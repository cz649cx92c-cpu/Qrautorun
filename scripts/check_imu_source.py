#!/usr/bin/env python3
"""Read-only ROS graph, selected parameter and IMU provenance audit."""
import argparse,json,time,math
import rclpy
from rcl_interfaces.srv import GetParameters
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Imu
from nav_msgs.msg import Odometry
from std_msgs.msg import String

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--require-complete',action='store_true')
    args=parser.parse_args()
    rclpy.init(args=['--ros-args','--disable-external-lib-logs'])
    n=rclpy.create_node('qr_imu_source_readback',enable_rosout=False,start_parameter_services=False)
    samples={};statuses={};subs=[]
    for topic,typ in [('/qr/imu/raw',Imu),('/qr/fusion/imu_input',Imu),('/qr/fusion/filtered',Odometry)]:
        samples[topic]=[]
        subs.append(n.create_subscription(typ,topic,lambda msg,t=topic:samples[t].append(msg),qos_profile_sensor_data))
    def status(msg,topic):
        try:statuses[topic]=json.loads(msg.data)
        except ValueError:pass
    for topic in ['/qr/imu/status','/qr/fusion/status']:
        subs.append(n.create_subscription(String,topic,lambda msg,t=topic:status(msg,t),qos_profile_sensor_data))
    try:
        end=time.monotonic()+3
        while time.monotonic()<end:rclpy.spin_once(n,timeout_sec=.1)
        params={}
        for name,keys in [('qr_yahboom_imu',['port','baud','imu_topic','frame_id','mounting_direction_verified']),
                          ('qr_fusion_inputs',['imu_topic','imu_frame','calibration_duration_s','calibration_min_samples','imu_projection_verified']),
                          ('greenhouse_navigation',['imu_topic','execution_enabled','maintenance_mode','imu_direction_verified'])]:
            client=n.create_client(GetParameters,'/'+name+'/get_parameters')
            if not client.wait_for_service(timeout_sec=.5):
                params[name]={'error':'parameter service unavailable'};n.destroy_client(client);continue
            request=GetParameters.Request();request.names=keys
            future=client.call_async(request);rclpy.spin_until_future_complete(n,future,timeout_sec=2.)
            result=future.result() if future.done() else None
            n.destroy_client(client)
            if result is None:params[name]={'error':'parameter read timed out'};continue
            def value(v):
                return {1:lambda:v.bool_value,2:lambda:v.integer_value,3:lambda:v.double_value,4:lambda:v.string_value}.get(v.type,lambda:None)()
            params[name]={key:value(v) for key,v in zip(keys,result.values)}
        graph={}
        for topic in ['/qr/imu/raw','/odin1/imu','/qr/fusion/imu_input','/qr/fusion/filtered']:
            graph[topic]={'publishers':[p.node_name for p in n.get_publishers_info_by_topic(topic)],
                          'subscribers':[p.node_name for p in n.get_subscriptions_info_by_topic(topic) if p.node_name!=n.get_name()]}
        summary={}
        for topic,messages in samples.items():
            summary[topic]={'received':len(messages)}
            if messages:
                msg=messages[-1]
                stamps=[m.header.stamp.sec+m.header.stamp.nanosec/1e9 for m in messages]
                summary[topic].update(frame=msg.header.frame_id,lastAgeS=n.get_clock().now().nanoseconds/1e9-stamps[-1],rateHz=(len(stamps)-1)/(stamps[-1]-stamps[0]) if len(stamps)>1 and stamps[-1]>stamps[0] else None)
                if isinstance(msg,Imu):summary[topic].update(acceleration=[msg.linear_acceleration.x,msg.linear_acceleration.y,msg.linear_acceleration.z],gyro=[msg.angular_velocity.x,msg.angular_velocity.y,msg.angular_velocity.z],orientationCovariance0=msg.orientation_covariance[0])
                else:summary[topic].update(childFrame=msg.child_frame_id,position=[msg.pose.pose.position.x,msg.pose.pose.position.y],angularVelocityZ=msg.twist.twist.angular.z)
        raw=summary['/qr/imu/raw']['received']>0 and graph['/qr/imu/raw']['publishers']==['qr_yahboom_imu']
        fused=(params.get('qr_fusion_inputs',{}).get('imu_topic')=='/qr/imu/raw' and 'qr_fusion_inputs' in graph['/qr/imu/raw']['subscribers'])
        nav=(params.get('greenhouse_navigation',{}).get('imu_topic')=='/qr/imu/raw' and 'greenhouse_navigation' in graph['/qr/imu/raw']['subscribers'])
        complete=raw and fused and nav and summary['/qr/fusion/imu_input']['received']>0 and summary['/qr/fusion/filtered']['received']>0
        print(json.dumps({'time':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'parameters':params,'graph':graph,'samples':summary,'statuses':statuses,'rawSerialVerified':raw,'fusionSourceSerial':fused,'navigationSourceSerial':nav,'completeSourceSwitch':complete,'physicalDirectionCalibrationCompleted':False},ensure_ascii=False,indent=2))
        return int(args.require_complete and not complete)
    finally:n.destroy_node();rclpy.shutdown()
if __name__=='__main__':raise SystemExit(main())
