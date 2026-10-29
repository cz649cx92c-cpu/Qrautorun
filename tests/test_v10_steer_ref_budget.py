"""v10 steer ref/episode 预算 RED→GREEN（生产 mission/segment 链，真实 node 回调产物上下文）。

覆盖：episode 计数、ref 跟随最新 cross、失效/换段/新锚不可消费、4T4D 距离累计、
距离/超时结束无旧 override、连续收敛才 completed、5cm 硬门仍停车。
"""
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT / 'tests'))
from greenhouse_navigation.control import Pose
from test_v10_no_auto_lateral import NoAutoLateral
from test_segment_execution import setup


class _Harness(NoAutoLateral):
    """补上生产 context 必有的 localOdom.recvMono（仅测试夹具，不改既有测试文件）。"""
    def tick(self, m, pose, anchor=True, raw=None, vy=0., vx=.08, obs=None):
        self.now += .05
        self.loco = {'x': pose.x, 'y': pose.y, 'yaw': pose.yaw,
                     'stamp': self.loco['stamp'] + .05, 'epoch': 'E1', 'recvMono': self.now}
        ex = m.segment_executor
        loc = {'mapId': (m.field or {}).get('id'), 'mapVersion': 5, 'localEpoch': 'E1',
               'localOdom': dict(self.loco)}
        if anchor:
            self._ev = getattr(self, '_ev', 0) + 1
            loc['qrAnchor'] = {'kind': 'update', 'correctionId': 'ev%d' % self._ev,
                               'sourceStamp': self.now - .1, 'recvMono': self.now,
                               'recvMonoLocal': self.now, 'mapId': loc['mapId'], 'mapVersion': 5,
                               'localEpoch': 'E1', 'scopeGeneration': 1,
                               'anchorPose': [pose.x, pose.y, pose.yaw], 'sigma': .008,
                               'posteriorStamp': self.loco['stamp'] - .05,
                               'localRef': {'x': pose.x, 'y': pose.y, 'yaw': pose.yaw,
                                            'stamp': self.loco['stamp'] - .05}}
        if raw is not None:
            loc['qrRaw'] = raw
        moving = ex.phase == 'MOVE'
        return m.tick(pose, self.fb(speed=.08 if moving else 0., vy=vy if moving else 0.,
                                    vx=vx if moving else 0.),
                      obs if obs is not None else [{'id': ex.segment['fromId']}], [], .05,
                      localization=loc)


