#!/usr/bin/env python3
"""Subscriptions/parameter readback only; no device or motion commands."""
import argparse,json,math,time
import rclpy
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Imu
from std_msgs.msg import String

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--seconds',type=float,default=8.)
    args=parser.parse_args();rclpy.init(args=['--ros-args','--disable-external-lib-logs'])
    node=rclpy.create_node('qr_verify_serial_imu',enable_rosout=False,start_parameter_services=False)
    samples=[];times=[];statuses=[]
    def receive(msg):samples.append(msg);times.append(time.monotonic())
    def status(msg):
        try:statuses.append(json.loads(msg.data))
        except ValueError:pass
    subscriptions=[node.create_subscription(Imu,'/qr/imu/raw',receive,qos_profile_sensor_data),
                   node.create_subscription(String,'/qr/imu/status',status,10)]
    try:
        end=time.monotonic()+args.seconds
        while time.monotonic()<end:rclpy.spin_once(node,timeout_sec=.1)
        pubs=node.get_publishers_info_by_topic('/qr/imu/raw')
        owned=node.get_publisher_names_and_types_by_node('qr_yahboom_imu','/')
        result={'sampleCount':len(samples),'rateHz':(len(times)-1)/(times[-1]-times[0]) if len(times)>1 else None,
                'imuPublishers':[p.node_name for p in pubs],'ownedNodePublishers':owned,'status':statuses[-1] if statuses else None}
        errors=[]
        if len(pubs)!=1 or pubs[0].node_name!='qr_yahboom_imu':errors.append('新IMU发布者不唯一或来源错误')
        if not samples:errors.append('新IMU尚未出数')
        else:
            msg=samples[-1];age=node.get_clock().now().nanoseconds/1e9-msg.header.stamp.sec-msg.header.stamp.nanosec/1e9
            values=lambda m:[m.angular_velocity.x,m.angular_velocity.y,m.angular_velocity.z,m.linear_acceleration.x,m.linear_acceleration.y,m.linear_acceleration.z]
            result['last']={'ageMs':age*1000,'frame':msg.header.frame_id,'acceleration':values(msg)[3:],'angularVelocity':values(msg)[:3],'orientationCovariance0':msg.orientation_covariance[0]}
            if not 0<=age<.25 or not all(all(math.isfinite(v) for v in values(m)) and m.orientation_covariance[0]==-1. and m.header.frame_id=='imu_link' for m in samples):errors.append('数据/时效/坐标系异常')
            if not 20.<=result['rateHz']<=30.:errors.append('实际输出频率偏离25Hz')
            stamps=[m.header.stamp.sec*10**9+m.header.stamp.nanosec for m in samples]
            if not all(b>a for a,b in zip(stamps,stamps[1:])):errors.append('时间戳不递增')
        allowed={'/qr/imu/raw','/qr/imu/status','/parameter_events','/rosout'}
        if any(topic not in allowed for topic,_ in owned):errors.append('IMU节点发布了额外话题')
        status=result['status']
        if not status or status.get('source')!='Yahboom serial' or not status.get('online') or status.get('payloadBytesSent')!=0 or status.get('mountingDirectionVerified') is not False:errors.append('来源/在线/只收模式/轴向审计失败')
        result.update(errors=errors,passed=not errors);print(json.dumps(result,ensure_ascii=False,indent=2))
        return int(bool(errors))
    finally:node.destroy_node();rclpy.shutdown()
if __name__=='__main__':raise SystemExit(main())
