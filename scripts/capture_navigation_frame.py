#!/usr/bin/env python3
"""Save one existing navigation camera frame, subscribing only."""
import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('ROS_LOG_DIR', str(ROOT / 'logs/ros'))
import rclpy
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import CompressedImage

rclpy.init()
node = rclpy.create_node('qr_stationary_frame_capture')
saved = []


def receive(message):
    if saved:
        return
    stamp = message.header.stamp.sec + message.header.stamp.nanosec / 1e9
    age = node.get_clock().now().nanoseconds / 1e9 - stamp
    if not 0 <= age <= .25:
        return
    path = ROOT / 'logs/navigation-stationary-B000.jpg'
    path.write_bytes(bytes(message.data))
    saved.append({'path': str(path), 'stamp': stamp, 'ageMs': age*1000,
                  'topic': '/qr/camera/image/compressed', 'readOnly': True})


try:
    subscription = node.create_subscription(CompressedImage, '/qr/camera/image/compressed',
                                             receive, qos_profile_sensor_data)
    deadline = time.monotonic() + 5
    while not saved and time.monotonic() < deadline:
        rclpy.spin_once(node, timeout_sec=.05)
    if not saved:
        raise SystemExit('没有收到新鲜相机帧')
    (ROOT / 'logs/navigation-stationary-B000-frame.json').write_text(
        json.dumps(saved[0], ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(saved[0], ensure_ascii=False))
finally:
    node.destroy_node()
    rclpy.try_shutdown()
