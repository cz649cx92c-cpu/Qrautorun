#!/usr/bin/env python3
"""只监督本工程输入适配/EKF；真实输入持续静止后丢弃失效轨迹并重新校零。"""
import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import yaml
import rclpy
from nav_msgs.msg import Odometry
from sensor_msgs.msg import Imu
from std_msgs.msg import String
from rclpy.qos import qos_profile_sensor_data
from yhs_can_interfaces.msg import ChassisInfoFb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.fusion import legacy_mode_allowed, stationary_feedback, usable_odometry
from greenhouse_navigation.chassis_odometry import chassis_mode_allowed

OUTPUT_TOPICS = ('/qr/fusion/wheel_input', '/qr/fusion/imu_input',
                 '/qr/fusion/filtered', '/qr/odometry/local',
                 '/qr/odometry/provisional', '/qr/fusion/status', '/qr/chassis/odom')


class RecoveryGate:
    """恢复门禁独立观察原始Topic，绝不借用已经锁定INVALID的输入适配器。"""
    def __init__(self, inputs, stationary_s=.75, backoff_s=2., maximum_backoff_s=30.):
        self.inputs = inputs
        self.timeout = inputs.get('input_timeout_s', .25)
        self.stationary_s = stationary_s
        self.backoff_s = backoff_s
        self.maximum_backoff_s = maximum_backoff_s
        self.last = {key: None for key in ('imu', 'odom', 'feedback')}
        self.stamps = dict(self.last)
        self.quiet = {key: False for key in self.last}
        self.feedback = None
        self.fusion = None
        self.status_at = None
        self.stable_since = None
        self.healthy_since = None
        self.ros_now = None
        self.attempts = 0
        self.next_attempt = 0.
        self.retired_epoch = None
        self.reason = '等待融合状态'

    def observe(self, key, msg, ros_now, monotonic_now):
        # ROS时间和墙上接收时效都要检查；暂停/倒退的ROS时钟不能伪装成新数据。
        if self.ros_now is not None and ros_now < self.ros_now - .01:
            self.clear_inputs()
            self.fusion = None
            self.status_at = None
        self.ros_now = ros_now
        stamp = msg.header.stamp.sec + msg.header.stamp.nanosec / 1e9
        previous = self.stamps[key]
        if not math.isfinite(stamp) or not 0 <= ros_now - stamp <= self.timeout:
            self.reject(key)
            return
        if previous is not None and stamp <= previous:
            # 从回退后的真实时间线重新等连续样本，但绝不释放旧融合状态。
            if stamp < previous - .01:
                self.stamps[key] = stamp
            self.reject(key)
            return
        if (self.last[key] is not None and monotonic_now - self.last[key] > self.timeout
                or previous is not None and stamp - previous > self.timeout):
            self.stable_since = None
        self.stamps[key] = stamp
        valid, quiet = False, False
        if key == 'imu':
            gyro = [msg.angular_velocity.x, msg.angular_velocity.y, msg.angular_velocity.z]
            accel = [msg.linear_acceleration.x, msg.linear_acceleration.y, msg.linear_acceleration.z]
            valid = (msg.header.frame_id == self.inputs.get('imu_frame', 'imu_link')
                     and all(math.isfinite(v) for v in gyro + accel)
                     and math.hypot(*gyro) <= 3.)
            quiet = valid and math.hypot(*gyro) <= .02 and 8.5 <= math.hypot(*accel) <= 11.
        elif key == 'odom':
            speeds = [msg.twist.twist.linear.x, msg.twist.twist.linear.y, msg.twist.twist.angular.z]
            valid = (msg.header.frame_id == 'odom' and msg.child_frame_id == 'base_link'
                     and all(math.isfinite(v) for v in speeds)
                     and (self.inputs['source'] == 'legacy' or usable_odometry(msg)))
            quiet = valid and all(abs(v) <= .002 for v in speeds[:2]) and abs(speeds[2]) <= .02
        elif key == 'feedback':
            speeds = [msg.ctrl_fb.ctrl_fb_x_linear, msg.ctrl_fb.ctrl_fb_y_linear,
                      msg.ctrl_fb.ctrl_fb_z_angular, msg.steering_ctrl_fb.steering_ctrl_fb_velocity,
                      msg.lf_wheel_fb.lf_wheel_fb_velocity, msg.rf_wheel_fb.rf_wheel_fb_velocity,
                      msg.lr_wheel_fb.lr_wheel_fb_velocity, msg.rr_wheel_fb.rr_wheel_fb_velocity]
            valid = all(math.isfinite(v) for v in speeds)
            quiet = valid and stationary_feedback(msg, self.inputs.get('stationary_feedback_gears', [1, 2]))
            self.feedback = msg if valid else None
        if not valid:
            self.reject(key)
            return
        self.last[key] = monotonic_now
        self.quiet[key] = quiet
        if not quiet:
            self.stable_since = None

    def reject(self, key):
        self.last[key] = None
        self.quiet[key] = False
        self.stable_since = None

    def clear_inputs(self):
        for key in self.last:
            self.last[key] = self.stamps[key] = None
            self.quiet[key] = False
        self.feedback = None
        self.stable_since = None

    def status(self, payload, ros_now, monotonic_now):
        # 无状态/旧epoch/过时状态均不能作为自动重建的依据。
        try:
            age = ros_now - float(payload['stamp'])
            epoch = payload['epoch']
            if (not 0 <= age <= .5 or not isinstance(epoch, str) or not epoch
                    or epoch == self.retired_epoch
                    or payload['state'] not in ('INVALID', 'CALIBRATING', 'WAITING', 'PROVISIONAL', 'FUSED')):
                return
        except (KeyError, TypeError, ValueError):
            return
        if self.status_at is not None and monotonic_now - self.status_at > .5:
            self.stable_since = self.healthy_since = None
        if self.fusion is not None and payload['epoch'] != self.fusion['epoch']:
            self.stable_since = self.healthy_since = None
        self.fusion = payload
        self.status_at = monotonic_now

    def ready_to_restart(self, ros_now, monotonic_now, publishers):
        if (self.fusion is None or self.status_at is None
                or not 0 <= monotonic_now - self.status_at <= .5
                or not 0 <= ros_now - float(self.fusion['stamp']) <= .5):
            self.stable_since = self.healthy_since = None
            self.reason = '等待新鲜融合状态'
            return False
        if self.fusion['state'] != 'INVALID':
            self.stable_since = None
            if self.fusion['state'] in ('PROVISIONAL', 'FUSED') and self.fusion.get('ready'):
                if self.healthy_since is None:
                    self.healthy_since = monotonic_now
                if monotonic_now - self.healthy_since >= 10.:
                    self.attempts = 0
            else:
                self.healthy_since = None
            return False
        self.healthy_since = None
        if any(publishers.get(key) != 1 for key in (*self.last, 'status')):
            self.stable_since = None
            self.reason = '等待IMU、里程计、底盘反馈和融合状态各有一个真实发布者'
            return False
        if any(self.last[key] is None or self.stamps[key] is None
               or not 0 <= monotonic_now - self.last[key] <= self.timeout
               or not 0 <= ros_now - self.stamps[key] <= self.timeout for key in self.last):
            self.stable_since = None
            self.reason = '等待新鲜IMU、里程计和底盘反馈'
            return False
        allowed = False
        if self.feedback is not None:
            if self.inputs['source'] == 'wheels':
                allowed = self.inputs.get('wheel_calibration_verified', False)
            elif self.inputs['source'] == 'chassis':
                allowed = (self.inputs.get('existing_chassis_confirmed', False)
                           and chassis_mode_allowed(self.feedback.ctrl_fb.ctrl_fb_gear, self.quiet['feedback']))
            else:
                allowed = legacy_mode_allowed(self.feedback.ctrl_fb.ctrl_fb_gear,
                                              self.feedback.steering_ctrl_fb.steering_ctrl_fb_gear,
                                              self.quiet['feedback'])
        if not allowed or not all(self.quiet.values()):
            self.stable_since = None
            self.reason = ('切回允许的停放模式并保持静止' if self.inputs['source'] == 'chassis' else
                           '切回允许的停放模式并保持静止；未标定横移仍然禁止')
            return False
        if self.stable_since is None:
            self.stable_since = monotonic_now
        if monotonic_now < self.next_attempt:
            self.reason = '保持静止，正在自动恢复，等待重试退避'
            return False
        self.reason = '保持静止，正在自动恢复，等待连续静止输入'
        return monotonic_now - self.stable_since >= self.stationary_s

    def restarted(self, monotonic_now):
        """消费本次恢复许可；新子进程必须发布与旧进程不同的epoch。"""
        self.retired_epoch = self.fusion['epoch'] if self.fusion else self.retired_epoch
        self.fusion = None
        self.status_at = None
        self.attempts = min(self.attempts + 1, 16)
        self.next_attempt = monotonic_now + min(self.maximum_backoff_s,
                                               self.backoff_s * 2**(self.attempts - 1))
        self.clear_inputs()


