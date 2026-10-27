"""v11：停稳证据的位姿稳定窗口、过码速度连续性、final stop 记录。

三个问题都来自 run-20261027T135941 的真实日志：
A. Q113 停稳后融合位姿仍以 4.3 mm/s 漂移（11.3 -> 18.9 mm，fb vx=0，QR 校正仍来），
   最终偏差口径不可信 → 必须等 N 个新鲜定位样本且位姿散布/漂移速率在阈值内才 stopConfirmed，
   最终距离取稳定窗口中位数并保留 raw first/last；定位过期/仍漂移不确认，超时走既有保护。
B. same_straight 过码不停车，但 Mission.transition 重置 Tracker，
   cmd_vx 0.075 -> 0.005、fb vx 一度 -0.031 → 切段后 Tracker.previous_speed 不得清 0。
C. motion 末帧只有 4/5、stops.jsonl 被 samples=[0] 写成 zeroSamples 恒 1 →
   第 5 个 stable zero 样本即使同 tick 切 ALIGN/FINISHED 也必须写一条 final stop record。
"""
import json
import math
import os
import shutil
import statistics
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src' / 'greenhouse_navigation'))
sys.path.insert(0, str(ROOT / 'tests'))
os.environ['QR_DIAG_DISABLE'] = '1'

from greenhouse_navigation.control import Pose  # noqa: E402
from greenhouse_navigation.run_log import build_stop_record  # noqa: E402
from test_segment_execution import setup, segment  # noqa: E402


def _seg(a, b, index, mode='4t4d', direction='forward', body_yaw=0., end_yaw=0.,
         strategy=None):
    """本地显式构造 segment dict：不依赖各版本 test_segment_execution.segment 的签名。"""
    ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
    if ang > 90:
        ang -= 180
    if ang < -90:
        ang += 180
    d = {'id': str(index), 'fromId': index, 'toId': index + 1, 'mode': mode,
         'direction': direction, 'bodyYaw': body_yaw, 'endYaw': end_yaw,
         'wheelAngle': ang if mode == 'crab' else 0.,
         'points': [{'x': a[0], 'y': a[1]},
                    {'x': (a[0] + b[0]) / 2, 'y': (a[1] + b[1]) / 2},
                    {'x': b[0], 'y': b[1]}]}
    if strategy:
        d['strategy'] = strategy
    return d


class V11Base(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.seq = 0

    def fb(self, speed=0., angle=0.):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed,
                'vx': speed, 'vy_mps': 0., 'vy_raw': 0.,
                'body_gear': 6, 'steering_gear': 5,
                'steering_angle': angle, 'angle_source': 'existing_chassis',
                'angles': [angle] * 4}

    def tick(self, m, pose, speed=0., obs=None, localization=None):
        self.now += .05
        ex = m.segment_executor
        return m.tick(pose, self.fb(speed),
                      obs if obs is not None else [{'id': ex.segment['fromId']}],
                      [], .05, localization=localization)

    def enter_move(self, m, pose):
        pose.sigma = .007
        pose.stamp = 1.0
        for _ in range(120):
            self.tick(m, pose)
            if m.segment_executor.phase == 'MOVE':
                return
        self.fail('未进入 MOVE：%s' % str(m.events[:4]))

    def loc(self, freeze=False):
        """新鲜定位样本；freeze=True 时 stamp 不再前进（模拟定位过期）。"""
        if not getattr(self, '_loc_stamp', None):
            self._loc_stamp = 100.
        if not freeze:
            self._loc_stamp = self.now
        return {'mapId': 'm', 'mapVersion': 1, 'localEpoch': 'E1',
                'stamp': self._loc_stamp, 'recvMono': self._loc_stamp,
                'localOdom': {'x': 0., 'y': 0., 'yaw': 0., 'stamp': 1., 'epoch': 'E1'}}


