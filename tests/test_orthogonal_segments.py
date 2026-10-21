"""正交/直线区间执行门禁（不加载 ROS、不碰 CAN）。"""
import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
from greenhouse_navigation.segment_execution import validate_segments  # noqa: E402


def straight(a, b, mode='4t4d', direction='forward', body_yaw=0.):
    midpoint = {'x': (a[0] + b[0]) / 2, 'y': (a[1] + b[1]) / 2}
    return {'id': 'seg', 'fromId': 0, 'toId': 1, 'mode': mode, 'direction': direction,
            'bodyYaw': body_yaw, 'endYaw': body_yaw, 'wheelAngle': 0.,
            'points': [{'x': a[0], 'y': a[1]}, midpoint, {'x': b[0], 'y': b[1]}]}


class OrthogonalSegments(unittest.TestCase):
    def test_horizontal_and_vertical_straight_segments_pass(self):
        validate_segments([straight((0, 0), (1, 0))])
        validate_segments([straight((0, 0), (0, 1), body_yaw=math.pi / 2)])
        validate_segments([straight((0, 0), (-.4, 0), '4t4d', 'reverse')])

    def test_straight_crab_diagonal_is_still_a_straight_line(self):
        # crab 平移可以沿斜向直线（轮角 45°），但必须是直线，不能是弧线。
        segment = straight((0, 0), (.5, .5), 'crab', 'lateral')
        segment['wheelAngle'] = 45.
        validate_segments([segment])

    def test_arc_or_bent_trace_is_rejected(self):
        curved = {'id': 'seg', 'fromId': 0, 'toId': 1, 'mode': '4t4d', 'direction': 'forward',
                  'bodyYaw': 0., 'endYaw': 0., 'wheelAngle': 0.,
                  'points': [{'x': 0., 'y': 0.}, {'x': .5, 'y': .25}, {'x': 1., 'y': 0.}]}
        with self.assertRaisesRegex(ValueError, '直线段'):
            validate_segments([curved])
        arc = {'id': 'seg', 'fromId': 0, 'toId': 1, 'mode': 'crab', 'direction': 'lateral',
               'bodyYaw': 0., 'endYaw': 0., 'wheelAngle': 0.,
               'points': [{'x': 0., 'y': 0.}, {'x': .3, 'y': .2}, {'x': .6, 'y': 0.}]}
        with self.assertRaisesRegex(ValueError, '直线段'):
            validate_segments([arc])

    def test_existing_safety_gates_still_apply(self):
        mismatch = straight((0, 0), (1, 0))
        mismatch['bodyYaw'] = math.pi
        with self.assertRaises(ValueError):
            validate_segments([mismatch])
        crab_bad_angle = straight((0, 0), (0, 1), 'crab', 'lateral')
        crab_bad_angle['wheelAngle'] = 0.
        with self.assertRaises(ValueError):
            validate_segments([crab_bad_angle])


if __name__ == '__main__':
    unittest.main(verbosity=2)
