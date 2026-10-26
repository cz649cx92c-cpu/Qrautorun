"""v10 4T4D 行进转向闭环数值验证（production Tracker + profile 限幅 + node 同式曲率限幅）。

不新增控制律：只调用 control.Tracker.forward 与 recorded_trial.limits_for，并按 node.py 的
4t4d 限幅公式夹取 yaw_rate；用自行车近似积分 yaw_rate→x/y/yaw，记录 cross 收敛。
"""
import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
from greenhouse_navigation.control import Command, Pose, Tracker, geometry, wrap
from greenhouse_navigation.recorded_trial import limits_for

PROFILE = 'recorded_slow_trial'
PATH = [{'x': 0., 'y': 0.}, {'x': .3, 'y': 0.}, {'x': .6, 'y': 0.}]
DT = .05


def node_clamp(cmd, trial):
    """与 node.py:748-756 相同的 4T4D 曲率/角速度限幅（非原地 TURN 分支）。"""
    bound = min(trial['maxYawRate'], abs(cmd.vx) * trial['maxCurvature'])
    wz = max(-bound, min(bound, cmd.yaw_rate))
    cmd.yaw_rate = wz
    return cmd


def run_case(initial_cross, initial_yaw, ticks=200):
    trial = limits_for(PROFILE)
    tr = Tracker()
    pose = Pose(0., initial_cross, initial_yaw)
    cross0, _, _, _ = geometry(pose, PATH)
    peak = abs(cross0)
    max_wz = 0.
    vy_nonzero = False
    modes = set()
    reached = False
    finals = []
    for i in range(ticks):
        cmd, cross_now, heading_err, remaining, end = tr.forward(
            pose, PATH, .08, DT, profile=PROFILE)
        cmd = node_clamp(cmd, trial)
        cmd.mode = '4t4d'; cmd.vy = 0.        # 与 segment_execution L883-886 一致
        modes.add(cmd.mode)
        if abs(cmd.vy) > 1e-12:
            vy_nonzero = True
        max_wz = max(max_wz, abs(cmd.yaw_rate))
        if cmd.vx <= 1e-9:
            break
        pose.x += cmd.vx * math.cos(pose.yaw) * DT
        pose.y += cmd.vx * math.sin(pose.yaw) * DT
        pose.yaw = wrap(pose.yaw + cmd.yaw_rate * DT)
        cross, _, remaining, end_distance = geometry(pose, PATH)
        finals.append(abs(cross))
        peak = max(peak, abs(cross))
        if remaining <= .03:
            reached = True
            break
    cross_end, _, _, _ = geometry(pose, PATH)
    return {'cross0': cross0, 'peak': peak, 'cross_end': cross_end,
            'reached': reached, 'max_wz': max_wz, 'vy_nonzero': vy_nonzero,
            'modes': sorted(modes), 'ticks': len(finals),
            'path_travel': pose.x}


class SteeringConvergence(unittest.TestCase):
    def _assert_converged(self, heading):
        for c in (+.03, -.03):
            r = run_case(c, heading)
            self.assertEqual(r['modes'], ['4t4d'])
            self.assertFalse(r['vy_nonzero'], 'vy 必须始终 0')
            self.assertGreater(r['max_wz'], 0., '必须有非零行进转向，而非被夹成 0')
            self.assertLessEqual(r['max_wz'], .25 + 1e-9)
            self.assertLess(abs(r['cross_end']), abs(r['cross0']), '横向误差必须下降')
            # 实测：一个 0.6m 段内从 3cm 调到约 1.9cm，并未达到 8mm；这里只断言
            # “有界调整、误差下降、不放大”，不把单段内到 8mm 当成已实现。
            self.assertLessEqual(abs(r['cross_end']), .022, '闭环应显著减小误差（实测~1.9cm）')
            self.assertLessEqual(r['peak'], abs(r['cross0']) + .005, '调整过程不得放大偏差')
            self.assertGreaterEqual(r['path_travel'], 0., '不得倒退')

    def test_heading_0_converges(self):
        self._assert_converged(0.)

    def test_heading_plus_90_not_dr_steer_supported(self):
        # 初始航向 +90°：生产 move_command 航向硬门(0.15rad)会停车，不得当前进转向硬纠。
        for c in (+.03, -.03):
            r = run_case(c, math.pi / 2)
            self.assertEqual(r['modes'], ['4t4d'])
            self.assertFalse(r['vy_nonzero'])
            self.assertLessEqual(r['max_wz'], .25 + 1e-9)

    def test_heading_minus_90_not_dr_steer_supported(self):
        for c in (+.03, -.03):
            r = run_case(c, -math.pi / 2)
            self.assertEqual(r['modes'], ['4t4d'])
            self.assertFalse(r['vy_nonzero'])
            self.assertLessEqual(r['max_wz'], .25 + 1e-9)

    def test_heading_90_180_not_dr_steer_supported(self):
        """初始航向 ±90/180°：属航向硬门故障/无法安全收敛，不能当 DR 转向收敛。"""
        for h in (math.pi / 2, -math.pi / 2, math.pi):
            for c in (+.03, -.03):
                r = run_case(c, h)
                self.assertEqual(r['modes'], ['4t4d'])
                self.assertFalse(r['vy_nonzero'])
                self.assertLessEqual(r['max_wz'], .25 + 1e-9)

    def test_production_move_command_steers_within_hard_gate(self):
        """生产 mission/segment：3cm 普通偏差 → MOVE 仍前进并给转向，不停车、不横移。"""
        from test_v10_no_auto_lateral import NoAutoLateral
        h = NoAutoLateral('test_midrun_dr_steers_not_crab')
        h.setUp(); h.addCleanup(h.clock.stop)
        m, pose = __import__('test_segment_execution', fromlist=['setup']).setup()
        h.enter_move(m, pose)
        pose.y += .03   # 普通横向偏差 3cm（< 5cm 硬门）
        cmd = h.tick(m, pose)
        self.assertNotEqual(m.state, 'FAULT')
        self.assertEqual(cmd.mode, '4t4d')
        self.assertEqual(abs(cmd.vy), 0.)
        self.assertEqual(m.segment_executor.phase, 'MOVE')
        self.assertGreater(cmd.vx, 0.)
        self.assertLessEqual(abs(cmd.yaw_rate), .25 + 1e-9)

    def test_production_gross_heading_faults_not_steer(self):
        """航向偏差超硬门（如 ±90°）：生产必须停车，不得用前进符号硬纠。"""
        from test_v10_no_auto_lateral import NoAutoLateral
        from test_segment_execution import setup
        for h in (math.pi / 2, math.pi):
            hh = NoAutoLateral('test_midrun_dr_steers_not_crab')
            hh.setUp(); hh.addCleanup(hh.clock.stop)
            m, pose = setup()
            hh.enter_move(m, pose)
            pose.yaw = h + 0.
            cmd = hh.tick(m, pose)
            self.assertEqual(m.state, 'FAULT')
            self.assertEqual((cmd.vx, cmd.vy), (0., 0.))


if __name__ == '__main__':
    for heading, name in ((0., '0deg'), (math.pi / 2, '+90deg'), (-math.pi / 2, '-90deg'), (math.pi, '180deg')):
        for c in (+.03, -.03):
            r = run_case(c, heading)
            print('heading=%-7s cross0=%+.4f peak=%+.4f end=%+.4f reached=%s maxWz=%.3f vyNonzero=%s modes=%s travel=%.3f' % (
                name, r['cross0'], r['peak'], r['cross_end'], r['reached'], r['max_wz'], r['vy_nonzero'], r['modes'], r['path_travel']))
    unittest.main(verbosity=2)
