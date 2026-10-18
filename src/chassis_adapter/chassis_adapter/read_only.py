"""只订阅已有反馈；禁止创建任何底盘命令发布者，不导入会启动驱动的兼容桥。"""
import json
import time
import rclpy
from rclpy.node import Node
from std_msgs.msg import String
from yhs_can_interfaces.msg import ChassisInfoFb


class ReadOnlyAdapter(Node):
    def __init__(self):
        super().__init__('qr_chassis_read_only')
        self.declare_parameter('feedback_topic', '/chassis_info_fb')
        self.pub = self.create_publisher(String, '/qr/chassis/status', 10)
        self.create_subscription(ChassisInfoFb, self.get_parameter('feedback_topic').value, self.receive, 10)
        self.last_received = None
        self.feedback = None
        self.create_timer(0.5, self.publish)
        self.get_logger().info('只读适配器已启动：不创建 /ctrl_cmd、/steering_ctrl_cmd 或 /io_cmd 发布者')

    def receive(self, msg):
        self.last_received = time.monotonic()
        self.feedback = {
            'stamp': {'sec': msg.header.stamp.sec, 'nanosec': msg.header.stamp.nanosec},
            'gear_raw': msg.ctrl_fb.ctrl_fb_gear,
            'vx_mps': msg.ctrl_fb.ctrl_fb_x_linear,
            'vy_raw_unverified': msg.ctrl_fb.ctrl_fb_y_linear,
            'yaw_rate_deg_s': msg.ctrl_fb.ctrl_fb_z_angular,
            'steering_gear_raw': msg.steering_ctrl_fb.steering_ctrl_fb_gear,
            'steering_angle_deg_raw': msg.steering_ctrl_fb.steering_ctrl_fb_steering,
            'wheel_angle_deg_raw': [msg.front_angle_fb.front_angle_fb_l, msg.front_angle_fb.front_angle_fb_r, msg.rear_angle_fb.rear_angle_fb_l, msg.rear_angle_fb.rear_angle_fb_r],
            'wheel_velocity_mps_raw': [msg.lf_wheel_fb.lf_wheel_fb_velocity, msg.rf_wheel_fb.rf_wheel_fb_velocity, msg.lr_wheel_fb.lr_wheel_fb_velocity, msg.rr_wheel_fb.rr_wheel_fb_velocity],
            'estop': msg.io_fb.io_fb_estop, 'remote_control': msg.io_fb.io_fb_joypad_ctrl,
            'field_freshness_verified': False,
        }

    def publish(self):
        age = None if self.last_received is None else time.monotonic() - self.last_received
        status = {'mode': 'read_only', 'motion_enabled': False, 'connected': age is not None and age < 0.6, 'receipt_age_s': age, 'feedback': self.feedback}
        msg = String(data=json.dumps(status, ensure_ascii=False))
        self.pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = ReadOnlyAdapter()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
