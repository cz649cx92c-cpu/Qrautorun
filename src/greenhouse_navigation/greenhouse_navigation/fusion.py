"""只读底盘/轮式与IMU融合；成熟底盘用户确认和轮式实测分别记录。"""
import copy
import json
import math
import uuid
from collections import deque
import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from nav_msgs.msg import Odometry
from sensor_msgs.msg import Imu
from std_msgs.msg import String
from yhs_can_interfaces.msg import ChassisInfoFb
from .chassis_odometry import measured_body_twist
from .imu_source_health import SerialSourceHealth


# EKF已随输入适配器启动；校零后允许首帧初始化1秒，后续仍使用输入时效上限。
FIRST_FILTER_TIMEOUT_S = 1.


class StationaryCalibration:
    """静止时估计陀螺零偏和重力竖直轴；不估计绝对航向/平移外参。"""
    def __init__(self, duration=5., minimum=500, max_gap=.1):
        self.duration = duration
        self.minimum = minimum
        self.max_gap = max_gap
        self.samples = deque(maxlen=10000)
        self.result = None
        self.last_reason = ''
        self.last_window_statistics = None

    def add(self, stamp, gyro, acceleration, stationary):
        gyro = np.asarray(gyro, dtype=float)
        acceleration = np.asarray(acceleration, dtype=float)
        if (not stationary or gyro.shape != (3,) or acceleration.shape != (3,)
                or not math.isfinite(stamp) or not np.all(np.isfinite(gyro))
                or not np.all(np.isfinite(acceleration)) or np.linalg.norm(gyro) > .02
                or not 8.5 <= np.linalg.norm(acceleration) <= 11.):
            self.samples.clear()
            return None
        if self.samples and not 0 < stamp - self.samples[-1][0] <= self.max_gap:
            self.samples.clear()
        self.samples.append((stamp, gyro, acceleration))
        if len(self.samples) < self.minimum or stamp - self.samples[0][0] < self.duration:
            return None
        gyros = np.array([s[1] for s in self.samples])
        accelerations = np.array([s[2] for s in self.samples])
        gs=np.std(gyros,axis=0);ac=np.std(accelerations,axis=0)
        self.last_window_statistics={'sampleCount':len(gyros),'gyroStdRadS':gs.tolist(),'accelerationStdMps2':ac.tolist()}
        if np.max(gs) > .005 or np.max(ac) > .15:
            self.last_reason='Stationary window rejected: gyro std %.6f rad/s, limit 0.005; accel std %.6f m/s2, limit 0.15. Not a hardware fault diagnosis.' % (np.max(gs),np.max(ac))
            self.samples.clear()
            return None
        self.last_reason=''
        bias = np.mean(gyros, axis=0)
        gravity = np.mean(accelerations, axis=0)
        up = gravity / np.linalg.norm(gravity)
        projected = (gyros - bias) @ up
        self.result = {'bias': bias.tolist(), 'up': up.tolist(),
                       'variance': max(.005 ** 2, float(np.var(projected, ddof=1))),
                       'sampleCount': len(gyros), 'durationS': stamp - self.samples[0][0],
                       'gravityNorm': float(np.linalg.norm(gravity)), 'stamp': stamp}
        return self.result

    def project(self, gyro):
        if self.result is None:
            raise ValueError('尚未静止校零')
        v = np.asarray(gyro, dtype=float)
        if v.shape != (3,) or not np.all(np.isfinite(v)):
            raise ValueError('无效陀螺数据')
        return float((v - self.result['bias']) @ np.asarray(self.result['up']))


def legacy_mode_allowed(body_gear, steering_gear, stationary):
    # 原兼容程序映射：6/5为4t4d，8/7为crab；静止停放不需要猜轮角符号。
    if body_gear in (7, 8) or steering_gear in (7, 8):
        return False
    return stationary or body_gear in (5, 6)



