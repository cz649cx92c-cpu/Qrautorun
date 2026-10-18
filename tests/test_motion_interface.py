"""Run the original sender/controller with memory publishers, never ROS or CAN."""
import ast
import math
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
from greenhouse_navigation import motion_interface as module
from greenhouse_navigation.control import Command
from greenhouse_navigation.motion_interface import ExistingMotionInterface, COMMAND_TOPICS


def memory_api():
    control = Path('/home/orangepi/ugv/control')
    compat_path = control / 'official_fwmini_compat.py'
    tree = ast.parse(compat_path.read_text())
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef)
                 and n.name in ('gear_name_to_code', 'steering_gear_name_to_code')]
    bridge_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == '_CompatBridge')
    functions += [n for n in bridge_class.body if isinstance(n, ast.FunctionDef)
                  and n.name in ('publish_body', 'publish_steering', 'publish_io')]
    namespace = {'math': math, 'CtrlCmd': SimpleNamespace,
                 'SteeringCtrlCmd': SimpleNamespace, 'IoCmd': SimpleNamespace}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(compat_path), 'exec'), namespace)
    graph = {topic: [] for topic in COMMAND_TOPICS}
    nodes = []
    body, steering, io = [], [], []
    node = SimpleNamespace(
        get_name=lambda: 'official_fwmini_compat_bridge', get_namespace=lambda: '/',
        get_node_names_and_namespaces=lambda: list(nodes),
        get_publishers_info_by_topic=lambda topic: list(graph[topic]))
    bridge = SimpleNamespace(ctrl_pub=SimpleNamespace(publish=body.append),
                             steering_pub=SimpleNamespace(publish=steering.append),
                             io_pub=SimpleNamespace(publish=io.append),
                             _log_runtime=lambda message: None, node=node,
                             snapshot=lambda: {'_seq': 1, 'io': {'unlock_ok': False}})
    for name in ('publish_body', 'publish_steering', 'publish_io'):
        setattr(bridge, name, lambda *args, _name=name, **kwargs:
                namespace[_name](bridge, *args, **kwargs))

    def get_bridge():
        if not nodes:
            nodes.append(('official_fwmini_compat_bridge', '/'))
            for i, topic in enumerate(COMMAND_TOPICS):
                graph[topic] = [SimpleNamespace(
                    node_name='official_fwmini_compat_bridge', node_namespace='/',
                    endpoint_gid=[i + 1, 2, 3])]
        return bridge

    # Execute unchanged controller definitions; replace only the bridge import
    # with the memory transport. Production loads the original module directly.
    controller_path = control / 'fw_mini_controller.py'
    api_tree = ast.parse(controller_path.read_text())
    api_tree.body = [n for n in api_tree.body if not (isinstance(n, ast.ImportFrom)
                    and n.module == 'official_fwmini_compat')]
    api = {'get_bridge': get_bridge, '__name__': __name__}
    exec(compile(api_tree, str(controller_path), 'exec'), api)
    sender_path = module.AUTORUN_ROOT / 'plant_lidar_centerline_follower.py'
    sender_tree = ast.parse(sender_path.read_text())
    definitions = [n for n in sender_tree.body if isinstance(n, ast.ClassDef)
                   and n.name in ('ControlState', 'CommandSender')]
    api.update(threading=threading, print=lambda *args, **kwargs: None)
    future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
    sender_code = ast.fix_missing_locations(ast.Module(body=[future] + definitions, type_ignores=[]))
    exec(compile(sender_code, str(sender_path), 'exec'), api)
    return SimpleNamespace(**api, graph=graph, nodes=nodes), body, steering, io


