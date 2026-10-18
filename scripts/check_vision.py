#!/usr/bin/env python3
"""只读实机检测链路检查，不向底盘或传感器发布测试数据。"""
import json
import math
import statistics
import time
from pathlib import Path
import rclpy
from rclpy.qos import qos_profile_sensor_data,QoSProfile,ReliabilityPolicy
from sensor_msgs.msg import CompressedImage,CameraInfo
from std_msgs.msg import String

rclpy.init();node=rclpy.create_node('qr_verify_live_vision')
states=[];camera=[];images=[];observations=[];infos=[]
def receive_image(msg):
    images.append((time.monotonic(),msg.header.stamp.sec+msg.header.stamp.nanosec/1e9))
subscriptions=[node.create_subscription(String,'/qr/detector/status',lambda m:states.append(json.loads(m.data)),20),
               node.create_subscription(String,'/qr/camera/status',lambda m:camera.append(json.loads(m.data)),10),
               node.create_subscription(CompressedImage,'/qr/camera/image/compressed',receive_image,QoSProfile(depth=1,reliability=ReliabilityPolicy.RELIABLE)),
               node.create_subscription(String,'/qr/tags/observations',observations.append,10),
               node.create_subscription(CameraInfo,'/qr/camera/camera_info',infos.append,qos_profile_sensor_data)]
end=time.monotonic()+2.
while time.monotonic()<end:rclpy.spin_once(node,timeout_sec=.05)
states.clear();images.clear();observations.clear();infos.clear();camera.clear()
end=time.monotonic()+8.
while time.monotonic()<end:rclpy.spin_once(node,timeout_sec=.05)
processing=[s['processingMs'] for s in states]
rate=(len(images)-1)/(images[-1][0]-images[0][0]) if len(images)>1 else 0.
errors=[]
if rate<10 or len(states)<70:errors.append('持续检测频率不足10Hz')
if not camera or not camera[-1]['fresh']:errors.append('摄像头未持续出图')
if not states or not 0<=node.get_clock().now().nanoseconds/1e9-states[-1]['frameStamp']<.25:errors.append('检测画面过期')
uncalibrated=not camera or not (camera[-1]['intrinsicsVerified'] and camera[-1]['extrinsicsVerified'])
if uncalibrated and (observations or infos and (not camera or not camera[-1]['intrinsicsVerified'])):errors.append('未标定时不得发布正式位姿或虚构内参')
if any(not math.isfinite(v) for v in processing):errors.append('处理统计无效')
controls={t:[p.node_name for p in node.get_publishers_info_by_topic(t)] for t in ('/ctrl_cmd','/steering_ctrl_cmd','/io_cmd')}
if any(name in ('qr_ground_detector','qr_camera_stream') for names in controls.values() for name in names):errors.append('视觉节点不得发布底盘指令')
result={'passed':not errors,'errors':errors,'frames':len(images),'detectorFrames':len(states),
        'camera':camera[-1] if camera else None,'lastDetection':states[-1] if states else None,
        'imageHz':round(rate,2),'processingMedianMs':statistics.median(processing) if processing else None,
        'processingMaxMs':max(processing) if processing else None,'formalObservations':len(observations),
        'cameraInfoCount':len(infos),'controlPublishers':controls,'metricAccuracyMeasured':False}
(Path(__file__).resolve().parents[1]/'logs/vision-live-check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2));node.destroy_node();rclpy.shutdown()
if errors:raise SystemExit('；'.join(errors))
