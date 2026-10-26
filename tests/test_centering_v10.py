"""v10-D：C 修好后激活的机械纠偏闭环（生产 Mission/SegmentExecutor 接口，无 ROS）。"""
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT / 'tests'))
from greenhouse_navigation.control import Pose
from greenhouse_navigation.mission import Mission
from test_segment_execution import setup, TURN_DEFAULTS

TILE = .0235


def board_group(to_id):
    return {'id': 'B0', 'referenceId': to_id, 'gridSize': 4, 'sizeMm': 100, 'gapMm': 2,
            'members': [{'id': to_id + i, 'x': (i % 4 - 1.5) * .0255, 'y': (1.5 - i // 4) * .0255,
                         'angle': 0., 'size': TILE / 1.25} for i in range(16)]}


def setup_heading(yaw, length=.3):
    """沿指定朝向的直线区间（bodyYaw=yaw），其它与 setup() 一致。"""
    config = yaml.safe_load((ROOT / 'config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters']
    config.update(existing_chassis_confirmed=True, existing_runtime_conditions_accepted=True)
    for key, value in TURN_DEFAULTS.items():
        config.setdefault(key, value)
    ux, uy = math.cos(yaw), math.sin(yaw)
    pts = [{'x': 0., 'y': 0.},
           {'x': ux * length / 2, 'y': uy * length / 2},
           {'x': ux * length, 'y': uy * length}]
    seg = {'id': '0', 'fromId': 0, 'toId': 1, 'mode': '4t4d', 'direction': 'forward',
           'bodyYaw': yaw, 'endYaw': yaw, 'wheelAngle': 0., 'points': pts}
    field = {'coordinateStatus': 'reviewed', 'routeMode': 'waypoints', 'motionSegments': [seg],
             'rows': [{'id': 'route', 'name': '测试', 'points': pts[1:], 'start': pts[0], 'exitDistance': .8}],
             'tags': [{'id': 0, **pts[0]}, {'id': 1, **pts[-1]}]}
    task = {'id': 'task', 'rowOrder': ['route'], 'forwardSpeed': .08, 'reverseSpeed': .06,
            'lateralSpeed': .05, 'endWaitSeconds': .2, 'returnToStart': False}
    m = Mission(config)
    pose = Pose(0., 0., yaw)
    m.start(field, task, pose)
    return m, pose


class CenteringV10(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.seq = 0
        self.loco_stamp = 100.

    def fb(self, mode='4t4d', angle=0., speed=.08, vx=.08, vy_mps=0.):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed, 'vx': vx,
                'vy_mps': vy_mps, 'vy_raw': vy_mps * 10., 'body_gear': 8 if mode == 'crab' else 6,
                'steering_gear': 7 if mode == 'crab' else 5, 'steering_angle': angle,
                'angle_source': 'existing_chassis', 'angles': [angle] * 4}

    def tick(self, m, pose, speed=.08, vy_mps=0., obs=None, qr=None, feedback=None):
        self.now += .05
        self.loco_stamp += .05
        ex = m.segment_executor
        mode = 'crab' if ex.phase.startswith('CENTER') else m.mode
        if ex.phase != 'MOVE':
            speed = 0.
        loc = {'mapId': (m.field or {}).get('id'), 'localEpoch': 'E1',
               'localOdom': {'x': pose.x, 'y': pose.y, 'yaw': pose.yaw, 'stamp': self.loco_stamp,
                             'recvMono': self.now, 'epoch': 'E1', 'wz': 0.}}
        if qr is not None:
            loc['qrRaw'] = qr
            self._ev = getattr(self, '_ev', 0) + 1
            loc['qrAnchor'] = {'kind': 'update', 'correctionId': 'ev%d' % self._ev,
                               'sourceStamp': qr.get('sourceStamp'), 'recvMono': self.now,
                               'recvMonoLocal': self.now, 'mapId': loc['mapId'], 'mapVersion': 5,
                               'localEpoch': 'E1', 'scopeGeneration': 1,
                               'anchorPose': [pose.x, pose.y, pose.yaw], 'sigma': .008,
                               'posteriorStamp': self.loco_stamp - .05,
                               'localRef': {'x': pose.x, 'y': pose.y, 'yaw': pose.yaw,
                                            'stamp': self.loco_stamp - .05}}
        obs = obs if obs is not None else [{'id': ex.segment['fromId']}]
        fb = feedback or self.fb(mode=mode, angle=m.target_angle if mode != 'crab' else 0.,
                                 speed=speed, vx=speed, vy_mps=vy_mps)
        return m.tick(pose, fb, obs, [], .05, localization=loc)

    def enter_move(self, m, pose):
        pose.sigma = .007
        pose.stamp = 1.0
        m.field['groups'] = [board_group(m.segment_executor.segment['toId'])]
        for _ in range(30):
            self.tick(m, pose, speed=0.)
            if m.segment_executor.phase == 'MOVE':
                break
        for _ in range(40):
            self.tick(m, pose, speed=.08)
        self.assertEqual(m.segment_executor.phase, 'MOVE')
        qr = {'sourceStamp': 2.0, 'recvMono': self.now, 'localEpoch': 'E1',
              'mapId': (m.field or {}).get('id')}
        self.tick(m, pose, speed=.08, obs=[{'id': m.segment_executor.segment['toId'], 'groupId': 'B0',
                                            'visibleCount': 16, 'sigma': .008}], qr=qr)

    def drive(self, m, pose, vy_mps, max_ticks=400):
        entered = False; finished = False; cmds = []
        last_vy = 0.
        s = m.segment_executor.segment
        for i in range(max_ticks):
            ex = m.segment_executor
            fb_vy = last_vy if ex.phase.startswith('CENTER') else vy_mps
            command = self.tick(m, pose, speed=.08 if ex.phase == 'MOVE' else 0.,
                                vy_mps=fb_vy, obs=[{'id': s['toId']}])
            if ex.phase.startswith('CENTER'):
                entered = True
                if abs(command.vy) > 1e-9:
                    cmds.append(command)
            last_vy = command.vy
            yaw = pose.yaw
            pose.x += (command.vx * math.cos(yaw) - command.vy * math.sin(yaw)) * .05
            pose.y += (command.vx * math.sin(yaw) + command.vy * math.cos(yaw)) * .05
            if ex.phase == 'MOVE' and i > 0:
                pose.x += vy_mps * .05 * -math.sin(yaw)
                pose.y += vy_mps * .05 * math.cos(yaw)
            if entered and ex.phase == 'MOVE' and i > 5:
                finished = True; break
            if m.state == 'FAULT':
                break
        return entered, finished, cmds


    def test_four_quadrants_steering_direction(self):
        """cross 正负 × 航向 0/±90°：4T4D 行进转向方向与横向偏差相反，vy 恒 0。"""
        for yaw, drift in [(0., .03), (0., -.03), (math.pi / 2, .03), (-math.pi / 2, -.03)]:
            m, pose = setup_heading(yaw)
            self.enter_move(m, pose)
            saw, cmds = False, []
            ex = m.segment_executor
            for i in range(200):
                cmd = self.tick(m, pose, speed=.08, vy_mps=drift)
                cmds.append(cmd)
                yawv = pose.yaw
                pose.x += (cmd.vx * math.cos(yawv) - cmd.vy * math.sin(yawv)) * .05
                pose.y += (cmd.vx * math.sin(yawv) + cmd.vy * math.cos(yawv)) * .05
                pose.yaw += cmd.yaw_rate * .05
                if ex.phase != 'MOVE':
                    break
                if abs(cmd.yaw_rate) > 1e-4:
                    saw = True
            self.assertFalse(ex.phase.startswith('CENTER'), '不得自动横移对中')
            self.assertFalse(any(c.mode == 'crab' or abs(c.vy) > 1e-9 for c in cmds),
                             'vy 必须为 0：%r' % [round(c.vy, 4) for c in cmds][:5])
            self.assertTrue(saw, '必须在 4T4D 中给出左右行进转向：%s' % str(m.events[:3]))
            bias = ex.dr_state.get('steerBiasM')
            if bias is not None:
                for c in cmds:
                    if abs(c.yaw_rate) > 1e-4:
                        self.assertLess(c.yaw_rate * bias, 0., '转向必须与预测 cross 反向')
                        break


    def test_fresh_qr_blocks_until_gap_then_steers(self):
        """QR 新鲜期不得 DR 转向纠偏；停更超 min_stale 后才允许行进而非横移。"""
        m, pose = setup()
        self.enter_move(m, pose)
        ex = m.segment_executor
        s = ex.segment
        for i in range(14):
            qr = {'sourceStamp': 2.0 + i * .05, 'recvMono': self.now, 'localEpoch': 'E1',
                  'mapId': (m.field or {}).get('id')}
            obs = [{'id': s['toId'], 'groupId': 'B0', 'visibleCount': 16, 'sigma': .008}]
            self.tick(m, pose, speed=.08, vy_mps=.03, obs=obs, qr=qr)
            self.assertEqual(ex.dr_state.get('last_decision') != 'steer_4t4d', True,
                             'QR 新鲜期内不得触发 DR 转向纠偏')
        saw = False
        for i in range(40):
            cmd = self.tick(m, pose, speed=.08, vy_mps=.03, obs=[{'id': s['toId']}])
            if ex.dr_state.get('last_decision') == 'steer_4t4d':
                saw = True
            self.assertFalse(ex.phase.startswith('CENTER'))
            self.assertEqual(abs(cmd.vy), 0.)
            pose.y += .03 * .05
            pose.yaw += cmd.yaw_rate * .05
        self.assertTrue(saw, 'QR 失联超 min_stale 后应启用 4T4D 转向纠偏')


    def test_planned_crab_feedback_missing_faults_and_stays_zero(self):
        """显式规划 crab 段：档位反馈失效时先零速等待，超时 FAULT（安全门保留）。"""
        from test_segment_execution import segment
        crab = {'id': 'crab', 'fromId': 0, 'toId': 1, 'mode': 'crab', 'direction': 'lateral',
                'bodyYaw': 0., 'endYaw': 0., 'wheelAngle': 90.,
                'points': [{'x': 0., 'y': 0.}, {'x': 0., 'y': .15}, {'x': 0., 'y': .3}]}
        m, pose = setup([crab])
        m.field['id'] = 'scan-test-1'; m.task['mapVersion'] = 5
        ex = m.segment_executor
        for _ in range(20):
            self.tick(m, pose)
            if ex.phase == 'MOVE':
                break
        bad = self.fb(mode='crab', speed=0.); bad['body_gear'] = 1
        zero_ok = True
        for _ in range(260):
            self.now += .05
            cmd = m.tick(pose, bad, [{'id': 1}], [], .05,
                         localization={'mapId': 'scan-test-1', 'localEpoch': 'E1',
                                       'localOdom': {'x': pose.x, 'y': pose.y, 'yaw': pose.yaw,
                                                     'stamp': self.loco_stamp + .05,
                                                     'recvMono': self.now, 'epoch': 'E1'}})
            if abs(cmd.vx) > 1e-9 or abs(cmd.vy) > 1e-9:
                zero_ok = False
            if m.state == 'FAULT':
                break
        self.assertTrue(zero_ok, '档位反馈失效期间必须零速')
        self.assertEqual(m.state, 'FAULT', '规划 crab 段档位反馈持续失效必须故障：%s' % str(m.events[:3]))

if __name__ == '__main__':
    unittest.main(verbosity=2)
