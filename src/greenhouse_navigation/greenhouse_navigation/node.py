"""真实ROS2反馈、导航安全状态机、独立Web桥；只复用原yhs Topic，不重写CAN驱动。"""
import copy
import json
import math
from .recorded_trial import limits_for
from .run_log import RunLog, build_motion_record, build_stop_record
import os
import queue
import threading
import time
import types
import uuid
from pathlib import Path
from urllib.request import Request,build_opener,ProxyHandler
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data,QoSProfile,DurabilityPolicy,ReliabilityPolicy
from nav_msgs.msg import Odometry
from sensor_msgs.msg import Imu
from std_msgs.msg import String
from yhs_can_interfaces.msg import ChassisInfoFb
from .motion_recording import feedback_record
from .control import Pose,Command
from .mission import Mission
from .segment_execution import TURN_EXECUTION_AVAILABLE
from .execution_diagnostics import ExecutionDiagnostics
from .turn_calibration import load_turn_calibration
from .start_gate import evaluate_start_gate, pose_values
from .motion_interface import ExistingMotionInterface,COMMAND_TOPICS
from .can_health import CanHealth
from .board_geometry import validate_boards,collapse_group_observations,validated_board_observations


def heading_degrees(yaw):
    return (math.degrees(yaw)+180.) % 360. - 180.


