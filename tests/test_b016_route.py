import json
import math
import unittest
from pathlib import Path
from unittest.mock import patch
import test_forward_only as fixtures
from greenhouse_navigation.control import geometry,Pose
from greenhouse_navigation.mission import exit_point,row_heading

class B016RouteTests(fixtures.ForwardOnlyTests):
    def harness(self):
        m,old,task,pose,h=super().harness()
        root=Path(__file__).resolve().parents[1]
        field=json.loads((root/'tests/fixtures/office-b016.json').read_text())
        a=exit_point(field['rows'][0]);h=row_heading(field['rows'][0])
        task['id']=field['tags'][0]['rules'][0]['task']
        return m,field,task,Pose(a['x'],a['y'],h,.01),h

    def test_complete_existing_route_stops_without_negative_or_lateral_command(self):
        # This fixture now represents a curved office route, not a straight row.
        now=[100.]
        with patch('greenhouse_navigation.mission.time.monotonic',side_effect=lambda:now[0]):
            m,field,task,pose,h=self.harness();m.start(field,task,pose)
            fb={'seq':0,'speed':0.,'steering_gear':6,'body_gear':6,'steering_angle':0.,'angle_source':'existing_chassis'}
            tags={t['id']:t for t in field['tags']};near32=99.;continued_after32=False;states=set()
            for i in range(4000):
                now[0]+=.05;fb.update(seq=i,aggregate_received=now[0])
                distance32=math.hypot(pose.x-tags[32]['x'],pose.y-tags[32]['y'])
                near32=min(near32,distance32)
                obs=[{'id':k} for k,t in tags.items() if math.hypot(pose.x-t['x'],pose.y-t['y'])<.1]
                cmd=m.tick(pose,fb,obs,[],.05);states.add(m.state)
                self.assertNotEqual(m.state,'FAULT');self.assertGreaterEqual(cmd.vx,0.);self.assertEqual(cmd.vy,0.)
                self.assertLessEqual(abs(cmd.yaw_rate),.6*cmd.vx+1e-12)
                if pose.x>tags[32]['x']+.2 and m.running:continued_after32=True
                pose.x+=cmd.vx*.05*math.cos(pose.yaw);pose.y+=cmd.vx*.05*math.sin(pose.yaw)
                pose.yaw+=cmd.yaw_rate*.05;fb['speed']=cmd.vx
                if m.state=='FINISHED':break
            self.assertTrue(continued_after32);self.assertLess(near32,.03)
            self.assertEqual(m.state,'FINISHED');self.assertFalse(m.running)
            self.assertLess(math.hypot(pose.x-tags[16]['x'],pose.y-tags[16]['y']),.031)
            self.assertNotIn('REVERSE',states);self.assertNotIn('LATERAL_SHIFT',states)
            self.assertTrue(any('Q016 LOCALIZE' in e for e in m.events))
            self.assertEqual(m.tick(pose,fb,[],[],.05).vx,0.)

    def test_explicit_restart_on_curve_uses_local_path_heading(self):
        m,field,task,pose,h=self.harness()
        tag=next(t for t in field['tags'] if t['id']==32)
        pose.x=tag['x'];pose.y=tag['y']
        points=[exit_point(field['rows'][0])]+field['rows'][0]['points']
        pose.yaw=geometry(pose,points)[1]
        m.start(field,task,pose)
        self.assertEqual(m.state,'INITIALIZING');self.assertTrue(m.running)
        m.stop();tag=next(t for t in field['tags'] if t['id']==16)
        last=field['rows'][0]['points'][-2]
        theta=math.atan2(tag['y']-last['y'],tag['x']-last['x'])
        pose.x=tag['x']+.5*math.cos(theta);pose.y=tag['y']+.5*math.sin(theta);pose.yaw=theta
        with self.assertRaises(ValueError):m.start(field,task,pose)

    def test_b032_is_intermediate_not_route_end(self):
        m,field,task,pose,h=self.harness();m.start(field,task,pose);m.state='FORWARD'
        tag=next(t for t in field['tags'] if t['id']==32)
        pose.x=tag['x'];pose.y=tag['y'];pose.yaw=-.12
        cmd=m.tick(pose,{'seq':1,'speed':0.},[{'id':32}],[],.05)
        self.assertEqual(m.state,'FORWARD');self.assertTrue(m.running);self.assertGreater(cmd.vx,0.)

    def test_original_marker_coordinates_preserved_and_turn_is_feasible(self):
        m,field,task,pose,h=self.harness();root=Path(__file__).resolve().parents[1]
        old=json.loads((root/'tests/fixtures/office-straight.json').read_text())
        self.assertEqual([(t['id'],t['x'],t['y'],t['angle']) for t in field['tags']],[(t['id'],t['x'],t['y'],t['angle']) for t in old['tags']])
        row=field['rows'][0];points=[exit_point(row)]+row['points'];tag16=next(t for t in field['tags'] if t['id']==16)
        self.assertEqual(row['points'][-1],{'x':tag16['x'],'y':tag16['y']})
        self.assertEqual(tag16['rowId'],row['id']);self.assertEqual(tag16['kind'],'end')
        self.assertEqual(next(t for t in field['tags'] if t['id']==32)['kind'],'waypoint')
        for a,b in zip(points,points[1:]):
            mid=Pose((a['x']+b['x'])/2,(a['y']+b['y'])/2,0.)
            *_,curvature=geometry(mid,points,include_curvature=True)
            self.assertLess(abs(curvature),.6)

if __name__=='__main__':unittest.main(verbosity=2)
