"""v10 运动语义 RED→GREEN：4T4D 行驶中只用左右行进转向纠偏，不再自动 crab 横移。

覆盖：DR 中途触发、到码 2~5cm 残余、转向后偏心、超 5cm 硬门、显式 crab 路线保留。
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
from test_segment_execution import setup

SCOPE = {'mapId': 'scan-test-1', 'mapVersion': 5}


def board_group(to_id):
    TILE = .0235
    return {'id': 'B0', 'referenceId': to_id, 'gridSize': 4, 'sizeMm': 100, 'gapMm': 2,
            'members': [{'id': 1 + i, 'x': (i % 4 - 1.5) * .0255, 'y': (1.5 - i // 4) * .0255,
                         'angle': 0., 'size': TILE / 1.25} for i in range(16)]}


class NoAutoLateral(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.seq = 0
        self.loco = {'x': 0., 'y': 0., 'yaw': 0., 'stamp': 100., 'epoch': 'E1'}

    def fb(self, speed=.08, vx=.08, vy=0.):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed, 'vx': vx,
                'vy_mps': vy, 'vy_raw': vy * 10., 'body_gear': 6, 'steering_gear': 5,
                'steering_angle': 0., 'angle_source': 'existing_chassis', 'angles': [0.] * 4}

    def tick(self, m, pose, anchor=True, raw=None, vy=0., vx=.08, obs=None):
        self.now += .05
        self.loco = {'x': pose.x, 'y': pose.y, 'yaw': pose.yaw, 'stamp': self.loco['stamp'] + .05,
                     'epoch': 'E1'}
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

    def enter_move(self, m, pose, length=.6):
        pose.sigma = .007; pose.stamp = 1.0
        m.field['groups'] = [board_group(m.segment_executor.segment['toId'])]
        m.field['id'] = SCOPE['mapId']; m.task['mapVersion'] = 5
        for _ in range(30):
            self.tick(m, pose)
            if m.segment_executor.phase == 'MOVE':
                break
        for _ in range(40):
            self.tick(m, pose)
        self.assertEqual(m.segment_executor.phase, 'MOVE')

    # A. 中途 DR 越阈值：不得切 crab / vy!=0 / 进入 CENTER
    def test_midrun_dr_steers_not_crab(self):
        m, pose = setup()
        self.enter_move(m, pose)
        drives = []
        for i in range(120):
            cmd = self.tick(m, pose, vy=.03)   # 真实横漂 → 预测 cross 增长
            drives.append(cmd)
            pose.x += cmd.vx * .05
            pose.y += (cmd.vy + .03) * .05
            pose.yaw += cmd.yaw_rate * .05
            if m.segment_executor.phase != 'MOVE':
                break
        bad = [c for c in drives if getattr(c, 'mode', '') == 'crab' or abs(getattr(c, 'vy', 0.)) > 1e-9]
        self.assertFalse(bad, '4T4D 行驶中不得自动 crab/非零 vy：%r' % (bad[:2],))
        self.assertFalse(m.segment_executor.phase.startswith('CENTER'),
                         '不得进入 CENTER_* 自动横移相位')
        steering = [c for c in drives if abs(getattr(c, 'yaw_rate', 0.)) > 1e-4]
        self.assertTrue(steering, '必须给出非零左右行进转向命令')

    # B. 到码 3cm 残余：不平移、直接进入下一计划动作
    def test_boundary_3cm_residual_no_crab_advances(self):
        m, pose = setup()
        self.enter_move(m, pose)
        for _ in range(200):
            cmd = self.tick(m, pose)
            pose.x += cmd.vx * .05
            if m.state == 'ROW_END':
                break
        self.assertEqual(m.state, 'ROW_END')
        pose.x = m.segment_executor.segment['points'][-1]['x'] + .03   # 相对下一段横向残余 3cm（<5cm 硬门）
        toid = m.segment_executor.segment['toId']
        for _ in range(80):
            cmd = self.tick(m, pose, obs=[{'id': toid}])
            if m.segment_executor.index > 0 or m.state == 'FAULT':
                break
            self.assertEqual(abs(cmd.vy), 0., '到码残余不得触发自动横移')
            self.assertFalse(m.segment_executor.phase.startswith('CENTER'))
            pose.x += cmd.vx * .05
        self.assertFalse(m.segment_executor.phase.startswith('CENTER'))
        self.assertNotIn('FAULT', [e for e in m.events])

    # C. 到码 >5cm：仍停车（不放宽硬门）
    def test_boundary_over_5cm_still_faults(self):
        from test_segment_execution import segment
        s1 = segment((0, 0), (.3, 0))
        s2 = {'id': 's2', 'fromId': 1, 'toId': 2, 'mode': '4t4d', 'direction': 'forward',
              'strategy': 'turn_forward', 'bodyYaw': math.pi / 2, 'endYaw': math.pi / 2, 'wheelAngle': 0.,
              'points': [{'x': .3, 'y': 0.}, {'x': .3, 'y': .15}, {'x': .3, 'y': .3}]}
        m, pose = setup([s1, s2])
        self.enter_move(m, pose)
        for _ in range(200):
            cmd = self.tick(m, pose)
            pose.x += cmd.vx * .05
            if m.state == 'ROW_END':
                break
        pose.x = m.segment_executor.segment['points'][-1]['x'] + .056   # 横向 5.6cm，仍在到码确认半径 6cm 内
        toid = m.segment_executor.segment['toId']
        for _ in range(40):
            self.tick(m, pose, obs=[{'id': toid}])
            if m.state == 'FAULT':
                break
        self.assertEqual(m.state, 'FAULT', '超 5cm 硬门必须停车')
        self.assertTrue(any('横向偏差' in e or '侧偏' in e for e in m.events), str(m.events[:3]))

    # D. 显式规划 crab 路线段仍按计划执行
    def test_planned_crab_segment_still_uses_crab(self):
        crab = {'id': 'crab', 'fromId': 0, 'toId': 1, 'mode': 'crab', 'direction': 'lateral',
                'bodyYaw': 0., 'endYaw': 0., 'wheelAngle': 90.,
                'points': [{'x': 0., 'y': 0.}, {'x': 0., 'y': .3}]}
        m, pose = setup([crab])
        m.field['groups'] = [board_group(1)]
        ex = m.segment_executor
        ex.align()
        crab_fb = self.fb(.05, vx=0., vy=.05)
        crab_fb.update({'body_gear': 8, 'steering_gear': 7, 'steering_angle': 0.})
        cmd = ex.move_command(pose, crab_fb, [], .05)
        self.assertEqual(cmd.mode, 'crab')
        self.assertGreater(abs(cmd.vy), 0.)


if __name__ == '__main__':
    unittest.main(verbosity=2)