class SteerRefEpisode(unittest.TestCase):
    def setUp(self):
        self.h = _Harness('test_midrun_dr_steers_not_crab')
        self.h.setUp(); self.addCleanup(self.h.clock.stop)
        self.m, self.pose = setup()
        self.h.enter_move(self.m, self.pose)
        self.m.config['dr_steer_distance_m'] = .5
        self.m.config['dr_steer_timeout_s'] = 3.0

    def st(self):
        return self.m.segment_executor.dr_state

    def drive(self, n, vy, vx=.08):
        cmds = []
        for _ in range(n):
            cmd = self.h.tick(self.m, self.pose, vy=vy, vx=vx, anchor=False)
            cmds.append(cmd)
            yaw = self.pose.yaw
            self.pose.x += (cmd.vx * math.cos(yaw) - cmd.vy * math.sin(yaw)) * .05
            self.pose.y += (cmd.vx * math.sin(yaw) + cmd.vy * math.cos(yaw)) * .05
            self.pose.yaw += cmd.yaw_rate * .05
            if self.m.segment_executor.phase != 'MOVE' or self.m.state == 'FAULT':
                break
        return cmds

    def test_attempts_not_per_tick(self):
        self.drive(10, .03)
        ep = self.st()['steerEpisode']
        self.assertEqual(ep['attempts'], 1, '连续 tick 不得消耗多次预算')
        self.assertEqual(self.st().get('mechanicalCorrections'), 1)
        self.assertTrue(ep['active'])

    def test_steer_ref_tracks_latest_cross(self):
        self.drive(8, .03)
        ref1 = self.st().get('steerRefM')
        self.assertIsNotNone(ref1)
        self.drive(6, .05)
        ref2 = self.st().get('steerRefM')
        self.assertIsNotNone(ref2)
        self.assertGreater(abs(ref2 - ref1), 1e-4, 'ref 必须随最新预测 cross 更新')
        self.assertAlmostEqual(ref2, self.st()['crossM'], delta=.005)

    def test_ref_invalid_on_needs_anchor(self):
        self.drive(6, .03)
        self.st()['needs_anchor'] = True
        cmd = self.h.tick(self.m, self.pose, vy=.03, anchor=False)
        self.assertFalse(self.st().get('steerRefValid'))
        self.assertEqual(self.st().get('steerRefReason'), 'needs_anchor')
        self.assertEqual(self.m.segment_executor.exit_info.get('steeringSource'), 'fused_4t4d')
        self.assertNotEqual(cmd.mode, 'crab')
        self.assertEqual(abs(cmd.vy), 0.)

    def test_ref_invalid_on_qr_visible_rejected(self):
        self.drive(6, .03)
        self.st()['qr_qualified_mono'] = self.h.now - 1.0   # 使 accepted 过期，模拟"可见但未被接受"
        raw = {'sourceStamp': 5.0, 'recvMono': self.h.now, 'localEpoch': 'E1',
               'mapId': (self.m.field or {}).get('id')}
        cmd = self.h.tick(self.m, self.pose, vy=.03, raw=raw, anchor=False)
        self.assertFalse(self.st().get('steerRefValid'))
        self.assertEqual(self.st().get('steerRefReason'), 'qr_visible_rejected')
        self.assertEqual(abs(cmd.vy), 0.)

    def test_stale_segment_ref_not_consumed(self):
        self.drive(6, .03)
        st = self.st()
        st['steerRefSegment'] = self.m.segment_executor.index - 1
        self.h.tick(self.m, self.pose, vy=.03)
        self.assertEqual(self.m.segment_executor.exit_info.get('steeringSource'), 'fused_4t4d',
                         '换段后旧 ref 不得消费')

    def test_reanchor_clears_episode(self):
        self.drive(6, .03)
        self.assertTrue(self.st()['steerEpisode']['active'])
        self.h.tick(self.m, self.pose, vy=.03, anchor=True)
        ep = self.st()['steerEpisode']
        self.assertFalse(ep['active'], '新 accepted 锚必须清旧 episode')
        self.assertIn(ep['reason'], ('reanchor', 'anchored'))
        self.assertFalse(self.st().get('steerRefValid'))

    def test_distance_accumulates_along_vx(self):
        self.drive(10, .03, vx=.08)
        ep = self.st()['steerEpisode']
        self.assertGreater(ep['distance'], .01, '4T4D episode 必须累计沿行进距离')
        self.assertLessEqual(ep['distance'], .08 * .05 * 12 + .01)

    def test_distance_limit_ends_episode_and_no_override(self):
        self.m.config['dr_steer_distance_m'] = .01
        self.drive(10, .03)
        ep = self.st()['steerEpisode']
        self.assertFalse(ep['active'])
        self.assertEqual(ep['reason'], 'distance')
        self.assertFalse(self.st().get('steerRefValid'))
        cmd = self.h.tick(self.m, self.pose, vy=.03, anchor=False)
        self.assertEqual(self.m.segment_executor.exit_info.get('steeringSource'), 'fused_4t4d')

    def test_completed_after_consecutive_convergence(self):
        self.drive(6, .03)
        # 反向漂移让预测 cross 下降，连续到目标内
        for _ in range(120):
            self.drive(1, -.03)
            st = self.st()
            if st['steerEpisode'].get('completed', 0) >= 1:
                break
            if st['steerEpisode']['active'] is False:
                break
        ep = self.st()['steerEpisode']
        self.assertGreaterEqual(ep.get('completed', 0), 1, '连续收敛后才计 completed：%r' % ep)
        self.assertFalse(ep['active'])

    def test_hard_gate_still_faults(self):
        for _ in range(400):
            self.h.tick(self.m, self.pose, vy=.06, anchor=False)
            if self.m.state == 'FAULT':
                break
        self.assertEqual(self.m.state, 'FAULT', '5cm 绝对硬门必须仍停车')
        self.assertFalse(self.st().get('steerRefValid'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
