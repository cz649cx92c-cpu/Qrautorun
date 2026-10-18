"""Offline static-anchor fixtures: no DDS, no hardware, no measured evidence."""
import copy
import json
import math
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock,patch

import numpy as np
from nav_msgs.msg import Odometry
from rclpy.node import Node
from std_msgs.msg import String

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.localization import GlobalLocalization,StationaryAnchor,absolute_tag_pose,propagate_pose,process_covariance_increment


def field():
    board={'id':'B000','referenceId':0,'gridSize':1,'sizeMm':140,'gapMm':2,
           'members':[{'id':0,'x':0.,'y':0.,'angle':0.,'size':.112}]}
    return {'id':'offline-map','coordinateStatus':'reviewed','groups':[board],
            'tags':[{'id':0,'groupId':'B000','x':2.,'y':1.,'angle':90.,'size':.14}]}


def packet(stamp):
    return {'stamp':stamp,'frame':'base_link','calibrated':True,'synchronized':False,
            'representation':'board-centers','groupLayouts':field()['groups'],
            'tags':[{'id':0,'groupId':'B000','memberIds':[0],'visibleCount':1,
                     'x':1.,'y':0.,'angle':0.,'sigma':.01,'angleSigma':.02}]}


def fusion(stamp,epoch='epoch-one'):
    return {'stamp':stamp,'epoch':epoch,'state':'FUSED','source':'chassis','ready':True,
            'mappingReady':True,'approvalBasis':'user_confirmation',
            'agesMs':dict.fromkeys(('imu','odom','feedback','filter'),0.)}


def sample(anchor,stamp,pose=(0.,0.,0.),speed=0.):
    anchor.update_fusion(fusion(stamp),stamp,stamp)
    anchor.update_feedback(stamp,[speed]+[0.]*6,0.,6,stamp,stamp)
    anchor.update_local(stamp,pose,stamp,stamp)


def prepared():
    anchor=StationaryAnchor(field())
    for i in range(23):sample(anchor,10.+i*.05)
    return anchor,11.1


