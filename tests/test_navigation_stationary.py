"""Read-only evidence accuracy, using memory messages and no ROS import."""
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace as NS
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/check_navigation_stationary.py'
spec = importlib.util.spec_from_file_location('stationary_check', SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def json_message(data):
    return NS(data=json.dumps(data))


def pose(frame='odom'):
    covariance = [0.] * 36
    for i in (0, 7, 35):
        covariance[i] = .0004
    return NS(header=NS(stamp=NS(sec=100, nanosec=0), frame_id=frame),
              child_frame_id='base_link', pose=NS(pose=NS(
              position=NS(x=1., y=2.), orientation=NS(x=0., y=0., z=0., w=1.)),
              covariance=covariance))


def board_payload(synchronized=False):
    layout = {'id': 'B000', 'referenceId': 0, 'gridSize': 1, 'sizeMm': 100,
              'gapMm': 2, 'members': [{'id': 0, 'x': 0., 'y': 0., 'angle': 0., 'size': .08}]}
    return {'stamp': 100., 'frame': 'base_link', 'calibrated': True,
            'synchronized': synchronized, 'representation': 'board-centers',
            'groupLayouts': [layout], 'tags': [{'id': 0, 'groupId': 'B000',
            'memberIds': [0], 'visibleCount': 1, 'x': .1, 'y': .2,
            'angle': .0, 'sigma': .02, 'angleSigma': .03}]}


class StationaryEvidenceTests(unittest.TestCase):
    def candidate_map(self):
        payload = board_payload()
        return {'id': 'real-map', 'coordinateStatus': 'draft', 'captureQuality': 'draft',
                'groups': payload['groupLayouts'], 'tags': [{'id': 0, 'x': 2., 'y': 1., 'angle': 90.}]}

    def test_draft_candidate_inverse_transform_is_report_only(self):
        c = check.EvidenceCollector(['/qr/tags/provisional'])
        c.observe('/qr/tags/provisional', json_message(board_payload()), 100., 10.)
        topics = c.snapshot(100., 10.)
        result = check.stationary_candidates(self.candidate_map(), topics['/qr/tags/provisional'])
        candidate = result['candidates'][0]
        self.assertAlmostEqual(candidate['x'], 2.2)
        self.assertAlmostEqual(candidate['y'], .9)
        self.assertAlmostEqual(candidate['yawRad'], math.pi/2)
        self.assertFalse(candidate['synchronized'])
        self.assertFalse(result['usableForNavigation'])
        self.assertFalse(check.formal_readiness(topics)['formalGlobalPose'])

    def test_stale_or_no_detected_board_has_no_invented_candidate(self):
        result = check.stationary_candidates(self.candidate_map(), {})
        self.assertEqual(result['candidates'], [])
        self.assertIn('未识别', result['reason'])

    def test_candidate_rejects_saved_map_layout_mismatch(self):
        c = check.EvidenceCollector(['/qr/tags/provisional'])
        c.observe('/qr/tags/provisional', json_message(board_payload()), 100., 10.)
        field = self.candidate_map()
        field['groups'] = []
        result = check.stationary_candidates(field, c.snapshot(100., 10.)['/qr/tags/provisional'])
        self.assertEqual(result['candidates'], [])
        self.assertIn('不匹配', result['reason'])

    def test_help_available_without_loading_ros(self):
        result = subprocess.run([sys.executable, '-S', str(SCRIPT), '--help'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--seconds', result.stdout)

    def test_observer_gap_is_separate_from_message_stamp_gap(self):
        c = check.EvidenceCollector(['/qr/fusion/status'])
        c.observe('/qr/fusion/status', json_message({'stamp': 100.}), 100., 10.)
        c.observe('/qr/fusion/status', json_message({'stamp': 100.01}), 100.01, 10.336)
        entry = c.snapshot(100.01, 10.336)['/qr/fusion/status']
        self.assertAlmostEqual(entry['maxReceiveGapMs'], 336.)
        self.assertAlmostEqual(entry['maxStampGapMs'], 10.)

    def test_freshness_recomputed_at_end_not_when_callback_arrived(self):
        c = check.EvidenceCollector(['/qr/localization/pose'])
        c.observe('/qr/localization/pose', pose('map'), 100., 10.)
        entry = c.snapshot(101., 11.)['/qr/localization/pose']
        self.assertEqual(entry['freshMessages'], 1)
        self.assertFalse(entry['qualifiedNow'])
        self.assertEqual(entry['latestStampAgeMs'], 1000.)

    def test_provisional_cannot_substitute_for_formal_local_or_global(self):
        c = check.EvidenceCollector(check.POSE_TOPICS)
        for topic in ('/qr/odometry/provisional', '/qr/localization/provisional'):
            c.observe(topic, pose('map' if 'localization' in topic else 'odom'), 100., 10.)
        readiness = check.formal_readiness(c.snapshot(100., 10.))
        self.assertFalse(readiness['formalLocalPose'])
        self.assertFalse(readiness['formalGlobalPose'])

    def test_observation_requires_verified_board_members_and_sync(self):
        c = check.EvidenceCollector(['/qr/tags/observations', '/qr/tags/provisional'])
        payload = board_payload()
        for topic in c.topics:
            c.observe(topic, json_message(payload), 100., 10.)
        report = c.snapshot(100., 10.)
        self.assertFalse(report['/qr/tags/observations']['qualifiedNow'])
        self.assertTrue(report['/qr/tags/provisional']['qualifiedNow'])
        payload['synchronized'] = True
        c.observe('/qr/tags/observations', json_message(payload), 100., 10.)
        self.assertTrue(c.snapshot(100., 10.)['/qr/tags/observations']['qualifiedNow'])
        payload['tags'][0]['memberIds'] = [99]
        c.observe('/qr/tags/observations', json_message(payload), 100., 10.)
        self.assertFalse(c.snapshot(100., 10.)['/qr/tags/observations']['qualifiedNow'])

    def test_visible_child_ids_and_empty_tags_do_not_count_as_group_pose(self):
        self.assertEqual(check.board_centers({'tags': [{'id': 0}]}), [])
        payload = board_payload(True)
        payload['tags'] = []
        self.assertEqual(check.board_centers(payload), [])

    def test_invalid_json_or_non_object_clears_current_evidence(self):
        c = check.EvidenceCollector(['/qr/fusion/status'])
        for value in ('null', '[]', '{bad', '42'):
            c.observe('/qr/fusion/status', NS(data=value), 100., 10.)
        entry = c.snapshot(100., 10.)['/qr/fusion/status']
        self.assertEqual(entry['invalidJson'], 4)
        self.assertFalse(entry['qualifiedNow'])

    def test_invalid_odometry_frame_orientation_and_covariance_rejected(self):
        c = check.EvidenceCollector(['/qr/localization/pose'])
        invalid = [pose('odom'), pose('map'), pose('map'), pose('map')]
        invalid[1].pose.pose.orientation.w = 0.
        invalid[2].pose.covariance[0] = 0.
        invalid[3].pose.pose.position.x = float('nan')
        for msg in invalid:
            c.observe('/qr/localization/pose', msg, 100., 10.)
        self.assertEqual(c.topics['/qr/localization/pose']['qualifiedMessages'], 0)

    def test_complete_valid_chain_does_not_claim_motion_permission(self):
        topics = list(check.JSON_TOPICS) + list(check.POSE_TOPICS)
        c = check.EvidenceCollector(topics)
        c.observe('/qr/camera/status', json_message({'stamp': 100.,
                  'captureTimestampVerified': True, 'intrinsicsVerified': True,
                  'extrinsicsVerified': True}), 100., 10.)
        c.observe('/qr/detector/status', json_message({'stamp': 100., 'positionReady': True,
                  'validBoardCount': 1, 'localPoseReady': True}), 100., 10.)
        c.observe('/qr/fusion/status', json_message({'stamp': 100., 'state': 'FUSED',
                  'mappingReady': True}), 100., 10.)
        c.observe('/qr/tags/observations', json_message(board_payload(True)), 100., 10.)
        c.observe('/qr/odometry/local', pose(), 100., 10.)
        c.observe('/qr/localization/pose', pose('map'), 100., 10.)
        result = check.formal_readiness(c.snapshot(100., 10.))
        self.assertEqual(check.blocking_summary(result), [])
        self.assertIn('不代表运动许可', result['note'])

    def test_camera_half_second_status_period_not_false_timeout(self):
        c = check.EvidenceCollector(['/qr/camera/status'])
        c.observe('/qr/camera/status', json_message({'stamp': 100.,
                  'captureTimestampVerified': True}), 100., 10.)
        result = check.formal_readiness(c.snapshot(100.4, 10.4))
        self.assertTrue(result['exposureTimestampVerified'])
        self.assertFalse(check.formal_readiness(c.snapshot(101.1, 11.1))['exposureTimestampVerified'])

    def test_future_and_boolean_stamp_cannot_claim_freshness(self):
        c = check.EvidenceCollector(['/qr/tags/observations'])
        for stamp in (True, float('nan'), 101.):
            payload = board_payload(True)
            payload['stamp'] = stamp
            c.observe('/qr/tags/observations', json_message(payload), 100., 10.)
            self.assertFalse(c.snapshot(100., 10.)['/qr/tags/observations']['qualifiedNow'])

    def test_epochs_and_regressions_recorded_independently(self):
        c = check.EvidenceCollector(['/qr/fusion/status'])
        for stamp, state, epoch in [(100., 'PROVISIONAL', 'a'), (100.1, 'INVALID', 'a'),
                                    (99., 'CALIBRATING', 'b')]:
            c.observe('/qr/fusion/status', json_message({'stamp': stamp, 'state': state,
                      'epoch': epoch}), stamp, stamp)
        entry = c.snapshot(100., 100.)['/qr/fusion/status']
        self.assertEqual(entry['epochs'], ['a', 'b'])
        self.assertEqual(entry['stampRegressions'], 1)
        self.assertEqual(entry['states']['INVALID'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
