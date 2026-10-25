"""Read-only turn-calibration loader tests (no writes, no ROS)."""
import hashlib
import json
import math
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
from greenhouse_navigation.turn_calibration import load_turn_calibration  # noqa: E402


def make_db(path, analyses):
    con = sqlite3.connect(path)
    con.execute('CREATE TABLE calibration_sessions (id TEXT, analysis_at TEXT, analysis TEXT)')
    for session_id, analysis_at, analysis in analyses:
        con.execute('INSERT INTO calibration_sessions VALUES (?,?,?)',
                    (session_id, analysis_at, json.dumps(analysis)))
    con.commit()
    con.close()


def analysis(trials):
    return {'schemaVersion': 3, 'trials': trials}


def trial(kind, measured, target=90.0, **extra):
    item = {'trialId': kind + str(len(extra)) + '-' + str(measured), 'type': kind,
            'targetAngleDeg': target, 'measuredAngleDeg': measured, 'valid': True}
    item.update(extra)
    return item


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class TurnCalibrationTests(unittest.TestCase):
    def test_valid_direction_consistent_trials_apply_and_exclude_mismatch(self):
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / 'calibration.db'
            make_db(db, [('cal-1', '2026-10-21T08:50:53.276Z', analysis([
                trial('left', 93.86), trial('left', 88.67), trial('left', 92.85),
                trial('right', -88.63), trial('right', -90.63),
                # 旧分析的“转反”样本：right 但实测为正，必须排除
                trial('right', 95.66),
                # 明确标记方向不一致的样本也必须排除
                trial('left', 92.0, directionMismatch=True),
                # 无效样本排除
                trial('right', -88.0, valid=False),
            ]))])
            before = sha(db)
            result = load_turn_calibration(calibration_path=str(db))
            after = sha(db)
        self.assertTrue(result['applied'], result)
        self.assertEqual(result['sessionId'], 'cal-1')
        self.assertEqual(result['validTurns'], 5)
        self.assertLessEqual(result['acceptanceDeg'], 2.5)
        self.assertGreaterEqual(result['acceptanceDeg'], 1.5)
        self.assertLess(result['correctionToleranceDeg'], result['acceptanceDeg'])
        self.assertTrue(all(item not in result['trialIds'] for item in ('right95.66-95.66',)))
        self.assertEqual(before, after, '标定数据库必须以只读方式打开，读取不得修改文件')

    def test_newest_analysis_wins(self):
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / 'calibration.db'
            make_db(db, [
                ('old', '2026-10-20T00:00:00.000Z', analysis([trial('left', 91.0), trial('left', 91.2), trial('right', -90.5)])),
                ('new', '2026-10-21T00:00:00.000Z', analysis([trial('left', 90.5), trial('left', 90.6), trial('right', -89.9)])),
            ])
            result = load_turn_calibration(calibration_path=str(db))
        self.assertTrue(result['applied'])
        self.assertEqual(result['sessionId'], 'new')

    def test_reversed_only_or_insufficient_trials_fall_back(self):
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / 'calibration.db'
            make_db(db, [('cal-bad', '2026-10-21T08:50:53.276Z', analysis([
                trial('right', 95.66), trial('left', -88.0), trial('right', 96.0)]))])
            result = load_turn_calibration(calibration_path=str(db))
        self.assertFalse(result['applied'])
        self.assertEqual(result['acceptanceDeg'], 2.5)
        self.assertEqual(result['correctionToleranceDeg'], 1.0)
        self.assertIn('有效转向样本不足', result['reason'])

    def test_missing_or_unreadable_database_falls_back(self):
        result = load_turn_calibration(calibration_path='/tmp/does-not-exist-calibration.db')
        self.assertFalse(result['applied'])
        self.assertEqual(result['acceptanceDeg'], 2.5)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'broken.db'
            path.write_bytes(b'not-a-sqlite-file')
            broken = load_turn_calibration(calibration_path=str(path))
        self.assertFalse(broken['applied'])
        self.assertIn('读取标定分析失败', broken['reason'])

    def test_wide_scatter_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / 'calibration.db'
            make_db(db, [('cal-wide', '2026-10-21T08:50:53.276Z', analysis([
                trial('left', 103.0), trial('left', 77.0), trial('right', -77.0), trial('right', -103.0)]))])
            result = load_turn_calibration(calibration_path=str(db))
        self.assertFalse(result['applied'])
        self.assertIn('散布过大', result['reason'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
