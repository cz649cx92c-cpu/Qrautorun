"""静止位姿仅进入显示遥测；不构造ROS节点、不连接DDS、不调用底盘接口。"""
import json
import math
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

import yaml
from nav_msgs.msg import Odometry
from std_msgs.msg import String
from yhs_can_interfaces.msg import ChassisInfoFb

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.node import GreenhouseNode, heading_degrees
from greenhouse_navigation.control import Pose


class StaticPoseStatusTests(unittest.TestCase):
    def setUp(self):
        self.clock=mock.patch('greenhouse_navigation.node.time.monotonic',return_value=10.)
        self.monotonic=self.clock.start();self.addCleanup(self.clock.stop)

    def harness(self):
        config=yaml.safe_load((ROOT/'config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters']
        config['execution_enabled']=False
        node=SimpleNamespace(config=config,ros_now=10.,seq=0,
            mission=SimpleNamespace(target_angle=0.,running=False),
            feedback={'speed':0.,'vx':0.,'vy_raw':0.,'yaw_deg':0.,'unlock':True,'estop':False,'remote_control':False},received=10.,
            pose=None,pose_received=0.,camera_received=0.,tag_received=0.,tag_sigma=math.inf,imu_received=0.,
            static_pose=None,static_pose_received=0.,static_pose_context=None,
            localization_status=None,localization_received=0.,observations=[],
            get_publishers_info_by_topic=lambda topic:[],motion=SimpleNamespace(owns_publishers=lambda _:True))
        node.get_clock=lambda:SimpleNamespace(now=lambda:SimpleNamespace(nanoseconds=int(node.ros_now*1e9)))
        return node

    def status(self,**changes):
        return {'stamp':10.,'state':'STATIC_ANCHORED','source':'stationary_qr','stationary':True,
                'absoluteHeading':True,'poseAvailable':True,'navigationReady':False,
                'captureTimestampVerified':False,'mapId':'office','localEpoch':'epoch-one',
                'reason':'静止二维码定位',**changes}

    def message(self,yaw=0.,stamp=10.):
        msg=Odometry();msg.header.frame_id='map';msg.child_frame_id='base_link'
        msg.header.stamp.sec=int(stamp);msg.header.stamp.nanosec=round((stamp-int(stamp))*1e9)
        msg.pose.pose.position.x=.012;msg.pose.pose.position.y=-.013
        msg.pose.pose.orientation.z=math.sin(yaw/2);msg.pose.pose.orientation.w=math.cos(yaw/2)
        for i in (0,7,35):msg.pose.covariance[i]=.0004
        return msg

    def anchor(self,node,yaw=0.):
        GreenhouseNode.localization_status_cb(node,String(data=json.dumps(self.status())))
        GreenhouseNode.static_pose_cb(node,self.message(yaw))

    def test_static_pose_visible_without_modifying_formal_pose_or_observation_gates(self):
        node=self.harness();self.anchor(node,-.2)
        displayed,localization=GreenhouseNode.localization_telemetry(node,10.)
        self.assertAlmostEqual(displayed['x'],.012)
        self.assertAlmostEqual(displayed['yaw'],-.2)
        self.assertEqual(localization['state'],'STATIC_ANCHORED')
        self.assertFalse(localization['navigationReady']);self.assertFalse(localization['captureTimestampVerified'])
        self.assertEqual(localization['mapId'],'office')
        self.assertIsNone(node.pose);self.assertEqual(node.pose_received,0.)
        self.assertEqual(node.camera_received,0.);self.assertEqual(node.tag_received,0.)
        conditions=GreenhouseNode.conditions(node)
        for key in ('pose','camera','execution'):
            self.assertFalse(next(c['ready'] for c in conditions if c['id']==key))

    def test_display_heading_wraps_to_signed_degrees(self):
        for yaw,expected in ((math.pi,-180.),(-math.pi,-180.),(math.radians(190.),-170.),(math.radians(-190.),170.)):
            node=self.harness();self.anchor(node,yaw)
            _,localization=GreenhouseNode.localization_telemetry(node,10.)
            self.assertAlmostEqual(localization['headingDeg'],expected)
            self.assertAlmostEqual(heading_degrees(yaw),expected)

    def test_pose_or_status_expiry_hides_static_position(self):
        for key in ('static_pose_received','localization_received'):
            node=self.harness();self.anchor(node)
            setattr(node,key,9.7)
            displayed,metadata=GreenhouseNode.localization_telemetry(node,10.)
            self.assertIsNone(displayed);self.assertFalse(metadata['poseAvailable'])
        node=self.harness();self.anchor(node);node.ros_now=10.3
        self.assertIsNone(GreenhouseNode.localization_telemetry(node,10.)[0])

    def test_body_motion_and_rotation_clear_cached_static_pose_immediately(self):
        for field,value in (('ctrl_fb_x_linear',.02),('ctrl_fb_y_linear',.2),('ctrl_fb_z_angular',.2)):
            node=self.harness();self.anchor(node)
            msg=ChassisInfoFb();msg.header.stamp.sec=10
            setattr(msg.ctrl_fb,field,value)
            GreenhouseNode.feedback_cb(node,msg)
            self.assertIsNone(node.static_pose)
            self.assertIsNone(GreenhouseNode.localization_telemetry(node,10.)[0])

    def test_missing_stale_or_nonfinite_body_feedback_cannot_show_static_pose(self):
        for mutate in (lambda n:setattr(n,'received',9.6),lambda n:setattr(n,'feedback',None),
                       lambda n:n.feedback.update(yaw_deg=math.nan),lambda n:n.feedback.update(speed=.1)):
            node=self.harness();self.anchor(node);mutate(node)
            self.assertIsNone(GreenhouseNode.localization_telemetry(node,10.)[0])

    def test_local_only_preserves_localizer_status_but_never_reuses_static_marker(self):
        node=self.harness();self.anchor(node)
        status=self.status(state='LOCAL_ONLY',stationary=False,poseAvailable=True,reason='仅局部传播')
        GreenhouseNode.localization_status_cb(node,String(data=json.dumps(status)))
        self.assertIsNone(node.static_pose)
        pose,metadata=GreenhouseNode.localization_telemetry(node,10.)
        self.assertIsNone(pose);self.assertEqual(metadata['state'],'LOCAL_ONLY')
        self.assertEqual(metadata['source'],'stationary_qr');self.assertFalse(metadata['navigationReady'])

    def test_map_and_epoch_changes_discard_old_static_marker(self):
        for changes in ({'mapId':'other-map'},{'localEpoch':'epoch-two'}):
            node=self.harness();self.anchor(node)
            GreenhouseNode.localization_status_cb(node,String(data=json.dumps(self.status(**changes))))
            self.assertIsNone(node.static_pose)
            self.assertIsNone(GreenhouseNode.localization_telemetry(node,10.)[0])

    def test_old_queued_odometry_cannot_cross_new_map_boundary(self):
        node=self.harness();self.anchor(node);node.ros_now=10.1
        GreenhouseNode.localization_status_cb(node,String(data=json.dumps(self.status(stamp=10.1,mapId='new-map'))))
        GreenhouseNode.static_pose_cb(node,self.message(stamp=10.))
        self.assertIsNone(node.static_pose)
        GreenhouseNode.static_pose_cb(node,self.message(stamp=10.1))
        self.assertEqual(node.static_pose_context,('new-map','epoch-one'))

    def test_invalid_quaternion_covariance_frames_and_duplicates_do_not_refresh_pose(self):
        changes=(lambda m:setattr(m.pose.pose.orientation,'w',0.),
                 lambda m:setattr(m.pose.pose.position,'x',math.nan),
                 lambda m:setattr(m.header,'frame_id','odom'),
                 lambda m:setattr(m,'child_frame_id','camera'),
                 lambda m:m.pose.covariance.__setitem__(0,0.))
        for mutate in changes:
            node=self.harness();self.anchor(node);original=node.static_pose;node.ros_now=10.1
            msg=self.message(stamp=10.1);mutate(msg)
            GreenhouseNode.static_pose_cb(node,msg)
            self.assertIs(node.static_pose,original);self.assertEqual(node.static_pose_received,10.)
        node=self.harness();self.anchor(node);self.monotonic.return_value=10.1
        GreenhouseNode.static_pose_cb(node,self.message())
        self.assertEqual(node.static_pose_received,10.)

    def test_invalid_stationary_navigation_claim_or_stale_status_clears_old_display(self):
        for changes in ({'navigationReady':True},{'captureTimestampVerified':True},
                        {'stamp':9.},{'source':'synchronized_qr'},{'stationary':False}):
            node=self.harness();self.anchor(node)
            GreenhouseNode.localization_status_cb(node,String(data=json.dumps(self.status(**changes))))
            self.assertIsNone(node.static_pose);self.assertIsNone(node.localization_status)

    def test_fresh_formal_pose_has_priority_and_independent_navigation_metadata(self):
        node=self.harness();self.anchor(node)
        status=self.status(state='FORMAL',source='synchronized_qr',navigationReady=True,captureTimestampVerified=True)
        GreenhouseNode.localization_status_cb(node,String(data=json.dumps(status)))
        node.pose=Pose(2.,3.,.3,.01,10.);node.pose_received=10.
        pose,metadata=GreenhouseNode.localization_telemetry(node,10.)
        self.assertEqual(pose,{'x':2.,'y':3.,'yaw':.3})
        self.assertEqual(metadata['state'],'FORMAL');self.assertTrue(metadata['navigationReady'])


if __name__=='__main__':unittest.main(verbosity=2)
