import copy
import math
import unittest
from unittest.mock import patch
import test_forward_only as fixtures
from greenhouse_navigation.control import Pose,Tracker
from greenhouse_navigation.mission import exit_point,row_heading

class ContinuousCorrectionTests(fixtures.ForwardOnlyTests):
    def forward(self):
        m,field,task,pose,h=self.harness()
        m.start(field,task,pose);m.state='FORWARD'
        return m,field,task,pose,h

    def test_recorded_b032_correction_keeps_moving_with_bounded_turn(self):
        m,field,task,pose,h=self.forward()
        before=copy.deepcopy(field);old_task=copy.deepcopy(task)
        m.tracker.previous_speed=.078
        previous=0.
        for x,y,yaw in [(1.6837,.0222,h+math.radians(.17)),
                         (1.7070,.0763,h+math.radians(.41)),
                         (1.7093,.0834,h+math.radians(.51))]:
            cmd=m.tick(Pose(x,y,yaw,.015),{'seq':1,'speed':.07},[{'id':32}],[],.05)
            self.assertEqual(m.state,'FORWARD');self.assertTrue(m.running)
            self.assertGreater(cmd.vx,0.);self.assertEqual(cmd.vy,0.)
            self.assertLessEqual(abs(cmd.yaw_rate-previous),.15*.05+1e-12)
            self.assertLessEqual(abs(cmd.yaw_rate),cmd.vx*.6+1e-12)
            previous=cmd.yaw_rate
        self.assertLess(cmd.vx,.078);self.assertLess(cmd.yaw_rate,0.)
        self.assertEqual(field,before);self.assertEqual(task,old_task)

    def test_heading_error_over_old_limit_is_corrected_while_moving(self):
        m,field,task,pose,h=self.forward();pose.yaw=h+.20
        cmd=m.tick(pose,{'seq':1,'speed':0.},[],[],.05)
        self.assertEqual(m.state,'FORWARD');self.assertGreater(cmd.vx,0.)
        self.assertLess(cmd.yaw_rate,0.)

    def test_qr_jump_then_no_markers_converges_on_original_long_path(self):
        now=[100.]
        with patch('greenhouse_navigation.mission.time.monotonic',side_effect=lambda:now[0]):
            m,field,task,pose,h=self.harness()
            a=exit_point(field['rows'][0])
            field['rows'][0]['points']=[{'x':a['x']+d*math.cos(h),'y':a['y']+d*math.sin(h)} for d in [.8,6.]]
            m.start(field,task,pose);m.state='FORWARD'
            fb={'seq':0,'speed':0.};jumped=False;states=set()
            for i in range(6000):
                now[0]+=.05;fb['seq']=i
                along=(pose.x-a['x'])*math.cos(h)+(pose.y-a['y'])*math.sin(h)
                obs=[]
                if along>=1.6 and not jumped:
                    pose.x-=.06*math.sin(h);pose.y+=.06*math.cos(h)
                    jumped=True;obs=[{'id':32}]
                cmd=m.tick(pose,fb,obs,[],.05);states.add(m.state)
                self.assertNotEqual(m.state,'FAULT');self.assertGreaterEqual(cmd.vx,0.)
                pose.x+=cmd.vx*.05*math.cos(pose.yaw);pose.y+=cmd.vx*.05*math.sin(pose.yaw)
                pose.yaw+=cmd.yaw_rate*.05;fb['speed']=cmd.vx
                if m.state=='FINISHED':break
            cross=-(pose.x-a['x'])*math.sin(h)+(pose.y-a['y'])*math.cos(h)
            self.assertTrue(jumped);self.assertLess(abs(cross),.01)
            self.assertEqual(m.state,'FINISHED');self.assertNotIn('REVERSE',states)

    def test_late_correction_stops_at_route_end_and_reports_residual(self):
        now=[100.]
        with patch('greenhouse_navigation.mission.time.monotonic',side_effect=lambda:now[0]):
            m,field,task,pose,h=self.forward()
            pose.x=1.7093;pose.y=.0834;pose.yaw=h+math.radians(.51)
            fb={'seq':0,'speed':0.};states=set()
            for i in range(500):
                now[0]+=.05;fb['seq']=i
                cmd=m.tick(pose,fb,[],[],.05);states.add(m.state)
                self.assertGreaterEqual(cmd.vx,0.);self.assertEqual(cmd.vy,0.)
                pose.x+=cmd.vx*.05*math.cos(pose.yaw);pose.y+=cmd.vx*.05*math.sin(pose.yaw)
                pose.yaw+=cmd.yaw_rate*.05;fb['speed']=cmd.vx
                if m.state=='FINISHED':break
            self.assertEqual(m.state,'FINISHED');self.assertNotIn('REVERSE',states)
            self.assertTrue(any('位置残差' in e for e in m.events))
            target=field['rows'][0]['points'][-1]
            self.assertLessEqual((pose.x-target['x'])*math.cos(h)+(pose.y-target['y'])*math.sin(h),0.)

    def test_pause_stop_and_fault_reset_turn_ramp(self):
        m,field,task,pose,h=self.forward();pose.yaw=h+.2
        for i in range(20):m.tick(pose,{'seq':i,'speed':0.},[],[],.05)
        m.pause();cmd=m.tick(pose,{},[],[],.05)
        self.assertEqual((cmd.vx,cmd.yaw_rate),(0.,0.))
        m.resume();cmd=m.tick(pose,{},[],[],.05)
        self.assertLessEqual(abs(cmd.yaw_rate),.15*.05+1e-12)
        cmd=m.tick(pose,{},[],[{'label':'急停','ready':False}],.05)
        self.assertEqual((cmd.vx,cmd.yaw_rate),(0.,0.));self.assertEqual(m.state,'FAULT')
        self.assertEqual(m.tracker.previous_forward_yaw_rate,0.)

    def test_alternating_pose_corrections_do_not_step_turn_command(self):
        tracker=Tracker();tracker.previous_speed=.08;previous=0.
        points=[{'x':0.,'y':0.},{'x':3.,'y':0.}]
        for y in [.06,-.06]*30:
            cmd,*_=tracker.forward(Pose(1.,y,0.),points,.08,.05)
            self.assertLessEqual(abs(cmd.yaw_rate-previous),.15*.05+1e-12)
            previous=cmd.yaw_rate

if __name__=='__main__':unittest.main(verbosity=2)
