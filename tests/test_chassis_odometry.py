"""离线ROS消息测试：不创建DDS节点、不操作底盘、不作为实测记录。"""
import json
import math
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import yaml
from nav_msgs.msg import Odometry
from sensor_msgs.msg import Imu
from yhs_can_interfaces.msg import ChassisInfoFb
from rclpy.node import Node

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT/'scripts'))
from greenhouse_navigation.chassis_odometry import ChassisOdometry, body_twist, chassis_mode_allowed
from greenhouse_navigation.fusion import FusionInputs, StationaryCalibration, usable_odometry
from run_fusion import load_configuration, RecoveryGate, OUTPUT_TOPICS


def feedback(stamp=10., gear=6, vx=.12, raw_vy=0., yaw_deg=0.):
    msg = ChassisInfoFb()
    msg.header.stamp.sec = int(stamp)
    msg.header.stamp.nanosec = int(round((stamp-int(stamp))*1e9))
    msg.ctrl_fb.ctrl_fb_gear = gear
    msg.ctrl_fb.ctrl_fb_x_linear = vx
    msg.ctrl_fb.ctrl_fb_y_linear = raw_vy
    msg.ctrl_fb.ctrl_fb_z_angular = yaw_deg
    return msg


def odometry(stamp=10., vx=.12, vy=.06, wz=.5):
    msg = Odometry()
    msg.header.stamp.sec = int(stamp)
    msg.header.stamp.nanosec = int(round((stamp-int(stamp))*1e9))
    msg.header.frame_id = 'odom'
    msg.child_frame_id = 'base_link'
    msg.pose.pose.orientation.w = 1.
    msg.twist.twist.linear.x, msg.twist.twist.linear.y, msg.twist.twist.angular.z = vx, vy, wz
    for i in (0, 7, 35):
        msg.pose.covariance[i] = .01
        msg.twist.covariance[i] = .0009
    return msg


