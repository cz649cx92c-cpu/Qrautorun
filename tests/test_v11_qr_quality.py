"""v11：二维码观测质量「迟滞 + 有界保持」。

用户确认的质量策略：质量/置信度可能先低后高、再下降；下降时不能立刻用较差
新观测覆盖此前已确认的高质量观测，但也不能永久锁存旧值。只有在
  * 连续下降达到帧数阈值，
  * 超过最大保持时长，或
  * 出现很大的可证实位姿变化/创新（超过硬门）
时才改变处理。

本测试覆盖纯决策层（不依赖 ROS / EKF），确保：
1. 尚未锁定时，任何合格观测都可建立锁定（不存在"高质量"可比）；
2. 高质量锁定后，单帧/少量连续质量下降 → 保留上一高质量观测，
   继续用正常里程计预测，不伪造零速度、不改观测值；
3. 连续低质量超帧数或超时长 → 锁失效，回到正常拒绝/等待重锚；
4. 小创新可迟滞；超硬门的明显创新不得盲目沿用旧观测；
5. 质量恢复后重新接受新高质量观测；
6. epoch / map scope / sourceStamp / 重复帧不被迟滞绕过；
7. 日志字段齐全，区分 held_observation 与 accepted_anchor。
"""
import io
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))

from greenhouse_navigation.qr_quality import (  # noqa: E402
    DEFAULT_PARAMS, QrQualityHysteresis, observation_quality)

SCOPE = {'mapId': 'm1', 'mapVersion': 5, 'localEpoch': 'E1'}


def q(sigma, angle=.02, members=4):
    return {'sigmaM': sigma, 'angleSigmaRad': angle, 'members': members}


class QualityMetric(unittest.TestCase):
    """质量必须只来自观测本身（RMS/sigma/成员数），不看预测位姿。"""

    def test_quality_reads_observation_only(self):
        tag = {'sigma': .012, 'angleSigma': .03, 'memberIds': [1, 2, 3]}
        got = observation_quality(tag)
        self.assertAlmostEqual(got['sigmaM'], .012)
        self.assertAlmostEqual(got['angleSigmaRad'], .03)
        self.assertEqual(got['members'], 3)

    def test_quality_does_not_mutate_observation(self):
        tag = {'sigma': .012, 'angleSigma': .03, 'memberIds': [1]}
        before = dict(tag)
        observation_quality(tag)
        self.assertEqual(tag, before, '不得把 sigma/RMS "变好看"或改真实观测值')

    def test_defaults_are_conservative(self):
        p = DEFAULT_PARAMS
        self.assertGreaterEqual(p['qr_quality_degrade_ratio'], 1.2,
                                '恶化比例过小会过度锁存')
        self.assertLessEqual(p['qr_quality_hold_frames'], 10, '保持帧数必须有界')
        self.assertLessEqual(p['qr_quality_max_hold_s'], 2.0, '保持时长必须有界')
        self.assertLessEqual(p['qr_quality_hard_innovation_m'], .10,
                             '硬创新门不得比既有 max_innovation_m(0.2) 更宽松')


class InitialLock(unittest.TestCase):
    def test_first_qualified_observation_locks(self):
        h = QrQualityHysteresis()
        r = h.update(q(.030), (0., 0., 0.), SCOPE, 100.0, now=0.)
        self.assertTrue(r['accept'])
        self.assertEqual(r['decision'], 'firstLock')
        self.assertEqual(r['qualityState'], 'accepted_anchor')

    def test_low_quality_first_does_not_lock_forever(self):
        """初始只有低质量时先锁定它，但一旦出现明显更好的观测就应被替换。"""
        h = QrQualityHysteresis()
        h.update(q(.045), (0., 0., 0.), SCOPE, 100.0, now=0.)
        r = h.update(q(.010), (0., 0., 0.), SCOPE, 100.1, now=.1)
        self.assertTrue(r['accept'])
        self.assertAlmostEqual(r['heldQuality']['sigmaM'], .010)


