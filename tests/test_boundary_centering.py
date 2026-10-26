"""v10 到码边界语义：不再自动横移对中；硬门内进下一计划动作，超过 5cm 停车。

取代旧 boundary_centering 的“到码 crab 对中”断言；保留超硬门停车、低质量不误动作、
计划 crab 路线保留等安全/兼容意图。
"""
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT / 'tests'))
from test_segment_execution import setup, segment


class BoundaryNoLateralTests(unittest.TestCase):
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

    def tick(self, m, pose, obs=None):
        self.now += .05
        self.loco = {'x': pose.x, 'y': pose.y, 'yaw': pose.yaw,
                     'stamp': self.loco['stamp'] + .05, 'epoch': 'E1'}
        ex = m.segment_executor
        return m.tick(pose, self.fb(.08 if ex.phase == 'MOVE' else 0.),
                      obs if obs is not None else [{'id': ex.segment['fromId']}], [], .05,
                      localization={'mapId': (m.field or {}).get('id'), 'localEpoch': 'E1',
                                    'localOdom': dict(self.loco)})

    def enter_move(self, m, pose):
        pose.sigma = .007; pose.stamp = 1.0
        for _ in range(80):
            self.tick(m, pose)
            if m.segment_executor.phase == 'MOVE':
                return
        self.fail('未进入 MOVE：%s' % str(m.events))

    def reach_boundary(self, m, pose, cross_offset=0.):
        self.enter_move(m, pose)
        for _ in range(200):
            cmd = self.tick(m, pose)
            pose.x += cmd.vx * .05
            if m.state == 'ROW_END':
                break
        self.assertEqual(m.state, 'ROW_END')
        self.pose_x = None
        pose.x = m.segment_executor.segment['points'][-1]['x'] + cross_offset
        toid = m.segment_executor.segment['toId']
        cmds = []
        for _ in range(80):
            cmd = self.tick(m, pose, obs=[{'id': toid}])
            cmds.append(cmd)
            if m.segment_executor.index > 0 or m.state == 'FAULT':
                break
        return cmds

    def test_positive_2_5cm_advances_without_crab(self):
        m, pose = setup()
        cmds = self.reach_boundary(m, pose, +.025)
        self.assertNotEqual(m.state, 'FAULT')
        self.assertGreater(m.segment_executor.index, 0, '硬门内应直接进入下一计划动作')
        self.assertTrue(all(abs(c.vy) == 0. for c in cmds), str([c.vy for c in cmds][:5]))
        self.assertFalse(m.segment_executor.phase.startswith('CENTER'))

    def test_negative_2_5cm_advances_without_crab(self):
        m, pose = setup()
        cmds = self.reach_boundary(m, pose, -.025)
        self.assertNotEqual(m.state, 'FAULT')
        self.assertGreater(m.segment_executor.index, 0)
        self.assertTrue(all(abs(c.vy) == 0. for c in cmds))
        self.assertFalse(m.segment_executor.phase.startswith('CENTER'))

    def test_centered_advances_without_crab(self):
        m, pose = setup()
        cmds = self.reach_boundary(m, pose, 0.)
        self.assertNotEqual(m.state, 'FAULT')
        self.assertGreater(m.segment_executor.index, 0)
        self.assertTrue(all(abs(c.vy) == 0. for c in cmds))
        self.assertFalse(m.segment_executor.phase.startswith('CENTER'))

    def test_over_5cm_still_faults(self):
        s1 = segment((0, 0), (.3, 0))
        s2 = {'id': 's2', 'fromId': 1, 'toId': 2, 'mode': '4t4d', 'direction': 'forward',
              'strategy': 'turn_forward', 'bodyYaw': math.pi / 2, 'endYaw': math.pi / 2,
              'wheelAngle': 0.,
              'points': [{'x': .3, 'y': 0.}, {'x': .3, 'y': .15}, {'x': .3, 'y': .3}]}
        m, pose = setup([s1, s2])
        self.reach_boundary(m, pose, +.056)
        self.assertEqual(m.state, 'FAULT', str(m.events[:3]))
        self.assertIn('硬门', ' | '.join(m.events))

    def test_no_crab_while_residual_within_gate(self):
        m, pose = setup()
        self.enter_move(m, pose)
        bad = []
        for _ in range(120):
            cmd = self.tick(m, pose)
            if cmd.mode == 'crab' and m.segment_executor.index == 0:
                bad.append(cmd.vy)
            pose.x += cmd.vx * .05
            if m.state != 'FORWARD' and m.segment_executor.index == 0:
                break
        self.assertFalse(bad, '本段行驶中不得出现 crab 横移')

    def test_low_sigma_does_not_trigger_lateral(self):
        m, pose = setup()
        pose.sigma = .08   # 低质量/大 sigma：旧实现会阻止对中；新语义不得产生横移
        cmds = self.reach_boundary(m, pose, +.025)
        self.assertFalse(any(c.mode == 'crab' and abs(c.vy) > 1e-9 for c in cmds), '零速计划 crab 命令不算自动横移')
        self.assertNotEqual(m.state, 'FAULT')

    def test_boundary_cross_recorded_for_diagnostics(self):
        s1 = segment((0, 0), (.3, 0))
        s2 = {'id': 's2', 'fromId': 1, 'toId': 2, 'mode': '4t4d', 'direction': 'forward',
              'strategy': 'turn_forward', 'bodyYaw': math.pi / 2, 'endYaw': math.pi / 2,
              'wheelAngle': 0.,
              'points': [{'x': .3, 'y': 0.}, {'x': .3, 'y': .15}, {'x': .3, 'y': .3}]}
        m, pose = setup([s1, s2])
        self.reach_boundary(m, pose, +.025)
        self.assertIn('boundaryCrossM', m.segment_executor.exit_info)
        self.assertLessEqual(abs(m.segment_executor.exit_info['boundaryCrossM']), .05)

    def test_planned_crab_next_segment_kept(self):
        # 默认路线第二段是显式 crab：到码后应进入该计划动作（不因“禁止自动横移”被拦）。
        m, pose = setup()
        self.reach_boundary(m, pose, +.025)
        self.assertGreater(m.segment_executor.index, 0)
        self.assertNotEqual(m.state, 'FAULT')


if __name__ == '__main__':
    unittest.main(verbosity=2)
