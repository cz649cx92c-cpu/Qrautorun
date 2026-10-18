"""Explicit operator reuse, offline only; no hardware commands or measured claims."""
import math
import time
import unittest
from unittest.mock import Mock
import test_node_motion as fixtures
from greenhouse_navigation.node import GreenhouseNode
from greenhouse_navigation.mission import Mission
from greenhouse_navigation.control import Pose


class RuntimeAcceptanceTests(unittest.TestCase):
    def harness(self):
        node=fixtures.NodeMotionTests().feedback_harness()
        node.config['existing_runtime_conditions_accepted']=True
        node.mission=Mission(node.config)
        GreenhouseNode.feedback_cb(node,fixtures.NodeMotionTests().aggregate_feedback())
        now=time.monotonic()
        node.motion=Mock();node.motion.owns_publishers.return_value=True
        node.get_publishers_info_by_topic=lambda topic:[]
        node.pose=Pose(0.,0.,0.,.01);node.pose_received=now;node.imu_received=now
        node.camera_received=now;node.tag_received=now
        return node

    def test_only_extra_acceptance_gates_are_removed(self):
        node=self.harness();checks={c['id']:c for c in GreenhouseNode.conditions(node)}
        for name in ('freshness','watchdog','takeover','dimensions'):self.assertNotIn(name,checks)
        for name in ('execution','feedback','ownership','unlock','estop','remote','pose','imu','camera'):
            self.assertIn(name,checks)
        self.assertNotIn('tag',checks)
        self.assertNotIn('qr_quality',checks)
        self.assertFalse(checks['execution']['ready'])
        for key in ('field_freshness_verified','hardware_watchdog_verified','manual_takeover_verified','vehicle_dimensions_verified'):
            self.assertFalse(node.config[key])
        node.motion.prepare.assert_not_called();node.motion.send.assert_not_called()

    def test_unconfirmed_chassis_does_not_waive_acceptance(self):
        node=self.harness();node.config['existing_chassis_confirmed']=False
        checks={c['id']:c for c in GreenhouseNode.conditions(node)}
        self.assertFalse(checks['freshness']['ready']);self.assertFalse(checks['watchdog']['ready'])

    def test_runtime_stop_and_manual_states_still_block(self):
        node=self.harness();node.received=time.monotonic()-1.
        node.feedback.update(estop=True,remote_control=True,unlock=False)
        node.motion.owns_publishers.return_value=False
        checks={c['id']:c for c in GreenhouseNode.conditions(node)}
        for name in ('feedback','estop','remote','unlock','ownership'):self.assertFalse(checks[name]['ready'])

    def test_unlock_feedback_is_an_event_not_a_persistent_enable_bit(self):
        node=self.harness()
        node.feedback['unlock']=False
        checks={c['id']:c for c in GreenhouseNode.conditions(node)}
        self.assertTrue(checks['unlock']['ready'])

    def test_operator_acceptance_reuses_aggregate_without_claiming_independent_time(self):
        node=self.harness()
        self.assertIsNone(node.feedback['steering_seq']);self.assertIsNone(node.feedback['steering_received'])
        self.assertFalse(node.feedback['steering_fresh'])
        for seq in range(1,6):
            node.feedback['seq']=seq
            ready=node.mission.stable_feedback(node.feedback,90.,(7,8))
        self.assertTrue(ready)

    def test_bad_or_expired_aggregate_angle_is_still_rejected(self):
        for changed in ({'aggregate_received':time.monotonic()-1.},{'aggregate_received':None},
                        {'steering_angle':math.nan},{'steering_angle':0.},{'seq':True},
                        {'body_gear':6},{'steering_gear':5},{'speed':.1}):
            with self.subTest(changed=changed):
                node=self.harness();node.feedback.update(changed)
                self.assertFalse(node.mission.stable_feedback(node.feedback,90.,(7,8)))

    def test_repeated_or_regressed_aggregate_does_not_count_as_new_samples(self):
        node=self.harness()
        for _ in range(10):self.assertFalse(node.mission.stable_feedback(node.feedback,90.,(7,8)))
        self.assertEqual(node.mission.stable,1)
        node.feedback['seq']=0
        self.assertFalse(node.mission.stable_feedback(node.feedback,90.,(7,8)))
        self.assertEqual(node.mission.stable,0)