class SameStraightContinuity(V11Base):
    """B：切段后 Tracker.previous_speed 不得清 0，第一帧不得出现 0.005 级凹陷。"""

    def enter_and_drive(self):
        m, pose = setup([_seg((0, 0), (.3, 0), 0), _seg((.3, 0), (.6, 0), 1)])
        self.enter_move(m, pose)
        ex = m.segment_executor
        last = None
        for _ in range(600):
            ex = m.segment_executor
            if ex.phase != 'MOVE':
                self.fail('中途进入 %s' % ex.phase)
            cmd = self.tick(m, pose, speed=.075)
            pose.x += cmd.vx * .05
            last = cmd
            if ex.index == 1:
                return m, ex, cmd, last
        self.fail('未跨过码边界')
        return None, None, None, None

    def test_pass_through_keeps_tracker_speed(self):
        m, ex, first_cmd, last_cmd = self.enter_and_drive()
        self.assertEqual(ex.index, 1)
        self.assertGreaterEqual(float(m.tracker.previous_speed), .05,
                                '切段后 Tracker.previous_speed 被清 0（run 实测 0.075→0.005）')

    def test_pass_through_first_command_has_no_dip(self):
        m, ex, first_cmd, last_cmd = self.enter_and_drive()
        self.assertEqual(first_cmd.mode, '4t4d', '过码必须保持 4T4D')
        self.assertEqual(first_cmd.vy, 0., '4T4D 必须 vy=0')
        self.assertGreaterEqual(first_cmd.vx, .05,
                                '过码第一帧 cmd.vx=%r 出现速度凹陷（应≈前一帧 0.075）' % (first_cmd.vx,))

    def test_hard_gates_not_relaxed_by_continuity(self):
        m, ex, first_cmd, last_cmd = self.enter_and_drive()
        self.assertFalse(ex.pass_log[-1].get('action') != 'same_straight')
        self.assertEqual(m.config['max_cross_track_m'], .05, '5cm 硬门不得被放宽')