def load_configuration(args):
    inputs = yaml.safe_load(args.inputs.read_text())['qr_fusion_inputs']['ros__parameters']
    ekf = yaml.safe_load(args.ekf.read_text())['ekf_filter_node']['ros__parameters']
    if ekf.get('publish_tf', True) or ekf.get('use_control', False):
        raise ValueError('此启动器必须关闭TF与控制输入，保持与原底盘独立')
    if ekf.get('odom0') != '/qr/fusion/wheel_input' or ekf.get('imu0') != '/qr/fusion/imu_input':
        raise ValueError('EKF必须使用本工程经过时效/零偏处理的输入')
    if inputs['source'] == 'wheels':
        if not inputs.get('wheel_calibration_verified') or inputs['odom_topic'] != '/qr/wheel/odom':
            raise ValueError('四轮模式需要真实标定的/qr/wheel/odom')
    elif inputs['source'] == 'chassis':
        if inputs.get('existing_chassis_confirmed') is not True or inputs['odom_topic'] != '/qr/chassis/odom':
            raise ValueError('成熟底盘模式需要用户确认及/qr/chassis/odom')
    elif inputs['source'] != 'legacy' or inputs['odom_topic'] != '/odom':
        raise ValueError('旧底盘模式只复用已核对的/odom')
    expected_odom, expected_imu = [False]*15, [False]*15
    expected_odom[6] = expected_odom[7] = expected_imu[11] = True
    if ekf.get('odom0_config') != expected_odom or ekf.get('imu0_config') != expected_imu:
        raise ValueError('输入掩码不匹配；仅融合速度/受限模式横向约束和竖直角速度')
    binary = ROOT/'install/greenhouse_navigation/lib/greenhouse_navigation/fusion_inputs'
    if not binary.exists():
        raise ValueError('请先编译greenhouse_navigation')
    commands = [
        ['/usr/bin/python3', str(binary), '--ros-args', '--params-file', str(args.inputs.resolve())],
        ['/opt/ros/humble/lib/robot_localization/ekf_node', '--ros-args', '--params-file', str(args.ekf.resolve()),
         '-r', 'odometry/filtered:=/qr/fusion/filtered', '-r', '/tf:=/qr/fusion/tf_unused',
         '-r', '/tf_static:=/qr/fusion/tf_static_unused']]
    if inputs['source'] == 'chassis':
        chassis_config = getattr(args, 'chassis', ROOT/'config/chassis_odometry.yaml')
        chassis = yaml.safe_load(chassis_config.read_text())['qr_chassis_odometry']['ros__parameters']
        if chassis.get('motion_confirmed') is not True:
            raise ValueError('成熟底盘反馈适配必须明确motion_confirmed')
        if not math.isclose(chassis.get('lateral_velocity_scale', math.nan), .1, rel_tol=0., abs_tol=1e-12):
            raise ValueError('成熟底盘横向速度修正必须为0.1')
        adapter = ROOT/'install/greenhouse_navigation/lib/greenhouse_navigation/chassis_odometry'
        if not adapter.exists():
            raise ValueError('请先编译chassis_odometry')
        commands.insert(0, ['/usr/bin/python3', str(adapter), '--ros-args', '--params-file', str(chassis_config.resolve())])
    return inputs, commands


