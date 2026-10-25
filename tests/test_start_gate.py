"""Start-gate regressions built from the real 2026-10-21 20:07-20:08 failure vectors."""
import math
import queue
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
from greenhouse_navigation.control import Pose  # noqa: E402
from greenhouse_navigation.start_gate import evaluate_start_gate, segment_start_check  # noqa: E402

MAP_ID = 'scan-402e12c2332e46ccb4e3153a79a27876'
ROUTE_ID = 'route-e5c44a91cecfbbfe888c7ed5'
START = {'x': -0.6716169460542605, 'y': -0.3157423237692501}
END = {'x': -1.2586725489662556, 'y': -0.3157423237692501}
OLD_EPOCH = 'c53e0d4b17344b05a94ca55197cfc00f'
NEW_EPOCH = '84df116dad874deba1ec963455dbfb1d'

CONFIG = {
    'max_cross_track_m': .05, 'max_position_sigma_m': .03,
    'start_heading_tolerance_deg': 15., 'localization_timeout_s': .25,
    'start_ahead_tolerance_m': .15, 'start_behind_tolerance_m': .05,
    'start_gate_timeout_s': 12., 'start_gate_stable_samples': 5,
    'start_stable_jitter_m': .01, 'start_stable_jitter_deg': .5,
}

# Real stale pose used by the failed 20:08 start attempts (old epoch, fusion CALIBRATING).
STALE_POSE = {'x': -0.9447286922960036, 'y': -0.5669666241575251, 'yaw': 2.3761171452640513}
# Real pose after the 20:12 re-anchor: 8.3 cm ahead along the route, 0.34 cm lateral.
FRESH_POSE = {'x': -0.7543742823791184, 'y': -0.3123453102931632, 'yaw': 3.040139800867831}


def field_task(segment_start=None):
    start = segment_start or START
    field = {
        'id': MAP_ID, 'routeMode': 'waypoints', 'coordinateStatus': 'reviewed',
        'tags': [{'id': 241, 'x': START['x'], 'y': START['y']}],
        'motionSegments': [{
            'id': 'seg-1', 'fromId': 241, 'toId': 193, 'mode': '4t4d', 'direction': 'forward',
            'bodyYaw': -math.pi, 'endYaw': -math.pi, 'wheelAngle': 0.,
            'points': [{'x': start['x'], 'y': start['y']}, {'x': END['x'], 'y': END['y']}],
        }],
    }
    task = {'id': 'task-route-f4bad1187d91c5250c8b5b9b', 'routeId': ROUTE_ID, 'mapId': MAP_ID, 'mapVersion': 6}
    return field, task


def loc(epoch, sigma, map_version=6, map_id=MAP_ID):
    return {'state': 'FORMAL', 'source': 'synchronized_qr', 'poseAvailable': True,
            'mapId': map_id, 'mapVersion': map_version, 'localEpoch': epoch,
            'positionSigmaM': sigma, 'navigationReady': True, 'captureTimestampVerified': True}


def fusion(epoch=NEW_EPOCH, state='FUSED'):
    return {'epoch': epoch, 'state': state, 'ready': state == 'FUSED'}


def samples(pose, epoch, sigma, count=5, now=100.0):
    return [{'t': now - (count - 1 - index) * .05, 'x': pose['x'], 'y': pose['y'], 'yaw': pose['yaw'],
             'mapId': MAP_ID, 'mapVersion': 6, 'localEpoch': epoch, 'sigma': sigma}
            for index in range(count)]


def evaluate(pose, epoch, sigma, samples_override=None, map_version=6, map_id=MAP_ID, segment_start=None, elapsed=0.):
    field, task = field_task(segment_start)
    return evaluate_start_gate(field, task, pose, loc(epoch, sigma, map_version, map_id), fusion(),
                               .05, .05, samples_override if samples_override is not None else samples(pose, epoch, sigma),
                               CONFIG, elapsed)


