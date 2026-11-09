"""Offline tracking convergence and actuator limits; no ROS/CAN commands."""
import math
import unittest
from test_reverse_continuity import ReverseContinuity
from test_segment_execution import setup, segment
from greenhouse_navigation.control import Tracker, Pose
from greenhouse_navigation.dr_anchor import build_anchor_event

class AnchorLookahead(unittest.TestCase):
    def simulate(self, reverse, offset, enabled):
        tracker=Tracker();tracker.previous_speed=.08
        points=[{'x':0.,'y':0.},{'x':-4. if reverse else 4.,'y':0.}]
        pose=Pose(0.,offset,0.)
        previous=0.
        for i in range(160):
            dt=[.03,.05,.07,.05][i%4]
            method=tracker.reverse if reverse else tracker.forward
            cmd=method(pose,points,.08,dt,anchor_lookahead=.35 if enabled else None)[0]
            self.assertLessEqual(abs(cmd.yaw_rate),abs(cmd.vx)*.6+1e-12)
            self.assertLessEqual(abs(cmd.yaw_rate-previous),.15*dt+1e-12)
            previous=cmd.yaw_rate
            self.assertEqual(cmd.vy,0.)
            self.assertLess(cmd.vx,0.) if reverse else self.assertGreater(cmd.vx,0.)
            pose.x+=cmd.vx*math.cos(pose.yaw)*dt
            pose.y+=cmd.vx*math.sin(pose.yaw)*dt
            pose.yaw+=cmd.yaw_rate*dt
        return abs(pose.y)

    def test_mirrored_forward_and_reverse_converge_faster(self):
        for reverse in (False,True):
            for offset in (-.015,.015,-.022,.022):
                with self.subTest(reverse=reverse,offset=offset):
                    before=self.simulate(reverse,offset,False)
                    after=self.simulate(reverse,offset,True)
                    print('SIM',reverse,offset,'old/new mm',round(before*1000,2),round(after*1000,2))
                    self.assertLess(after,before*.6)
                    self.assertLess(after,.006)

class AnchorIntegration(ReverseContinuity):
    def make(self):
        m,p=setup([segment((0,0),(.6,0)),segment((.6,0),(1.2,0),index=1)])
        self.enter_move(m,p)
        return m,p

    def context(self,m,pose,identity='a',bad=False):
        now=self.now
        loco={'x':pose.x,'y':pose.y,'yaw':pose.yaw,'stamp':now,'recvMono':now,'epoch':'E1'}
        event=build_anchor_event('qr',identity,now,'bad' if bad else None,None,'E1',1,
                 [pose.x,pose.y,pose.yaw],.01,[pose.x,pose.y,pose.yaw,now],now)
        return {'localEpoch':'E1','localOdom':loco,'qrAnchor':event,'qrRaw':{'recvMono':now}}

    def test_fresh_accepted_anchor_steers_before_stale_delay(self):
        m,p=self.make();p.y=.018;m.tracker.previous_speed=.08
        m.localization=self.context(m,p)
        cmd=m.segment_executor.move_command(p,self.fb(speed=.08),[{'id':1}],.05)
        self.assertEqual(m.segment_executor.exit_info['steeringSource'],'accepted_anchor_lookahead_4t4d')
        self.assertLess(cmd.yaw_rate,0.)
        self.assertGreater(cmd.vx,0.)
        self.assertLess(m.segment_executor.dr_state['staleS'],.25)
        self.assertAlmostEqual(m.segment_executor.dr_state['steerRefM'],.018,places=3)

    def test_handoff_preserves_anchor_and_yaw_slew(self):
        m,p=self.make();p.x=.58;p.y=.018;m.tracker.previous_speed=.08
        m.tracker.previous_forward_yaw_rate=-.03
        m.localization=self.context(m,p)
        cmd=m.segment_executor.move_command(p,self.fb(speed=.08),[{'id':1}],.05)
        self.assertEqual(m.segment_executor.index,1)
        self.assertTrue(m.segment_executor.dr_state['anchor_valid'])
        self.assertEqual(m.segment_executor.exit_info['steeringSource'],'accepted_anchor_lookahead_4t4d')
        self.assertLessEqual(abs(cmd.yaw_rate+.03),.15*.05+1e-12)
        self.assertGreater(cmd.vx,.06)

    def test_raw_without_accepted_anchor_does_not_enable_lookahead(self):
        m,p=self.make();p.y=.018
        m.localization={'localEpoch':'E1','localOdom':self.context(m,p)['localOdom'],
                        'qrRaw':{'recvMono':self.now}}
        m.segment_executor.move_command(p,self.fb(speed=.08),[{'id':1}],.05)
        self.assertNotEqual(m.segment_executor.exit_info['steeringSource'],'accepted_anchor_lookahead_4t4d')

    def test_rejected_scope_stale_sigma_and_epoch_do_not_enable(self):
        for kind in ('scope','stale','sigma','epoch'):
            with self.subTest(kind=kind):
                m,p=self.make();p.y=.018;m.field['id']='map';m.task['mapVersion']=1
                ctx=self.context(m,p);e=ctx['qrAnchor'];e['mapId']='map';e['mapVersion']=1
                if kind=='scope': e['mapId']='other'
                if kind=='stale': e['recvMono']=self.now-2.
                if kind=='sigma': e['sigma']=.2
                if kind=='epoch': e['localEpoch']='other'
                m.localization=ctx
                m.segment_executor.move_command(p,self.fb(speed=.08),[{'id':1}],.05)
                self.assertNotEqual(m.segment_executor.exit_info['steeringSource'],
                                    'accepted_anchor_lookahead_4t4d')

    def test_new_anchor_updates_cross_in_same_tick(self):
        m,p=self.make();p.y=.018;m.localization=self.context(m,p)
        ex=m.segment_executor
        ex.move_command(p,self.fb(speed=.08),[{'id':1}],.05)
        self.now+=.05;p.y=-.014;m.localization=self.context(m,p,identity='b')
        ex.move_command(p,self.fb(speed=.08),[{'id':1}],.05)
        self.assertAlmostEqual(ex.dr_state['steerRefM'],-.014,places=3)
        self.assertEqual(ex.dr_state['last_correction_id'],'b')

if __name__=='__main__': unittest.main()
