"""node 接线测试：实际 _run_log_tick 必须写出 distance_mm / 命令 / 反馈 / 目标点。"""
import json
import math
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT / 'tests'))
os.environ['QR_DIAG_DISABLE'] = '1'

from greenhouse_navigation.node import GreenhouseNode
from test_v10_no_auto_lateral import NoAutoLateral
from test_segment_execution import setup


class NodeRunLogWiring(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='noderun-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.h = NoAutoLateral('test_midrun_dr_steers_not_crab')
        self.h.setUp(); self.addCleanup(self.h.clock.stop)
        self.m, self.pose = setup()
        self.h.enter_move(self.m, self.pose)
        self.node = object.__new__(GreenhouseNode)
        self.node.mission = self.m
        self.node.pose = self.pose
        self.node.feedback = self.h.fb(.08, .08)
        self.node.config = {'stopped_speed_mps': .015}
        self.node._run_log = None
        self.node._run_log_targets = None
        self.node.execution_diagnostics = None
        self.node._last_send = {'sent': True, 'mode': '4t4d', 'vx': .08, 'vy': 0., 'wz': .01}
        self.m.running = True
        # 目标点来自 field tags（生产同源）
        self.node._run_log_targets = [{'seg': 1, 'from': 0, 'to': 1,
                                       'x': .3, 'y': 0.}]

    def _patch_base(self, base):
        self.node._run_log_base = base

    def test_writes_motion_with_distance_and_feedback(self):
        from greenhouse_navigation import run_log
        import greenhouse_navigation.node as node_mod
        orig = run_log.RunLog
        created = {}

        def factory(base_dir, run_id, **kw):
            created['base'] = base_dir
            return orig(self.tmp, run_id, **kw)

        with patch.object(node_mod, 'RunLog', side_effect=factory):
            self.node._run_log_ensure()
            cmd = type('C', (), {'mode': '4t4d', 'vx': .08, 'vy': 0., 'yaw_rate': .01,
                                 'wheel_angle': 0.})()
            self.node._run_log_tick(cmd, {'localOdom': {'x': 0., 'y': 0., 'yaw': 0.,
                                                        'stamp': 1., 'epoch': 'E1'}},
                                    0., self.h.now)
            self.node._run_log.close(summary={})
        files = []
        for root, _, fs in os.walk(self.tmp):
            for f in fs:
                if f.startswith('motion-') and f.endswith('.jsonl'):
                    pth = os.path.join(root, f)
                    if os.path.getsize(pth) > 0:
                        files.append(pth)
        self.assertTrue(files, 'node 必须实际写出非空 motion 分片')
        rec = json.loads(open(files[0], encoding='utf-8').readline())
        self.assertIsNotNone(rec['distance_mm'], 'distance_mm 必须由 node 实际计算写入')
        self.assertAlmostEqual(rec['distance_mm'],
                               1000 * math.hypot(self.pose.x - .3, self.pose.y - 0.), delta=1.0)
        self.assertEqual(rec['mode'], '4t4d')
        self.assertEqual(rec['cmd']['vy'], 0.)
        self.assertIn('fb', rec)
        self.assertIsNotNone(rec['fb']['seq'])
        self.assertEqual(rec['send']['sent'], True)
        self.assertIsNotNone(rec['target']['x'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
