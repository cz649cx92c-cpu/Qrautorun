#!/usr/bin/env python3
"""只订阅真实IMU，检查时效、有限值及仅IMU数据流；不产生运动指令。"""
import json
import math
import time
from pathlib import Path
import rclpy
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Imu
from std_msgs.msg import String

rclpy.init()
node=rclpy.create_node('qr_verify_imu_only')
samples=[]
times=[]
statuses=[]

def receive(msg):
    samples.append(msg)
    times.append(time.monotonic())

subscriptions=[node.create_subscription(Imu,'/odin1/imu',receive,qos_profile_sensor_data),
               node.create_subscription(String,'/qr/imu/status',lambda msg:statuses.append(json.loads(msg.data)),10)]
end=time.monotonic()+8
while time.monotonic()<end:
    rclpy.spin_once(node,timeout_sec=.1)
result={'sampleCount':len(samples),'rateHz':round((len(times)-1)/(times[-1]-times[0]),2) if len(times)>1 else None,
        'status':statuses[-1] if statuses else None,
        'imuPublishers':[p.node_name for p in node.get_publishers_info_by_topic('/odin1/imu')],
        'ownedNodePublishers':node.get_publisher_names_and_types_by_node('odin_imu_only','/'),
        'controlPublishers':{topic:[p.node_name for p in node.get_publishers_info_by_topic(topic)] for topic in ['/ctrl_cmd','/steering_ctrl_cmd','/io_cmd']}}
if samples:
    msg=samples[-1]
    result['last']={'stamp':msg.header.stamp.sec+msg.header.stamp.nanosec/1e9,
                    'ageMs':round((node.get_clock().now().nanoseconds/1e9-msg.header.stamp.sec-msg.header.stamp.nanosec/1e9)*1000,2),
                    'frame':msg.header.frame_id,
                    'acceleration':[msg.linear_acceleration.x,msg.linear_acceleration.y,msg.linear_acceleration.z],
                    'angularVelocity':[msg.angular_velocity.x,msg.angular_velocity.y,msg.angular_velocity.z],
                    'orientationCovariance0':msg.orientation_covariance[0]}
    result['allFinite']=all(all(math.isfinite(v) for v in [m.angular_velocity.x,m.angular_velocity.y,m.angular_velocity.z,m.linear_acceleration.x,m.linear_acceleration.y,m.linear_acceleration.z]) for m in samples)
errors=[]
if not samples:errors.append('IMU尚未出数')
elif not result['allFinite'] or result['last']['orientationCovariance0']!=-1 or not 0<=result['last']['ageMs']<250:errors.append('IMU数据/时效异常')
allowed={'/odin1/imu','/qr/imu/status','/parameter_events','/rosout'}
if any(topic not in allowed for topic,_ in result['ownedNodePublishers']):errors.append('仅IMU节点出现额外发布者')
if any('odin_imu_only' in names for names in result['controlPublishers'].values()):errors.append('仅IMU节点不允许发布底盘命令')
if result['status'] is None or 'packetRates' not in result['status']:errors.append('缺少数据流审计')
else:
    for status in statuses[-3:]:
        if any(status['packetRates'].get(str(t),0) for t in [1,3,4,5,7,8,9]):errors.append('设备仍在传输视觉/深度/SLAM数据');break
result['errors']=errors
result['passed']=not errors
root=Path(__file__).resolve().parents[1]
(root/'logs/imu-only-check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
node.destroy_node()
rclpy.shutdown()
if errors:raise SystemExit('；'.join(errors))
