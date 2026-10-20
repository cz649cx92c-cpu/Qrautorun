#!/usr/bin/env python3
"""One authorized bounded forward trial through the existing web control lease.

Default is passive preflight. --execute is required for motion. This never
creates a chassis publisher, starts full navigation, or changes acceptance.
"""
import argparse
import collections
import json
import math
import os
from pathlib import Path
import signal
import threading
import time
import uuid
from urllib.request import Request, ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]
CONTROL_TOPICS = ('/ctrl_cmd', '/steering_ctrl_cmd', '/io_cmd')
EXPECTED_OWNER = 'official_fwmini_compat_bridge'


def check_application(data, client_id=None):
    if data.get('task_status') != 'Idle' or data.get('can_status') != 'UP':
        raise RuntimeError('Original application is busy or CAN unavailable')
    feedback = data.get('vehicle_status', {})
    if feedback.get('feedback_fresh') is not True or feedback.get('feedback_age_ms', 10000) > 200:
        raise RuntimeError('Original feedback is stale')
    io = feedback.get('io', {})
    if io.get('estop') is not False or io.get('remote_control') is not False:
        raise RuntimeError('Emergency stop or physical remote control')
    if io.get('charge_state') is not False or feedback.get('battery', {}).get('charging') is not False:
        raise RuntimeError('Charging is active or unknown')
    gamepad = data.get('gamepad_control', {})
    if client_id:
        if not gamepad.get('enabled') or gamepad.get('owner_client_id') != client_id:
            raise RuntimeError('Control lease lost')
    elif gamepad.get('enabled'):
        raise RuntimeError('Existing browser control is in use')


def check_motion(sample, received_age):
    if not sample or not 0 <= received_age <= .20 or not 0 <= sample['ageS'] <= .20:
        raise RuntimeError('ROS chassis feedback lost or stale')
    if sample['estop'] or sample['remote'] or sample['charging'] or any(sample.get('contactOrDrop', [])):
        raise RuntimeError('Emergency stop, manual takeover, charging or collision/drop sensor')
    numbers = [sample['vx'], sample['vy'], sample['wzDps'], *sample['wheels']]
    if not all(math.isfinite(v) for v in numbers):
        raise RuntimeError('Invalid feedback')
    if max(abs(sample['vx']), *(abs(v) for v in sample['wheels'])) > .06:
        raise RuntimeError('Speed exceeds experiment limit')
    if sample['vx'] < -.005 or abs(sample['vy']) > .008 or abs(sample['wzDps']) > 5.:
        raise RuntimeError('Motion is not straight forward')


class DistanceGuard:
    """Independent absolute body/wheel path integrals; never sum wheel paths."""
    def __init__(self):
        self.previous = None
        self.paths = [0.] * 5
        self.max_gap = 0.

    @property
    def distance(self):
        return max(self.paths)

    def observe(self, stamp, vx, wheels):
        speeds = [abs(vx), *(abs(v) for v in wheels)]
        if len(speeds) != 5 or not math.isfinite(stamp) or not all(math.isfinite(v) for v in speeds):
            raise ValueError('Invalid integration sample')
        if self.previous:
            old_stamp, old_speeds = self.previous
            dt = stamp - old_stamp
            if dt <= 0 or dt > .20:
                raise ValueError('Feedback clock discontinuity or gap')
            self.max_gap = max(self.max_gap, dt)
            for i, (a, b) in enumerate(zip(old_speeds, speeds)):
                self.paths[i] += .5 * (a + b) * dt
        self.previous = (stamp, speeds)


