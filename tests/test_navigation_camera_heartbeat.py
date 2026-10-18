"""Actual image liveness and QR coasting; offline callbacks, no DDS or commands."""
import json
import math
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_runtime_acceptance as fixtures
from greenhouse_navigation.node import GreenhouseNode


class CameraHeartbeatTests(unittest.TestCase):
    def harness(self):
        node=fixtures.RuntimeAcceptanceTests().harness()
        node.config['execution_enabled']=True
        node.ros_now=10.
        node.detector=None
        node.detector_received=0.
        node.camera_received=0.
        node.observation_received=0.
        node.camera_frame_stamp=None
        node.observations=[]
        node.active_boards=[]
        node.mission.field=None
        node.tag_received=0.
        return node

    def packet(self, **changed):
        data={'stamp':10.,'frameStamp':9.98,'calibrated':True,
              'captureTimestampVerified':True,'identified':0,
              'positionReady':False,'localPoseReady':True}
        data.update(changed)
        return SimpleNamespace(data=json.dumps(data))

    def checks(self,node):
        return {c['id']:c for c in GreenhouseNode.conditions(node)}

    def test_no_tags_image_heartbeat_keeps_camera_online_without_creating_pose(self):
        node=self.harness()
        node.pose=None
        GreenhouseNode.detector_cb(node,self.packet())
        self.assertTrue(self.checks(node)['camera']['ready'])
        self.assertFalse(self.checks(node)['pose']['ready'])
        self.assertEqual(node.tag_received,0.)
        self.assertEqual(node.observation_received,0.)
        self.assertEqual(node.observations,[])
        self.assertIsNone(node.pose)

    def test_stale_unverified_uncalibrated_or_future_image_cannot_keep_camera_alive(self):
        for changes in ({'stamp':9.6},{'stamp':10.1},{'stamp':math.nan},
                        {'frameStamp':9.7},{'frameStamp':10.1},
                        {'frameStamp':math.nan},{'frameStamp':True},{'frameStamp':None},
                        {'calibrated':False},{'captureTimestampVerified':False}):
            with self.subTest(changes=changes):
                node=self.harness()
                GreenhouseNode.detector_cb(node,self.packet(**changes))
                self.assertEqual(node.camera_received,0.)
                self.assertFalse(self.checks(node)['camera']['ready'])

    def test_repeated_frame_status_is_not_a_new_image(self):
        node=self.harness()
        with patch('greenhouse_navigation.node.time.monotonic',return_value=100.):
            GreenhouseNode.detector_cb(node,self.packet())
        node.ros_now=10.1
        with patch('greenhouse_navigation.node.time.monotonic',return_value=100.1):
            GreenhouseNode.detector_cb(node,self.packet(stamp=10.1))
        self.assertEqual(node.camera_received,100.)
        self.assertEqual(node.camera_frame_stamp,9.98)

    def test_fresh_image_cannot_extend_old_marker_observation_or_refire_rule(self):
        node=self.harness()
        node.observations=[{'id':0,'groupId':'B000'}]
        node.observation_received=node.tag_received=99.
        with patch('greenhouse_navigation.node.time.monotonic',return_value=100.):
            GreenhouseNode.detector_cb(node,self.packet())
        self.assertEqual(node.camera_received,100.)
        self.assertEqual(GreenhouseNode.current_observations(node,100.),[])
        self.assertEqual(node.tag_received,99.)
        self.assertFalse(GreenhouseNode.marker_tracking(node,100.)['visible'])

    def test_legacy_synchronized_observation_still_refreshes_camera_and_tag(self):
        node=self.harness()
        payload={'stamp':10.,'frame':'base_link','calibrated':True,'synchronized':True,
                 'tags':[{'id':0,'x':.1,'y':0.,'angle':0.,'sigma':.01}]}
        GreenhouseNode.observation_cb(node,SimpleNamespace(data=json.dumps(payload)))
        self.assertTrue(self.checks(node)['camera']['ready'])
        self.assertGreater(node.tag_received,0.)
        self.assertEqual(node.observation_received,node.camera_received)
        self.assertEqual(len(GreenhouseNode.current_observations(node,node.camera_received)),1)

    def test_marker_loss_is_truthful_diagnostic_and_pose_limits_still_block(self):
        node=self.harness()
        node.config['qr_interval_navigation']=False
        node.tag_received=10.
        tracking=GreenhouseNode.marker_tracking(node,100.)
        self.assertFalse(tracking['visible'])
        self.assertFalse(tracking['withinTimeout'])
        self.assertEqual(tracking['lastSeenAgeS'],90.)
        self.assertNotIn('tag',self.checks(node))
        node.pose.sigma=node.config['max_position_sigma_m']+.001
        self.assertFalse(self.checks(node)['pose']['ready'])
        node.pose.sigma=.01
        node.pose_received=0.
        self.assertFalse(self.checks(node)['pose']['ready'])

    def test_real_camera_loss_and_manual_estop_still_block(self):
        node=self.harness()
        GreenhouseNode.detector_cb(node,self.packet())
        node.camera_received-=1.
        node.feedback.update(estop=True,remote_control=True)
        checks=self.checks(node)
        for key in ('camera','estop','remote'):
            self.assertFalse(checks[key]['ready'])


if __name__=='__main__':
    unittest.main(verbosity=2)
