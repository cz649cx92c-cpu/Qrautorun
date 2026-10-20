"""Offline navigation-to-mature-controller integration; no ROS construction."""
import sys
import time
import queue
import unittest
import yaml
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace,MethodType
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/greenhouse_navigation'))
from greenhouse_navigation.node import GreenhouseNode
from greenhouse_navigation.control import Command,Pose
from greenhouse_navigation.mission import Mission
from yhs_can_interfaces.msg import ChassisInfoFb


class NodeMotionTests(unittest.TestCase):
    def feedback_harness(self):
        config=yaml.safe_load((Path(__file__).resolve().parents[1]/'config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters']
        config={**config,'existing_runtime_conditions_accepted':False}
        node=SimpleNamespace(config={**config,'existing_chassis_confirmed':True},seq=0,feedback=None,
            received=0.,ros_now=10.,mission=Mission(config))
        node.mission.target_angle=90.
        node.get_clock=lambda:SimpleNamespace(now=lambda:SimpleNamespace(nanoseconds=int(node.ros_now*1e9)))
        return node

    def aggregate_feedback(self,stamp=10.):
        msg=ChassisInfoFb();msg.header.stamp.sec=int(stamp);msg.header.stamp.nanosec=int(round((stamp-int(stamp))*1e9))
        msg.ctrl_fb.ctrl_fb_gear=8;msg.steering_ctrl_fb.steering_ctrl_fb_gear=7
        msg.steering_ctrl_fb.steering_ctrl_fb_steering=90.
        return msg

    def test_aggregate_steering_is_diagnostic_without_inventing_independent_frame_metadata(self):
        node=self.feedback_harness()
        for i in range(10):
            node.ros_now=10.+i*.01
            GreenhouseNode.feedback_cb(node,self.aggregate_feedback(node.ros_now))
            self.assertEqual(node.feedback['seq'],i+1)
            self.assertEqual(node.feedback['steering_angle'],90.)
            self.assertTrue(node.feedback['steering_aligned_diagnostic'])
            self.assertIsNone(node.feedback['steering_seq']);self.assertIsNone(node.feedback['steering_received'])
            self.assertFalse(node.feedback['steering_fresh']);self.assertFalse(node.feedback['lateral_aligned'])
            self.assertFalse(node.mission.stable_feedback(node.feedback,90.,(7,8)))
        self.assertEqual(node.mission.stable,0)
        self.assertFalse(node.feedback['field_freshness_verified'])

    def test_body_frame_cannot_refresh_previous_independent_steering_claim(self):
        node=self.feedback_harness()
        node.feedback={'steering_seq':42,'steering_received':time.monotonic(),'steering_fresh':True}
        GreenhouseNode.feedback_cb(node,self.aggregate_feedback())
        self.assertIsNone(node.feedback['steering_seq']);self.assertIsNone(node.feedback['steering_received'])
        self.assertFalse(node.feedback['steering_fresh'])

    def test_stale_or_future_aggregate_does_not_refresh_feedback(self):
        node=self.feedback_harness()
        for stamp in (9.,11.):GreenhouseNode.feedback_cb(node,self.aggregate_feedback(stamp))
        self.assertIsNone(node.feedback);self.assertEqual(node.seq,0);self.assertEqual(node.received,0.)

    def test_confirmed_chassis_preserves_independent_freshness_gate_and_execution_disabled(self):
        node=self.feedback_harness();GreenhouseNode.feedback_cb(node,self.aggregate_feedback())
        now=time.monotonic()
        node.motion=Mock();node.motion.owns_publishers.return_value=True
        node.get_publishers_info_by_topic=lambda topic:[]
        node.pose=Pose(0.,0.,0.,.01);node.pose_received=now;node.imu_received=now
        node.camera_received=now;node.tag_received=now
        conditions=GreenhouseNode.conditions(node);by_id={item['id']:item for item in conditions}
        self.assertTrue(by_id['feedback']['ready']);self.assertTrue(by_id['calibration']['ready'])
        self.assertFalse(by_id['freshness']['ready']);self.assertEqual(by_id['freshness']['label'],'四轮角与IO独立新鲜度验证')
        self.assertFalse(by_id['execution']['ready']);self.assertFalse(node.config['field_freshness_verified'])
        node.pending_start=None
        with self.assertRaisesRegex(ValueError,'四轮角与IO独立新鲜度验证'):
            GreenhouseNode.request_start(node,self.start_command(),conditions)
        node.motion.prepare.assert_not_called();node.motion.send.assert_not_called()

    def test_unlock_feedback_is_an_event_not_a_prerequisite_for_requesting_unlock(self):
        node=self.feedback_harness();msg=self.aggregate_feedback()
        msg.io_fb.io_fb_unlock=False
        GreenhouseNode.feedback_cb(node,msg)
        self.assertTrue(GreenhouseNode.motion_feedback_ready(node))
        for field in ('estop','remote_control','charge_state'):
            with self.subTest(field=field):
                node.feedback[field]=True
                self.assertFalse(GreenhouseNode.motion_feedback_ready(node))
                node.feedback[field]=False
        node.received=time.monotonic()-1.
        self.assertFalse(GreenhouseNode.motion_feedback_ready(node))

    def test_bms_charging_also_blocks_motion(self):
        node=self.feedback_harness();msg=self.aggregate_feedback()
        msg.io_fb.io_fb_charge_state=False
        msg.bms_flag_fb.bms_flag_fb_charge_flag=True
        GreenhouseNode.feedback_cb(node,msg)
        self.assertTrue(node.feedback['charge_state'])
        self.assertFalse(GreenhouseNode.motion_feedback_ready(node))

    def harness(self, directory):
        return SimpleNamespace(motion=Mock(), engaged=True,
            mission=SimpleNamespace(state='SWITCH_TO_LATERAL', running=True, paused=False),
            closed=Mock(), pid_file=Path(directory) / 'unused.pid',
            feedback={'remote_control': False}, received=time.monotonic(),
            config={'feedback_timeout_s': .3}, get_publishers_info_by_topic=lambda topic: [])

    def start_harness(self):
        node=SimpleNamespace(motion=Mock(), mission=Mock(running=False), engaged=False,
            pending_start=None, pending_start_at=0., acks=queue.Queue(), pose=object(), config={'maintenance_mode':False})
        node.cancel_pending_start=MethodType(GreenhouseNode.cancel_pending_start,node)
        return node

    def start_command(self):
        return {'id':'start-test','payload':{'map':{'id':'map'},'task':{'id':'task'}}}

    def test_discovery_delay_keeps_mission_idle_until_all_fresh_conditions_ready(self):
        node=self.start_harness();node.motion.prepare.return_value=False
        ready=[{'id':'ownership','label':'控制权','ready':True}]
        GreenhouseNode.request_start(node,self.start_command(),ready)
        self.assertIsNotNone(node.pending_start)
        node.mission.start.assert_not_called();node.motion.send.assert_not_called()
        GreenhouseNode.advance_pending_start(node,[{**ready[0],'ready':False}])
        node.mission.start.assert_not_called();self.assertFalse(node.engaged)
        node.motion.prepare.return_value=True
        GreenhouseNode.advance_pending_start(node,ready)
        node.mission.start.assert_called_once()
        self.assertIs(node.mission.start.call_args.args[2],node.pose)
        self.assertTrue(node.engaged);self.assertIsNone(node.pending_start)
        self.assertTrue(node.acks.get_nowait()['ok'])

    def test_pending_wait_never_waives_pose_or_feedback_conditions(self):
        for missing in ('pose','feedback','remote'):
            node=self.start_harness()
            GreenhouseNode.request_start(node,self.start_command(),[])
            GreenhouseNode.advance_pending_start(node,[{'id':missing,'label':missing,'ready':False}])
            node.mission.start.assert_not_called();node.motion.send.assert_not_called()
            self.assertIsNotNone(node.pending_start)

    def test_pending_start_timeout_acknowledges_failure_without_loading_again(self):
        node=self.start_harness()
        GreenhouseNode.request_start(node,self.start_command(),[])
        node.pending_start_at=time.monotonic()-4
        node.motion.prepare.reset_mock()
        GreenhouseNode.advance_pending_start(node,[])
        self.assertFalse(node.acks.get_nowait()['ok'])
        self.assertIsNone(node.pending_start)
        node.motion.prepare.assert_not_called();node.mission.start.assert_not_called()

    def test_stop_cancels_pending_start_and_cannot_auto_resume(self):
        node=self.start_harness()
        GreenhouseNode.request_start(node,self.start_command(),[])
        GreenhouseNode.cancel_pending_start(node,'停止')
        node.motion.prepare.return_value=True
        GreenhouseNode.advance_pending_start(node,[])
        node.mission.start.assert_not_called()
        self.assertFalse(node.acks.get_nowait()['ok'])

    def test_duplicate_pending_or_running_start_is_rejected(self):
        for running in (False,True):
            node=self.start_harness()
            node.mission.running=running
            if not running:node.pending_start=self.start_command()
            with self.assertRaises(ValueError):
                GreenhouseNode.request_start(node,self.start_command(),[])
            node.motion.prepare.assert_not_called()

    def test_read_only_rejects_before_preparing_controller(self):
        node=self.start_harness()
        with self.assertRaises(ValueError):
            GreenhouseNode.request_start(node,self.start_command(),[{'id':'execution','label':'执行','ready':False}])
        node.motion.prepare.assert_not_called()

    def test_segment_initial_stop_does_not_create_sender_or_change_gear(self):
        with TemporaryDirectory() as directory:
            node=self.harness(directory)
            node.mission.segment_executor=SimpleNamespace(phase='START_STOP')
            GreenhouseNode.send(node,Command())
            node.motion.send.assert_not_called()
            node.motion.stop.assert_called_once()

    def test_paused_or_stopped_task_never_requests_wheel_alignment(self):
        with TemporaryDirectory() as directory:
            node=self.harness(directory)
            node.mission.paused=True
            GreenhouseNode.send(node, Command(mode='crab', wheel_angle=90))
            self.assertEqual(node.motion.send.call_args.args[1], 'HOLD')
            node.mission.paused=False;node.mission.running=False
            GreenhouseNode.send(node, Command())
            self.assertEqual(node.motion.send.call_args.args[1], 'HOLD')

    def test_disengaged_does_not_send(self):
        with TemporaryDirectory() as directory:
            node=self.harness(directory);node.engaged=False
            GreenhouseNode.send(node, Command(vx=.1))
            node.motion.send.assert_not_called()

    def test_close_sends_body_zero_only_when_owned_fresh_and_not_manual(self):
        cases=[(True, False, False, True), (False, False, False, False),
               (True, True, False, False), (True, False, True, False)]
        for owner, manual, stale, expected in cases:
            with self.subTest(owner=owner, manual=manual, stale=stale), TemporaryDirectory() as directory:
                node=self.harness(directory)
                node.motion.owns_publishers.return_value=owner
                node.feedback['remote_control']=manual
                if stale:node.received=0.
                GreenhouseNode.close(node)
                self.assertEqual(node.motion.stop.called, expected)
                node.motion.send.assert_not_called()
                node.motion.close.assert_called_once()


if __name__ == '__main__':
    unittest.main(verbosity=2)
