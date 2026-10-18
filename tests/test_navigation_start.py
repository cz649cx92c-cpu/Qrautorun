"""Start admission regression, offline: no ROS construction or motion interface."""
import copy
import json
import math
from pathlib import Path
import sys
import unittest
import yaml
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.control import Pose
from greenhouse_navigation.mission import Mission,exit_point,row_heading

class NavigationStartTests(unittest.TestCase):
    def setUp(self):
        self.config=yaml.safe_load((ROOT/'config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters']
        self.config['qr_interval_navigation']=False
        self.field=json.loads((ROOT/'tests/fixtures/office-straight.json').read_text())
        self.field=self.field.get('map',self.field)
        self.row=self.field['rows'][0];self.origin=exit_point(self.row);self.heading=row_heading(self.row)
        self.task={'id':'offline-start','rowOrder':[self.row['id']],'forwardSpeed':.08,'reverseSpeed':.06,'lateralSpeed':.05,'endWaitSeconds':2}

    def pose(self,along=0.,cross=0.,yaw=0.):
        c,s=math.cos(self.heading),math.sin(self.heading)
        return Pose(self.origin['x']+along*c-cross*s,self.origin['y']+along*s+cross*c,self.heading+yaw,.01)

    def test_real_reported_pose_starts_with_explicit_test_tolerance(self):
        mission=Mission(self.config)
        mission.start(copy.deepcopy(self.field),copy.deepcopy(self.task),Pose(.0797568,-.0065153,-.0202685,.01))
        self.assertTrue(mission.running);self.assertEqual(mission.state,'INITIALIZING')

    def test_tolerance_is_configurable_and_default_remains_five_cm(self):
        mission=Mission({key:value for key,value in self.config.items() if key!='start_position_tolerance_m'})
        with self.assertRaisesRegex(ValueError,'允许 5 cm'):mission.start(self.field,self.task,self.pose(along=.08))
        mission=Mission(self.config)
        with self.assertRaisesRegex(ValueError,'允许 15 cm'):mission.start(self.field,self.task,self.pose(along=.16))
        self.assertFalse(mission.running)

    def test_wider_start_radius_keeps_cross_track_and_heading_checks(self):
        for pose,reason in ((self.pose(cross=.06),'侧偏'),(self.pose(yaw=.12),'航向偏差')):
            mission=Mission(self.config)
            with self.assertRaisesRegex(ValueError,reason):mission.start(self.field,self.task,pose)
            self.assertFalse(mission.running)

    def test_first_forward_tick_uses_acceleration_limit_after_real_feedback(self):
        mission=Mission(self.config);pose=self.pose(along=.08)
        mission.start(self.field,self.task,pose)
        feedback={'seq':0,'speed':0.,'angles':[0.]*4,'steering_gear':6}
        for seq in range(1,self.config['stable_feedback_samples']+1):
            feedback['seq']=seq
            command=mission.tick(pose,feedback,[],[],.05)
            self.assertEqual(command.vx,0.)
        self.assertEqual(mission.state,'FORWARD')
        command=mission.tick(pose,feedback,[],[],.05)
        self.assertGreater(command.vx,0.)
        self.assertLessEqual(command.vx,self.config['acceleration_mps2']*.05+1e-12)

class QrIntervalStartTests(unittest.TestCase):
    pose=NavigationStartTests.pose

    def setUp(self):
        NavigationStartTests.setUp(self)
        self.config['qr_interval_navigation']=True
        p=self.row['points'][-1]
        self.length=(p['x']-self.origin['x'])*math.cos(self.heading)+(p['y']-self.origin['y'])*math.sin(self.heading)
        self.middle=self.length/2

    def start(self,pose,field=None):
        mission=Mission(self.config)
        mission.start(copy.deepcopy(self.field if field is None else field),copy.deepcopy(self.task),pose)
        return mission

    def test_explicit_mid_row_start_keeps_initialization_and_selects_only_first_task_row(self):
        self.assertGreater(self.middle,self.config['start_position_tolerance_m'])
        mission=self.start(self.pose(along=self.middle,cross=.01,yaw=.02))
        self.assertTrue(mission.running)
        self.assertEqual(mission.state,'INITIALIZING')
        self.assertEqual(mission.row['id'],self.task['rowOrder'][0])
        self.assertEqual(mission.row_index,0)

    def test_original_start_tolerance_and_exact_last_point_are_accepted(self):
        for along in (-self.config['start_position_tolerance_m']*.9,0.,self.length):
            with self.subTest(along=along):self.assertTrue(self.start(self.pose(along=along)).running)

    def test_path_before_allowed_start_beyond_end_or_cross_track_is_rejected(self):
        for pose in (self.pose(along=-self.config['start_position_tolerance_m']-.01),
                     self.pose(along=self.length+.01),
                     self.pose(along=self.middle,cross=self.config['max_cross_track_m']+.01)):
            with self.subTest(pose=pose):
                with self.assertRaises(ValueError):self.start(pose)

    def test_other_row_reverse_heading_and_unreviewed_map_are_rejected(self):
        for pose in (self.pose(along=self.middle,cross=.5),self.pose(along=self.middle,yaw=math.pi),
                     self.pose(along=self.middle,yaw=.11)):
            with self.subTest(pose=pose):
                with self.assertRaises(ValueError):self.start(pose)
        unreviewed=copy.deepcopy(self.field);unreviewed['coordinateStatus']='draft'
        with self.assertRaisesRegex(ValueError,'现场坐标验收'):self.start(self.pose(along=self.middle),unreviewed)

    def test_non_straight_path_does_not_expand_original_start_area(self):
        bent=copy.deepcopy(self.field)
        row=next(r for r in bent['rows'] if r['id']==self.task['rowOrder'][0])
        point=copy.deepcopy(row['points'][-1]);point['x']-=math.sin(self.heading)*.2;point['y']+=math.cos(self.heading)*.2
        row['points'].append(point)
        with self.assertRaises(ValueError):self.start(self.pose(along=self.middle),bent)

    def test_rotated_row_uses_path_coordinates_instead_of_world_x(self):
        angle=.7;c,s=math.cos(angle),math.sin(angle)
        for point in self.row['points']:
            x,y=point['x'],point['y'];point.update(x=x*c-y*s,y=x*s+y*c)
        self.origin=exit_point(self.row);self.heading=row_heading(self.row)
        self.assertTrue(self.start(self.pose(along=self.middle,cross=.01,yaw=.02)).running)


if __name__=='__main__':unittest.main(verbosity=2)