class MotionInterfaceTests(unittest.TestCase):
    def wait_for(self, predicate, timeout=.7):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.005)
        self.assertTrue(predicate(), 'original sender did not reach the expected state')

    def unloaded(self, loader_hook=None, **options):
        api, body, steering, io = memory_api()
        def loader():
            if loader_hook:
                loader_hook(api)
            return api
        motion = ExistingMotionInterface(True, loader, lambda: api.graph,
                                         lambda: list(api.nodes), **options)
        self.addCleanup(motion.close)
        return motion, api, body, steering, io

    def harness(self, **options):
        motion, api, body, steering, io = self.unloaded(**options)
        self.assertFalse(motion.prepare())
        self.assertIsNone(motion.sender)
        self.assertEqual((body, steering, io), ([], [], []))
        self.assertTrue(motion.prepare())
        return motion, api, body, steering, io

    def test_read_only_never_loads_even_on_send_stop_and_close(self):
        motion = ExistingMotionInterface(False, lambda: self.fail('read-only loaded hardware API'))
        self.assertFalse(motion.prepare())
        self.assertFalse(motion.send(Command(vx=.1)))
        self.assertFalse(motion.stop())
        motion.close()
        self.assertIsNone(motion.controller)

    def test_prepare_creates_no_sender_body_steering_or_unlock(self):
        motion, api, body, steering, io = self.harness()
        for _ in range(3):
            self.assertTrue(motion.prepare())
        self.assertIsNone(motion.sender)
        self.assertFalse(motion.stop())
        self.assertEqual((body, steering, io), ([], [], []))

    def test_original_sender_heartbeat_unlock_and_single_yaw_conversion(self):
        motion, api, body, steering, io = self.harness()
        self.assertTrue(motion.send(Command(vx=.1, yaw_rate=.2), 'FORWARD'))
        self.assertIs(type(motion.sender), api.CommandSender)
        self.assertEqual((motion.sender.interface, motion.sender.channel, motion.sender.bitrate),
                         ('socketcan', 'can0', 500000))
        self.assertEqual(motion.sender.period_s, .05)
        self.wait_for(lambda: sum(abs(m.ctrl_cmd_x_linear-.1) < 1e-9 for m in body) >= 2)
        self.assertEqual(body[-1].ctrl_cmd_gear, 6)
        self.assertAlmostEqual(body[-1].ctrl_cmd_z_angular, math.degrees(.2))
        self.assertTrue(io[-1].io_cmd_unlock)
        self.assertFalse(io[-1].io_cmd_braking_lamp)
        # Match the original sender's one-time zero-speed steering synchronization.
        self.assertEqual(len(steering),1)
        self.assertEqual(steering[0].ctrl_cmd_gear,5)
        self.assertEqual(steering[0].steering_ctrl_cmd_velocity,0.)

    def test_initialization_preserves_complete_mature_zero_speed_handshake(self):
        motion, _, body, steering, io = self.harness()
        motion.send(Command(), 'INITIALIZING')
        self.wait_for(lambda: len(body)>=3 and bool(io))
        self.assertTrue(all(message.ctrl_cmd_gear==6 for message in body))
        self.assertTrue(all(message.ctrl_cmd_x_linear==0. for message in body))
        self.assertEqual(len(steering),1)
        self.assertEqual(steering[0].ctrl_cmd_gear,5)
        self.assertEqual(steering[0].steering_ctrl_cmd_velocity,0.)
        self.assertEqual(steering[0].steering_ctrl_cmd_steering,0.)
        self.assertIsNotNone(motion.sender._state.steering)
        self.assertTrue(any(message.io_cmd_unlock for message in io))

    def test_reverse_preserves_signed_velocity(self):
        motion, _, body, _, io = self.harness()
        motion.send(Command(vx=-.1, yaw_rate=-.02), 'REVERSE')
        self.wait_for(lambda: bool(io) and any(m.ctrl_cmd_x_linear < 0 for m in body))
        self.assertEqual(body[-1].ctrl_cmd_x_linear, -.1)
        self.assertAlmostEqual(body[-1].ctrl_cmd_z_angular, math.degrees(-.02))
        self.assertTrue(io[-1].io_cmd_unlock)

    def test_crab_uses_original_body_velocity_and_zero_speed_gear_sync(self):
        for sign in (-1, 1):
            motion, _, body, steering, io = self.harness()
            motion.send(Command(mode='crab', vy=sign*.06, wheel_angle=sign*90), 'LATERAL_SHIFT')
            self.wait_for(lambda: bool(io) and any(abs(m.ctrl_cmd_y_linear) > 0 for m in body))
            self.assertEqual(body[-1].ctrl_cmd_gear, 8)
            self.assertEqual(body[-1].ctrl_cmd_y_linear, sign*.06)
            self.assertEqual(len(steering), 1)
            self.assertEqual(steering[0].ctrl_cmd_gear, 7)
            self.assertEqual(steering[0].steering_ctrl_cmd_velocity, 0)
            self.assertEqual(steering[0].steering_ctrl_cmd_steering, sign*90)
            motion.close()

    def test_zero_speed_mode_alignment_and_mode_switch_use_original_sender(self):
        motion, _, body, steering, io = self.harness()
        motion.send(Command(mode='crab', wheel_angle=-90), 'SWITCH_TO_LATERAL')
        self.wait_for(lambda: bool(steering) and bool(io))
        self.assertEqual(steering[-1].ctrl_cmd_gear, 7)
        self.assertEqual(steering[-1].steering_ctrl_cmd_steering, -90)
        self.assertEqual(steering[-1].steering_ctrl_cmd_velocity, 0)
        count=len(steering)
        motion.send(Command(), 'SWITCH_TO_ACKERMANN')
        self.wait_for(lambda: body[-1].ctrl_cmd_gear == 6 and len(steering)>count)
        self.assertEqual(steering[-1].ctrl_cmd_gear,5)
        self.assertEqual(steering[-1].steering_ctrl_cmd_velocity,0.)
        self.assertEqual(steering[-1].steering_ctrl_cmd_steering,0.)
        self.assertEqual(body[-1].ctrl_cmd_x_linear, 0)
        self.assertTrue(io[-1].io_cmd_braking_lamp)

    def test_original_command_timeout_zeroes_stale_motion(self):
        motion, _, body, _, _ = self.harness(command_timeout_s=.08)
        motion.send(Command(vx=.04), 'FORWARD')
        self.wait_for(lambda: any(m.ctrl_cmd_x_linear == .04 for m in body))
        self.wait_for(lambda: motion.sender.feedback_snapshot()['_runtime']['command_stale'])
        self.assertEqual(body[-1].ctrl_cmd_x_linear, 0.)
        self.assertEqual(body[-1].ctrl_cmd_y_linear, 0.)
        self.assertEqual(body[-1].ctrl_cmd_z_angular, 0.)

    def test_stop_updates_original_sender_without_recreating_it(self):
        motion, _, body, _, io = self.harness()
        motion.send(Command(vx=.04), 'FORWARD')
        self.wait_for(lambda: any(m.ctrl_cmd_x_linear == .04 for m in body))
        sender = motion.sender
        self.assertTrue(motion.stop())
        self.wait_for(lambda: body[-1].ctrl_cmd_x_linear == 0.)
        self.assertIs(motion.sender, sender)
        self.assertTrue(io[-1].io_cmd_braking_lamp)

    def test_owned_close_uses_original_parking_and_stops_thread(self):
        motion, _, body, steering, _ = self.harness()
        motion.send(Command(vx=.04), 'FORWARD')
        self.wait_for(lambda: any(m.ctrl_cmd_x_linear == .04 for m in body))
        motion.close()
        self.assertFalse(motion.sender._thread.is_alive())
        self.assertTrue(motion.sender._stop_requested)
        self.assertEqual(body[-1].ctrl_cmd_gear, 2)
        self.assertEqual(body[-1].ctrl_cmd_x_linear, 0.)
        self.assertEqual(steering[-1].steering_ctrl_cmd_velocity, 0.)
        count = len(body)
        self.assertFalse(motion.send(Command(vx=.1)))
        motion.close()
        self.assertEqual(len(body), count)

    def test_external_takeover_cancels_original_loop_without_competing_parking(self):
        allowed = [True]
        motion, _, body, _, _ = self.harness(command_allowed=lambda: allowed[0])
        motion.send(Command(vx=.04), 'FORWARD')
        self.wait_for(lambda: any(m.ctrl_cmd_x_linear == .04 for m in body))
        allowed[0] = False
        self.wait_for(lambda: motion.suspended and not motion.sender._thread.is_alive())
        count = len(body)
        self.assertFalse(motion.sender._stop_requested)
        self.assertFalse(motion.send(Command(vx=.04)))
        motion.close()
        self.assertEqual(len(body), count)
        self.assertTrue(all(m.ctrl_cmd_gear == 6 for m in body))

    def test_duplicate_publisher_cancels_without_publishing_a_stop(self):
        motion, api, body, _, _ = self.harness()
        motion.send(Command(vx=.04), 'FORWARD')
        self.wait_for(lambda: any(m.ctrl_cmd_x_linear == .04 for m in body))
        api.graph['/ctrl_cmd'].append(SimpleNamespace(node_name='other', node_namespace='/', endpoint_gid=[9]))
        self.wait_for(lambda: motion.suspended and not motion.sender._thread.is_alive())
        count = len(body)
        motion.close()
        self.assertEqual(len(body), count)

    def test_invalid_command_does_not_load(self):
        for command in (Command(vx=float('nan')), Command(mode='unknown')):
            motion = ExistingMotionInterface(True, lambda: self.fail('invalid command loaded controller'))
            with self.assertRaises(ValueError):
                motion.send(command)

    def test_wrong_source_is_rejected_before_import(self):
        with patch.object(module.importlib.util, 'find_spec', return_value=SimpleNamespace(origin='/tmp/fw_mini_controller.py')), patch.object(module.importlib, 'import_module') as importing:
            with self.assertRaises(RuntimeError):
                module.load_existing_api()
            importing.assert_not_called()

    def test_missing_gid_or_replaced_endpoint_rejects(self):
        for change in ('missing', 'replaced'):
            motion, api, body, _, _ = self.harness()
            if change == 'missing':
                del api.graph['/ctrl_cmd'][0].endpoint_gid
            else:
                api.graph['/ctrl_cmd'][0].endpoint_gid = [8, 9, 10]
            self.assertFalse(motion.send(Command(vx=.1)))
            self.assertIsNone(motion.sender)
            self.assertEqual(body, [])

    def test_graph_failure_rejects_zero_and_motion(self):
        motion, _, body, _, _ = self.harness()
        def failing():
            raise RuntimeError('ROS graph unavailable')
        motion.publisher_snapshot = failing
        self.assertFalse(motion.send(Command(vx=.1)))
        self.assertFalse(motion.stop())
        self.assertEqual(body, [])

    def test_no_graph_reader_cannot_load(self):
        motion = ExistingMotionInterface(True, lambda: self.fail('unverified controller loaded'))
        self.assertFalse(motion.send(Command()))

    def test_existing_bridge_prevents_loading_even_before_publishers_discovered(self):
        for discovered in (False, True):
            motion, api, body, _, _ = self.unloaded()
            if discovered:
                api.get_bridge()
            else:
                api.nodes.append(('official_fwmini_compat_bridge', '/'))
            self.assertFalse(motion.prepare())
            self.assertIsNone(motion.controller)
            self.assertEqual(body, [])

    def test_publisher_appearing_during_import_prevents_constructor(self):
        motion, _, body, _, _ = self.unloaded(lambda api: api.get_bridge())
        self.assertFalse(motion.prepare())
        self.assertIsNone(motion.controller)
        self.assertEqual(body, [])

    def test_live_interlock_is_rechecked_after_constructing_command(self):
        allowed = [True]
        motion, api, body, _, _ = self.harness(command_allowed=lambda: allowed[0])
        original_body = api.BodyCommand
        def body_constructor(**kwargs):
            allowed[0] = False
            return original_body(**kwargs)
        api.BodyCommand = body_constructor
        self.assertFalse(motion.send(Command(vx=.04)))
        self.assertIsNone(motion.sender)
        self.assertEqual(body, [])


    def test_same_crab_gear_new_interval_resynchronizes_angle_at_zero_speed(self):
        motion,_,body,steering,_=self.harness()
        motion.send(Command(mode='crab',wheel_angle=90.),'SEGMENT_ALIGN')
        self.wait_for(lambda:bool(body) and bool(steering))
        count=len(steering)
        motion.send(Command(mode='crab',wheel_angle=45.),'SEGMENT_ALIGN')
        self.assertGreater(len(steering),count)
        self.assertEqual(steering[-1].steering_ctrl_cmd_steering,45.)
        self.assertEqual(steering[-1].steering_ctrl_cmd_velocity,0.)
        self.assertEqual(body[-1].ctrl_cmd_gear,8)
        self.assertTrue(all(m.ctrl_cmd_x_linear==0 and m.ctrl_cmd_y_linear==0 for m in body))
        count=len(steering)
        with self.assertRaises(ValueError):motion.send(Command(mode='crab',vy=.1,wheel_angle=45.),'SEGMENT_ALIGN')
        self.assertEqual(len(steering),count)


