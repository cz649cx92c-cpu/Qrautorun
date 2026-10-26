"""v10 生产链集成回归（RED→GREEN）：真实 ROS 消息 → 实际 node 回调 → 实际 mission/segment。

只 mock ROS I/O 边界（Node 基类），不手工构造 localOdom dict 绕过真实回调。
"""
import json
import math
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))
sys.path.insert(0, str(ROOT / 'tests'))
os.environ['QR_DIAG_DISABLE'] = '1'

from rclpy.time import Time
from nav_msgs.msg import Odometry
from std_msgs.msg import String
from greenhouse_navigation.control import Pose
from greenhouse_navigation.node import GreenhouseNode
from greenhouse_navigation.dr_anchor import build_localization_context
from test_segment_execution import setup

TILE = .0235
SCOPE = {'mapId': 'scan-test-1', 'mapVersion': 5}


def odom_msg(x=0., y=0., yaw=0., stamp=100.0, frame='odom', child='base_link'):
    m = Odometry()
    m.header.frame_id = frame
    m.child_frame_id = child
    m.header.stamp.sec = int(stamp)
    m.header.stamp.nanosec = int((stamp - int(stamp)) * 1e9)
    m.pose.pose.position.x = x
    m.pose.pose.position.y = y
    m.pose.pose.orientation.z = math.sin(yaw / 2.)
    m.pose.pose.orientation.w = math.cos(yaw / 2.)
    m.twist.twist.angular.z = 0.
    return m


def anchor_msg(correction_id='c1', source=10.0, pose=(0., 0., 0.), local=(0., 0., 0., 100.0),
               epoch='E1', map_id=SCOPE['mapId'], version=5, posterior_stamp=100.0, recv_mono=100.0):
    return String(data=json.dumps({
        'kind': 'update', 'correctionId': correction_id, 'sourceStamp': source,
        'recvMono': recv_mono, 'mapId': map_id, 'mapVersion': version, 'localEpoch': epoch,
        'scopeGeneration': 1, 'anchorPose': list(pose), 'sigma': .008,
        'posteriorStamp': posterior_stamp,
        'localRef': {'x': local[0], 'y': local[1], 'yaw': local[2], 'stamp': local[3]}}))


