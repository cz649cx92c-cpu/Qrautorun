"""Statistical diagnostics: circular heading and observed spread."""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from check_stationary_pose import pose_summary


def sample(x, y, yaw):
    return {'x': x, 'y': y, 'yawRad': math.radians(yaw), 'visibleMembers': 5,
            'reprojectionPx': .6, 'relativePositionSigmaM': .018}


class StationaryPoseTests(unittest.TestCase):
    def test_wraparound_heading_does_not_report_full_rotation(self):
        result=pose_summary([sample(0,0,179), sample(0,0,-179)])
        self.assertAlmostEqual(abs(result['mean']['yawDeg']), 180)
        self.assertAlmostEqual(result['observedJitter']['yawPeakToPeakDeg'], 2)

    def test_metre_positions_are_reported_as_millimetre_jitter(self):
        result=pose_summary([sample(.009,-.002,0), sample(.011,.002,0)])
        self.assertAlmostEqual(result['mean']['x'], .01)
        self.assertAlmostEqual(result['observedJitter']['xStdMm'], 1)
        self.assertAlmostEqual(result['observedJitter']['yPeakToPeakMm'], 4)

    def test_insufficient_samples_do_not_invent_statistics(self):
        self.assertNotIn('mean', pose_summary([]))
        self.assertNotIn('observedJitter', pose_summary([sample(0,0,0)]))


if __name__ == '__main__':
    unittest.main(verbosity=2)