def stationary_feedback(fb, gears):
    """使用真实底盘各路速度判断停放；横移档位即使速度为零也不参与校零。"""
    velocities = [fb.ctrl_fb.ctrl_fb_x_linear, fb.ctrl_fb.ctrl_fb_y_linear,
                  fb.steering_ctrl_fb.steering_ctrl_fb_velocity,
                  fb.lf_wheel_fb.lf_wheel_fb_velocity, fb.rf_wheel_fb.rf_wheel_fb_velocity,
                  fb.lr_wheel_fb.lr_wheel_fb_velocity, fb.rr_wheel_fb.rr_wheel_fb_velocity]
    angular = fb.ctrl_fb.ctrl_fb_z_angular
    return (fb.ctrl_fb.ctrl_fb_gear in gears
            and fb.ctrl_fb.ctrl_fb_gear not in (7, 8)
            and fb.steering_ctrl_fb.steering_ctrl_fb_gear not in (7, 8)
            and all(math.isfinite(v) and abs(v) <= .002 for v in velocities)
            and math.isfinite(angular) and abs(angular) <= .1)

def usable_odometry(msg):
    q = msg.pose.pose.orientation
    values = [msg.pose.pose.position.x, msg.pose.pose.position.y, q.x, q.y, q.z, q.w,
              msg.twist.twist.linear.x, msg.twist.twist.linear.y, msg.twist.twist.angular.z]
    cov = list(msg.pose.covariance) + list(msg.twist.covariance)
    return (msg.header.frame_id == 'odom' and msg.child_frame_id == 'base_link'
            and all(math.isfinite(v) for v in values + cov)
            and abs(q.x*q.x + q.y*q.y + q.z*q.z + q.w*q.w - 1.) < .02
            and all(msg.pose.covariance[i] > 0 for i in (0, 7, 35))
            and all(msg.twist.covariance[i] > 0 for i in (0, 7, 35)))


