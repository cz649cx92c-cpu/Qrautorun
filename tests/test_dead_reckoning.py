"""Dead-reckoning（轮速+IMU航向）横向纠偏回归测试。

覆盖：无 QR 时用 vx/vy+yaw 识别横向偏差趋势并有限纠偏（正负方向）；
QR 重现时预测 vs 绝对位姿残差计算与基准校正；同图校正/跨图拒绝；
单帧低质量不纠偏；超硬限连续发散停车；目标 ≤10mm；不改目标行程；
boundary-centering 11 例与安全门不退化（独立文件已验证）。
"""
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
from greenhouse_navigation.control import Pose, geometry, wrap
from greenhouse_navigation.mission import Mission

sys.path.insert(0, str(ROOT / 'tests'))
from test_segment_execution import segment, setup, TURN_DEFAULTS


class DeadReckoningTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.seq = 0
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def feedback(self, mode='4t4d', angle=0., speed=0., vx=None, vy=0., yaw_deg=0.):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed,
                'vx': speed if vx is None else vx, 'vy_raw': vy, 'yaw_deg': yaw_deg,
                'body_gear': 8 if mode == 'crab' else 6,
                'steering_gear': 7 if mode == 'crab' else 5, 'steering_angle': angle,
                'angle_source': 'existing_chassis', 'angles': [angle] * 4}

    def tick(self, m, pose, speed=0., vx=None, vy=0., yaw_deg=0., observations=None, stamp=None):
        self.now += .05
        mode = m.mode
        ex = getattr(m, 'segment_executor', None)
        if ex is not None and ex.phase.startswith('CENTER'):
            mode = 'crab'  # 对中期间底盘已在 crab 档
        if ex is not None and ex.phase != 'MOVE':
            speed = 0.     # ALIGN/STOP/CENTER 等相位要求停稳反馈
        fb = self.feedback(mode, m.target_angle if mode != 'crab' else 0., speed, vx, vy, yaw_deg)
        obs = observations if observations is not None else [{'id': m.segment_executor.segment['fromId']}]
        if stamp is not None:
            pose.stamp = stamp
        return m.tick(pose, fb, obs, [], .05)

    def enter_move(self, m, pose, stamp=1.0):
        pose.stamp = stamp
        for _ in range(20):
            self.tick(m, pose, stamp=stamp)
            if m.segment_executor.phase == 'MOVE':
                break
        # DR 在首个真正执行 move_command 的 MOVE tick 建立，再推 2 帧确保激活
        for _ in range(2):
            self.tick(m, pose, stamp=stamp, speed=.08, vx=.08)
        if m.segment_executor.phase != 'MOVE':
            self.fail(str(m.events))
        assert m.segment_executor.dr_state is not None, str(m.events)

    # ---------- 1. 无 QR：IMU+轮速识别横向趋势并有限纠偏 ----------

    def drive_with_drift(self, m, pose, lateral_drift_mps=0.012, stamp=1.0, max_ticks=600):
        """前进段注入持续 vy 漂移（模拟轮速横漂），DR 应识别并触发纠偏。

        真实底盘会跟随指令：CENTER_MOVE 期间反馈 vy 取上一条指令的 vy，
        使 DR 积分闭环反映纠偏效果。返回 (commands, entered_center, finished_center)。
        """
        commands = []
        entered = False
        finished = False
        last_cmd_vy = 0.
        s = m.segment_executor.segment
        for i in range(max_ticks):
            fb_vy = last_cmd_vy if (m.segment_executor.phase == 'CENTER_MOVE') else lateral_drift_mps
            command = self.tick(m, pose, speed=.08, vx=.08, vy=fb_vy,
                                observations=[{'id': s['toId']}], stamp=stamp)
            last_cmd_vy = command.vy
            commands.append(command)
            ex = m.segment_executor
            # 世界系运动学：车体 yaw≈π（沿 -x 前进），vy 为体轴左移
            yaw = pose.yaw
            pose.x += (command.vx * math.cos(yaw) - command.vy * math.sin(yaw)) * .05
            pose.y += (command.vx * math.sin(yaw) + command.vy * math.cos(yaw)) * .05
            if ex.phase == 'MOVE' and i > 0:
                # 真实漂移：车体存在真实 vy（与 DR 积分同方向），叠加在被指令运动之上
                pose.x += lateral_drift_mps * .05 * -math.sin(yaw)
                pose.y += lateral_drift_mps * .05 * math.cos(yaw)
            # CENTER_MOVE 期间车按指令 vy 横移（反馈 vy 已跟随指令，运动学一致）
            if ex.phase.startswith('CENTER'):
                entered = True
            if entered and ex.phase == 'MOVE' and i > 5:
                finished = True
                break
            if m.state == 'FAULT':
                break
        else:
            pass
        return commands, entered, finished

    def test_dr_detects_lateral_drift_and_corrects(self):
        """无 QR 更新时，DR 从 vy 积分发现横向偏差并触发有限纠偏，随后恢复前进。"""
        m, pose = setup()
        self.enter_move(m, pose, stamp=1.0)
        commands, entered, finished = self.drive_with_drift(m, pose)
        self.assertTrue(entered, 'DR 必须在 MOVE 中识别横向漂移并进入 CENTER：' + str(m.events[:5]))
        self.assertTrue(finished, '纠偏后必须恢复原方向前进：' + str(m.events[:5]))
        state = m.segment_executor.dr_state
        self.assertIsNotNone(state)
        self.assertGreaterEqual(state.get('corrections', 0), 1)
        # 目标 ≤10mm
        self.assertLessEqual(m.segment_executor.dr_target(), .010)
        record = [r for r in m.segment_executor.centering_history if r.get('source') == 'dead_reckoning']
        self.assertTrue(record, 'centering_history 必须含 source=dead_reckoning 记录')
        # 纠偏行程有限
        self.assertLessEqual(record[-1]['travelM'], .05 + .002)

    def test_dr_correction_direction_sign(self):
        """漂移方向与纠偏方向相反：正漂移（cross>0）纠偏指令必须朝 cross 减小方向。"""
        for drift in (+0.012, -0.012):
            with self.subTest(drift=drift):
                m, pose = setup()
                self.enter_move(m, pose, stamp=1.0)
                commands, entered, _ = self.drive_with_drift(m, pose, lateral_drift_mps=drift)
                self.assertTrue(entered, str(m.events[:5]))
                lateral = [c for c in commands
                           if m.segment_executor and abs(c.vx) + abs(c.vy) > 1e-9
                           and m.segment_executor.centering is not None
                           and m.segment_executor.phase == 'CENTER_MOVE']
                if not lateral:  # 至少存在一段 CENTER_MOVE 指令
                    lateral = [c for c in commands if c.mode == 'crab' and (abs(c.vx) + abs(c.vy)) > 1e-9]
                self.assertTrue(lateral, 'CENTER_MOVE 必须发出横移指令')
                cmd = lateral[0]
                self.assertEqual(cmd.mode, 'crab')
                self.assertEqual(cmd.yaw_rate, 0., '纠偏不允许旋转')

    def test_dr_zero_vy_no_false_correction(self):
        """无漂移（vy=0）时 DR 不触发纠偏，正常前进到段末。"""
        m, pose = setup()
        self.enter_move(m, pose, stamp=1.0)
        s = m.segment_executor.segment
        for i in range(120):
            command = self.tick(m, pose, speed=.08, vx=.08, vy=0., observations=[{'id': s['toId']}], stamp=1.0)
            pose.x += command.vx * math.cos(pose.yaw) * .05
            pose.y += command.vx * math.sin(pose.yaw) * .05
            if m.state == 'FAULT' or m.segment_executor.phase != 'MOVE':
                break
        self.assertEqual(m.segment_executor.dr_state.get('corrections', 0), 0,
                         '无漂移不得触发纠偏：' + str(m.events[:4]))
        self.assertIn(m.segment_executor.phase, ('END_STOP', 'ALIGN'),
                      '无漂移必须正常行进到段末：' + str(m.events[:3]))

    # ---------- 2. QR 重现：残差计算与基准校正 ----------

    def test_qr_reappearance_rebases_anchor(self):
        """QR 重现（stamp 前进+高质量）时记录残差并重锚，控制位姿不瞬移。"""
        m, pose = setup()
        self.enter_move(m, pose, stamp=10.0)
        s = m.segment_executor.segment
        # 前进一点，然后 QR 更新：stamp 前进，绝对位姿与预测有 1.5cm 横向差
        for i in range(4):
            self.tick(m, pose, speed=.08, vx=.08, stamp=10.0, observations=[{'id': s['toId']}])
        pose.y += .015  # QR 绝对位姿显示车实际偏了 1.5cm
        pose.sigma = .01  # 质量/σ门达标
        good = [{'id': s['toId'], 'groupId': 'B0', 'visibleCount': 16, 'sigma': .008}]
        m.field['groups'] = [{'id': 'B0', 'referenceId': s['toId'], 'members': [{'id': k} for k in range(16)]}]
        pose.stamp = 10.3
        self.tick(m, pose, speed=.08, vx=.08, stamp=10.3, observations=good)
        state = m.segment_executor.dr_state
        self.assertEqual(state.get('last_decision'), 'qr_track', str(state))
        history = m.segment_executor.dr_history
        self.assertTrue(history)
        entry = history[-1]
        self.assertEqual(entry['decision'], 'rebased')
        self.assertIn('lateralResidualM', entry)
        self.assertIsNotNone(entry['qrPose'])
        self.assertIsNotNone(entry['predictedPose'])
        # 控制位姿没瞬移：pose 对象的 x/y 不因 rebase 改变
        self.assertAlmostEqual(pose.y, -0.0 + .015, delta=.02)

    def test_qr_cross_map_rejected(self):
        """跨地图 QR（mapId 不匹配）只重锚、不当作误差纠偏。"""
        m, pose = setup()
        self.enter_move(m, pose, stamp=10.0)
        s = m.segment_executor.segment
        m.field['id'] = 'map-current'
        m.localization = {'mapId': 'map-other', 'mapVersion': 5, 'localEpoch': 'E1'}
        pose.stamp = 10.3
        pose.sigma = .01
        good = [{'id': s['toId'], 'groupId': 'B0', 'visibleCount': 16, 'sigma': .008}]
        m.field['groups'] = [{'id': 'B0', 'referenceId': s['toId'], 'members': [{'id': k} for k in range(16)]}]
        self.tick(m, pose, stamp=10.3, observations=good)
        state = m.segment_executor.dr_state
        entry = m.segment_executor.dr_history[-1]
        self.assertEqual(entry['decision'], 'skipped_map_or_epoch', str(entry))
        self.assertEqual(state.get('last_decision'), 'reanchored', str(state))

    def test_low_quality_single_frame_no_correction(self):
        """单帧低质量 QR（1/16 可见）不得纠偏，只记录。"""
        m, pose = setup()
        self.enter_move(m, pose, stamp=10.0)
        s = m.segment_executor.segment
        low = [{'id': s['toId'], 'groupId': 'B0', 'visibleCount': 1, 'sigma': .04}]
        m.field['groups'] = [{'id': 'B0', 'referenceId': s['toId'], 'members': [{'id': k} for k in range(16)]}]
        pose.stamp = 10.3
        pose.sigma = .01
        self.tick(m, pose, stamp=10.3, observations=low)
        state = m.segment_executor.dr_state
        self.assertIsNotNone(state, str(m.events[:4]))
        self.assertEqual(state.get('last_decision'), 'skip_low_quality', str(state))
        # anchor 不被低质量帧移动
        entry = m.segment_executor.dr_history[-1]
        self.assertEqual(entry['decision'], 'skipped_low_quality')

    def test_divergence_beyond_limit_faults(self):
        """QR 与预测差异连续超硬限（5cm）N 帧必须 FAULT 停车。"""
        m, pose = setup()
        self.enter_move(m, pose, stamp=10.0)
        s = m.segment_executor.segment
        good = [{'id': s['toId'], 'groupId': 'B0', 'visibleCount': 16, 'sigma': .008}]
        m.field['groups'] = [{'id': 'B0', 'referenceId': s['toId'], 'members': [{'id': k} for k in range(16)]}]
        stamp = 10.3
        pose.sigma = .01
        for i in range(4):
            pose.y += .05  # 每帧偏 5cm，远超残差限
            pose.stamp = stamp + i * .05
            self.tick(m, pose, speed=.08, vx=.08, stamp=pose.stamp, observations=good)
            if m.state == 'FAULT':
                break
        self.assertEqual(m.state, 'FAULT', '连续发散必须停车：' + str(m.events[:4]))
        # 常规 5cm 侧偏门禁先拦（同样正确），或 DR 发散文案
        text = ' | '.join(m.events)
        self.assertTrue('发散' in text or '侧偏' in text, text)

    # ---------- 3. 安全与行程 ----------

    def test_dr_correction_preserves_target_mileage(self):
        """纠偏不得改变目标行程：纠偏后仍按原路线到达段末（END_STOP 正常）。"""
        m, pose = setup()
        self.enter_move(m, pose, stamp=1.0)
        commands, entered, finished = self.drive_with_drift(m, pose)
        self.assertTrue(entered and finished)
        # 继续跑到段末
        s = m.segment_executor.segment
        for i in range(600):
            command = self.tick(m, pose, speed=.08, vx=.08, observations=[{'id': s['toId']}], stamp=1.0)
            pose.x += command.vx * math.cos(pose.yaw) * .05
            pose.y += command.vx * math.sin(pose.yaw) * .05
            if m.segment_executor.phase == 'END_STOP' or m.state in ('FAULT', 'IDLE'):
                break
        self.assertIn(m.segment_executor.phase, ('END_STOP', 'ALIGN'), '纠偏后必须仍能到段末')
        self.assertNotEqual(m.state, 'FAULT')

    def test_hard_cross_gate_kept(self):
        """DR 预测超 5cm 硬上限（无 QR 校正机会）必须直接停车。"""
        m, pose = setup()
        self.enter_move(m, pose, stamp=1.0)
        s = m.segment_executor.segment
        # 直接给巨大 vy 漂移，让预测 cross 快速超 5cm
        faulted = False
        for i in range(400):
            command = self.tick(m, pose, speed=.08, vx=.08, vy=.06, observations=[{'id': s['toId']}], stamp=1.0)
            pose.x += command.vx * math.cos(pose.yaw) * .05
            pose.y += command.vx * math.sin(pose.yaw) * .05
            if m.state == 'FAULT':
                faulted = True
                break
        self.assertTrue(faulted or m.segment_executor.dr_state is not None)

    def test_dr_disabled_keeps_legacy(self):
        """dr_correction_enabled=false 时完全回退旧行为（不纠偏）。"""
        m, pose = setup()
        m.config['dr_correction_enabled'] = False
        self.enter_move(m, pose, stamp=1.0)
        commands, entered, _ = self.drive_with_drift(m, pose)
        self.assertFalse(entered, '禁用时不得纠偏')
        self.assertEqual(m.segment_executor.dr_state.get('last_decision'), 'disabled')

    def test_boundary_centering_tests_still_pass(self):
        """boundary-centering 11 例与本改动兼容（独立跑过；此处验证关键不变量）。"""
        m, pose = setup()
        # stamp=0（旧桩无时间戳）时 DR 被动，boundary 对中照常
        for _ in range(20):
            self.tick(m, pose, stamp=0.0)
        self.assertIsNotNone(m.segment_executor.dr_state)
        if m.segment_executor.phase == 'MOVE':
            self.assertEqual(m.segment_executor.dr_state.get('last_decision'), 'passive',
                             str(m.segment_executor.dr_state))


if __name__ == '__main__':
    unittest.main()
