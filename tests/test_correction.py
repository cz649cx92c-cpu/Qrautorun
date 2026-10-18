"""位置校正、延迟补偿及错误观测过滤的数学验证。"""
import math
from pathlib import Path
import sys
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src/greenhouse_navigation'))
from greenhouse_navigation.localization import absolute_tag_pose,propagate_pose,correction_update


class CorrectionTests(unittest.TestCase):
    def test_known_tag_recovers_car_position_and_heading(self):
        pose=absolute_tag_pose({'x':2.,'y':1.,'angle':90.}, {'x':.2,'y':.1,'angle':0.})
        self.assertAlmostEqual(pose[0],2.1)
        self.assertAlmostEqual(pose[1],.8)
        self.assertAlmostEqual(pose[2],math.pi/2)

    def test_reverse_and_lateral_delay_compensation(self):
        estimate=[2.,1.,math.pi/2]
        reverse=propagate_pose(estimate,[0.,0.,0.],[-.1,0.,0.])
        lateral=propagate_pose(estimate,[0.,0.,0.],[0.,.1,0.])
        np.testing.assert_allclose(reverse[:2],[2.,.9],atol=1e-10)
        np.testing.assert_allclose(lateral[:2],[1.9,1.],atol=1e-10)

    def test_drift_is_corrected_and_covariance_remains_positive(self):
        before=np.array([2.1,0.,.01]);covariance=np.diag([.01,.01,.01])
        result=correction_update(before,covariance,np.array([2.,0.,0.]),np.diag([.0004]*3))
        self.assertIsNotNone(result)
        after,cov=result
        self.assertLess(abs(after[0]-2),abs(before[0]-2))
        self.assertGreater(float(np.min(np.linalg.eigvalsh(cov))),0)

    def test_wrong_tag_jump_and_nonfinite_data_rejected(self):
        pose=np.zeros(3);cov=np.eye(3)*.01;noise=np.eye(3)*.0004
        self.assertIsNone(correction_update(pose,cov,np.array([2.,0.,0.]),noise))
        self.assertIsNone(correction_update(pose,cov,np.array([math.nan,0.,0.]),noise))

    def test_heading_wrap_does_not_trigger_false_jump(self):
        result=correction_update(np.array([0.,0.,math.pi-.01]),np.eye(3)*.01,
                                 np.array([0.,0.,-math.pi+.01]),np.eye(3)*.001)
        self.assertIsNotNone(result)
        self.assertLess(abs(abs(result[0][2])-math.pi),.02)


if __name__=='__main__':unittest.main(verbosity=2)