class RealCallbackChain(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.clock = patch('time.monotonic', lambda: self.now)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.seq = 0
        self.node = object.__new__(GreenhouseNode)
        self.node.fusion = {'epoch': 'E1'}
        self.node.local_odom = None
        self.node.qr_anchor = None
        self.node.qr_meta = None
        self.node.localization_status = {'mapId': SCOPE['mapId'], 'mapVersion': 5, 'localEpoch': 'E1'}

    # ---- 实际 node 回调（只有 Node 基类被隔离） ----
    def feed_odom(self, **kw):
        self.node.local_odom_cb(odom_msg(**kw))
        return self.node.local_odom

    def feed_anchor(self, **kw):
        self.node.anchor_event_cb(anchor_msg(**kw))
        return self.node.qr_anchor

    def fb(self, speed=.08, vx=.08):
        self.seq += 1
        return {'seq': self.seq, 'aggregate_received': self.now, 'speed': speed, 'vx': vx,
                'vy_mps': 0., 'vy_raw': 0., 'body_gear': 6, 'steering_gear': 5,
                'steering_angle': 0., 'angle_source': 'existing_chassis', 'angles': [0.] * 4}

    def context(self):
        return build_localization_context(self.node.localization_status, self.node.local_odom,
                                          self.node.qr_meta, self.node.qr_anchor)

    def test_red_local_odom_cb_must_expose_finite_xy(self):
        """旧代码不存 x/y：真实回调产物缺 x/y → 传播必须报 badLocalOdom:x。"""
        loco = self.feed_odom(x=.12, y=-.03, yaw=.4, stamp=100.0)
        self.assertIsNotNone(loco)
        for key in ('x', 'y', 'yaw', 'stamp'):
            self.assertIn(key, loco, 'local_odom_cb 必须从真实消息保存 ' + key)
            self.assertTrue(math.isfinite(loco[key]) and loco[key] is not None)

    def test_red_anchor_through_real_callbacks_cannot_anchor_without_xy(self):
        self.feed_odom(x=0., y=0., yaw=0., stamp=100.0)
        self.feed_anchor(pose=(-.76, -.18, math.radians(179)), local=(0., 0., 0., 100.0),
                         posterior_stamp=100.0)
        ctx = self.context()
        self.assertIsNotNone(ctx.get('qrAnchor') and ctx.get('localOdom'))
        m, pose = setup()
        pose.sigma = .007; pose.stamp = 1.0
        m.field['id'] = SCOPE['mapId']; m.task['mapVersion'] = 5
        m.field['groups'] = [{'id': 'B0', 'referenceId': m.segment_executor.segment['toId'],
                              'gridSize': 4, 'sizeMm': 100, 'gapMm': 2,
                              'members': [{'id': 1 + i, 'x': (i % 4 - 1.5) * .0255,
                                           'y': (1.5 - i // 4) * .0255, 'angle': 0., 'size': TILE / 1.25}
                                          for i in range(16)]}]
        for _ in range(30):
            self.now += .05
            m.tick(pose, self.fb(0., 0.), [{'id': m.segment_executor.segment['fromId']}], [], .05,
                   localization=self.context())
            if m.segment_executor.phase == 'MOVE':
                break
        # 事件必须新鲜（生产上 localization 在观察时立即发），同刻 posterior/localRef
        self.feed_odom(x=0., y=0., yaw=0., stamp=100.0)
        self.feed_anchor(pose=(-.76, -.18, math.radians(179)), local=(0., 0., 0., 100.0),
                         posterior_stamp=100.0, recv_mono=self.now)
        self.now += .05
        m.tick(pose, self.fb(.08, .08), [{'id': m.segment_executor.segment['fromId']}], [], .05,
               localization=self.context())
        st = m.segment_executor.dr_state
        self.assertTrue(st.get('anchor_valid'),
                        '真实回调链必须能建立锚；拒绝原因=%s' % st.get('anchor_reject_reason'))
        self.assertNotEqual(st.get('anchor_reject_reason'), 'badLocalOdom:x')

    def test_anchor_callback_preserves_all_fields(self):
        self.feed_odom(x=0., y=0., yaw=0., stamp=100.0)
        self.feed_anchor(pose=(1., 2., .3), local=(.1, .2, .1, 99.8), posterior_stamp=99.8)
        ev = self.node.qr_anchor
        for key in ('correctionId', 'sourceStamp', 'mapId', 'mapVersion', 'localEpoch',
                    'anchorPose', 'posteriorStamp', 'localRef'):
            self.assertIn(key, ev)
        self.assertEqual(ev['posteriorStamp'], ev['localRef']['stamp'])

    def test_invalid_local_odom_not_stored(self):
        bad = odom_msg(x=float('nan'), y=0., stamp=100.0)
        self.node.local_odom_cb(bad)
        self.assertIsNone(self.node.local_odom, '非有限坐标不得存成有效局部里程')
        wrong = odom_msg(frame='map', stamp=100.0)
        self.node.local_odom_cb(wrong)
        self.assertIsNone(self.node.local_odom, '错误 frame 不得接受')
    def test_stale_grows_after_real_anchor_and_pose_stamp_refresh(self):
        self.feed_odom(x=0., y=0., yaw=0., stamp=100.0)
        self.feed_anchor(pose=(-.76, -.18, math.radians(179)), local=(0., 0., 0., 100.0),
                         posterior_stamp=100.0, recv_mono=self.now)
        m, pose = setup()
        pose.sigma = .007; pose.stamp = 1.0
        m.field['id'] = SCOPE['mapId']; m.task['mapVersion'] = 5
        m.field['groups'] = [{'id': 'B0', 'referenceId': m.segment_executor.segment['toId'],
                              'gridSize': 4, 'sizeMm': 100, 'gapMm': 2,
                              'members': [{'id': 1 + i, 'x': (i % 4 - 1.5) * .0255,
                                           'y': (1.5 - i // 4) * .0255, 'angle': 0., 'size': TILE / 1.25}
                                          for i in range(16)]}]
        for _ in range(30):
            self.now += .05
            m.tick(pose, self.fb(0., 0.), [{'id': m.segment_executor.segment['fromId']}], [], .05,
                   localization=self.context())
            if m.segment_executor.phase == 'MOVE':
                break
        self.feed_odom(x=0., y=0., yaw=0., stamp=100.0)
        self.feed_anchor(pose=(-.76, -.18, math.radians(179)), local=(0., 0., 0., 100.0),
                         posterior_stamp=100.0, recv_mono=self.now)
        self.now += .05
        m.tick(pose, self.fb(.08, .08), [{'id': m.segment_executor.segment['fromId']}], [], .05,
               localization=self.context())
        st = m.segment_executor.dr_state
        self.assertTrue(st.get('anchor_valid'))
        stale0 = st['staleS']
        for i in range(8):   # 无 QR；局部 odom 与融合 pose stamp 持续刷新
            self.now += .05
            self.feed_odom(x=0., y=0., yaw=0., stamp=100.0 + (i + 1) * .05)
            pose.stamp += .05
            m.tick(pose, self.fb(.08, .08), [{'id': m.segment_executor.segment['fromId']}], [], .05,
                   localization=self.context())
        self.assertTrue(m.segment_executor.dr_state['anchor_valid'], '锚不得因融合 pose 刷新丢失')
        self.assertGreater(m.segment_executor.dr_state['staleS'], .25 + stale0 - .1,
                           'QR 失联计时必须持续增长，不能被 pose stamp 重置')



if __name__ == '__main__':
    unittest.main(verbosity=2)
