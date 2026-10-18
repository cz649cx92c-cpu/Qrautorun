"""融合数学与准入检查；单元输入不作为实车测量记录。"""
import json
import math
import os
import subprocess
import tempfile
from pathlib import Path
import sys
import unittest
from unittest import mock
from types import SimpleNamespace
import numpy as np
import yaml
from nav_msgs.msg import Odometry
from sensor_msgs.msg import Imu
from yhs_can_interfaces.msg import ChassisInfoFb
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.fusion import StationaryCalibration, legacy_mode_allowed, usable_odometry, FusionInputs
sys.path.insert(0, str(ROOT/"scripts"))
from run_fusion import RecoveryGate, OwnedChildren, acquire_lock


class FusionTests(unittest.TestCase):
    def calibrated(self, up):
        calibration = StationaryCalibration(duration=2., minimum=100)
        bias = np.array([.001, -.002, .003])
        for i in range(202):
            calibration.add(i*.01, bias, np.array(up)*9.81, True)
        self.assertIsNotNone(calibration.result)
        return calibration, bias

    def test_tilted_mount_yaw_projection_and_bias(self):
        up = np.array([-.3, .1, math.sqrt(.9)])
        calibration, bias = self.calibrated(up)
        self.assertAlmostEqual(calibration.project(bias), 0., places=12)
        self.assertAlmostEqual(calibration.project(bias + up*.2), .2, places=12)
        self.assertAlmostEqual(calibration.project(bias - up*.2), -.2, places=12)
        self.assertGreaterEqual(calibration.result['variance'], .005**2)

    def test_motion_cannot_calibrate(self):
        calibration = StationaryCalibration(duration=2., minimum=100)
        for i in range(250):
            calibration.add(i*.01, [0., 0., .05], [0., 0., 9.81], True)
        self.assertIsNone(calibration.result)
        for i in range(250):
            calibration.add(i*.01, [0., 0., 0.], [0., 0., 9.81], False)
        self.assertIsNone(calibration.result)

    def test_gap_and_out_of_order_restart_calibration(self):
        calibration = StationaryCalibration(duration=2., minimum=100)
        for i in range(150):
            calibration.add(i*.01, [0., 0., 0.], [0., 0., 9.81], True)
        calibration.add(3., [0., 0., 0.], [0., 0., 9.81], True)
        self.assertEqual(len(calibration.samples), 1)
        calibration.add(2., [0., 0., 0.], [0., 0., 9.81], True)
        self.assertEqual(len(calibration.samples), 1)
        self.assertIsNone(calibration.result)

    def test_invalid_acceleration_and_nan_are_rejected(self):
        calibration = StationaryCalibration(duration=2., minimum=100)
        for acceleration in ([0., 0., 0.], [0., 0., 20.], [math.nan, 0., 9.81]):
            self.assertIsNone(calibration.add(0., [0., 0., 0.], acceleration, True))
            self.assertEqual(len(calibration.samples), 0)
        self.assertIsNone(calibration.add(0., [math.nan, 0., 0.], [0., 0., 9.81], True))

    def test_legacy_crab_rejected_even_while_stationary(self):
        self.assertFalse(legacy_mode_allowed(8, 7, False))
        self.assertFalse(legacy_mode_allowed(6, 7, True))
        self.assertFalse(legacy_mode_allowed(8, 5, True))
        self.assertTrue(legacy_mode_allowed(6, 5, False))
        self.assertTrue(legacy_mode_allowed(1, 1, True))
        self.assertFalse(legacy_mode_allowed(1, 1, False))

    def test_bad_covariance_and_pose_rejected(self):
        message = Odometry()
        message.header.frame_id = 'odom'
        message.child_frame_id = 'base_link'
        message.pose.pose.orientation.w = 1.
        self.assertFalse(usable_odometry(message))
        for i in (0, 7, 35):
            message.pose.covariance[i] = .01
            message.twist.covariance[i] = .01
        self.assertTrue(usable_odometry(message))
        message.twist.twist.linear.x = math.nan
        self.assertFalse(usable_odometry(message))
        message.twist.twist.linear.x = 0.
        message.header.frame_id = 'map'
        self.assertFalse(usable_odometry(message))

    def test_legacy_never_qualifies_as_lateral_mapping(self):
        # 绕过ROS构造，只检查默认准入策略，不连接实车。
        node = FusionInputs.__new__(FusionInputs)
        node.config = {'source': 'legacy', 'wheel_calibration_verified': True,
                       'noise_calibration_verified': True, 'imu_projection_verified': True}
        self.assertFalse(node.mapping_ready())
        node.config['source'] = 'wheels'
        self.assertTrue(node.mapping_ready())
        node.config['imu_projection_verified'] = False
        self.assertFalse(node.mapping_ready())

    def test_observed_remote_stop_gear_only_with_zero_feedback(self):
        from yhs_can_interfaces.msg import ChassisInfoFb
        node=FusionInputs.__new__(FusionInputs)
        node.config={'stationary_feedback_gears':[0,1,2]}
        node.feedback=ChassisInfoFb();node.fresh=lambda key:True
        self.assertTrue(node.stationary())
        node.feedback.lf_wheel_fb.lf_wheel_fb_velocity=.01
        self.assertFalse(node.stationary())
        node.feedback.lf_wheel_fb.lf_wheel_fb_velocity=0.
        node.feedback.steering_ctrl_fb.steering_ctrl_fb_gear=7
        self.assertFalse(node.stationary())

    def test_provisional_configuration_only_velocity_constraints(self):
        parameters = yaml.safe_load((ROOT/'config/ekf_provisional.yaml').read_text())['ekf_filter_node']['ros__parameters']
        self.assertFalse(parameters['publish_tf'])
        self.assertFalse(parameters['use_control'])
        self.assertEqual([i for i, v in enumerate(parameters['odom0_config']) if v], [6, 7])
        self.assertEqual([i for i, v in enumerate(parameters['imu0_config']) if v], [11])
        inputs = yaml.safe_load((ROOT/'config/fusion_inputs.yaml').read_text())['qr_fusion_inputs']['ros__parameters']
        self.assertFalse(inputs['wheel_calibration_verified'])
        self.assertFalse(inputs['noise_calibration_verified'])
        self.assertFalse(inputs['imu_projection_verified'])

    def harness(self):
        node = FusionInputs.__new__(FusionInputs)
        node.config = {'source': 'legacy', 'input_timeout_s': .25,
                       'wheel_calibration_verified': False, 'noise_calibration_verified': False,
                       'imu_projection_verified': False}
        node.now = lambda: 10.
        node.mode_allowed = lambda: True
        node.last = {k: 10. for k in ('imu', 'odom', 'feedback', 'filter')}
        node.stamps = {k: None for k in node.last}
        node.calibration = StationaryCalibration()
        node.calibration.result = {'bias': [0.]*3, 'up': [0.,0.,1.], 'variance': .000025}
        node.invalid_reason = ''
        node.started = False
        node.filtered = None
        node.last_relay = None
        node.counts = {'imu': 1, 'odom': 1, 'filter': 0, 'provisional': 0, 'local': 0}
        node.preview = []
        node.local = []
        node.statuses = []
        node.preview_pub = SimpleNamespace(publish=node.preview.append)
        node.local_pub = SimpleNamespace(publish=node.local.append)
        node.status_pub = SimpleNamespace(publish=node.statuses.append)
        return node

    def test_input_expiry_and_clock_rewind_invalidate_session(self):
        node = self.harness()
        self.assertTrue(node.inputs_ready())
        node.last['imu'] = 9.
        self.assertFalse(node.inputs_ready())
        node.started = True
        node.status()
        self.assertTrue(node.invalid_reason)
        node.last['imu'] = 10.
        self.assertFalse(node.inputs_ready(), '传感器恢复不能掩盖已经丢失的运动轨迹')
        node = self.harness()
        node.started = True
        node.stamps['imu'] = 10.
        message = Odometry()
        message.header.stamp.sec = 9
        self.assertFalse(node.accept_stamp('imu', message))
        self.assertTrue(node.invalid_reason)

    def test_relay_keeps_provisional_out_of_formal_localization(self):
        node = self.harness()
        message = Odometry()
        message.header.frame_id = 'odom'
        message.child_frame_id = 'base_link'
        message.header.stamp.sec = 10
        message.pose.pose.orientation.w = 1.
        for i in (0,7,35):
            message.pose.covariance[i] = .01
            message.twist.covariance[i] = .01
        node.filtered_cb(message)
        self.assertEqual(len(node.preview), 1)
        self.assertEqual(len(node.local), 0)
        node.last['odom'] = 9.
        message.header.stamp.nanosec = 1
        node.filtered_cb(message)
        self.assertEqual(len(node.preview), 1, '不能继续转发EKF无观测的预测输出')


    def test_gap_callback_stops_imu_and_odometry_immediately(self):
        for key in ('imu', 'odom'):
            node = self.harness()
            node.config['imu_frame'] = 'imu_link'
            node.started = True
            node.stamps[key] = 9.7
            published = []
            node.imu_pub = node.odom_pub = SimpleNamespace(publish=published.append)
            message = Imu() if key == 'imu' else Odometry()
            message.header.stamp.sec = 10
            message.header.frame_id = 'imu_link' if key == 'imu' else 'odom'
            if key == 'odom':
                message.child_frame_id = 'base_link'
            else:
                message.linear_acceleration.z = 9.81
            getattr(node, key+'_cb')(message)
            self.assertTrue(node.invalid_reason)
            self.assertEqual(published, [], '发现断流的同一回调不能再发布一帧旧融合输入')

    def test_filter_loss_also_invalidates_and_exposes_automatic_recovery(self):
        node = self.harness()
        node.epoch = 'old-origin'
        node.started = True
        node.last['filter'] = 9.
        node.status()
        status = json.loads(node.statuses[-1].data)
        self.assertEqual(status['state'], 'INVALID')
        self.assertFalse(status['ready'])
        self.assertFalse(status['mappingReady'])
        self.assertIsNone(status['pose'])
        self.assertFalse(status['lateralSupported'])
        self.assertTrue(status['recovery']['requiresNewEpoch'])
        self.assertIn('保持静止，正在自动恢复', status['reason'])
        self.assertNotIn('需重启', status['reason'])
        self.assertEqual(status['epoch'], 'old-origin', '真正重建前不得伪造新epoch')

    def test_clock_rewind_before_first_pose_also_requires_new_session(self):
        node = self.harness()
        node.stamps['imu'] = 10.1
        message = Imu()
        message.header.stamp.sec = 10
        self.assertFalse(node.accept_stamp('imu', message))
        self.assertTrue(node.invalid_reason)
        self.assertFalse(node.inputs_ready())


    def test_input_already_sent_before_first_pose_still_invalidates_on_mode_or_gap(self):
        node = self.harness()
        node.inputs_started = True
        node.started = False
        node.config['stationary_feedback_gears'] = [0, 1, 2]
        node.mode_allowed = lambda: False
        feedback = ChassisInfoFb()
        feedback.header.stamp.sec = 10
        feedback.ctrl_fb.ctrl_fb_gear = 8
        node.feedback_cb(feedback)
        self.assertTrue(node.invalid_reason)
        self.assertFalse(node.inputs_ready())
        node = self.harness()
        node.inputs_started = True
        node.last['odom'] = 9.
        node.status()
        self.assertEqual(json.loads(node.statuses[-1].data)['state'], 'INVALID')

    def test_new_node_has_new_epoch_and_empty_calibration_and_ekf_relay_state(self):
        # Mock ROS wiring only: execute the actual constructor twice without connecting DDS.
        from rclpy.node import Node
        config = yaml.safe_load((ROOT/'config/fusion_inputs.yaml').read_text())['qr_fusion_inputs']['ros__parameters']
        config.update(source='legacy', odom_topic='/odom', existing_chassis_confirmed=False)
        with mock.patch.object(Node, '__init__', return_value=None), \
             mock.patch.object(FusionInputs, 'declare_parameter'), \
             mock.patch.object(FusionInputs, 'get_parameter', side_effect=lambda key: SimpleNamespace(value=config[key])), \
             mock.patch.object(FusionInputs, 'create_publisher'), \
             mock.patch.object(FusionInputs, 'create_subscription'), \
             mock.patch.object(FusionInputs, 'create_timer'), \
             mock.patch.object(FusionInputs, 'get_logger'):
            old = FusionInputs()
            old.calibration.result = {'old': True}
            old.filtered = Odometry()
            new = FusionInputs()
        self.assertNotEqual(old.epoch, new.epoch)
        self.assertIsNone(new.calibration.result)
        self.assertIsNone(new.filtered)
        self.assertIsNone(new.last_relay)
        self.assertFalse(new.started)
        self.assertFalse(new.inputs_started)
        self.assertTrue(all(value is None for value in new.stamps.values()))
        self.assertFalse(new.mapping_ready())