def validate_budget(target, prior):
    if not (math.isfinite(target) and math.isfinite(prior) and .005 <= target <= .45
            and 0 <= prior and prior + target + .04 <= .50):
        raise ValueError('Cumulative travel plus stopping reserve exceeds authorization')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--target-m', type=float, default=.45)
    parser.add_argument('--prior-travel-m', type=float, default=0.)
    parser.add_argument('--output', type=Path, default=ROOT/'logs/forward-50cm-timing-20261015.json')
    args = parser.parse_args()
    validate_budget(args.target_m, args.prior_travel_m)
    os.environ.setdefault('ROS_LOG_DIR', str(ROOT/'logs/ros'))
    import rclpy
    from rclpy.qos import qos_profile_sensor_data
    from sensor_msgs.msg import Imu
    from nav_msgs.msg import Odometry
    from std_msgs.msg import String
    from yhs_can_interfaces.msg import ChassisInfoFb

    opener = build_opener(ProxyHandler({}))
    def api(path, body=None, timeout=.3, port=8765):
        request = Request(f'http://127.0.0.1:{port}{path}',
                          data=None if body is None else json.dumps(body).encode(),
                          headers={'Content-Type': 'application/json'})
        with opener.open(request, timeout=timeout) as response:
            return json.load(response)

    rclpy.init()
    node = rclpy.create_node('qr_authorized_forward_timing_trial')
    lock = threading.Lock()
    raw = collections.defaultdict(list)
    latest = {}
    guard = DistanceGuard()
    shared = {'integrating': False, 'distance': 0., 'fault': None, 'epoch': None,
              'baseline_epoch': None, 'phase': 'BASELINE', 'owner_check': 0.}
    report = {'operatorAuthorization': '你现在进行时间同步 你可以往前走50cm 你试一下',
              'authorizedMaximumM': .5, 'plannedStopM': args.target_m, 'priorTravelM': args.prior_travel_m,
              'stoppingReserveM': .04, 'plannedSpeedMps': .03,
              'singleTrial': True, 'noAutomaticRetry': True, 'executeRequested': args.execute,
              'startedAt': time.time(), 'sourceModified': False,
              'globalNavigationExecutionEnabled': False, 'events': [], 'commandRequests': [],
              'unlockSemantics': 'Safety-parking unlock event, not persistent drive enable',
              'unlockProtocolSource': '/home/orangepi/ugv/FW-mini用户使用手册V1.0.4.pdf, printed page 36',
              'previousPreparationReport': 'logs/forward-50cm-preparation-attempt-20261015.json'}
    client_id = 'qr-timing-' + uuid.uuid4().hex
    lease = False
    executor_done = threading.Event()
    def event(text):
        entry = {'at': time.time(), 'text': text}
        report['events'].append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)
    def now_ros(): return node.get_clock().now().nanoseconds / 1e9
    def stamp(msg): return msg.header.stamp.sec + msg.header.stamp.nanosec / 1e9
    def feedback(msg):
        t = stamp(msg)
        c = msg.ctrl_fb
        sample = {'stamp': t, 'receivedAt': time.time(), 'receivedMono': time.monotonic(),
                  'ageS': now_ros()-t, 'vx': float(c.ctrl_fb_x_linear),
                  'vy': float(c.ctrl_fb_y_linear)*.1, 'wzDps': float(c.ctrl_fb_z_angular),
                  'wheels': [float(v) for v in (msg.lf_wheel_fb.lf_wheel_fb_velocity,
                      msg.rf_wheel_fb.rf_wheel_fb_velocity, msg.lr_wheel_fb.lr_wheel_fb_velocity,
                      msg.rr_wheel_fb.rr_wheel_fb_velocity)],
                  'bodyGear': int(c.ctrl_fb_gear),
                  'steeringGear': int(msg.steering_ctrl_fb.steering_ctrl_fb_gear),
                  'steeringDeg': float(msg.steering_ctrl_fb.steering_ctrl_fb_steering),
                  'contactOrDrop': [bool(getattr(msg.io_fb, name)) for name in (
                      'io_fb_fl_impact_sensor', 'io_fb_fm_impact_sensor', 'io_fb_fr_impact_sensor',
                      'io_fb_rl_impact_sensor', 'io_fb_rm_impact_sensor', 'io_fb_rr_impact_sensor',
                      'io_fb_fl_drop_sensor', 'io_fb_fm_drop_sensor', 'io_fb_fr_drop_sensor',
                      'io_fb_rl_drop_sensor', 'io_fb_rm_drop_sensor', 'io_fb_rr_drop_sensor')],
                  'unlock': bool(msg.io_fb.io_fb_unlock), 'estop': bool(msg.io_fb.io_fb_estop),
                  'remote': bool(msg.io_fb.io_fb_joypad_ctrl),
                  'charging': bool(msg.io_fb.io_fb_charge_state or msg.bms_flag_fb.bms_flag_fb_charge_flag)}
        with lock:
            sample['phase'] = shared['phase']
            raw['feedback'].append(sample)
            latest['feedback'] = sample
            if shared['integrating']:
                try:
                    # Count all valid observed path, including braking rebound,
                    # before evaluating a motion interlock. A fault cannot erase
                    # already travelled distance from the authorization ledger.
                    guard.observe(t, sample['vx'], sample['wheels'])
                    shared['distance'] = guard.distance
                    check_motion(sample, 0.)
                except Exception as error:
                    shared['fault'] = str(error)
    def odom(msg):
        q = msg.pose.pose.orientation
        sample = {'stamp': stamp(msg), 'receivedAt': time.time(),
                  'pose': [msg.pose.pose.position.x, msg.pose.pose.position.y,
                           math.atan2(2*(q.w*q.z+q.x*q.y), 1-2*(q.y*q.y+q.z*q.z))],
                  'twist': [msg.twist.twist.linear.x, msg.twist.twist.linear.y, msg.twist.twist.angular.z]}
        with lock:
            sample['epoch'] = shared['epoch']
            raw['localOdom'].append(sample)
            latest['odom'] = {'receivedMono': time.monotonic(), 'stamp': sample['stamp']}
    def imu(msg):
        with lock:
            raw['imu'].append({'stamp': stamp(msg), 'receivedAt': time.time(),
                'gyro': [msg.angular_velocity.x, msg.angular_velocity.y, msg.angular_velocity.z],
                'accel': [msg.linear_acceleration.x, msg.linear_acceleration.y, msg.linear_acceleration.z]})
            latest['imu'] = {'receivedMono': time.monotonic(), 'stamp': stamp(msg)}
    def status(name, msg):
        try:
            data = json.loads(msg.data)
            if not isinstance(data, dict): return
            received = time.monotonic()
            with lock:
                raw[name].append({'receivedAt': time.time(), 'epoch': shared['epoch'], 'data': data})
                latest[name] = {'receivedMono': received, 'data': data}
                if name == 'fusion':
                    shared['epoch'] = data.get('epoch')
                    if shared['integrating'] and (data.get('ready') is not True
                            or data.get('state') != 'FUSED' or data.get('epoch') != shared['baseline_epoch']):
                        shared['fault'] = 'Fusion became invalid or epoch changed'
        except (ValueError, TypeError): pass
    subscriptions = [node.create_subscription(ChassisInfoFb, '/chassis_info_fb', feedback, qos_profile_sensor_data),
                     node.create_subscription(Odometry, '/qr/odometry/local', odom, qos_profile_sensor_data),
                     node.create_subscription(Imu, '/qr/imu/raw', imu, qos_profile_sensor_data)]
    for name, topic in [('tags', '/qr/tags/provisional'), ('fusion', '/qr/fusion/status'),
                        ('camera', '/qr/camera/status'), ('detector', '/qr/detector/status')]:
        subscriptions.append(node.create_subscription(String, topic, lambda msg, n=name: status(n, msg), qos_profile_sensor_data))
    def spin():
        while not executor_done.is_set():
            try: rclpy.spin_once(node, timeout_sec=.01)
            except Exception as error:
                with lock: shared['fault'] = 'ROS executor: ' + str(error)
                break
    worker = threading.Thread(target=spin, daemon=True)
    worker.start()
    def publishers():
        return {topic: [{'name': p.node_name, 'namespace': p.node_namespace}
                        for p in node.get_publishers_info_by_topic(topic)] for topic in CONTROL_TOPICS}
    def check_live():
        with lock:
            if shared['fault']: raise RuntimeError(shared['fault'])
            sample = latest.get('feedback')
            check_motion(sample, time.monotonic()-sample['receivedMono'] if sample else 999.)
            for name in ['odom', 'imu']:
                item = latest.get(name)
                if not item or time.monotonic()-item['receivedMono'] > .20 or not 0 <= now_ros()-item['stamp'] <= .20:
                    raise RuntimeError(name + ' is stale')
            fusion = latest.get('fusion')
            if not fusion or time.monotonic()-fusion['receivedMono'] > .30 or not fusion['data'].get('ready'):
                raise RuntimeError('Fusion is stale')
            if args.prior_travel_m + shared['distance'] >= .47: raise RuntimeError('Cumulative distance reserve reached')
        graph = publishers()
        if any(len(graph[t]) != 1 or graph[t][0]['name'] != EXPECTED_OWNER or graph[t][0]['namespace'] != '/' for t in CONTROL_TOPICS):
            raise RuntimeError('Command publisher ownership changed')
    def command(speed, deadman=True):
        if not 0 <= speed <= .03: raise ValueError('Forward speed out of scope')
        body = {'client_id': client_id, 'connected': True,
                'device_name': 'Authorized 50cm timing experiment', 'deadman': deadman,
                'gear': '4t4d', 'speed_mode': 'low', 'drive_axis': speed/.15, 'steer_axis': 0.}
        response = api('/api/gamepad/command', body)
        if response.get('ok') is not True: raise RuntimeError('Existing command API rejected request')
        state = response.get('gamepad_control', {})
        if state.get('owner_client_id') != client_id: raise RuntimeError('Command lease mismatch')
        report['commandRequests'].append({'at': time.time(), 'requestedSpeedMps': speed, 'deadman': deadman})
    interrupted = threading.Event()
    def on_signal(*_): interrupted.set()
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    outcome = 'PREFLIGHT_ONLY'
    try:
        baseline_end = time.monotonic() + 3.
        while time.monotonic() < baseline_end:
            if interrupted.is_set(): raise RuntimeError('Interrupted during baseline')
            time.sleep(.03)
        original = api('/api/state')
        check_application(original)
        robot = api('/api/robot/status', port=3080)
        if not robot.get('connected') or robot.get('running'): raise RuntimeError('QR bridge unavailable or running a mission')
        if not latest.get('tags') or time.monotonic()-latest['tags']['receivedMono'] > .3:
            raise RuntimeError('No fresh ground board pose for timing experiment')
        check_live()
        with lock:
            if max(abs(latest['feedback']['vx']), *(abs(v) for v in latest['feedback']['wheels'])) > .002:
                raise RuntimeError('Vehicle is not stationary')
        report['preflightOriginal'] = original
        report['preflightQr'] = robot
        report['commandPublishersBefore'] = publishers()
        if args.execute:
            response = api('/api/gamepad/claim', {'client_id': client_id, 'connected': True,
                                                 'device_name': 'Authorized 50cm timing experiment'})
            lease = response.get('ok') is True
            if not lease: raise RuntimeError('Cannot claim existing control lease')
            with lock:
                shared['integrating'] = True
                shared['baseline_epoch'] = shared['epoch']
                shared['phase'] = 'PREPARE_ZERO'
            event('Existing control lease claimed; zero-speed safety unlock pulse')
            # The manufacturer's safety-parking command is a falling edge.
            # Keep body speed zero throughout the pulse; no new publisher.
            for active in (True, False):
                until = time.monotonic() + .20
                while time.monotonic() < until:
                    check_live()
                    command(0., active)
                    time.sleep(.05)
            prepared_end = time.monotonic() + 5.
            stable_samples = 0
            while True:
                if interrupted.is_set(): raise RuntimeError('Interrupted')
                check_live()
                command(0.)
                with lock: fb = dict(latest['feedback'])
                # Original mature runtime and real driving logs allow unlock=False;
                # this is an event report, not a persistent enable status.
                # Retain the raw flag without inventing an acknowledgement.
                ready = (fb['bodyGear'] == 6 and abs(fb['steeringDeg']) <= 3.
                         and max(abs(fb['vx']), *(abs(v) for v in fb['wheels'])) <= .002)
                stable_samples = stable_samples + 1 if ready else 0
                if stable_samples >= 5: break
                if time.monotonic() >= prepared_end: raise RuntimeError('Forward gear/straight steering preparation failed')
                time.sleep(.05)
            check_application(api('/api/state'), client_id)
            event(f'Prepared; forward trial begins, additional stop target {args.target_m:.3f}m, prior travel {args.prior_travel_m:.4f}m')
            move_start = time.monotonic()
            paused = False
            pause_until = None
            next_state_check = 0.
            last_progress = 0.
            while True:
                tick = time.monotonic()
                if interrupted.is_set(): raise RuntimeError('Interrupted')
                check_live()
                with lock: distance = shared['distance']
                if distance >= args.target_m: outcome = 'TARGET_REACHED'; break
                if tick-move_start > 25.: raise RuntimeError('Movement deadline reached')
                if tick-move_start > 4. and distance < .003: raise RuntimeError('No measurable forward movement')
                # Live interlocks come directly from ROS, including the BMS
                # charge flag. The command API validates the owner on every
                # heartbeat; avoid the filesystem-heavy /api/state snapshot
                # blocking heartbeats while the vehicle is moving.
                if not paused and distance >= .025:
                    paused = True
                    pause_until = tick + 1.2
                    event('Short zero-speed interval for timing identification')
                if pause_until is not None and tick < pause_until:
                    speed = 0.
                    phase = 'CALIBRATION_PAUSE'
                else:
                    speed = min(.03, max(0., tick-move_start) * .06)
                    phase = 'FORWARD'
                with lock: shared['phase'] = phase
                command(speed)
                if tick-last_progress >= 1.:
                    event(f'Forward path estimate {distance:.4f}m')
                    last_progress = tick
                time.sleep(max(0., .05-(time.monotonic()-tick)))
            event('Stop target reached; sending zero and releasing control lease')
    except Exception as error:
        outcome = 'ABORTED'
        report['error'] = str(error)
        event('Trial stopped: ' + str(error))
    finally:
        with lock: shared['phase'] = 'STOPPING'
        if lease:
            # Deadman false causes the existing controller to send zero, then
            # its release endpoint explicitly sends zero and removes unlock.
            for _ in range(3):
                try: command(0., False)
                except Exception as error: report.setdefault('stopErrors', []).append(str(error))
                time.sleep(.06)
            try:
                reply = api('/api/gamepad/release', {'client_id': client_id, 'reason': 'Timing trial finished'}, timeout=1.)
                report['releaseReply'] = reply
            except Exception as error: report.setdefault('stopErrors', []).append(str(error))
            stop_deadline = time.monotonic() + 3.
            stationary_since = None
            while time.monotonic() < stop_deadline:
                with lock:
                    fb = latest.get('feedback', {})
                    quiet = (fb and time.monotonic()-fb['receivedMono'] < .2
                             and max(abs(fb['vx']), *(abs(v) for v in fb['wheels'])) <= .002)
                stationary_since = (stationary_since or time.monotonic()) if quiet else None
                if stationary_since and time.monotonic()-stationary_since > .6: break
                time.sleep(.03)
            report['stoppedConfirmed'] = bool(stationary_since and time.monotonic()-stationary_since > .6)
            report['unlockEventObserved'] = any(s['unlock'] for s in raw['feedback'])
        else: report['stoppedConfirmed'] = None
        with lock: shared['phase'] = 'POST_STOP'
        time.sleep(1.)
        executor_done.set()
        worker.join(timeout=2.)
        with lock:
            report['samples'] = dict(raw)
            report['estimatedTravelM'] = guard.distance
            report['cumulativeEstimatedTravelM'] = args.prior_travel_m + guard.distance
            report['integratedBodyAndWheelPathsM'] = guard.paths
            report['maximumFeedbackStampGapS'] = guard.max_gap
            report['latest'] = dict(latest)
            report['fault'] = shared['fault']
        report['outcome'] = outcome
        report['finishedAt'] = time.time()
        try:
            report['finalOriginal'] = api('/api/state', timeout=2.)
            report['commandPublishersAfter'] = publishers()
        except Exception as error: report['finalStateError'] = str(error)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
        node.destroy_node()
        rclpy.try_shutdown()
    print(json.dumps({'report': str(args.output), 'outcome': outcome, 'error': report.get('error'),
                      'estimatedTravelM': guard.distance, 'stoppedConfirmed': report['stoppedConfirmed'],
                      'commands': len(report['commandRequests']),
                      'samples': {name: len(values) for name, values in raw.items()}}, ensure_ascii=False), flush=True)
    return 0 if outcome in ('PREFLIGHT_ONLY', 'TARGET_REACHED') else 1


if __name__ == '__main__':
    raise SystemExit(main())
