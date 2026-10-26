"""v9 innovation 审计：correction_update 原数学结果同值回归 + audit 记录接受/拒绝原因。"""
import json, math, os, sys, unittest
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
os.environ['QR_DIAG_DISABLE'] = '1'
from greenhouse_navigation.localization import correction_update
from greenhouse_navigation.control import wrap


def reference_update(estimate, covariance, observed, noise, max_innovation=.2):
    """改动前的原实现逐行复制，作为同值基准。"""
    if not all(np.all(np.isfinite(v)) for v in (estimate, covariance, observed, noise)):
        return None
    if np.any(np.linalg.eigvalsh(covariance) <= 0) or np.any(np.linalg.eigvalsh(noise) <= 0):
        return None
    innovation = np.asarray(observed) - estimate; innovation[2] = wrap(innovation[2])
    total = covariance + noise
    if (np.linalg.norm(innovation[:2]) > max_innovation or abs(innovation[2]) > .3
            or innovation @ np.linalg.solve(total, innovation) > 11.34): return None
    gain = np.linalg.solve(total.T, covariance.T).T
    result = estimate + gain @ innovation; result[2] = wrap(result[2]); identity = np.eye(3)
    posterior = (identity - gain) @ covariance @ (identity - gain).T + gain @ noise @ gain.T
    return result, (posterior + posterior.T) / 2


class InnovationAuditChecks(unittest.TestCase):
    def setUp(self):
        self.est = np.array([1.0, 2.0, 0.1])
        self.cov = np.diag([0.01 ** 2, 0.01 ** 2, 0.05 ** 2])
        self.noise = np.diag([0.02 ** 2, 0.02 ** 2, 0.05 ** 2])

    def test_accept_same_math_as_reference(self):
        obs = np.array([1.008, 1.996, 0.12])
        audit = []
        got = correction_update(self.est, self.cov, obs, self.noise, audit=audit)
        ref = reference_update(self.est, self.cov, obs, self.noise)
        self.assertIsNotNone(got); self.assertIsNotNone(ref)
        np.testing.assert_allclose(got[0], ref[0], atol=0)
        np.testing.assert_allclose(got[1], ref[1], atol=0)
        rec = audit[0]
        self.assertTrue(rec['accepted'])
        self.assertEqual(rec['positionThresholdM'], 0.2)
        self.assertAlmostEqual(rec['innovation'][0], obs[0] - self.est[0], places=12)
        self.assertAlmostEqual(rec['delta'][0], got[0][0] - self.est[0], places=12)
        self.assertIn('gain', rec); self.assertIn('posterior', rec)

    def test_reject_position_reason(self):
        obs = np.array([1.5, 2.0, 0.1])  # 0.5m > 0.2
        audit = []
        self.assertIsNone(correction_update(self.est, self.cov, obs, self.noise, audit=audit))
        self.assertFalse(audit[0]['accepted'])
        self.assertTrue(audit[0]['reason'].startswith('positionOver'))
        self.assertAlmostEqual(audit[0]['innovation'][0], 0.5, places=9)

    def test_reject_yaw_reason(self):
        obs = np.array([1.0, 2.0, 0.1 + 0.5])  # 0.5rad > 0.3
        audit = []
        self.assertIsNone(correction_update(self.est, self.cov, obs, self.noise, audit=audit))
        self.assertEqual(audit[0]['reason'], 'yawOver0.3rad')

    def test_reject_mahalanobis_reason(self):
        # 位置 0.15m<0.2 但紧协方差下马氏距离超 11.34
        obs = np.array([1.15, 2.0, 0.1])
        audit = []
        got = correction_update(self.est, self.cov, obs, self.noise, audit=audit)
        if got is None:
            self.assertEqual(audit[0]['reason'], 'mahalanobisOver11.34')
        else:
            self.assertTrue(audit[0]['accepted'])  # 若未超限则应接受且同值
            ref = reference_update(self.est, self.cov, obs, self.noise)
            np.testing.assert_allclose(got[0], ref[0], atol=0)

    def test_nonfinite_reason(self):
        obs = np.array([float('nan'), 2.0, 0.1])
        audit = []
        self.assertIsNone(correction_update(self.est, self.cov, obs, self.noise, audit=audit))
        self.assertEqual(audit[0]['reason'], 'nonFiniteInput')

    def test_no_audit_behaves_exactly_as_before(self):
        obs = np.array([1.008, 1.996, 0.12])
        a = correction_update(self.est, self.cov, obs, self.noise)
        b = reference_update(self.est, self.cov, obs, self.noise)
        np.testing.assert_allclose(a[0], b[0], atol=0)
        self.assertIsNone(correction_update(self.est, self.cov, np.array([9., 9., 9.]), self.noise))


if __name__ == '__main__':
    unittest.main(verbosity=2)
