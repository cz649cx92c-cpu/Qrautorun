"""Offline independent-frame fixtures; never hardware measurements or timestamps."""
import math
import sys
import time
import unittest
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.mission import Mission
from greenhouse_navigation.control import Pose


class ExistingChassisFeedbackTests(unittest.TestCase):
    def mission(self):
        config=yaml.safe_load((ROOT/'config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters']
        return Mission({**config,'existing_chassis_confirmed':True,'existing_runtime_conditions_accepted':False})

    def independent_feedback(self,target=90.,gear=7):
        return {'seq':1,'speed':0.,'angles':None,'steering_angle':target,
                'angle_source':'existing_chassis','steering_gear':gear,'body_gear':8 if gear==7 else 6,
                'steering_seq':1,'steering_fresh':True,'steering_received':time.monotonic()}

    def test_stopped_mode_switch_uses_real_mature_steering_feedback(self):
        for target,gear in ((0.,5),(90.,7),(-90.,7)):
            mission=self.mission()
            fb=self.independent_feedback(target,gear)
            for seq in range(1,6):
                fb['steering_seq']=seq;ready=mission.stable_feedback(fb,target,(gear,))
            self.assertTrue(ready)

    def test_missing_or_wrong_canonical_angle_does_not_assert_wheel_alignment(self):
        for angle in (None,float('nan'),0.):
            mission=self.mission()
            fb=self.independent_feedback();fb['steering_angle']=angle
            for seq in range(1,8):
                fb['steering_seq']=seq;self.assertFalse(mission.stable_feedback(fb,90.,(7,)))

    def test_trusting_motion_does_not_skip_stopping_or_fresh_samples(self):
        mission=self.mission()
        fb=self.independent_feedback();fb['speed']=.1
        for seq in range(1,8):
            fb['steering_seq']=seq;self.assertFalse(mission.stable_feedback(fb,90.,(7,)))
        fb.update(speed=0.,steering_seq=8)
        for _ in range(10):self.assertFalse(mission.stable_feedback(fb,90.,(7,)))

    def test_body_arrivals_cannot_count_cached_steering_without_independent_sequence(self):
        mission=self.mission();fb=self.independent_feedback()
        for key in ('steering_seq','steering_received','steering_fresh'):fb.pop(key)
        for seq in range(1,25):
            fb['seq']=seq;self.assertFalse(mission.stable_feedback(fb,90.,(7,8)))
        self.assertEqual(mission.stable,0)

    def test_body_sequence_does_not_advance_count_when_steering_sequence_repeats(self):
        mission=self.mission();fb=self.independent_feedback()
        for seq in range(1,25):
            fb['seq']=seq;self.assertFalse(mission.stable_feedback(fb,90.,(7,8)))
        self.assertEqual(mission.stable,1)

    def test_invalid_sequence_freshness_and_receive_time_cannot_count_alignment(self):
        invalid=[('steering_seq',None),('steering_seq',True),('steering_seq',-1),('steering_seq',1.5),
                 ('steering_fresh',False),('steering_fresh',1),('steering_received',None),
                 ('steering_received',math.nan),('steering_received',time.monotonic()-1.),
                 ('steering_received',time.monotonic()+10.),('steering_angle',math.inf),
                 ('steering_angle',True),('body_gear',6),('steering_gear',8)]
        for key,value in invalid:
            with self.subTest(key=key,value=value):
                mission=self.mission();fb={**self.independent_feedback(),key:value}
                for body_seq in range(1,8):
                    fb['seq']=body_seq;self.assertFalse(mission.stable_feedback(fb,90.,(7,8)))
                self.assertEqual(mission.stable,0)

    def test_duplicate_previously_aligned_frame_rechecks_expiry_motion_and_modes(self):
        for changed in ({'steering_received':time.monotonic()-1.},{'steering_fresh':False},
                        {'steering_angle':0.},{'body_gear':6},{'steering_gear':8},
                        {'speed':.1},{'speed':math.nan}):
            with self.subTest(changed=changed):
                mission=self.mission();fb=self.independent_feedback()
                for seq in range(1,6):fb['steering_seq']=seq;ready=mission.stable_feedback(fb,90.,(7,8))
                self.assertTrue(ready);fb.update(changed)
                self.assertFalse(mission.stable_feedback(fb,90.,(7,8)));self.assertEqual(mission.stable,0)

    def test_steering_sequence_rewind_resets_count_and_cannot_replay_old_frame(self):
        mission=self.mission();fb=self.independent_feedback()
        for seq in range(10,15):fb['steering_seq']=seq;ready=mission.stable_feedback(fb,90.,(7,8))
        self.assertTrue(ready)
        fb['steering_seq']=13;self.assertFalse(mission.stable_feedback(fb,90.,(7,8)))
        fb['steering_seq']=14;self.assertFalse(mission.stable_feedback(fb,90.,(7,8)))
        self.assertEqual(mission.stable,0)

    def lateral_mission(self):
        mission=self.mission()
        mission.field={'rows':[{'id':'a','name':'a','points':[{'x':0.,'y':0.},{'x':2.,'y':0.}],'width':.6,'exitDistance':.8},
                               {'id':'b','name':'b','points':[{'x':0.,'y':1.},{'x':2.,'y':1.}],'width':.6,'exitDistance':.8}],
                       'tags':[],'vehicle':{'width':.4,'length':.8,'margin':.05},
                       'zone':[{'x':-2.,'y':-2.},{'x':2.,'y':-2.},{'x':2.,'y':2.},{'x':-2.,'y':2.}]}
        mission.task={'id':'offline','rowOrder':['a','b'],'lateralSpeed':.06}
        mission.running=True;mission.state='LATERAL_SHIFT';mission.mode='crab';mission.target_angle=90.
        return mission

    def test_lateral_running_requires_exact_body_and_steering_gears_and_fresh_angle(self):
        invalid=[{'body_gear':6},{'body_gear':None},{'steering_gear':8},{'steering_gear':5},
                 {'steering_angle':0.},{'steering_angle':math.nan},{'steering_fresh':False},
                 {'steering_seq':None},{'steering_received':None},{'steering_received':time.monotonic()-1.}]
        for changed in invalid:
            with self.subTest(changed=changed):
                mission=self.lateral_mission();fb={**self.independent_feedback(),'lateral_aligned':True,**changed}
                cmd=mission.tick(Pose(-.8,.25,0.,.01),fb,[],[],.05)
                self.assertEqual(mission.state,'FAULT');self.assertFalse(mission.running)
                self.assertEqual((cmd.vx,cmd.vy,cmd.yaw_rate),(0.,0.,0.))

    def test_lateral_checks_remain_active_while_paused_waiting_or_at_endpoint(self):
        for state in ('paused','waiting','endpoint'):
            with self.subTest(state=state):
                mission=self.lateral_mission()
                if state=='paused':mission.paused=True
                if state=='waiting':mission.wait_until=time.monotonic()+10.
                pose=Pose(-.8,1. if state=='endpoint' else .25,0.,.01)
                cmd=mission.tick(pose,{**self.independent_feedback(),'body_gear':6},[],[],.05)
                self.assertEqual(mission.state,'FAULT');self.assertEqual(cmd.vy,0.)

    def test_lateral_offline_valid_independent_feedback_permits_tracker_command(self):
        mission=self.lateral_mission()
        cmd=mission.tick(Pose(-.8,.25,0.,.01),self.independent_feedback(),[],[],.05)
        self.assertEqual(mission.state,'LATERAL_SHIFT');self.assertGreater(cmd.vy,0.)

    def test_stop_only_confirmation_uses_body_samples_without_claiming_steering_alignment(self):
        mission=self.mission();fb={'speed':0.,'angle_source':'existing_chassis'}
        for seq in range(1,6):fb['seq']=seq;ready=mission.stable_feedback(fb)
        self.assertTrue(ready)


if __name__=='__main__':
    unittest.main(verbosity=2)
