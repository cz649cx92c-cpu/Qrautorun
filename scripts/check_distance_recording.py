#!/usr/bin/env python3
"""检查订阅与文件增长；不打开正在写入的rosbag SQLite数据库。"""
import json
import subprocess
import time
from pathlib import Path
import rclpy
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Imu
from nav_msgs.msg import Odometry
from yhs_can_interfaces.msg import ChassisInfoFb

ROOT = Path(__file__).resolve().parents[1]
active = json.loads((ROOT/'logs/motion-tests/active.json').read_text())
folder = Path(active['folder']).resolve()
if not folder.is_relative_to((ROOT/'logs/motion-tests').resolve()):
    raise SystemExit('测试记录路径无效')

def file_bytes():
    return sum(p.stat().st_size for p in (folder/'rosbag').glob('*.db3'))

rclpy.init()
node = rclpy.create_node('qr_distance_record_check')
counts = {'feedback': 0, 'odom': 0, 'imu': 0}
last = {}

def receive(kind, msg):
    counts[kind] += 1
    last[kind] = msg

topics = [('feedback', ChassisInfoFb, '/chassis_info_fb'),
          ('odom', Odometry, '/odom'), ('imu', Imu, '/odin1/imu')]
subscriptions = [node.create_subscription(cls, topic,
    lambda msg, key=kind: receive(key, msg), qos_profile_sensor_data)
    for kind, cls, topic in topics]
before = file_bytes()
try:
    end = time.monotonic()+6
    while time.monotonic() < end:
        rclpy.spin_once(node, timeout_sec=.05)
    after = file_bytes()
    recorder_topics = {topic for topic, _ in
        node.get_subscriber_names_and_types_by_node('rosbag2_recorder', '/')}
    controls = {t: [p.node_name for p in node.get_publishers_info_by_topic(t)]
                for t in ('/ctrl_cmd', '/steering_ctrl_cmd', '/io_cmd')}
    now = node.get_clock().now().nanoseconds/1e9
    ages = {key: now-msg.header.stamp.sec-msg.header.stamp.nanosec/1e9
            for key, msg in last.items()}
finally:
    node.destroy_node()
    rclpy.shutdown()
service = subprocess.run(['systemctl', '--user', 'is-active', 'qr-distance-test.service'],
                         capture_output=True, text=True).stdout.strip()
passed = (all(counts.values()) and service == 'active' and after > before
          and all(topic in recorder_topics for _, _, topic in topics)
          and all(0 <= age < .5 for age in ages.values())
          and all('rosbag2_recorder' not in names for names in controls.values()))
result = {'passed': passed, 'testId': active['id'], 'service': service,
          'liveCounts': counts, 'messageAgeS': ages,
          'recorderSubscriptions': sorted(recorder_topics),
          'fileBytesBefore': before, 'fileBytesAfter': after,
          'controlPublishers': controls, 'hardwareControl': False}
(folder/'recording-check.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if not passed:
    raise SystemExit('记录检查未通过，请暂不移动车辆')
