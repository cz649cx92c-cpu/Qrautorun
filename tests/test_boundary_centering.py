"""边界横向对中回归：真实办公室9 v5 各段 ±2.2~2.7cm 偏差必须在每个二维码边界收敛。

基线（改动前）：普通 4T4D/crab 路线到码后直接进入下一段，横向偏差只记录不修正
（centeringUsed=false / converged=false）。本文件先证伪旧行为，再锁定新行为：
>2cm 触发有限 crab 对中、<=2cm 收敛、>5cm/发散/超时/低质量 FAULT；
第一段起点偏差不误判为后续区间偏差。
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


class BoundaryCenteringTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.seq = 0
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def feedback(self, mode='4t4d', angle=0., speed=0.):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed,
                'body_gear': 8 if mode == 'crab' else 6,
                'steering_gear': 7 if mode == 'crab' else 5, 'steering_angle': angle,
                'angle_source': 'existing_chassis', 'angles': [angle] * 4}

    def tick(self, m, pose, speed=0., observations=None):
        self.now += .05
        fb = self.feedback(m.mode, m.target_angle, speed)
        obs = observations if observations is not None else [{'id': m.segment_executor.segment['fromId']}]
        return m.tick(pose, fb, obs, [], .05)

    def enter_move(self, m, pose):
        for _ in range(15):
            self.tick(m, pose)
            if m.segment_executor.phase == 'MOVE':
                return
        self.fail(str(m.events))

    def reach_end_stop(self, m, pose, offset_x=0., sigma=.01):
        """开到第一段末端；END_STOP 停稳后由边界对中决策。返回 ('center'|'advanced'|'fault',phase)。"""
        self.enter_move(m, pose)
        s = m.segment_executor.segment
        pose.x = s['points'][-1]['x'] + offset_x
        pose.y = s['points'][-1]['y']
        pose.sigma = sigma
        pose.yaw = 0.
        obs = [{'id': s['toId']}]
        for _ in range(40):
            self.tick(m, pose, observations=obs)
            ex = m.segment_executor
            if ex.phase.startswith('CENTER'):
                return 'center', ex.phase
            if ex.phase == 'ALIGN' and ex.index == 1:
                return 'advanced', 'ALIGN'
            if m.state == 'FAULT':
                return 'fault', m.state
        return 'timeout', m.segment_executor.phase

    def run_centering(self, m, pose, converge=True, drift=0., freeze=False):
        """从 CENTER_ALIGN 推进到下一段 MOVE（或 FAULT）。返回 (commands, ok)。"""
        commands = []
        target = m.segment_executor.segment['toId']
        for _ in range(400):
            command = self.tick(m, pose, observations=[{'id': target}])
            commands.append(command)
            if not freeze:
                pose.x += (command.vx * math.cos(pose.yaw) - command.vy * math.sin(pose.yaw)) * .05
                pose.y += (command.vx * math.sin(pose.yaw) + command.vy * math.cos(pose.yaw)) * .05
                pose.yaw += command.yaw_rate * .05
            if not converge and m.segment_executor.phase == 'CENTER_MOVE':
                pose.x += drift
            if m.state == 'FAULT':
                return commands, False
            if m.segment_executor.phase == 'MOVE':
                return commands, True
        return commands, False

    # ---- GREEN 主链路：真实基线 ±2.57/-2.70cm ----

    def test_boundary_positive_257_converges_and_advances(self):
        """+25.7mm（相对下一段直线）必须触发对中并收敛到 <=2cm，然后进入下一段。"""
        m, pose = setup()
        outcome, phase = self.reach_end_stop(m, pose, offset_x=-.0257)
        self.assertEqual(outcome, 'center', '2.57cm 必须触发边界对中：' + str(m.events))
        self.assertEqual(m.segment_executor.exit_info.get('centeringUsed'), True)
        commands, ok = self.run_centering(m, pose)
        self.assertTrue(ok, '对中必须收敛并进入下一段：' + str(m.events))
        self.assertEqual(m.segment_executor.index, 1, '对中完成后必须进入第 2 段')
        s2 = m.segment_executor.segment
        cross, _, _, _ = geometry(pose, s2['points'])
        self.assertLessEqual(abs(cross), .02 + .001,
                             '收敛后相对下一段横向偏差必须 <=2cm，实测 %.4f' % cross)
        record = m.segment_executor.centering_history[-1]
        self.assertEqual(record['decision'], 'converged')
        self.assertGreater(record['travelM'], 0., '必须真的横移过：' + str(record))
        self.assertGreater(record['durationS'], 0.)
        self.assertAlmostEqual(record['startCrossM'], .0257, delta=.001)

    def test_boundary_negative_270_converges(self):
        """-27.0mm 同样必须触发并收敛（方向相反）。"""
        m, pose = setup()
        outcome, _ = self.reach_end_stop(m, pose, offset_x=+.027)
        self.assertEqual(outcome, 'center', str(m.events))
        commands, ok = self.run_centering(m, pose)
        self.assertTrue(ok, str(m.events))
        self.assertEqual(m.segment_executor.index, 1)
        cross, _, _, _ = geometry(pose, m.segment_executor.segment['points'])
        self.assertLessEqual(abs(cross), .02 + .001)
        record = m.segment_executor.centering_history[-1]
        self.assertEqual(record['direction'], 'right')
        self.assertAlmostEqual(record['startCrossM'], -.027, delta=.001)

    def test_centering_direction_commands_sign(self):
        """正偏差向 +x 修、负偏差向 -x 修；纯横移（yaw_rate=0，不伪装成前进）。"""
        for offset, expect_vx in ((-.0257, +1), (+.027, -1)):
            with self.subTest(offset=offset):
                m, pose = setup()
                outcome, _ = self.reach_end_stop(m, pose, offset_x=offset)
                self.assertEqual(outcome, 'center', str(m.events))
                lateral = None
                for command in self.run_centering(m, pose)[0]:
                    if abs(command.vx) > 1e-9 or abs(command.vy) > 1e-9:
                        lateral = command
                        break
                self.assertIsNotNone(lateral, 'CENTER_MOVE 必须发出横移指令')
                self.assertEqual(lateral.mode, 'crab', '对中只能用 crab 横移')
                self.assertEqual(lateral.yaw_rate, 0., '对中不允许旋转')
                lateral_x = lateral.vx * math.cos(pose.yaw) + lateral.vy * math.sin(pose.yaw)
                self.assertEqual(math.copysign(1., lateral_x), expect_vx,
                                 '横移方向必须朝偏差减小方向（世界系 %.4f）' % lateral_x)

    def test_centered_boundary_advances_without_crab(self):
        """<=2cm 的边界不触发对中，直接进入下一段（不浪费对中动作）。"""
        m, pose = setup()
        outcome, _ = self.reach_end_stop(m, pose, offset_x=-.008)
        self.assertEqual(outcome, 'advanced', str(m.events))
        self.assertEqual(m.segment_executor.exit_info.get('status'), 'converged')
        self.assertFalse(m.segment_executor.exit_info.get('centeringUsed'))
        self.assertEqual(len(m.segment_executor.centering_history), 0)

    # ---- FAULT 门禁 ----

    def test_boundary_over_5cm_faults(self):
        """>5cm 硬上限直接 FAULT，不做对中也不前进（共线双段路线构造纯横向 5.5cm）。"""
        import test_segment_execution as _tse
        ss = [segment((0, 0), (.3, 0), index=0), segment((.3, 0), (.6, 0), index=1)]
        # setup() 要求每段端点恰为二维码中心，共线双段需手造 tags。
        config = yaml.safe_load((ROOT / 'config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters']
        config.update(existing_chassis_confirmed=True, existing_runtime_conditions_accepted=True)
        for key, value in _tse.TURN_DEFAULTS.items():
            config.setdefault(key, value)
        points = [ss[0]['points'][0]] + [s['points'][-1] for s in ss]
        field = {'coordinateStatus': 'reviewed', 'routeMode': 'waypoints', 'motionSegments': ss,
                 'rows': [{'id': 'route', 'name': 'over-limit', 'points': points[1:], 'start': points[0], 'exitDistance': .8}],
                 'tags': [{'id': s['fromId'], 'x': s['points'][0]['x'], 'y': s['points'][0]['y']} for s in ss]
                          + [{'id': ss[-1]['toId'], 'x': ss[-1]['points'][-1]['x'], 'y': ss[-1]['points'][-1]['y']}]}
        task = {'id': 'task', 'rowOrder': ['route'], 'forwardSpeed': .08, 'reverseSpeed': .06,
                'lateralSpeed': .05, 'endWaitSeconds': .2, 'returnToStart': False}
        m = Mission(config)
        pose = Pose(points[0]['x'], points[0]['y'], ss[0]['bodyYaw'])
        m.start(field, task, pose)
        self.enter_move(m, pose)
        s = m.segment_executor.segment
        pose.x = s['points'][-1]['x']
        pose.y = s['points'][-1]['y'] + .055
        pose.sigma = .01
        pose.yaw = 0.
        outcome = None
        for _ in range(40):
            self.tick(m, pose, observations=[{'id': s['toId']}])
            ex = m.segment_executor
            outcome = ('fault' if m.state == 'FAULT' else
                       'center' if ex.phase.startswith('CENTER') else
                       'advanced' if ex.phase == 'ALIGN' and ex.index == 1 else None)
            if outcome:
                break
        self.assertEqual(outcome, 'fault', str(m.events))
        self.assertEqual(m.state, 'FAULT')
        self.assertIn('超过硬上限', ' | '.join(m.events))
        self.assertEqual(m.segment_executor.centering_history[-1]['reason'], 'over_limit')

    def test_boundary_divergence_faults(self):
        """对中方向发散（越修越偏）必须 FAULT。"""
        m, pose = setup()
        outcome, _ = self.reach_end_stop(m, pose, offset_x=-.0257)
        self.assertEqual(outcome, 'center', str(m.events))
        commands, ok = self.run_centering(m, pose, converge=False, drift=-.003)
        self.assertFalse(ok)
        self.assertEqual(m.state, 'FAULT')
        self.assertIn('横移对中方向异常', ' | '.join(m.events))
        self.assertEqual(m.segment_executor.centering_history[-1]['reason'], 'diverged')
        self.assertEqual((commands[-1].vx, commands[-1].vy, commands[-1].yaw_rate), (0., 0., 0.))

    def test_boundary_timeout_faults(self):
        """对中冻结不收敛必须超时 FAULT，不无限走。"""
        m, pose = setup()
        outcome, _ = self.reach_end_stop(m, pose, offset_x=-.0257)
        self.assertEqual(outcome, 'center', str(m.events))
        commands, ok = self.run_centering(m, pose, freeze=True)
        self.assertFalse(ok)
        self.assertEqual(m.state, 'FAULT')
        # 冻结位姿时距离窗口（10cm）与时间窗口（8s）都可能先触发，都合法。
        self.assertIn('横移对中', ' | '.join(m.events))
        self.assertIn(m.segment_executor.centering_history[-1]['reason'], ('timeout', 'travel_limit'))

    def test_low_sigma_gate_blocks_centering(self):
        """定位质量不足（sigma>3cm）禁止横移对中，直接 FAULT。"""
        m, pose = setup()
        outcome, _ = self.reach_end_stop(m, pose, offset_x=-.0257, sigma=.05)
        self.assertEqual(outcome, 'fault', str(m.events))
        self.assertIn('定位质量不足', ' | '.join(m.events))
        self.assertEqual(m.segment_executor.centering_history[-1]['reason'], 'low_quality')

    def test_no_crab_capability_faults(self):
        """底盘未确认横移能力时不对中、不前进。"""
        m, pose = setup()
        self.enter_move(m, pose)
        m.config['existing_runtime_conditions_accepted'] = False
        s = m.segment_executor.segment
        pose.x = s['points'][-1]['x'] - .0257
        pose.sigma = .01
        for _ in range(40):
            self.tick(m, pose, observations=[{'id': s['toId']}])
            if m.state == 'FAULT':
                break
        self.assertEqual(m.state, 'FAULT', str(m.events))
        self.assertIn('无法正交对中', ' | '.join(m.events))
        self.assertEqual(m.segment_executor.centering_history[-1]['reason'], 'no_crab')

    # ---- 起点偏差不误判 ----

    def test_first_segment_start_offset_not_misjudged(self):
        """第一段起点 3.5cm 侧偏不触发对中（由 start_gate 把关），照常行驶。"""
        m, pose = setup()
        pose.y = .035  # 起点 +3.5cm 侧偏（<5cm 门限，start 允许）
        pose.sigma = .01
        self.enter_move(m, pose)
        self.assertEqual(m.segment_executor.phase, 'MOVE')
        self.assertEqual(len(m.segment_executor.centering_history), 0,
                         '第一段起点偏差不得被当成后续区间边界偏差触发对中')
        self.assertEqual(m.segment_executor.index, 0)
        command = self.tick(m, pose, observations=[{'id': 1}])
        self.assertGreater(command.vx, 0., '起点侧偏在门限内必须照常前进')

    def test_centering_history_capped_and_structured(self):
        """结构化记录字段完整（start/end/delta/指令/距离/时长/decision）。"""
        m, pose = setup()
        self.reach_end_stop(m, pose, offset_x=-.0257)
        commands, ok = self.run_centering(m, pose)
        self.assertTrue(ok)
        record = m.segment_executor.centering_history[-1]
        for key in ('targetSegment', 'boundaryTagId', 'startCrossM', 'endCrossM',
                    'deltaCrossM', 'direction', 'doneCrossM', 'triggerCrossM',
                    'limitCrossM', 'command', 'travelM', 'durationS', 'decision'):
            self.assertIn(key, record, '记录缺字段 ' + key)
        self.assertLess(abs(record['endCrossM']), .02 + .001)
        self.assertLess(abs(record['deltaCrossM']), .0257 + .002)
        self.assertEqual(record['command'].get('mode'), 'crab')
        self.assertIn(record['decision'], ('converged',))
        m.segment_executor.centering_history = [record] * 20
        m2, pose2 = setup()
        self.reach_end_stop(m2, pose2, offset_x=-.0257)
        self.run_centering(m2, pose2)
        self.assertLessEqual(len(m2.segment_executor.centering_history), 8)


if __name__ == '__main__':
    unittest.main()
