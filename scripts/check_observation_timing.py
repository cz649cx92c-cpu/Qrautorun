#!/usr/bin/env python3
"""Passive timing experiment; no control publishers, hardware writes or motion."""
import argparse
import bisect
import collections
import json
import math
import os
import statistics
import time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def summary(values):
    values=sorted(v for v in values if isinstance(v,(int,float)) and math.isfinite(v))
    if not values:return {'count':0}
    def quantile(q):
        index=(len(values)-1)*q;low=math.floor(index);high=math.ceil(index)
        return values[low]+(values[high]-values[low])*(index-low)
    return {'count':len(values),'min':values[0],'median':quantile(.5),'p95':quantile(.95),'max':values[-1]}


def local_at(history,stamp,epoch):
    samples=[p for p in history if p['epoch']==epoch]
    times=[p['stamp'] for p in samples]
    i=bisect.bisect_left(times,stamp)
    if i<len(times) and times[i]==stamp:return samples[i]['pose']
    if i==0 or i==len(times):return None
    a,b=samples[i-1],samples[i]
    gap=b['stamp']-a['stamp']
    if not 0<gap<=.1:return None
    fraction=(stamp-a['stamp'])/gap
    p,q=a['pose'],b['pose']
    yaw_delta=math.atan2(math.sin(q[2]-p[2]),math.cos(q[2]-p[2]))
    yaw=p[2]+fraction*yaw_delta
    return [p[0]+fraction*(q[0]-p[0]),p[1]+fraction*(q[1]-p[1]),math.atan2(math.sin(yaw),math.cos(yaw))]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds',type=float,default=15.)
    parser.add_argument('--output',type=Path,default=ROOT/'logs/observation-timing-20261015.json')
    args=parser.parse_args()
    if not 5<=args.seconds<=45:parser.error('seconds must be 5..45')
    os.environ.setdefault('ROS_LOG_DIR',str(ROOT/'logs/ros'))
    import rclpy
    from rclpy.qos import qos_profile_sensor_data
    from sensor_msgs.msg import CompressedImage,Imu
    from nav_msgs.msg import Odometry
    from std_msgs.msg import String
    from yhs_can_interfaces.msg import ChassisInfoFb
    rclpy.init();node=rclpy.create_node('qr_observation_timing_read_only')
    counts=collections.Counter();ages=collections.defaultdict(list);latest={}
    images=[];detections=[];observations=[];history=[];velocities=[]
    epoch='';controls=('/ctrl_cmd','/steering_ctrl_cmd','/io_cmd')
    def publishers():return {t:[{'name':p.node_name,'namespace':p.node_namespace} for p in node.get_publishers_info_by_topic(t)] for t in controls}
    def now():return node.get_clock().now().nanoseconds/1e9
    def header_stamp(msg):return msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
    def record(topic,stamp):
        counts[topic]+=1;age=now()-stamp
        if math.isfinite(age):ages[topic].append(age*1000)
        return math.isfinite(age) and 0<=age<=.25
    def image(msg):
        stamp=header_stamp(msg)
        if record('image',stamp):images.append(stamp)
    def imu(msg):record('imu',header_stamp(msg))
    def odom(msg):
        stamp=header_stamp(msg)
        if not record('localOdom',stamp) or not epoch or msg.header.frame_id!='odom' or msg.child_frame_id!='base_link':return
        q=msg.pose.pose.orientation
        pose=[msg.pose.pose.position.x,msg.pose.pose.position.y,math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))]
        if not all(math.isfinite(v) for v in pose):return
        # Epoch is required, and out-of-order poses cannot be interpolated.
        if history and history[-1]['epoch']==epoch and stamp<=history[-1]['stamp']:return
        history.append({'stamp':stamp,'pose':pose,'epoch':epoch})
    def feedback(msg):
        if not record('feedback',header_stamp(msg)):return
        c=msg.ctrl_fb
        speed=max(math.hypot(c.ctrl_fb_x_linear,c.ctrl_fb_y_linear*.1),
            abs(msg.steering_ctrl_fb.steering_ctrl_fb_velocity),
            abs(msg.lf_wheel_fb.lf_wheel_fb_velocity),abs(msg.rf_wheel_fb.rf_wheel_fb_velocity),
            abs(msg.lr_wheel_fb.lr_wheel_fb_velocity),abs(msg.rr_wheel_fb.rr_wheel_fb_velocity))
        velocities.append({'speedMps':speed,'yawRateDegS':abs(c.ctrl_fb_z_angular)})
    def status(topic,msg):
        nonlocal epoch
        try:
            data=json.loads(msg.data)
            if not isinstance(data,dict) or not record(topic,float(data['stamp'])):return
            latest[topic]=data
            if topic=='fusion':
                epoch=data.get('epoch','') if data.get('ready') and data.get('state')=='FUSED' else ''
            elif topic=='detector':detections.append(data)
            elif topic=='tags':observations.append({'data':data,'epoch':epoch})
        except (ValueError,KeyError,TypeError):counts[topic+'Rejected']+=1
    subscriptions=[node.create_subscription(CompressedImage,'/qr/camera/image/compressed',image,qos_profile_sensor_data),
        node.create_subscription(Imu,'/qr/imu/raw',imu,qos_profile_sensor_data),
        node.create_subscription(Odometry,'/qr/odometry/local',odom,qos_profile_sensor_data),
        node.create_subscription(ChassisInfoFb,'/chassis_info_fb',feedback,qos_profile_sensor_data)]
    for topic,path in [('fusion','/qr/fusion/status'),('camera','/qr/camera/status'),('detector','/qr/detector/status'),('tags','/qr/tags/provisional')]:
        subscriptions.append(node.create_subscription(String,path,lambda msg,t=topic:status(t,msg),qos_profile_sensor_data))
    started=time.monotonic();before=publishers()
    try:
        while time.monotonic()-started<args.seconds:rclpy.spin_once(node,timeout_sec=.03)
        after=publishers();sweeps=[]
        for delay_ms in (0,20,40,60,80,100,150,200):
            eligible=[o for o in observations if o['epoch'] and o['data'].get('calibrated') is True and o['data'].get('tags')]
            covered=sum(local_at(history,o['data']['stamp']-delay_ms/1000,o['epoch']) is not None for o in eligible)
            sweeps.append({'assumedDelayMs':delay_ms,'eligibleFrames':len(eligible),'interpolatableFrames':covered,'coverage':covered/len(eligible) if eligible else None,'captureDelayMeasured':False})
        max_speed=max((v['speedMps'] for v in velocities),default=None)
        max_yaw=max((v['yawRateDegS'] for v in velocities),default=None)
        issues=[]
        if not velocities:issues.append('底盘反馈为0帧，不能确认静止或限制授权行程；不发车。')
        if not history:issues.append('无正式局部里程计，不能进行图像时刻插值。')
        if not images:issues.append('无新鲜相机图像。')
        if not any(d.get('validBoardCount',0)>0 for d in detections):issues.append('未获得有效定位板中心。')
        result={'readOnly':True,'motionCommandsSent':0,'sampleSeconds':time.monotonic()-started,
          'counts':dict(counts),'receiveAgeMs':{k:summary(v) for k,v in ages.items()},
          'serverToRosImageAgeMs':summary(ages['image']),
          'detectorProcessingMs':summary(d.get('processingMs') for d in detections),
          'serverToDetectionReadyEstimateMs':summary(d.get('imageAgeMs',0)+d.get('processingMs',0) for d in detections),
          'cameraCaptureDelayMeasured':False,'captureTimestampVerified':latest.get('camera',{}).get('captureTimestampVerified',False),
          'timestampSource':latest.get('camera',{}).get('timestampSource'),
          'maxSpeedMps':max_speed,'maxYawRateDegS':max_yaw,'localEpochs':sorted(set(p['epoch'] for p in history)),
          'assumedDelaySweep':sweeps,'latest':latest,'commandPublishersBefore':before,'commandPublishersAfter':after,
          'issues':issues,'notes':['延迟统计从服务器接收JPEG开始，不包含相机曝光至服务器的未知延迟。',
           '静止采样不能识别相机曝光延迟；不会据此选择一个延迟数值或改成采时已验证。',
           '0..200ms扫描是历史位姿缓存覆盖检查，假设值不作为实测标定结果。']}
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({k:result[k] for k in ('readOnly','counts','serverToRosImageAgeMs','detectorProcessingMs','maxSpeedMps','issues')},ensure_ascii=False))
    finally:node.destroy_node();rclpy.try_shutdown()


if __name__=='__main__':main()
