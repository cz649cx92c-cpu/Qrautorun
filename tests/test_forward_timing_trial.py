"""Offline distance and interlock checks. Never imports ROS or controls hardware."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('forward_trial', Path(__file__).resolve().parents[1]/'scripts/forward_timing_trial.py')
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)

class ForwardTrialTests(unittest.TestCase):
    def state(self):
        return {'task_status':'Idle','can_status':'UP','vehicle_status':{
            'feedback_fresh':True,'feedback_age_ms':10,
            'io':{'estop':False,'remote_control':False,'charge_state':False},
            'battery':{'charging':False}},'gamepad_control':{'enabled':False}}

    def sample(self):
        return {'ageS':.01,'vx':.03,'vy':0.,'wzDps':0.,'wheels':[.03]*4,
                'estop':False,'remote':False,'charging':False}

    def test_cumulative_authorization_keeps_stopping_reserve(self):
        trial.validate_budget(.42,.026)
        for target,prior in [(.45,.026),(.5,0.),(-.01,0.),(.42,-.01),(float('nan'),0.)]:
            with self.assertRaises(ValueError):trial.validate_budget(target,prior)

    def test_distance_is_path_and_wheel_paths_are_not_added(self):
        guard=trial.DistanceGuard()
        for i in range(101):guard.observe(i*.1,.03,[.03]*4)
        self.assertAlmostEqual(guard.distance,.3)
        guard.observe(10.1,-.03,[-.03]*4)
        self.assertGreater(guard.distance,.3)

    def test_fastest_wheel_is_conservative(self):
        guard=trial.DistanceGuard()
        for i in range(101):guard.observe(i*.1,.02,[.03,.02,.02,.02])
        self.assertAlmostEqual(guard.distance,.3)
        self.assertAlmostEqual(guard.paths[0],.2)

    def test_gap_reversal_and_nan_fail_closed(self):
        for bad in [1.,-.1,float('nan')]:
            guard=trial.DistanceGuard();guard.observe(0.,0.,[0.]*4)
            with self.assertRaises(ValueError):guard.observe(bad,0.,[0.]*4)

    def test_charging_and_unknown_charge_are_blocked(self):
        for value in [True,None]:
            state=self.state();state['vehicle_status']['battery']['charging']=value
            with self.assertRaises(RuntimeError):trial.check_application(state)

    def test_busy_manual_estop_and_lease_loss_are_blocked(self):
        for key in ['estop','remote_control']:
            state=self.state();state['vehicle_status']['io'][key]=True
            with self.assertRaises(RuntimeError):trial.check_application(state)
        state=self.state();state['gamepad_control']['enabled']=True
        with self.assertRaises(RuntimeError):trial.check_application(state)
        with self.assertRaises(RuntimeError):trial.check_application(self.state(),'expected-owner')

    def test_feedback_loss_overspeed_and_reverse_are_blocked(self):
        with self.assertRaises(RuntimeError):trial.check_motion(self.sample(),.3)
        sample=self.sample();sample['contactOrDrop']=[True]
        with self.assertRaises(RuntimeError):trial.check_motion(sample,.01)
        for key,value in [('vx',.07),('vx',-.01),('vy',.02),('wzDps',10.)]:
            sample=self.sample();sample[key]=value
            with self.assertRaises(RuntimeError):trial.check_motion(sample,.01)

if __name__=='__main__':unittest.main()