class RecoveryTests(unittest.TestCase):
    publishers = {key: 1 for key in ('imu', 'odom', 'feedback', 'status')}

    def setUp(self):
        self.inputs = {'source': 'legacy', 'imu_frame': 'imu_link', 'input_timeout_s': .25,
                       'stationary_feedback_gears': [0, 1, 2], 'wheel_calibration_verified': False}
        self.gate = RecoveryGate(self.inputs)

    def stamp(self, msg, stamp):
        msg.header.stamp.sec = int(stamp)
        msg.header.stamp.nanosec = int(round((stamp-int(stamp))*1e9))
        return msg

    def messages(self, stamp):
        imu = self.stamp(Imu(), stamp)
        imu.header.frame_id = 'imu_link'
        imu.linear_acceleration.z = 9.81
        odom = self.stamp(Odometry(), stamp)
        odom.header.frame_id = 'odom'
        odom.child_frame_id = 'base_link'
        feedback = self.stamp(ChassisInfoFb(), stamp)
        return {'imu': imu, 'odom': odom, 'feedback': feedback}

    def status(self, now, ros_now=None, epoch='old', state='INVALID'):
        ros_now = now if ros_now is None else ros_now
        self.gate.status({'stamp': ros_now, 'epoch': epoch, 'state': state,
                          'ready': state in ('PROVISIONAL', 'FUSED')}, ros_now, now)

    def tick(self, now, *, ros_now=None, omit=(), modify=None, publishers=None, epoch='old', state='INVALID'):
        ros_now = round(now if ros_now is None else ros_now, 9)
        messages = self.messages(ros_now)
        if modify:
            modify(messages)
        for key, msg in messages.items():
            if key not in omit:
                self.gate.observe(key, msg, ros_now, now)
        self.status(now, ros_now, epoch, state)
        return self.gate.ready_to_restart(ros_now, now, self.publishers if publishers is None else publishers)

    def run_quiet(self, start=10., steps=18, **kwargs):
        return [self.tick(start + i*.05, **kwargs) for i in range(steps)]

    def test_only_fresh_invalid_status_and_continuous_raw_input_allow_restart(self):
        outcomes = self.run_quiet()
        self.assertFalse(any(outcomes[:15]))
        self.assertTrue(outcomes[-1])
        self.gate.restarted(11.)
        self.assertIsNone(self.gate.fusion)
        self.assertTrue(all(value is None for value in self.gate.last.values()))
        self.assertEqual(self.gate.retired_epoch, 'old')
        self.assertFalse(any(self.run_quiet(12., epoch='old')), '旧epoch排队状态不能触发第二次重建')
        self.assertTrue(self.run_quiet(13., epoch='new')[-1])

    def test_publisher_presence_without_messages_does_not_authorize_restart(self):
        self.status(10.)
        self.assertFalse(self.gate.ready_to_restart(10., 10., self.publishers))
        self.assertIn('新鲜', self.gate.reason)
        self.assertFalse(any(self.run_quiet(10., omit=('imu',))))

    def test_long_sensor_outage_waits_without_attempts_then_recovers(self):
        for now in (10., 100., 1000.):
            self.assertFalse(self.tick(now, omit=('imu',), publishers={**self.publishers, 'imu': 0}))
        self.assertEqual(self.gate.attempts, 0)
        self.assertTrue(self.run_quiet(1000.1)[-1])

    def test_disappearance_and_duplicate_publishers_reset_stationary_window(self):
        for bad_count in (0, 2):
            self.gate = RecoveryGate(self.inputs)
            self.run_quiet(10., steps=12)
            self.assertFalse(self.tick(10.6, publishers={**self.publishers, 'odom': bad_count}))
            self.assertFalse(any(self.run_quiet(10.65, steps=14)))
            self.assertTrue(self.tick(11.45))

    def test_stationary_crab_mode_is_still_rejected(self):
        for body, steering in ((8, 7), (6, 7), (8, 5)):
            def crab(messages):
                messages['feedback'].ctrl_fb.ctrl_fb_gear = body
                messages['feedback'].steering_ctrl_fb.steering_ctrl_fb_gear = steering
            self.assertFalse(any(self.run_quiet(10., modify=crab)))
            self.gate = RecoveryGate(self.inputs)

    def test_any_real_motion_prevents_restart_even_if_body_feedback_says_zero(self):
        for mutate in (lambda m: setattr(m['feedback'].lf_wheel_fb, 'lf_wheel_fb_velocity', .01),
                       lambda m: setattr(m['odom'].twist.twist.linear, 'x', .01),
                       lambda m: setattr(m['imu'].angular_velocity, 'z', .03),
                       lambda m: setattr(m['imu'].linear_acceleration, 'z', 0.),
                       lambda m: setattr(m['feedback'].ctrl_fb, 'ctrl_fb_z_angular', math.nan)):
            self.gate = RecoveryGate(self.inputs)
            self.assertFalse(any(self.run_quiet(modify=mutate)))

    def test_brief_motion_requires_entire_new_stationary_window(self):
        self.run_quiet(10., steps=12)
        self.tick(10.6, modify=lambda m: setattr(m['odom'].twist.twist.linear, 'y', .01))
        self.assertFalse(any(self.run_quiet(10.65, steps=14)))
        self.assertTrue(self.tick(11.45))

    def test_stale_future_wrong_frame_and_duplicate_messages_cannot_count_as_fresh(self):
        changes = (lambda m: self.stamp(m['imu'], 5.),
                   lambda m: self.stamp(m['imu'], 100.),
                   lambda m: setattr(m['imu'].header, 'frame_id', 'wrong'),
                   lambda m: setattr(m['odom'].header, 'frame_id', 'map'),
                   lambda m: self.stamp(m['feedback'], 10.))
        for mutate in changes:
            self.gate = RecoveryGate(self.inputs)
            self.assertFalse(any(self.run_quiet(modify=mutate)))

    def test_missing_status_never_uses_old_invalid_status_for_restart(self):
        self.run_quiet(10., steps=12)
        for i in range(20):
            now = 10.6+i*.05
            for key, msg in self.messages(now).items():
                self.gate.observe(key, msg, now, now)
            ready = self.gate.ready_to_restart(now, now, self.publishers)
        self.assertFalse(ready)
        self.assertIsNone(self.gate.stable_since)

    def test_global_clock_rewind_clears_window_and_recovers_on_new_timeline(self):
        self.run_quiet(10., steps=12)
        self.assertFalse(self.tick(10.6, ros_now=5.))
        for i in range(1, 15):
            self.assertFalse(self.tick(10.6+i*.05, ros_now=5.+i*.05))
        self.assertTrue(self.tick(11.4, ros_now=5.8))

    def test_single_sensor_timestamp_rewind_rebaselines_without_accepting_duplicates(self):
        self.run_quiet(10., steps=12)
        self.assertFalse(self.tick(10.6, modify=lambda m: self.stamp(m['imu'], 10.4)))
        self.assertFalse(any(self.run_quiet(10.65, steps=14)))
        self.assertTrue(self.tick(11.45))

    def test_sensor_receive_gap_requires_entire_new_stationary_window(self):
        self.run_quiet(10., steps=12)
        self.assertFalse(self.tick(11.))
        self.assertFalse(any(self.run_quiet(11.05, steps=14)))
        self.assertTrue(self.tick(11.8))

    def test_exponential_backoff_is_bounded_and_stable_health_resets_it(self):
        self.assertTrue(self.run_quiet()[-1])
        self.gate.restarted(11.)
        self.assertEqual(self.gate.next_attempt, 13.)
        self.assertFalse(any(self.run_quiet(11.1, epoch='new')))
        self.assertTrue(self.run_quiet(12.2, epoch='new')[-1])
        self.gate.restarted(13.1)
        self.assertAlmostEqual(self.gate.next_attempt, 17.1)
        for i in range(10):
            self.status(20.+i, epoch=str(i))
            self.gate.restarted(20.+i)
        self.assertLessEqual(self.gate.next_attempt - 29., 30.)
        for i in range(100):
            self.assertFalse(self.tick(50.+i*.1, epoch='healthy', state='PROVISIONAL'))
        self.assertGreater(self.gate.attempts, 0)
        self.assertFalse(self.tick(60.1, epoch='healthy', state='PROVISIONAL'))
        self.assertEqual(self.gate.attempts, 0)

    def test_calibrating_waiting_and_healthy_states_are_never_restarted(self):
        for state in ('CALIBRATING', 'WAITING', 'PROVISIONAL', 'FUSED'):
            self.gate = RecoveryGate(self.inputs)
            self.assertFalse(any(self.run_quiet(state=state)))
            self.assertEqual(self.gate.attempts, 0)

    def test_unverified_wheel_mapping_cannot_be_recovered_as_verified(self):
        self.gate = RecoveryGate({**self.inputs, 'source': 'wheels'})
        self.assertFalse(any(self.run_quiet()))

    def test_real_owned_children_are_reaped_before_replacement(self):
        # 启动两个无ROS/硬件连接的休眠Python进程，检查真实PID回收语义。
        command = [sys.executable, '-c', 'import time; time.sleep(60)']
        real_popen = subprocess.Popen
        def quiet_popen(command):
            return real_popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with tempfile.TemporaryDirectory() as directory, mock.patch('run_fusion.subprocess.Popen', side_effect=quiet_popen):
            children = OwnedChildren([command, command], Path(directory)/'children.json')
            try:
                children.start()
                old = list(children.children)
                self.assertEqual(len(old), 2)
                with self.assertRaises(RuntimeError):
                    children.start()
                children.stop()
                self.assertTrue(all(child.poll() is not None for child in old))
                children.start()
                self.assertTrue(set(c.pid for c in old).isdisjoint(c.pid for c in children.children))
                self.assertEqual(json.loads(children.processes_file.read_text())['children'],
                                 [child.pid for child in children.children])
            finally:
                children.stop()

    def test_partial_launch_failure_cleans_up_only_owned_process(self):
        real_popen = subprocess.Popen
        created = []
        def launch(command):
            child = real_popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            created.append(child)
            return child
        with tempfile.TemporaryDirectory() as directory, mock.patch('run_fusion.subprocess.Popen', side_effect=launch):
            children = OwnedChildren([[sys.executable, '-c', 'import time; time.sleep(60)'],
                                      ['/missing/qr-fusion-test-binary']], Path(directory)/'children.json')
            with self.assertRaises(FileNotFoundError):
                children.start()
            self.assertEqual(children.children, [])
            self.assertEqual(len(created), 1)
            self.assertIsNotNone(created[0].poll())

    def test_direct_supervisor_launch_has_exclusive_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'fusion.lock'
            first = acquire_lock(path)
            try:
                with self.assertRaisesRegex(RuntimeError, '拒绝争用'):
                    acquire_lock(path)
            finally:
                os.close(first)
            second = acquire_lock(path)
            os.close(second)


if __name__ == '__main__':
    unittest.main(verbosity=2)