class StartGateTests(unittest.TestCase):
    def test_stale_old_epoch_pose_waits_instead_of_claiming_not_at_start(self):
        result = evaluate(STALE_POSE, OLD_EPOCH, .07925)
        self.assertEqual(result['decision'], 'wait', result)
        self.assertEqual(result['diagnostics']['reasonCode'], 'localization_epoch_stale')
        # 旧行为在这个位姿上直接报“请将小车放到首个二维码起点”（37.1cm 欧氏偏差）。
        self.assertAlmostEqual(result['diagnostics']['distanceM'], .371, places=2)
        self.assertEqual(result['diagnostics']['finalDecision'], 'wait')

    def test_fresh_reanchored_pose_passes_with_along_track_offset(self):
        result = evaluate(FRESH_POSE, NEW_EPOCH, .001166)
        self.assertEqual(result['decision'], 'pass', result['message'])
        diag = result['diagnostics']
        self.assertAlmostEqual(diag['alongM'], .0828, places=3)
        self.assertAlmostEqual(abs(diag['crossM']), .0034, places=3)
        self.assertLessEqual(abs(diag['headingErrorDeg']), 6.0)
        self.assertTrue(diag['localizationFresh'])
        self.assertEqual(diag['stableSamples'], 5)
        self.assertEqual(diag['firstTagId'], 241)
        self.assertEqual(diag['mapId'], MAP_ID)
        self.assertEqual(diag['mapVersion'], 6)
        self.assertEqual(diag['routeId'], ROUTE_ID)
        self.assertEqual(diag['finalDecision'], 'pass')
        self.assertAlmostEqual(result['pose']['x'], FRESH_POSE['x'], places=6)

    def test_old_pose_then_fresh_samples_waits_then_passes(self):
        old = evaluate(STALE_POSE, OLD_EPOCH, .07925)
        self.assertEqual(old['decision'], 'wait')
        mixed = samples(STALE_POSE, OLD_EPOCH, .07925) + samples(FRESH_POSE, NEW_EPOCH, .001166, count=5, now=100.2)
        result = evaluate(FRESH_POSE, NEW_EPOCH, .001166, samples_override=mixed)
        self.assertEqual(result['decision'], 'pass', result['message'])

    def test_wrong_lateral_position_rejects(self):
        pose = {'x': FRESH_POSE['x'], 'y': FRESH_POSE['y'] + .20, 'yaw': FRESH_POSE['yaw']}
        result = evaluate(pose, NEW_EPOCH, .001166)
        self.assertEqual(result['decision'], 'reject')
        self.assertEqual(result['diagnostics']['reasonCode'], 'wrong_start_position')
        self.assertGreater(abs(result['diagnostics']['crossM']), .05)

    def test_wrong_heading_rejects(self):
        pose = {'x': FRESH_POSE['x'], 'y': FRESH_POSE['y'], 'yaw': math.radians(140.)}
        result = evaluate(pose, NEW_EPOCH, .001166)
        self.assertEqual(result['decision'], 'reject')
        self.assertEqual(result['diagnostics']['reasonCode'], 'wrong_start_heading')
        self.assertGreater(abs(result['diagnostics']['headingErrorDeg']), 15.)

    def test_too_far_behind_start_rejects(self):
        pose = {'x': START['x'] + .10, 'y': START['y'], 'yaw': FRESH_POSE['yaw']}  # travel = -x, so behind 10cm
        result = evaluate(pose, NEW_EPOCH, .001166, segment_start=START)
        self.assertEqual(result['decision'], 'reject')
        self.assertEqual(result['diagnostics']['reasonCode'], 'wrong_start_position')
        self.assertLess(result['diagnostics']['alongM'], -.05)

    def test_map_scope_mismatch_rejects(self):
        result = evaluate(FRESH_POSE, NEW_EPOCH, .001166, map_version=5)
        self.assertEqual(result['decision'], 'reject')
        self.assertEqual(result['diagnostics']['reasonCode'], 'map_scope_mismatch')

    def test_route_snapshot_mismatch_rejects(self):
        shifted = {'x': START['x'] - .05, 'y': START['y']}
        result = evaluate(FRESH_POSE, NEW_EPOCH, .001166, segment_start=shifted)
        self.assertEqual(result['decision'], 'reject')
        self.assertEqual(result['diagnostics']['reasonCode'], 'route_snapshot_mismatch')

    def test_high_sigma_waits_with_explicit_reason(self):
        result = evaluate(FRESH_POSE, NEW_EPOCH, .07925)
        self.assertEqual(result['decision'], 'wait')
        self.assertEqual(result['diagnostics']['reasonCode'], 'position_sigma_high')

    def test_segment_executor_double_check_keeps_lateral_and_heading_gates(self):
        field, task = field_task()
        segment = field['motionSegments'][0]
        fresh = segment_start_check(type('Pose', (), FRESH_POSE), segment, CONFIG)
        self.assertTrue(fresh['ok'], fresh['message'])
        self.assertAlmostEqual(fresh['alongM'], .0828, places=3)
        self.assertAlmostEqual(abs(fresh['crossM']), .0034, places=3)
        wrong_lateral = dict(FRESH_POSE, y=FRESH_POSE['y'] + .20)
        self.assertFalse(segment_start_check(type('Pose', (), wrong_lateral), segment, CONFIG)['ok'])
        wrong_heading = dict(FRESH_POSE, yaw=math.radians(140.))
        self.assertFalse(segment_start_check(type('Pose', (), wrong_heading), segment, CONFIG)['ok'])
        stale = segment_start_check(type('Pose', (), STALE_POSE), segment, CONFIG)
        self.assertFalse(stale['ok'])
        self.assertIn('起点偏差', stale['message'])


    def test_ros_pose_object_passes_with_real_vector(self):
        """The real ROS Pose object from node.py must be accepted, not indexed."""
        field, task = field_task()
        pose = Pose(FRESH_POSE['x'], FRESH_POSE['y'], FRESH_POSE['yaw'])
        result = evaluate_start_gate(field, task, pose, loc(NEW_EPOCH, .001166), fusion(),
                                     .05, .05, samples(FRESH_POSE, NEW_EPOCH, .001166), CONFIG, 0.)
        self.assertEqual(result['decision'], 'pass', result['message'])
        self.assertEqual(result['diagnostics']['reasonCode'], 'ok')
        self.assertAlmostEqual(result['diagnostics']['alongM'], .0828, places=3)
        self.assertAlmostEqual(abs(result['diagnostics']['crossM']), .0034, places=3)
        self.assertEqual(result['diagnostics']['finalDecision'], 'pass')

    def test_invalid_pose_types_reject_without_exception(self):
        field, task = field_task()
        for bad in (object(), 'not-a-pose', 42, {'x': 1.0}, {'x': 1.0, 'y': 2.0}):
            try:
                result = evaluate_start_gate(field, task, bad, loc(NEW_EPOCH, .001166), fusion(),
                                             .05, .05, samples(FRESH_POSE, NEW_EPOCH, .001166), CONFIG, 0.)
            except Exception as exc:  # noqa: BLE001
                self.fail(f'非法位姿 {type(bad).__name__} 不应抛出异常：{exc!r}')
            self.assertEqual(result['decision'], 'reject', result)
            self.assertEqual(result['diagnostics']['reasonCode'], 'invalid_pose_type')
            self.assertIsNone(result['pose'])


