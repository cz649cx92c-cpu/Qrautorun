import unittest,copy,json,math
from pathlib import Path
from unittest.mock import patch
import yaml
from greenhouse_navigation.mission import Mission,exit_point,row_heading
from greenhouse_navigation.control import Pose

class ForwardOnlyTests(unittest.TestCase):
    def harness(self):
        root=Path(__file__).resolve().parents[1]
        config=yaml.safe_load((root/'config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters']
        field=json.loads((root/'tests/fixtures/office-straight.json').read_text());field=field.get('map',field)
        row=field['rows'][0];a=exit_point(row);h=row_heading(row)
        task={'id':'forward-only-test','rowOrder':[row['id']],'forwardSpeed':.08,'reverseSpeed':.06,'lateralSpeed':.05,'endWaitSeconds':2.}
        return Mission(config),field,task,Pose(a['x'],a['y'],h,.01),h

    def test_complete_existing_route_stops_without_negative_or_lateral_command(self):
        now=[100.]
        with patch('greenhouse_navigation.mission.time.monotonic',side_effect=lambda:now[0]):
            m,field,task,pose,h=self.harness();before=copy.deepcopy(field);old_task=copy.deepcopy(task)
            m.start(field,task,pose);states=set();fb={'seq':0,'speed':0.,'steering_gear':6,'body_gear':6,'steering_angle':0.,'angle_source':'existing_chassis'}
            for seq in range(2000):
                now[0]+=.05;fb.update(seq=seq,aggregate_received=now[0]);cmd=m.tick(pose,fb,[],[],.05);states.add(m.state)
                self.assertGreaterEqual(cmd.vx,0.);self.assertEqual(cmd.vy,0.)
                pose.x+=cmd.vx*.05*math.cos(h);pose.y+=cmd.vx*.05*math.sin(h);fb['speed']=abs(cmd.vx)
                if m.state=='FINISHED':break
            self.assertEqual(m.state,'FINISHED');self.assertFalse(m.running)
            self.assertIn('FORWARD',states);self.assertIn('ROW_END',states)
            self.assertNotIn('REVERSE',states);self.assertNotIn('LATERAL_SHIFT',states)
            target=field['rows'][0]['points'][-1]
            self.assertLessEqual(math.hypot(pose.x-target['x'],pose.y-target['y']),.031)
            for _ in range(50):self.assertEqual(m.tick(pose,fb,[],[],.05).vx,0.)
            self.assertEqual(field,before);self.assertEqual(task,old_task)

    def test_arrival_waits_for_real_stopped_feedback_before_completing(self):
        m,field,task,pose,h=self.harness();m.start(field,task,pose);m.state='ROW_END';m.entered=0.
        for seq in range(10):
            cmd=m.tick(pose,{'seq':seq,'speed':.03},[],[],.05)
            self.assertEqual(cmd.vx,0.);self.assertEqual(m.state,'ROW_END')
        for seq in range(10,15):m.tick(pose,{'seq':seq,'speed':0.},[],[],.05)
        self.assertEqual(m.state,'FINISHED');self.assertFalse(m.running)

    def test_real_fault_still_returns_zero_and_does_not_complete(self):
        m,field,task,pose,h=self.harness();m.start(field,task,pose);m.state='FORWARD'
        cmd=m.tick(pose,{'seq':1,'speed':0.},[],[{'label':'CAN','ready':False}],.05)
        self.assertEqual(cmd.vx,0.);self.assertEqual(m.state,'FAULT')

if __name__=='__main__':unittest.main(verbosity=2)
