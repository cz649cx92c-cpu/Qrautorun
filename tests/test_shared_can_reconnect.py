"""Reconnect preflight policy; fake states only, no processes or hardware."""
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('shared_can_reconnect',Path(__file__).resolve().parents[1]/'scripts/reconnect_shared_can.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class SharedCanReconnectTests(unittest.TestCase):
    def test_active_task_and_gamepad_are_never_reconnected(self):
        for value in ({'task_status':'Hybrid Drive'},{'task_status':'Idle','gamepad_control':{'enabled':True}}):
            with self.assertRaises(RuntimeError):module.idle(value)

    def test_fresh_motion_or_manual_takeover_prevents_reconnect(self):
        for value in ({'motion':{'vx':float('nan')}},{'motion':{'vx':.03}},{'motion':{'vy':.03}},{'motion':{'wz':.2}},{'io':{'remote_control':True}}):
            with self.assertRaises(RuntimeError):module.idle({'task_status':'Idle','vehicle_status':{'feedback_fresh':True,**value}})

    def test_old_motion_cache_is_not_treated_as_current_motion(self):
        # Allows resetting a silent receive driver, but does not authorize motion.
        module.idle({'task_status':'Idle','vehicle_status':{'feedback_fresh':False,'motion':{'vx':-.4},'io':{'remote_control':True}}})

    def test_fresh_stationary_idle_is_allowed(self):
        module.idle({'task_status':'Idle','vehicle_status':{'feedback_fresh':True,'motion':{'vx':0.,'vy':0.,'wz':0.},'io':{'remote_control':False}}})


if __name__=='__main__':unittest.main()
