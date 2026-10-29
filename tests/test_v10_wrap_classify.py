"""B241 误停 RED→GREEN：next 段带 strategy=turn_forward 但车头方向连续（±180 环绕）时，
应判 same_straight 免停；真正 90/180 变化才 turn。"""
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT / 'tests'))
from test_segment_execution import setup, segment


class WrapHeadingClassify(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.seq = 0
        self.loco = {'x': 0., 'y': 0., 'yaw': 0., 'stamp': 100., 'epoch': 'E1'}

    def fb(self, speed=0.):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed, 'vx': speed,
                'vy_mps': 0., 'vy_raw': 0., 'body_gear': 6, 'steering_gear': 5,
                'steering_angle': 0., 'angle_source': 'existing_chassis', 'angles': [0.] * 4}

    def mk(self, a, b, index, body_yaw, strategy=None, direction='forward', mode='4t4d'):
        d = segment(a, b, index, mode=mode, direction=direction)
        d['bodyYaw'] = body_yaw
        d['endYaw'] = body_yaw
        if strategy: d['strategy'] = strategy
        return d

    def classify(self, segs):
        m, pose = setup(segs)
        ex = m.segment_executor
        ex.index = 0
        return ex.next_action_kind()

    def test_wrap_180_equivalent_is_same_straight(self):
        """bodyYaw -180 与 180 等价（同向），即使 next 带 turn_forward 也不该停。"""
        s1 = self.mk((0, 0), (-.4, 0), 0, -math.pi)
        s2 = self.mk((-.4, 0), (-.8, 0), 1, math.pi, strategy='turn_forward')
        self.assertEqual(self.classify([s1, s2]), 'same_straight',
                         '同向（±180 环绕）不得判 turn：这正是 B241 误停原因')

    def test_real_90_turn_still_turn(self):
        s1 = self.mk((0, 0), (-.4, 0), 0, math.pi)
        s2 = self.mk((-.4, 0), (-.4, .4), 1, math.pi / 2, strategy='turn_forward')
        self.assertEqual(self.classify([s1, s2]), 'turn')

    def test_real_180_turn_still_turn(self):
        s1 = self.mk((0, 0), (-.4, 0), 0, math.pi)
        s2 = self.mk((-.4, 0), (0, 0), 1, 0., strategy='turn_forward')
        self.assertEqual(self.classify([s1, s2]), 'turn')


if __name__ == '__main__':
    unittest.main(verbosity=2)