class StaticAnchorTests(unittest.TestCase):
    def test_one_second_continuous_real_inputs_required(self):
        anchor=StationaryAnchor(field())
        for i in range(20):sample(anchor,10.+i*.05)
        self.assertFalse(anchor.observe(packet(10.95),np.zeros(3),10.95,10.95))
        sample(anchor,11.05)
        self.assertTrue(anchor.observe(packet(11.05),np.zeros(3),11.05,11.05))

    def test_board_center_sets_absolute_position_and_heading_without_member_offset(self):
        anchor,stamp=prepared();self.assertTrue(anchor.observe(packet(stamp),np.zeros(3),stamp,stamp))
        np.testing.assert_allclose(anchor.estimate,[2.,0.,math.pi/2],atol=1e-12)
        self.assertTrue(anchor.available(stamp,stamp))

    def test_map_angle_degrees_relative_angle_radians_and_wrap(self):
        result=absolute_tag_pose({'x':2.,'y':1.,'angle':-179.},{'x':0.,'y':0.,'angle':math.radians(179.)})
        self.assertAlmostEqual(result[2],math.radians(2.))

    def test_conservative_covariance_floor_survives_repeated_corrections(self):
        anchor,stamp=prepared()
        for i in range(60):
            now=stamp+i*.05
            if i:sample(anchor,now)
            self.assertTrue(anchor.observe(packet(now),np.zeros(3),now,now))
            self.assertTrue(np.all(np.diag(anchor.covariance)>=np.array([.05**2,.05**2,.1**2])-1e-12))
        self.assertIn('非实测精度',anchor.reason)

    def test_configuration_cannot_lower_duration_or_covariance_floors(self):
        for params in ({'minimum_s':.5},{'position_floor':.01},{'yaw_floor':.02},{'timeout':math.nan}):
            with self.subTest(params=params),self.assertRaises(ValueError):StationaryAnchor(field(),**params)

    def test_received_aliases_preserve_origin_during_motion_without_static_correction(self):
        for gear in (5,7):
            anchor,stamp=prepared();anchor.observe(packet(stamp),np.zeros(3),stamp,stamp)
            before=anchor.estimate.copy();now=stamp+.05
            anchor.update_fusion(fusion(now),now,now)
            self.assertFalse(anchor.update_feedback(now,[.1]+[0.]*6,0.,gear,now,now))
            anchor.update_local(now,(.1,0.,0.),now,now)
            self.assertIsNotNone(anchor.estimate);self.assertFalse(anchor.available(now,now))
            np.testing.assert_allclose(anchor.estimate,before+[0.,.1,0.],atol=1e-12)
            self.assertFalse(anchor.observe(packet(now),np.zeros(3),now,now))

    def test_motion_preserves_origin_rejects_receive_time_correction_and_static_pose(self):
        anchor,stamp=prepared();anchor.observe(packet(stamp),np.zeros(3),stamp,stamp)
        before=anchor.estimate.copy();sample(anchor,stamp+.05,pose=(.1,0.,0.),speed=.1)
        self.assertIsNotNone(anchor.estimate);self.assertFalse(anchor.available(stamp+.05,stamp+.05))
        np.testing.assert_allclose(anchor.estimate,before+[0.,.1,0.],atol=1e-12)
        self.assertFalse(anchor.observe(packet(stamp+.05),np.zeros(3),stamp+.05,stamp+.05))

    def test_reverse_lateral_and_rotated_local_increment_propagate(self):
        for current,expected in (([-.1,0.,0.],[2.,-.1,math.pi/2]),([0.,.1,0.],[1.9,0.,math.pi/2]),
                                 ([0.,0.,.2],[2.,0.,math.pi/2+.2])):
            np.testing.assert_allclose(propagate_pose([2.,0.,math.pi/2],[0.,0.,0.],current),expected,atol=1e-12)

    def test_resume_static_needs_new_full_quiet_window_and_new_qr(self):
        anchor,stamp=prepared();anchor.observe(packet(stamp),np.zeros(3),stamp,stamp)
        sample(anchor,stamp+.05,speed=.1)
        for i in range(1,20):sample(anchor,stamp+.05+i*.05)
        self.assertFalse(anchor.available(stamp+1.,stamp+1.))
        sample(anchor,stamp+1.2)
        self.assertFalse(anchor.available(stamp+1.2,stamp+1.2))
        self.assertTrue(anchor.observe(packet(stamp+1.2),np.zeros(3),stamp+1.2,stamp+1.2))

    def test_epoch_change_clears_origin_local_input_and_stationary_window(self):
        anchor,stamp=prepared();anchor.observe(packet(stamp),np.zeros(3),stamp,stamp)
        self.assertTrue(anchor.update_fusion(fusion(stamp+.05,'epoch-two'),stamp+.05,stamp+.05))
        self.assertIsNone(anchor.estimate);self.assertIsNone(anchor.local);self.assertIsNone(anchor.quiet_since)
        self.assertEqual(anchor.epoch,'epoch-two')

    def test_input_expiry_monotonic_and_ros_clocks_clear_origin(self):
        for ros,mono in ((11.5,11.5),(11.1,11.5),(10.,11.1)):
            anchor,stamp=prepared();anchor.observe(packet(stamp),np.zeros(3),stamp,stamp)
            self.assertFalse(anchor.inputs_valid(ros,mono));self.assertIsNone(anchor.estimate)

    def test_disrupted_feedback_cannot_rejoin_old_origin(self):
        anchor,stamp=prepared();anchor.observe(packet(stamp),np.zeros(3),stamp,stamp)
        anchor.update_feedback(stamp+.5,[0.]*7,0.,6,stamp+.5,stamp+.5)
        self.assertIsNone(anchor.estimate);self.assertIsNone(anchor.quiet_since)

    def test_nonzero_any_velocity_or_yaw_stops_static(self):
        for index in range(8):
            anchor,stamp=prepared();anchor.observe(packet(stamp),np.zeros(3),stamp,stamp)
            velocities=[0.]*7
            if index<7:velocities[index]=.01
            anchor.update_feedback(stamp+.01,velocities,.01 if index==7 else 0.,8,stamp+.01,stamp+.01)
            self.assertFalse(anchor.available(stamp+.01,stamp+.01));self.assertIsNotNone(anchor.estimate)

    def test_invalid_fusion_or_unconfirmed_inputs_reset_anchor(self):
        invalid=[{'source':'legacy'},{'approvalBasis':None},{'ready':False},{'mappingReady':False},
                 {'state':'INVALID'},{'agesMs':{'imu':999.}},{'stamp':9.},{'stamp':math.nan}]
        for changed in invalid:
            anchor,stamp=prepared();anchor.observe(packet(stamp),np.zeros(3),stamp,stamp)
            anchor.update_fusion({**fusion(stamp+.05),**changed},stamp+.05,stamp+.05)
            self.assertIsNone(anchor.estimate)

    def test_qr_validation_rejects_uncalibrated_stale_unknown_layout_and_synchronized(self):
        invalid=[{'calibrated':False},{'synchronized':True},{'frame':'camera'},{'representation':'single-tags'},
                 {'groupLayouts':[]},{'stamp':9.},{'stamp':12.},{'tags':[]},{'tags':[{'id':99}]}]
        for changed in invalid:
            anchor,stamp=prepared()
            self.assertFalse(anchor.observe({**packet(stamp),**changed},np.zeros(3),stamp,stamp))
            self.assertIsNone(anchor.estimate)
        anchor,stamp=prepared();bad=packet(stamp);bad['groupLayouts'][0]['sizeMm']=150.
        self.assertFalse(anchor.observe(bad,np.zeros(3),stamp,stamp))

    def test_qr_requires_formal_local_interpolation_and_no_duplicate_refresh(self):
        anchor,stamp=prepared();self.assertFalse(anchor.observe(packet(stamp),None,stamp,stamp))
        self.assertTrue(anchor.observe(packet(stamp),np.zeros(3),stamp,stamp))
        self.assertFalse(anchor.observe(packet(stamp),np.zeros(3),stamp+.01,stamp+.01))
        self.assertEqual(anchor.tag_received,stamp)

    def test_qr_expiry_stops_static_but_preserves_local_only_origin(self):
        anchor,stamp=prepared();anchor.observe(packet(stamp),np.zeros(3),stamp,stamp)
        for i in range(1,7):sample(anchor,stamp+i*.05)
        self.assertFalse(anchor.available(stamp+.3,stamp+.3));self.assertIsNotNone(anchor.estimate)

    def test_delayed_callback_does_not_falsify_qr_receive_freshness(self):
        anchor,stamp=prepared()
        self.assertFalse(anchor.observe(packet(stamp),np.zeros(3),stamp,stamp,received=stamp-.5))


