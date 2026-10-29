"""B241 误停 RED→GREEN：用真实 route snapshot 段做分类验证（±180 环绕应同向免停）。"""
import json, math, sqlite3, sys, unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT / 'tests'))
from greenhouse_navigation.segment_execution import SegmentExecutor
import types


def real_segments():
    c = sqlite3.connect('file:' + str(ROOT / 'maps' / 'navigation.db') + '?mode=ro', uri=True)
    body = c.execute("select body from tasks where id=?",
                     ('task-route-aef3d96bb638d6fd97dedac8',)).fetchone()[0]
    return json.loads(body)['routeSnapshot']['motionSegments']


class RealRouteClassify(unittest.TestCase):
    def setUp(self):
        self.clock = patch('time.monotonic', lambda: 100.)
        self.clock.start(); self.addCleanup(self.clock.stop)

    def classify(self, segs, index):
        ns = types.SimpleNamespace(task={}, field={}, config={}, localization={},
                                   fault=lambda msg: None, running=True, state='FORWARD')
        ex = SegmentExecutor(ns, segs)
        ex.index = index
        return ex.next_action_kind()

    def test_seg1_to_2_same_straight(self):
        """真实 route：Q257→Q241 后接 Q241→Q193，bodyYaw -180→180（同向），不得停车。"""
        segs = real_segments()
        self.assertEqual(self.classify(segs, 0), 'same_straight',
                         'B241 后同向直行被误判为 turn（本次实车停车的根因）')

    def test_seg6_to_7_same_straight(self):
        segs = real_segments()
        self.assertEqual(self.classify(segs, 5), 'same_straight')

    def test_real_90_turn_is_turn(self):
        segs = real_segments()   # seg2->3: 180 -> 90
        self.assertEqual(self.classify(segs, 1), 'turn')

    def test_final_is_final(self):
        segs = real_segments()
        self.assertEqual(self.classify(segs, len(segs) - 1), 'final')


if __name__ == '__main__':
    unittest.main(verbosity=2)