class HoldHighQuality(unittest.TestCase):
    """高质量锁定后，质量下降不得立刻覆盖。"""

    def setUp(self):
        self.h = QrQualityHysteresis()
        self.h.update(q(.010), (0., 0., 0.), SCOPE, 100.0, now=0.)
        self.h.update(q(.010), (0., 0., 0.), SCOPE, 100.1, now=.1)

    def test_single_degraded_frame_is_held(self):
        r = self.h.update(q(.030), (0., 0., 0.), SCOPE, 100.2, now=.2)
        self.assertFalse(r['accept'], '较差观测不得用于位姿校正')
        self.assertEqual(r['decision'], 'hold')
        self.assertEqual(r['qualityState'], 'held_observation')
        self.assertAlmostEqual(r['heldQuality']['sigmaM'], .010,
                               '必须保留上一高质量观测，而不是被 .030 覆盖')
        self.assertEqual(r['holdFrames'], 1)

    def test_hold_does_not_fake_zero_speed_or_freeze(self):
        r = self.h.update(q(.030), (0., 0., 0.), SCOPE, 100.2, now=.2)
        self.assertNotIn('vx', r, '不得伪造零速度')
        self.assertNotIn('frozen', r, '不得冻结位姿')
        self.assertEqual(r['posePrediction'], 'odometry', '保持期间仍用正常里程计预测')

    def test_few_consecutive_degraded_frames_still_held(self):
        for i in range(DEFAULT_PARAMS['qr_quality_hold_frames']):
            r = self.h.update(q(.030), (0., 0., 0.), SCOPE, 100.2 + i * .05,
                              now=.2 + i * .05)
            self.assertFalse(r['accept'])
            self.assertEqual(r['decision'], 'hold', '第 %d 帧仍应在有界保持内' % (i + 1))
            self.assertAlmostEqual(r['heldQuality']['sigmaM'], .010)


class HoldExpiry(unittest.TestCase):
    def test_hold_expires_after_frame_limit(self):
        h = QrQualityHysteresis()
        h.update(q(.010), (0., 0., 0.), SCOPE, 100.0, now=0.)
        limit = DEFAULT_PARAMS['qr_quality_hold_frames']
        last = None
        for i in range(limit + 1):
            last = h.update(q(.030), (0., 0., 0.), SCOPE, 100.2 + i * .05,
                            now=.2 + i * .05)
        self.assertEqual(last['decision'], 'holdExpired', '超帧数后旧质量锁必须失效')
        self.assertEqual(last['qualityState'], 'expired')
        self.assertFalse(last['accept'])
        self.assertIsNone(h.held, '失效后必须丢弃旧观测，不得永久锁存')

    def test_hold_expires_after_max_age(self):
        h = QrQualityHysteresis()
        h.update(q(.010), (0., 0., 0.), SCOPE, 100.0, now=0.)
        max_age = DEFAULT_PARAMS['qr_quality_max_hold_s']
        r = h.update(q(.030), (0., 0., 0.), SCOPE, 100.2, now=max_age + .01)
        self.assertEqual(r['decision'], 'holdExpired', '超时长后旧质量锁必须失效')
        self.assertIsNone(h.held)

    def test_reacquire_after_expiry_needs_fresh_quality(self):
        h = QrQualityHysteresis()
        h.update(q(.010), (0., 0., 0.), SCOPE, 100.0, now=0.)
        for i in range(DEFAULT_PARAMS['qr_quality_hold_frames'] + 1):
            h.update(q(.030), (0., 0., 0.), SCOPE, 100.2 + i * .05, now=.2 + i * .05)
        r = h.update(q(.012), (0., 0., 0.), SCOPE, 101.0, now=2.0)
        self.assertTrue(r['accept'], '质量恢复后必须能重新接受')
        # 失效后已无锁定，重新接受即为新的 firstLock（语义上等价于重新锚定）。
        self.assertIn(r['decision'], ('qualityOk', 'firstLock'))
        self.assertEqual(r['qualityState'], 'accepted_anchor')