class StaticNodeTests(unittest.TestCase):
    def harness(self):
        anchor,stamp=prepared();anchor.observe(packet(stamp),np.zeros(3),stamp,stamp)
        node=GlobalLocalization.__new__(GlobalLocalization)
        node.anchor=anchor;node.enable_stationary_anchor=True;node.field=field();node.estimate=None;node.covariance=np.eye(3)
        node.formal_origin=False;node.formal_published_at=None;node.formal_preview_at=None
        node.pending_static=[];node.history=[(stamp-.05,np.zeros(3)),(stamp,np.zeros(3))]
        node.local_at=lambda value:GlobalLocalization.local_at(node,value)
        node.last_odometry=Odometry();node.last_odometry.header.stamp.sec=11;node.last_odometry.header.stamp.nanosec=100000000
        node.now=lambda:stamp
        node.static_outputs=[];node.preview_outputs=[];node.formal_outputs=[];node.statuses=[]
        node.static_pub=SimpleNamespace(publish=node.static_outputs.append)
        node.preview_pub=SimpleNamespace(publish=node.preview_outputs.append)
        node.pub=SimpleNamespace(publish=node.formal_outputs.append)
        node.status_pub=SimpleNamespace(publish=node.statuses.append)
        node.get_parameter=lambda name:SimpleNamespace(value=.03 if name=='max_position_sigma_m' else True)
        node.tf=Mock()
        return node,stamp

    def test_static_output_is_map_frame_truthful_status_and_never_formal_or_tf(self):
        node,stamp=self.harness()
        with patch('greenhouse_navigation.localization.time.monotonic',return_value=stamp):
            node.publish_anchor();node.status();node.publish(node.last_odometry,np.zeros(3))
        self.assertEqual(len(node.static_outputs),1);self.assertEqual(len(node.preview_outputs),1)
        self.assertEqual(node.formal_outputs,[]);node.tf.sendTransform.assert_not_called()
        output=node.static_outputs[0];self.assertEqual(output.header.frame_id,'map');self.assertEqual(output.child_frame_id,'base_link')
        status=json.loads(node.statuses[-1].data)
        self.assertEqual(status['state'],'STATIC_ANCHORED');self.assertEqual(status['source'],'stationary_qr')
        self.assertTrue(status['absoluteHeading']);self.assertTrue(status['poseAvailable']);self.assertTrue(status['stationary'])
        self.assertFalse(status['navigationReady']);self.assertFalse(status['captureTimestampVerified'])
        self.assertEqual(status['mapId'],'offline-map');self.assertEqual(status['localEpoch'],'epoch-one')

    def test_moving_origin_only_outputs_provisional_and_local_only_status(self):
        node,stamp=self.harness();stamp+=.05;sample(node.anchor,stamp,pose=(0.,.1,0.),speed=.1)
        node.now=lambda:stamp;node.last_odometry.header.stamp.nanosec=150000000
        with patch('greenhouse_navigation.localization.time.monotonic',return_value=stamp):node.publish_anchor();node.status()
        self.assertEqual(node.static_outputs,[]);self.assertEqual(len(node.preview_outputs),1);self.assertEqual(node.formal_outputs,[])
        status=json.loads(node.statuses[-1].data);self.assertEqual(status['state'],'LOCAL_ONLY');self.assertEqual(status['source'],'stationary_qr')
        self.assertFalse(status['stationary']);self.assertFalse(status['navigationReady']);self.assertFalse(status['captureTimestampVerified'])

    def test_expired_inputs_stop_all_stationary_origin_outputs(self):
        node,stamp=self.harness();node.now=lambda:stamp+.5
        with patch('greenhouse_navigation.localization.time.monotonic',return_value=stamp+.5):node.publish_anchor();node.status()
        self.assertEqual(node.static_outputs,[]);self.assertEqual(node.preview_outputs,[])
        self.assertFalse(json.loads(node.statuses[-1].data)['poseAvailable'])

    def test_interpolation_includes_exact_endpoints_and_shortest_yaw(self):
        node,stamp=self.harness()
        node.history=[(stamp-.05,np.array([0.,0.,math.pi-.01])),(stamp,np.array([0.,.1,-math.pi+.01]))]
        np.testing.assert_allclose(node.local_at(stamp-.05),node.history[0][1])
        midpoint=node.local_at(stamp-.025);self.assertAlmostEqual(midpoint[1],.05);self.assertAlmostEqual(abs(midpoint[2]),math.pi)
        self.assertIsNone(node.local_at(stamp+.01))

    def test_constructor_tf_default_false_and_only_diagnostic_publishers(self):
        config={'map_file':'offline.json','local_odom_topic':'/qr/odometry/local','enable_stationary_anchor':True,
                'publish_tf':False,'max_observation_age_s':.25,'max_innovation_m':.2}
        with patch.object(Node,'__init__',return_value=None),patch.object(GlobalLocalization,'declare_parameter') as declarations,\
             patch.object(GlobalLocalization,'get_parameter',side_effect=lambda key:SimpleNamespace(value=config[key])),\
             patch('greenhouse_navigation.localization.Path.read_text',return_value=json.dumps(field())),\
             patch.object(GlobalLocalization,'create_subscription') as subscribers,\
             patch.object(GlobalLocalization,'create_publisher') as publishers,\
             patch.object(GlobalLocalization,'create_timer'),patch.object(GlobalLocalization,'get_logger'),\
             patch('greenhouse_navigation.localization.TransformBroadcaster') as tf:
            node=GlobalLocalization()
        tf.assert_not_called();self.assertIsNone(node.tf);self.assertFalse(node.formal_origin)
        self.assertIn(('publish_tf',False),[call.args for call in declarations.call_args_list])
        self.assertIn(('qr_interval_navigation',False),[call.args for call in declarations.call_args_list])
        topics={call.args[1] for call in publishers.call_args_list}
        self.assertEqual(topics,{'/qr/localization/pose','/qr/localization/provisional','/qr/localization/static_pose','/qr/localization/status'})
        self.assertEqual({call.args[1] for call in subscribers.call_args_list},
                         {'/qr/odometry/local','/qr/tags/observations','/qr/tags/provisional','/chassis_info_fb','/qr/fusion/status'})

    def test_formal_output_still_requires_calibrated_covariance_and_explicit_tf_switch(self):
        node,stamp=self.harness();node.formal_origin=True;node.estimate=np.array([1.,2.,.3]);node.covariance=np.eye(3)*.01
        params={'qr_interval_navigation':False,'max_position_sigma_m':.03,'covariance_calibrated':False,'synchronized_navigation_confirmed':False,'publish_tf':False}
        node.get_parameter=lambda key:SimpleNamespace(value=params[key])
        node.publish(node.last_odometry,np.zeros(3));self.assertEqual(node.formal_outputs,[])
        params['covariance_calibrated']=True;node.publish(node.last_odometry,np.zeros(3));self.assertEqual(len(node.formal_outputs),1)
        node.tf.sendTransform.assert_not_called()
        params['publish_tf']=True;node.publish(node.last_odometry,np.zeros(3));node.tf.sendTransform.assert_called_once()


    def test_operator_confirmed_synchronized_pose_can_navigate_without_measured_claim(self):
        node,stamp=self.harness();node.formal_origin=True
        node.estimate=np.array([1.,2.,.3]);node.covariance=np.eye(3)*.0004
        params={'qr_interval_navigation':False,'max_position_sigma_m':.03,'covariance_calibrated':False,'synchronized_navigation_confirmed':True,'publish_tf':False}
        node.get_parameter=lambda key:SimpleNamespace(value=params[key])
        with patch('greenhouse_navigation.localization.time.monotonic',return_value=stamp):
            node.publish(node.last_odometry,np.zeros(3));node.status()
        self.assertEqual(len(node.formal_outputs),1)
        self.assertEqual(node.formal_outputs[0].pose.covariance[0],.0004)
        status=json.loads(node.statuses[-1].data)
        self.assertEqual(status['state'],'FORMAL');self.assertTrue(status['navigationReady'])
        self.assertTrue(status['captureTimestampVerified']);self.assertFalse(status['covarianceCalibrated'])
        self.assertEqual(status['approvalBasis'],'user_confirmation');self.assertIn('精度尚未实测',status['reason'])
        node.tf.sendTransform.assert_not_called()

    def test_confirmation_never_promotes_stationary_unsynchronized_or_expired_pose(self):
        node,stamp=self.harness()
        params={'qr_interval_navigation':False,'max_position_sigma_m':.03,'covariance_calibrated':False,'synchronized_navigation_confirmed':True,'publish_tf':False}
        node.get_parameter=lambda key:SimpleNamespace(value=params[key])
        with patch('greenhouse_navigation.localization.time.monotonic',return_value=stamp):
            node.publish_anchor();node.publish(node.last_odometry,np.zeros(3));node.status()
        self.assertEqual(node.formal_outputs,[])
        self.assertFalse(json.loads(node.statuses[-1].data)['navigationReady'])
        node.formal_origin=True;node.estimate=np.array([1.,2.,.3]);node.covariance=np.eye(3)*.0004
        with patch('greenhouse_navigation.localization.time.monotonic',return_value=stamp):
            node.publish(node.last_odometry,np.zeros(3))
        node.now=lambda:stamp+.5
        with patch('greenhouse_navigation.localization.time.monotonic',return_value=stamp+.5):node.status()
        self.assertFalse(json.loads(node.statuses[-1].data)['navigationReady'])


