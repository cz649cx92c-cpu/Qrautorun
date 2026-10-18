"""只读成熟底盘车体反馈适配；不发送命令、不发布TF、不依赖四轮符号标定。"""
import copy
import math

import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from nav_msgs.msg import Odometry
from yhs_can_interfaces.msg import ChassisInfoFb


def chassis_mode_allowed(gear, stationary):
    # Only the user-confirmed driving gears: 6=4t4d, 8=crab.
    return gear in (6, 8) or (gear in (0, 1, 2) and stationary)



def measured_body_twist(feedback, lateral_velocity_scale=.1):
    """原驱动vx除1000，vy除100（协议为1000），wz除100得到度/秒。"""
    ctrl = feedback.ctrl_fb
    vx = float(ctrl.ctrl_fb_x_linear)
    vy = float(ctrl.ctrl_fb_y_linear) * lateral_velocity_scale
    wz = math.radians(float(ctrl.ctrl_fb_z_angular))
    if not all(math.isfinite(v) for v in (vx, vy, wz)):
        raise ValueError('底盘车体速度非有限值')
    return vx, vy, wz


def body_twist(feedback, lateral_velocity_scale=.1):
    """Drive-mode validation; never use actuator mode as an odometry validity flag."""
    vx,vy,wz=measured_body_twist(feedback,lateral_velocity_scale)
    stationary=abs(vx)<=.002 and abs(vy)<=.002 and abs(wz)<=math.radians(.1)
    if not chassis_mode_allowed(feedback.ctrl_fb.ctrl_fb_gear,stationary):
        raise ValueError('底盘档位不支持或停放反馈非静止')
    return vx,vy,wz


class ChassisOdometry(Node):
    def __init__(self):
        super().__init__('qr_chassis_odometry')
        defaults = {'motion_confirmed': False, 'lateral_velocity_scale': .1,
                    'input_timeout_s': .25, 'velocity_sigma_mps': .03,
                    'yaw_sigma_rad_s': .02}
        self.config = {}
        for name, default in defaults.items():
            self.declare_parameter(name, default)
            self.config[name] = self.get_parameter(name).value
        if not self.config['motion_confirmed']:
            raise ValueError('复用成熟底盘反馈需要明确的用户确认')
        if not math.isclose(self.config['lateral_velocity_scale'], .1, rel_tol=0., abs_tol=1e-12):
            raise ValueError('当前原驱动的横向速度单位修正必须为0.1')
        for name, minimum, maximum in (('input_timeout_s', .01, 1.),
                                       ('velocity_sigma_mps', .001, 1.),
                                       ('yaw_sigma_rad_s', .001, 1.)):
            if not minimum <= self.config[name] <= maximum:
                raise ValueError('无效时效/协方差参数：'+name)
        self.previous = None
        self.x = self.y = self.yaw = 0.
        self.pub = self.create_publisher(Odometry, '/qr/chassis/odom', 10)
        self.create_subscription(ChassisInfoFb, '/chassis_info_fb', self.receive, qos_profile_sensor_data)
        self.get_logger().info('只读成熟底盘反馈：用户确认；vx/vy与IMU融合，原角速度仅用于里程计诊断；无命令、无TF')

    def now(self):
        return self.get_clock().now().nanoseconds / 1e9

    def receive(self, msg):
        stamp = msg.header.stamp.sec + msg.header.stamp.nanosec / 1e9
        if not math.isfinite(stamp) or not 0. <= self.now() - stamp <= self.config['input_timeout_s']:
            return
        if self.previous is not None and stamp <= self.previous:
            if stamp < self.previous - .01:
                self.previous = None
            return
        try:
            vx, vy, wz = measured_body_twist(msg, self.config['lateral_velocity_scale'])
        except ValueError:
            return
        dt = 0. if self.previous is None else stamp - self.previous
        self.previous = stamp
        # 断流期间不猜测位移；融合输入会观察时间戳间隙并作废旧epoch。
        if 0. < dt <= self.config['input_timeout_s']:
            mid = self.yaw + wz * dt / 2.
            self.x += (vx * math.cos(mid) - vy * math.sin(mid)) * dt
            self.y += (vx * math.sin(mid) + vy * math.cos(mid)) * dt
            self.yaw = math.atan2(math.sin(self.yaw+wz*dt), math.cos(self.yaw+wz*dt))
        out = Odometry()
        out.header = copy.deepcopy(msg.header)
        out.header.frame_id = 'odom'
        out.child_frame_id = 'base_link'
        out.pose.pose.position.x = self.x
        out.pose.pose.position.y = self.y
        out.pose.pose.orientation.z = math.sin(self.yaw / 2.)
        out.pose.pose.orientation.w = math.cos(self.yaw / 2.)
        out.twist.twist.linear.x = vx
        out.twist.twist.linear.y = vy
        out.twist.twist.angular.z = wz
        for i in (0, 7, 14, 21, 28, 35):
            out.pose.covariance[i] = out.twist.covariance[i] = 1e6
        # 非零噪声先验；不宣称为实测噪声或绝对地图精度。
        out.pose.covariance[0] = out.pose.covariance[7] = .02
        out.pose.covariance[35] = .01
        out.twist.covariance[0] = out.twist.covariance[7] = self.config['velocity_sigma_mps'] ** 2
        out.twist.covariance[35] = self.config['yaw_sigma_rad_s'] ** 2
        self.pub.publish(out)


def main(args=None):
    rclpy.init(args=args)
    node = None
    try:
        node = ChassisOdometry()
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        if node is not None:
            node.destroy_node()
        rclpy.try_shutdown()
