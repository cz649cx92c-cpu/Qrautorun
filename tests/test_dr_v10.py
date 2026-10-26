"""v10 DR 三项缺陷 RED/GREEN 测试（SI 横向速度 / 局部 EKF 航向增量 / QR 新鲜度）。

禁止 ROS/CAN：只用纯函数与 Mission/SegmentExecutor 生产接口。
"""
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT / 'tests'))
from greenhouse_navigation.control import Pose, wrap
from greenhouse_navigation.mission import Mission
from test_segment_execution import segment, setup


class V10LateralUnit(unittest.TestCase):
    """A) 反馈边界统一 SI 横向速度，不伪造 0、不重复缩放。"""

    def test_existing_raw_scaled_to_si(self):
        from greenhouse_navigation.segment_execution import feedback_lateral_velocity
        fb = {'vy_raw': .2, 'angle_source': 'existing_chassis'}
        self.assertAlmostEqual(feedback_lateral_velocity(fb), .02, places=9)
        fb = {'vy_raw': -.2, 'angle_source': 'existing_chassis'}
        self.assertAlmostEqual(feedback_lateral_velocity(fb), -.02, places=9)

    def test_si_field_not_scaled_again(self):
        from greenhouse_navigation.segment_execution import feedback_lateral_velocity
        fb = {'vy_mps': .02, 'vy_raw': .2, 'angle_source': 'existing_chassis'}
        self.assertAlmostEqual(feedback_lateral_velocity(fb), .02, places=9)

    def test_missing_or_nonfinite_is_none(self):
        from greenhouse_navigation.segment_execution import feedback_lateral_velocity
        self.assertIsNone(feedback_lateral_velocity({}))
        self.assertIsNone(feedback_lateral_velocity({'vy_raw': float('nan')}))
        self.assertIsNone(feedback_lateral_velocity({'vy_mps': float('inf')}))
        # 未确认的适配源不得按 0.1 强乘
        self.assertIsNone(feedback_lateral_velocity({'vy_raw': .2, 'angle_source': 'four_wheels'}))

    def test_dr_integrates_si_lateral_over_one_second(self):
        import time as _t
        m, pose = setup()
        ex = m.segment_executor
        ex.dr_start(pose, {'vy_mps': 0., 'vx': 0.}, 0.)
        st = ex.dr_state
        x0, y0 = st['pred']['x'], st['pred']['y']
        for i in range(20):   # 20 × 0.05s = 1s，vy_raw=0.2 ⇒ SI 0.02
            ex.dr_integrate({'vx': 0., 'vy_raw': .2, 'angle_source': 'existing_chassis'}, .05,
                            {'yaw': 0., 'stamp': 100. + i * .05, 'recvMono': _t.monotonic(), 'epoch': 'E1',
                             'x': 0., 'y': 0.})
        self.assertAlmostEqual(st['pred']['y'] - y0, .02, delta=.002)
        self.assertAlmostEqual(st['pred']['x'] - x0, 0., delta=1e-9)

    def test_missing_vy_does_not_fabricate_zero_motion(self):
        import time as _t
        m, pose = setup()
        ex = m.segment_executor
        ex.dr_start(pose, {'vy_mps': 0.}, 0.)
        st = ex.dr_state
        y0 = st['pred']['y']
        for i in range(20):
            ex.dr_integrate({'vx': .08, 'angle_source': 'existing_chassis'}, .05,
                            {'yaw': 0., 'stamp': 100. + i * .05, 'recvMono': _t.monotonic(), 'epoch': 'E1',
                             'x': 0., 'y': 0.})
        self.assertAlmostEqual(st['pred']['y'] - y0, 0., delta=1e-12)
        self.assertFalse(st.get('vySourceOk', True), '缺横向来源必须显式标记无效')


