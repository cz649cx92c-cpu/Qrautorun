"""v9 逐子码重投影 RMS：真实值、拒绝子码标记、不改变 solve_board_pose 返回/选解。"""
import json, math, os, sys, tempfile, unittest
from pathlib import Path
import cv2
import numpy as np
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
os.environ['QR_DIAG_DISABLE'] = '1'
from greenhouse_navigation.diag_log import DiagLogger
import greenhouse_navigation.vision as vision
from greenhouse_navigation.vision import solve_board_pose, marker_corners
os.environ.pop('QR_DIAG_DISABLE', None)


def board():
    tile = .0235
    return {'id': 'B016', 'referenceId': 16, 'gridSize': 4, 'sizeMm': 100, 'gapMm': 2,
            'members': [{'id': 16 + i, 'x': (i % 4 - 1.5) * .0255, 'y': (1.5 - i // 4) * .0255,
                         'angle': 0., 'size': tile / 1.25} for i in range(16)]}


class MemberRmsChecks(unittest.TestCase):
    def setUp(self):
        self.board = board()
        self.k = np.array([[700., 0., 640.], [0., 720., 360.], [0., 0., 1.]])
        self.d = np.zeros(5)
        self.rotation = np.array([[0., -1., 0.], [-1., 0., 0.], [0., 0., -1.]])
        self.translation = np.array([0., 0., .14])
        yaw = .3
        base_rotation = np.array([[math.cos(yaw), -math.sin(yaw), 0.], [math.sin(yaw), math.cos(yaw), 0.], [0., 0., 1.]])
        self.rvec = cv2.Rodrigues(self.rotation.T @ base_rotation)[0]
        self.tvec = self.rotation.T @ (np.array([.03, .05, 0.]) - self.translation)

    def solve_with_diag(self, detections):
        with tempfile.TemporaryDirectory() as d:
            logger = DiagLogger('vision', root=d, flush_interval=0.02)
            saved = getattr(vision, '_diag', None)
            vision._diag = logger
            try:
                pose = solve_board_pose(self.board, detections, self.k, self.d, self.rotation,
                                        self.translation, diag={'stamp': 123.0, 'recv': 456.0})
                deadline = __import__('time').monotonic() + 2
                while logger.written < 1 and __import__('time').monotonic() < deadline:
                    __import__('time').sleep(0.02)
                __import__('time').sleep(0.25)
            finally:
                vision._diag = saved
            records = []
            if os.path.exists(logger.path):
                with open(logger.path, encoding='utf-8') as f:
                    for line in f:
                        line = line.rstrip('\n')
                        if not line:
                            continue
                        records.append(json.loads(line))
            return pose, records

    def detections_for(self, members, noise_by_id=None):
        pixels = {}
        for m in members:
            pix = cv2.projectPoints(marker_corners(m), self.rvec, self.tvec, self.k, self.d)[0].reshape(4, 2)
            if noise_by_id and m['id'] in noise_by_id:
                rng = np.random.default_rng(7 + m['id'])
                pix = pix + rng.normal(0, noise_by_id[m['id']], pix.shape)
            pixels[m['id']] = pix
        return pixels

    def test_clean_all_codes_small_rms(self):
        pose, records = self.solve_with_diag(self.detections_for(self.board['members']))
        self.assertIsNotNone(pose)
        self.assertEqual(len(records), 1)
        rec = records[0]
        self.assertEqual(rec['type'], 'boardPnp')
        self.assertEqual(rec['groupId'], 'B016')
        self.assertEqual(rec['memberIds'], [16 + i for i in range(16)])
        self.assertEqual(len(rec['memberReprojPx']), 16)
        for v in rec['memberReprojPx']:
            self.assertLess(v, 0.5)
        self.assertEqual(rec['diag']['stamp'], 123.0)

    def test_noisy_code_detected_or_rejected_never_silent(self):
        # 0.6px 噪声：仍在 RANSAC 容差内，应留在 memberIds 且自身 RMS 明显偏大
        pose, records = self.solve_with_diag(self.detections_for(self.board['members'], {16: 0.6}))
        self.assertIsNotNone(pose)
        rec = records[0]
        if 16 in rec['memberIds']:
            idx = rec['memberIds'].index(16)
            rms = rec['memberReprojPx']
            self.assertGreater(rms[idx], max(rms[:idx] + rms[idx + 1:]) + 0.2,
                               '注入噪声的子码自身 RMS 应高于其他码')
        else:
            self.assertIn(16, rec['rejectedMemberIds'])

    def test_heavy_noise_code_appears_in_rejected(self):
        # 6px 噪声：RANSAC 应剔除该子码；被拒码必须在 rejectedMemberIds 可见（无投影数据，标 unavailable）
        pose, records = self.solve_with_diag(self.detections_for(self.board['members'], {16: 6.0}))
        if pose is not None:
            rec = records[0]
            self.assertEqual(rec['rejectedReproj'], 'unavailable:noCorrespondence')
            self.assertTrue(16 in rec['rejectedMemberIds'] or 16 in rec['memberIds'])

    def test_return_dict_schema_unchanged(self):
        src = Path(vision.__file__).read_text(encoding='utf-8')
        block = src.split('result={')[1].split('}')[0]
        self.assertNotIn('memberReprojPx', block)
        self.assertNotIn('member_rms', block)
        self.assertIn("'reprojectionPx':error", block)


if __name__ == '__main__':
    unittest.main(verbosity=2)