class ChassisOdometryTests(unittest.TestCase):
    def harness(self):
        node = ChassisOdometry.__new__(ChassisOdometry)
        node.config = {'motion_confirmed': True, 'lateral_velocity_scale': .1,
                       'input_timeout_s': .25, 'velocity_sigma_mps': .03, 'yaw_sigma_rad_s': .02}
        node.now = lambda: 10.
        node.previous = None
        node.x = node.y = node.yaw = 0.
        node.outputs = []
        node.pub = SimpleNamespace(publish=node.outputs.append)
        return node

    def test_signed_forward_and_reverse_unchanged(self):
        for speed in (.12, -.12):
            vx, vy, wz = body_twist(feedback(vx=speed))
            self.assertAlmostEqual(vx, speed, places=6)
            self.assertEqual((vy, wz), (0., 0.))

    def test_signed_lateral_scaling_and_angle_conversion_once(self):
        for sign in (1., -1.):
            vx, vy, wz = body_twist(feedback(gear=8, vx=0., raw_vy=sign*.6, yaw_deg=sign*90.))
            self.assertEqual(vx, 0.)
            self.assertAlmostEqual(vy, sign*.06, places=6)
            self.assertAlmostEqual(wz, sign*math.pi/2)

    def test_nonfinite_each_body_field_rejected(self):
        for field in ('ctrl_fb_x_linear', 'ctrl_fb_y_linear', 'ctrl_fb_z_angular'):
            for value in (math.nan, math.inf, -math.inf):
                msg = feedback()
                setattr(msg.ctrl_fb, field, value)
                with self.assertRaises(ValueError):
                    body_twist(msg)

    def test_park_requires_zero_and_unknown_gears_rejected(self):
        for gear in (0, 1, 2):
            self.assertEqual(body_twist(feedback(gear=gear, vx=0.)), (0., 0., 0.))
            with self.assertRaises(ValueError):
                body_twist(feedback(gear=gear))
        for gear in (3, 4, 5, 7, 9):
            with self.assertRaises(ValueError):
                body_twist(feedback(gear=gear, vx=0.))
        self.assertTrue(chassis_mode_allowed(8, False))

    def test_first_frame_publishes_velocity_covariance_without_integration(self):
        node = self.harness()
        msg = feedback(raw_vy=.6, yaw_deg=10.)
        node.receive(msg)
        self.assertEqual(len(node.outputs), 1)
        out = node.outputs[0]
        self.assertTrue(usable_odometry(out))
        self.assertEqual((node.x, node.y, node.yaw), (0., 0., 0.))
        self.assertAlmostEqual(out.twist.twist.linear.y, .06, places=6)
        self.assertAlmostEqual(out.twist.twist.angular.z, math.radians(10.))
        self.assertAlmostEqual(out.twist.covariance[0], .03**2)
        self.assertAlmostEqual(out.twist.covariance[7], .03**2)
        self.assertAlmostEqual(out.twist.covariance[35], .02**2)
        self.assertEqual(msg.header.frame_id, '', '不得改写底盘输入消息')

    def test_forward_reverse_and_crab_integrate_signed_motion(self):
        for vx, raw_vy, gear in ((.1, 0., 6), (-.1, 0., 6), (0., .6, 8), (0., -.6, 8)):
            node = self.harness()
            node.receive(feedback(gear=gear, vx=vx, raw_vy=raw_vy))
            node.now = lambda: 10.1
            node.receive(feedback(10.1, gear=gear, vx=vx, raw_vy=raw_vy))
            self.assertAlmostEqual(node.x, vx*.1, places=7)
            self.assertAlmostEqual(node.y, raw_vy*.01, places=7)

    def test_turn_integration_uses_body_frame(self):
        node = self.harness()
        node.yaw = math.pi/2
        node.receive(feedback(vx=.1, yaw_deg=10.))
        node.now = lambda: 10.1
        node.receive(feedback(10.1, vx=.1, yaw_deg=10.))
        self.assertGreater(node.y, .0099)
        self.assertLess(node.x, 0.)
        self.assertAlmostEqual(node.yaw, math.pi/2+math.radians(1.))

    def test_stale_future_duplicate_and_invalid_input_not_published(self):
        node = self.harness()
        for msg in (feedback(9.), feedback(11.), feedback(yaw_deg=math.nan), feedback(vx=math.nan)):
            node.receive(msg)
        self.assertEqual(node.outputs, [])
        node.receive(feedback())
        node.receive(feedback())
        node.receive(feedback(9.9))
        self.assertEqual(len(node.outputs), 1)

    def test_input_gap_does_not_invent_displacement(self):
        node = self.harness()
        node.receive(feedback())
        node.now = lambda: 11.
        node.receive(feedback(11.))
        self.assertEqual(node.x, 0.)
        self.assertEqual(len(node.outputs), 2, '新时间戳必须可供融合检测断流')

    def test_clock_rewind_rebaselines_without_publishing_rollback(self):
        node = self.harness()
        node.receive(feedback())
        node.now = lambda: 5.
        node.receive(feedback(5.))
        self.assertIsNone(node.previous)
        self.assertEqual(len(node.outputs), 1)
        node.now = lambda: 5.1
        node.receive(feedback(5.1))
        self.assertEqual(node.x, 0.)

    def test_constructor_is_only_one_odometry_publisher_and_feedback_subscription(self):
        config = self.harness().config
        with mock.patch.object(Node, '__init__', return_value=None), \
             mock.patch.object(ChassisOdometry, 'declare_parameter'), \
             mock.patch.object(ChassisOdometry, 'get_parameter', side_effect=lambda key: SimpleNamespace(value=config[key])), \
             mock.patch.object(ChassisOdometry, 'create_publisher') as publisher, \
             mock.patch.object(ChassisOdometry, 'create_subscription') as subscriber, \
             mock.patch.object(ChassisOdometry, 'get_logger'):
            ChassisOdometry()
        publisher.assert_called_once_with(Odometry, '/qr/chassis/odom', 10)
        self.assertEqual(subscriber.call_count, 1)
        self.assertEqual(subscriber.call_args.args[:2], (ChassisInfoFb, '/chassis_info_fb'))

    def test_constructor_rejects_no_confirmation_wrong_units_and_bad_variances(self):
        cases = [('motion_confirmed', False), ('lateral_velocity_scale', 1.),
                 ('input_timeout_s', 0.), ('velocity_sigma_mps', 0.), ('yaw_sigma_rad_s', math.nan)]
        for key, value in cases:
            config = {**self.harness().config, key: value}
            with mock.patch.object(Node, '__init__', return_value=None), \
                 mock.patch.object(ChassisOdometry, 'declare_parameter'), \
                 mock.patch.object(ChassisOdometry, 'get_parameter', side_effect=lambda key: SimpleNamespace(value=config[key])), \
                 mock.patch.object(ChassisOdometry, 'create_publisher') as publisher:
                with self.assertRaises(ValueError):
                    ChassisOdometry()
                publisher.assert_not_called()