def acquire_lock(path):
    """复用start脚本的fd 9锁；直接调用此脚本时也保持相同独占语义。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        inherited = os.fstat(9)
        target = path.stat()
        if (inherited.st_dev, inherited.st_ino) == (target.st_dev, target.st_ino):
            fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return 9
    except (OSError, FileNotFoundError):
        pass
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise RuntimeError('本工程融合已运行，拒绝争用')
    return fd


class OwnedChildren:
    """只回收由本监督器Popen创建的进程；旧EKF完全退出后才能建立新原点。"""
    def __init__(self, commands, processes_file):
        self.commands = commands
        self.processes_file = processes_file
        self.children = []

    def start(self):
        if self.children:
            raise RuntimeError('旧融合子进程尚未回收')
        try:
            for command in self.commands:
                self.children.append(subprocess.Popen(command))
            self.processes_file.write_text(json.dumps(
                {'supervisor': os.getpid(), 'children': [child.pid for child in self.children]}, indent=2)+'\n')
        except BaseException:
            self.stop()
            raise

    def check(self):
        for child in self.children:
            if child.poll() is not None:
                raise RuntimeError('融合子进程退出，返回码'+str(child.returncode))

    def stop(self, stopping=None):
        # 先停止输入适配器，再回收EKF；等待中仍允许父进程响应stop信号。
        for child in self.children:
            if child.poll() is None:
                try:
                    child.send_signal(signal.SIGINT)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 5.
        for child in self.children:
            while child.poll() is None and time.monotonic() < deadline:
                if stopping is not None and stopping():
                    break
                try:
                    child.wait(timeout=.1)
                except subprocess.TimeoutExpired:
                    pass
        for child in self.children:
            if child.poll() is None:
                try:
                    child.terminate()
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 2.
        for child in self.children:
            while child.poll() is None and time.monotonic() < deadline:
                try:
                    child.wait(timeout=.1)
                except subprocess.TimeoutExpired:
                    pass
            if child.poll() is None:
                try:
                    child.kill()
                except ProcessLookupError:
                    pass
            child.wait()
        self.children.clear()


def main(argv=None):
    parser = argparse.ArgumentParser(description='只读轮式/IMU融合，失效后静止自动重建')
    parser.add_argument('--inputs', type=Path, default=ROOT/'config/fusion_inputs.yaml')
    parser.add_argument('--ekf', type=Path, default=ROOT/'config/ekf_provisional.yaml')
    parser.add_argument('--chassis', type=Path, default=ROOT/'config/chassis_odometry.yaml')
    args = parser.parse_args(argv)
    inputs, commands = load_configuration(args)
    lock_fd = acquire_lock(ROOT/'logs/fusion.lock')
    pid_file = ROOT/'logs/fusion.pid'
    processes_file = ROOT/'logs/fusion-processes.json'
    owned = OwnedChildren(commands, processes_file)
    stop_requested = False

    def interrupted(*_):
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    node = None
    result = 0
    try:
        # 默认rclpy信号处理会shutdown context；此处由监督器统一停止自己的子进程。
        from rclpy.signals import SignalHandlerOptions
        rclpy.init(signal_handler_options=SignalHandlerOptions.NO)
        node = rclpy.create_node('qr_fusion_supervisor')
        gate = RecoveryGate(inputs)
        topics = {key: inputs[key+'_topic'] for key in ('imu', 'odom', 'feedback')}
        topics['status'] = '/qr/fusion/status'

        def raw_callback(key):
            return lambda msg: gate.observe(key, msg, node.get_clock().now().nanoseconds / 1e9,
                                            time.monotonic())

        for key, message_type in (('imu', Imu), ('odom', Odometry), ('feedback', ChassisInfoFb)):
            node.create_subscription(message_type, topics[key], raw_callback(key), qos_profile_sensor_data)

        def status_callback(msg):
            try:
                payload = json.loads(msg.data)
                if isinstance(payload, dict):
                    gate.status(payload, node.get_clock().now().nanoseconds / 1e9, time.monotonic())
            except (ValueError, TypeError):
                pass

        node.create_subscription(String, topics['status'], status_callback, 10)
        deadline = time.monotonic() + 2.
        while not stop_requested and time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=.1)
        if stop_requested:
            return 0
        conflicts = [topic for topic in OUTPUT_TOPICS if node.count_publishers(topic)]
        if conflicts:
            raise RuntimeError('融合Topic已有发布者，拒绝争用：'+'、'.join(conflicts))
        # 启动时传感器离线不退出；输入适配器等待校零，恢复后门禁仍需真实新鲜样本。
        pid_file.write_text(str(os.getpid()))
        owned.start()
        last_notice = None
        last_notice_at = 0.
        next_check = 0.
        while not stop_requested:
            rclpy.spin_once(node, timeout_sec=.1)
            if stop_requested:
                break
            now = time.monotonic()
            if now < next_check:
                continue
            next_check = now + .1
            owned.check()
            ros_now = node.get_clock().now().nanoseconds / 1e9
            publishers = {key: node.count_publishers(topic) for key, topic in topics.items()}
            if gate.ready_to_restart(ros_now, now, publishers):
                print('保持静止，正在自动恢复：回收旧EKF和输入适配器，重新校零并建立新epoch', flush=True)
                owned.stop(lambda: stop_requested)
                if stop_requested:
                    break
                gate.restarted(time.monotonic())
                owned.start()
                last_notice = None
            elif gate.fusion and gate.fusion['state'] == 'INVALID':
                if gate.reason != last_notice or now - last_notice_at >= 10.:
                    print('保持静止，正在自动恢复：'+gate.reason, flush=True)
                    last_notice, last_notice_at = gate.reason, now
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(str(error), flush=True)
        result = 1
    finally:
        stop_requested = True
        owned.stop(lambda: True)
        if node is not None:
            node.destroy_node()
        rclpy.try_shutdown()
        if pid_file.exists() and pid_file.read_text().strip() == str(os.getpid()):
            pid_file.unlink()
        if processes_file.exists():
            try:
                if json.loads(processes_file.read_text()).get('supervisor') == os.getpid():
                    processes_file.unlink()
            except (ValueError, OSError):
                pass
        os.close(lock_fd)
    return result


if __name__ == '__main__':
    raise SystemExit(main())