class GreenhouseNode(Node):
    def __init__(self):
        super().__init__('greenhouse_navigation')
        defaults={'execution_enabled':False,'backend_url':'http://127.0.0.1:3080','bridge_key_file':'','feedback_topic':'/chassis_info_fb','imu_topic':'/qr/imu/raw','fused_pose_topic':'/qr/localization/pose','localization_preview_topic':'/qr/localization/provisional','observation_topic':'/qr/tags/observations','local_odom_topic':'/qr/odometry/local','feedback_calibration_verified':False,'field_freshness_verified':False,'hardware_watchdog_verified':False,'manual_takeover_verified':False,'vehicle_dimensions_verified':False,'wheel_angle_signs':[0.,0.,0.,0.],'wheel_angle_offsets':[0.,0.,0.,0.],'feedback_timeout_s':.3,'localization_timeout_s':.25,'command_timeout_s':.25,'tag_timeout_s':25.,'mode_timeout_s':8.,'stopped_speed_mps':.015,'angle_tolerance_deg':3.,'stable_feedback_samples':5,'forward_speed_mps':.12,'reverse_speed_mps':.1,'lateral_speed_mps':.06,'max_cross_track_m':.05,'max_heading_rad':.15,'max_position_sigma_m':.03,'acceleration_mps2':.1,'braking_mps2':.2}
        # v11 停稳证据：连续零速后还要等 N 个新鲜定位样本且位姿散布/漂移速率
        # 在阈值内才算 stopConfirmed；定位过期或位姿仍漂移不确认（超时走既有保护）。
        defaults['endpoint_stop_window_m']=.010
        defaults['pose_stability_samples']=5
        defaults['pose_stability_tolerance_m']=.004
        defaults['pose_stability_rate_mps']=.0025
        defaults['maintenance_mode']=False
        defaults['imu_direction_verified']=False
        self.config={}
        self.can_health=CanHealth('can0')
        defaults['existing_chassis_confirmed']=False
        defaults['existing_runtime_conditions_accepted']=False
        defaults['start_position_tolerance_m']=.05
        defaults['qr_interval_navigation']=False
        defaults['turn_yaw_rate_max_radps']=.3
        defaults['turn_yaw_accel_radps2']=.6
        defaults['turn_yaw_gain']=1.5
        defaults['turn_tolerance_deg']=5.
        defaults['turn_timeout_s']=15.
        defaults['start_heading_tolerance_deg']=15.
        defaults['boundary_heading_tolerance_deg']=15.
        defaults['turn_acceptance_deg']=2.5
        defaults['turn_correction_tolerance_deg']=1.0
        defaults['turn_correction_limit']=3
        defaults['turn_correction_min_s']=.2
        defaults['turn_correction_min_delta_deg']=.2
        defaults['centering_max_offset_m']=.12
        defaults['centering_done_cross_m']=.02
        defaults['centering_lateral_speed_mps']=.02
        defaults['centering_timeout_s']=8.
        # 每个二维码边界的横向对中：>2 cm 触发、<=2 cm 收敛、>5 cm 直接 FAULT。
        defaults['centering_enabled']=True
        defaults['centering_trigger_cross_m']=.02
        defaults['centering_max_travel_m']=.10
        defaults['centering_max_sigma_m']=.03
        defaults['centering_heading_drift_deg']=3.
        defaults['centering_speed_limit_mps']=.06
        # 二维码间 dead-reckoning（轮速+IMU航向）连续横向估计与提前有限纠偏。
        defaults['dr_correction_enabled']=True
        defaults['dr_cross_target_m']=.008
        defaults['dr_correction_trigger_m']=.008
        defaults['dr_correction_limit']=2
        defaults['dr_correction_travel_m']=.05
        defaults['dr_correction_min_remaining_m']=.15
        defaults['dr_correction_min_stale_s']=.25
        defaults['dr_rebase_residual_limit_m']=.05
        defaults['dr_rebase_max_sigma_m']=.03
        defaults['dr_divergence_frames']=3
        defaults['calibration_database_path']=''
        defaults['start_ahead_tolerance_m']=.15
        defaults['start_behind_tolerance_m']=.05
        defaults['start_gate_timeout_s']=12.
        defaults['start_gate_stable_samples']=5
        defaults['start_stable_jitter_m']=.01
        defaults['start_stable_jitter_deg']=.5
        defaults['localization_jump_step_m']=.005
        defaults['localization_jump_low_ratio']=.5
        defaults['localization_jump_sigma_m']=.02
        defaults['localization_jump_high_ratio']=.75
        defaults['localization_jump_high_sigma_m']=.02
        defaults['localization_jump_hard_cross_m']=.08
        defaults['localization_jump_confirm_s']=2.
        defaults['localization_jump_confirm_m']=.08
        defaults['localization_jump_speed_mps']=.03
        defaults['localization_jump_max_vy_mps']=.01
        defaults['localization_jump_low_quality_s']=1.5
        defaults['localization_jump_recover_samples']=2
        # 末段动态制动闭环：目标停车窗口（预测停车点/实测剩余必须落在此窗口内）。
        defaults['endpoint_stop_window_m']=.010
        for key,value in defaults.items():self.declare_parameter(key,value);self.config[key]=self.get_parameter(key).value
        if self.config['maintenance_mode'] and self.config['execution_enabled']:
            raise ValueError('IMU维护模式必须禁用实体执行')
        # 只读最新有效标定分析，作为转向完成容差/修正容差的输入；不写回标定库。
        calibration_path=(self.config.get('calibration_database_path') or
                          str(Path(__file__).resolve().parents[3]/'maps/calibration.db'))
        self.turn_calibration=load_turn_calibration(calibration_path=calibration_path)
        self.config['turn_calibration']=self.turn_calibration
        if self.turn_calibration.get('applied'):
            self.config['turn_acceptance_deg']=float(self.turn_calibration['acceptanceDeg'])
            self.config['turn_correction_tolerance_deg']=float(self.turn_calibration['correctionToleranceDeg'])
        self.execution_diagnostics=ExecutionDiagnostics();self.mission=Mission(self.config);self.feedback=None;self.received=0.;self.pose=None;self.pose_received=0.;self.imu_received=0.;self.observations=[];self.qr_meta=None;self.qr_anchor=None;self.local_odom=None;self.tag_received=0.;self.camera_received=0.;self.observation_received=0.;self.camera_frame_stamp=None;self.seq=0
        self.boot_id=str(uuid.uuid4());self.commands=queue.Queue();self.acks=queue.Queue();self.survey=queue.Queue(maxsize=500);self.motion_records=queue.Queue(maxsize=3000)
        # 融合标定：只被动收集带原始 ROS 时间戳的观测/IMU 样本；不参与任何运动决策。
        self.calibration_context=None;self.calibration_last_context=None;self.calibration_samples=queue.Queue(maxsize=4000)
        self.lock=threading.Lock();self.snapshot={};self.registry_boards=[];self.active_boards=[];self.boards_sent=None;self.fusion=None;self.fusion_received=0.;self.detector=None;self.detector_received=0.;self.pid_file=Path(self.config['bridge_key_file']).parent.parent/'logs/robot.pid';self.pid_file.parent.mkdir(parents=True,exist_ok=True);self.pid_file.write_text(str(os.getpid()));self.closed=threading.Event();self.last_tick=time.monotonic();self.engaged=False
        self.mapping=None;self.mapping_received=0.
        self.static_pose=None;self.static_pose_received=0.;self.static_pose_context=None
        self.localization_status=None;self.localization_received=0.;self.preview_pose=None;self.preview_pose_received=0.
        self.pending_start=None;self.pending_start_at=0.
        self.start_gate={};self.start_samples=[];self.start_gate_reason=''
        self.create_subscription(ChassisInfoFb,self.config['feedback_topic'],self.feedback_cb,10)
        self.create_subscription(Odometry,self.config['fused_pose_topic'],self.pose_cb,10)
        self.create_subscription(Odometry,self.config['local_odom_topic'],self.local_odom_cb,qos_profile_sensor_data)
        self.create_subscription(Odometry,self.config['localization_preview_topic'],self.preview_pose_cb,10)
        self.create_subscription(Odometry,'/qr/localization/static_pose',self.static_pose_cb,10)
        self.create_subscription(String,'/qr/localization/status',self.localization_status_cb,10)
        self.create_subscription(String,self.config['observation_topic'],self.observation_cb,10)
        self.create_subscription(String,'/qr/fusion/status',self.fusion_cb,10)
        self.create_subscription(String,'/qr/localization/accepted_anchor',self.anchor_event_cb,10)
        self.create_subscription(String,'/qr/detector/status',self.detector_cb,10)
        self.create_subscription(String,'/qr/draft/status',self.mapping_cb,10)
        self.create_subscription(String,'/qr/tags/draft_observations',self.draft_observation_cb,10)
        if self.config['imu_topic']:self.create_subscription(Imu,self.config['imu_topic'],self.imu_cb,qos_profile_sensor_data)
        self.status_pub=self.create_publisher(String,'/qr/navigation/status',10)
        self.job_pub=self.create_publisher(String,'/qr/tasks/job_request',10)
        self.boards_pub=self.create_publisher(String,'/qr/boards/layout',QoSProfile(depth=1,durability=DurabilityPolicy.TRANSIENT_LOCAL,reliability=ReliabilityPolicy.RELIABLE))
        self.motion=ExistingMotionInterface(enabled=self.config['execution_enabled'],
            publisher_snapshot=lambda:{topic:self.get_publishers_info_by_topic(topic) for topic in COMMAND_TOPICS},
            node_snapshot=self.get_node_names_and_namespaces,
            command_allowed=self.motion_feedback_ready,
            command_timeout_s=self.config['command_timeout_s'],
            body_velocity_crab=bool(self.config.get('existing_chassis_confirmed',False) and self.config.get('existing_runtime_conditions_accepted',False)))
        self.create_timer(.05,self.tick)
        self.worker=threading.Thread(target=self.web_worker,daemon=True);self.worker.start()
        self.get_logger().info('温室导航已启动；实体执行许可='+str(self.config['execution_enabled'])+'；摄像头按最后接入顺序等待')
        calib=self.turn_calibration
        if calib.get('applied'):
            self.get_logger().info('转向标定输入：session='+str(calib.get('sessionId'))+'；有效转向='+str(calib.get('validTurns'))+
                                   '；误差均值='+str(calib.get('meanErrorDeg'))+'°；σ='+str(calib.get('stdDeg'))+
                                   '°；完成容差='+str(calib.get('acceptanceDeg'))+'°；修正容差='+str(calib.get('correctionToleranceDeg'))+'°')
        else:
            self.get_logger().info('转向标定输入：使用固定默认（'+str(calib.get('reason'))+'）；完成容差='+str(self.config['turn_acceptance_deg'])+'°')

    def feedback_cb(self,msg):
        stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        age=self.get_clock().now().nanoseconds/1e9-stamp
        if not 0<=age<self.config['feedback_timeout_s']:return
        self.received=time.monotonic();self.seq+=1
        raw=[msg.front_angle_fb.front_angle_fb_l,msg.front_angle_fb.front_angle_fb_r,msg.rear_angle_fb.rear_angle_fb_l,msg.rear_angle_fb.rear_angle_fb_r]
        signs=self.config['wheel_angle_signs'];offsets=self.config['wheel_angle_offsets']
        angles=[raw[i]*signs[i]+offsets[i] for i in range(4)] if all(abs(s)==1 for s in signs) else None
        wheels=[msg.lf_wheel_fb.lf_wheel_fb_velocity,msg.rf_wheel_fb.rf_wheel_fb_velocity,msg.lr_wheel_fb.lr_wheel_fb_velocity,msg.rr_wheel_fb.rr_wheel_fb_velocity]
        target=self.mission.target_angle
        existing=self.config.get('existing_chassis_confirmed',False)
        steering_angle=float(msg.steering_ctrl_fb.steering_ctrl_fb_steering)
        steering_aligned=math.isfinite(steering_angle) and abs(steering_angle-target)<self.config['angle_tolerance_deg']
        # The original aggregate carries cached steering fields, with no
        # independent steering sequence/timestamp. Body arrivals cannot prove
        # steering freshness or alignment; retain the angle for diagnostics.
        aligned=False if existing else (angles is not None and all(abs(a-target)<self.config['angle_tolerance_deg'] for a in angles))
        self._fb_frame=getattr(self,'_fb_frame',0)+1
        _bg=int(msg.ctrl_fb.ctrl_fb_gear); _sg=int(msg.steering_ctrl_fb.steering_ctrl_fb_gear)
        _dev=max((abs(v) for v in raw), default=0.)
        if self._fb_frame%5==0 or _bg not in (5,6) or _sg not in (5,6) or _dev>3.0:
            try:
                from .diag_log import get as _diag_get
                ctl=_diag_get('control')
                loco=getattr(self,'local_odom',None) or {}
                ctl.write({'type':'chassisFeedback','frame':self._fb_frame,'seq':self.seq,
                    'bodyGear':_bg,'steerGear':_sg,'steerAngle':steering_angle,
                    'anglesRaw':[float(v) for v in raw],'vx':float(msg.ctrl_fb.ctrl_fb_x_linear),
                    'vyRaw':float(msg.ctrl_fb.ctrl_fb_y_linear),
                    'vyMps':(float(msg.ctrl_fb.ctrl_fb_y_linear)*.1 if existing else None),
                    'yawSource':'local_ekf' if loco else 'unavailable',
                    'localX':loco.get('x'),'localY':loco.get('y'),
                    'localYawStamp':loco.get('stamp'),'localYaw':loco.get('yaw'),
                    'localEpoch':loco.get('epoch'),
                    'unlock':bool(msg.io_fb.io_fb_unlock),'estop':bool(msg.io_fb.io_fb_estop),
                    'remote':bool(msg.io_fb.io_fb_joypad_ctrl),
                    'headerStamp':stamp,'recv':round(time.time(),6)})
            except Exception:
                pass
        self.feedback={'seq':self.seq,'aggregate_received':self.received,'vx':float(msg.ctrl_fb.ctrl_fb_x_linear),'vy_raw':float(msg.ctrl_fb.ctrl_fb_y_linear),'vy_mps':(float(msg.ctrl_fb.ctrl_fb_y_linear)*.1 if existing and math.isfinite(msg.ctrl_fb.ctrl_fb_y_linear) else None),'yaw_deg':float(msg.ctrl_fb.ctrl_fb_z_angular),'speed':max(math.hypot(msg.ctrl_fb.ctrl_fb_x_linear,msg.ctrl_fb.ctrl_fb_y_linear*(.1 if existing else 1.)),abs(msg.steering_ctrl_fb.steering_ctrl_fb_velocity),*(abs(v) for v in wheels)),'angles_raw':raw,'angles':angles,'steering_angle':steering_angle,'angle_source':'existing_chassis' if existing else 'four_wheels','steering_seq':None,'steering_received':None,'steering_fresh':False,'steering_aligned_diagnostic':steering_aligned,'steering_gear':int(msg.steering_ctrl_fb.steering_ctrl_fb_gear),'body_gear':int(msg.ctrl_fb.ctrl_fb_gear),'estop':bool(msg.io_fb.io_fb_estop),'remote_control':bool(msg.io_fb.io_fb_joypad_ctrl),'charge_state':bool(msg.io_fb.io_fb_charge_state or msg.bms_flag_fb.bms_flag_fb_charge_flag),'unlock':bool(msg.io_fb.io_fb_unlock),'lateral_aligned':aligned,'field_freshness_verified':self.config['field_freshness_verified']}
        if hasattr(self,'motion_records'):
            fusion=getattr(self,'fusion',None) or {}
            record=feedback_record(msg,self.seq,fusion.get('epoch',''),self.received,existing)
            if record:
                record['feedbackAgeS']=age
                try:self.motion_records.put_nowait(record)
                except queue.Full:pass
        if not GreenhouseNode.static_feedback_stationary(self,time.monotonic()):
            self.static_pose=None;self.static_pose_context=None

    def detector_cb(self,msg):
        try:
            data=json.loads(msg.data);age=self.get_clock().now().nanoseconds/1e9-float(data['stamp'])
            if math.isfinite(age) and 0<=age<.3:
                self.detector=data;self.detector_received=time.monotonic()
                frame_stamp=data.get('frameStamp')
                # This is a processed image heartbeat, independent of seeing a QR.
                # Repeated frames, receive-time-only images and missing calibration
                # must not keep the navigation camera condition alive.
                previous=getattr(self,'camera_frame_stamp',None)
                now_ros=self.get_clock().now().nanoseconds/1e9
                if (data.get('calibrated') is True and data.get('captureTimestampVerified') is True
                        and isinstance(frame_stamp,(int,float)) and not isinstance(frame_stamp,bool)
                        and math.isfinite(frame_stamp) and 0<=now_ros-frame_stamp<.25
                        and (previous is None or frame_stamp>previous)):
                    self.camera_frame_stamp=frame_stamp
                    self.camera_received=time.monotonic()
        except (ValueError,KeyError,TypeError):pass

    def fusion_cb(self,msg):
        try:
            data=json.loads(msg.data);age=self.get_clock().now().nanoseconds/1e9-float(data['stamp'])
            if 0<=age<.3 and data.get('state') in ('CALIBRATING','WAITING','PROVISIONAL','FUSED','INVALID'):
                self.fusion=data;self.fusion_received=time.monotonic()
        except (ValueError,KeyError,TypeError):pass

    def mapping_cb(self,msg):
        try:
            data=json.loads(msg.data);age=self.get_clock().now().nanoseconds/1e9-float(data['stamp'])
            if 0<=age<.3 and data.get('quality')=='draft':
                self.mapping=data;self.mapping_received=time.monotonic()
        except (ValueError,KeyError,TypeError):pass

    def draft_observation_cb(self,msg):
        """仅写扫描队列；不更新导航位姿、动作触发或正式相机条件。"""
        try:
            batch=json.loads(msg.data)
            if (self.mission.running or batch.get('quality')!='draft'
                    or batch.get('synchronized') is not False or batch.get('calibrated') is not True
                    or batch.get('timestampSource')!='server_receive'
                    or batch.get('frame')!='base_link' or batch.get('representation')!='board-centers'
                    or batch.get('localPoseSynchronized') is not True):return
            stamp=float(batch['stamp']);age=self.get_clock().now().nanoseconds/1e9-stamp
            local=batch['localPose'];epoch=batch['localEpoch']
            if not 0<=age<=.25 or not isinstance(epoch,str) or not 1<=len(epoch)<=80:return
            if not all(math.isfinite(local[k]) for k in ('x','y','yaw')):return
            tags=batch['tags']
            if not isinstance(tags,list) or not 1<=len(tags)<=30:return
            checked=validated_board_observations(tags,self.active_boards,batch.get('groupLayouts',[]))
            if len(checked)!=len(tags) or any(not t.get('groupId') for t in checked):return
            group_ids={t['groupId'] for t in checked}
            sample={'stamp':stamp,'pose':local,'tags':checked,'calibrated':True,'synchronized':False,
                    'quality':'draft','localEpoch':epoch,'timestampSource':'server_receive',
                    'representation':'board-centers','groupLayouts':[b for b in self.active_boards if b['id'] in group_ids]}
            self.survey.put_nowait(sample)
        except queue.Full:self.mission.log('草稿采集缓冲已满')
        except (ValueError,TypeError,KeyError):self.mission.log('拒绝无效草稿观测')

    def imu_cb(self,msg):
        stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        age=self.get_clock().now().nanoseconds/1e9-stamp
        if 0<=age<.25 and math.isfinite(msg.angular_velocity.z):self.imu_received=time.monotonic()
        if self.calibration_context is not None:
            sample={'kind':'imu','stamp':stamp,'gx':float(msg.angular_velocity.x),'gy':float(msg.angular_velocity.y),'gz':float(msg.angular_velocity.z),
                    'ax':float(msg.linear_acceleration.x),'ay':float(msg.linear_acceleration.y),'az':float(msg.linear_acceleration.z)}
            if all(math.isfinite(sample[key]) for key in ('stamp','gx','gy','gz')):
                try:self.calibration_samples.put_nowait(sample)
                except queue.Full:pass

    def anchor_event_cb(self,msg):
        """localization 真正接受 QR 校正后的内用锚事件（唯一可信 DR 重锚来源）。"""
        try:
            event=json.loads(msg.data)
        except Exception:
            return
        if not isinstance(event,dict):return
        event['recvMonoLocal']=time.monotonic()
        self.qr_anchor=event
        try:
            from .diag_log import get as _diag_get
            _diag_get('control').write({'type':'acceptedAnchor','event':{k:event.get(k) for k in
                ('kind','correctionId','sourceStamp','mapId','mapVersion','localEpoch','anchorPose','sigma',
                 'posteriorStamp','localRef','scopeGeneration')},
                'recv':round(time.time(),6)})
        except Exception:
            pass

    def local_odom_cb(self,msg):
        """局部 EKF 连续位姿（/qr/odometry/local = /qr/fusion/filtered 中继，不含全局 QR 校正）。

        必须保存 x/y/yaw/stamp 供 accepted-QR 锚事件做同源局部里程传播；
        非有限坐标、错误 frame、非法四元数一律丢弃（不得存成“有效”局部里程）。
        """
        stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        if msg.header.frame_id!='odom' or msg.child_frame_id!='base_link' or not math.isfinite(stamp):return
        p=msg.pose.pose.position; q=msg.pose.pose.orientation
        if not (math.isfinite(p.x) and math.isfinite(p.y)):return
        norm=q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w
        if not math.isfinite(norm) or abs(norm-1.)>.02:return
        yaw=math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))
        if not math.isfinite(yaw):return
        fusion=getattr(self,'fusion',None) or {}
        self.local_odom={'x':float(p.x),'y':float(p.y),'stamp':float(stamp),'yaw':float(yaw),
                         'wz':float(msg.twist.twist.angular.z) if math.isfinite(msg.twist.twist.angular.z) else None,
                         'recvMono':time.monotonic(),
                         'epoch':fusion.get('epoch') if isinstance(fusion,dict) else None}

    def pose_cb(self,msg):
        stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        now_ros=self.get_clock().now().nanoseconds/1e9
        if msg.header.frame_id!='map' or msg.child_frame_id!='base_link' or not 0<=now_ros-stamp<=self.config['localization_timeout_s']:return
        q=msg.pose.pose.orientation;norm=math.sqrt(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w)
        if abs(norm-1.)>.01:return
        cov=msg.pose.covariance
        if cov[0]<=0 or cov[7]<=0:return
        yaw=math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))
        vals=[msg.pose.pose.position.x,msg.pose.pose.position.y,yaw,cov[0],cov[7]]
        if not all(math.isfinite(v) for v in vals):return
        self.pose=Pose(vals[0],vals[1],yaw,math.sqrt(max(cov[0],cov[7])),stamp);self.pose_received=time.monotonic()

    def preview_pose_cb(self,msg):
        """Keep the synchronized QR pose visible while formal output is gated."""
        stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        now_ros=self.get_clock().now().nanoseconds/1e9
        if msg.header.frame_id!='map' or msg.child_frame_id!='base_link' or not 0<=now_ros-stamp<=self.config['localization_timeout_s']:return
        q=msg.pose.pose.orientation;norm=math.sqrt(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w)
        cov=msg.pose.covariance
        if abs(norm-1.)>.01 or cov[0]<=0 or cov[7]<=0:return
        yaw=math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))
        vals=[msg.pose.pose.position.x,msg.pose.pose.position.y,yaw,cov[0],cov[7]]
        if all(math.isfinite(v) for v in vals):
            self.preview_pose=Pose(vals[0],vals[1],yaw,math.sqrt(max(cov[0],cov[7])),stamp)
            self.preview_pose_received=time.monotonic()

    def static_feedback_stationary(self, now):
        fb=getattr(self,'feedback',None) or {}
        if not 0<=now-getattr(self,'received',0.)<self.config.get('feedback_timeout_s',.3):return False
        values=[fb.get(k,float('inf')) for k in ('speed','vx','vy_raw','yaw_deg')]
        return (all(isinstance(v,(int,float)) and math.isfinite(v) for v in values)
                and abs(values[0])<=.002 and abs(values[1])<=.002
                and abs(values[2])*(.1 if self.config.get('existing_chassis_confirmed',False) else 1.)<=.002
                and abs(values[3])<=.1)

    def localization_status_cb(self,msg):
        try:
            data=json.loads(msg.data)
            if not isinstance(data,dict):raise ValueError('定位状态格式无效')
            stamp=float(data['stamp']);now_ros=self.get_clock().now().nanoseconds/1e9
            if not math.isfinite(stamp) or not 0<=now_ros-stamp<=.25:raise ValueError('定位状态过期')
            if data.get('state') not in ('STATIC_ANCHORED','WAITING','LOCAL_ONLY','FORMAL'):raise ValueError('定位状态未知')
            if data.get('source') not in ('stationary_qr','synchronized_qr'):raise ValueError('定位来源未知')
            for key in ('stationary','absoluteHeading','poseAvailable','navigationReady','captureTimestampVerified'):
                if type(data.get(key)) is not bool:raise ValueError('定位状态标志无效')
            if not isinstance(data.get('mapId'),str) or len(data['mapId'])>200:raise ValueError('定位地图无效')
            if not isinstance(data.get('localEpoch'),str) or len(data['localEpoch'])>80:raise ValueError('定位原点无效')
            if not isinstance(data.get('reason'),str) or len(data['reason'])>2000:raise ValueError('定位原因无效')
            if data['source']=='stationary_qr' and (data['navigationReady'] or data['captureTimestampVerified']):raise ValueError('静止定位不能声明运动同步')
            if data['state']=='STATIC_ANCHORED' and not (data['source']=='stationary_qr' and data['stationary'] and data['absoluteHeading'] and data['poseAvailable'] and data['mapId']):raise ValueError('静止定位标志不一致')
            if data['state']=='FORMAL' and data['source']!='synchronized_qr':raise ValueError('正式定位来源不一致')
            if data['navigationReady'] and not (data['state']=='FORMAL' and data['captureTimestampVerified'] and data['poseAvailable']):raise ValueError('正式定位条件无效')
            old=getattr(self,'localization_status',None) or {}
            context=(data['mapId'],data.get('mapVersion'),data['localEpoch'])
            if context!=(old.get('mapId'),old.get('mapVersion'),old.get('localEpoch')):
                self.static_pose=None;self.static_pose_context=None;self.localization_context_started=stamp
                if old.get('mapId'):
                    self.pose=None;self.pose_received=0.;self.preview_pose=None;self.preview_pose_received=0.
            if data['state']!='STATIC_ANCHORED' or not data['stationary']:
                self.static_pose=None;self.static_pose_context=None
            self.localization_status=data;self.localization_received=time.monotonic()
        except (ValueError,TypeError,KeyError):
            self.localization_status=None;self.static_pose=None;self.static_pose_context=None

    def static_pose_cb(self,msg):
        # Independent display-only storage. Never updates self.pose or official observation gates.
        status=getattr(self,'localization_status',None) or {}
        now=time.monotonic();now_ros=self.get_clock().now().nanoseconds/1e9
        if (status.get('state')!='STATIC_ANCHORED' or status.get('source')!='stationary_qr'
                or not 0<=now-getattr(self,'localization_received',0.)<=.25
                or not 0<=now_ros-status.get('stamp',0.)<=.25
                or not GreenhouseNode.static_feedback_stationary(self,now)):return
        stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        if (msg.header.frame_id!='map' or msg.child_frame_id!='base_link' or not 0<=now_ros-stamp<=.25
                or stamp<getattr(self,'localization_context_started',0.)):return
        q=msg.pose.pose.orientation;cov=msg.pose.covariance
        values=[msg.pose.pose.position.x,msg.pose.pose.position.y,q.x,q.y,q.z,q.w]+list(cov)
        if not all(math.isfinite(v) for v in values):return
        if abs(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w-1.)>.02 or any(cov[i]<=0 for i in (0,7,35)):return
        previous=getattr(self,'static_pose',None)
        if previous is not None and stamp<=previous.stamp:return
        yaw=math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))
        self.static_pose=Pose(values[0],values[1],yaw,math.sqrt(max(cov[0],cov[7])),stamp)
        self.static_pose_received=now;self.static_pose_context=(status['mapId'],status['localEpoch'])

    def localization_telemetry(self, now):
        status=getattr(self,'localization_status',None) or {}
        metadata={'stamp':0.,'state':'WAITING','source':None,'stationary':False,'absoluteHeading':False,
                  'poseAvailable':False,'navigationReady':False,'captureTimestampVerified':False,
                  'mapId':'','localEpoch':'','reason':'等待地图定位状态','headingDeg':None,
                  'covarianceCalibrated':False,'approvalBasis':None,'positionSigmaM':None,'positionLimitM':self.config['max_position_sigma_m']}
        if not status or not 0<=now-getattr(self,'localization_received',0.)<=.25:return None,metadata
        now_ros=self.get_clock().now().nanoseconds/1e9
        if not 0<=now_ros-status['stamp']<=.25:return None,metadata
        metadata.update({key:status[key] for key in metadata if key in status})
        if type(status.get('mapVersion')) is int and status['mapVersion']>0:metadata['mapVersion']=status['mapVersion']
        metadata.update(poseAvailable=False,navigationReady=False,headingDeg=None)
        formal=getattr(self,'pose',None)
        if (formal is not None and 0<=now-self.pose_received<=self.config.get('localization_timeout_s',.25)
                and 0<=now_ros-formal.stamp<=self.config.get('localization_timeout_s',.25)
                and status['state']=='FORMAL' and status['source']=='synchronized_qr' and status['mapId']):
            metadata.update(stamp=min(status['stamp'],formal.stamp),poseAvailable=True,
                            navigationReady=GreenhouseNode.navigation_pose_ready(self,now),headingDeg=heading_degrees(formal.yaw))
            if self.config.get('qr_interval_navigation',False) and formal.sigma>self.config['max_position_sigma_m']:
                metadata['reason']=f'二维码间里程计推算，等待下一定位板校正（估计不确定度 {formal.sigma*100:.1f} cm）'
            metadata['positionSigmaM']=formal.sigma
            return {'x':formal.x,'y':formal.y,'yaw':formal.yaw},metadata
        preview=getattr(self,'preview_pose',None)
        if (preview is not None and 0<=now-getattr(self,'preview_pose_received',0.)<=self.config.get('localization_timeout_s',.25)
                and 0<=now_ros-preview.stamp<=self.config.get('localization_timeout_s',.25)
                and status['state']=='LOCAL_ONLY' and status['source']=='synchronized_qr'
                and status['poseAvailable'] and status['absoluteHeading'] and status['captureTimestampVerified']
                and status['mapId']):
            metadata.update(stamp=min(status['stamp'],preview.stamp),poseAvailable=True,
                            navigationReady=False,headingDeg=heading_degrees(preview.yaw))
            return {'x':preview.x,'y':preview.y,'yaw':preview.yaw},metadata
        static=getattr(self,'static_pose',None)
        if (formal is None or not 0<=now-self.pose_received<=self.config.get('localization_timeout_s',.25)):
            if (static is not None and status['state']=='STATIC_ANCHORED' and status['source']=='stationary_qr'
                    and status['stationary'] and status['poseAvailable'] and status['absoluteHeading']
                    and getattr(self,'static_pose_context',None)==(status['mapId'],status['localEpoch'])
                    and 0<=now-getattr(self,'static_pose_received',0.)<=.25 and 0<=now_ros-static.stamp<=.25
                    and GreenhouseNode.static_feedback_stationary(self,now)):
                metadata.update(stamp=min(status['stamp'],static.stamp),poseAvailable=True,
                                navigationReady=False,captureTimestampVerified=False,headingDeg=heading_degrees(static.yaw))
                return {'x':static.x,'y':static.y,'yaw':static.yaw},metadata
        metadata.update(state='LOCAL_ONLY' if status['state']=='LOCAL_ONLY' else 'WAITING',
                        absoluteHeading=False,stationary=False,reason=status['reason'] or '等待当前地图的有效定位')
        return None,metadata

    def observation_cb(self,msg):
        try:
            batch=json.loads(msg.data)
            if batch.get('frame')!='base_link' or batch.get('calibrated') is not True or batch.get('synchronized') is not True:return
            stamp=float(batch['stamp']);now_ros=self.get_clock().now().nanoseconds/1e9
            if not 0<=now_ros-stamp<=.25:return
            tags=batch['tags']
            if not isinstance(tags,list) or len(tags)>30:return
            for tag in tags:
                if type(tag['id']) is not int or not 0<=tag['id']<=586 or not all(math.isfinite(float(tag[k])) for k in ['x','y','angle','sigma']):return
            if batch.get('representation')=='board-centers':tags=validated_board_observations(tags,self.active_boards,batch.get('groupLayouts',[]))
            else:tags=collapse_group_observations(tags,self.active_boards)
            if self.active_boards:tags=[t for t in tags if t.get('groupId')]
            self.observations=tags;self.observation_received=time.monotonic();self.camera_received=self.observation_received
            fusion=getattr(self,'fusion',None) or {}
            self.qr_meta={'sourceStamp':stamp,'recvMono':self.observation_received,
                          'localEpoch':batch.get('localEpoch') or (fusion.get('epoch') if isinstance(fusion,dict) else None),
                          'mapId':(self.mission.field or {}).get('id') if getattr(self.mission,'field',None) else None,
                          'groups':sorted({t.get('groupId') for t in tags if t.get('groupId')})}
            if self.calibration_context is not None:
                sample={'kind':'observation','stamp':stamp,'frame':'base_link','calibrated':True,'synchronized':True,
                        'representation':batch.get('representation'),'tags':tags,
                        'groupLayouts':batch.get('groupLayouts',[]),'localEpoch':batch.get('localEpoch')}
                try:self.calibration_samples.put_nowait(sample)
                except queue.Full:pass
            self.mapping_observation=None
            known={t['id'] for t in self.mission.field['tags']} if self.mission.running and self.mission.field else None
            relevant=[t for t in tags if known is None or t['id'] in known]
            if relevant:self.tag_received=time.monotonic()
            # 示教建图必须用采集时间的局部轮式/IMU位姿，不能用已受当前地图校正的全局位姿循环自证。
            local=batch.get('localPose')
            if local and batch.get('localPoseSynchronized') is True:
                group_ids={t.get('groupId') for t in tags}
                sample={'stamp':stamp,'pose':local,'tags':tags,'calibrated':True,'synchronized':True,'representation':'board-centers','groupLayouts':[b for b in self.active_boards if b['id'] in group_ids]}
                fusion=getattr(self,'fusion',None) or {}
                epoch=batch.get('localEpoch') or fusion.get('epoch')
                if epoch:sample['localEpoch']=epoch
                # Only accepted synchronized local-pose evidence may enable mapping.
                if (tags and batch.get('localEpoch') and isinstance(local,dict)
                        and all(isinstance(local.get(k),(int,float)) and not isinstance(local.get(k),bool)
                                and math.isfinite(local[k]) for k in ('x','y','yaw'))):
                    self.mapping_observation={'stamp':stamp,'localEpoch':batch['localEpoch']}
                try:self.survey.put_nowait(sample)
                except queue.Full:self.mission.log('采集缓冲已满，停止接收该批观测')
        except (ValueError,TypeError,KeyError):self.mission.log('拒绝无效标记观测')

    def motion_feedback_ready(self):
        fb=self.feedback or {}
        can_health=getattr(self,'can_health',None)
        can_ready=can_health is None or can_health.status()['ready']
        return (can_ready and 0<=time.monotonic()-self.received<self.config['feedback_timeout_s']
                and not fb.get('estop',True) and not fb.get('remote_control',True)
                and not fb.get('charge_state',False))

    def navigation_pose_ready(self,now):
        pose=getattr(self,'pose',None)
        if (pose is None or not 0<=now-self.pose_received<self.config['localization_timeout_s']
                or not all(math.isfinite(v) for v in (pose.x,pose.y,pose.yaw,pose.sigma))
                or pose.sigma<=0):return False
        # Between surveyed QR anchors, wheel/IMU propagation remains the actual
        # map pose. Its uncalibrated covariance is diagnostic in interval mode.
        return (self.config.get('qr_interval_navigation',False)
                or pose.sigma<=self.config['max_position_sigma_m'])

    def conditions(self):
        now=time.monotonic();fb=self.feedback or {};configured=self.config
        ownership=self.motion.owns_publishers({topic:self.get_publishers_info_by_topic(topic) for topic in COMMAND_TOPICS})
        fresh=0<=now-self.received<configured['feedback_timeout_s']
        safe_to_request_unlock=GreenhouseNode.motion_feedback_ready(self)
        checks=[('execution','实体执行许可',configured['execution_enabled']),('feedback','底盘反馈时效',fresh),('calibration','底盘反馈倍率与轮角标定',configured['feedback_calibration_verified'] and all(abs(s)==1 for s in configured['wheel_angle_signs'])),('freshness','四轮角与IO独立新鲜度验证',configured['field_freshness_verified']),('watchdog','底盘通信看门狗验证',configured['hardware_watchdog_verified']),('takeover','手柄接管互斥验证',configured['manual_takeover_verified']),('dimensions','整车尺寸与扫掠验收',configured['vehicle_dimensions_verified']),('ownership','底盘命令发布者独占',ownership),('unlock','底盘安全状态可请求解锁',safe_to_request_unlock),('estop','硬件急停释放',not fb.get('estop',True)),('remote','人工接管未占用',not fb.get('remote_control',True)),('pose','实时融合位姿与误差',GreenhouseNode.navigation_pose_ready(self,now)),('imu','真实IMU数据',bool(configured['imu_topic']) and now-self.imu_received<.5),('camera','实时标定相机观测',now-self.camera_received<.5)]
        checks.append(('imu_direction','新IMU实物方向标定',configured.get('imu_direction_verified',False)))
        if getattr(self,'can_health',None) is not None:
            can=self.can_health.status()
            checks.append(('can','CAN发送链路'+('' if can['ready'] else '（'+can['state']+'）'),can['ready']))
        # QR measurement noise belongs to the localization filter, which already
        # rejects outliers and weights corrections by covariance. Between markers,
        # fresh wheel/IMU increments propagate that pose and grow its uncertainty.
        # Gate motion on the fused pose above, not on the latest camera sample.
        # The calibrated camera heartbeat remains required. Marker visibility is
        # diagnostic; the bounded fused-pose uncertainty limits prediction.
        if configured.get('existing_chassis_confirmed',False):
            checks=[(id,'现成底盘运动反馈（用户已确认）',configured['feedback_calibration_verified']) if id=='calibration'
                else (id,label,ok) for id,label,ok in checks]
        if configured.get('existing_chassis_confirmed',False) and configured.get('existing_runtime_conditions_accepted',False):
            waived={'freshness','watchdog','takeover','dimensions'}
            checks=[item for item in checks if item[0] not in waived]
        return [{'id':id,'label':label,'ready':bool(ok)} for id,label,ok in checks]

    # ---- v10 运行取证（只记录，不影响控制） ----
    def _run_log_ensure(self):
        if getattr(self, '_run_log', None) is not None:
            return self._run_log
        try:
            ex = getattr(self.mission, 'segment_executor', None)
            task = getattr(self.mission, 'task', None) or {}
            field = getattr(self.mission, 'field', None) or {}
            targets = []
            if ex is not None:
                tags = {t['id']: t for t in field.get('tags', [])}
                for i, seg in enumerate(ex.segments):
                    tag = tags.get(seg.get('toId'))
                    if tag:
                        targets.append({'seg': i + 1, 'from': seg.get('fromId'),
                                        'to': seg.get('toId'),
                                        'x': tag['x'], 'y': tag['y']})
            run_id = time.strftime('run-%Y%m%dT%H%M%S', time.localtime())
            base = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
                os.path.dirname(os.path.abspath(__file__))))), 'logs', 'diagnostics', 'runs')
            self._run_log_targets = targets
            self._run_log = RunLog(base, run_id)
            self._run_log.start(meta={'runId': run_id, 'taskId': task.get('id'),
                                      'routeId': task.get('routeId'),
                                      'mapId': field.get('id'),
                                      'mapVersion': task.get('mapVersion'),
                                      'returnToStart': task.get('returnToStart', False),
                                      'targets': targets,
                                      'startedAt': time.time()})
            self._run_log_id = run_id
        except Exception:
            self._run_log = False
            if os.environ.get('QR_RUNLOG_DEBUG'):
                import traceback
                traceback.print_exc()
        return self._run_log

    def _run_log_tick(self, cmd, loc_ctx, start, now):
        try:
            if not getattr(self.mission, 'running', False):
                return
            rl = self._run_log_ensure()
            if not rl:
                return
            ex = getattr(self.mission, 'segment_executor', None)
            if ex is None:
                return
            seg = ex.segment or {}
            st = ex.dr_state or {}
            ed = (getattr(self, 'execution_diagnostics', None) and None) or {}
            pose = self.pose
            targets = {}
            for t in (getattr(self, '_run_log_targets', None) or []):
                targets[t['seg']] = t
            idx = int(getattr(ex, 'index', 0)) + 1
            tgt = targets.get(idx) or {}
            cross = st.get('crossM')
            heading = None
            if pose is not None and seg.get('points'):
                from .control import geometry, wrap
                try:
                    c, tangent, remaining, _ = geometry(pose, seg['points'])
                    cross = c
                    heading = wrap(pose.yaw - tangent)
                except Exception:
                    pass
            fb = self.feedback or {}
            loco = (loc_ctx or {}).get('localOdom') or {}
            rec = build_motion_record(
                t=now, seg=idx, frm=seg.get('fromId'), to=seg.get('toId'),
                phase=getattr(ex, 'phase', None), mode=getattr(cmd, 'mode', None),
                cmd={'vx': getattr(cmd, 'vx', None), 'vy': getattr(cmd, 'vy', None),
                     'wz': getattr(cmd, 'yaw_rate', None),
                     'rawWz': st.get('lastCommandWz'),
                     'clampedWz': getattr(cmd, 'yaw_rate', None),
                     'wheelAngle': getattr(cmd, 'wheel_angle', None)},
                pose={'x': pose.x, 'y': pose.y, 'yaw': pose.yaw,
                      'stamp': getattr(pose, 'stamp', None)} if pose else {},
                target={'x': tgt.get('x'), 'y': tgt.get('y')},
                cross=cross, heading=heading,
                remaining=st.get('remainingM'),
                dr={'decision': st.get('last_decision'), 'refValid': st.get('steerRefValid'),
                    'refM': st.get('steerRefM'), 'refReason': st.get('steerRefReason'),
                    'refStamp': st.get('steerRefMono'), 'refSegment': st.get('steerRefSegment'),
                    'episode': dict(st.get('steerEpisode') or {}),
                    'predicted': dict(st.get('pred') or {}),
                    'predictedCross': st.get('crossM'), 'staleS': st.get('staleS'),
                    'yawSourceOk': st.get('yawSourceOk'),
                    'yawSourceReason': st.get('yawSourceReason'),
                    'anchorValid': st.get('anchor_valid'),
                    'anchorRejectReason': st.get('anchor_reject_reason'),
                    'corrections': st.get('corrections'),
                    'mechanicalCorrections': st.get('mechanicalCorrections')},
                endpoint_brake=dict(getattr(ex, 'endpoint_brake', None) or {}),
                fb={'seq': fb.get('seq'), 'age': (time.monotonic() - fb.get('aggregate_received', time.monotonic())) if fb.get('aggregate_received') else None,
                    'bodyGear': fb.get('body_gear'), 'steerGear': fb.get('steering_gear'),
                    'angles': fb.get('angles'), 'anglesRaw': fb.get('angles_raw'),
                    'steerAngle': fb.get('steering_angle'),
                    'vx': fb.get('vx'), 'vyRaw': fb.get('vy_raw'), 'vyMps': fb.get('vy_mps'),
                    'unlock': fb.get('unlock'), 'estop': fb.get('estop'),
                    'localX': loco.get('x'), 'localY': loco.get('y'),
                    'localYaw': loco.get('yaw'), 'localStamp': loco.get('stamp'),
                    'localEpoch': loco.get('epoch')},
                source_stamp=(getattr(self, 'qr_meta', None) or {}).get('sourceStamp'),
                qr={'sourceStamp': (getattr(self, 'qr_meta', None) or {}).get('sourceStamp'),
                    'correctionId': (getattr(self, 'qr_anchor', None) or {}).get('correctionId'),
                    'rebaseResidualM': (st.get('last_residual') or {}).get('rebaseResidualM')},
                send=getattr(self, '_last_send', None))
            rl.write_motion(rec)
            # 停稳证据（v11）：只在 executor 确认停稳（连续零速 + 目标码可见 +
            # 位姿稳定窗口满足）的那一次写一条真实记录；不再按帧刷 stops、
            # 也不再传 samples=[0] 把 zeroSamples 写成恒 1。
            fs = (getattr(ex, 'exit_info', None) or {}).get('finalStop') or {}
            fseq = fs.get('seq')
            if fseq is not None and fseq != getattr(self, '_last_stop_seq', None):
                self._last_stop_seq = fseq
                fb = self.feedback or {}
                sp = fb.get('vx', fb.get('speed'))
                rl.stop_record(build_stop_record(
                    t=fs.get('t', now), seg=idx, to=seg.get('toId'),
                    pose=fs.get('pose') or ({'x': pose.x, 'y': pose.y, 'yaw': pose.yaw} if pose else {}),
                    target={'x': tgt.get('x'), 'y': tgt.get('y')},
                    speed=sp if isinstance(sp, (int, float)) else 0.,
                    state=getattr(self.mission, 'state', None),
                    samples=fs.get('stableZeroSamples'),
                    stamp=(fb.get('header_stamp') if isinstance(fb, dict) else None),
                    distance_m=fs.get('distanceM'),
                    distance_raw_first_m=fs.get('distanceRawFirstM'),
                    distance_raw_last_m=fs.get('distanceRawLastM'),
                    stop_reason=fs.get('stopReason'),
                    pose_stability=fs.get('poseStability')))
        except Exception:
            if os.environ.get('QR_RUNLOG_DEBUG'):
                import traceback
                traceback.print_exc()

    def _run_log_send(self, cmd, state, ok):
        self._last_send = {'sent': bool(ok), 'state': state,
                           'mode': getattr(cmd, 'mode', None),
                           'vx': getattr(cmd, 'vx', None),
                           'vy': getattr(cmd, 'vy', None),
                           'wz': getattr(cmd, 'yaw_rate', None),
                           'wheelAngle': getattr(cmd, 'wheel_angle', None),
                           't': time.time()}

    def send(self,cmd):
        if self.engaged:
            # A failed runtime gate already recorded the cause. Stop the existing
            # sender without starting/alignment work or replacing that first fault.
            if self.mission.state=='FAULT':
                self.engaged=False
                self.motion.stop()
                return
            executor=getattr(self.mission,'segment_executor',None)
            if executor is not None and executor.phase=='START_STOP':
                # Do not create a sender/change gear before measured standstill.
                self.motion.stop()
                return
            state=self.mission.state if self.mission.running and not self.mission.paused else 'HOLD'
            try:
                ok_send=self.motion.send(cmd,state)
                self._run_log_send(cmd,state,bool(ok_send))
                if not ok_send:raise RuntimeError('成熟控制接口未接受指令')
            except Exception as error:
                can_health=getattr(self,'can_health',None)
                can=can_health.status() if can_health is not None else None
                reason=('CAN发送链路异常（'+can['state']+'）'
                        if can is not None and not can['ready'] else str(error))
                if self.mission.state!='FAULT':self.mission.fault('底盘指令发送失败：'+reason)
                self.engaged=False
                self.motion.stop()

    def recover_motion_after_stop(self,now):
        """Restore availability after a takeover; never resume or send a command."""
        if not getattr(self.motion,'suspended',False):
            self.motion_recovery_since=None
            return False
        if (self.mission.running or self.pending_start or self.engaged
                or not GreenhouseNode.static_feedback_stationary(self,now)
                or not GreenhouseNode.motion_feedback_ready(self)):
            self.motion_recovery_since=None
            return False
        since=getattr(self,'motion_recovery_since',None)
        if since is None:
            self.motion_recovery_since=now
            return False
        if now-since<.5:return False
        if not self.motion.recover_after_stop():return False
        self.motion_recovery_since=None
        self.mission.log('控制接口已恢复，可以重新启动导航')
        return True

    def request_start(self,command,conditions):
        if self.config.get('maintenance_mode',False):raise ValueError('IMU维护模式拒绝导航启动')
        if self.pending_start or self.mission.running:raise ValueError('已有启动中或运行中任务')
        missing=[v['label'] for v in conditions if not v['ready']]
        if missing:raise ValueError('ROS2安全条件不满足：'+'、'.join(missing))
        started=time.monotonic()
        self.motion.prepare()  # Load only; never send body/steering/IO commands.
        self.pending_start=command;self.pending_start_at=started
        self.start_gate={};self.start_samples=[];self.start_gate_reason=''
        self.mission.log('等待现有控制接口就绪，重新检查导航条件')

    def cancel_pending_start(self,reason):
        if self.pending_start:
            self.acks.put({'id':self.pending_start['id'],'ok':False,'message':reason})
            self.pending_start=None

    def advance_pending_start(self,conditions):
        command=self.pending_start
        if command is None:return
        now=time.monotonic();elapsed=now-self.pending_start_at
        missing='、'.join(v['label'] for v in conditions if not v['ready'])
        if missing:
            if elapsed>=3.:self.cancel_pending_start('启动等待超时：'+missing)
            return
        if not self.motion.prepare():return
        field=command['payload']['map'];task=copy.deepcopy(command['payload']['task'])
        pose=self.pose;loc=self.localization_status if isinstance(self.localization_status,dict) else {}
        fusion=self.fusion if isinstance(self.fusion,dict) else {}
        pose_dict,_=pose_values(pose)
        if pose_dict is not None and loc.get('mapId'):
            self.start_samples.append({'t':now,'x':pose_dict['x'],'y':pose_dict['y'],'yaw':pose_dict['yaw'],
                'mapId':loc.get('mapId'),'mapVersion':loc.get('mapVersion'),
                'localEpoch':loc.get('localEpoch'),'sigma':loc.get('positionSigmaM')})
            self.start_samples=[sample for sample in self.start_samples if now-sample['t']<=1.0]
        try:
            gate=evaluate_start_gate(field,task,pose,loc,fusion,
                (now-self.pose_received) if pose is not None else None,
                (now-self.localization_received) if loc else None,
                self.start_samples,self.config,elapsed)
        except Exception as error:
            # A start-gate integration error must never kill the navigation child.
            segments=field.get('motionSegments') or []
            self.start_gate={'mapId':field.get('id'),'mapVersion':task.get('mapVersion'),
                             'routeId':task.get('routeId') or '',
                             'firstTagId':segments[0].get('fromId') if segments else None,
                             'actualPose':pose_dict,'finalDecision':'reject',
                             'reasonCode':'start_gate_exception',
                             'reason':f'起点门禁内部错误：{type(error).__name__}: {error}',
                             'elapsedS':round(elapsed,3)}
            message='起点门禁内部错误，已安全拒绝启动：'+type(error).__name__
            self.mission.log(message+'；'+str(error))
            self.cancel_pending_start(message)
            return
        self.start_gate=gate['diagnostics']
        if gate['decision']=='wait':
            reason=gate['diagnostics'].get('reasonCode','')
            if reason!=self.start_gate_reason:
                self.start_gate_reason=reason
                self.mission.log('起点门禁等待：'+gate['message'])
            if elapsed>=float(self.config.get('start_gate_timeout_s',12.)):
                self.start_gate['finalDecision']='reject'
                self.cancel_pending_start('启动等待超时：'+gate['message'])
            return
        if gate['decision']=='reject':
            self.start_gate['finalDecision']='reject'
            self.mission.log('起点门禁拒绝：'+gate['message'])
            self.cancel_pending_start(gate['message'])
            return
        try:
            filtered=gate.get('pose') or pose_dict
            if not filtered:raise ValueError('起点门禁未返回有效位姿')
            start_pose=types.SimpleNamespace(x=filtered['x'],y=filtered['y'],yaw=filtered['yaw'])
            self.mission.start(field,task,start_pose)
            self.engaged=True
            self.acks.put({'id':command['id'],'ok':True,'message':'任务请求已由ROS2状态机处理'})
        except Exception as error:
            self.start_gate['finalDecision']='reject'
            self.acks.put({'id':command['id'],'ok':False,'message':str(error)})
            self.mission.log(str(error))
        self.pending_start=None

    def apply_calibration_command(self,payload):
        """只切换被动标定采样上下文；绝不触发运动、解锁或导航。"""
        if not isinstance(payload,dict):raise ValueError('标定命令格式无效')
        if payload.get('active'):
            session_id=payload.get('sessionId');trial_id=payload.get('trialId')
            if (not isinstance(session_id,str) or not session_id or len(session_id)>80
                    or not isinstance(trial_id,str) or not trial_id or len(trial_id)>80):
                raise ValueError('标定会话/试验编号无效')
            self.calibration_context={'sessionId':session_id,'trialId':trial_id}
            self.calibration_last_context=dict(self.calibration_context)
            self.mission.log('开始被动记录标定样本；不发送任何运动命令')
        else:
            self.calibration_context=None
            self.mission.log('结束标定样本记录')

    def tick(self):
        with self.lock:registry=copy.deepcopy(self.registry_boards)
        boards=self.mission.field.get('groups',[]) if self.mission.running and self.mission.field else registry
        serialized=json.dumps({'boards':boards},sort_keys=True)
        if serialized!=self.boards_sent:
            self.active_boards=validate_boards(boards);self.boards_pub.publish(String(data=serialized));self.boards_sent=serialized
        start=time.monotonic();dt=min(.1,start-self.last_tick);self.last_tick=start
        GreenhouseNode.recover_motion_after_stop(self,start)
        conditions=self.conditions()
        while not self.commands.empty():
            c=self.commands.get_nowait();ok=False
            try:
                if c['type']=='start':
                    self.request_start(c,conditions)
                    continue  # Acknowledge only after discovery and rechecks.
                elif c['type']=='stop':self.cancel_pending_start('启动已由停止指令取消');self.mission.stop()
                elif c['type']=='pause':self.cancel_pending_start('启动已由暂停指令取消');self.mission.pause()
                elif c['type']=='resume':
                    if any(not v['ready'] for v in conditions):raise ValueError('恢复任务前需重新满足全部运行条件')
                    self.mission.resume()
                elif c['type']=='calibration':self.apply_calibration_command(c.get('payload') or {})
                else:raise ValueError('未知任务命令')
                ok=True;message='任务请求已由ROS2状态机处理'
            except Exception as e:message=str(e);self.mission.log(message)
            self.acks.put({'id':c['id'],'ok':ok,'message':message})
        if self.pending_start:
            conditions=self.conditions()
            self.advance_pending_start(conditions)
        observations=GreenhouseNode.current_observations(self,start)
        diagnostic_time=self.get_clock().now().nanoseconds/1e9
        try:
            diagnostic_sample=self.execution_diagnostics.capture(
                self.mission,self.pose,self.feedback or {},observations,start,self.pose_received,
                diagnostic_time,getattr(self,'localization_status',None) or {},
                getattr(self,'localization_received',0.))
        except Exception:
            # Display diagnostics must never interrupt mission decisions or command output.
            diagnostic_sample={'status':'unavailable','reason':'执行诊断数据暂不可用','sampledAt':diagnostic_time}
        from .dr_anchor import build_localization_context
        loc_context=build_localization_context(self.localization_status,self.local_odom,self.qr_meta,self.qr_anchor)
        cmd=self.mission.tick(self.pose,self.feedback or {},observations,conditions,dt,localization=loc_context)
        self._cmd_frame=getattr(self,'_cmd_frame',0)+1
        self._run_log_tick(cmd,loc_context,start,diagnostic_time)
        try:
            from .diag_log import get as _diag_get
            ctl=_diag_get('control')
            _active=abs(getattr(cmd,'vx',0.))+abs(getattr(cmd,'vy',0.))+abs(getattr(cmd,'wz',0.))>1e-9
            if _active or self._cmd_frame%50==0 or getattr(self,'_last_cmd_active',False):
                fbk=self.feedback or {}
                ctl.write({'type':'command','frame':self._cmd_frame,
                    'vx':getattr(cmd,'vx',None),'vy':getattr(cmd,'vy',None),'wz':getattr(cmd,'wz',None),
                    'mode':getattr(cmd,'mode',None),
                    'qrSourceStamp':(getattr(self,'qr_meta',None) or {}).get('sourceStamp'),
                    'qrLastQualifiedAge':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('qrLastQualifiedAgeS'),
                    'drDecision':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('last_decision'),
                    'drCrossM':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('crossM'),
                    'drYawSourceOk':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('yawSourceOk'),
                    'drYawSourceReason':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('yawSourceReason'),
                    'drVySourceOk':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('vySourceOk'),
                    'drAnchorValid':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('anchor_valid'),
                    'drAnchorRejectReason':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('anchor_reject_reason'),
                    'drSteerActive':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('steeringActive'),
                    'drSteerBiasM':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('steerBiasM'),
                    'drSteeringSource':(getattr(getattr(self.mission,'segment_executor',None),'exit_info',None) or {}).get('steeringSource'),
                    'drSteerRefValid':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('steerRefValid'),
                    'drSteerRefReason':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('steerRefReason'),
                    'drSteerEpisode':dict((getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('steerEpisode') or {}),
                    'drAutoLateral':False,
                    'drCorrections':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('corrections'),
                    'drMechanicalCorrections':(getattr(getattr(self.mission,'segment_executor',None),'dr_state',None) or {}).get('mechanicalCorrections'),
                    'endpointBrake':dict(getattr(getattr(self.mission,'segment_executor',None),'endpoint_brake',None) or {}),
                    'vySuggestedMps':getattr(cmd,'vy',None),
                    'fb':{'seq':fbk.get('seq'),'bodyGear':fbk.get('body_gear'),'steerGear':fbk.get('steering_gear'),
                          'vx':fbk.get('vx'),'anglesRaw':fbk.get('angles_raw'),'steerAngle':fbk.get('steering_angle'),
                          'unlock':fbk.get('unlock'),'estop':fbk.get('estop'),'remote':fbk.get('remote_control')},
                    'recv':round(time.time(),6)})
            self._last_cmd_active=_active
        except Exception:
            pass
        while self.mission.job_requests:self.job_pub.publish(String(data=json.dumps(self.mission.job_requests.pop(0),ensure_ascii=False)))
        if cmd.mode=='4t4d':
            executor=getattr(self.mission,'segment_executor',None)
            trial=limits_for(executor.segment.get('executionProfile')) if executor else None
            if executor is not None and executor.turning:
                # A pure in-place turn has no forward speed, so the curvature bound
                # below would clamp the yaw rate to zero. Use the turn rate limit.
                bound=float(self.config.get('turn_yaw_rate_max_radps',.3))
            else:
                bound=min(trial['maxYawRate'],abs(cmd.vx)*trial['maxCurvature']) if trial else abs(cmd.vx)*.6
            cmd.yaw_rate=max(-bound,min(bound,cmd.yaw_rate))
        # 人工接管/其它原命令发布者出现时退出控制，不向其继续覆盖零指令。
        ownership=next(v['ready'] for v in conditions if v['id']=='ownership')
        if self.engaged:
            if ownership and not (self.feedback or {}).get('remote_control',True):self.send(cmd)
            else:self.engaged=False
        if not self.mission.running and self.feedback and self.feedback['speed']<=self.config['stopped_speed_mps']:self.engaged=False
        telemetry={'bootId':self.boot_id,'seq':self.seq+int(start*1000),'state':self.mission.state,'running':self.mission.running,'paused':self.mission.paused,'rowId':self.mission.row['id'] if self.mission.row else '', 'pose':{'x':self.pose.x,'y':self.pose.y,'yaw':self.pose.yaw} if self.pose and start-self.pose_received<.25 else None,'speed':(self.feedback or {}).get('vx',0.),'wheelAngle':None if not self.feedback or self.feedback['angles'] is None else sum(self.feedback['angles'])/4,'tagId':observations[0]['id'] if observations else None,'chassis':{'connected':start-self.received<.3,'feedback':self.feedback},'sensors':{'camera':'最后接入' if not self.camera_received else '已接入' if start-self.camera_received<.5 else '观测过期','odom':'原底盘反馈在线，横移标定待确认' if start-self.received<.3 else '离线','imu':'在线' if start-self.imu_received<.5 else '未接入','localization':'在线' if self.pose and start-self.pose_received<.25 else '未就绪'},'conditions':conditions,'events':self.mission.events,'cycleMs':(time.monotonic()-start)*1000,'taskId':self.mission.task['id'] if self.mission.task else ''}
        try:
            telemetry['executionDiagnostics']=self.execution_diagnostics.finalize(diagnostic_sample,self.mission)
        except Exception:
            telemetry['executionDiagnostics']={'status':'unavailable','reason':'执行诊断数据暂不可用','sampledAt':diagnostic_time}
        telemetry['startGate']=self.start_gate
        telemetry['maintenance']={'active':self.config.get('maintenance_mode',False),'executionEnabled':self.config['execution_enabled'],'pendingStart':self.pending_start is not None,'queuedLocalCommands':self.commands.qsize(),'taskCommandPolling':not self.config.get('maintenance_mode',False),'imuDirectionVerified':self.config.get('imu_direction_verified',False)}
        # Capability is reported by this node, never assumed by the web bridge.
        telemetry['capabilities']={'turnInPlace':bool(TURN_EXECUTION_AVAILABLE and float(self.config.get('turn_yaw_rate_max_radps',0.))>0 and float(self.config.get('turn_timeout_s',0.))>0),'turnToleranceDeg':float(self.config.get('turn_tolerance_deg',5.)),'turnMaxRateRadps':float(self.config.get('turn_yaw_rate_max_radps',.3)),'turnTimeoutS':float(self.config.get('turn_timeout_s',15.))}
        telemetry['markerTracking']=GreenhouseNode.marker_tracking(self,start)
        telemetry.update(self.sensor_status(start,telemetry['sensors']))
        telemetry['pose'],telemetry['localization']=self.localization_telemetry(start)
        if telemetry['localization']['state']=='STATIC_ANCHORED' and telemetry['localization']['poseAvailable']:
            telemetry['sensors']['localization']='静止已定位 / 运动同步待接入'
        elif (telemetry['localization']['state']=='LOCAL_ONLY'
                and telemetry['localization']['source']=='synchronized_qr'
                and telemetry['localization']['captureTimestampVerified']):
            telemetry['sensors']['localization']='二维码时间已同步 / 定位精度待验证'
        visible=next((t for t in observations if t.get('groupId')),None)
        board=next((b for b in self.active_boards if visible and b['id']==visible['groupId']),None)
        telemetry['group']=None if not visible or not board else {'id':board['id'],'visible':visible['visibleCount'],'total':len(board['members']),'uncertaintyM':visible['sigma'],'degraded':visible['visibleCount']<len(board['members'])}
        self.status_pub.publish(String(data=json.dumps(telemetry,ensure_ascii=False)))
        with self.lock:self.snapshot=telemetry

    def current_observations(self, now):
        age=now-getattr(self,'observation_received',0.)
        return self.observations if 0<=age<.25 else []

    def marker_tracking(self, now):
        """Report missing QR observations without presenting them as a motion gate."""
        received=getattr(self,'tag_received',0.)
        age=now-received if received else None
        observation_age=now-getattr(self,'observation_received',0.)
        return {'visible':bool(self.observations and 0<=observation_age<.25),
                'lastSeenAgeS':age if age is not None and age>=0 else None,
                'withinTimeout':bool(age is not None and 0<=age<self.config['tag_timeout_s']),
                'timeoutS':self.config['tag_timeout_s']}

    def sensor_status(self, now, sensors):
        """Describe fresh ROS inputs; camera preview is a separate web service."""
        sensors=dict(sensors)
        detector_fresh=self.detector is not None and 0<=now-self.detector_received<.5
        detected=self.detector if detector_fresh else {}
        if detector_fresh:
            if detected.get('positionReady'):
                camera_label=('定位观测已同步' if detected.get('captureTimestampVerified') and detected.get('localPoseReady')
                              else '位姿已计算 / 待同步')
            elif detected.get('calibrationDiagnostic'):
                camera_label='已标定 / 标定板画面'
            elif detected.get('visibleMemberCount'):
                camera_label='识别'+str(detected['visibleMemberCount'])+'子码 / '+('待定位校验' if detected.get('calibrated') else '待标定')
            else:
                camera_label='已标定 / 未见定位组' if detected.get('calibrated') else '在线 / 待标定'
            detector_reason=detected.get('reason','')
        else:
            camera_label='识别服务心跳超时' if self.detector is not None else '等待识别服务心跳'
            detector_reason=('定位识别服务心跳超时，未收到新的识别结果' if self.detector is not None
                             else '未收到定位识别服务心跳，预览画面不代表定位识别已就绪')
        sensors['camera']=camera_label
        fusion_fresh=self.fusion is not None and 0<=now-self.fusion_received<.5
        fusion=self.fusion if fusion_fresh else {}
        imu_age=fusion.get('agesMs',{}).get('imu')
        if self.imu_received and 0<=now-self.imu_received<.5:
            sensors['imu']='在线'
        elif fusion_fresh and isinstance(imu_age,(int,float)) and math.isfinite(imu_age) and 0<=imu_age<500:
            sensors['imu']='在线（融合输入）'
        elif fusion_fresh:
            sensors['imu']='IMU数据超时 / 等待恢复' if imu_age is not None else '等待IMU数据'
        elif self.imu_received:
            sensors['imu']='IMU数据超时 / 等待恢复'
        elif self.config['imu_topic']:
            sensors['imu']='等待IMU数据：'+self.config['imu_topic']
        else:
            sensors['imu']='等待融合服务确认IMU输入'
        if fusion_fresh:
            feedback_age=fusion.get('agesMs',{}).get('feedback')
            if isinstance(feedback_age,(int,float)) and math.isfinite(feedback_age) and 0<=feedback_age<300:
                sensors['odom']=(('底盘反馈 + IMU 已融合' if fusion.get('ready') else '底盘反馈已接入 / 等待IMU融合') if fusion.get('source')=='chassis' else '四轮已接入' if fusion.get('source')=='wheels' else '原底盘已接入')
            if fusion.get('state')=='INVALID' or not (self.pose and 0<=now-self.pose_received<.25):
                sensors['localization']={'CALIBRATING':'静止校零中，请保持静止','WAITING':'等待融合数据',
                    'PROVISIONAL':'局部已融合 / 待标定','FUSED':'局部已融合 / 等待二维码',
                    'INVALID':'定位中断 / 等待自动恢复，请保持静止'}.get(fusion.get('state'),'等待融合数据')
        elif not (self.pose and 0<=now-self.pose_received<.25):
            sensors['localization']='融合服务心跳超时 / 等待恢复' if self.fusion is not None else '等待融合服务心跳'
        mapping_fresh=self.mapping is not None and 0<=now-self.mapping_received<.5
        mapping_reason=self.mapping.get('reason','') if mapping_fresh else ('草稿采集服务心跳超时' if self.mapping is not None else '等待草稿采集服务心跳')
        mapping_quality='draft'
        mapping_epoch=self.mapping.get('localEpoch','') if mapping_fresh else ''
        mapping_ready=bool(mapping_fresh and self.mapping.get('ready'))
        # Draft capture deliberately stops after verified observations take over.
        # Its inactive status must not override the live formal capture stream.
        if fusion_fresh and fusion.get('mappingReady') and detector_fresh and detected.get('captureTimestampVerified') is True:
            mapping_quality='verified';mapping_epoch=fusion.get('epoch','')
            observation_fresh=0<=now-getattr(self,'observation_received',0.)<.25
            evidence=getattr(self,'mapping_observation',None) or {}
            evidence_stamp=evidence.get('stamp',float('-inf'))
            now_ros=self.get_clock().now().nanoseconds/1e9
            mapping_ready=bool(observation_fresh and mapping_epoch
                and evidence.get('localEpoch')==mapping_epoch and 0<=now_ros-evidence_stamp<.25)
            if mapping_ready:
                sensors['camera']='定位观测已同步'
                if detector_reason=='局部轮式/IMU融合位姿未验证，扫描尚未就绪':detector_reason=''
            mapping_reason='' if mapping_ready else '等待新鲜的正式同步定位观测'
        if fusion_fresh and fusion.get('state')=='INVALID':
            # Keep the actual cause while removing the obsolete manual-restart advice.
            cause=str(fusion.get('reason') or mapping_reason or '融合输入无效')
            cause=cause.replace('，需重启融合','').replace('，需轮式横移标定并重新初始化','（横移尚未标定）')
            mapping_reason=cause+'；等待自动恢复，请保持车辆静止'
        if not detector_fresh:
            mapping_reason=detector_reason+('；'+mapping_reason if mapping_reason else '')
        elif not fusion_fresh:
            mapping_reason=sensors['localization']+('；'+mapping_reason if mapping_reason else '')
        return {'sensors':sensors,
                'detector':{'connected':detector_fresh,'ids':detected.get('detectedIds',[]),
                    'groups':detected.get('visibleGroups',[]),'positionReady':bool(detected.get('positionReady')),
                    'reason':detector_reason,'processingMs':detected.get('processingMs',0.)},
                'mapping':{'ready':bool(mapping_ready and fusion_fresh and fusion.get('ready') and fusion.get('state')!='INVALID' and detector_fresh),
                    'quality':mapping_quality,'reason':mapping_reason,'localEpoch':mapping_epoch,
                    'lateralSupported':bool(fusion_fresh and fusion.get('ready') and fusion.get('lateralSupported'))}}

    def fetch_task_commands(self,request):
        # Maintenance observes telemetry but never fetches/consumes queued jobs.
        if self.config.get('maintenance_mode',False):return []
        return request('/api/robot/commands')

    def web_worker(self):
        seen=set();url=self.config['backend_url'];key_path=Path(self.config['bridge_key_file']);opener=build_opener(ProxyHandler({}));last_error=0.
        def request(path,data=None):
            key=key_path.read_text().strip();req=Request(url+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json','X-Bridge-Key':key});
            with opener.open(req,timeout=.8) as response:return json.load(response)
        log_path=Path(self.config['bridge_key_file']).parent.parent/'logs/navigation.jsonl'
        log_path.parent.mkdir(parents=True,exist_ok=True)
        last_success=time.monotonic();last_boards=0.;last_sent_snapshot=None
        while not self.closed.is_set():
            try:
                if time.monotonic()-last_boards>2.:
                    boards=validate_boards(request('/api/boards'))
                    with self.lock:self.registry_boards=copy.deepcopy(boards)
                    last_boards=time.monotonic()
                with self.lock:status=copy.deepcopy(self.snapshot)
                snapshot_key=(status.get('bootId'),status.get('seq')) if status else None
                if status and snapshot_key!=last_sent_snapshot:
                    request('/api/robot/telemetry',status)
                    last_sent_snapshot=snapshot_key
                    if log_path.exists() and log_path.stat().st_size>20*1024*1024:log_path.replace(log_path.with_suffix('.previous.jsonl'))
                    with log_path.open('a') as file:file.write(json.dumps({'recorded':time.time(),'status':status},ensure_ascii=False)+'\n')
                for c in self.fetch_task_commands(request):
                    if c['id'] not in seen:self.commands.put(c);seen.add(c['id'])
                while not self.acks.empty():request('/api/robot/ack',self.acks.get_nowait())
                motion=[]
                while len(motion)<200 and not self.motion_records.empty():motion.append(self.motion_records.get_nowait())
                if motion:request('/api/robot/motion-records',{'records':motion})
                calibration_context=self.calibration_context or self.calibration_last_context
                if calibration_context is not None:
                    samples=[]
                    while len(samples)<150 and not self.calibration_samples.empty():samples.append(self.calibration_samples.get_nowait())
                    if samples:request('/api/robot/calibration/samples',{'sessionId':calibration_context['sessionId'],'trialId':calibration_context['trialId'],'samples':samples})
                    if self.calibration_context is None and self.calibration_samples.empty():self.calibration_last_context=None
                observations=[]
                while len(observations)<5 and not self.survey.empty():observations.append(self.survey.get_nowait())
                if observations:request('/api/robot/observations',{'samples':observations})
                last_success=time.monotonic()
            except Exception as e:
                if time.monotonic()-last_error>10.:self.get_logger().warning('Web桥连接错误：'+str(e));last_error=time.monotonic()
                if self.mission.running and time.monotonic()-last_success>.8:self.commands.put({'id':str(uuid.uuid4()),'type':'pause','payload':{}})
            # Keep live display updates inside the 250ms pose freshness window.
            self.closed.wait(.1)

    def close(self):
        self.closed.set()
        if self.pid_file.exists() and self.pid_file.read_text().strip()==str(os.getpid()):self.pid_file.unlink()
        fb=self.feedback or {}
        # Do not overwrite a new owner/manual command when shutting down.
        # Resource cleanup alone must never load the hardware controller.
        if (self.engaged and time.monotonic()-self.received<self.config['feedback_timeout_s']
                and not fb.get('remote_control',True)
                and self.motion.owns_publishers({topic:self.get_publishers_info_by_topic(topic) for topic in COMMAND_TOPICS})):
            self.motion.stop()
        self.motion.close()


def main(args=None):
    rclpy.init(args=args);node=GreenhouseNode()
    try:rclpy.spin(node)
    except KeyboardInterrupt:pass
    finally:node.close();node.destroy_node();rclpy.try_shutdown()