class InnovationGate(unittest.TestCase):
    def setUp(self):
        self.h = QrQualityHysteresis()
        self.h.update(q(.010), (0., 0., 0.), SCOPE, 100.0, now=0.)

    def test_small_innovation_is_held(self):
        r = self.h.update(q(.030), (0.010, 0., 0.), SCOPE, 100.2, now=.2)
        self.assertEqual(r['decision'], 'hold')
        self.assertAlmostEqual(r['innovation'], .010, places=6)

    def test_large_innovation_must_not_reuse_old_observation(self):
        r = self.h.update(q(.030), (0.25, 0., 0.), SCOPE, 100.2, now=.2)
        self.assertEqual(r['decision'], 'rejectInnovation',
                         '超硬门的明显创新不得盲目沿用旧观测')
        self.assertEqual(r['qualityState'], 'innovationGate')
        self.assertFalse(r['accept'])

    def test_large_innovation_never_accepts_degraded(self):
        r = self.h.update(q(.030), (0.25, 0., 0.), SCOPE, 100.2, now=.2)
        self.assertFalse(r['accept'], '低质量 + 大创新必须拒绝，不能借迟滞放行')


class ScopeAndDuplicates(unittest.TestCase):
    def test_epoch_change_clears_hold(self):
        h = QrQualityHysteresis()
        h.update(q(.010), (0., 0., 0.), SCOPE, 100.0, now=0.)
        r = h.update(q(.030), (0., 0., 0.),
                     {'mapId': 'm1', 'mapVersion': 5, 'localEpoch': 'E2'},
                     100.2, now=.2)
        self.assertFalse(r['accept'])
        self.assertEqual(r['decision'], 'rejectScope', 'epoch 变化不得被迟滞绕过')
        self.assertIsNone(h.held)

    def test_map_version_change_clears_hold(self):
        h = QrQualityHysteresis()
        h.update(q(.010), (0., 0., 0.), SCOPE, 100.0, now=0.)
        r = h.update(q(.030), (0., 0., 0.),
                     {'mapId': 'm1', 'mapVersion': 6, 'localEpoch': 'E1'},
                     100.2, now=.2)
        self.assertEqual(r['decision'], 'rejectScope')
        self.assertIsNone(h.held)

    def test_duplicate_source_stamp_not_accepted(self):
        h = QrQualityHysteresis()
        h.update(q(.010), (0., 0., 0.), SCOPE, 100.0, now=0.)
        r = h.update(q(.010), (0., 0., 0.), SCOPE, 100.0, now=.1)
        self.assertFalse(r['accept'], '重复帧不得被迟滞绕过')
        self.assertEqual(r['decision'], 'duplicate')

    def test_older_source_stamp_rejected(self):
        h = QrQualityHysteresis()
        h.update(q(.010), (0., 0., 0.), SCOPE, 100.5, now=0.)
        r = h.update(q(.010), (0., 0., 0.), SCOPE, 100.1, now=.1)
        self.assertEqual(r['decision'], 'staleStamp')
        self.assertFalse(r['accept'])


class LogFields(unittest.TestCase):
    def test_all_documented_fields_present(self):
        h = QrQualityHysteresis()
        h.update(q(.010), (0., 0., 0.), SCOPE, 100.0, now=0.)
        r = h.update(q(.030), (0.001, 0., 0.), SCOPE, 100.2, now=.2)
        for key in ('qualityState', 'candidateQuality', 'heldQuality', 'holdFrames',
                    'holdAge', 'holdReason', 'innovation', 'decision',
                    'posePrediction', 'sourceStamp'):
            self.assertIn(key, r, '日志必须含 %s' % key)
        self.assertEqual(r['qualityState'], 'held_observation')
        self.assertNotEqual(r['qualityState'], 'accepted_anchor',
                            '必须区分 held_observation 与 accepted_anchor')


if __name__ == '__main__':
    unittest.main(verbosity=2)