class LocalizationProcessNoiseTests(unittest.TestCase):
    def interval_status(self,covariance,expired=False):
        node,stamp=StaticNodeTests().harness();node.formal_origin=True
        node.estimate=np.array([1.,2.,.3]);node.covariance=covariance
        params={'qr_interval_navigation':True,'max_position_sigma_m':.03,'covariance_calibrated':False,'synchronized_navigation_confirmed':True,'publish_tf':False}
        node.get_parameter=lambda key:SimpleNamespace(value=params[key])
        with patch('greenhouse_navigation.localization.time.monotonic',return_value=stamp):
            node.publish(node.last_odometry,np.zeros(3))
        if expired:node.now=lambda:stamp+.5
        with patch('greenhouse_navigation.localization.time.monotonic',return_value=stamp+(.5 if expired else 0.)):
            node.status()
        return json.loads(node.statuses[-1].data)

    def test_interval_mode_excess_uncertainty_is_diagnostic_not_a_stop(self):
        status=self.interval_status(np.eye(3)*.08**2)
        self.assertTrue(status['navigationReady'])
        self.assertAlmostEqual(status['positionSigmaM'],.08)
        self.assertIn('下一定位板校正',status['reason'])
        self.assertFalse(status['covarianceCalibrated'])

    def test_interval_mode_never_promotes_expired_pose_or_invalid_covariance(self):
        self.assertFalse(self.interval_status(np.eye(3)*.08**2,expired=True)['navigationReady'])
        for covariance in (np.diag([-.01,.01,.01]),np.zeros((3,3)),np.eye(3)*float('nan')):
            with self.subTest(covariance=covariance):
                self.assertFalse(self.interval_status(covariance)['navigationReady'])

    def test_confirmed_stationary_preserves_existing_uncertainty_for_long_wait(self):
        covariance=np.diag([.02**2,.018**2,.03**2]);original=covariance.copy()
        for _ in range(18000):
            covariance+=process_covariance_increment([1,2,.1],[1,2,.10001],.05,.01,.02,True)
        np.testing.assert_array_equal(covariance,original)

    def test_zero_odometry_without_fresh_stationary_confirmation_retains_noise(self):
        np.testing.assert_allclose(process_covariance_increment([0,0,0],[0,0,0],.1,.01,.02,False),
                                   np.diag([.01**2,.01**2,.02**2])*.1)

    def test_translation_reverse_lateral_and_rotation_always_grow_uncertainty(self):
        for current in ([.001,0,0],[-.001,0,0],[0,.001,0],[0,0,.001]):
            with self.subTest(current=current):
                np.testing.assert_allclose(process_covariance_increment([0,0,0],current,.1,.01,.02,True),
                                           np.diag([.01**2,.01**2,.02**2])*.1)

    def test_invalid_process_time_or_values_are_rejected(self):
        for dt in (0,-.1,.3,float('nan')):
            with self.subTest(dt=dt),self.assertRaises(ValueError):
                process_covariance_increment([0,0,0],[0,0,0],dt,.01,.02,True)

    def test_fresh_formal_pose_with_excess_uncertainty_is_truthfully_not_ready(self):
        node,stamp=StaticNodeTests().harness();node.formal_origin=True
        node.estimate=np.array([1.,2.,.3]);node.covariance=np.eye(3)*.18**2
        params={'qr_interval_navigation':False,'max_position_sigma_m':.03,'covariance_calibrated':False,'synchronized_navigation_confirmed':True,'publish_tf':False}
        node.get_parameter=lambda key:SimpleNamespace(value=params[key])
        with patch('greenhouse_navigation.localization.time.monotonic',return_value=stamp):
            node.publish(node.last_odometry,np.zeros(3));node.status()
        status=json.loads(node.statuses[-1].data)
        self.assertEqual(status['state'],'FORMAL');self.assertTrue(status['poseAvailable'])
        self.assertFalse(status['navigationReady']);self.assertAlmostEqual(status['positionSigmaM'],.18)
        self.assertIn('18.0 cm',status['reason'])


if __name__=='__main__':unittest.main(verbosity=2)
