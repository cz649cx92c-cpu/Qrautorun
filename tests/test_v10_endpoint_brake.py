"""末段动态制动闭环 RED→GREEN（生产 Mission/SegmentExecutor/Tracker 全链路）。

覆盖：
1. RED 复现：旧实现 remaining≈30mm 且实测 vx≈0.08 时立即 END_STOP 并把指令切 0。
2. 制动距离随速度/减速度/指令时延变化，且与物理公式一致。
3. 规划末速(recorded_speed_plan)与执行限速(limit)共用同一制动度量。
4. 指令必须连续降到 0（ramp），不得在某个距离阈值上从 0.08 直接跳 0。
5. 低速尾段：闭环必须真正收敛进目标窗口并停住，不能停在窗口外。
6. 连续零速样本：未凑满 stable_feedback_samples 帧不得宣称停稳完成。
7. 终点靠近确认用欧氏距离（不是沿路径 remaining）。
8. 超时/反馈失效必须 fault 且输出零指令（不得假装停到位）。
"""
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT / 'tests'))
from greenhouse_navigation.control import (Pose, Tracker, brake_stop_distance,
                                           endpoint_brake_metrics, endpoint_brake_speed,
                                           geometry, max_speed_for_distance,
                                           recorded_speed_plan)
from greenhouse_navigation.recorded_trial import limits_for
from test_segment_execution import setup  # noqa: E402


def seg(a, b, index, mode='4t4d', direction='forward', strategy=None, body_yaw=None):
    ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
    if ang > 90:
        ang -= 180
    if ang < -90:
        ang += 180
    yaw = math.atan2(b[1] - a[1], b[0] - a[0]) if body_yaw is None else body_yaw
    d = {'id': str(index), 'fromId': index, 'toId': index + 1, 'mode': mode,
         'direction': direction, 'bodyYaw': yaw, 'endYaw': yaw,
         'wheelAngle': ang if mode == 'crab' else 0.,
         'points': [{'x': a[0], 'y': a[1]},
                    {'x': (a[0] + b[0]) / 2, 'y': (a[1] + b[1]) / 2},
                    {'x': b[0], 'y': b[1]}]}
    if strategy:
        d['strategy'] = strategy
    return d


class BrakeMetric(unittest.TestCase):
    """纯函数层：制动度量必须与物理公式一致，且随速度/时延/减速度变化。"""

    def test_brake_distance_scales_with_speed(self):
        slow = brake_stop_distance(.08, .20, .25)
        fast = brake_stop_distance(.12, .20, .25)
        self.assertAlmostEqual(slow, .08 ** 2 / .4 + .08 * .25, places=9)
        self.assertAlmostEqual(fast, .12 ** 2 / .4 + .12 * .25, places=9)
        self.assertGreater(fast, slow + .02, '速度翻 1.5 倍，制动距离必须显著变大')

    def test_brake_distance_scales_with_delay(self):
        none = brake_stop_distance(.08, .20, 0.)
        delayed = brake_stop_distance(.08, .20, .25)
        self.assertAlmostEqual(none, .016, places=6)
        self.assertAlmostEqual(delayed, .036, places=6)
        self.assertAlmostEqual(delayed - none, .08 * .25, places=9)

    def test_brake_distance_monotone_in_braking(self):
        weak = brake_stop_distance(.12, .10, 0.)
        strong = brake_stop_distance(.12, .20, 0.)
        self.assertGreater(weak, strong)
        self.assertAlmostEqual(strong, .12 ** 2 / .4, places=9)

    def test_metrics_report_predicted_stop_error(self):
        m = endpoint_brake_metrics(.08, .030, .20, .25)
        self.assertEqual(m['vx'], .08)
        self.assertAlmostEqual(m['predictedBrakeM'], .036, places=6)
        self.assertAlmostEqual(m['pureBrakeM'], .016, places=6)
        self.assertAlmostEqual(m['velocityDelayMarginM'], .020, places=6)
        self.assertAlmostEqual(m['predictedStopErrorM'], .030 - .036, places=6)

    def test_speed_for_distance_inverts_brake_distance(self):
        for v in (.02, .05, .08, .12):
            d = brake_stop_distance(v, .20, .25)
            self.assertAlmostEqual(endpoint_brake_speed(d, .20, .25), v, places=6)
        self.assertAlmostEqual(max_speed_for_distance(.016, .20), .08, places=9)

    def test_zero_distance_gives_zero_speed(self):
        self.assertEqual(endpoint_brake_speed(0., .20, .25), 0.)
        self.assertEqual(endpoint_brake_speed(-.05, .20, .25), 0.)
        self.assertEqual(brake_stop_distance(0., .20, .25), 0.)

    def test_real_profile_limits_are_used(self):
        """真实执行配置 recorded_slow_trial 的 braking 必须参与制动度量。"""
        trial = limits_for('recorded_slow_trial')
        self.assertIsNotNone(trial)
        self.assertAlmostEqual(trial['braking'], .2, places=6)


