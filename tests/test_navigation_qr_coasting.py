"""Offline QR -> fused pose -> mission regression; no DDS or motor commands."""
from collections import deque
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
import yaml
from nav_msgs.msg import Odometry
from std_msgs.msg import String

import test_runtime_acceptance as fixtures
from greenhouse_navigation.localization import GlobalLocalization
from greenhouse_navigation.mission import Mission
from greenhouse_navigation.node import GreenhouseNode

ROOT = Path(__file__).resolve().parents[1]


class QrCoastingTests(unittest.TestCase):
    def setUp(self):
        self.clock = 100.
        self.clock_patch = patch('time.monotonic', side_effect=lambda: self.clock)
        self.clock_patch.start()
        self.addCleanup(self.clock_patch.stop)
        self.nav = fixtures.RuntimeAcceptanceTests().harness()
        self.nav.config['execution_enabled'] = True
        self.nav.pose = None
        self.nav.pose_received = 0.
        self.nav.tag_received = 0.
        self.nav.active_boards = []
        self.nav.observations = []
        self.nav.feedback.update(body_gear=6, steering_gear=6, steering_angle=0., angles=[0.]*4)
        self.nav.mission = Mission(self.nav.config)
        self.field = {
            'id': 'offline-coasting', 'coordinateStatus': 'reviewed', 'groups': [],
            'rows': [{'id': 'row', 'name': 'offline row', 'points': [{'x': .1, 'y': 0.}, {'x': 2., 'y': 0.}],
                      'exitDistance': .1, 'width': 1.}],
            'tags': [{'id': 0, 'x': .2, 'y': 0., 'angle': 0., 'rowId': 'row', 'rules': []}],
            'vehicle': {'length': .4, 'width': .3, 'margin': .05},
            'zone': [{'x': -1., 'y': -1.}, {'x': 3., 'y': -1.}, {'x': 3., 'y': 1.}, {'x': -1., 'y': 1.}],
        }
        self.task = {'id': 'offline-task', 'rowOrder': ['row'], 'forwardSpeed': .08,
                     'reverseSpeed': .06, 'lateralSpeed': .05, 'endWaitSeconds': 0.}
        self.outputs = []
        loc = self.loc = GlobalLocalization.__new__(GlobalLocalization)
        loc.field = self.field
        loc.boards = []
        loc.tags = {t['id']: t for t in self.field['tags']}
        loc.history = deque(maxlen=300)
        loc.estimate = None
        loc.covariance = np.eye(3)
        loc.last = None
        loc.last_tag = 0.
        loc.formal_origin = False
        loc.formal_preview_at = loc.formal_published_at = None
        loc.enable_stationary_anchor = False
        loc.tf = None
        params = yaml.safe_load((ROOT/'config/global_localization.yaml').read_text())['qr_global_localization']['ros__parameters']
        loc.get_parameter = lambda key: SimpleNamespace(value=params[key])
        loc.get_clock = self.nav.get_clock
        loc.preview_pub = SimpleNamespace(publish=lambda msg: None)
        loc.pub = SimpleNamespace(publish=self.receive_pose)
        loc.get_logger = lambda: SimpleNamespace(warning=lambda text: self.fail(text))
        self.step()
        self.step(packet=self.packet(sigma=.01))
        self.step()
        self.assertIsNotNone(self.nav.pose)
        conditions = self.conditions()
        self.assertTrue(all(c['ready'] for c in conditions), conditions)
        self.nav.mission.start(copy.deepcopy(self.field), copy.deepcopy(self.task), self.nav.pose)
        for seq in range(1, self.nav.config['stable_feedback_samples']+1):
            self.nav.feedback['seq'] = seq
            self.tick()
        self.assertEqual(self.nav.mission.state, 'FORWARD')

    def receive_pose(self, msg):
        self.outputs.append(msg)
        GreenhouseNode.pose_cb(self.nav, msg)

    def packet(self, sigma=.01, x=.2, tags=True):
        return {'frame': 'base_link', 'calibrated': True, 'synchronized': True,
                'tags': [{'id': 0, 'x': x, 'y': 0., 'angle': 0., 'sigma': sigma}] if tags else []}

    def step(self, x=0., dt=.05, packet=None):
        self.clock += dt
        self.nav.ros_now = round(self.nav.ros_now+dt, 9)
        self.nav.received = self.nav.imu_received = self.clock
        self.nav.feedback['aggregate_received'] = self.clock
        msg = Odometry()
        sec = int(self.nav.ros_now)
        msg.header.stamp.sec = sec
        msg.header.stamp.nanosec = round((self.nav.ros_now-sec)*1e9)
        self.nav.ros_now = msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        msg.header.frame_id = 'odom'
        msg.child_frame_id = 'base_link'
        msg.pose.pose.orientation.w = 1.
        msg.pose.pose.position.x = x
        GlobalLocalization.odometry(self.loc, msg)
        payload = self.packet(tags=False) if packet is None else dict(packet)
        payload['stamp'] = self.nav.ros_now
        observation = String(data=json.dumps(payload))
        GlobalLocalization.observe(self.loc, observation)
        GreenhouseNode.observation_cb(self.nav, observation)

    def conditions(self):
        return GreenhouseNode.conditions(self.nav)

    def tick(self):
        return self.nav.mission.tick(self.nav.pose, self.nav.feedback, self.nav.observations, self.conditions(), .05)

    def test_no_markers_for_three_seconds_keeps_updating_position_and_driving(self):
        tag_time = self.loc.last_tag
        sigma = self.nav.pose.sigma
        for i in range(1, 61):
            self.step(x=i*.004)
            self.assertGreater(self.tick().vx, 0.)
        self.assertEqual(self.loc.last_tag, tag_time)
        self.assertAlmostEqual(self.nav.pose.x, .24)
        self.assertGreater(self.nav.pose.sigma, sigma)
        self.assertEqual(self.nav.mission.state, 'FORWARD')

    def test_bad_single_frame_does_not_cancel_a_good_fused_pose(self):
        tag_time = self.loc.last_tag
        self.step(x=.004, packet=self.packet(sigma=.08))
        self.assertEqual(self.loc.last_tag, tag_time, 'unusable QR must not correct localization')
        self.assertGreater(self.tick().vx, 0.)
        self.assertEqual(self.nav.mission.state, 'FORWARD')

    def test_noisy_consistent_qr_uses_filter_weighting_without_stopping(self):
        tag_time = self.loc.last_tag
        self.step(x=.004, packet=self.packet(sigma=.04, x=.196))
        self.assertGreater(self.loc.last_tag, tag_time)
        self.assertLess(self.nav.pose.sigma, self.nav.config['max_position_sigma_m'])
        self.assertGreater(self.tick().vx, 0.)
        self.assertEqual(self.nav.mission.state, 'FORWARD')

    def test_returning_marker_corrects_drift_before_continuing(self):
        for i in range(1, 21):
            self.step(x=i*.005)
            self.tick()
        before = self.nav.pose.x
        self.step(x=.1, packet=self.packet(x=.12))  # map pose .08, odometry pose .10
        self.assertLess(self.loc.estimate[0], before)
        self.assertGreater(self.loc.estimate[0], .08)
        self.step(x=.1)
        self.assertLess(self.nav.pose.x, before)
        self.assertGreater(self.tick().vx, 0.)

    def test_long_prediction_stops_when_fused_uncertainty_exceeds_limit(self):
        self.nav.config['qr_interval_navigation']=False
        for _ in range(200):
            self.step(x=.1)
            command = self.tick()
            if not self.nav.mission.running:
                break
        self.assertGreater(self.nav.pose.sigma, self.nav.config['max_position_sigma_m'])
        self.assertEqual(command.vx, 0.)
        self.assertEqual(self.nav.mission.state, 'FAULT')
        self.assertIn('实时融合位姿与误差', self.nav.mission.events[0])

    def test_marker_loss_timeout_is_diagnostic_while_bounded_pose_is_valid(self):
        self.nav.config['tag_timeout_s'] = .15
        for _ in range(5):
            self.step()
            command = self.tick()
        self.assertLess(self.nav.pose.sigma, self.nav.config['max_position_sigma_m'])
        self.assertGreater(command.vx, 0.)
        self.assertEqual(self.nav.mission.state, 'FORWARD')
        self.assertFalse(GreenhouseNode.marker_tracking(self.nav,self.clock)['withinTimeout'])
        self.assertNotIn('tag',{c['id'] for c in self.conditions()})

    def test_interval_mode_drives_to_next_qr_after_thirty_seconds_and_corrects(self):
        self.nav.config['qr_interval_navigation']=True
        # 1.8m board spacing at 5cm/s takes 36s, well beyond the old ~9s budget.
        for i in range(1,721):
            self.step(x=i*.0025)
            command=self.tick()
            self.assertGreater(command.vx,0.)
            self.assertEqual(self.nav.mission.state,'FORWARD')
        before=self.nav.pose.sigma
        self.assertGreater(before,self.nav.config['max_position_sigma_m'])
        # A real synchronized observation at the next board corrects drift.
        self.loc.tags[0]['x']=2.
        self.step(x=1.8,packet=self.packet(x=.22,sigma=.01))
        self.step(x=1.8)
        self.assertLess(self.nav.pose.sigma,before)
        self.assertGreater(self.tick().vx,0.)

    def test_interval_mode_never_accepts_nonfinite_or_nonpositive_covariance(self):
        self.nav.config['qr_interval_navigation']=True
        for sigma in (float('nan'),float('inf'),0.,-.1):
            self.nav.pose.sigma=sigma
            self.assertFalse(GreenhouseNode.navigation_pose_ready(self.nav,self.clock))

    def test_stale_pose_or_feedback_still_stops(self):
        # Each subcase gets an active mission; no control interface is called.
        for attribute, label in (('pose_received', '实时融合位姿与误差'), ('received', '底盘反馈时效')):
            with self.subTest(attribute=attribute):
                original = getattr(self.nav, attribute)
                setattr(self.nav, attribute, self.clock-1.)
                self.nav.mission.running = True
                self.nav.mission.state = 'FORWARD'
                command = self.tick()
                self.assertEqual(command.vx, 0.)
                self.assertEqual(self.nav.mission.state, 'FAULT')
                self.assertIn(label, self.nav.mission.events[0])
                setattr(self.nav, attribute, original)


if __name__ == '__main__':
    unittest.main(verbosity=2)
