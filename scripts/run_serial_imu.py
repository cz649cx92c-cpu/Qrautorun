#!/usr/bin/env python3
"""Yahboom serial IMU: physical ACC/GYRO only, host receive timestamps."""
import json
import time
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Imu
from std_msgs.msg import String
from imu_serial import Receiver, DEFAULT_PORT

class SerialImu(Node):
    def __init__(self):
        super().__init__('qr_yahboom_imu',enable_rosout=False)
        defaults={'port':DEFAULT_PORT,'baud':115200,'imu_topic':'/qr/imu/raw','frame_id':'imu_link',
                  'max_age_s':.25,'reconnect_s':1.,'max_backlog_bytes':512,'mounting_direction_verified':False}
        self.config={}
        for key,value in defaults.items():
            self.declare_parameter(key,value);self.config[key]=self.get_parameter(key).value
        if self.config['mounting_direction_verified']:
            raise ValueError('Mounting direction has not been physically verified for this replacement')
        self.receiver=Receiver(port=self.config['port'],baud=self.config['baud'],max_age=self.config['max_age_s'],
                               reconnect_s=self.config['reconnect_s'],max_backlog=self.config['max_backlog_bytes'])
        self.publisher=self.create_publisher(Imu,self.config['imu_topic'],qos_profile_sensor_data)
        self.status_publisher=self.create_publisher(String,'/qr/imu/status',10)
        self.received=0;self.last_at=None;self.last_stamp=0;self.previous=0;self.status_at=time.monotonic()
        self.create_timer(.01,self.tick);self.create_timer(1.,self.status)
    def tick(self):
        for frame in self.receiver.poll(time.monotonic()):
            now=time.monotonic()
            if not 0<=now-frame.received_at<=self.config['max_age_s']:
                self.receiver.dropped_stale+=1;continue
            stamp=self.get_clock().now()
            if stamp.nanoseconds<=self.last_stamp:
                self.receiver.dropped_stale+=1;continue
            msg=Imu();msg.header.stamp=stamp.to_msg();msg.header.frame_id=self.config['frame_id']
            msg.linear_acceleration.x,msg.linear_acceleration.y,msg.linear_acceleration.z=frame.acceleration
            msg.angular_velocity.x,msg.angular_velocity.y,msg.angular_velocity.z=frame.angular_velocity
            # Orientation frames are audited but never mixed into this motion observation.
            msg.orientation_covariance[0]=-1.
            # All-zero ACC/GYRO covariance means unknown, not perfect precision.
            self.publisher.publish(msg);self.last_stamp=stamp.nanoseconds;self.last_at=now;self.received+=1
    def status(self):
        now=time.monotonic();rate=(self.received-self.previous)/max(now-self.status_at,1e-9)
        self.previous=self.received;self.status_at=now;r=self.receiver
        payload={'source':'Yahboom serial','mode':'serial_imu','protocol':'7e23-sum8','port':self.config['port'],
                 'baud':self.config['baud'],'connected':r.connected,'online':self.last_at is not None and 0<=now-self.last_at<=.25,
                 'rateHz':rate,'received':self.received,'timestampSource':'host_receive','orientationAvailable':False,
                 'mountingDirectionVerified':False,'packetCounts':{format(k,'02x'):v for k,v in r.parser.counts.items()},
                 'parseErrors':dict(r.parser.errors),'connections':r.connections,'disconnects':r.disconnects,
                 'droppedBacklog':r.dropped_backlog,'droppedStale':r.dropped_stale,'payloadBytesSent':0,'error':r.error}
        self.status_publisher.publish(String(data=json.dumps(payload,ensure_ascii=False)))

def main():
    rclpy.init();node=None
    try:
        node=SerialImu();rclpy.spin(node)
    except KeyboardInterrupt:pass
    finally:
        if node is not None:
            node.receiver.close();node.destroy_node()
        rclpy.try_shutdown()
if __name__=='__main__':main()
