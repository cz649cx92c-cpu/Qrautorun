"""复用Node摄像头共享WS，单帧缓存；不第二次打开V4L2设备。"""
import json
import array
import math
import struct
import threading
import time
from pathlib import Path
from urllib.parse import urlparse
import numpy as np
import websocket
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import CompressedImage, CameraInfo
from std_msgs.msg import String
from geometry_msgs.msg import TransformStamped
from tf2_ros import StaticTransformBroadcaster
from .vision import camera_parameters
from .timing_calibration import load_relative_timing, timing_profile_matches


def parse_packet(raw):
    if not isinstance(raw,bytes) or not 20 <= len(raw) <= 4*1024*1024:
        raise ValueError('图像数据包无效')
    sequence, stamp_ms, width, height = struct.unpack('>IdHH',raw[:16])
    if not math.isfinite(stamp_ms) or stamp_ms <= 0 or not 16 <= width <= 4096 or not 16 <= height <= 4096 or raw[16:18] != b'\xff\xd8':
        raise ValueError('图像数据包头无效')
    return sequence, stamp_ms/1000, width, height, raw[16:]


class CameraStream(Node):
    def __init__(self):
        super().__init__('qr_camera_stream')
        defaults = {'stream_url':'ws://127.0.0.1:3080/ws/camera',
                    'frame_id':'qr_camera_optical', 'calibration_file':'',
                    'extrinsics_file':'', 'max_publish_hz':15., 'max_age_s':.25,
                    'capture_timestamp_verified':False,'capture_delay_s':0.0,
                    'capture_timing_calibration_file':'',
                    'compat_preview_topic':'','handoff_legacy_preview':False}
        self.config = {}
        for key,value in defaults.items():
            self.declare_parameter(key,value)
            self.config[key] = self.get_parameter(key).value
        url = urlparse(self.config['stream_url'])
        if url.scheme != 'ws' or url.hostname not in ('127.0.0.1','localhost'):
            raise ValueError('仅连接本机已有摄像头服务')
        if not 1 <= self.config['max_publish_hz'] <= 30:
            raise ValueError('图像发布频率需为1～30Hz')
        if not 0 <= self.config['capture_delay_s'] <= .2:
            raise ValueError('采集延迟参数需为0～0.2秒')
        self.relative_timing = load_relative_timing(self.config['capture_timing_calibration_file'],
            Path(self.config['calibration_file']).parent, self.config['capture_delay_s'])
        self.timing_profile_valid = False
        self.calibration = None;self.extrinsics = None;self.calibration_error = ''
        try:
            path = Path(self.config['calibration_file'])
            if path.is_file():
                data = json.loads(path.read_text());camera_parameters(data)
                if data.get('calibrationVerified') is True:
                    self.calibration = data
                else:
                    self.calibration_error = '相机内参待复核'
            else:
                self.calibration_error = '未完成相机内参标定'
        except (ValueError,KeyError,TypeError):
            self.calibration_error = '相机内参文件无效'
        self.tf = StaticTransformBroadcaster(self)
        try:
            path = Path(self.config['extrinsics_file'])
            if path.is_file():
                data = json.loads(path.read_text())
                position = np.asarray(data['translationM'], dtype=float)
                q = np.asarray(data['quaternionXyzw'], dtype=float)
                if (position.shape!=(3,) or q.shape!=(4,) or not np.all(np.isfinite(position))
                        or not np.all(np.isfinite(q)) or abs(float(q@q)-1)>1e-5):
                    raise ValueError('外参格式无效')
                if data.get('extrinsicsVerified') is True and data.get('childFrame')==self.config['frame_id'] and data.get('parentFrame')=='base_link':
                    self.extrinsics = data
                    transform = TransformStamped();transform.header.stamp=self.get_clock().now().to_msg()
                    transform.header.frame_id='base_link';transform.child_frame_id=self.config['frame_id']
                    transform.transform.translation.x,transform.transform.translation.y,transform.transform.translation.z = map(float,position)
                    transform.transform.rotation.x,transform.transform.rotation.y,transform.transform.rotation.z,transform.transform.rotation.w = map(float,q)
                    self.tf.sendTransform(transform)
        except (ValueError,KeyError,TypeError):
            self.calibration_error += '；相机外参文件无效'
        self.image_pub = self.create_publisher(CompressedImage,'/qr/camera/image/compressed',QoSProfile(depth=1,reliability=ReliabilityPolicy.RELIABLE))
        self.compat_pub=self.create_publisher(CompressedImage,self.config['compat_preview_topic'],1) if self.config['compat_preview_topic'] else None
        self.compat_last=0.
        self.info_pub = self.create_publisher(CameraInfo,'/qr/camera/camera_info',qos_profile_sensor_data)
        self.status_pub = self.create_publisher(String,'/qr/camera/status',10)
        self.closed = threading.Event();self.lock=threading.Lock();self.pending=None;self.ws=None
        self.last_stamp=None;self.latest_stamp=None;self.last_size=None;self.connected=False;self.error=''
        self.received=0;self.published=0;self.dropped=0;self.last_publish=0.
        self.file_versions=self.versions()
        self.create_timer(1/self.config['max_publish_hz'],self.publish_frame)
        self.create_timer(.5,self.status)
        self.create_timer(.5,self.reload_calibration)
        self.worker=threading.Thread(target=self.read_stream,daemon=True);self.worker.start()
        self.get_logger().info('复用现有HBVCAM共享视频流；未标定只发布真实压缩图像，不生成相机内参')

    def read_stream(self):
        while not self.closed.is_set():
            try:
                ws = websocket.create_connection(self.config['stream_url'],timeout=2.,http_no_proxy=['127.0.0.1','localhost'])
                self.ws=ws;self.connected=True;self.error=''
                while not self.closed.is_set():
                    raw = ws.recv()
                    if isinstance(raw,str):
                        status=json.loads(raw)
                        if status.get('error'):self.error=status['error']
                        continue
                    sequence,stamp,width,height,jpeg=parse_packet(raw)
                    with self.lock:
                        if self.pending is not None:self.dropped+=1
                        self.pending=(stamp,width,height,jpeg)
                    self.latest_stamp=stamp;self.received+=1;self.error=''
                    ws.send(json.dumps({'type':'ack','sequence':sequence}))
            except Exception as error:
                if not self.closed.is_set():self.error=str(error)
            finally:
                self.connected=False
                if self.ws is not None:
                    try:self.ws.close()
                    except Exception:pass
                self.ws=None
            self.closed.wait(1.)

    def publish_frame(self):
        with self.lock:
            packet=self.pending;self.pending=None
        if packet is None:return
        stamp,width,height,jpeg=packet
        self.timing_profile_valid = timing_profile_matches(self.relative_timing,width,height)
        if self.config['capture_timestamp_verified'] or self.timing_profile_valid:
            stamp-=self.config['capture_delay_s']
        now=self.get_clock().now().nanoseconds/1e9
        if not 0 <= now-stamp <= self.config['max_age_s'] or (self.last_stamp is not None and stamp <= self.last_stamp):
            self.dropped+=1;return
        # 共享服务的原生JPEG直接转发；检测节点只解码一次并核对真实图像尺寸。
        msg=CompressedImage();msg.header.stamp.sec=int(stamp);msg.header.stamp.nanosec=int((stamp-int(stamp))*1e9)
        # ROS生成代码对普通bytes逐字节验证；原生array可避免每帧数十毫秒Python循环。
        msg.header.frame_id=self.config['frame_id'];msg.format='jpeg';msg.data=array.array('B',jpeg)
        if self.calibration is not None:
            try:
                k,d=camera_parameters(self.calibration,width,height)
                info=CameraInfo();info.header=msg.header;info.width=width;info.height=height
                info.distortion_model='rational_polynomial' if len(d)>5 else 'plumb_bob'
                info.k=list(map(float,k.ravel()));info.d=list(map(float,d));info.r=[1.,0.,0.,0.,1.,0.,0.,0.,1.]
                info.p=[float(k[0,0]),0.,float(k[0,2]),0.,0.,float(k[1,1]),float(k[1,2]),0.,0.,0.,1.,0.]
                self.info_pub.publish(info)
                self.calibration_error=''
            except ValueError as error:
                self.calibration_error=str(error)
        self.image_pub.publish(msg);self.last_size=[width,height];self.last_stamp=stamp;self.published+=1;self.last_publish=time.monotonic()
        if self.compat_pub is not None and time.monotonic()-self.compat_last>.15:
            publishers=self.get_publishers_info_by_topic(self.config['compat_preview_topic'])
            if all(p.node_name==self.get_name() for p in publishers):
                self.compat_pub.publish(msg);self.compat_last=time.monotonic()

    def status(self):
        now=self.get_clock().now().nanoseconds/1e9
        fresh=self.latest_stamp is not None and 0 <= now-self.latest_stamp <= self.config['max_age_s']
        payload={'stamp':now,'connected':self.connected,'fresh':fresh,'size':self.last_size,
                 'received':self.received,'published':self.published,'dropped':self.dropped,'jpegPassthrough':True,
                 'intrinsicsVerified':self.calibration is not None and not self.calibration_error,
                 'extrinsicsVerified':self.extrinsics is not None,
                 'timestampSource':self.relative_timing.get('source','server_receive') if self.timing_profile_valid else 'server_receive',
                 'captureTimestampVerified':bool(self.config['capture_timestamp_verified'] or self.timing_profile_valid),
                 'relativeTimingVerified':self.timing_profile_valid,
                 'hardwareExposureTimestampMeasured':self.relative_timing.get('hardwareExposureTimestampMeasured',False),
                 'timingCalibration':self.relative_timing,
                 'captureDelayS':self.config['capture_delay_s'],
                 'calibrationTarget':self.calibration.get('target') if self.calibration is not None else None,
                 'error':self.error or self.calibration_error}
        self.status_pub.publish(String(data=json.dumps(payload,ensure_ascii=False)))

    def versions(self):
        result=[]
        for key in ('calibration_file','extrinsics_file','capture_timing_calibration_file'):
            path=Path(self.config[key]);result.append(path.stat().st_mtime_ns if path.is_file() else None)
        return tuple(result)

    def reload_calibration(self):
        versions=self.versions()
        if versions==self.file_versions:return
        self.file_versions=versions;self.calibration=None;self.extrinsics=None
        self.relative_timing=load_relative_timing(self.config['capture_timing_calibration_file'],
            Path(self.config['calibration_file']).parent,self.config['capture_delay_s'])
        self.timing_profile_valid=False
        try:
            path=Path(self.config['calibration_file'])
            if not path.is_file():raise ValueError('未完成相机内参标定')
            data=json.loads(path.read_text());camera_parameters(data)
            if data.get('calibrationVerified') is not True:raise ValueError('内参未验证')
            self.calibration=data;self.calibration_error=''
        except (ValueError,KeyError,TypeError) as error:self.calibration_error=str(error)
        try:
            path=Path(self.config['extrinsics_file'])
            if not path.is_file():return
            data=json.loads(path.read_text());position=np.asarray(data['translationM'],float);q=np.asarray(data['quaternionXyzw'],float)
            if (position.shape!=(3,) or q.shape!=(4,) or not np.all(np.isfinite(position))
                    or not np.all(np.isfinite(q)) or abs(float(q@q)-1)>1e-5):raise ValueError('外参无效')
            if data.get('extrinsicsVerified') is not True or data.get('parentFrame')!='base_link' or data.get('childFrame')!=self.config['frame_id']:return
            self.extrinsics=data
            transform=TransformStamped();transform.header.stamp=self.get_clock().now().to_msg()
            transform.header.frame_id='base_link';transform.child_frame_id=self.config['frame_id']
            transform.transform.translation.x,transform.transform.translation.y,transform.transform.translation.z=map(float,position)
            transform.transform.rotation.x,transform.transform.rotation.y,transform.transform.rotation.z,transform.transform.rotation.w=map(float,q)
            self.tf.sendTransform(transform)
            self.get_logger().info('已重新加载经验证的安装外参')
        except (ValueError,KeyError,TypeError) as error:self.calibration_error+='；'+str(error)

    def close(self):
        self.closed.set()
        if self.ws is not None:
            try:self.ws.close()
            except Exception:pass
        self.worker.join(timeout=3.)


def main(args=None):
    rclpy.init(args=args);node=CameraStream()
    try:rclpy.spin(node)
    except KeyboardInterrupt:pass
    finally:node.close();node.destroy_node();rclpy.try_shutdown()
