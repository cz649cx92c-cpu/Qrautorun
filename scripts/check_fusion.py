#!/usr/bin/env python3
"""订阅真实融合输出并保存检查证据；不发布传感器样本或底盘命令。"""
import json
import math
import time
from pathlib import Path
import rclpy
from nav_msgs.msg import Odometry
from std_msgs.msg import String
from sensor_msgs.msg import Imu
from rclpy.qos import qos_profile_sensor_data

rclpy.init()
node = rclpy.create_node('qr_verify_fusion_read_only')
outputs = []
times = []
statuses = []
gyros = []
qualified = []
def receive(msg):
    outputs.append(msg)
    times.append(time.monotonic())
subscriptions = [node.create_subscription(Odometry, '/qr/odometry/provisional', receive, 20),
                 node.create_subscription(Odometry, '/qr/odometry/local', qualified.append, 20),
                 node.create_subscription(String, '/qr/fusion/status', lambda m: statuses.append(json.loads(m.data)), 20),
                 node.create_subscription(Imu, '/qr/fusion/imu_input', gyros.append, qos_profile_sensor_data)]
end = time.monotonic()+10.
while time.monotonic() < end:
    rclpy.spin_once(node, timeout_sec=.1)
owned = {name: node.get_publisher_names_and_types_by_node(name, '/') for name in ('qr_fusion_inputs', 'ekf_filter_node')}
controls = {topic: [p.node_name for p in node.get_publishers_info_by_topic(topic)] for topic in ('/ctrl_cmd', '/steering_ctrl_cmd', '/io_cmd')}
errors = []
if len(outputs) < 200:
    errors.append('融合输出不足200帧/10秒')
if not statuses or not statuses[-1].get('ready'):
    errors.append('融合输入尚未就绪')
if not gyros:
    errors.append('IMU未进入融合')
if statuses and statuses[-1]['source'] == 'legacy' and (qualified or statuses[-1].get('mappingReady')):
    errors.append('未标定的旧里程计不应进入正式建图')
if any(topic in ('/ctrl_cmd','/steering_ctrl_cmd','/io_cmd','/tf','/tf_static') for pubs in owned.values() for topic,_ in pubs):
    errors.append('融合节点不应发布底盘命令或争用TF')
last = None
if outputs:
    m = outputs[-1]
    q = m.pose.pose.orientation
    stamp = m.header.stamp.sec+m.header.stamp.nanosec/1e9
    last = {'stamp': stamp, 'ageMs': (node.get_clock().now().nanoseconds/1e9-stamp)*1000,
            'frame': m.header.frame_id, 'childFrame': m.child_frame_id,
            'position': [m.pose.pose.position.x, m.pose.pose.position.y],
            'yawRad': math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z)),
            'velocity': [m.twist.twist.linear.x,m.twist.twist.linear.y,m.twist.twist.angular.z],
            'poseVariances': [m.pose.covariance[i] for i in (0,7,35)]}
    if not 0 <= last['ageMs'] < 250:
        errors.append('融合输出过期')
    if any(not math.isfinite(v) for m in outputs for v in list(m.pose.covariance)+list(m.twist.covariance)+[m.pose.pose.position.x,m.pose.pose.position.y,m.pose.pose.orientation.z,m.pose.pose.orientation.w,m.twist.twist.linear.x,m.twist.twist.linear.y,m.twist.twist.angular.z]):
        errors.append('融合输出包含非有限值')
result = {'passed': not errors, 'errors': errors, 'sampleCount': len(outputs),
          'outputHz': round((len(times)-1)/(times[-1]-times[0]),2) if len(times)>1 else None,
          'qualifiedSamples': len(qualified), 'gyroSamples': len(gyros),
          'status': statuses[-1] if statuses else None, 'last': last,
          'ownedPublishers': owned, 'controlPublishers': controls,
          'accuracyMeasured': False, 'motionCommandSent': False}
(Path(__file__).resolve().parents[1]/'logs/fusion-check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
node.destroy_node()
rclpy.shutdown()
if errors:
    raise SystemExit('；'.join(errors))
