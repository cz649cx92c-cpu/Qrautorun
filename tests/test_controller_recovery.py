"""Stopped recovery of an interrupted sender, with no DDS or hardware."""
import unittest
from unittest.mock import Mock,patch
import test_runtime_acceptance as fixtures
from greenhouse_navigation.node import GreenhouseNode


class StoppedControllerRecoveryTests(unittest.TestCase):
    def harness(self):
        node=fixtures.RuntimeAcceptanceTests().harness()
        node.engaged=False;node.pending_start=None;node.mission.running=False
        node.feedback.update(speed=0.,vx=0.,vy_raw=0.,yaw_deg=0.,estop=False,remote_control=False,charge_state=False)
        node.received=100.;node.motion=Mock(suspended=True)
        node.motion.recover_after_stop.return_value=True
        return node

    def recover(self,node,now):
        with patch('greenhouse_navigation.node.time.monotonic',return_value=now):
            node.received=now
            return GreenhouseNode.recover_motion_after_stop(node,now)

    def test_stopped_safe_inputs_must_stay_stable_before_recovering_without_output(self):
        node=self.harness()
        self.assertFalse(self.recover(node,100.))
        self.assertFalse(self.recover(node,100.49))
        self.assertTrue(self.recover(node,100.51))
        node.motion.recover_after_stop.assert_called_once_with()
        node.motion.send.assert_not_called();node.motion.prepare.assert_not_called()
        self.assertFalse(node.engaged);self.assertFalse(node.mission.running)

    def test_running_pending_or_still_engaged_mission_never_rearms(self):
        for name in ('running','pending_start','engaged'):
            with self.subTest(name=name):
                node=self.harness()
                if name=='running':node.mission.running=True
                else:setattr(node,name,True)
                self.recover(node,100.);self.recover(node,101.)
                node.motion.recover_after_stop.assert_not_called()

    def test_manual_estop_charging_or_motion_prevents_recovery(self):
        for key,value in [('remote_control',True),('estop',True),('charge_state',True),('speed',.01),('vx',-.01),('vy_raw',.1),('yaw_deg',.5)]:
            with self.subTest(key=key):
                node=self.harness();node.feedback[key]=value
                self.recover(node,100.);self.recover(node,101.)
                node.motion.recover_after_stop.assert_not_called()

    def test_real_can_error_still_blocks_recovery(self):
        node=self.harness();node.can_health=Mock();node.can_health.status.return_value={'ready':False,'state':'BUS-OFF'}
        self.recover(node,100.);self.recover(node,101.)
        node.motion.recover_after_stop.assert_not_called()

    def test_old_feedback_never_rearms_and_interrupt_resets_stability_window(self):
        node=self.harness()
        self.recover(node,100.)
        with patch('greenhouse_navigation.node.time.monotonic',return_value=101.):
            self.assertFalse(GreenhouseNode.recover_motion_after_stop(node,101.))
        self.assertIsNone(node.motion_recovery_since)
        self.assertFalse(self.recover(node,101.1))
        self.assertFalse(self.recover(node,101.3))
        self.assertTrue(self.recover(node,101.7))

    def test_active_healthy_sender_is_not_reset(self):
        node=self.harness();node.motion.suspended=False
        self.assertFalse(self.recover(node,100.));node.motion.recover_after_stop.assert_not_called()


if __name__=='__main__':unittest.main(verbosity=2)
