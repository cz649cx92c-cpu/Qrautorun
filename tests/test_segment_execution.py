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
from greenhouse_navigation.control import Pose, geometry, wrap
from greenhouse_navigation.mission import Mission
from greenhouse_navigation.segment_execution import validate_segments


def segment(a,b,mode='4t4d',direction='forward',index=0):
    angle=math.degrees(math.atan2(b[1]-a[1],b[0]-a[0]))
    if angle>90:angle-=180
    if angle< -90:angle+=180
    return {'id':str(index),'fromId':index,'toId':index+1,'mode':mode,'direction':direction,
            'bodyYaw':0.,'endYaw':0.,'wheelAngle':angle if mode=='crab' else 0.,
            'points':[{'x':a[0],'y':a[1]},{'x':(a[0]+b[0])/2,'y':(a[1]+b[1])/2},{'x':b[0],'y':b[1]}]}


# Turn-in-place parameters are declared by node.py through ROS parameter defaults,
# so the YAML fixture carries none of them. Mirror those defaults here.
TURN_DEFAULTS={'turn_yaw_rate_max_radps':.3,'turn_yaw_accel_radps2':.6,'turn_yaw_gain':1.5,
               'turn_tolerance_deg':5.,'turn_timeout_s':15.}


def setup(segments=None,returning=False,start_yaw=None):
    config=yaml.safe_load((ROOT/'config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters']
    config.update(existing_chassis_confirmed=True,existing_runtime_conditions_accepted=True)
    for key,value in TURN_DEFAULTS.items():config.setdefault(key,value)
    ss=segments or [segment((0,0),(.3,0)),segment((.3,0),(.3,.3),'crab','lateral',1),
                    segment((.3,.3),(.6,.6),'crab','lateral',2),segment((.6,.6),(.3,.6),'4t4d','reverse',3)]
    points=[ss[0]['points'][0]]+[s['points'][-1] for s in ss]
    field={'coordinateStatus':'reviewed','routeMode':'waypoints','motionSegments':ss,
           'rows':[{'id':'route','name':'测试','points':points[1:],'start':points[0],'exitDistance':.8}],
           'tags':[{'id':i,**p} for i,p in enumerate(points)]}
    task={'id':'task','rowOrder':['route'],'forwardSpeed':.08,'reverseSpeed':.06,'lateralSpeed':.05,
          'endWaitSeconds':.2,'returnToStart':returning}
    m=Mission(config);pose=Pose(points[0]['x'],points[0]['y'],ss[0]['bodyYaw'] if start_yaw is None else start_yaw)
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

    def enter_turn(self,m,pose):
        for _ in range(20):
            self.tick(m,pose)
            if m.segment_executor.phase=='TURN':return
        self.fail(str(m.events))

    def spin(self,m,pose,limit=600):
        """Offline kinematics: integrate the commanded yaw rate until MOVE starts.

        Returns (first_move_command, in_place_commands, reached_turn_stop).  The
        first MOVE command is the one produced by the tick in which TURN_STOP
        completes, so a dead cycle after the turn shows up as vx==0 here.
        """
        in_place=[];reached_stop=False;first_move=None
        for _ in range(limit):
            command=self.tick(m,pose)
            phase=m.segment_executor.phase
            if phase in ('TURN','TURN_STOP'):in_place.append(command)
            if phase=='TURN_STOP':reached_stop=True
            pose.yaw+=command.yaw_rate*.05
            if m.state=='FAULT':break
            if phase=='MOVE':
                first_move=command;break
        return first_move,in_place,reached_stop

    @staticmethod
    def turn_forward_segment():
        return {'id':'turn','fromId':0,'toId':1,'mode':'4t4d','direction':'forward',
                'strategy':'turn_forward','bodyYaw':math.pi/2,'endYaw':math.pi/2,
                'wheelAngle':0.,'points':[{'x':0.,'y':0.},{'x':0.,'y':.3}]}

    def test_turn_forward_90_turn_completion_emits_forward_command(self):
        m,pose=setup([self.turn_forward_segment()],start_yaw=0.)
        self.enter_turn(m,pose)
        first,in_place,stopped=self.spin(m,pose)
        self.assertTrue(stopped,'转向必须先经过 TURN_STOP 停稳确认：'+str(m.events))
        self.assertIsNotNone(first,'TURN_STOP 完成后必须立即产生前进指令：'+str(m.events))
        self.assertEqual(m.segment_executor.phase,'MOVE')
        self.assertEqual(m.state,'FORWARD')
        # A pure in-place turn never emits translation.
        for command in in_place:
            self.assertEqual((command.vx,command.vy),(0.,0.))
        self.assertLessEqual(abs(wrap(pose.yaw-math.pi/2)),math.radians(m.config['turn_tolerance_deg'])+.06)
        # The completing cycle itself is 4T4D forward: no dead (vx==0) cycle.
        self.assertEqual(first.mode,'4t4d')
        self.assertGreater(first.vx,0.)
        self.assertEqual(first.vy,0.)
        # ... and every following cycle keeps producing 4T4D forward motion.
        for _ in range(20):
            command=self.tick(m,pose)
            self.assertEqual(m.segment_executor.phase,'MOVE',str(m.events))
            self.assertEqual(command.mode,'4t4d')
            self.assertGreater(command.vx,0.,'转向后必须持续产生前进速度：'+str(m.events))
            self.assertEqual(command.vy,0.)

    def test_saved_route_turn_forward_payload_drives_forward_after_turn(self):
        # Shape mirrors web/backend/src/route-design.ts compileDesignedRoute output and
        # therefore the routes.motion_segments JSON the ROS node actually consumes.
        turn={'id':'design-interval-1','fromId':0,'toId':1,'mode':'4t4d','direction':'forward',
              'strategy':'turn_forward','executionProfile':'recorded_slow_trial',
              'bodyYaw':math.pi/2,'endYaw':math.pi/2,'wheelAngle':0.,
              'points':[{'x':0.,'y':i*.05} for i in range(9)]}
        straight={'id':'design-interval-2','fromId':1,'toId':2,'mode':'4t4d','direction':'forward',
                  'strategy':'forward','executionProfile':'recorded_slow_trial',
                  'bodyYaw':math.pi/2,'endYaw':math.pi/2,'wheelAngle':0.,
                  'points':[{'x':0.,'y':.4+i*.05} for i in range(9)]}
        validate_segments([turn,straight])
        m,pose=setup([copy.deepcopy(turn),copy.deepcopy(straight)],start_yaw=0.)
        self.enter_turn(m,pose)
        first,_,stopped=self.spin(m,pose)
        self.assertTrue(stopped,str(m.events))
        self.assertGreater(first.vx,0.,str(m.events))
        self.assertEqual(first.vy,0.)
        self.assertEqual(first.mode,'4t4d')

    def test_crab_interval_never_reports_forward(self):
        # A crab interval must stay lateral: vx==0 and vy!=0, never "forward".
        crab={'id':'crab','fromId':0,'toId':1,'mode':'crab','direction':'lateral',
              'bodyYaw':0.,'endYaw':0.,'wheelAngle':90.,
              'points':[{'x':0.,'y':0.},{'x':0.,'y':.3}]}
        m,pose=setup([crab],start_yaw=0.);executor=m.segment_executor;executor.align()
        command=executor.move_command(pose,self.feedback('crab',m.target_angle),[],.05)
        self.assertEqual(command.mode,'crab')
        self.assertLess(abs(command.vx),1e-9)
        self.assertGreater(command.vy,0.)
        self.assertEqual(command.yaw_rate,0.)

    def test_turn_forward_rejects_lateral_and_reverse_masquerade(self):
        lateral={'id':'t','fromId':0,'toId':1,'mode':'crab','direction':'lateral','strategy':'turn_forward',
                 'bodyYaw':0.,'endYaw':0.,'wheelAngle':90.,'points':[{'x':0.,'y':0.},{'x':0.,'y':.3}]}
        reverse={'id':'t2','fromId':0,'toId':1,'mode':'4t4d','direction':'reverse','strategy':'turn_forward',
                 'bodyYaw':0.,'endYaw':0.,'wheelAngle':0.,'points':[{'x':0.,'y':0.},{'x':.3,'y':0.}]}
        for bad in (lateral,reverse):
            with self.assertRaisesRegex(ValueError,'转向后前进'):validate_segments([bad])

    def test_turn_forward_keeps_safety_gates_after_turn(self):
        # 1) Stale chassis feedback after the turn still faults and outputs zero.
        m,pose=setup([self.turn_forward_segment()],start_yaw=0.)
        self.enter_turn(m,pose)
        first,_,_=self.spin(m,pose)
        self.assertGreater(first.vx,0.)
        self.now+=.05
        stale=self.feedback();stale['aggregate_received']-=1.
        command=m.tick(pose,stale,[{'id':0}],[],.05)
        self.assertEqual(m.state,'FAULT')
        self.assertEqual((command.vx,command.vy,command.yaw_rate),(0.,0.,0.))

        # 2) A heading residual beyond max_heading_rad after the turn keeps the gate.
        m,pose=setup([self.turn_forward_segment()],start_yaw=0.)
        self.enter_turn(m,pose)
        first,_,_=self.spin(m,pose)
        self.assertGreater(first.vx,0.)
        pose.yaw=math.pi/2+m.config['max_heading_rad']+.05
        command=self.tick(m,pose)
        self.assertEqual(m.state,'FAULT')
        self.assertEqual((command.vx,command.vy,command.yaw_rate),(0.,0.,0.))

        # 3) Cross-track beyond the centering limit after the turn faults instead of
        #    silently driving on (inside the limit it is corrected with crab centering).
        m,pose=setup([self.turn_forward_segment()],start_yaw=0.)
        self.enter_turn(m,pose)
        first,_,_=self.spin(m,pose)
        self.assertGreater(first.vx,0.)
        pose.x=m.config.get('centering_max_offset_m',.12)+.05
        command=self.tick(m,pose)
        self.assertEqual(m.state,'FAULT')
        self.assertEqual((command.vx,command.vy,command.yaw_rate),(0.,0.,0.))

    def test_non_turn_forward_keeps_regular_forward_command(self):
        m,pose=setup([segment((0,0),(.3,0))])
        self.enter_move(m,pose)
        command=self.tick(m,pose)
        self.assertEqual(m.segment_executor.phase,'MOVE')
        self.assertGreater(command.vx,0.)
        self.assertEqual(command.vy,0.)
        self.assertEqual(command.yaw_rate,0.)

    def test_turn_error_and_timeout_keep_zero_output(self):
        m,pose=setup([self.turn_forward_segment()],start_yaw=0.)
        self.enter_turn(m,pose)
        self.now+=m.config['turn_timeout_s']+.1
        command=self.tick(m,pose)
        self.assertEqual(m.state,'FAULT')
        self.assertEqual((command.vx,command.vy,command.yaw_rate),(0.,0.,0.))

        # Residual grows again after standstill was confirmed: keep micro-adjusting,
        # but never emit translation while it is still turning.
        m,pose=setup([self.turn_forward_segment()],start_yaw=math.pi/2-math.radians(2.))
        self.enter_turn(m,pose)
        self.tick(m,pose)
        self.assertEqual(m.segment_executor.phase,'TURN_STOP')
        pose.yaw=math.pi/2-math.radians(20.)
        command=None
        for _ in range(10):
            command=self.tick(m,pose)
            if m.segment_executor.phase=='TURN':break
        self.assertEqual(m.segment_executor.phase,'TURN')
        self.assertEqual((command.vx,command.vy,command.yaw_rate),(0.,0.,0.))

    def _spin_with_drift(self,m,pose,drift_deg=-4.0):
        """Drive the turn, inject a post-stop residual drift once, then continue."""
        injected=False
        for _ in range(600):
            command=self.tick(m,pose)
            phase=m.segment_executor.phase
            pose.yaw+=command.yaw_rate*.05
            if phase=='TURN_STOP' and not injected:
                pose.yaw=math.pi/2+math.radians(drift_deg)
                injected=True
            if m.state=='FAULT':return None,False
            if phase=='MOVE':return command,True
        return None,False

    def _spin_with_offset(self,m,pose,offset_m=0.07,converge=True):
        """Turn, then simulate crab centering (converge or diverge) until MOVE/fault."""
        output=[]
        for _ in range(1200):
            command=self.tick(m,pose,mode='crab' if m.segment_executor.phase.startswith('CENTER') else None)
            output.append(command)
            pose.x+=command.vx*math.cos(pose.yaw)*.05-command.vy*math.sin(pose.yaw)*.05
            pose.y+=command.vx*math.sin(pose.yaw)*.05+command.vy*math.cos(pose.yaw)*.05
            pose.yaw+=command.yaw_rate*.05
            if not converge and m.segment_executor.phase=='CENTER_MOVE':
                pose.x+=0.003  # 故意向远离目标线方向漂移
            if m.state=='FAULT':return output,False
            if m.segment_executor.phase=='MOVE':
                # 进入 MOVE 的这一周期先从 ALIGN 返回零指令，再取下一周期的真实前进指令。
                command=self.tick(m,pose)
                output.append(command)
                return output,True
        return output,False

    def test_turn_correction_uses_stricter_tolerance_and_actually_rotates(self):
        m,pose=setup([self.turn_forward_segment()],start_yaw=0.)
        self.enter_turn(m,pose)
        first,ok=self._spin_with_drift(m,pose,drift_deg=-4.0)
        self.assertTrue(ok,'转角修正后必须能进入前进：'+str(m.events))
        self.assertIsNotNone(first,'转向完成后必须产生前进指令：'+str(m.events))
        self.assertEqual(first.mode,'4t4d');self.assertGreater(first.vx,0.);self.assertEqual(first.vy,0.)
        corrections=m.segment_executor.turn_info['corrections']
        self.assertTrue(corrections,'4.0°残差必须触发真实修正，不能被5°旧门限吞掉：'+str(m.events))
        for item in corrections:
            self.assertGreaterEqual(abs(item['deltaDeg']),.2,'每次修正必须有真实姿态变化：'+str(item))
            self.assertGreaterEqual(item['wzMaxRadps'],.06,'修正必须发出有符号非零wz：'+str(item))
        self.assertLessEqual(abs(wrap(pose.yaw-math.pi/2)),m.segment_executor.turn_acceptance()+.06)
        self.assertIn('转角修正', ' | '.join(m.events))

    def test_turn_correction_without_pose_change_faults(self):
        m,pose=setup([self.turn_forward_segment()],start_yaw=0.)
        self.enter_turn(m,pose)
        # 先到 TURN_STOP，再制造 4° 残差漂移触发修正；之后冻结 yaw 模拟“发了wz但姿态没动”。
        for _ in range(400):
            command=self.tick(m,pose)
            pose.yaw+=command.yaw_rate*.05
            if m.segment_executor.phase=='TURN_STOP':break
        self.assertEqual(m.segment_executor.phase,'TURN_STOP',str(m.events))
        pose.yaw=math.pi/2+math.radians(4.0)
        command=None
        for _ in range(30):
            command=self.tick(m,pose)
            if m.state=='FAULT':break
        self.assertEqual(m.state,'FAULT')
        self.assertIn('未产生姿态变化', ' | '.join(m.events))
        self.assertEqual((command.vx,command.vy,command.yaw_rate),(0.,0.,0.))

    def test_turn_exit_centering_converges_then_moves_forward(self):
        m,pose=setup([self.turn_forward_segment()],start_yaw=0.)
        self.enter_turn(m,pose)
        pose.x=.07  # 转向出口相对目标直线偏差 7cm（超过5cm门限，未超对中上限）
        self.assertEqual(m.segment_executor.phase,'TURN',str(m.events))
        outputs,ok=self._spin_with_offset(m,pose,.07,converge=True)
        self.assertTrue(ok,'横移对中必须收敛并进入前进：'+str(m.events))
        self.assertTrue(m.segment_executor.exit_info.get('converged'),str(m.segment_executor.exit_info))
        self.assertTrue(m.segment_executor.centering_info.get('done'),str(m.segment_executor.centering_info))
        last=outputs[-1]
        self.assertEqual(last.mode,'4t4d');self.assertGreater(last.vx,0.);self.assertEqual(last.vy,0.)
        cross,_,_,_=geometry(pose,m.segment_executor.segment['points'])
        self.assertLessEqual(abs(cross),m.config['max_cross_track_m']+.01)

    def test_turn_exit_centering_divergence_faults(self):
        m,pose=setup([self.turn_forward_segment()],start_yaw=0.)
        self.enter_turn(m,pose)
        pose.x=.07
        outputs,ok=self._spin_with_offset(m,pose,.07,converge=False)
        self.assertEqual(m.state,'FAULT')
        self.assertIn('横移对中方向异常', ' | '.join(m.events))
        self.assertEqual((outputs[-1].vx,outputs[-1].vy),(0.,0.))

    def test_turn_exit_beyond_centering_limit_faults(self):
        m,pose=setup([self.turn_forward_segment()],start_yaw=0.)
        self.enter_turn(m,pose)
        pose.x=.14
        command=None
        for _ in range(200):
            command=self.tick(m,pose)
            pose.yaw+=command.yaw_rate*.05
            if m.state=='FAULT':break
        self.assertEqual(m.state,'FAULT')
        self.assertIn('超过对中上限', ' | '.join(m.events))
        self.assertEqual((command.vx,command.vy),(0.,0.))

    def test_crab_unavailable_faults_instead_of_forced_forward(self):
        m,pose=setup([self.turn_forward_segment()],start_yaw=0.)
        m.config['existing_chassis_confirmed']=False
        m.config['existing_runtime_conditions_accepted']=False
        self.enter_turn(m,pose)
        pose.x=.07
        command=None
        for _ in range(200):
            command=self.tick(m,pose)
            pose.yaw+=command.yaw_rate*.05
            if m.state=='FAULT':break
        self.assertEqual(m.state,'FAULT')
        self.assertIn('无法正交对中', ' | '.join(m.events))
        self.assertEqual((command.vx,command.vy),(0.,0.))

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

    # ---- localization-jump mitigation regressions (real 20:33:29 Q177->Q161 run) ----
    @staticmethod
    def jump_segment():
        return {'id':'jump','fromId':0,'toId':1,'mode':'4t4d','direction':'forward',
                'strategy':'turn_forward','bodyYaw':0.,'endYaw':0.,'wheelAngle':0.,
                'points':[{'x':0.,'y':0.},{'x':.3,'y':0.}]}

    def jump_setup(self):
        m,pose=setup([self.jump_segment()],start_yaw=0.)
        m.field['groups']=[{'id':'B0','referenceId':0,'members':[{'id':i} for i in range(16)]}]
        ex=m.segment_executor
        ex.phase='MOVE';ex.turn_done=True
        m.state='FORWARD';m.mode='4t4d';m.target_angle=0.;m.stable=0;m.last_sample=None
        pose.x=0.;pose.y=.0365;pose.yaw=0.
        return m,pose

    def jump_tick(self,m,pose,observations,vx=.05,vy=0.,mode='4t4d'):
        self.now+=.05;self.seq+=1
        crab=mode=='crab'
        fb={'seq':self.seq,'aggregate_received':self.now,'speed':abs(vx),'vx':vx,'vy_raw':vy,
            'body_gear':8 if crab else 6,'steering_gear':7 if crab else 5,'steering_angle':0.,
            'angle_source':'existing_chassis','angles':[0.]*4}
        return m.tick(pose,fb,observations,[],.05)

    @staticmethod
    def low_quality_observations():
        return [{'id':1,'groupId':'B0','visibleCount':1,'sigma':.04}]

    @staticmethod
    def high_quality_observations():
        return [{'id':1,'groupId':'B0','visibleCount':16,'sigma':.008}]

    def test_low_quality_single_code_jump_does_not_fault_on_first_frame(self):
        m,pose=self.jump_setup()
        self.jump_tick(m,pose,self.low_quality_observations(),vx=.05,vy=0.)
        # real replay: Q161 1/16 visible; cross jumps 3.65 -> 5.09 cm in one update
        pose.y=.0509
        command=self.jump_tick(m,pose,self.low_quality_observations(),vx=.05,vy=0.)
        self.assertNotEqual(m.state,'FAULT','低质量单码更新不应单帧直接 FAULT：'+str(m.events))
        self.assertEqual(command.mode,'4t4d')
        self.assertGreater(command.vx,0.)
        self.assertEqual(command.vy,0.)
        jump=getattr(m.segment_executor,'localization_jump',{})
        self.assertTrue(jump.get('decision','').startswith('suspected'),jump)
        self.assertEqual(jump.get('tagId'),1)
        self.assertEqual((jump.get('visible'),jump.get('total')),(1,16))
        self.assertAlmostEqual(jump.get('deltaCrossM'),.0144,places=4)
        self.assertTrue(jump.get('degraded'))
        self.assertEqual(m.segment_executor.exit_info.get('localizationJump',{}).get('reasonCode'),'localization_jump_suspected')

    def test_low_quality_jump_confirmation_window_times_out_to_fault(self):
        m,pose=self.jump_setup()
        self.jump_tick(m,pose,self.low_quality_observations(),vx=.05,vy=0.)
        pose.y=.0509
        self.jump_tick(m,pose,self.low_quality_observations(),vx=.05,vy=0.)
        self.assertNotEqual(m.state,'FAULT')
        for _ in range(60):
            self.jump_tick(m,pose,self.low_quality_observations(),vx=.05,vy=0.)
            if m.state=='FAULT':break
        self.assertEqual(m.state,'FAULT','连续低质量/窗口超时必须 FAULT：'+str(m.events))
        jump=getattr(m.segment_executor,'localization_jump',{})
        self.assertIn(jump.get('decision',''),('fault_timeout','fault_low_quality'))

    def test_low_quality_jump_beyond_hard_cross_limit_faults(self):
        m,pose=self.jump_setup()
        self.jump_tick(m,pose,self.low_quality_observations(),vx=.05,vy=0.)
        pose.y=.10
        self.jump_tick(m,pose,self.low_quality_observations(),vx=.05,vy=0.)
        self.assertEqual(m.state,'FAULT','超过跳变硬上限必须 FAULT：'+str(m.events))

    def test_high_quality_real_cross_error_still_faults(self):
        m,pose=self.jump_setup()
        self.jump_tick(m,pose,self.high_quality_observations(),vx=.05,vy=0.)
        pose.y=.0509
        self.jump_tick(m,pose,self.high_quality_observations(),vx=.05,vy=0.)
        self.assertEqual(m.state,'FAULT','高质量观测下真实 cross>5cm 必须 FAULT')

    def test_low_quality_jump_with_chassis_vy_faults(self):
        m,pose=self.jump_setup()
        self.jump_tick(m,pose,self.low_quality_observations(),vx=.05,vy=0.)
        pose.y=.0509
        self.jump_tick(m,pose,self.low_quality_observations(),vx=.05,vy=.05)
        self.assertEqual(m.state,'FAULT','底盘存在横向速度时不得继续忽略：'+str(m.events))

    def test_low_quality_jump_with_heading_error_faults(self):
        m,pose=self.jump_setup()
        self.jump_tick(m,pose,self.low_quality_observations(),vx=.05,vy=0.)
        pose.y=.0509;pose.yaw=.2
        self.jump_tick(m,pose,self.low_quality_observations(),vx=.05,vy=0.)
        self.assertEqual(m.state,'FAULT','航向异常时不得继续忽略：'+str(m.events))

    def test_high_quality_normal_forward_still_moves(self):
        m,pose=self.jump_setup()
        pose.y=.03
        command=self.jump_tick(m,pose,self.high_quality_observations(),vx=.05,vy=0.)
        self.assertNotEqual(m.state,'FAULT')
        self.assertEqual(m.segment_executor.phase,'MOVE')
        self.assertGreater(command.vx,0.);self.assertEqual(command.vy,0.)


    def test_low_quality_jump_does_not_cancel_active_centering_immediately(self):
        m,pose=self.jump_setup()
        ex=m.segment_executor
        ex.phase='CENTER_MOVE'
        ex.centering={'start_cross':.06,'start_pose':(pose.x,pose.y),'started':self.now,'moved':0.}
        ex.centering_info={'required':True,'startCrossM':.06,'done':False,'mode':'crab','travelM':0.}
        m.mode='crab';m.target_angle=0.;pose.y=.06
        self.jump_tick(m,pose,self.low_quality_observations(),mode='crab')
        pose.y=.075
        command=self.jump_tick(m,pose,self.low_quality_observations(),mode='crab')
        self.assertNotEqual(m.state,'FAULT','对中期间低质量单码更新不应取消对中或直接 FAULT：'+str(m.events))
        self.assertEqual(command.mode,'crab')
        self.assertTrue(getattr(ex,'localization_jump',{}).get('decision','').startswith('suspected'))
        self.assertEqual(ex.centering_info.get('localizationJump',{}).get('reasonCode'),'localization_jump_suspected')
        # A following high-quality observation confirms the pose; centering continues.
        for _ in range(2):
            self.jump_tick(m,pose,self.high_quality_observations(),mode='crab')
        self.assertNotEqual(m.state,'FAULT','高质量观测确认后应继续对中，而不是越过对中安全状态：'+str(m.events))


    def test_quality_unknown_cross_error_stops_conservatively(self):
        m,pose=self.jump_setup()
        unknown=[{'id':1}]
        self.jump_tick(m,pose,unknown,vx=.05,vy=0.)
        pose.y=.0509
        self.jump_tick(m,pose,unknown,vx=.05,vy=0.)
        self.assertEqual(m.state,'FAULT','质量字段缺失时不得启用跳变缓解，必须保守停车：'+str(m.events))
        jump=getattr(m.segment_executor,'localization_jump',{})
        self.assertEqual(jump.get('reasonCode'),'localization_jump_quality_unknown')


if __name__=='__main__':unittest.main(verbosity=2)