class PoseStabilityWindow(V11Base):
    """A：连续零速后必须等位姿稳定窗口，漂移/定位过期不得确认。"""

    @staticmethod
    def turn_route():
        """两段、第二段是转向 → 第一段到码必须 END_STOP 并确认后 index 才推进。"""
        return [_seg((0, 0), (.3, 0), 0),
                _seg((.3, 0), (.3, .3), 1, body_yaw=math.pi / 2,
                     end_yaw=math.pi / 2, strategy='turn_forward')]

    def to_end_stop(self, drift=0., localization=True, freeze_before_end=False):
        m, pose = setup(self.turn_route())
        self.enter_move(m, pose)
        ex = m.segment_executor
        pose.x = .295          # 5mm
        for _ in range(400):
            cmd = self.tick(m, pose, speed=.02,
                            obs=[{'id': 1}],
                            localization=self.loc(freeze=freeze_before_end))
            if ex.phase == 'END_STOP':
                break
            pose.x += cmd.vx * .05
        self.assertEqual(ex.phase, 'END_STOP', str(m.events[:3]))
        return m, pose, ex

    def test_drifting_pose_must_not_confirm(self):
        m, pose, ex = self.to_end_stop()
        for i in range(40):
            pose.x -= .0003                      # 6 mm/s 定位漂移
            self.tick(m, pose, speed=0., obs=[{'id': 1}], localization=self.loc())
            if ex.index != 0:
                self.fail('位姿仍在漂移时就把停稳确认并推进（第 %d tick）' % (i + 1))
        self.assertEqual(ex.index, 0, '漂移期间不得推进')
        st = ex.exit_info.get('poseStability') or {}
        self.assertEqual(st.get('reason'), 'poseDrift',
                         '必须如实记录位姿不稳定，实际 %r' % (st,))
        self.assertFalse(st.get('ready'), '漂移时 ready 必须为 False')

    def test_stable_pose_confirms_after_window(self):
        m, pose, ex = self.to_end_stop()
        samples = int(m.config.get('pose_stability_samples', 5))
        # 连续零速（stable_feedback_samples 帧）之后才开始计稳定窗口，因此确认
        # 必然晚于第 5 个零速帧。断言：窗口没凑满绝不推进，凑满后必须推进。
        advanced = None
        for i in range(40):
            self.tick(m, pose, speed=0., obs=[{'id': 1}], localization=self.loc())
            if ex.index != 0:
                advanced = i
                break
            ps = ex.exit_info.get('poseStability') or {}
            self.assertFalse(ps.get('ready'), 'ready=True 却未推进（第 %d tick）' % (i + 1))
            self.assertLess(ps.get('samples') or 0, samples,
                            '未凑满 %d 个稳定样本不得确认' % samples)
        self.assertIsNotNone(advanced, '稳定窗口满足后必须确认推进：%s' % str(m.events[:3]))

    def test_stale_localization_blocks_then_timeouts(self):
        m, pose, ex = self.to_end_stop(freeze_before_end=True)
        m.config['mode_timeout_s'] = 1.0
        reason = None
        for _ in range(60):
            self.tick(m, pose, speed=0., obs=[{'id': 1}], localization=self.loc(freeze=True))
            if m.state == 'FAULT':
                break
            reason = (ex.exit_info.get('poseStability') or {}).get('reason')
            if ex.index != 0:
                self.fail('定位过期仍确认停稳')
        self.assertEqual(m.state, 'FAULT', '定位过期必须安全等待并最终超时保护：%s' % str(m.events[:4]))
        self.assertEqual(reason, 'localizationStale')

    def test_final_distance_is_median_with_raw_first_last(self):
        m, pose, ex = self.to_end_stop()
        for i in range(4):
            pose.x -= .0003                      # 先漂移几帧（窗口会被重建）
            self.tick(m, pose, speed=0., obs=[{'id': 1}], localization=self.loc())
        for _ in range(8):                       # 再以阈值内的缓慢变化稳定下来
            pose.x -= .0001                      # 2 mm/s < 2.5 mm/s 限值
            self.tick(m, pose, speed=0., obs=[{'id': 1}], localization=self.loc())
            if ex.index != 0:
                break
        fs = ex.exit_info.get('finalStop') or {}
        self.assertTrue(fs, '必须写 finalStop 停稳证据：%s' % str(ex.exit_info.keys()))
        self.assertGreaterEqual(int(fs.get('stableZeroSamples') or 0), 5,
                                'stableZeroSamples 必须是真实连续零速帧数')
        self.assertEqual(fs.get('stopReason'), 'poseStable')
        win = fs.get('window') or []
        self.assertGreaterEqual(len(win), 2, '必须保留稳定窗口原始样本')
        med = statistics.median(math.hypot(p['x'] - .3, p['y']) for p in win)
        self.assertAlmostEqual(fs['distanceM'], med, places=6,
                               msg='最终距离必须取稳定窗口中位数')
        self.assertGreaterEqual(fs['distanceRawFirstM'], 0.)
        self.assertGreaterEqual(fs['distanceRawLastM'], 0.)
        self.assertLess(round(fs['distanceRawFirstM'], 6), round(fs['distanceRawLastM'], 6),
                        '缓慢漂移下窗口首尾距离应不同，才能证明保留了 raw')
        self.assertEqual(ex.exit_info.get('poseStability', {}).get('source'), 'localization')

    def test_final_stop_recorded_once_not_duplicated(self):
        m, pose, ex = self.to_end_stop()
        for _ in range(10):
            self.tick(m, pose, speed=0., obs=[{'id': 1}], localization=self.loc())
            if ex.index != 0:
                break
        first = (ex.exit_info.get('finalStop') or {}).get('seq')
        self.assertIsNotNone(first)
        seq = first
        for _ in range(6):
            self.tick(m, pose, speed=0., obs=[{'id': 1}], localization=self.loc())
            seqs = (ex.exit_info.get('finalStop') or {}).get('seq')
            if seqs is not None:
                seq = seqs
        self.assertEqual(seq, first, '同一次停稳不得重复写 finalStop（ROW_END/FINISHED 去重）')


