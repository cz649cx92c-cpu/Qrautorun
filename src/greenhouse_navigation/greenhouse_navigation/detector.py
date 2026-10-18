"""实时多码检测与位姿，缺少标定只报告ID，不冒充米制位置。"""
from collections import deque
from pathlib import Path
import json
import math
import time
import cv2
import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data, QoSProfile, DurabilityPolicy, ReliabilityPolicy
from sensor_msgs.msg import Image, CameraInfo, CompressedImage
from nav_msgs.msg import Odometry
from std_msgs.msg import String
from tf2_ros import Buffer, TransformListener
from rclpy.time import Time
from cv_bridge import CvBridge
from .control import wrap
from .board_geometry import validate_boards
from .vision import solve_board_pose, printed_marker_detections, calibration_board_diagnostic


def rotation_from_quaternion(q):
    x,y,z,w=q.x,q.y,q.z,q.w
    return np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                     [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                     [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])


class GroundDetector(Node):
    def __init__(self):
        super().__init__('qr_ground_detector')
        defaults={'map_file':'','camera_calibration_verified':False,
                  'camera_topic':'/qr/camera/image','compressed_topic':'/qr/camera/image/compressed',
                  'camera_info_topic':'/qr/camera/camera_info','tag_size_m':.08,
                  'max_reprojection_px':1.5,'max_image_age_s':.25,'max_tag_distance_m':1.,
                  'max_ground_height_m':.08,'opencv_threads':2}
        for key,value in defaults.items():self.declare_parameter(key,value)
        cv2.setNumThreads(self.get_parameter('opencv_threads').value)
        self.boards=[];path=self.get_parameter('map_file').value
        if path:
            field=json.loads(Path(path).read_text());self.set_boards(field.get('map',field).get('groups',[]))
        self.local_epoch='';self.fusion_ready=False;self.calibration=None;self.camera_status={};self.local=deque(maxlen=300)
        self.pending=deque(maxlen=5);self.previous_image=None;self.frames=0;self.rejected=0
        self.calibration_diagnostic=None;self.diagnostic_checked=0.
        self.bridge=CvBridge();self.buffer=Buffer();self.listener=TransformListener(self.buffer,self)
        self.dictionary=cv2.aruco.Dictionary_get(cv2.aruco.DICT_APRILTAG_36h11)
        self.parameters=cv2.aruco.DetectorParameters_create()
        self.parameters.cornerRefinementMethod=cv2.aruco.CORNER_REFINE_SUBPIX
        self.pub=self.create_publisher(String,'/qr/tags/observations',10)
        self.preview=self.create_publisher(String,'/qr/tags/provisional',10)
        self.status=self.create_publisher(String,'/qr/detector/status',10)
        latest_qos=QoSProfile(depth=1,reliability=ReliabilityPolicy.BEST_EFFORT)
        self.create_subscription(Image,self.get_parameter('camera_topic').value,self.image,latest_qos)
        self.create_subscription(CompressedImage,self.get_parameter('compressed_topic').value,self.image,QoSProfile(depth=1,reliability=ReliabilityPolicy.RELIABLE))
        self.create_subscription(CameraInfo,self.get_parameter('camera_info_topic').value,self.info,qos_profile_sensor_data)
        self.create_subscription(String,'/qr/fusion/status',self.fusion_cb,10)
        self.create_subscription(String,'/qr/camera/status',self.camera_cb,10)
        self.create_subscription(Odometry,'/qr/odometry/local',self.odom,20)
        layout_qos=QoSProfile(depth=1,durability=DurabilityPolicy.TRANSIENT_LOCAL,reliability=ReliabilityPolicy.RELIABLE)
        self.create_subscription(String,'/qr/boards/layout',self.layout,layout_qos)
        self.create_timer(.02,self.dispatch)
        self.get_logger().info('实时识别已启动；多码共同PnP，内参/安装外参/同步未验证时不发布正式定位观测')

    def set_boards(self,boards):self.boards=validate_boards(boards)

    def layout(self,msg):
        try:self.set_boards(json.loads(msg.data)['boards'])
        except (ValueError,TypeError,KeyError,AttributeError):self.get_logger().warning('拒绝冲突的多码布局')

    def camera_cb(self,msg):
        try:self.camera_status=json.loads(msg.data)
        except (ValueError,TypeError):pass

    def info(self,msg):
        if (msg.k[0]>0 and msg.k[4]>0 and msg.distortion_model in ('plumb_bob','rational_polynomial')
                and all(math.isfinite(v) for v in list(msg.k)+list(msg.d))):self.calibration=msg

    def fusion_cb(self,msg):
        try:
            data=json.loads(msg.data)
            epoch=data.get('epoch','')
            ready=bool(data.get('ready')) and data.get('state') in ('FUSED','PROVISIONAL')
            if epoch!=self.local_epoch or not ready:self.local.clear();self.pending.clear()
            self.local_epoch=epoch;self.fusion_ready=ready
        except (ValueError,TypeError):pass

    def odom(self,msg):
        if not self.fusion_ready or not self.local_epoch:return
        stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        if msg.header.frame_id!='odom' or msg.child_frame_id!='base_link':return
        q=msg.pose.pose.orientation
        if not all(math.isfinite(v) for v in [msg.pose.pose.position.x,msg.pose.pose.position.y,q.x,q.y,q.z,q.w]):return
        if self.local and stamp<=self.local[-1][0]:self.local.clear();self.pending.clear()
        yaw=math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))
        self.local.append((stamp,{'x':msg.pose.pose.position.x,'y':msg.pose.pose.position.y,'yaw':yaw}))

    def local_at(self,stamp):
        for (a,p),(b,q) in zip(self.local,list(self.local)[1:]):
            if a<=stamp<=b and 0<b-a<.1:
                t=(stamp-a)/(b-a)
                return {'x':p['x']+(q['x']-p['x'])*t,'y':p['y']+(q['y']-p['y'])*t,
                        'yaw':wrap(p['yaw']+wrap(q['yaw']-p['yaw'])*t)}
        return None

    def dispatch(self):
        now=self.get_clock().now().nanoseconds/1e9
        for _ in range(len(self.pending)):
            payload=self.pending.popleft();stamp=payload['stamp'];local=self.local_at(stamp)
            if not 0<=now-stamp<=self.get_parameter('max_image_age_s').value:continue
            if local is None:self.pending.append(payload);continue
            payload.update(synchronized=True,localPoseSynchronized=True,localPose=local,localEpoch=self.local_epoch)
            self.pub.publish(String(data=json.dumps(payload)))

    def image(self,msg):
        start=time.monotonic();stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        now=self.get_clock().now().nanoseconds/1e9;age=now-stamp
        if not 0<=age<=self.get_parameter('max_image_age_s').value or (self.previous_image is not None and stamp<=self.previous_image):
            self.rejected+=1;return
        self.previous_image=stamp
        try:
            if isinstance(msg,CompressedImage):
                image=cv2.imdecode(np.frombuffer(msg.data,np.uint8),cv2.IMREAD_GRAYSCALE)
            else:image=self.bridge.imgmsg_to_cv2(msg,desired_encoding='mono8')
            if image is None:return
            corners,ids,_=cv2.aruco.detectMarkers(image,self.dictionary,parameters=self.parameters)
            detections=printed_marker_detections(ids,corners)
            # 专用标定板诊断独立于导航检测；只读、限频，其ID从不参与组位姿。
            if detections:self.calibration_diagnostic=None
            elif start-self.diagnostic_checked>=1.:
                self.diagnostic_checked=start
                self.calibration_diagnostic=calibration_board_diagnostic(image,self.camera_status.get('calibrationTarget'))
            visible=[{'id':b['id'],'visible':sum(m['id'] in detections for m in b['members']),
                      'total':len(b['members'])} for b in self.boards]
            visible=[b for b in visible if b['visible']]
            tags=[];reason='';verified=False
            info=self.calibration
            calibrated_source=(self.camera_status.get('intrinsicsVerified') is True and self.camera_status.get('extrinsicsVerified') is True)
            if not (self.get_parameter('camera_calibration_verified').value or calibrated_source) or info is None:
                reason='相机内参/安装参数待标定'
            elif info.header.frame_id!=msg.header.frame_id or (info.height,info.width)!=image.shape:
                reason='图像规格与标定不一致'
            elif self.camera_status.get('intrinsicsVerified') is not True or self.camera_status.get('extrinsicsVerified') is not True:
                reason='相机标定尚未验证'
            else:
                try:
                    tf=self.buffer.lookup_transform('base_link',msg.header.frame_id,Time.from_msg(msg.header.stamp))
                    rotation=rotation_from_quaternion(tf.transform.rotation)
                    translation=np.array([tf.transform.translation.x,tf.transform.translation.y,tf.transform.translation.z])
                    k=np.asarray(info.k).reshape(3,3);d=np.asarray(info.d)
                    for board in self.boards:
                        pose=solve_board_pose(board,detections,k,d,rotation,translation,
                            self.get_parameter('max_reprojection_px').value,
                            self.get_parameter('max_tag_distance_m').value,
                            self.get_parameter('max_ground_height_m').value)
                        if pose is not None:tags.append(pose)
                    verified=True
                except Exception as error:reason='缺少安装外参或位姿计算失败：'+str(error)
            layouts=[b for b in self.boards if any(t['groupId']==b['id'] for t in tags)]
            payload={'stamp':stamp,'frame':'base_link','calibrated':verified,'synchronized':False,
                     'localPoseSynchronized':False,'localPose':None,'representation':'board-centers',
                     'groupLayouts':layouts,'tags':tags}
            if tags:
                self.preview.publish(String(data=json.dumps(payload)))
                # 只读视频的时间为接收时间；未验证拍摄时间/局部融合时不进入正式扫描。
                camera_age=now-float(self.camera_status.get('stamp',0))
                if verified and self.camera_status.get('captureTimestampVerified') is True and 0<=camera_age<1.:
                    self.pending.append(payload)
                else:reason=reason or '图像采集时间/轮式定位待验证'
                if not reason and self.local_at(stamp) is None:
                    reason='局部轮式/IMU融合位姿未验证，扫描尚未就绪'
            elif not reason:
                if self.calibration_diagnostic:
                    reason='画面疑似标定板，请换成已登记的地面定位组'
                elif not detections:reason='未看到地面导航定位组'
                elif not visible:reason='识别到未登记的定位码'
                else:reason='定位组几何、地面安装或重投影校验未通过'
            self.frames+=1
            self.status.publish(String(data=json.dumps({'stamp':now,'frameStamp':stamp,'frames':self.frames,
                'identified':len(tags),'detectedIds':sorted(detections),'visibleMemberCount':len(detections),
                'validBoardCount':len(tags),'visibleGroups':visible,'calibrated':verified,
                'calibrationDiagnostic':self.calibration_diagnostic,
                'captureTimestampVerified':self.camera_status.get('captureTimestampVerified') is True,
                'positionReady':bool(tags),'localPoseReady':self.local_at(stamp) is not None,
                'processingMs':(time.monotonic()-start)*1000,'imageAgeMs':age*1000,
                'rejectedFrames':self.rejected,'reason':reason},ensure_ascii=False)))
        except Exception as error:self.get_logger().warning('拒绝图像/位姿：'+str(error))


def main(args=None):
    rclpy.init(args=args);node=GroundDetector()
    try:rclpy.spin(node)
    except KeyboardInterrupt:pass
    finally:node.destroy_node();rclpy.try_shutdown()
