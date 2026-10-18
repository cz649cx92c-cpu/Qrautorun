"""Physical send-health and command-failure regression; no hardware I/O."""
import unittest
from unittest.mock import Mock
import test_runtime_acceptance as runtime_fixtures
from greenhouse_navigation.node import GreenhouseNode
from greenhouse_navigation.control import Command

class NodeCanHealthTests(unittest.TestCase):
    def harness(self,state='ERROR-ACTIVE',ready=True):
        node=runtime_fixtures.RuntimeAcceptanceTests().harness()
        node.can_health=Mock();node.can_health.status.return_value={'ready':ready,'state':state,'reason':'','txPackets':0,'rxPackets':1000}
        return node

    def test_bus_off_blocks_send_even_when_ros_feedback_is_fresh(self):
        node=self.harness('BUS-OFF',False)
        self.assertFalse(GreenhouseNode.motion_feedback_ready(node))
        checks={row['id']:row for row in GreenhouseNode.conditions(node)}
        self.assertTrue(checks['feedback']['ready'])
        self.assertFalse(checks['can']['ready']);self.assertIn('BUS-OFF',checks['can']['label'])

    def test_healthy_link_preserves_existing_feedback_interlocks(self):
        node=self.harness()
        self.assertTrue(GreenhouseNode.motion_feedback_ready(node))
        self.assertTrue(next(row['ready'] for row in GreenhouseNode.conditions(node) if row['id']=='can'))
        node.feedback['remote_control']=True
        self.assertFalse(GreenhouseNode.motion_feedback_ready(node))

    def test_rejected_or_failed_sender_becomes_visible_fault(self):
        for failure in (None,RuntimeError('CAN write failed')):
            node=self.harness();node.engaged=True;node.motion.send.return_value=False
            if failure:node.motion.send.side_effect=failure
            GreenhouseNode.send(node,Command(vx=.01))
            self.assertFalse(node.engaged);self.assertEqual(node.mission.state,'FAULT')
            self.assertIn('底盘指令发送失败',node.mission.events[0]);node.motion.stop.assert_called_once()

    def test_bus_off_fault_is_not_replaced_by_rejected_stop_command(self):
        node=self.harness('BUS-OFF',False);node.engaged=True
        node.mission.fault('运行条件失效：CAN发送链路（BUS-OFF）')
        original=list(node.mission.events)
        node.motion.send.return_value=False
        GreenhouseNode.send(node,Command())
        self.assertFalse(node.engaged)
        self.assertEqual(node.mission.events,original)
        self.assertEqual(node.mission.state,'FAULT')
        node.motion.send.assert_not_called()
        node.motion.stop.assert_called_once()

    def test_faulted_mission_never_passes_a_nonzero_command_to_sender(self):
        node=self.harness();node.engaged=True
        node.mission.fault('定位失效')
        GreenhouseNode.send(node,Command(vx=.08))
        node.motion.send.assert_not_called()
        node.motion.stop.assert_called_once()
        self.assertFalse(node.engaged)
        self.assertIn('定位失效',node.mission.events[0])

    def test_can_failure_during_send_reports_bus_state(self):
        node=self.harness('BUS-OFF',False);node.engaged=True
        node.motion.send.return_value=False
        GreenhouseNode.send(node,Command(vx=.01))
        self.assertFalse(node.engaged)
        self.assertIn('CAN发送链路异常（BUS-OFF）',node.mission.events[0])
        node.motion.stop.assert_called_once()

if __name__=='__main__':unittest.main(verbosity=2)