class FusionInputs(Node):
    def __init__(self):
        super().__init__('qr_fusion_inputs')
        defaults = {'source': 'legacy', 'odom_topic': '/odom', 'imu_topic': '/qr/imu/raw',
                    'feedback_topic': '/chassis_info_fb', 'imu_frame': 'imu_link',
                    'input_timeout_s': .25, 'calibration_duration_s': 5.,
                    'calibration_min_samples': 500, 'wheel_velocity_sigma_mps': .03,
                    'lateral_constraint_sigma_mps': .05,
                    'wheel_calibration_verified': False, 'noise_calibration_verified': False,
                    'imu_projection_verified': False, 'stationary_feedback_gears': [1, 2]}
        self.config = {}
        for key, value in defaults.items():
            self.declare_parameter(key, value)
            self.config[key] = self.get_parameter(key).value
        self.declare_parameter('existing_chassis_confirmed', False)
        self.config['existing_chassis_confirmed'] = (
            self.get_parameter('existing_chassis_confirmed').value
            if self.config['source'] == 'chassis' else False)
        self.epoch = uuid.uuid4().hex
        if self.config['source'] not in ('legacy', 'wheels', 'chassis'):
            raise ValueError('source必须为legacy、wheels或chassis')
        if self.config['source'] == 'chassis' and not self.config['existing_chassis_confirmed']:
            raise ValueError('成熟底盘模式需要明确的用户确认')
        if not .01 <= self.config['input_timeout_s'] <= 1. or not .001 <= self.config['wheel_velocity_sigma_mps'] <= 1.:
            raise ValueError('无效时效/协方差参数')
        if not .01 <= self.config['lateral_constraint_sigma_mps'] <= 1.:
            raise ValueError('横向运动约束噪声不可过小')
        if not 2. <= self.config['calibration_duration_s'] <= 30. or self.config['calibration_min_samples'] < 100:
            raise ValueError('静止校零至少2秒、100样本')
        self.calibration = StationaryCalibration(self.config['calibration_duration_s'],
                                                self.config['calibration_min_samples'])
        self.last = {'imu': None, 'odom': None, 'feedback': None, 'filter': None}
        self.stamps = {'imu': None, 'odom': None, 'feedback': None, 'filter': None}
        self.counts = {'imu': 0, 'odom': 0, 'filter': 0, 'provisional': 0, 'local': 0}
        self.feedback = None
        self.source_health = SerialSourceHealth() if self.config['imu_topic']=='/qr/imu/raw' else None
        if self.source_health is not None:
            self.create_subscription(String,'/qr/imu/status',self.imu_source_cb,10)
        self.filtered = None
        self.invalid_reason = ''
        self.started = False
        self.inputs_started = False
        self.input_relays = set()
        self.filter_wait_started = None
        self.last_relay = None
        self.odom_pub = self.create_publisher(Odometry, '/qr/fusion/wheel_input', 10)
        self.imu_pub = self.create_publisher(Imu, '/qr/fusion/imu_input', 20)
        self.preview_pub = self.create_publisher(Odometry, '/qr/odometry/provisional', 10)
        self.local_pub = self.create_publisher(Odometry, '/qr/odometry/local', 10)
        self.status_pub = self.create_publisher(String, '/qr/fusion/status', 10)
        self.create_subscription(ChassisInfoFb, self.config['feedback_topic'], self.feedback_cb, qos_profile_sensor_data)
        self.create_subscription(Odometry, self.config['odom_topic'], self.odom_cb, qos_profile_sensor_data)
        self.create_subscription(Imu, self.config['imu_topic'], self.imu_cb, qos_profile_sensor_data)
        self.create_subscription(Odometry, '/qr/fusion/filtered', self.filtered_cb, 10)
        self.create_timer(.1, self.status)
        self.get_logger().info('只读融合：底盘速度+IMU竖直轴角速度；无加速度积分、无底盘命令、无TF发布')

    def now(self):
        return self.get_clock().now().nanoseconds / 1e9

    def accept_stamp(self, key, msg):
        stamp = msg.header.stamp.sec + msg.header.stamp.nanosec / 1e9
        previous = self.stamps[key]
        if previous is not None and stamp <= previous:
            if stamp < previous - .01:
                self.invalid_reason = self.invalid_reason or '传感器时钟回退，旧轨迹已作废'
            return False
        if not 0 <= self.now() - stamp <= self.config['input_timeout_s']:
            return False
        if self.session_active() and previous is not None and stamp-previous > self.config['input_timeout_s']:
            self.invalid_reason = self.invalid_reason or '传感器观测中断，旧轨迹已作废'
        self.stamps[key] = stamp
        self.last[key] = self.now()
        return True

    def session_active(self):
        return self.started or getattr(self, 'inputs_started', False)

    def mark_input_started(self, key):
        self.inputs_started = True
        if not hasattr(self, 'input_relays'):
            self.input_relays = set()
        self.input_relays.add(key)
        # 两路有效融合输入均就绪才计时；校零期间或缺少一路输入不能误判EKF故障。
        # 只设置一次，持续输入不能把首帧截止时间无限后移。
        if (getattr(self, 'filter_wait_started', None) is None
                and self.input_relays == {'imu', 'odom'} and self.inputs_ready()):
            self.filter_wait_started = self.now()

    def fresh(self, key):
        return self.last[key] is not None and 0 <= self.now() - self.last[key] <= self.config['input_timeout_s']

    def stationary(self):
        if self.feedback is None or not self.fresh('feedback'):
            return False
        # 正在作业的短暂停车不用于校零，防止把真实慢速转动学习为零偏。
        return stationary_feedback(self.feedback, self.config.get('stationary_feedback_gears', [1, 2]))

    def mode_allowed(self):
        if self.feedback is None or not self.fresh('feedback'):
            return False
        if self.config['source'] == 'wheels':
            return self.config['wheel_calibration_verified']
        if self.config['source'] == 'chassis':
            # Body velocity is a measurement, independent of the requested drive mode.
            # Drive/route permissions remain restricted to gears 6/8 elsewhere.
            if not self.config.get('existing_chassis_confirmed',False):return False
            try:measured_body_twist(self.feedback)
            except ValueError:return False
            return True
        fb = self.feedback
        return legacy_mode_allowed(fb.ctrl_fb.ctrl_fb_gear, fb.steering_ctrl_fb.steering_ctrl_fb_gear, self.stationary())

    def feedback_cb(self, msg):
        if self.accept_stamp('feedback', msg):
            self.feedback = msg
            if self.session_active() and not self.mode_allowed():
                self.invalid_reason = self.invalid_reason or (
                    '底盘速度测量无效，等待有效反馈并静止恢复' if self.config['source'] == 'chassis' else
                    '运动模式不支持；横移未标定，请切回允许的停放模式')

    def odom_cb(self, msg):
        if msg.header.frame_id != 'odom' or msg.child_frame_id != 'base_link':
            return
        if not self.mode_allowed() or self.calibration.result is None or self.invalid_reason:
            return
        # 完整校验必须先于时效更新，坏协方差/位姿不得掩盖输入断流。
        # legacy全零协方差沿用明确噪声先验，保留原底盘兼容路径。
        if self.config['source'] in ('wheels', 'chassis') and not usable_odometry(msg):
            return
        vx, vy = msg.twist.twist.linear.x, msg.twist.twist.linear.y
        if (not all(math.isfinite(v) for v in (vx, vy))
                or not self.accept_stamp('odom', msg) or self.invalid_reason):
            return
        out = Odometry()
        out.header = msg.header
        out.child_frame_id = 'base_link'
        out.pose.pose.orientation.w = 1.
        out.twist.twist.linear.x = vx
        out.twist.twist.linear.y = vy if self.config['source'] in ('wheels', 'chassis') else 0.
        # 旧协方差全零表示没有误差模型；使用明确的待验证噪声先验，不把它当精确值。
        for i in (0, 7, 14, 21, 28, 35):
            out.pose.covariance[i] = 1e6
            out.twist.covariance[i] = 1e6
        out.twist.covariance[0] = self.config['wheel_velocity_sigma_mps'] ** 2
        # legacy仅在停放/4t4d引入vy≈0约束；wheels/chassis使用真实横向速度及其非零协方差。
        out.twist.covariance[7] = self.config['lateral_constraint_sigma_mps'] ** 2
        if self.config['source'] in ('wheels', 'chassis'):
            out.twist.covariance[0] = max(out.twist.covariance[0], msg.twist.covariance[0])
            out.twist.covariance[7] = max(self.config['wheel_velocity_sigma_mps'] ** 2, msg.twist.covariance[7])
        self.odom_pub.publish(out)
        self.mark_input_started('odom')
        self.counts['odom'] += 1

    def imu_source_cb(self,msg):
        try: payload=json.loads(msg.data)
        except (ValueError,TypeError): payload={}
        valid,changed=self.source_health.observe(payload,self.now())
        if not valid or changed:
            if self.calibration.result is not None or self.session_active():
                self.invalid_reason=self.invalid_reason or '新IMU来源/连接已变化，旧校零作废'
            self.calibration.samples.clear()

    def imu_cb(self, msg):
        health=getattr(self,'source_health',None)
        if health is not None and not health.fresh(self.now()):
            if self.calibration.result is not None or self.session_active():
                self.invalid_reason=self.invalid_reason or '新IMU来源状态过期，旧校零作废'
            self.calibration.samples.clear()
            return
        if msg.header.frame_id != self.config['imu_frame']:
            return
        gyro = [msg.angular_velocity.x, msg.angular_velocity.y, msg.angular_velocity.z]
        accel = [msg.linear_acceleration.x, msg.linear_acceleration.y, msg.linear_acceleration.z]
        if not all(math.isfinite(v) for v in gyro + accel) or np.linalg.norm(gyro) > 3.:
            return
        if not self.accept_stamp('imu', msg) or self.invalid_reason:
            return
        self.counts['imu'] += 1
        if self.calibration.result is None:
            result = self.calibration.add(self.stamps['imu'], gyro, accel, self.stationary())
            if result is not None:
                self.get_logger().info('静止校零完成：' + json.dumps(result, ensure_ascii=False))
            return
        if self.invalid_reason:
            return
        out = Imu()
        out.header = copy.deepcopy(msg.header)
        # 这是车体竖直轴的标量投影，只发布z，不虚构完整三轴安装外参。
        out.header.frame_id = 'base_link'
        out.orientation_covariance[0] = -1.
        out.linear_acceleration_covariance[0] = -1.
        out.angular_velocity.z = self.calibration.project(gyro)
        out.angular_velocity_covariance[0] = 1e6
        out.angular_velocity_covariance[4] = 1e6
        out.angular_velocity_covariance[8] = self.calibration.result['variance']
        self.imu_pub.publish(out)
        self.mark_input_started('imu')

    def inputs_ready(self):
        return (self.calibration.result is not None and not self.invalid_reason
                and all(self.fresh(k) for k in ('imu', 'odom', 'feedback')) and self.mode_allowed())

    def mapping_ready(self):
        if self.config['source'] == 'chassis':
            return bool(self.config.get('existing_chassis_confirmed', False))
        return (self.config['source'] == 'wheels' and self.config['wheel_calibration_verified']
                and self.config['noise_calibration_verified'] and self.config['imu_projection_verified'])

    def check_first_filter_timeout(self):
        filter_wait_started = getattr(self, 'filter_wait_started', None)
        if (not self.started and filter_wait_started is not None
                and self.now()-filter_wait_started >= FIRST_FILTER_TIMEOUT_S):
            self.invalid_reason = self.invalid_reason or 'EKF首帧有效输出超时，旧轨迹已作废'

    def filtered_cb(self, msg):
        if not usable_odometry(msg):
            return
        # 不允许迟到首帧在状态定时器下一次运行前绕过截止时间。
        self.check_first_filter_timeout()
        if self.invalid_reason or not self.accept_stamp('filter', msg):
            return
        self.filtered = msg
        self.counts['filter'] += 1
        if not self.inputs_ready():
            return
        self.started = True
        self.preview_pub.publish(msg)
        self.counts['provisional'] += 1
        if self.mapping_ready():
            self.local_pub.publish(msg)
            self.counts['local'] += 1
        self.last_relay = self.now()

    def status(self):
        if self.session_active() and any(self.last[k] is not None and not self.fresh(k)
                                         for k in ('imu', 'odom', 'feedback')):
            self.invalid_reason = self.invalid_reason or '传感器观测中断，旧轨迹已作废'
        if self.started and any(not self.fresh(k) for k in ('imu', 'odom', 'feedback', 'filter')):
            self.invalid_reason = self.invalid_reason or '传感器或EKF观测中断，旧轨迹已作废'
        self.check_first_filter_timeout()
        ready = self.inputs_ready() and self.fresh('filter') and self.last_relay is not None and self.now()-self.last_relay <= .25
        if self.invalid_reason:
            state = 'INVALID'
        elif self.calibration.result is None:
            state = 'CALIBRATING'
        elif ready:
            state = 'FUSED' if self.mapping_ready() else 'PROVISIONAL'
        else:
            state = 'WAITING'
        pose = None
        if ready and self.filtered is not None:
            msg = self.filtered
            q = msg.pose.pose.orientation
            pose = {'x': msg.pose.pose.position.x, 'y': msg.pose.pose.position.y,
                    'yaw': math.atan2(2*(q.w*q.z+q.x*q.y), 1-2*(q.y*q.y+q.z*q.z)),
                    'positionSigmaM': math.sqrt(max(msg.pose.covariance[0], msg.pose.covariance[7]))}
        payload = {'stamp': self.now(), 'state': state, 'source': self.config['source'],
                   'epoch': getattr(self, 'epoch', 'unknown'),
                   'ready': bool(ready), 'mappingReady': bool(ready and self.mapping_ready()),
                   'lateralSupported': (self.config['source'] == 'wheels' and self.config['wheel_calibration_verified']
                                        or self.config['source'] == 'chassis' and self.config.get('existing_chassis_confirmed', False)),
                   'absoluteHeading': False, 'hardwareControl': False,
                   'imuSourceTopic':self.config.get('imu_topic',''),
                   'imuSourceHealthy':self.source_health.fresh(self.now()) if getattr(self,'source_health',None) is not None else None,
                   'imuProjectionVerified':self.config.get('imu_projection_verified',False),
                   'calibrationLastRejection':getattr(self.calibration,'last_reason',''),
                   'calibrationWindowStatistics':getattr(self.calibration,'last_window_statistics',None),
                   'reason': ('保持静止，正在自动恢复：' + self.invalid_reason
                              + '；等待新鲜传感器数据后重新校零并建立新原点') if self.invalid_reason else
                             ('保持静止，正在静止校零' if state == 'CALIBRATING' else ''),
                   'recovery': {'phase': 'WAITING_FOR_STATIONARY_INPUTS' if self.invalid_reason else
                                        ('CALIBRATING' if state == 'CALIBRATING' else 'IDLE'),
                                'automatic': True, 'requiresNewEpoch': bool(self.invalid_reason)},
                   'counts': self.counts,
                   'agesMs': {k: None if v is None else round((self.now()-v)*1000, 3) for k, v in self.last.items()},
                   'calibration': self.calibration.result,
                   'calibrationSamples': len(self.calibration.samples), 'pose': pose}
        if self.config['source'] == 'chassis':
            payload['approvalBasis'] = 'user_confirmation' if self.config.get('existing_chassis_confirmed', False) else None
        self.status_pub.publish(String(data=json.dumps(payload, ensure_ascii=False)))


def main(args=None):
    rclpy.init(args=args)
    node = FusionInputs()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
