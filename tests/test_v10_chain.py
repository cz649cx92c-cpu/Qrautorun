"""v10 剩余源链 RED/GREEN：accepted-QR 锚事件、scope/version、yaw 失效冻结、初始锚。

生产链测试走 Mission/SegmentExecutor（不加载 ROS）；node 侧仅测纯上下文装配函数。
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
from greenhouse_navigation.control import Pose
from greenhouse_navigation.mission import Mission
from greenhouse_navigation.segment_execution import SegmentExecutor
from test_segment_execution import setup, TURN_DEFAULTS

TILE = .0235
SCOPE = {'mapId': 'scan-test-1', 'mapVersion': 5}


def board_group(to_id, ref=1):
    return {'id': 'B0', 'referenceId': ref, 'gridSize': 4, 'sizeMm': 100, 'gapMm': 2,
            'members': [{'id': ref + i, 'x': (i % 4 - 1.5) * .0255, 'y': (1.5 - i // 4) * .0255,
                         'angle': 0., 'size': TILE / 1.25} for i in range(16)]}


def anchor_event(source=10.0, recv=None, map_id=None, version=5, epoch='E1',
                 pose=(0., 0., 0.), local=(0., 0., 0., 100.0), correction_id='c1',
                 sigma=.008, kind='update', posterior_stamp=None, recv_local=None):
    ev = {'kind': kind, 'correctionId': correction_id, 'sourceStamp': source,
          'recvMono': recv, 'recvMonoLocal': recv if recv_local is None else recv_local,
          'mapId': map_id or SCOPE['mapId'], 'mapVersion': version,
          'localEpoch': epoch, 'scopeGeneration': 1,
          'anchorPose': list(pose), 'sigma': sigma,
          'posteriorStamp': local[3] if posterior_stamp is None else posterior_stamp,
          'localRef': {'x': local[0], 'y': local[1], 'yaw': local[2], 'stamp': local[3]}}
    return ev


class DrAnchorUnit(unittest.TestCase):
    def test_mission_scope_from_field_and_task(self):
        from greenhouse_navigation.dr_anchor import mission_scope
        class M: field = {'id': 'scan-test-1'}; task = {'mapVersion': 5}
        self.assertEqual(mission_scope(M()), SCOPE)

    def test_event_scope_and_version_validation(self):
        from greenhouse_navigation.dr_anchor import anchor_event_ok
        now = 100.
        ev = anchor_event(recv=now - .1)
        ok, why = anchor_event_ok(ev, SCOPE, now, current_epoch='E1')
        self.assertTrue(ok, why)
        bad_map = anchor_event(recv=now - .1, map_id='other')
        self.assertFalse(anchor_event_ok(bad_map, SCOPE, now, current_epoch='E1')[0])
        bad_ver = anchor_event(recv=now - .1, version=4)
        self.assertFalse(anchor_event_ok(bad_ver, SCOPE, now, current_epoch='E1')[0])
        bad_epoch = anchor_event(recv=now - .1, epoch='E2')
        self.assertFalse(anchor_event_ok(bad_epoch, SCOPE, now, current_epoch='E1')[0])
        self.assertFalse(anchor_event_ok(anchor_event(recv=now - .1), SCOPE, now,
                                         current_epoch='E1', last_correction_id='c1')[0])

    def test_propagate_anchor_to_current_local_odom(self):
        from greenhouse_navigation.dr_anchor import propagate_anchor
        ev = anchor_event(pose=(1., 2., .3), local=(0., 0., 0., 100.0))
        loco = {'x': .1, 'y': -.05, 'yaw': .05, 'stamp': 100.4, 'epoch': 'E1', 'recvMono': 100.4}
        pose, ok, why = propagate_anchor(ev, loco)
        self.assertTrue(ok, why)
        self.assertAlmostEqual(pose[0], 1 + .1 * math.cos(.3) + .05 * math.sin(.3), places=6)
        self.assertAlmostEqual(pose[1], 2 + .1 * math.sin(.3) - .05 * math.cos(.3), places=6)
        self.assertAlmostEqual(pose[2], .35, places=6)
        # 局部 odom 过期/epoch 变化/时间倒退：不得传播
        for bad in ({**loco, 'stamp': 100.9}, {**loco, 'epoch': 'E2'}, {**loco, 'stamp': 99.}):
            self.assertFalse(propagate_anchor(ev, bad)[1])

    def test_context_assembly(self):
        from greenhouse_navigation.dr_anchor import build_localization_context
        ctx = build_localization_context({'mapId': 'm', 'localEpoch': 'E1'}, {'stamp': 1.}, {'sourceStamp': 2.}, {'correctionId': 'c'})
        self.assertEqual(ctx['mapId'], 'm')
        self.assertEqual(ctx['localOdom']['stamp'], 1.)
        self.assertEqual(ctx['qrRaw']['sourceStamp'], 2.)
        self.assertEqual(ctx['qrAnchor']['correctionId'], 'c')


class YawChain(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.seq = 0
        self.loco_stamp = 100.

    def fb(self, speed=.08, vx=.08):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed, 'vx': vx,
                'vy_mps': 0., 'vy_raw': 0., 'body_gear': 6, 'steering_gear': 5,
                'steering_angle': 0., 'angle_source': 'existing_chassis', 'angles': [0.] * 4}

    def tick(self, m, pose, yaw=None, loco_age=0., vx=.08, anchor=None, raw=None, obs=None):
        self.now += .05
        loco = {'yaw': pose.yaw if yaw is None else yaw, 'stamp': self.loco_stamp + .05,
                'recvMono': self.now - loco_age, 'epoch': 'E1', 'x': pose.x, 'y': pose.y}
        self.loco_stamp += .05
        loc = {'mapId': (m.field or {}).get('id'), 'localEpoch': 'E1', 'localOdom': loco}
        if anchor is not None:
            loc['qrAnchor'] = anchor
        if raw is not None:
            loc['qrRaw'] = raw
        ex = m.segment_executor
        speed = .08 if ex.phase == 'MOVE' else 0.
        return m.tick(pose, self.fb(speed, vx), obs if obs is not None else [{'id': ex.segment['fromId']}], [], .05,
                      localization=loc)

    def enter_move(self, m, pose):
        pose.sigma = .007; pose.stamp = 1.0
        m.field['groups'] = [board_group(m.segment_executor.segment['toId'])]
        for _ in range(30):
            self.tick(m, pose)
            if m.segment_executor.phase == 'MOVE':
                break
        for _ in range(40):
            self.tick(m, pose)
        self.assertEqual(m.segment_executor.phase, 'MOVE')

    def test_same_stamp_different_epoch_invalid(self):
        from greenhouse_navigation.segment_execution import local_yaw_step
        st = {'last_local_yaw': 0., 'last_local_stamp': 10., 'local_epoch': 'E1'}
        dy, ok, why = local_yaw_step(st, {'yaw': .1, 'stamp': 10., 'recvMono': self.now, 'epoch': 'E2'}, self.now)
        self.assertFalse(ok, '不同 epoch 的同 stamp 必须 invalid，不能是 duplicate')
        self.assertEqual(dy, 0.)

    def test_gap_does_not_catch_up_and_requires_anchor(self):
        m, pose = setup()
        self.enter_move(m, pose)
        ex = m.segment_executor
        st = ex.dr_state
        yaw0 = st['pred']['yaw']
        # 局部 odom 中断 1s（recv age > 0.3）
        for _ in range(6):
            self.tick(m, pose, yaw=pose.yaw + .5, loco_age=1.0)
        self.assertAlmostEqual(st['pred']['yaw'], yaw0, delta=1e-9, msg='失效期不得积分/补积转角')
        self.assertFalse(st.get('yawSourceOk', True))
        # 恢复：新帧 yaw 大跳（模拟失联期间旋转），只能重建基准不得补积
        self.tick(m, pose, yaw=pose.yaw + .5)
        self.assertAlmostEqual(st['pred']['yaw'], yaw0, delta=.02, msg='gap 后新帧不得补积失联角')

    def test_yaw_invalid_freezes_xy(self):
        m, pose = setup()
        self.enter_move(m, pose)
        st = m.segment_executor.dr_state
        x0, y0 = st['pred']['x'], st['pred']['y']
        for _ in range(5):
            self.tick(m, pose, loco_age=1.0, vx=.2)
        self.assertAlmostEqual(st['pred']['x'], x0, places=10, msg='yaw 失效时 xy 必须冻结')
        self.assertAlmostEqual(st['pred']['y'], y0, places=10)


class AnchorChain(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.seq = 0
        self.loco_stamp = 100.

    def fb(self, speed=.08, vx=.08):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed, 'vx': vx,
                'vy_mps': 0., 'vy_raw': 0., 'body_gear': 6, 'steering_gear': 5,
                'steering_angle': 0., 'angle_source': 'existing_chassis', 'angles': [0.] * 4}

    def tick(self, m, pose, anchor=None, raw=None, obs=None, qr_only=False):
        self.now += .05
        self.loco_stamp += .05
        ex = m.segment_executor
        loc = {'mapId': (m.field or {}).get('id'), 'localEpoch': 'E1',
               'localOdom': {'yaw': pose.yaw, 'stamp': self.loco_stamp, 'recvMono': self.now,
                             'epoch': 'E1', 'x': pose.x, 'y': pose.y}}
        if anchor is not None:
            loc['qrAnchor'] = anchor
        if raw is not None:
            loc['qrRaw'] = raw
        speed = .08 if ex.phase == 'MOVE' else 0.
        return m.tick(pose, self.fb(speed), obs if obs is not None else [{'id': ex.segment['fromId']}], [], .05,
                      localization=loc)

    def enter_move(self, m, pose, scope=None):
        pose.sigma = .007; pose.stamp = 1.0
        m.field['groups'] = [board_group(m.segment_executor.segment['toId'])]
        if scope:
            m.task['mapId'], m.task['mapVersion'] = scope['mapId'], scope['mapVersion']
        m.field['id'] = (scope or SCOPE)['mapId']
        for _ in range(30):
            self.tick(m, pose)
            if m.segment_executor.phase == 'MOVE':
                break
        for _ in range(40):
            self.tick(m, pose)
        self.assertEqual(m.segment_executor.phase, 'MOVE')

    def test_raw_qr_without_accepted_event_does_not_rebase(self):
        m, pose = setup(); self.enter_move(m, pose)
        st = m.segment_executor.dr_state
        before = st.get('corrections', 0)
        for i in range(6):
            self.tick(m, pose, raw={'sourceStamp': 2.0 + i * .05, 'recvMono': self.now, 'localEpoch': 'E1',
                                    'mapId': (m.field or {}).get('id')},
                      obs=[{'id': m.segment_executor.segment['toId'], 'groupId': 'B0',
                            'visibleCount': 16, 'sigma': .008}])
        self.assertEqual(st.get('corrections', 0), before, '仅有裸观测不得 rebase')
        self.assertNotEqual(st.get('last_decision'), 'qr_track')

    def test_accepted_event_anchors_with_propagation(self):
        m, pose = setup(); self.enter_move(m, pose)
        st = m.segment_executor.dr_state
        self.assertFalse(st.get('anchor_valid', True), '初始不得从任意 pose 构造有效锚')
        pose.x, pose.y = .12, .01
        ev = anchor_event(source=5.0, recv=self.now, pose=(.10, 0., 0.),
                          local=(0., 0., 0., 100.0), epoch='E1')
        ev['localRef']['stamp'] = self.loco_stamp - .05
        ev['posteriorStamp'] = ev['localRef']['stamp']
        self.tick(m, pose, anchor=ev)
        self.assertTrue(st.get('anchor_valid'))
        # 期望 anchor = posterior(.10,0) ⊕ local 位移(.12,.01) ≈ (.22,.01)
        self.assertAlmostEqual(st['anchor_pose'][0], .22, delta=.01)
        self.assertAlmostEqual(st['anchor_pose'][1], .01, delta=.01)
        self.assertEqual(st.get('last_decision'), 'anchored')

    def test_duplicate_correction_id_not_reapplied(self):
        m, pose = setup(); self.enter_move(m, pose)
        st = m.segment_executor.dr_state
        pose.x = .10
        ev = anchor_event(source=5.0, recv=self.now, pose=(.10, 0., 0.), local=(0., 0., 0., self.loco_stamp - .05))
        self.tick(m, pose, anchor=ev)
        corrections = st.get('corrections', 0)
        self.tick(m, pose, anchor=ev)
        self.assertEqual(st.get('corrections', 0), corrections, '同一 correctionId 不得重复处理')

    def test_wrong_scope_or_version_or_stale_rejected(self):
        m, pose = setup(); self.enter_move(m, pose, scope=SCOPE)
        st = m.segment_executor.dr_state
        pose.x = .10
        good = anchor_event(source=5.0, recv=self.now, pose=(.10, 0., 0.), local=(0., 0., 0., self.loco_stamp - .05))
        for bad in (anchor_event(source=6.0, recv=self.now, map_id='other', pose=(.1, 0., 0.)),
                    anchor_event(source=7.0, recv=self.now, version=4, pose=(.1, 0., 0.)),
                    anchor_event(source=8.0, recv=self.now - 2.0, pose=(.1, 0., 0.)),
                    anchor_event(source=9.0, recv=self.now, epoch='E2', pose=(.1, 0., 0.))):
            self.tick(m, pose, anchor=bad)
            self.assertFalse(st.get('anchor_valid', False), '非法 scope/版本/过期/epoch 不得锚定/重锚')
        self.tick(m, pose, anchor=good)
        self.assertTrue(st.get('anchor_valid'), '同 scope 新鲜事件必须可锚定')

    def test_visible_but_rejected_qr_blocks_mechanical_correction(self):
        m, pose = setup(); self.enter_move(m, pose)
        ex = m.segment_executor
        st = ex.dr_state
        # 先给一个有效锚开启纠偏资格
        self.tick(m, pose, anchor=anchor_event(source=3.0, recv=self.now, pose=(0., 0., 0.),
                                               local=(0., 0., 0., self.loco_stamp - .05)))
        # 漂移 + 板一直可见但都低质量（裸观测存在、无 accepted 事件）
        for i in range(20):
            raw = {'sourceStamp': 3.1 + i * .05, 'recvMono': self.now, 'localEpoch': 'E1',
                   'mapId': (m.field or {}).get('id')}
            self.tick(m, pose, raw=raw, obs=[{'id': ex.segment['toId'], 'groupId': 'B0',
                                              'visibleCount': 1, 'sigma': .05}])
            pose.y += .01 * .05
            if ex.phase.startswith('CENTER'):
                break
        self.assertFalse(ex.phase.startswith('CENTER'), '可见但被拒绝的 QR 不得误判为无码并纠偏')
        self.assertEqual(st.get('last_decision'), 'qr_visible_rejected')


    def test_long_gap_with_local_odom_allows_bounded_steering(self):
        m, pose = setup(); self.enter_move(m, pose)
        ex = m.segment_executor
        st = ex.dr_state
        self.tick(m, pose, anchor=anchor_event(source=3.0, recv=self.now, pose=(0., 0., 0.),
                                               local=(0., 0., 0., self.loco_stamp - .05)))
        drove, steered, crab = [], [], []
        for i in range(300):
            self.now += .05; self.loco_stamp += .05; pose.stamp += .05
            loc = {'mapId': (m.field or {}).get('id'), 'localEpoch': 'E1',
                   'localOdom': {'yaw': pose.yaw, 'stamp': self.loco_stamp, 'recvMono': self.now,
                                 'epoch': 'E1', 'x': pose.x, 'y': pose.y}}
            fb = self.fb(.08 if ex.phase == 'MOVE' else 0.)
            fb['vy_mps'] = .03; fb['vy_raw'] = .3
            cmd = m.tick(pose, fb, [{'id': ex.segment['toId']}], [], .05, localization=loc)
            drove.append(cmd)
            if ex.phase != 'MOVE':
                break
            if cmd.mode == 'crab' or abs(cmd.vy) > 1e-9:
                crab.append(cmd)
            if abs(cmd.yaw_rate) > 1e-4:
                steered.append(cmd)
            pose.x += cmd.vx * .05; pose.y += (.03 + cmd.vy) * .05; pose.yaw += cmd.yaw_rate * .05
        self.assertFalse(ex.phase.startswith('CENTER'), '不得再进入自动横移相位')
        self.assertFalse(crab, '4T4D 行进纠偏不得 crab/横移：%r' % (crab[:2],))
        self.assertTrue(steered, 'QR 失联时应给有界左右行进转向')
        self.assertIn(st.get('last_decision'), ('steer_4t4d', 'predict', 'qr_track', 'anchored', 'no_anchor'), str(st.get('last_decision')))

class NodeContext(unittest.TestCase):
    def test_node_context_passes_anchor_and_raw_and_scope(self):
        from greenhouse_navigation.dr_anchor import build_localization_context
        ctx = build_localization_context({'mapId': 'scan-test-1', 'localEpoch': 'E1', 'mapVersion': 5},
                                         {'stamp': 1.0}, {'sourceStamp': 2.0}, {'correctionId': 'c1'})
        self.assertEqual(ctx['qrAnchor']['correctionId'], 'c1')
        self.assertEqual(ctx['qrRaw']['sourceStamp'], 2.0)

def se2_ref(anchor_pose, ref_local, cur_local):
    """独立参考实现：dG = R(aYaw - rYaw)·dL；yaw = aYaw + dyaw。"""
    aX, aY, aYaw = anchor_pose
    dx = cur_local[0] - ref_local[0]
    dy = cur_local[1] - ref_local[1]
    dyaw = math.atan2(math.sin(cur_local[2] - ref_local[2]), math.cos(cur_local[2] - ref_local[2]))
    ang = aYaw - ref_local[2]
    c, s = math.cos(ang), math.sin(ang)
    return [aX + c * dx - s * dy, aY + s * dx + c * dy, aYaw + dyaw]


class Se2Math(unittest.TestCase):
    def test_nonzero_ref_yaw_all_quadrants(self):
        from greenhouse_navigation.dr_anchor import propagate_anchor
        cases = [
            (math.radians(90), .10, .05, math.radians(5), math.radians(20)),
            (math.radians(-90), -.08, .12, math.radians(-7), math.radians(170)),
            (math.radians(37), .03, -.11, math.radians(12), math.radians(-100)),
            (math.radians(180), -.06, -.04, math.radians(3), math.radians(45)),
            (0., .07, -.09, math.radians(-4), math.radians(89)),
        ]
        for ref_yaw, dx, dy, dyaw, anchor_yaw in cases:
            ref = [0., 0., ref_yaw, 100.0]
            cur = {'x': dx, 'y': dy, 'yaw': ref_yaw + dyaw, 'stamp': 100.4, 'epoch': 'E1', 'recvMono': 100.4}
            anchor = [-3.394, .612, anchor_yaw]
            ev = anchor_event(pose=anchor, local=ref, posterior_stamp=100.0)
            got, ok, why = propagate_anchor(ev, cur)
            self.assertTrue(ok, why)
            want = se2_ref(anchor, ref, [dx, dy, ref_yaw + dyaw])
            self.assertAlmostEqual(got[0], want[0], places=9, msg='x ref_yaw=%r' % ref_yaw)
            self.assertAlmostEqual(got[1], want[1], places=9, msg='y ref_yaw=%r' % ref_yaw)
            self.assertAlmostEqual(got[2], want[2], places=9, msg='yaw ref_yaw=%r' % ref_yaw)

    def test_posterior_and_localref_must_share_stamp(self):
        from greenhouse_navigation.dr_anchor import anchor_event_ok
        ev = anchor_event(recv=100., local=(0., 0., 0., 100.0))
        ev['posteriorStamp'] = 99.5
        self.assertFalse(anchor_event_ok(ev, SCOPE, 100., current_epoch='E1')[0],
                         'posterior 与 localRef 非同刻必须拒绝')

    def test_local_receive_time_domain_preferred(self):
        from greenhouse_navigation.dr_anchor import anchor_event_ok
        ev = anchor_event(recv=9999., local=(0., 0., 0., 100.0), recv_local=100.1)
        ok, why = anchor_event_ok(ev, SCOPE, 100.2, current_epoch='E1')
        self.assertTrue(ok, why)

    def test_local_odom_epoch_must_match_event(self):
        from greenhouse_navigation.dr_anchor import propagate_anchor
        ev = anchor_event(local=(0., 0., 0., 100.0), epoch='E1')
        self.assertFalse(propagate_anchor(ev, {'x': 0., 'y': 0., 'yaw': 0., 'stamp': 100.3, 'epoch': 'E2'})[1])


if __name__ == '__main__':
    unittest.main(verbosity=2)
