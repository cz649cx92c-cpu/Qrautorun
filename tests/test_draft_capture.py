"""草稿插值与正式导航隔离；不启动ROS节点或移动底盘。"""
import math
import sys
import unittest
import json
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'src/greenhouse_navigation'))
from greenhouse_navigation.draft_capture import interpolate_pose, draft_packet, DraftCapture
from greenhouse_navigation.node import GreenhouseNode
from test_group_bridge import BridgeChecks


class DraftChecks(unittest.TestCase):
    def test_formal_local_without_capture_time_keeps_only_draft_capture(self):
        h=SimpleNamespace(now=lambda:10.,epoch='new',
            fusion={'stamp':10.,'ready':True,'mappingReady':True},
            camera={'stamp':10.,'fresh':True,'intrinsicsVerified':True,
                    'extrinsicsVerified':True,'captureTimestampVerified':False},
            poses=[(10.,{'x':0.,'y':0.,'yaw':0.})])
        self.assertEqual(DraftCapture.reason(h),'')
        h.camera['captureTimestampVerified']=True
        self.assertIn('正式观测',DraftCapture.reason(h))
        h.camera['captureTimestampVerified']=False
        h.camera['stamp']=9.
        self.assertEqual(DraftCapture.reason(h),'等待已标定相机')

    def test_interpolation_wrap_gap_and_no_extrapolation(self):
        poses=[(10., {'x':0.,'y':0.,'yaw':math.pi-.02}),
               (10.04, {'x':.04,'y':.02,'yaw':-math.pi+.02})]
        p=interpolate_pose(poses,10.02)
        self.assertAlmostEqual(p['x'],.02);self.assertAlmostEqual(p['y'],.01)
        self.assertAlmostEqual(abs(p['yaw']),math.pi)
        self.assertIsNone(interpolate_pose(poses,10.05))
        self.assertIsNone(interpolate_pose([(10.,poses[0][1]),(10.2,poses[1][1])],10.1))

    def test_draft_does_not_claim_capture_time_verification(self):
        packet=BridgeChecks().packet()
        result=draft_packet(packet,packet['localPose'],'epoch-one')
        self.assertFalse(result['synchronized']);self.assertEqual(result['quality'],'draft')
        self.assertEqual(result['timestampSource'],'server_receive')
        packet['calibrated']=False
        with self.assertRaises(ValueError):draft_packet(packet,result['localPose'],'epoch-one')

    def test_only_draft_queue_receives_provisional_packet(self):
        fixture=BridgeChecks();h=fixture.harness();packet=fixture.packet()
        packet=draft_packet(packet,packet['localPose'],'epoch-one')
        GreenhouseNode.observation_cb(h,SimpleNamespace(data=json.dumps(packet)))
        self.assertTrue(h.survey.empty())
        GreenhouseNode.draft_observation_cb(h,SimpleNamespace(data=json.dumps(packet)))
        self.assertEqual(h.survey.qsize(),1)
        sample=h.survey.get_nowait();self.assertEqual(sample['quality'],'draft')
        self.assertFalse(sample['synchronized']);self.assertEqual(h.observations,[])
        self.assertEqual(h.camera_received,0.);self.assertEqual(h.tag_received,0.)

    def test_draft_rejects_layout_mismatch_and_active_navigation(self):
        fixture=BridgeChecks();h=fixture.harness();packet=fixture.packet()
        packet=draft_packet(packet,packet['localPose'],'epoch-one')
        packet['groupLayouts'][0]['sizeMm']=150
        GreenhouseNode.draft_observation_cb(h,SimpleNamespace(data=json.dumps(packet)))
        self.assertTrue(h.survey.empty())
        packet=draft_packet(fixture.packet(),packet['localPose'],'epoch-one')
        h.mission.running=True
        GreenhouseNode.draft_observation_cb(h,SimpleNamespace(data=json.dumps(packet)))
        self.assertTrue(h.survey.empty())


if __name__=='__main__':unittest.main(verbosity=2)