class V10YawUnit(unittest.TestCase):
    """B) 用局部 EKF 连续 yaw 增量；去重、顺序、新鲜、epoch。"""

    def _state(self):
        return {'last_local_yaw': 0., 'last_local_stamp': 10., 'local_epoch': 'e1'}

    def test_increment_from_local_yaw(self):
        from greenhouse_navigation.segment_execution import local_yaw_step
        st = self._state()
        dy, ok, reason = local_yaw_step(st, {'yaw': .05, 'stamp': 10.033, 'recvMono': 100.01, 'epoch': 'e1'}, 100.02)
        self.assertTrue(ok); self.assertAlmostEqual(dy, .05, places=9)
        self.assertAlmostEqual(st['last_local_stamp'], 10.033)

    def test_duplicate_stamp_not_reintegrated(self):
        from greenhouse_navigation.segment_execution import local_yaw_step
        st = self._state()
        loco = {'yaw': .05, 'stamp': 10.033, 'recvMono': 100.01, 'epoch': 'e1'}
        local_yaw_step(st, loco, 100.02)
        dy, ok, reason = local_yaw_step(st, loco, 100.07)   # 同一反馈被再次 tick
        self.assertTrue(ok); self.assertEqual(dy, 0.); self.assertEqual(reason, 'duplicate')

    def test_nonuniform_dt_accumulates_exact_increments(self):
        from greenhouse_navigation.segment_execution import local_yaw_step
        st = self._state()
        total = 0.
        seq = [(10.02, .01), (10.09, .034), (10.10, .036), (10.30, .088)]
        for stamp, yaw in seq:
            dy, ok, _ = local_yaw_step(st, {'yaw': yaw, 'stamp': stamp, 'recvMono': 100.49, 'epoch': 'e1'}, 100.5)
            self.assertTrue(ok); total += dy
        self.assertAlmostEqual(total, .088, places=9)

    def test_wrap_across_pi(self):
        from greenhouse_navigation.segment_execution import local_yaw_step
        st = {'last_local_yaw': 3.10, 'last_local_stamp': 10., 'local_epoch': 'e1'}
        dy, ok, _ = local_yaw_step(st, {'yaw': -3.10, 'stamp': 10.033, 'recvMono': 100., 'epoch': 'e1'}, 100.02)
        self.assertTrue(ok); self.assertAlmostEqual(dy, wrap(-3.10 - 3.10), places=9)

    def test_reversed_stale_epoch_rejected(self):
        from greenhouse_navigation.segment_execution import local_yaw_step
        st = self._state()
        dy, ok, reason = local_yaw_step(st, {'yaw': .1, 'stamp': 9., 'recvMono': 100., 'epoch': 'e1'}, 100.02)
        self.assertFalse(ok); self.assertEqual(reason, 'stampReversed')
        dy, ok, reason = local_yaw_step(st, {'yaw': .1, 'stamp': 11., 'recvMono': 99., 'epoch': 'e1'}, 100.5)
        self.assertFalse(ok); self.assertEqual(reason, 'stale')
        dy, ok, reason = local_yaw_step(st, {'yaw': .1, 'stamp': 12., 'recvMono': 100., 'epoch': 'e2'}, 100.02)
        self.assertFalse(ok); self.assertEqual(reason, 'epochChanged')


