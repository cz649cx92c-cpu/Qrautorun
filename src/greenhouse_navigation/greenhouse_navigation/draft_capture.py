"""手柄扫描草稿：接收时戳+临时局部融合，仅发布独立草稿Topic。"""
from collections import deque
import json
import math
import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry
from std_msgs.msg import String
from .control import wrap


def interpolate_pose(poses, stamp):
    for (a, p), (b, q) in zip(poses, list(poses)[1:]):
        if a <= stamp <= b and 0 < b-a < .1:
            t = (stamp-a)/(b-a)
            return {'x': p['x']+(q['x']-p['x'])*t,
                    'y': p['y']+(q['y']-p['y'])*t,
                    'yaw': wrap(p['yaw']+wrap(q['yaw']-p['yaw'])*t)}
    return None


def draft_packet(batch, pose, epoch):
    if (batch.get('calibrated') is not True or batch.get('frame') != 'base_link'
            or batch.get('representation') != 'board-centers' or not batch.get('tags')
            or not epoch or not all(math.isfinite(pose[k]) for k in ('x', 'y', 'yaw'))):
        raise ValueError('草稿观测无效')
    return {**batch, 'localPose': pose, 'localPoseSynchronized': True,
            'synchronized': False, 'quality': 'draft', 'localEpoch': epoch,
            'timestampSource': 'server_receive'}


class DraftCapture(Node):
    def __init__(self):
        super().__init__('qr_draft_capture')
        self.poses = deque(maxlen=300)
        self.pending = deque(maxlen=8)
        self.fusion = {}; self.camera = {}; self.epoch = ''; self.count = 0
        self.pub = self.create_publisher(String, '/qr/tags/draft_observations', 10)
        self.status_pub = self.create_publisher(String, '/qr/draft/status', 10)
        self.create_subscription(Odometry, '/qr/odometry/provisional', self.odom, 20)
        self.create_subscription(String, '/qr/fusion/status', self.fusion_cb, 10)
        self.create_subscription(String, '/qr/camera/status', self.camera_cb, 10)
        self.create_subscription(String, '/qr/tags/provisional', self.tags, 10)
        self.create_timer(.02, self.dispatch)
        self.create_timer(.2, self.status)

    def now(self): return self.get_clock().now().nanoseconds/1e9

    def fusion_cb(self, msg):
        try:
            data = json.loads(msg.data)
            epoch = data.get('epoch', '')
            if epoch != self.epoch:
                self.poses.clear(); self.pending.clear(); self.epoch = epoch
            self.fusion = data
            if not data.get('ready'):
                self.poses.clear(); self.pending.clear()
        except (ValueError, TypeError): pass

    def camera_cb(self, msg):
        try: self.camera = json.loads(msg.data)
        except (ValueError, TypeError): pass

    def reason(self):
        now = self.now()
        if not self.epoch or not 0 <= now-float(self.fusion.get('stamp', 0)) < .5:
            return '等待局部融合'
        if self.fusion.get('state') == 'CALIBRATING': return '保持静止，IMU校零中'
        if not self.fusion.get('ready'):
            return self.fusion.get('reason') or '等待轮式/IMU数据'
        # 正式局部里程计就绪不代表相机采集时间已验证；仍允许独立草稿观测。
        if self.fusion.get('mappingReady') and self.camera.get('captureTimestampVerified') is True:
            return '已切换正式融合，请使用正式观测'
        if not (0 <= now-float(self.camera.get('stamp', 0)) < .5
                and self.camera.get('fresh') and self.camera.get('intrinsicsVerified')
                and self.camera.get('extrinsicsVerified')): return '等待已标定相机'
        if not self.poses or not 0 <= now-self.poses[-1][0] < .25:
            return '等待连续局部位姿'
        return ''

    def odom(self, msg):
        if not self.epoch or msg.header.frame_id != 'odom' or msg.child_frame_id != 'base_link': return
        stamp = msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        q = msg.pose.pose.orientation
        if not 0 <= self.now()-stamp < .25: return
        if abs(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w-1) > .02: return
        pose = {'x': msg.pose.pose.position.x, 'y': msg.pose.pose.position.y,
                'yaw': math.atan2(2*(q.w*q.z+q.x*q.y), 1-2*(q.y*q.y+q.z*q.z))}
        if not all(math.isfinite(v) for v in pose.values()): return
        if self.poses and stamp <= self.poses[-1][0]:
            self.poses.clear(); self.pending.clear()
        self.poses.append((stamp, pose))

    def tags(self, msg):
        try:
            batch = json.loads(msg.data)
            if not self.reason() and 0 <= self.now()-float(batch['stamp']) < .25:
                self.pending.append(batch)
        except (ValueError, KeyError, TypeError): pass

    def dispatch(self):
        if self.reason(): self.pending.clear(); return
        for _ in range(len(self.pending)):
            batch = self.pending.popleft()
            if not 0 <= self.now()-float(batch['stamp']) < .25: continue
            pose = interpolate_pose(self.poses, batch['stamp'])
            if pose is None: self.pending.append(batch); continue
            try: payload = draft_packet(batch, pose, self.epoch)
            except (ValueError, KeyError, TypeError): continue
            self.pub.publish(String(data=json.dumps(payload))); self.count += 1

    def status(self):
        reason = self.reason()
        self.status_pub.publish(String(data=json.dumps({'stamp': self.now(),
            'ready': not bool(reason), 'quality': 'draft', 'reason': reason,
            'localEpoch': self.epoch, 'count': self.count,
            'lateralSupported': bool(self.fusion.get('ready') and self.fusion.get('lateralSupported'))})))


def main(args=None):
    rclpy.init(args=args); node = DraftCapture()
    try: rclpy.spin(node)
    except KeyboardInterrupt: pass
    finally: node.destroy_node(); rclpy.try_shutdown()
