import json,math,unittest
from pathlib import Path
from unittest.mock import patch
import test_forward_only as fixtures
from greenhouse_navigation.control import Pose,geometry
from greenhouse_navigation.mission import exit_point,row_heading
class OfficeRouteTests(unittest.TestCase):
 def test_all_four_boards_then_stop_without_reverse(self):
  helper=fixtures.ForwardOnlyTests();m,_,task,_,_=helper.harness()
  generated=json.loads(Path('/tmp/office3-generated.json').read_text());field=generated['map'];field['coordinateStatus']='reviewed';task.update(generated['task'])
  start=exit_point(field['rows'][0]);pose=Pose(start['x'],start['y'],row_heading(field['rows'][0]),.01)
  tags={t['id']:t for t in field['tags']};points=[start]+field['rows'][0]['points'];now=[100.];states=set();near={k:99. for k in tags};maxcross=0.
  with patch('greenhouse_navigation.mission.time.monotonic',side_effect=lambda:now[0]):
   m.start(field,task,pose);fb={'seq':0,'speed':0.,'steering_gear':6,'body_gear':6,'steering_angle':0.,'angle_source':'existing_chassis'}
   for i in range(6000):
    now[0]+=.05;fb.update(seq=i,aggregate_received=now[0])
    for k,t in tags.items():near[k]=min(near[k],math.hypot(pose.x-t['x'],pose.y-t['y']))
    obs=[{'id':k} for k,t in tags.items() if math.hypot(pose.x-t['x'],pose.y-t['y'])<.15]
    cmd=m.tick(pose,fb,obs,[],.05);states.add(m.state);maxcross=max(maxcross,abs(geometry(pose,points)[0]))
    self.assertNotEqual(m.state,'FAULT',m.events);self.assertGreaterEqual(cmd.vx,0);self.assertEqual(cmd.vy,0)
    self.assertLessEqual(abs(cmd.yaw_rate),cmd.vx*.6+1e-10)
    pose.x+=cmd.vx*.05*math.cos(pose.yaw);pose.y+=cmd.vx*.05*math.sin(pose.yaw);pose.yaw+=cmd.yaw_rate*.05;fb['speed']=cmd.vx
    if m.state=='FINISHED':break
   self.assertEqual(m.state,'FINISHED',m.events);self.assertNotIn('REVERSE',states);self.assertNotIn('LATERAL_SHIFT',states)
   self.assertLess(near[32],.12);self.assertLess(near[49],.05);self.assertLess(near[16],.035);self.assertLess(maxcross,.04)
   self.assertEqual(m.tick(pose,fb,[],[],.05).vx,0)
   print('Office simulation:',{'nearest_board_m':near,'max_path_error_m':maxcross,'final':m.state})
if __name__=='__main__':unittest.main()