class EndpointBrakeClosedLoop(unittest.TestCase):
    """用「指令→实测速度」一阶滞后被控对象验证生产闭环本身。"""

    def setUp(self):
        self.now = 100.
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.seq = 0
        self.tau = .10          # 底盘速度跟随时间常数（相对 command_timeout 0.25s 偏乐观）
        self.actual = .0        # 被控对象当前实测速度

    def fb(self, mode='4t4d', angle=0., speed=0.):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed,
                'vx': speed, 'vy_mps': 0., 'vy_raw': 0.,
                'body_gear': 8 if mode == 'crab' else 6,
                'steering_gear': 7 if mode == 'crab' else 5,
                'steering_angle': angle, 'angle_source': 'existing_chassis',
                'angles': [angle] * 4}

    def observe(self, cmd_vx, dt=.05):
        """一阶滞后：实测速度跟随指令速度；无指令时按同一时间常数衰减到 0。"""
        alpha = min(1., dt / self.tau) if self.tau > 0 else 1.
        self.actual += (cmd_vx - self.actual) * alpha
        if abs(self.actual) < 1e-4:
            self.actual = 0.
        return self.actual

    def tick(self, m, pose, cmd_speed=None, mode='4t4d', angle=0., obs=None):
        """cmd_speed=None 时用被控对象实测速度作为反馈（标准闭环）。"""
        self.now += .05
        ex = m.segment_executor
        if cmd_speed is None:
            speed = self.actual
        else:
            speed = cmd_speed
            self.actual = cmd_speed
        cmd = m.tick(pose, self.fb(mode, angle, speed),
                     obs if obs is not None else [{'id': ex.segment['fromId']}], [], .05)
        return cmd

    def enter_move(self, m, pose):
        pose.sigma = .007
        pose.stamp = 1.0
        self.actual = 0.
        for _ in range(120):
            self.tick(m, pose)
            if m.segment_executor.phase == 'MOVE':
                return
        self.fail('未进入 MOVE：%s' % str(m.events[:5]))

    def drive(self, m, pose, ticks=900, stop_on=('FAULT', 'FINISHED')):
        """标准闭环驱动：指令 → 被控对象 → 反馈 → 位姿积分。"""
        log = []
        dt = .05
        for _ in range(ticks):
            ex = m.segment_executor
            mode = 'crab' if ex.segment.get('mode') == 'crab' else '4t4d'
            angle = m.target_angle if mode == 'crab' else 0.
            obs = [{'id': ex.segment['fromId']}]
            for tag in (ex.segment['fromId'], ex.segment['toId']):
                tgt = next(p for p in ex.segment['points'] if True) if False else None
            target = ex.segment['points'][-1]
            if math.hypot(pose.x - target['x'], pose.y - target['y']) <= .06:
                obs.append({'id': ex.segment['toId']})
            cmd = self.tick(m, pose, mode=mode, angle=angle, obs=obs)
            vx = self.observe(cmd.vx, dt)
            vy = self.observe(cmd.vy, dt) if mode == 'crab' else 0.
            log.append((ex.phase, ex.index, round(cmd.vx, 4), round(cmd.vy, 4),
                        m.state, round(self.actual, 4)))
            pose.x += (vx * math.cos(pose.yaw) - vy * math.sin(pose.yaw)) * dt
            pose.y += (vx * math.sin(pose.yaw) + vy * math.cos(pose.yaw)) * dt
            pose.yaw += cmd.yaw_rate * dt
            if m.state in stop_on:
                break
        return log

    # ---- RED：复现旧实现的「30mm 处指令瞬间切零」 ----
    def test_red_30mm_at_speed_must_not_stop_instantly(self):
        """旧实现在 remaining≈30mm、实测 vx=0.08 时立刻 END_STOP 并把指令切 0。

        正确行为：v=0.08 的预测制动距离（16mm 纯制动 + 20mm 时延）= 36mm，
        30mm 处不可能停住，必须继续按制动度量给非零指令。
        """
        m, pose = setup([seg((0, 0), (.3, 0), 0)])
        self.enter_move(m, pose)
        pose.x = .27          # remaining = 30mm
        self.actual = .08
        cmd = self.tick(m, pose, cmd_speed=.08)
        ex = m.segment_executor
        self.assertNotEqual(ex.phase, 'END_STOP',
                            '30mm + vx=0.08 不得直接进入 END_STOP：%s' % str(m.events[:3]))
        self.assertGreater(cmd.vx, 0., '末段必须仍在给非零前进指令，而不是瞬间切 0')

    # ---- GREEN：规划与限幅共用同一制动度量 ----
    def test_speed_plan_and_limit_share_endpoint_metric(self):
        trial = limits_for('recorded_slow_trial')
        points = [{'x': 0., 'y': 0.}, {'x': .3, 'y': 0.}]
        # 远距离：两者都不限速
        planned, _, _ = recorded_speed_plan(Pose(.1, 0., 0.), points, .12, trial, .1, .2, .25)
        self.assertAlmostEqual(planned, .12, places=6)
        # 逼近端点：规划末速必须等于同一制动度量给出的可停速度
        remaining = .036
        planned, _, _ = recorded_speed_plan(Pose(.3 - remaining, 0., 0.), points,
                                           .12, trial, .1, .2, .25)
        expected = endpoint_brake_speed(remaining, .2, .25)
        self.assertAlmostEqual(planned, expected, delta=1e-3,
                              msg='规划末速 %r 必须等于制动度量 %r' % (planned, expected))
        self.assertLess(planned, .09, '36mm 处必须已显著降速')
        # limit() 沿同一度量收敛到同一速度
        tr = Tracker(.1, .2)
        tr.previous_speed = .12
        for _ in range(200):
            limited = tr.limit(.12, remaining, .05, .1, .2, stop_delay=.25)
        self.assertAlmostEqual(limited, planned, delta=2e-3,
                              msg='limit 收敛 %r 必须与规划末速 %r 一致' % (limited, planned))

    # ---- GREEN：指令必须连续 ramp 到 0，并在窗口内真正停住 ----
    def test_command_ramps_to_zero_and_stops_inside_window(self):
        m, pose = setup([seg((0, 0), (.3, 0), 0)])
        self.enter_move(m, pose)
        log = self.drive(m, pose)
        phases = [x[0] for x in log]
        self.assertIn('END_STOP', phases, '终点必须停车：%s' % str(m.events[:3]))
        self.assertEqual(m.state, 'FINISHED', '闭环必须在窗口内停稳完成：%s' % str(m.events[:5]))
        # 不得出现「带着明显速度进入 END_STOP」：末段指令必须已 ramp 到低速
        entering = next((x for x in log if x[0] == 'END_STOP'), None)
        self.assertIsNotNone(entering)
        self.assertLessEqual(entering[2], .05,
                             '进入 END_STOP 时指令 vx 必须已降到低速，实测 %r' % (entering[2],))
        self.assertLessEqual(entering[2], max(.08, .05),
                             '进入 END_STOP 时不得仍是全速 0.08')
        # 最终实测停车位置必须在目标窗口内
        target = m.segment_executor.segment['points'][-1]
        dist = math.hypot(pose.x - target['x'], pose.y - target['y'])
        self.assertLessEqual(dist, .02, '最终停车离目标 %.1f mm，必须在目标窗口内' % (dist * 1000))
        # 实测停车残余必须被如实记录
        meta = getattr(m.segment_executor, 'endpoint_brake', {}) or {}
        self.assertIn('enterRemainingM', meta, '必须记录进入末段制动时的剩余距离')
        self.assertIn('predictedBrakeM', meta, '必须记录预测制动距离')
        self.assertIn('windowM', meta, '必须记录目标窗口')

    def test_end_stop_entry_requires_target_window(self):
        """END_STOP 入口由同一制动度量决定：剩余距离必须已进入目标窗口。"""
        m, pose = setup([seg((0, 0), (.3, 0), 0)])
        self.enter_move(m, pose)
        ex = m.segment_executor
        window = float(m.config.get('endpoint_stop_window_m', .010))
        # 30mm（旧实现的固定入口）必须仍在 MOVE
        pose.x = .3 - .030
        self.tick(m, pose, cmd_speed=.04, obs=[{'id': 1}])
        self.assertEqual(ex.phase, 'MOVE', '30mm 处仍在目标窗口外，不得进入 END_STOP')
        # 进入窗口后必须进入 END_STOP
        pose.x = .3 - window * .5
        self.tick(m, pose, cmd_speed=.02, obs=[{'id': 1}])
        self.assertEqual(ex.phase, 'END_STOP', '进入目标窗口后必须进入 END_STOP')

    def test_end_stop_confirmation_requires_consecutive_zero_samples(self):
        """进入 END_STOP 后必须凑满 stable_feedback_samples 帧连续零速才离开 ROW_END。"""
        m, pose = setup([seg((0, 0), (.3, 0), 0)])
        self.enter_move(m, pose)
        ex = m.segment_executor
        window = float(m.config.get('endpoint_stop_window_m', .010))
        # 走到窗口内触发 END_STOP
        for _ in range(400):
            cmd = self.tick(m, pose, cmd_speed=.02, obs=[{'id': 1}])
            if ex.phase == 'END_STOP':
                break
            pose.x += cmd.vx * .05
        self.assertEqual(ex.phase, 'END_STOP', str(m.events[:3]))
        samples = int(m.config['stable_feedback_samples'])
        # v11：连续零速之后还要等位姿稳定窗口（pose_stability_samples 帧样本）
        # 才确认，所以确认前必须仍在 ROW_END，确认后给足 tick 数让它完成。
        for i in range(samples - 2):
            self.tick(m, pose, cmd_speed=0., obs=[{'id': 1}])
            self.assertEqual(m.state, 'ROW_END',
                             '仅 %d 帧零速不得离开 ROW_END' % (i + 1))
        # 中间插一帧非零速：连续计数必须清零
        self.tick(m, pose, cmd_speed=.05, obs=[{'id': 1}])
        self.assertEqual(m.state, 'ROW_END', '非零速帧必须打断连续零速计数')
        for _ in range(samples + int(m.config.get('pose_stability_samples', 5)) + 8):
            self.tick(m, pose, cmd_speed=0., obs=[{'id': 1}])
            if m.state == 'FINISHED':
                break
        self.assertEqual(m.state, 'FINISHED', '凑满连续零速样本后必须完成：%s' % str(m.events[:3]))

    # ---- GREEN：终点靠近用欧氏距离 ----
    def test_low_speed_tail_still_converges(self):
        """低速尾段：从高速收下来后仍必须真正进窗口并停住，不能停在窗口外。"""
        m, pose = setup([seg((0, 0), (.5, 0), 0)])
        m.task['forwardSpeed'] = .12
        self.enter_move(m, pose)
        log = self.drive(m, pose, ticks=1200)
        self.assertEqual(m.state, 'FINISHED', '高速尾段也必须收敛：%s' % str(m.events[:5]))
        target = m.segment_executor.segment['points'][-1]
        dist = math.hypot(pose.x - target['x'], pose.y - target['y'])
        self.assertLessEqual(dist, .02, '最终停车离目标 %.1f mm' % (dist * 1000))
        self.assertLessEqual(max(x[2] for x in log), .12 + 1e-6)
        meta = getattr(m.segment_executor, 'endpoint_brake', {}) or {}
        self.assertTrue(meta.get('withinWindow', True),
                        '高速尾段进窗口必须为真，实际记录 %r' % (meta.get('withinWindow'),))

    def test_endpoint_fault_uses_euclidean_goal_distance(self):
        m, pose = setup([seg((0, 0), (.3, 0), 0)])
        self.enter_move(m, pose)
        ex = m.segment_executor
        # 沿路径 remaining 已夹到 0（未越过终点 45mm 门限），但欧氏距离 62.5mm
        # 超过 60mm 边界容差：必须靠欧氏距离发现「停偏了」。
        pose.x = .34
        pose.y = .048
        for _ in range(int(m.config['stable_feedback_samples'])):
            self.tick(m, pose, cmd_speed=0., obs=[{'id': 1}])
            if m.state == 'FAULT':
                break
        self.assertEqual(m.state, 'FAULT', '欧氏距离超边界容差必须 fault：%s' % str(m.events[:3]))
        self.assertIn('未靠近目标二维码', ' | '.join(m.events))

    def test_euclidean_distance_is_not_path_remaining(self):
        points = [{'x': 0., 'y': 0.}, {'x': .15, 'y': 0.}, {'x': .3, 'y': 0.}]
        pose = Pose(.3, .04, 0.)     # 纵向到达终点，横向偏 4cm
        cross, _, remaining, end = geometry(pose, points)
        self.assertAlmostEqual(remaining, 0., places=6)
        self.assertAlmostEqual(abs(cross), .04, places=6)
        self.assertAlmostEqual(end, .04, places=6, msg='终点距离必须是欧氏距离')

    # ---- GREEN：故障语义 ----
    def test_feedback_loss_during_endpoint_faults_with_zero(self):
        m, pose = setup([seg((0, 0), (.3, 0), 0)])
        self.enter_move(m, pose)
        pose.x = .27
        self.now += .05
        stale = self.fb(speed=.08)
        stale['aggregate_received'] -= 1.
        cmd = m.tick(pose, stale, [{'id': 1}], [], .05)
        self.assertEqual(m.state, 'FAULT')
        self.assertEqual((cmd.vx, cmd.vy, cmd.yaw_rate), (0., 0., 0.))

    def test_endpoint_timeout_faults_instead_of_creeping(self):
        """末段进不了停稳窗口（位置卡住）：必须 fault，不能无限爬行。"""
        m, pose = setup([seg((0, 0), (.3, 0), 0)])
        self.enter_move(m, pose)
        pose.x = .25                 # remaining = 50mm
        for _ in range(int(m.config['mode_timeout_s'] / .05) + 60):
            self.tick(m, pose, cmd_speed=.08)   # 位置卡住
            if m.state == 'FAULT':
                break
        self.assertEqual(m.state, 'FAULT', '末段制动超时必须 fault：%s' % str(m.events[:3]))
        self.assertIn('末段', ' | '.join(m.events))

    def test_endpoint_fault_outputs_zero_command(self):
        m, pose = setup([seg((0, 0), (.3, 0), 0)])
        self.enter_move(m, pose)
        pose.x = .25
        cmd = None
        for _ in range(int(m.config['mode_timeout_s'] / .05) + 60):
            cmd = self.tick(m, pose, cmd_speed=.08)
            if m.state == 'FAULT':
                break
        self.assertEqual(m.state, 'FAULT')
        self.assertEqual((cmd.vx, cmd.vy, cmd.yaw_rate), (0., 0., 0.))


if __name__ == '__main__':
    unittest.main(verbosity=2)
