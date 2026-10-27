"""v10 连续同向直行免停 RED→GREEN（复用已验证的生产链夹具）。"""
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


def seg(a, b, index, mode='4t4d', direction='forward', strategy=None, body_yaw=None):
    ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
    if ang > 90: ang -= 180
    if ang < -90: ang += 180
    yaw = math.atan2(b[1] - a[1], b[0] - a[0]) if body_yaw is None else body_yaw
    d = {'id': str(index), 'fromId': index, 'toId': index + 1, 'mode': mode,
         'direction': direction, 'bodyYaw': yaw, 'endYaw': yaw,
         'wheelAngle': ang if mode == 'crab' else 0.,
         'points': [{'x': a[0], 'y': a[1]},
                    {'x': (a[0] + b[0]) / 2, 'y': (a[1] + b[1]) / 2},
                    {'x': b[0], 'y': b[1]}]}
    if strategy: d['strategy'] = strategy
    return d


class ContinuousStraight(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.seq = 0
        self.loco = {'x': 0., 'y': 0., 'yaw': 0., 'stamp': 100., 'epoch': 'E1'}

    def fb(self, mode='4t4d', angle=0., speed=0.):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed, 'vx': speed,
                'vy_mps': 0., 'vy_raw': 0.,
                'body_gear': 8 if mode == 'crab' else 6,
                'steering_gear': 7 if mode == 'crab' else 5,
                'steering_angle': angle, 'angle_source': 'existing_chassis',
                'angles': [angle] * 4}

    def tick(self, m, pose, speed=0., mode='4t4d', angle=0., obs=None):
        self.now += .05
        self.loco = {'x': pose.x, 'y': pose.y, 'yaw': pose.yaw,
                     'stamp': self.loco['stamp'] + .05, 'epoch': 'E1'}
        ex = m.segment_executor
        return m.tick(pose, self.fb(mode, angle, speed),
                      obs if obs is not None else [{'id': ex.segment['fromId']}], [], .05)

    def enter_move(self, m, pose):
        pose.sigma = .007; pose.stamp = 1.0
        for _ in range(120):
            ex = m.segment_executor
            self.tick(m, pose, speed=.0, mode='4t4d', angle=0.)
            if ex.phase == 'MOVE':
                return
        self.fail('未进入 MOVE：%s' % str(m.events[:5]))

    def run_route(self, m, pose, ticks=900):
        log = []
        for _ in range(ticks):
            ex = m.segment_executor
            vx = .08 if ex.phase == 'MOVE' else .0
            mode = 'crab' if ex.segment.get('mode') == 'crab' else '4t4d'
            angle = m.target_angle if mode == 'crab' else 0.
            cmd = self.tick(m, pose, speed=vx, mode=mode, angle=angle)
            log.append((ex.phase, ex.index, round(cmd.vx, 4), round(cmd.vy, 4), m.state))
            pose.x += cmd.vx * math.cos(pose.yaw) * .05
            pose.y += cmd.vx * math.sin(pose.yaw) * .05
            pose.yaw += cmd.yaw_rate * .05
            if m.state in ('FAULT', 'FINISHED'):
                break
        return log

    def test_three_same_direction_segments_no_stop(self):
        m, pose = setup([seg((0, 0), (.3, 0), 0), seg((.3, 0), (.6, 0), 1),
                         seg((.6, 0), (.9, 0), 2)])
        self.enter_move(m, pose)
        log = self.run_route(m, pose)
        # 只检查“通过中间码（index 0→1→2）期间”不停车；最后一段是 final，本就该停
        passed = [x for x in log if x[1] < 2]
        phases = [x[0] for x in passed]
        self.assertNotIn('END_STOP', phases, '同向连续段（非 final）不得进入 END_STOP')
        self.assertNotIn('ROW_END', [x[4] for x in passed], '不得切 ROW_END 停车')
        zeros = [x for x in passed if x[0] == 'MOVE' and x[2] == 0.0]
        self.assertFalse(zeros, '同向直行不得出现零速指令')
        self.assertGreaterEqual(max(x[1] for x in log), 2, '应连续通过中间码到达最后一段')
        self.assertTrue(getattr(m.segment_executor, 'pass_log', None), '必须记录 passThrough')

    def test_turn_90_stops_then_recenters(self):
        m, pose = setup([seg((0, 0), (.3, 0), 0),
                         seg((.3, 0), (.3, .3), 1, strategy='turn_forward', body_yaw=math.pi / 2)])
        self.enter_move(m, pose)
        log = self.run_route(m, pose)
        self.assertTrue(any(x[0] in ('END_STOP', 'TURN', 'TURN_RECENTER') for x in log),
                        '90° 必须停车/转向：%s' % [x[0] for x in log][:20])

    def test_turn_180_stops(self):
        m, pose = setup([seg((0, 0), (.3, 0), 0),
                         seg((.3, 0), (0., 0.), 1, strategy='turn_forward', body_yaw=math.pi)])
        self.enter_move(m, pose)
        log = self.run_route(m, pose)
        self.assertTrue(any(x[0] in ('END_STOP', 'TURN') for x in log), '180° 必须停车')

    def test_crab_segment_stops(self):
        m, pose = setup([seg((0, 0), (.3, 0), 0),
                         seg((.3, 0), (.3, .3), 1, mode='crab', direction='lateral', body_yaw=0.)])
        self.enter_move(m, pose)
        log = self.run_route(m, pose)
        self.assertTrue(any(x[0] in ('END_STOP', 'ALIGN') for x in log), 'crab 前必须停车')

    def test_reverse_segment_stops(self):
        m, pose = setup([seg((0, 0), (.3, 0), 0), seg((.3, 0), (0., 0.), 1, direction='reverse', body_yaw=0.)])
        self.enter_move(m, pose)
        log = self.run_route(m, pose)
        self.assertTrue(any(x[0] == 'END_STOP' for x in log), 'reverse 前必须停车')

    def test_final_stops(self):
        m, pose = setup([seg((0, 0), (.3, 0), 0)])
        self.enter_move(m, pose)
        log = self.run_route(m, pose)
        self.assertTrue(any(x[0] == 'END_STOP' for x in log), '终点必须停车')

    def test_qr_recorded_while_passing(self):
        m, pose = setup([seg((0, 0), (.3, 0), 0), seg((.3, 0), (.6, 0), 1)])
        self.enter_move(m, pose)
        self.run_route(m, pose)
        ex = m.segment_executor
        self.assertGreaterEqual(ex.index, 1, '应已过第一个码')
        self.assertTrue(getattr(ex, 'pass_log', None) or 'passThrough' in str(ex.exit_info),
                        '免停过码必须记录 passThrough')


if __name__ == '__main__':
    unittest.main(verbosity=2)
