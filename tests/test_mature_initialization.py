"""Mature feedback replay; pure callbacks, no DDS publishers or vehicle commands."""
import json
import math
from pathlib import Path
import sys
import unittest
from sensor_msgs.msg import Imu
from yhs_can_interfaces.msg import ChassisInfoFb
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_chassis_fusion_failures as failures
from test_chassis_fusion_failures import stamped,odometry
import test_chassis_odometry as chassis_fixtures
from greenhouse_navigation.chassis_odometry import body_twist,chassis_mode_allowed

class MatureInitializationTests(unittest.TestCase):
    def setUp(self):
        self.fusion=failures.ChassisFusionFailureTests().harness()
        self.adapter=chassis_fixtures.ChassisOdometryTests().harness()

    def frame(self,stamp,code,vx=0.,vy=0.,steering=None,wz=0.):
        n=self.fusion;n.clock=stamp;self.adapter.now=lambda:stamp
        fb=stamped(ChassisInfoFb(),stamp)
        fb.ctrl_fb.ctrl_fb_gear=code;fb.ctrl_fb.ctrl_fb_x_linear=float(vx);fb.ctrl_fb.ctrl_fb_y_linear=float(vy*10)
        fb.ctrl_fb.ctrl_fb_z_angular=float(math.degrees(wz))
        fb.steering_ctrl_fb.steering_ctrl_fb_gear=code if steering is None else steering
        old=len(self.adapter.outputs)
        self.adapter.receive(fb);n.feedback_cb(fb)
        imu=stamped(Imu(),stamp);imu.header.frame_id='imu_link';imu.linear_acceleration.z=9.81;n.imu_cb(imu)
        if len(self.adapter.outputs)>old:n.odom_cb(self.adapter.outputs[-1])
        n.filtered_cb(odometry(stamp));n.status()
        return json.loads(n.statuses[-1].data),fb

    def test_confirmed_gears_keep_one_epoch_and_signed_odometry(self):
        for code,vx,vy in [(6,.1,0.),(6,-.1,0.),(8,0.,-.1),(8,0.,.1)]:
            for i in range(30):
                state,fb=self.frame(10.+len(self.adapter.outputs)*.05,code,vx,vy)
                self.assertEqual(state['state'],'FUSED',self.fusion.invalid_reason)
                self.assertEqual(state['epoch'],'failure-test-origin')
                self.assertEqual(body_twist(fb)[0],fb.ctrl_fb.ctrl_fb_x_linear)
                self.assertAlmostEqual(self.adapter.outputs[-1].twist.twist.linear.y,vy,places=6)
        self.assertEqual(self.fusion.invalid_reason,'')

    def test_stationary_mode_selection_longer_than_timeout_does_not_drop_odometry(self):
        for code in (1,6,8,0,6):
            for _ in range(25):
                state,_=self.frame(10.+len(self.adapter.outputs)*.05,code)
                self.assertEqual(state['state'],'FUSED')
                self.assertTrue(state['ready'])
                self.assertAlmostEqual(self.fusion.stamps['feedback'],self.fusion.clock)
                self.assertAlmostEqual(self.fusion.stamps['odom'],self.fusion.clock)
        self.assertEqual((self.adapter.x,self.adapter.y),(0.,0.))

    def test_parking_with_measured_motion_preserves_actual_twist_and_epoch(self):
        self.frame(10.,6,-.05)
        state,_=self.frame(10.015,0,-.045,steering=6)
        self.assertAlmostEqual(self.fusion.stamps['feedback'],10.015)
        self.assertAlmostEqual(self.adapter.outputs[-1].twist.twist.linear.x,-.045,places=6)
        self.assertEqual(state['state'],'FUSED')
        state,_=self.frame(10.03,0)
        self.assertEqual(state['state'],'FUSED');self.assertEqual(state['epoch'],'failure-test-origin')

    def test_any_actuator_selection_preserves_measurements_without_granting_a_driving_mode(self):
        from greenhouse_navigation.chassis_odometry import measured_body_twist
        for code in (6,0,7,8,5,6,1):
            for i in range(30):
                stamp=10.+len(self.adapter.outputs)*.05
                state,fb=self.frame(stamp,code,0.,-.1,steering=7)
                self.assertEqual(state['state'],'FUSED',self.fusion.invalid_reason)
                self.assertEqual(state['epoch'],'failure-test-origin')
                self.assertAlmostEqual(measured_body_twist(fb)[1],-.1,places=6)
            if code in (5,7):self.assertFalse(chassis_mode_allowed(code,False))

    def test_nonfinite_measurement_cannot_revive_or_refresh_valid_odometry(self):
        self.frame(10.,6)
        count=len(self.adapter.outputs)
        state,_=self.frame(10.05,6,float('nan'))
        self.assertEqual(state['state'],'INVALID');self.assertEqual(len(self.adapter.outputs),count)
        self.assertIn('速度测量无效',self.fusion.invalid_reason)

    def test_actual_failed_recording_replays_without_mode_triggered_origin_reset(self):
        path=Path(__file__).resolve().parents[1]/'logs/41e030d6-ac83-4769-939f-c820a9904281-mode-reset.json'
        if not path.exists():self.skipTest('现场证据文件仅保存在Pi')
        records=json.loads(path.read_text())['motionRecords'];origin=records[0]['stamp']
        for r in records:
            state,_=self.frame(10.+r['stamp']-origin,r['bodyGear'],r['vx'],r['vy'],r['steeringGear'],r['wz'])
            self.assertEqual(state['state'],'FUSED',(r,state,self.fusion.invalid_reason))
            self.assertEqual(state['epoch'],'failure-test-origin')
        self.assertGreater(len(records),7000)

if __name__=='__main__':unittest.main(verbosity=2)
