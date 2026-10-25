"""转向完成后：必须完成轮子回正 + 档位确认才允许前进（RED/GREEN）。

真实故障（2026-10-22 21:07:43.794 / 21:08:49.200）：原地转 90° 到位后 TURN_STOP 只确认
停稳与 yaw 残差，立即切 FORWARD/MOVE 并下发 vx；实车四轮转角当时仍在 -90°→-24° 回正途中，
底盘档位确认不通过，1 秒内 FAULT「区间模式或轮角反馈不匹配」。
"""
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT / 'tests'))
from test_segment_execution import setup


def turn_segment():
    return {'id': 'turn', 'fromId': 0, 'toId': 1, 'mode': '4t4d', 'direction': 'forward',
            'strategy': 'turn_forward', 'bodyYaw': math.pi / 2, 'endYaw': math.pi / 2,
            'wheelAngle': 0., 'points': [{'x': 0., 'y': 0.}, {'x': 0., 'y': .3}]}


class TurnRecenterGateTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.seq = 0
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.commands = []

    def feedback(self, mode='4t4d', angle=0., speed=0., fresh=True):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now if fresh else self.now - 99.,
                'speed': speed, 'body_gear': 8 if mode == 'crab' else 6,
                'steering_gear': 7 if mode == 'crab' else 5,
                'steering_angle': angle, 'angle_source': 'existing_chassis', 'angles': [angle] * 4}

    def tick(self, m, pose, angle, mode='4t4d', speed=0., fresh=True):
        self.now += .05
        command = m.tick(pose, self.feedback(mode, angle, speed, fresh),
                         [{'id': m.segment_executor.segment['fromId']}], [], .05)
        self.commands.append(command)
        pose.yaw += command.yaw_rate * .05
        return command

    def drive(self, m, pose, limit=800):
        """按真实相位给轮角：对准阶段=0°，原地转向过程=-90°，其余=0°。"""
        for _ in range(limit):
            phase = m.segment_executor.phase
            angle = -90. if phase in ('TURN', 'TURN_STOP') else 0.
            command = self.tick(m, pose, angle)
            if phase == 'TURN' and m.segment_executor.phase == 'TURN_STOP':
                continue
            yield command

    def reach_recenter(self, m, pose):
        for _ in self.drive(m, pose):
            phase = m.segment_executor.phase
            if phase == 'TURN_RECENTER':
                return
            if m.state == 'FAULT':
                self.fail('转向到位前后不应 FAULT：' + ' | '.join(m.events))
            if phase == 'MOVE':
                self.fail('yaw 到位后不得直接进入 MOVE／下发前进，必须先做轮子回正与档位确认：'
                          + ' | '.join(m.events[-4:]))
        self.fail('未进入轮子回正阶段：' + ' | '.join(m.events))

    def test_yaw_reached_but_wheels_not_recentered_must_not_command_forward(self):
        m, pose = setup([turn_segment()], start_yaw=0.)
        self.reach_recenter(m, pose)
        forward = []
        for _ in range(40):
            command = self.tick(m, pose, -90.)
            if command.vx and abs(command.vx) > 1e-9:
                forward.append((m.segment_executor.phase, command.vx))
            self.assertNotEqual(m.segment_executor.phase, 'MOVE', '轮子未回正时不得进入 MOVE')
        self.assertEqual(forward, [], '轮角 -90° 未回正时绝不允许下发前进速度：%s' % forward)
        self.assertNotEqual(m.state, 'FAULT', '等待回正期间应保持等待而非 FAULT：' + ' | '.join(m.events))

    def test_mode_switch_unconfirmed_must_not_command_forward(self):
        m, pose = setup([turn_segment()], start_yaw=0.)
        self.reach_recenter(m, pose)
        for _ in range(20):
            command = self.tick(m, pose, 0., mode='crab')
            self.assertEqual((command.vx, command.vy), (0., 0.), '档位未切回 4t4d 时不得发前进/横移速度')
            self.assertNotEqual(m.segment_executor.phase, 'MOVE', '档位未确认时不得进入 MOVE')

    def test_forward_only_after_wheels_and_gear_confirmed(self):
        m, pose = setup([turn_segment()], start_yaw=0.)
        self.reach_recenter(m, pose)
        moved = None
        for _ in range(80):
            command = self.tick(m, pose, 0.)
            if m.segment_executor.phase == 'MOVE':
                moved = command
                break
            self.assertEqual(command.vx, 0., '回正确认完成前必须保持零速')
        self.assertIsNotNone(moved, '轮角回正且档位确认后必须进入 MOVE：' + ' | '.join(m.events))
        self.assertGreater(moved.vx, 0., '进入 MOVE 的首个指令应为前进')
        self.assertEqual(moved.mode, '4t4d')
        self.assertEqual(moved.vy, 0.)
        info = m.segment_executor.turn_info.get('recenter') or {}
        self.assertEqual(info.get('status'), 'ready', '回正门禁应留下 ready 结构化记录：%s' % info)

    def test_recenter_timeout_faults_without_any_forward_command(self):
        m, pose = setup([turn_segment()], start_yaw=0.)
        self.reach_recenter(m, pose)
        worst = 0.
        for _ in range(int(float(m.config['mode_timeout_s']) / .05) + 40):
            command = self.tick(m, pose, -90.)
            worst = max(worst, abs(command.vx or 0.))
            if m.state == 'FAULT':
                break
        self.assertEqual(m.state, 'FAULT', '回正持续失败必须 FAULT：' + ' | '.join(m.events))
        self.assertIn('轮子回正', ' | '.join(m.events))
        self.assertEqual(worst, 0., '回正失败全过程不得下发任何前进速度')
        self.assertEqual((self.commands[-1].vx, self.commands[-1].vy), (0., 0.))

    def test_stale_feedback_during_recenter_never_moves(self):
        m, pose = setup([turn_segment()], start_yaw=0.)
        self.reach_recenter(m, pose)
        worst = 0.
        for _ in range(30):
            command = self.tick(m, pose, 0., fresh=False)
            worst = max(worst, abs(command.vx or 0.))
            if m.state == 'FAULT':
                break
        self.assertEqual(worst, 0., '反馈过期时不得下发前进速度')
        self.assertEqual(m.state, 'FAULT', '反馈过期必须结构化 FAULT：' + ' | '.join(m.events))

    def test_normal_turn_still_reaches_forward_after_recenter(self):
        m, pose = setup([turn_segment()], start_yaw=0.)
        reached = False
        for command in self.drive(m, pose):
            if m.segment_executor.phase == 'MOVE':
                reached = True
                self.assertGreater(command.vx, 0.)
                break
            if m.state == 'FAULT':
                self.fail('正常转弯不应 FAULT：' + ' | '.join(m.events))
        self.assertTrue(reached, '正常转弯后必须继续前进：' + ' | '.join(m.events))


if __name__ == '__main__':
    unittest.main()