class ChassisFusionTests(unittest.TestCase):
    def harness(self, confirmed=True):
        node = FusionInputs.__new__(FusionInputs)
        node.config = {'source': 'chassis', 'existing_chassis_confirmed': confirmed,
                       'wheel_calibration_verified': False, 'noise_calibration_verified': False,
                       'imu_projection_verified': False, 'input_timeout_s': .25,
                       'stationary_feedback_gears': [0, 1, 2], 'wheel_velocity_sigma_mps': .03,
                       'lateral_constraint_sigma_mps': .05, 'imu_frame': 'imu_link'}
        node.now = lambda: 10.
        node.feedback = feedback(gear=8, vx=0., raw_vy=.6)
        node.last = {key: 10. for key in ('feedback', 'imu', 'odom', 'filter')}
        node.stamps = dict.fromkeys(node.last)
        node.counts = dict.fromkeys(('imu', 'odom', 'filter', 'provisional', 'local'), 0)
        node.calibration = StationaryCalibration()
        node.calibration.result = {'bias': [0., 0., 0.], 'up': [0., 0., 1.], 'variance': .000025}
        node.invalid_reason = ''
        node.started = node.inputs_started = False
        node.last_relay = None
        node.filtered = None
        node.outputs, node.local, node.preview, node.statuses = [], [], [], []
        node.odom_pub = SimpleNamespace(publish=node.outputs.append)
        node.local_pub = SimpleNamespace(publish=node.local.append)
        node.preview_pub = SimpleNamespace(publish=node.preview.append)
        node.status_pub = SimpleNamespace(publish=node.statuses.append)
        return node

    def test_confirmation_qualifies_without_falsifying_other_flags(self):
        node = self.harness()
        self.assertTrue(node.mapping_ready())
        self.assertTrue(node.mode_allowed())
        for key in ('wheel_calibration_verified', 'noise_calibration_verified', 'imu_projection_verified'):
            self.assertFalse(node.config[key])
        node.config['existing_chassis_confirmed'] = False
        self.assertFalse(node.mapping_ready())
        self.assertFalse(node.mode_allowed())

    def test_live_feedback_required_in_confirmed_mode(self):
        node = self.harness()
        node.last['feedback'] = 9.
        self.assertFalse(node.mode_allowed())
        node.last['feedback'] = 10.
        node.feedback.ctrl_fb.ctrl_fb_gear = 7
        self.assertTrue(node.mode_allowed())
        self.assertFalse(chassis_mode_allowed(7,False))

    def test_raw_wheel_signs_not_used_for_moving_body_mode(self):
        node = self.harness()
        node.feedback.lf_wheel_fb.lf_wheel_fb_velocity = -.1
        node.feedback.front_angle_fb.front_angle_fb_l = -90.
        self.assertTrue(node.mode_allowed())

    def test_relay_preserves_xy_only_never_reuses_body_yaw(self):
        node = self.harness()
        node.odom_cb(odometry())
        self.assertEqual(len(node.outputs), 1)
        out = node.outputs[0]
        self.assertEqual(out.twist.twist.linear.x, .12)
        self.assertEqual(out.twist.twist.linear.y, .06)
        self.assertEqual(out.twist.twist.angular.z, 0.)
        self.assertEqual(out.twist.covariance[35], 1e6)
        self.assertAlmostEqual(out.twist.covariance[7], .0009)

    def test_bad_covariance_rejected(self):
        node = self.harness()
        msg = odometry()
        msg.twist.covariance[7] = 0.
        node.odom_cb(msg)
        self.assertEqual(node.outputs, [])

    def test_imu_runtime_calibration_is_still_required(self):
        node = self.harness()
        node.calibration.result = None
        self.assertFalse(node.inputs_ready())
        node.odom_cb(odometry())
        self.assertEqual(node.outputs, [])

    def test_expired_clock_gap_still_invalidates_confirmed_source(self):
        node = self.harness()
        node.inputs_started = True
        node.stamps['odom'] = 9.7
        node.odom_cb(odometry())
        self.assertTrue(node.invalid_reason)
        self.assertEqual(node.outputs, [])

    def test_formal_local_output_and_truthful_approval_status(self):
        node = self.harness()
        node.filtered_cb(odometry())
        self.assertEqual(len(node.local), 1)
        node.status()
        status = json.loads(node.statuses[-1].data)
        self.assertEqual(status['state'], 'FUSED')
        self.assertTrue(status['mappingReady'])
        self.assertTrue(status['lateralSupported'])
        self.assertEqual(status['approvalBasis'], 'user_confirmation')
        self.assertFalse(status['hardwareControl'])

    def test_legacy_and_wheels_mapping_policy_unchanged(self):
        node = self.harness()
        node.config['source'] = 'legacy'
        self.assertFalse(node.mapping_ready())
        node.config['source'] = 'wheels'
        self.assertFalse(node.mapping_ready())
        for key in ('wheel_calibration_verified', 'noise_calibration_verified', 'imu_projection_verified'):
            node.config[key] = True
        self.assertTrue(node.mapping_ready())
        node.config['imu_projection_verified'] = False
        self.assertFalse(node.mapping_ready())

    def test_constructor_requires_explicit_confirmation_and_retains_real_calibration(self):
        config = yaml.safe_load((ROOT/'config/fusion_inputs.yaml').read_text())['qr_fusion_inputs']['ros__parameters']
        for confirmed in (False, True):
            parameters = {**config, 'source': 'chassis', 'existing_chassis_confirmed': confirmed}
            with mock.patch.object(Node, '__init__', return_value=None), \
                 mock.patch.object(FusionInputs, 'declare_parameter') as declare, \
                 mock.patch.object(FusionInputs, 'get_parameter', side_effect=lambda key: SimpleNamespace(value=parameters[key])), \
                 mock.patch.object(FusionInputs, 'create_publisher'), \
                 mock.patch.object(FusionInputs, 'create_subscription'), \
                 mock.patch.object(FusionInputs, 'create_timer'), \
                 mock.patch.object(FusionInputs, 'get_logger'):
                if not confirmed:
                    with self.assertRaisesRegex(ValueError, '用户确认'):
                        FusionInputs()
                else:
                    node = FusionInputs()
                    self.assertIsNone(node.calibration.result)
                    self.assertTrue(node.mapping_ready())
                    self.assertFalse(node.inputs_ready())
                self.assertIn(mock.call('existing_chassis_confirmed', False), declare.call_args_list)

    def test_confirmed_chassis_source_rejects_nonfinite_measurement(self):
        node = self.harness()
        node.inputs_started = True
        node.feedback_cb(feedback(gear=6, vx=math.nan))
        self.assertIn('速度测量无效', node.invalid_reason)
        self.assertNotIn('横移未标定', node.invalid_reason)