class _FakeMotion:
    def __init__(self):
        self.prepared = False
        self.sent = []

    def prepare(self):
        self.prepared = True
        return True


class _FakeMission:
    def __init__(self):
        self.running = False
        self.events = []
        self.started = 0
        self.started_pose = None

    def log(self, text):
        self.events.append(text)

    def start(self, field, task, pose):
        self.started += 1
        self.started_pose = pose


class PendingStartTests(unittest.TestCase):
    def _node(self, pose):
        import greenhouse_navigation.node as node_module
        n = node_module.GreenhouseNode.__new__(node_module.GreenhouseNode)
        field, task = field_task()
        n.config = dict(CONFIG)
        n.pose = pose
        n.pose_received = time.monotonic()
        n.localization_status = loc(NEW_EPOCH, .001166)
        n.localization_received = time.monotonic()
        n.fusion = fusion()
        n.start_samples = samples(FRESH_POSE, NEW_EPOCH, .001166, count=4, now=time.monotonic())
        n.start_gate = {}
        n.start_gate_reason = ''
        n.pending_start = {'id': 'req-test', 'payload': {'map': field, 'task': task}}
        n.pending_start_at = time.monotonic()
        n.motion = _FakeMotion()
        n.mission = _FakeMission()
        n.acks = queue.Queue()
        n.engaged = False
        return n, node_module

    def _conditions(self):
        return [{'label': 'test', 'ready': True}]

    def test_pending_start_with_ros_pose_completes_without_crash(self):
        n, _ = self._node(Pose(FRESH_POSE['x'], FRESH_POSE['y'], FRESH_POSE['yaw']))
        n.advance_pending_start(self._conditions())
        self.assertIsNone(n.pending_start)
        self.assertEqual(n.mission.started, 1)
        self.assertTrue(n.engaged)
        ack = n.acks.get_nowait()
        self.assertTrue(ack['ok'], ack)
        self.assertEqual(n.start_gate['finalDecision'], 'pass')
        self.assertEqual(n.start_gate['reasonCode'], 'ok')
        # advance_pending_start must not send any motion command.
        self.assertEqual(n.motion.sent, [])

    def test_pending_start_with_invalid_pose_rejects_without_crash(self):
        n, _ = self._node(object())
        n.advance_pending_start(self._conditions())
        self.assertIsNone(n.pending_start)
        self.assertEqual(n.mission.started, 0)
        self.assertFalse(n.engaged)
        ack = n.acks.get_nowait()
        self.assertFalse(ack['ok'])
        self.assertEqual(n.start_gate['reasonCode'], 'invalid_pose_type')
        self.assertEqual(n.motion.sent, [])

    def test_gate_exception_is_contained_as_structured_rejection(self):
        n, node_module = self._node(Pose(FRESH_POSE['x'], FRESH_POSE['y'], FRESH_POSE['yaw']))
        original = node_module.evaluate_start_gate

        def broken(*args, **kwargs):
            raise RuntimeError('boom')
        node_module.evaluate_start_gate = broken
        try:
            n.advance_pending_start(self._conditions())
        finally:
            node_module.evaluate_start_gate = original
        self.assertIsNone(n.pending_start)
        self.assertEqual(n.mission.started, 0)
        self.assertEqual(n.start_gate['finalDecision'], 'reject')
        self.assertEqual(n.start_gate['reasonCode'], 'start_gate_exception')
        ack = n.acks.get_nowait()
        self.assertFalse(ack['ok'])
        self.assertEqual(n.motion.sent, [])
        self.assertTrue(any('起点门禁内部错误' in event for event in n.mission.events))


if __name__ == '__main__':
    unittest.main(verbosity=2)
