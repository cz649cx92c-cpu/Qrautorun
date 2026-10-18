"""Use autorunlida's actual CommandSender and unchanged chassis protocol.

Preparation only discovers the shared bridge. The mature sender thread starts
on the first authorized command, after the navigation gates have been checked.
"""
import importlib
import importlib.util
import math
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

CONTROL_ROOT = Path('/home/orangepi/ugv/control')
AUTORUN_ROOT = Path('/home/orangepi/ugv/autorunlida')
COMMAND_TOPICS = ('/ctrl_cmd', '/steering_ctrl_cmd', '/io_cmd')


def load_existing_api():
    for root in (CONTROL_ROOT, AUTORUN_ROOT):
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))
    modules = {}
    for name, root in (('fw_mini_controller', CONTROL_ROOT),
                       ('official_fwmini_compat', CONTROL_ROOT),
                       ('plant_lidar_centerline_follower', AUTORUN_ROOT)):
        spec = importlib.util.find_spec(name)
        if spec is None or not spec.origin or Path(spec.origin).resolve() != root/(name+'.py'):
            raise RuntimeError('底盘接口来源不匹配：'+name)
        module = importlib.import_module(name)
        if Path(module.__file__).resolve() != root/(name+'.py'):
            raise RuntimeError('底盘接口来源不匹配：'+name)
        modules[name] = module
    api = modules['fw_mini_controller']
    sender = modules['plant_lidar_centerline_follower']
    return SimpleNamespace(
        FWMiniController=api.FWMiniController, BodyCommand=api.BodyCommand,
        SteeringCommand=api.SteeringCommand, IOCommand=api.IOCommand,
        get_bridge=api.get_bridge, CommandSender=sender.CommandSender,
        ControlState=sender.ControlState, sender_source=str(Path(sender.__file__).resolve()))


