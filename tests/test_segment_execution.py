"""Pure kinematic tests; never load ROS publishers or touch CAN."""
import copy
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import yaml
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.control import Pose
from greenhouse_navigation.mission import Mission
from greenhouse_navigation.segment_execution import validate_segments


def segment(a,b,mode='4t4d',direction='forward',index=0):
    angle=math.degrees(math.atan2(b[1]-a[1],b[0]-a[0]))
    if angle>90:angle-=180
    if angle< -90:angle+=180
    return {'id':str(index),'fromId':index,'toId':index+1,'mode':mode,'direction':direction,
            'bodyYaw':0.,'endYaw':0.,'wheelAngle':angle if mode=='crab' else 0.,
            'points':[{'x':a[0],'y':a[1]},{'x':(a[0]+b[0])/2,'y':(a[1]+b[1])/2},{'x':b[0],'y':b[1]}]}


def setup(segments=None,returning=False):
    config=yaml.safe_load((ROOT/'config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters']
    config.update(existing_chassis_confirmed=True,existing_runtime_conditions_accepted=True)
    ss=segments or [segment((0,0),(.3,0)),segment((.3,0),(.3,.3),'crab','lateral',1),
                    segment((.3,.3),(.6,.6),'crab','lateral',2),segment((.6,.6),(.3,.6),'4t4d','reverse',3)]
    points=[ss[0]['points'][0]]+[s['points'][-1] for s in ss]
    field={'coordinateStatus':'reviewed','routeMode':'waypoints','motionSegments':ss,
           'rows':[{'id':'route','name':'测试','points':points[1:],'start':points[0],'exitDistance':.8}],
           'tags':[{'id':i,**p} for i,p in enumerate(points)]}
    task={'id':'task','rowOrder':['route'],'forwardSpeed':.08,'reverseSpeed':.06,'lateralSpeed':.05,
          'endWaitSeconds':.2,'returnToStart':returning}
    m=Mission(config);pose=Pose(points[0]['x'],points[0]['y'],ss[0]['bodyYaw'])
    m.start(field,task,pose)
    return m,pose


class SegmentExecutionTests(unittest.TestCase):
    def setUp(self):
        self.now=100.;self.seq=0
        self.clock=patch('time.monotonic',lambda:self.now);self.clock.start();self.addCleanup(self.clock.stop)

    def feedback(self,mode='4t4d',angle=0.,speed=0.):
        self.seq+=1
        return {'seq':self.seq,'aggregate_received':self.now,'speed':speed,'body_gear':8 if mode=='crab' else 6,
                'steering_gear':7 if mode=='crab' else 5,'steering_angle':angle,
                'angle_source':'existing_chassis','angles':[angle]*4}

    def tick(self,m,pose,mode=None,angle=None,speed=0.,observations=None):
        self.now+=.05
        fb=self.feedback(mode or m.mode,m.target_angle if angle is None else angle,speed)
        return m.tick(pose,fb,observations if observations is not None else [{'id':m.segment_executor.segment['fromId']}],[],.05)

    def enter_move(self,m,pose):
        for _ in range(15):
            command=self.tick(m,pose)
            if m.segment_executor.phase=='MOVE':return
        self.fail(str(m.events))

    def test_received_feedback_aliases_do_not_add_command_modes(self):
        for mode,body,steering in [('4t4d',5,5),('4t4d',5,6),('4t4d',6,6),('crab',7,7),('crab',8,7)]:
            ss=[segment((0,0),(.3,0))] if mode=='4t4d' else [segment((0,0),(0,.3),'crab','lateral')]
            m,pose=setup(ss);ex=m.segment_executor;ex.align()
            fb=self.feedback(mode,m.target_angle);fb.update(body_gear=body,steering_gear=steering)
            self.assertTrue(ex.mode_ready(fb))
            command=ex.zero();self.assertEqual(command.mode,mode);self.assertEqual(command.vx,0);self.assertEqual(command.vy,0)
            fb['steering_gear']=7 if mode=='4t4d' else 6
            self.assertFalse(ex.mode_ready(fb))

    def test_received_aliases_pass_full_stopped_alignment_state_machine(self):
        for mode,body,steer in [('4t4d',5,5),('4t4d',5,6),('crab',7,7)]:
            ss=[segment((0,0),(.3,0))] if mode=='4t4d' else [segment((0,0),(0,.3),'crab','lateral')]
            m,pose=setup(ss)
            for _ in range(20):
                self.now+=.05;fb=self.feedback(mode,m.target_angle);fb.update(body_gear=body,steering_gear=steer)
                command=m.tick(pose,fb,[{'id':0}],[],.05)
                if m.segment_executor.phase=='START_STOP':
                    self.assertEqual((command.vx,command.vy),(0.,0.))
                else:self.assertEqual(command.mode,mode)
                if m.segment_executor.phase=='MOVE':break
            self.assertEqual(m.segment_executor.phase,'MOVE',str(m.events))
            self.now+=.05;fb=self.feedback(mode,m.target_angle);fb.update(body_gear=body,steering_gear=steer)
            command=m.tick(pose,fb,[{'id':0}],[],.05)
            self.assertGreater(math.hypot(command.vx,command.vy),0)
            self.assertEqual(command.mode,mode)

    def test_mixed_route_and_return_finish_at_start_without_body_turn(self):
        for returning in (False,True):
            with self.subTest(returning=returning):
                m,pose=setup(returning=returning);previous=None;switches=[];moved=[]
                vx=vy=wz=0.
                for _ in range(4000):
                    ex=m.segment_executor;s=ex.segment
                    if ex.phase=='END_STOP':pose.x=s['points'][-1]['x'];pose.y=s['points'][-1]['y']
                    # Camera sees the target group only when the body reaches it.
                    observations=[{'id':s[k]} for k,p in [('fromId',s['points'][0]),('toId',s['points'][-1])] if math.hypot(pose.x-p['x'],pose.y-p['y'])<.06]
                    mode=m.mode;angle=m.target_angle
                    command=self.tick(m,pose,mode,angle,math.hypot(vx,vy),observations)
                    if previous is not None and (command.mode,command.wheel_angle)!=previous:
                        self.assertLessEqual(math.hypot(vx,vy),m.config['stopped_speed_mps'])
                        self.assertEqual(command.vx,0);self.assertEqual(command.vy,0)
                        switches.append((command.mode,command.wheel_angle))
                    previous=(command.mode,command.wheel_angle)
                    if abs(command.vx)+abs(command.vy)>0:
                        moved.append((ex.index,command.vx,command.vy))
                        self.assertEqual(ex.phase,'MOVE')
                        if command.mode=='crab':self.assertEqual(command.yaw_rate,0.)
                    vx,vy,wz=command.vx,command.vy,command.yaw_rate
                    pose.x+=(vx*math.cos(pose.yaw)-vy*math.sin(pose.yaw))*.05
                    pose.y+=(vx*math.sin(pose.yaw)+vy*math.cos(pose.yaw))*.05;pose.yaw+=wz*.05
                    if not m.running:break
                self.assertEqual(m.state,'FINISHED',m.events)
                self.assertEqual(set(i for i,_,_ in moved),set(range(8 if returning else 4)))
                target=(0,0) if returning else (.3,.6)
                self.assertLess(math.hypot(pose.x-target[0],pose.y-target[1]),.045)
                self.assertAlmostEqual(pose.yaw,0.)
                self.assertTrue(any(mode=='crab' and abs(a-45)<1e-6 for mode,a in switches))
                if returning:self.assertTrue(any(i==5 and x<0 and y<0 for i,x,y in moved))

    def test_no_mode_change_before_five_distinct_stopped_frames(self):
        m,pose=setup([segment((0,0),(0,.3),'crab','lateral')]);m.mode='4t4d'
        for _ in range(10):
            c=self.tick(m,pose,speed=.05);self.assertEqual(c.mode,'4t4d');self.assertEqual(m.segment_executor.phase,'START_STOP')
        fb=self.feedback();
        for _ in range(10):m.tick(pose,fb,[{'id':0}],[],.05)
        self.assertEqual(m.segment_executor.phase,'START_STOP')
        for _ in range(4):self.tick(m,pose)
        self.assertEqual(m.segment_executor.phase,'ALIGN');self.assertEqual(m.mode,'crab')

    def test_wrong_angle_wrong_gear_and_duplicates_cannot_finish_alignment(self):
        m,pose=setup([segment((0,0),(0,.3),'crab','lateral')])
        for _ in range(5):self.tick(m,pose)
        self.assertEqual(m.segment_executor.phase,'ALIGN')
        for _ in range(12):self.tick(m,pose,mode='crab',angle=0.)
        self.assertEqual(m.segment_executor.phase,'ALIGN')
        fb=self.feedback('crab',90.)
        for _ in range(15):m.tick(pose,fb,[],[],.05)
        self.assertEqual(m.segment_executor.phase,'ALIGN')
        for _ in range(4):self.tick(m,pose,mode='crab',angle=90.)
        self.assertEqual(m.segment_executor.phase,'MOVE')
        c=self.tick(m,pose,mode='4t4d');self.assertEqual(m.state,'FAULT');self.assertEqual(c.vy,0)

    def test_pause_mid_interval_requires_new_stop_and_alignment(self):
        m,pose=setup([segment((0,0),(0,.3),'crab','lateral')]);self.enter_move(m,pose)
        pose.y=.12;m.pause();self.assertEqual(self.tick(m,pose).vy,0.)
        m.resume()
        for _ in range(4):
            c=self.tick(m,pose,observations=[]);self.assertEqual(c.vy,0.)
        self.assertEqual(m.segment_executor.phase,'RECOVER_STOP')
        self.tick(m,pose,observations=[])
        self.assertEqual(m.segment_executor.phase,'ALIGN')
        for _ in range(5):self.tick(m,pose,observations=[])
        self.assertEqual(m.segment_executor.phase,'MOVE');self.assertGreater(self.tick(m,pose,observations=[]).vy,0.)

    def test_endpoint_requires_position_and_fresh_target_code(self):
        m,pose=setup();self.enter_move(m,pose)
        pose.x=.28;self.tick(m,pose,observations=[])
        self.assertEqual(m.segment_executor.phase,'END_STOP')
        for _ in range(12):self.tick(m,pose,observations=[])
        self.assertEqual(m.segment_executor.index,0);self.assertEqual(m.mode,'4t4d')
        pose.x=.5
        for _ in range(6):self.tick(m,pose,observations=[{'id':1}])
        self.assertEqual(m.segment_executor.index,0)
        pose.x=.3;self.tick(m,pose,observations=[{'id':1}])
        self.assertEqual(m.segment_executor.index,1);self.assertEqual(m.mode,'crab')

    def test_stale_negative_speed_and_heading_drift_fault_with_zero_output(self):
        for failure in ('stale','negative','yaw'):
            m,pose=setup([segment((0,0),(0,.3),'crab','lateral')]);self.enter_move(m,pose)
            fb=self.feedback('crab',90.)
            if failure=='stale':fb['aggregate_received']-=1.
            elif failure=='negative':fb['speed']=-.1
            else:pose.yaw=.11
            c=m.tick(pose,fb,[],[],.05)
            self.assertEqual(m.state,'FAULT');self.assertEqual((c.vx,c.vy,c.yaw_rate),(0.,0.,0.));self.assertEqual(c.mode,'crab')

    def test_mismatched_or_unknown_received_body_state_cannot_move(self):
        for gear in (5,9):
            m,pose=setup([segment((0,0),(0,.3),'crab','lateral')]);self.enter_move(m,pose)
            fb=self.feedback('crab',90.);fb['body_gear']=gear
            c=m.tick(pose,fb,[],[],.05)
            self.assertEqual(m.state,'FAULT');self.assertEqual((c.vx,c.vy,c.yaw_rate),(0.,0.,0.))

    def test_timeout_and_invalid_routes_never_move(self):
        m,pose=setup();self.now+=20
        c=self.tick(m,pose,observations=[]);self.assertEqual(m.state,'FAULT');self.assertEqual(c.vx,0.)
        bad=segment((0,0),(0,.3),'crab','lateral');bad['wheelAngle']=0.
        with self.assertRaises(ValueError):validate_segments([bad])
        bad=segment((0,0),(.3,0));bad['bodyYaw']=math.pi
        with self.assertRaises(ValueError):validate_segments([bad])

if __name__=='__main__':unittest.main(verbosity=2)