class FinalStopRecord(V11Base):
    """C：真实零速样本数 + 兼容字段 + 中位数距离。"""

    def test_build_stop_record_real_samples_and_compat(self):
        rec = build_stop_record(
            t=120., seg=7, to=113, pose={'x': -4.5797, 'y': .6052, 'yaw': 3.14},
            target={'x': -4.5889, 'y': .6121}, speed=0., state='FINISHED',
            samples=7, stamp=1.,
            distance_m=.0189, distance_raw_first_m=.0124, distance_raw_last_m=.0189,
            stop_reason='poseStable', pose_stability={'ready': True, 'samples': 5})
        self.assertEqual(rec['zeroSamples'], 7, '兼容字段必须用真实样本数，不再恒 1')
        self.assertEqual(rec['stableZeroSamples'], 7)
        self.assertEqual(rec['stopReason'], 'poseStable')
        self.assertAlmostEqual(rec['distance_mm'], 18.9, delta=.2)
        self.assertAlmostEqual(rec['distanceRawFirstMm'], 12.4, delta=.2)
        self.assertAlmostEqual(rec['distanceRawLastMm'], 18.9, delta=.2)
        self.assertEqual(rec['poseStability']['ready'], True)
        # 兼容：旧的按位/关键字调用仍可用
        old = build_stop_record(t=1., seg=1, to=2, pose={'x': 0., 'y': 0., 'yaw': 0.},
                                target={'x': .3, 'y': 0.}, speed=0., state='FINISHED',
                                samples=[0, 0, 0, 0, 0], stamp=None)
        self.assertEqual(old['zeroSamples'], 5)


class NodeStopRecordWiring(V11Base):
    """node._run_log_tick 必须把 finalStop 写成一条真实 stop record，且不重复。"""

    def setUp(self):
        super().setUp()
        self.tmp = tempfile.mkdtemp(prefix='v11node-')
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _node(self, m, pose):
        from greenhouse_navigation.node import GreenhouseNode
        from test_v10_no_auto_lateral import NoAutoLateral
        h = NoAutoLateral('test_midrun_dr_steers_not_crab')
        h.setUp()
        self.addCleanup(h.clock.stop)
        node = object.__new__(GreenhouseNode)
        node.mission = m
        node.pose = pose
        node.feedback = self.fb(0.)
        node.config = {'stopped_speed_mps': .015}
        node._run_log = None
        node._run_log_base = self.tmp
        node._run_log_targets = [{'seg': 1, 'from': 0, 'to': 1, 'x': .3, 'y': 0.}]
        node.execution_diagnostics = None
        node._last_send = {'sent': True, 'mode': '4t4d', 'vx': 0., 'vy': 0., 'wz': 0.}
        node._run_log_tick_loc = None
        return node

    def _stops(self):
        out = []
        for root, _, fs in os.walk(self.tmp):
            for f in fs:
                if f.startswith('stops') and f.endswith('.jsonl'):
                    for line in open(os.path.join(root, f), encoding='utf-8'):
                        if line.strip():
                            out.append(json.loads(line))
        return out

    def test_writes_final_stop_record_once(self):
        m, pose = setup([_seg((0, 0), (.3, 0), 0)])
        self.enter_move(m, pose)
        ex = m.segment_executor
        ex.exit_info['finalStop'] = {'seq': 1, 't': 1793080889.5, 'stableZeroSamples': 7,
                                     'stopReason': 'poseStable',
                                     'pose': {'x': .2911, 'y': 0., 'yaw': 0.},
                                     'window': [{'x': .2911, 'y': 0.}, {'x': .2912, 'y': 0.}],
                                     'distanceM': .0089, 'distanceRawFirstM': .0089,
                                     'distanceRawLastM': .0088,
                                     'poseStability': {'ready': True, 'samples': 5}}
        node = self._node(m, pose)
        from greenhouse_navigation import run_log as rlmod
        import greenhouse_navigation.node as node_mod
        orig = rlmod.RunLog

        with patch.object(node_mod, 'RunLog', side_effect=lambda b, r, **k: orig(self.tmp, r, **k)):
            node._run_log_ensure()
            cmd = type('C', (), {'mode': '4t4d', 'vx': 0., 'vy': 0., 'yaw_rate': 0.,
                                 'wheel_angle': 0.})()
            loc = {'localOdom': {'x': 0., 'y': 0., 'yaw': 0., 'stamp': 1., 'epoch': 'E1'}}
            node._run_log_tick(cmd, loc, 0., self.now)
            node._run_log_tick(cmd, loc, 0., self.now + .05)
            node._run_log.close(summary={})
        stops = self._stops()
        self.assertEqual(len(stops), 1, '同一次停稳只允许一条 stop record：%r' % (stops,))
        rec = stops[0]
        self.assertEqual(rec['zeroSamples'], 7)
        self.assertEqual(rec['stableZeroSamples'], 7)
        self.assertEqual(rec['stopReason'], 'poseStable')
        self.assertAlmostEqual(rec['distance_mm'], 8.9, delta=.2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