class SenderRecoveryTests(unittest.TestCase):
    """A released hand controller permits a new explicit start, never a resume."""
    wait_for=MotionInterfaceTests.wait_for
    unloaded=MotionInterfaceTests.unloaded
    harness=MotionInterfaceTests.harness
    def cancelled(self):
        allowed=[True]
        motion,api,body,steering,io=self.harness(command_allowed=lambda:allowed[0])
        self.assertTrue(motion.send(Command(vx=.04),'FORWARD'))
        self.wait_for(lambda:any(m.ctrl_cmd_x_linear==.04 for m in body))
        old=motion.sender
        allowed[0]=False
        self.wait_for(lambda:motion.suspended and not old._thread.is_alive()
                      and not motion._watch_thread.is_alive())
        return motion,api,body,steering,io,allowed,old

    def test_recovery_sends_nothing_and_next_explicit_start_creates_new_sender(self):
        motion,api,body,steering,io,allowed,old=self.cancelled()
        owner=motion.owner;gids=dict(motion.endpoint_gids);bridge=motion.bridge
        allowed[0]=True
        count=(len(body),len(steering),len(io))
        self.assertTrue(motion.recover_after_stop())
        self.assertFalse(motion.suspended)
        self.assertIsNone(motion.sender)
        self.assertIs(motion.bridge,bridge)
        self.assertEqual(motion.owner,owner)
        self.assertEqual(motion.endpoint_gids,gids)
        self.assertTrue(motion.owns_publishers(api.graph))
        self.assertTrue(motion.prepare())
        time.sleep(.07)
        self.assertEqual((len(body),len(steering),len(io)),count)
        self.assertFalse(old._thread.is_alive())
        self.assertTrue(motion.send(Command(vx=.02),'FORWARD'))
        self.assertIsNot(motion.sender,old)
        self.wait_for(lambda:any(m.ctrl_cmd_x_linear==.02 for m in body))

    def test_manual_or_can_interlock_still_blocks_recovery(self):
        motion,_,body,_,_,allowed,old=self.cancelled()
        count=len(body)
        self.assertFalse(motion.recover_after_stop())
        self.assertTrue(motion.suspended)
        self.assertIs(motion.sender,old)
        allowed[0]=True
        self.assertTrue(motion.recover_after_stop())
        self.assertEqual(len(body),count)

    def test_real_external_publisher_still_blocks_recovery(self):
        motion,api,body,_,_,allowed,old=self.cancelled()
        allowed[0]=True
        count=len(body)
        api.graph['/ctrl_cmd'].append(SimpleNamespace(node_name='other',node_namespace='/',endpoint_gid=[99]))
        self.assertFalse(motion.recover_after_stop())
        self.assertTrue(motion.suspended)
        self.assertIs(motion.sender,old)
        api.graph['/ctrl_cmd'].pop()
        self.assertTrue(motion.recover_after_stop())
        self.assertEqual(len(body),count)

    def test_replaced_gid_or_duplicate_owner_never_reclaims_control(self):
        for change in ('gid','duplicate_node'):
            with self.subTest(change=change):
                motion,api,body,_,_,allowed,old=self.cancelled()
                allowed[0]=True
                count=len(body)
                if change=='gid':api.graph['/ctrl_cmd'][0].endpoint_gid=[99]
                else:api.nodes.append(motion.owner)
                self.assertFalse(motion.recover_after_stop())
                self.assertTrue(motion.suspended)
                self.assertIs(motion.sender,old)
                self.assertEqual(len(body),count)

    def test_alive_sender_or_watcher_cannot_be_discarded(self):
        for active in ('sender','watcher'):
            with self.subTest(active=active):
                motion,_,body,_,_=self.harness(command_allowed=lambda:True)
                motion.suspended=True
                motion.sender=SimpleNamespace(_thread=SimpleNamespace(is_alive=lambda:active=='sender'))
                motion._watch_thread=SimpleNamespace(is_alive=lambda:active=='watcher')
                try:
                    self.assertFalse(motion.recover_after_stop())
                    self.assertTrue(motion.suspended)
                    self.assertEqual(body,[])
                finally:
                    motion.sender=None;motion._watch_thread=None

    def test_recovery_is_explicit_and_never_happens_during_prepare_or_send(self):
        motion,api,body,_,_,allowed,old=self.cancelled()
        allowed[0]=True
        count=len(body)
        self.assertFalse(motion.owns_publishers(api.graph))
        self.assertFalse(motion.prepare())
        self.assertFalse(motion.send(Command(vx=.03),'FORWARD'))
        self.assertTrue(motion.suspended)
        self.assertIs(motion.sender,old)
        self.assertEqual(len(body),count)

    def test_recovery_without_cancellation_keeps_active_sender(self):
        motion,_,body,_,_=self.harness(command_allowed=lambda:True)
        self.assertTrue(motion.send(Command(vx=.01),'FORWARD'))
        old=motion.sender
        self.assertTrue(motion.recover_after_stop())
        self.assertIs(motion.sender,old)
        self.assertTrue(old._thread.is_alive())

    def test_closed_disabled_or_unverifiable_inputs_cannot_recover(self):
        for mode in ('closed','disabled','no_callback','exception'):
            with self.subTest(mode=mode):
                motion,_,body,_,_,allowed,_=self.cancelled()
                allowed[0]=True
                if mode=='closed':motion.closed=True
                elif mode=='disabled':motion.enabled=False
                elif mode=='no_callback':motion.command_allowed=None
                else:
                    def failed():raise RuntimeError('feedback unavailable')
                    motion.command_allowed=failed
                count=len(body)
                self.assertFalse(motion.recover_after_stop())
                self.assertTrue(motion.suspended)
                self.assertEqual(len(body),count)


if __name__ == '__main__':
    unittest.main(verbosity=2)
