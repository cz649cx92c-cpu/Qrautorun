import copy,json,math,unittest
from pathlib import Path
from unittest.mock import patch
import test_forward_only as fixtures
from greenhouse_navigation.control import Pose,Tracker,geometry,wrap
from greenhouse_navigation.mission import exit_point,row_heading
class ReturnToStartTests(unittest.TestCase):
 def harness(self,enabled=True):
  m,_,task,_,_=fixtures.ForwardOnlyTests().harness();raw=json.loads((Path(__file__).parent/'fixtures/office-return.json').read_text());field=raw.get('map',raw);row=field['rows'][0]
  task.update(id='office-return-test',rowOrder=[row['id']],returnToStart=enabled)
  first=exit_point(row);pose=Pose(first['x'],first['y'],row_heading(row),.01)
  return m,field,task,pose
 def simulate(self,enabled):
  m,field,task,pose=self.harness(enabled);now=[100.];states=set();reverse=False;final=None
  with patch('greenhouse_navigation.mission.time.monotonic',side_effect=lambda:now[0]):
   m.start(field,copy.deepcopy(task),pose);fb={'seq':0,'speed':0.,'steering_gear':6,'body_gear':6,'steering_angle':0.,'angle_source':'existing_chassis'}
   for i in range(9000):
    now[0]+=.05;fb.update(seq=i,aggregate_received=now[0]);before=m.state;cmd=m.tick(pose,fb,[],[],.05);states.add(m.state)
    self.assertNotEqual(m.state,'FAULT',m.events);self.assertEqual(cmd.vy,0.);self.assertLessEqual(abs(cmd.yaw_rate),abs(cmd.vx)*.6+1e-10)
    if before=='FORWARD':self.assertGreaterEqual(cmd.vx,0.)
    if cmd.vx<0:reverse=True;self.assertEqual(before,'REVERSE')
    self.assertLess(abs(pose.yaw),math.pi/2,'倒车不应掉头')
    pose.x+=cmd.vx*.05*math.cos(pose.yaw);pose.y+=cmd.vx*.05*math.sin(pose.yaw);pose.yaw=wrap(pose.yaw+cmd.yaw_rate*.05);fb['speed']=abs(cmd.vx)
    if m.state=='FINISHED':final=pose;break
   self.assertIsNotNone(final,m.events);self.assertFalse(m.running);self.assertNotIn('LATERAL_SHIFT',states);self.assertNotIn('SWITCH_TO_LATERAL',states)
   target=exit_point(field['rows'][0]) if enabled else field['rows'][0]['points'][-1]
   error=math.hypot(final.x-target['x'],final.y-target['y']);self.assertLess(error,.035);self.assertEqual(reverse,enabled)
   for _ in range(10):self.assertEqual(m.tick(pose,fb,[],[],.05).vx,0.)
   print('Round trip simulation',{'enabled':enabled,'final_error_cm':error*100,'states':sorted(states)})
 def test_full_curved_route_returns_to_original_start(self):self.simulate(True)
 def test_disabled_still_finishes_at_forward_target(self):self.simulate(False)
 def test_reverse_waits_for_real_stopped_feedback_and_resets_tracker(self):
  m,field,task,pose=self.harness();m.start(field,task,pose);m.state='ROW_END';m.entered=0.;m.tracker.previous_speed=.08;m.tracker.previous_forward_yaw_rate=.04
  for seq in range(10):
   cmd=m.tick(pose,{'seq':seq,'speed':.03},[],[],.05);self.assertEqual(cmd.vx,0.);self.assertEqual(m.state,'ROW_END')
  for seq in range(10,15):m.tick(pose,{'seq':seq,'speed':0.},[],[],.05)
  self.assertEqual(m.state,'REVERSE');self.assertEqual(m.tracker.previous_speed,0.);self.assertEqual(m.tracker.previous_forward_yaw_rate,0.)
 def test_pause_stop_and_fault_never_enter_reverse(self):
  for action in ['pause','stop','fault']:
   m,field,task,pose=self.harness();m.start(field,task,pose);m.state='ROW_END';m.entered=0.
   if action=='fault':m.fault('CAN反馈失效')
   else:getattr(m,action)()
   for seq in range(10):self.assertEqual(m.tick(pose,{'seq':seq,'speed':0.},[],[],.05).vx,0.)
   self.assertNotEqual(m.state,'REVERSE')
 def test_reverse_fault_and_continuous_correction(self):
  m,field,task,pose=self.harness();m.start(field,task,pose);m.state='REVERSE';row=field['rows'][0];points=list(reversed(row['points']))+[exit_point(row)]
  p=row['points'][-8];pose.x=p['x'];pose.y=p['y'];_,travel,_,_=geometry(pose,points);pose.yaw=wrap(travel+math.pi)
  pose.x+=-.06*math.sin(pose.yaw);pose.y+=.06*math.cos(pose.yaw)
  cmd=m.tick(pose,{'seq':1,'speed':.02},[],[],.05);self.assertEqual(m.state,'REVERSE');self.assertLess(cmd.vx,0.)
  cmd=m.tick(pose,{'seq':2,'speed':.02},[],[{'label':'CAN','ready':False}],.05);self.assertEqual(cmd.vx,0.);self.assertEqual(m.state,'FAULT')
 def test_reverse_curve_feedforward_sign_for_both_turns(self):
  for sign in [-1,1]:
   points=[{'x':2*math.sin(i*.02),'y':sign*2*(1-math.cos(i*.02))} for i in range(51)];reverse=list(reversed(points));p=points[25];pose=Pose(p['x'],p['y'],0.)
   _,travel,_,_=geometry(pose,reverse);pose.yaw=wrap(travel+math.pi);tracker=Tracker();tracker.previous_speed=.06
   cmd,*_=tracker.reverse(pose,reverse,.06,.05);self.assertLess(cmd.vx,0.);self.assertLess(cmd.yaw_rate*sign,0.)
if __name__=='__main__':unittest.main()
