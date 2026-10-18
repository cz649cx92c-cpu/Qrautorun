"""Offline replay checks, no DDS or chassis commands."""
import math
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from check_observation_timing import local_at,summary


class ObservationTimingTests(unittest.TestCase):
    def pose(self,stamp,epoch='one',pose=None):return {'stamp':stamp,'epoch':epoch,'pose':pose or [0.,0.,0.]}

    def test_no_feedback_has_no_invented_numeric_latency(self):
        self.assertEqual(summary([]),{'count':0})
        self.assertEqual(summary([math.nan,math.inf,None]),{'count':0})

    def test_percentiles_keep_large_queue_delays_visible(self):
        result=summary([1.,2.,3.,4.,100.])
        self.assertEqual(result['median'],3.);self.assertGreater(result['p95'],80.)

    def test_epoch_discontinuity_cannot_be_interpolated(self):
        samples=[self.pose(1.),self.pose(1.04,'two',[1.,0.,0.])]
        self.assertIsNone(local_at(samples,1.02,'one'));self.assertIsNone(local_at(samples,1.02,'two'))

    def test_dropped_stream_and_extrapolation_rejected(self):
        samples=[self.pose(1.),self.pose(1.3)]
        for stamp in (.9,1.15,1.4):self.assertIsNone(local_at(samples,stamp,'one'))

    def test_lateral_reverse_and_yaw_wrap_are_preserved(self):
        samples=[self.pose(1.,pose=[0.,0.,math.radians(179.)]),self.pose(1.04,pose=[-.04,.02,math.radians(-179.)])]
        point=local_at(samples,1.02,'one')
        self.assertAlmostEqual(point[0],-.02);self.assertAlmostEqual(point[1],.01)
        self.assertAlmostEqual(abs(point[2]),math.pi)
        self.assertEqual(local_at(samples,1.,'one'),samples[0]['pose'])


if __name__=='__main__':unittest.main()