class V10QrFreshness(unittest.TestCase):
    """C) QR 新鲜度/重锚以真实 QR 源 stamp + 接收单调计时，不用融合 pose.stamp。"""

    def setUp(self):
        self.now = 100.
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.m, self.pose = setup()
        tile = .0235
        self.m.field['groups'] = [{'id': 'B001', 'referenceId': 1, 'gridSize': 4, 'sizeMm': 100, 'gapMm': 2,
             'members': [{'id': 1 + i, 'x': (i % 4 - 1.5) * .0255, 'y': (1.5 - i // 4) * .0255,
                          'angle': 0., 'size': tile / 1.25} for i in range(16)]}]
        self.seq = 0

    def fb(self, mode='4t4d', angle=0., speed=.08, vx=.08, vy_raw=0.):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed, 'vx': vx,
                'vy_raw': vy_raw, 'vy_mps': 0., 'body_gear': 8 if mode == 'crab' else 6,
                'steering_gear': 7 if mode == 'crab' else 5, 'steering_angle': angle,
                'angle_source': 'existing_chassis', 'angles': [angle] * 4}

    def tick(self, loc=None, obs=None, stamp=None, speed=.08):
        self.now += .05
        ex = self.m.segment_executor
        mode = 'crab' if ex.phase.startswith('CENTER') else self.m.mode
        if ex.phase != 'MOVE': speed = 0.
        if stamp is not None: self.pose.stamp = stamp
        obs = obs if obs is not None else [{'id': ex.segment['fromId']}]
        return self.m.tick(self.pose, self.fb(mode, self.m.target_angle if mode != 'crab' else 0., speed),
                           obs, [], .05, localization=loc)

    def enter_move(self):
        self.pose.stamp = 1.0
        self.pose.sigma = .007
        for _ in range(25):
            self.tick(loc={'mapId': 'm1', 'localEpoch': 'e1'})
            if self.m.segment_executor.phase == 'MOVE':
                break
        for _ in range(2):
            self.tick(stamp=1.0)
        self.assertIsNotNone(self.m.segment_executor.dr_state)

    def loc(self, qr_stamp=None, quality_ok=True, epoch='e1', qr_age_s=0.):
        loc = {'mapId': 'm1', 'localEpoch': epoch}
        if qr_stamp is not None:
            obs = [{'id': self.m.segment_executor.segment['toId'], 'groupId': 'B001',
                    'visibleCount': 12 if quality_ok else 2, 'sigma': .01 if quality_ok else .03}]
            loc['qrObservation'] = {'sourceStamp': qr_stamp, 'recvMono': self.now - qr_age_s,
                                    'localEpoch': epoch, 'mapId': 'm1'}
            return loc, obs
        return loc, [{'id': self.m.segment_executor.segment['fromId']}]

    def test_pose_stamp_advancing_does_not_reset_qr_staleness(self):
        self.enter_move()
        for i in range(8):   # 融合 pose stamp 连续前进、QR 停止
            self.tick(stamp=2.0 + i * .05, loc={'mapId': 'm1', 'localEpoch': 'e1'})
        state = self.m.segment_executor.dr_state
        self.assertGreater(state['staleS'], .25, '融合 pose 刷新不得重置 QR 失联计时')
        self.assertGreaterEqual(state.get('corrections', 0), 0)

    def test_accepted_event_anchors_then_duplicate_correction_ignored(self):
        self.enter_move()
        st = self.m.segment_executor.dr_state
        # 无 accepted 事件前不得锚定
        for i in range(6):
            self.tick(stamp=2.0 + i * .05, loc={'mapId': 'm1', 'localEpoch': 'e1'})
        self.assertFalse(st.get('anchor_valid', True), '无 accepted 事件不得锚定')
        ev = {'kind': 'update', 'correctionId': 'c1', 'sourceStamp': 5.0,
              'recvMono': self.now, 'recvMonoLocal': self.now,
              'mapId': 'm1', 'mapVersion': 5, 'localEpoch': 'e1', 'scopeGeneration': 1,
              'anchorPose': [self.pose.x, self.pose.y, self.pose.yaw], 'sigma': .008,
              'posteriorStamp': 100.0,
              'localRef': {'x': self.pose.x, 'y': self.pose.y, 'yaw': self.pose.yaw,
                           'stamp': 100.0}}
        loc = {'mapId': 'm1', 'localEpoch': 'e1', 'qrAnchor': ev,
               'localOdom': {'x': self.pose.x, 'y': self.pose.y, 'yaw': self.pose.yaw,
                             'stamp': 100.0, 'recvMono': self.now, 'epoch': 'e1'}}
        self.tick(loc=loc, stamp=2.4)
        self.assertTrue(st.get('anchor_valid'), '合格 accepted 事件必须建立锚')
        # 同一 correctionId 重复到达不得重复处理
        before = st.get('corrections', 0)
        self.tick(loc=loc, stamp=2.45)
        self.assertEqual(st.get('corrections', 0), before, '重复 correctionId 不得重复重锚')
        # 只有裸观测（无事件）不得再刷新/重锚
        loc2 = {'mapId': 'm1', 'localEpoch': 'e1',
                'qrRaw': {'sourceStamp': 6.0, 'recvMono': self.now, 'localEpoch': 'e1', 'mapId': 'm1'}}
        self.tick(loc=loc2, stamp=2.5,
                  obs=[{'id': self.m.segment_executor.segment['toId'], 'groupId': 'B001',
                        'visibleCount': 16, 'sigma': .008}])
        self.assertEqual(st.get('corrections', 0), before, '仅裸观测不得重锚')

    def test_low_quality_or_wrong_epoch_does_not_refresh(self):
        self.enter_move()
        for i in range(8):
            self.tick(stamp=2.0 + i * .05, loc={'mapId': 'm1', 'localEpoch': 'e1'})
        st = self.m.segment_executor.dr_state
        stale0 = st['staleS']; corr0 = st.get('corrections', 0)
        loc, obs = self.loc(qr_stamp=6.0, quality_ok=False)
        self.tick(loc=loc, obs=obs, stamp=2.5)
        self.assertEqual(st.get('corrections', 0), corr0)
        self.assertGreaterEqual(st['staleS'], stale0, '低质量 QR 不得刷新新鲜计时')
        loc2, obs2 = self.loc(qr_stamp=7.0, epoch='e2')
        self.tick(loc=loc2, obs=obs2, stamp=2.55)
        self.assertEqual(st.get('corrections', 0), corr0, '错 epoch 不得重锚')

    def test_long_qr_gap_is_not_fault(self):
        self.enter_move()
        for i in range(260):   # 13s 无码
            self.tick(stamp=2.0 + i * .05, loc={'mapId': 'm1', 'localEpoch': 'e1'})
        self.assertNotEqual(self.m.state, 'FAULT', '正常 1.2m/十多秒无码不得判故障')


if __name__ == '__main__':
    unittest.main(verbosity=2)
