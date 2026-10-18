"""独立四轮速度+转角里程计；支持前进、负轮速倒车与四轮90°横移。未知标定不发布。"""
import math
import numpy as np
import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry
from yhs_can_interfaces.msg import ChassisInfoFb


def wheel_twist(speeds,angles,positions):
    # 滚动方向与无侧滑约束同时求解vx/vy/wz，避免90°下单一滚动方程秩不足。
    matrix=[];measurements=[]
    for speed,angle,(x,y) in zip(speeds,angles,positions):
        c,s=math.cos(angle),math.sin(angle)
        matrix.extend([[c,s,-y*c+x*s],[-s,c,y*s+x*c]])
        measurements.extend([speed,0.])
    a=np.asarray(matrix);b=np.asarray(measurements)
    if np.linalg.matrix_rank(a)<3:raise ValueError('四轮几何不可辨识')
    result=np.linalg.lstsq(a,b,rcond=None)[0]
    return result,float(np.sqrt(np.mean(np.square(a@result-b))))


class WheelOdometry(Node):
    def __init__(self):
        super().__init__('qr_wheel_odometry')
        for name,default in [('calibration_verified',False),('field_freshness_verified',False),('wheel_positions',[0.]*8),('wheel_angle_signs',[0.]*4),('wheel_angle_offsets',[0.]*4),('wheel_speed_signs',[0.]*4),('max_residual_mps',.03)]:self.declare_parameter(name,default)
        self.pub=self.create_publisher(Odometry,'/qr/wheel/odom',10)
        self.create_subscription(ChassisInfoFb,'/chassis_info_fb',self.receive,10)
        self.previous=None;self.x=0.;self.y=0.;self.yaw=0.
        self.get_logger().info('四轮里程计等待几何/速度/轮角/字段时效实测标定；不使用旧odom的vy=0')

    def receive(self,msg):
        if not self.get_parameter('calibration_verified').value or not self.get_parameter('field_freshness_verified').value:return
        signs=self.get_parameter('wheel_angle_signs').value;speed_signs=self.get_parameter('wheel_speed_signs').value;offsets=self.get_parameter('wheel_angle_offsets').value
        if any(abs(v)!=1 for v in signs+speed_signs):return
        positions=np.asarray(self.get_parameter('wheel_positions').value).reshape(4,2)
        angles=[msg.front_angle_fb.front_angle_fb_l,msg.front_angle_fb.front_angle_fb_r,msg.rear_angle_fb.rear_angle_fb_l,msg.rear_angle_fb.rear_angle_fb_r]
        speeds=[msg.lf_wheel_fb.lf_wheel_fb_velocity,msg.rf_wheel_fb.rf_wheel_fb_velocity,msg.lr_wheel_fb.lr_wheel_fb_velocity,msg.rr_wheel_fb.rr_wheel_fb_velocity]
        angles=[math.radians(a*signs[i]+offsets[i]) for i,a in enumerate(angles)];speeds=[v*speed_signs[i] for i,v in enumerate(speeds)]
        try:twist,residual=wheel_twist(speeds,angles,positions)
        except ValueError:return
        if not np.all(np.isfinite(twist)) or residual>self.get_parameter('max_residual_mps').value:return
        stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9;now=self.get_clock().now().nanoseconds/1e9
        if not 0<=now-stamp<.2:return
        dt=0. if self.previous is None else stamp-self.previous;self.previous=stamp
        if not 0<dt<.2:return
        vx,vy,wz=map(float,twist);mid=self.yaw+wz*dt/2
        self.x+=(vx*math.cos(mid)-vy*math.sin(mid))*dt;self.y+=(vx*math.sin(mid)+vy*math.cos(mid))*dt;self.yaw+=wz*dt
        out=Odometry();out.header=msg.header;out.header.frame_id='odom';out.child_frame_id='base_link';out.pose.pose.position.x=self.x;out.pose.pose.position.y=self.y;out.pose.pose.orientation.z=math.sin(self.yaw/2);out.pose.pose.orientation.w=math.cos(self.yaw/2)
        out.twist.twist.linear.x=vx;out.twist.twist.linear.y=vy;out.twist.twist.angular.z=wz
        variance=max(.0004,residual**2);out.twist.covariance[0]=variance;out.twist.covariance[7]=variance;out.twist.covariance[35]=max(.001,variance)
        out.pose.covariance[0]=.02;out.pose.covariance[7]=.02;out.pose.covariance[35]=.01
        self.pub.publish(out)


def main(args=None):
    rclpy.init(args=args);node=WheelOdometry()
    try:rclpy.spin(node)
    except KeyboardInterrupt:pass
    finally:node.destroy_node();rclpy.try_shutdown()
