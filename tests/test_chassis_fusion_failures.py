"""完整消息异常/首帧EKF超时的离线复现；不初始化ROS或发布硬件命令。"""
import copy
import json
import math
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

from nav_msgs.msg import Odometry
from sensor_msgs.msg import Imu
from yhs_can_interfaces.msg import ChassisInfoFb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT/'scripts'))
from greenhouse_navigation.fusion import FusionInputs, StationaryCalibration, FIRST_FILTER_TIMEOUT_S
from run_fusion import RecoveryGate


def stamped(msg, stamp):
    msg.header.stamp.sec = int(stamp)
    msg.header.stamp.nanosec = round((stamp-int(stamp))*1e9)
    return msg


def odometry(stamp):
    msg = stamped(Odometry(), stamp)
    msg.header.frame_id = 'odom'
    msg.child_frame_id = 'base_link'
    msg.pose.pose.orientation.w = 1.
    for i in (0, 7, 35):
        msg.pose.covariance[i] = .01
        msg.twist.covariance[i] = .0009
    return msg


class ChassisFusionFailureTests(unittest.TestCase):
    def harness(self, source='chassis', calibrated=True):
        node = FusionInputs.__new__(FusionInputs)
        node.config = {'source': source, 'existing_chassis_confirmed': source == 'chassis',
                       'wheel_calibration_verified': source == 'wheels', 'noise_calibration_verified': False,
                       'imu_projection_verified': False, 'input_timeout_s': .25,
                       'stationary_feedback_gears': [0, 1, 2], 'imu_frame': 'imu_link',
                       'wheel_velocity_sigma_mps': .03, 'lateral_constraint_sigma_mps': .05}
        node.clock = 10.
        node.now = lambda: node.clock
        node.last = dict.fromkeys(('imu', 'odom', 'feedback', 'filter'))
        node.stamps = dict(node.last)
        node.counts = dict.fromkeys(('imu', 'odom', 'filter', 'provisional', 'local'), 0)
        node.calibration = StationaryCalibration(duration=2., minimum=100)
        if calibrated:
            node.calibration.result = {'bias': [0., 0., 0.], 'up': [0., 0., 1.], 'variance': .000025}
        node.feedback = node.filtered = None
        node.started = node.inputs_started = False
        node.filter_wait_started = node.last_relay = None
        node.invalid_reason = ''
        node.epoch = 'failure-test-origin'
        node.outputs, node.imus, node.previews, node.locals, node.statuses = [], [], [], [], []
        node.odom_pub = SimpleNamespace(publish=node.outputs.append)
        node.imu_pub = SimpleNamespace(publish=node.imus.append)
        node.preview_pub = SimpleNamespace(publish=node.previews.append)
        node.local_pub = SimpleNamespace(publish=node.locals.append)
        node.status_pub = SimpleNamespace(publish=node.statuses.append)
        node.get_logger = lambda: SimpleNamespace(info=lambda text: None)
        return node

    def inputs(self, node, stamp, *, include_odom=True, include_imu=True):
        node.clock = stamp
        fb = stamped(ChassisInfoFb(), stamp)
        imu = stamped(Imu(), stamp)
        imu.header.frame_id = 'imu_link'
        imu.linear_acceleration.z = 9.81
        node.feedback_cb(fb)
        if include_imu:
            node.imu_cb(imu)
        if include_odom:
            node.odom_cb(odometry(stamp))
        return {'feedback': fb, 'imu': imu, 'odom': odometry(stamp)}

    def status(self, node):
        node.status()
        return json.loads(node.statuses[-1].data)

    def test_all_bad_covariances_rejected_before_stamp_or_freshness_changes(self):
        for source in ('chassis', 'wheels'):
            for array in ('pose', 'twist'):
                for index, value in ((0, 0.), (7, -.01), (35, 0.), (1, math.nan), (34, math.inf)):
                    with self.subTest(source=source, array=array, index=index, value=value):
                        node = self.harness(source)
                        self.inputs(node, 10.)
                        previous = (copy.copy(node.last), copy.copy(node.stamps), len(node.outputs), node.counts['odom'])
                        node.clock = 10.1
                        msg = odometry(10.1)
                        getattr(msg, array).covariance[index] = value
                        node.odom_cb(msg)
                        self.assertEqual((node.last, node.stamps, len(node.outputs), node.counts['odom']), previous)

    def test_bad_pose_quaternion_velocity_and_frames_do_not_refresh_input(self):
        mutations = (lambda m: setattr(m.pose.pose.position, 'x', math.nan),
                     lambda m: setattr(m.pose.pose.orientation, 'w', 0.),
                     lambda m: setattr(m.twist.twist.linear, 'x', math.inf),
                     lambda m: setattr(m.twist.twist.angular, 'z', math.nan),
                     lambda m: setattr(m.header, 'frame_id', 'map'),
                     lambda m: setattr(m, 'child_frame_id', 'camera'))
        for mutate in mutations:
            node = self.harness()
            self.inputs(node, 10.)
            node.clock = 10.1
            msg = odometry(10.1)
            mutate(msg)
            node.odom_cb(msg)
            self.assertEqual(node.last['odom'], 10.)
            self.assertEqual(node.stamps['odom'], 10.)
            self.assertEqual(len(node.outputs), 1)

    def test_bad_covariance_does_not_poison_clock_and_valid_same_stamp_can_follow(self):
        node = self.harness()
        self.inputs(node, 10.)
        node.clock = 10.1
        bad = odometry(10.1)
        bad.twist.covariance[7] = 0.
        node.odom_cb(bad)
        node.odom_cb(odometry(10.1))
        self.assertEqual(len(node.outputs), 2)
        self.assertEqual(node.stamps['odom'], 10.1)
        self.assertEqual(node.invalid_reason, '')

    def test_continuous_corrupt_odom_cannot_hide_real_input_expiry(self):
        node = self.harness()
        self.inputs(node, 10.)
        node.filtered_cb(odometry(10.))
        for i in range(1, 7):
            stamp = 10.+i*.05
            self.inputs(node, stamp, include_odom=False)
            bad = odometry(stamp)
            bad.twist.covariance[7] = 0.
            node.odom_cb(bad)
        status = self.status(node)
        self.assertEqual(node.last['odom'], 10.)
        self.assertEqual(status['state'], 'INVALID')
        self.assertFalse(status['ready'])
        self.assertTrue(status['recovery']['requiresNewEpoch'])
        self.assertIsNone(status['pose'])

    def test_legacy_zero_covariance_path_remains_compatible(self):
        node = self.harness('legacy')
        self.inputs(node, 10., include_odom=False)
        msg = stamped(Odometry(), 10.)
        msg.header.frame_id = 'odom'
        msg.child_frame_id = 'base_link'
        node.odom_cb(msg)
        self.assertEqual(len(node.outputs), 1)
        self.assertEqual(node.outputs[0].twist.covariance[0], .03**2)

    def test_real_calibration_and_both_inputs_required_before_first_filter_timer(self):
        node = self.harness(calibrated=False)
        for i in range(201):
            self.inputs(node, 10.+i*.01)
        self.assertIsNotNone(node.calibration.result)
        self.assertIsNone(node.filter_wait_started, '校零完成帧尚未发送校零IMU输入')
        self.inputs(node, 12.01)
        self.assertEqual(node.filter_wait_started, 12.01)
        self.assertEqual(self.status(node)['state'], 'WAITING')

    def test_one_input_or_no_effective_input_does_not_arm_timer(self):
        for include_odom, include_imu in ((False, True), (True, False), (False, False)):
            node = self.harness()
            for i in range(30):
                self.inputs(node, 10.+i*.05, include_odom=include_odom, include_imu=include_imu)
            self.assertIsNone(node.filter_wait_started)
            self.assertEqual(self.status(node)['state'], 'WAITING')

    def test_continuous_valid_inputs_without_first_ekf_output_invalidate_all_sources(self):
        for source in ('chassis', 'wheels', 'legacy'):
            node = self.harness(source)
            self.inputs(node, 10.)
            for i in range(1, 20):
                self.inputs(node, 10.+i*.05)
                self.assertEqual(self.status(node)['state'], 'WAITING')
            self.inputs(node, 10.+FIRST_FILTER_TIMEOUT_S)
            status = self.status(node)
            self.assertEqual(node.filter_wait_started, 10., '新输入不得延期首帧截止时间')
            self.assertEqual(status['state'], 'INVALID')
            self.assertIn('EKF首帧', status['reason'])
            self.assertFalse(status['mappingReady'])
            self.assertEqual(status['epoch'], 'failure-test-origin')
            self.assertTrue(status['recovery']['automatic'])
            self.assertTrue(status['recovery']['requiresNewEpoch'])

    def test_malformed_first_filter_cannot_disarm_deadline(self):
        node = self.harness()
        for i in range(21):
            stamp = 10.+i*.05
            self.inputs(node, stamp)
            bad = odometry(stamp)
            bad.pose.covariance[0] = 0.
            node.filtered_cb(bad)
        self.assertIsNone(node.last['filter'])
        self.assertEqual(node.counts['filter'], 0)
        self.assertEqual(self.status(node)['state'], 'INVALID')

    def test_preinput_filter_output_does_not_count_as_first_relay(self):
        node = self.harness()
        node.filtered_cb(odometry(10.))
        self.assertFalse(node.started)
        self.inputs(node, 10.)
        for i in range(1, 21):
            self.inputs(node, 10.+i*.05)
        self.assertEqual(self.status(node)['state'], 'INVALID')

    def test_timely_filter_output_cancels_startup_deadline_and_relays_formal_pose(self):
        node = self.harness()
        for i in range(25):
            stamp = 10.+i*.05
            self.inputs(node, stamp)
            if i >= 5:
                node.filtered_cb(odometry(stamp))
            self.assertEqual(self.status(node)['state'], 'FUSED' if i >= 5 else 'WAITING')
        self.assertTrue(node.started)
        self.assertEqual(node.invalid_reason, '')
        self.assertEqual(len(node.locals), 20)

    def test_late_first_output_cannot_race_status_timer_and_revive_old_epoch(self):
        node = self.harness()
        for i in range(22):
            self.inputs(node, 10.+i*.05)
        node.filtered_cb(odometry(node.clock))
        self.assertFalse(node.started)
        self.assertEqual(node.locals, [])
        self.assertEqual(node.previews, [])
        self.assertIsNone(node.last['filter'])
        self.assertEqual(self.status(node)['state'], 'INVALID')

    def test_timeout_status_drives_existing_stationary_recovery_gate(self):
        node = self.harness()
        gate = RecoveryGate(node.config)
        publishers = dict.fromkeys(('feedback', 'imu', 'odom', 'status'), 1)
        ready = False
        for i in range(39):
            stamp = 10.+i*.05
            messages = self.inputs(node, stamp)
            for key, msg in messages.items():
                gate.observe(key, msg, stamp, stamp)
            gate.status(self.status(node), stamp, stamp)
            ready = gate.ready_to_restart(stamp, stamp, publishers)
            if i <= 20:
                self.assertFalse(ready)
        self.assertTrue(ready)
        gate.restarted(node.clock)
        self.assertEqual(gate.retired_epoch, node.epoch)


if __name__ == '__main__':
    unittest.main(verbosity=2)