class ExistingMotionInterface:
    def __init__(self, enabled=False, loader=load_existing_api, publisher_snapshot=None,
                 node_snapshot=None, command_allowed=None, command_timeout_s=.25, body_velocity_crab=False):
        self.enabled = enabled
        self.body_velocity_crab = bool(body_velocity_crab)
        self.loader = loader
        self.publisher_snapshot = publisher_snapshot
        self.node_snapshot = node_snapshot
        self.command_allowed = command_allowed
        self.command_timeout_s = float(command_timeout_s)
        if not .05 <= self.command_timeout_s <= .6:
            raise ValueError('底盘指令时效参数无效')
        self.api = None
        self.controller = None
        self.bridge = None
        self.sender = None
        self.owner = None
        self.endpoint_gids = None
        self.closed = False
        self.closing = False
        self.suspended = False
        self.last_mode = '4t4d'
        self._sender_lock = threading.Lock()
        self._watch_stop = threading.Event()
        self._watch_thread = None

    def owns_publishers(self, publishers):
        return self._owns_publishers(publishers)

    def _owns_publishers(self, publishers, allow_suspended=False):
        if self.closed or (self.suspended and not allow_suspended) or any(topic not in publishers for topic in COMMAND_TOPICS):
            return False
        if self.owner is None:
            try:
                if self.node_snapshot is not None and any(
                        name == 'official_fwmini_compat_bridge'
                        for name, _namespace in self.node_snapshot()):
                    return False
            except Exception:
                return False
            return all(not publishers[topic] for topic in COMMAND_TOPICS)
        try:
            if self.bridge.node.get_node_names_and_namespaces().count(self.owner) != 1:
                return False
        except Exception:
            return False
        gids = {}
        for topic in COMMAND_TOPICS:
            endpoints = publishers[topic]
            if len(endpoints) != 1:
                return False
            endpoint = endpoints[0]
            if (endpoint.node_name, endpoint.node_namespace) != self.owner:
                return False
            gid = tuple(getattr(endpoint, 'endpoint_gid', ()) or ())
            if not gid or not any(gid):
                return False
            gids[topic] = gid
        if self.endpoint_gids is None:
            self.endpoint_gids = gids
        return gids == self.endpoint_gids

    def _publishers(self):
        try:
            if self.publisher_snapshot is not None:
                return self.publisher_snapshot()
            if self.bridge is not None:
                return {topic: self.bridge.node.get_publishers_info_by_topic(topic)
                        for topic in COMMAND_TOPICS}
        except Exception:
            return None
        return None

    def _command_ready(self):
        if not self.enabled or self.closed or self.suspended:
            return False
        try:
            if self.command_allowed is not None and not self.command_allowed():
                return False
            if not self.enabled or self.closed or self.suspended:
                return False
            publishers = self._publishers()
            return publishers is not None and self.owns_publishers(publishers)
        except Exception:
            return False

    def recover_after_stop(self):
        """Discard an exited sender after the caller confirms a stopped mission.

        This only permits a later explicit start. It sends no commands, does not
        restart the previous thread, and never reclaims another publisher's GID.
        The caller must check that its mission is stopped and no start is pending.
        """
        if not self.enabled or self.closed or self.closing:
            return False
        # Recovery needs positive proof of live CAN/feedback and released manual
        # control; an absent callback is insufficient to rearm a cancelled sender.
        def inputs_ready():
            try:
                return self.command_allowed is not None and bool(self.command_allowed())
            except Exception:
                return False
        if not inputs_ready():
            return False
        with self._sender_lock:
            if not self.enabled or self.closed or self.closing or not inputs_ready():
                return False
            if not self.suspended:
                return True
            if self.owner is None or self.bridge is None:
                return False
            sender_thread=getattr(self.sender,'_thread',None)
            if sender_thread is not None and sender_thread.is_alive():
                return False
            if self._watch_thread is not None and self._watch_thread.is_alive():
                return False
            publishers=self._publishers()
            if publishers is None or not self._owns_publishers(publishers,allow_suspended=True):
                return False
            if not inputs_ready():
                return False
            self.sender=None
            self._watch_thread=None
            self._watch_stop=threading.Event()
            self.suspended=False
            return True

    def prepare(self):
        """Create only the bridge, without starting the sender or unlocking."""
        if not self._command_ready():
            return False
        if self.controller is None:
            api = self.loader()
            if not self._command_ready():
                return False
            self.api = api
            self.controller = api.FWMiniController()
            self.bridge = api.get_bridge()
            self.owner = (self.bridge.node.get_name(), self.bridge.node.get_namespace())
            return False
        return True

    def send(self, command, state=''):
        if not self.enabled or self.closed or self.closing:
            return False
        if command.mode not in ('4t4d', 'crab') or not all(math.isfinite(v) for v in (
                command.vx, command.vy, command.yaw_rate, command.wheel_angle)):
            raise ValueError('无效底盘运动指令')
        if not self.prepare():
            return False
        body = self.api.BodyCommand(gear=command.mode, vx=float(command.vx),
                                    vy=float(command.vy), wz=float(command.yaw_rate))
        moving = any(abs(v) > 1e-6 for v in (command.vx, command.vy, command.yaw_rate))
        if state == 'SEGMENT_ALIGN' and moving:
            raise ValueError('区间轮角同步只允许零速指令')
        align = state in ('SEGMENT_ALIGN', 'INITIALIZING', 'SWITCH_TO_ACKERMANN', 'NEXT_ROW', 'SWITCH_TO_LATERAL')
        # Preserve the mature sender's initial/mode-change steering handshake.
        # The compatibility layer chooses protocol subtypes; this adapter only
        # passes the same mode/zero-speed steering state as the original app.
        # Body-velocity crab uses only its initial zero-angle gear handshake;
        # the mature sender/firmware owns wheel alignment from vx/vy.
        steering = (self.api.SteeringCommand(
            gear=command.mode, speed=0., angle=float(command.wheel_angle) if command.mode == 'crab' and not self.body_velocity_crab else 0.)
            if align or moving else None)
        io = self.api.IOCommand(brake=not moving)
        if not self._command_ready():
            return False
        with self._sender_lock:
            if not self._command_ready() or self.closing:
                return False
            self.last_mode = command.mode
            if self.sender is None:
                self.sender = self.api.CommandSender(
                    'socketcan', 'can0', 500000, period_s=.05,
                    initial_state=self.api.ControlState(body=body, steering=steering, io=io),
                    startup_unlock_cycles=8, command_timeout_s=self.command_timeout_s)
                self.sender.start()
                self._watch_thread = threading.Thread(target=self._watch_sender,
                    name='qr-mature-sender-ownership', daemon=True)
                self._watch_thread.start()
            else:
                self.sender.update(body, steering, io)
            if state == 'SEGMENT_ALIGN' and not (self.body_velocity_crab and command.mode=='crab'):
                # The mature sender synchronizes steering only on gear changes.
                # Adjacent crab intervals can change angle without changing gear.
                # At a measured stop, reuse its controller with zero-speed commands.
                if not self._command_ready():
                    return False
                self.controller.send_body(body)
                if not self._command_ready() or self.closing:
                    return False
                self.controller.send_steering(steering)
            if moving:
                self.sender.request_unlock()
            if self.sender._error is not None:
                raise RuntimeError('原工程底盘发送器已退出') from self.sender._error
        return not self.suspended

    def _watch_sender(self):
        """Release this sender if its exclusive ownership or live inputs fail.

        Cancellation uses the existing sender's stop event. Unlike its public
        stop() (which requests parking), cancellation must not send competing
        parking commands after a physical remote or another publisher takes over.
        No original class, method or module global is patched.
        """
        while not self._watch_stop.wait(.02):
            if self.closed or self.closing:
                return
            if not self._command_ready():
                self.suspended = True
                if self.sender is not None:
                    self.sender._stop.set()
                return

    def stop(self):
        """Feed zero to an existing sender; never creates or imports one."""
        if self.sender is None or not self._command_ready():
            return False
        self.sender.update(self.api.BodyCommand(gear=self.last_mode), None,
                           self.api.IOCommand(brake=True))
        return True

    def close(self):
        if self.closed:
            return
        self.closing = True
        self._watch_stop.set()
        if self._watch_thread is not None:
            self._watch_thread.join(timeout=.2)
        with self._sender_lock:
            try:
                if self.sender is not None:
                    if self._command_ready():
                        self.sender.update(self.api.BodyCommand(gear=self.last_mode), None,
                                           self.api.IOCommand(brake=True))
                        self.sender.stop()
                    else:
                        self.sender._stop.set()
                        if self.sender._thread is not None:
                            self.sender._thread.join(timeout=2.)
            finally:
                self.closed = True
                if self.controller is not None:
                    self.controller.close()
                self.owner = None
                self.endpoint_gids = None