class ChassisLauncherTests(unittest.TestCase):
    def configuration(self, directory):
        inputs = yaml.safe_load((ROOT/'config/fusion_inputs.yaml').read_text())
        inputs['qr_fusion_inputs']['ros__parameters'].update(source='chassis', odom_topic='/qr/chassis/odom', existing_chassis_confirmed=True)
        chassis = {'qr_chassis_odometry': {'ros__parameters': {
            'motion_confirmed': True, 'lateral_velocity_scale': .1, 'input_timeout_s': .25,
            'velocity_sigma_mps': .03, 'yaw_sigma_rad_s': .02}}}
        args = SimpleNamespace(inputs=Path(directory)/'inputs.yaml',
                               chassis=Path(directory)/'chassis.yaml', ekf=ROOT/'config/ekf_provisional.yaml')
        args.inputs.write_text(yaml.safe_dump(inputs))
        args.chassis.write_text(yaml.safe_dump(chassis))
        return args, inputs, chassis

    def test_adapter_first_and_managed_as_owned_child(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(Path, 'exists', return_value=True):
            args, _, _ = self.configuration(directory)
            inputs, commands = load_configuration(args)
        self.assertEqual(inputs['source'], 'chassis')
        self.assertEqual(len(commands), 3)
        self.assertTrue(commands[0][1].endswith('/chassis_odometry'))
        self.assertTrue(commands[1][1].endswith('/fusion_inputs'))
        self.assertTrue(commands[2][0].endswith('/ekf_node'))
        self.assertIn('/qr/chassis/odom', OUTPUT_TOPICS)

    def test_both_confirmations_topic_and_scale_are_explicit(self):
        for invalid in ('fusion-confirmation', 'adapter-confirmation', 'topic', 'scale'):
            with tempfile.TemporaryDirectory() as directory, mock.patch.object(Path, 'exists', return_value=True):
                args, inputs, chassis = self.configuration(directory)
                if invalid == 'fusion-confirmation':
                    inputs['qr_fusion_inputs']['ros__parameters'].pop('existing_chassis_confirmed')
                elif invalid == 'adapter-confirmation':
                    chassis['qr_chassis_odometry']['ros__parameters']['motion_confirmed'] = False
                elif invalid == 'topic':
                    inputs['qr_fusion_inputs']['ros__parameters']['odom_topic'] = '/odom'
                else:
                    chassis['qr_chassis_odometry']['ros__parameters']['lateral_velocity_scale'] = 1.
                args.inputs.write_text(yaml.safe_dump(inputs))
                args.chassis.write_text(yaml.safe_dump(chassis))
                with self.assertRaises(ValueError):
                    load_configuration(args)

    def test_masks_cannot_add_duplicate_body_angular_velocity(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(Path, 'exists', return_value=True):
            args, _, _ = self.configuration(directory)
            ekf = yaml.safe_load(args.ekf.read_text())
            ekf['ekf_filter_node']['ros__parameters']['odom0_config'][11] = True
            args.ekf = Path(directory)/'ekf.yaml'
            args.ekf.write_text(yaml.safe_dump(ekf))
            with self.assertRaises(ValueError):
                load_configuration(args)

    def test_legacy_and_wheels_launch_contract_remains_two_children(self):
        for source, topic in (('legacy', '/odom'), ('wheels', '/qr/wheel/odom')):
            with tempfile.TemporaryDirectory() as directory, mock.patch.object(Path, 'exists', return_value=True):
                args, inputs, _ = self.configuration(directory)
                inputs['qr_fusion_inputs']['ros__parameters'].update(source=source, odom_topic=topic,
                                                                     wheel_calibration_verified=source == 'wheels')
                args.inputs.write_text(yaml.safe_dump(inputs))
                _, commands = load_configuration(args)
                self.assertEqual(len(commands), 2)
                self.assertTrue(commands[0][1].endswith('/fusion_inputs'))

    def test_missing_adapter_binary_rejected_before_any_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            args, _, _ = self.configuration(directory)
            with mock.patch.object(Path, 'exists', side_effect=lambda p=None: True) as exists:
                exists.side_effect = [True, False]
                with self.assertRaisesRegex(ValueError, 'chassis_odometry'):
                    load_configuration(args)

    def test_recovery_requires_quiet_fresh_inputs_and_confirmation(self):
        for confirmed in (True, False):
            gate = RecoveryGate({'source': 'chassis', 'existing_chassis_confirmed': confirmed,
                                 'input_timeout_s': .25, 'stationary_feedback_gears': [0, 1, 2]})
            ready = False
            for i in range(19):
                stamp = 10.+i*.05
                fb = feedback(stamp, gear=0, vx=0.)
                imu = Imu()
                imu.header = fb.header
                imu.header.frame_id = 'imu_link'
                imu.linear_acceleration.z = 9.81
                for key, msg in (('feedback', fb), ('imu', imu), ('odom', odometry(stamp, 0., 0., 0.))):
                    gate.observe(key, msg, stamp, stamp)
                gate.status({'stamp': stamp, 'epoch': 'old', 'state': 'INVALID'}, stamp, stamp)
                ready = gate.ready_to_restart(stamp, stamp, dict.fromkeys(('feedback', 'imu', 'odom', 'status'), 1))
            self.assertEqual(ready, confirmed)
            if confirmed:
                gate.last['feedback'] = 9.
                self.assertFalse(gate.ready_to_restart(stamp, stamp, dict.fromkeys(('feedback', 'imu', 'odom', 'status'), 1)))


if __name__ == '__main__':
    unittest.main(verbosity=2)
