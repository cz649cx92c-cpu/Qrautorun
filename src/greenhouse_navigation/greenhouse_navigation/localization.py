"""局部robot_localization EKF + 地面标记全局校正；相机未接入时不伪造map位姿。"""
import bisect
import copy
from collections import deque
import json
import math
import os
import time
from pathlib import Path
import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from nav_msgs.msg import Odometry
from geometry_msgs.msg import TransformStamped
from std_msgs.msg import String
from tf2_ros import TransformBroadcaster
from yhs_can_interfaces.msg import ChassisInfoFb
from .control import wrap
from .board_geometry import collapse_group_observations,validated_board_observations,validate_boards


def absolute_tag_pose(tag,relative):
    yaw=wrap(math.radians(tag['angle'])-relative['angle'])
    x=tag['x']-math.cos(yaw)*relative['x']+math.sin(yaw)*relative['y']
    y=tag['y']-math.sin(yaw)*relative['x']-math.cos(yaw)*relative['y']
    return np.array([x,y,yaw])


def propagate_pose(estimate,previous,current):
    """观测时刻的二维码位姿，按局部运动增量推到当前时刻；含倒车/横移。"""
    result=np.array(estimate,dtype=float).copy()
    previous=np.asarray(previous);current=np.asarray(current)
    offset=wrap(result[2]-previous[2]);c,s=math.cos(offset),math.sin(offset)
    result[:2]+=np.array([[c,-s],[s,c]])@(current[:2]-previous[:2])
    result[2]=wrap(result[2]+wrap(current[2]-previous[2]))
    return result


def process_covariance_increment(previous,current,dt,position_noise,angle_noise,stationary=False):
    """Keep uncertainty while confirmed stopped; retain motion noise otherwise."""
    previous=np.asarray(previous,dtype=float);current=np.asarray(current,dtype=float)
    if (previous.shape!=(3,) or current.shape!=(3,)
            or not np.all(np.isfinite(previous)) or not np.all(np.isfinite(current))
            or not all(math.isfinite(v) for v in (dt,position_noise,angle_noise))
            or not 0<dt<.3 or min(position_noise,angle_noise)<0):
        raise ValueError('Invalid localization process increment')
    # Wheel/IMU quietness alone cannot mask translation or rotation in local odometry.
    no_motion=(np.linalg.norm(current[:2]-previous[:2])<=1e-6
               and abs(wrap(current[2]-previous[2]))<=math.radians(.1)*dt)
    if stationary and no_motion:return np.zeros((3,3))
    return np.diag([position_noise**2,position_noise**2,angle_noise**2])*dt


def correction_update(estimate,covariance,observed,noise,max_innovation=.2):
    if not all(np.all(np.isfinite(v)) for v in (estimate,covariance,observed,noise)):
        return None
    if np.any(np.linalg.eigvalsh(covariance)<=0) or np.any(np.linalg.eigvalsh(noise)<=0):
        return None
    innovation=np.asarray(observed)-estimate;innovation[2]=wrap(innovation[2])
    total=covariance+noise
    if (np.linalg.norm(innovation[:2])>max_innovation or abs(innovation[2])>.3
            or innovation@np.linalg.solve(total,innovation)>11.34):return None
    gain=np.linalg.solve(total.T,covariance.T).T
    result=estimate+gain@innovation;result[2]=wrap(result[2]);identity=np.eye(3)
    posterior=(identity-gain)@covariance@(identity-gain).T+gain@noise@gain.T
    return result,(posterior+posterior.T)/2


def finite_number(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)


class StationaryAnchor:
    """Receive-time QR diagnostic, isolated from synchronized localization.

    Floors are conservative priors, not measured map accuracy. Repeated views
    share calibration/receive-time errors, so they cannot reduce these floors.
    No ROS nodes, publishers, TF or chassis controllers are constructed here.
    """
    def __init__(self,field,timeout=.25,minimum_s=1.,position_floor=.05,yaw_floor=.1,max_innovation=.2):
        if (not all(finite_number(v) for v in (timeout,minimum_s,position_floor,yaw_floor,max_innovation))
                or not .01<=timeout<=1. or minimum_s<1. or position_floor<.05 or yaw_floor<.1
                or max_innovation<=0):raise ValueError('静止锚定需至少1秒，协方差先验下限不可降低')
        self.boards=validate_boards(field.get('groups',[]));self.tags={t['id']:t for t in field['tags']}
        self.timeout=timeout;self.minimum_s=minimum_s;self.position_floor=position_floor;self.yaw_floor=yaw_floor
        self.max_innovation=max_innovation;self.epoch='';self.fusion=None;self.feedback=None;self.local=None
        self.quiet_since=None;self.estimate=None;self.covariance=None;self.last_tag=None;self.tag_received=None
        self.reason='等待连续静止底盘、已确认的融合及正式局部里程计'

    def reset(self,reason,reset_window=True,clear_origin=True):
        if clear_origin:self.estimate=self.covariance=None
        self.last_tag=self.tag_received=None
        if reset_window:self.quiet_since=None
        self.reason=reason

    def fresh(self,sample,ros_now,monotonic_now):
        return (sample is not None and 0<=ros_now-sample['stamp']<=self.timeout
                and 0<=monotonic_now-sample['received']<=self.timeout)

    def update_fusion(self,data,ros_now,monotonic_now):
        epoch=data.get('epoch') if isinstance(data,dict) else None
        changed=isinstance(epoch,str) and bool(epoch) and epoch!=self.epoch
        if changed:
            self.reset('融合epoch变化，等待新原点连续静止');self.local=None;self.feedback=None;self.fusion=None;self.epoch=epoch
        stamp=data.get('stamp') if isinstance(data,dict) else None
        ages=data.get('agesMs',{}) if isinstance(data,dict) else {}
        valid=(finite_number(stamp) and 0<=ros_now-stamp<=self.timeout
               and isinstance(epoch,str) and bool(epoch) and epoch==self.epoch
               and data.get('state')=='FUSED' and data.get('source')=='chassis'
               and data.get('ready') is True and data.get('mappingReady') is True
               and data.get('approvalBasis')=='user_confirmation'
               and isinstance(ages,dict) and all(finite_number(ages.get(k)) and 0<=ages[k]<=self.timeout*1000
                                                for k in ('imu','odom','feedback','filter')))
        if not valid:
            self.fusion=None;self.reset('融合未就绪、未确认或输入已过期');return changed
        if self.fusion and (stamp<=self.fusion['stamp'] or not self.fresh(self.fusion,ros_now,monotonic_now)):
            self.fusion=None;self.reset('融合状态重复、回退或中断');return changed
        self.fusion={'stamp':stamp,'received':monotonic_now}
        self.inputs_ready(ros_now,monotonic_now)
        return changed

    def update_feedback(self,stamp,velocities,yaw_rate,gear,ros_now,monotonic_now):
        valid=(finite_number(stamp) and 0<=ros_now-stamp<=self.timeout
               and len(velocities)==7 and all(finite_number(v) for v in velocities)
               and finite_number(yaw_rate) and gear in (0,1,2,5,6,7,8))
        if not valid:
            self.feedback=None;self.reset('底盘反馈无效或已过期');return False
        if self.feedback and stamp<=self.feedback['stamp']:
            self.reset('底盘反馈时间戳重复或回退');self.feedback=None;return False
        if self.feedback and not self.fresh(self.feedback,ros_now,monotonic_now):self.reset('底盘反馈中断')
        quiet=all(abs(v)<=.002 for v in velocities) and abs(yaw_rate)<=math.radians(.1)
        self.feedback={'stamp':stamp,'received':monotonic_now,'quiet':quiet}
        if not quiet:self.reset('检测到运动：仅传播静止二维码原点，接收时间修正已停用',clear_origin=False)
        self.inputs_ready(ros_now,monotonic_now)
        return quiet

    def update_local(self,stamp,pose,ros_now,monotonic_now):
        if not finite_number(stamp) or not 0<=ros_now-stamp<=self.timeout or not np.all(np.isfinite(pose)):
            self.local=None;self.reset('正式局部里程计无效或已过期');return False
        old=self.local
        if old and (stamp<=old['stamp'] or not self.fresh(old,ros_now,monotonic_now)):
            self.reset('局部里程计中断或时间回退');old=None
        self.local={'stamp':stamp,'received':monotonic_now,'pose':np.array(pose,dtype=float)}
        valid=self.inputs_valid(ros_now,monotonic_now)
        if valid and self.estimate is not None and old is not None:
            self.estimate=propagate_pose(self.estimate,old['pose'],pose)
            # Deliberately conservative process priors, never measured noise.
            self.covariance+=np.diag([.03**2,.03**2,.05**2])*(stamp-old['stamp'])
        self.inputs_ready(ros_now,monotonic_now)
        return True

    def inputs_valid(self,ros_now,monotonic_now):
        if (not self.epoch or not self.fresh(self.feedback,ros_now,monotonic_now)
                or not self.fresh(self.fusion,ros_now,monotonic_now)
                or not self.fresh(self.local,ros_now,monotonic_now)):
            self.reset('等待新鲜底盘、融合及正式局部里程计；旧原点已失效')
            return False
        return True

    def inputs_ready(self,ros_now,monotonic_now):
        if not self.inputs_valid(ros_now,monotonic_now):return False
        if not self.feedback['quiet']:
            self.reset('检测到运动：仅传播静止二维码原点，接收时间修正已停用',clear_origin=False)
            return False
        if self.quiet_since is None:self.quiet_since=monotonic_now
        if monotonic_now-self.quiet_since<self.minimum_s:
            self.reason='保持静止，等待连续静止至少1秒';return False
        return True

    def available(self,ros_now,monotonic_now):
        if not self.inputs_ready(ros_now,monotonic_now):return False
        if (self.estimate is None or self.last_tag is None or self.tag_received is None
                or not 0<=ros_now-self.last_tag<=self.timeout
                or not 0<=monotonic_now-self.tag_received<=self.timeout):
            self.reset('仅传播静止二维码原点，等待新鲜已标定的二维码板中心',reset_window=False,clear_origin=False);return False
        return True

    def observe(self,data,local,ros_now,monotonic_now,received=None):
        if not self.inputs_ready(ros_now,monotonic_now):return False
        received=monotonic_now if received is None else received
        if not finite_number(received) or not 0<=monotonic_now-received<=self.timeout:return False
        if self.last_tag is not None and (ros_now-self.last_tag>self.timeout or monotonic_now-self.tag_received>self.timeout):
            self.reset('二维码观测已过期，仅保留局部增量传播',reset_window=False,clear_origin=False)
        try:
            stamp=data.get('stamp')
            if (not finite_number(stamp) or not 0<=ros_now-stamp<=self.timeout
                    or data.get('calibrated') is not True or data.get('synchronized') is not False
                    or data.get('frame')!='base_link' or data.get('representation')!='board-centers'
                    or self.last_tag is not None and stamp<=self.last_tag
                    or local is None or not np.all(np.isfinite(local))):return False
            raw=data['tags']
            if not isinstance(raw,list) or not 1<=len(raw)<=30:return False
            checked=validated_board_observations(raw,self.boards,data.get('groupLayouts',[]))
            if len(checked)!=len(raw):return False
            candidates=[]
            for relative in checked:
                tag=self.tags.get(relative['id'])
                if (tag is None or not relative.get('groupId') or tag.get('groupId')!=relative['groupId']
                        or not all(finite_number(tag.get(k)) for k in ('x','y','angle','size'))):return False
                board=next(b for b in self.boards if b['id']==relative['groupId'])
                if abs(tag['size']-board['sizeMm']/1000)>1e-7:return False
                candidate=propagate_pose(absolute_tag_pose(tag,relative),local,self.local['pose'])
                angle_sigma=max(self.yaw_floor,relative['angleSigma'])
                sigma=max(self.position_floor,math.hypot(relative['sigma'],math.hypot(relative['x'],relative['y'])*angle_sigma))
                candidates.append((candidate,sigma,angle_sigma))
            if any(np.linalg.norm(a[0][:2]-b[0][:2])>.08 or abs(wrap(a[0][2]-b[0][2]))>.15
                   for a in candidates for b in candidates):return False
            estimate=None if self.estimate is None else self.estimate.copy()
            covariance=None if self.covariance is None else self.covariance.copy()
            for observed,sigma,angle_sigma in candidates:
                noise=np.diag([sigma**2,sigma**2,angle_sigma**2])
                if estimate is None:estimate=observed.copy();covariance=noise;continue
                update=correction_update(estimate,covariance,observed,noise,self.max_innovation)
                if update is None:return False
                estimate,covariance=update
                covariance+=np.diag(np.maximum(0.,np.array([self.position_floor**2]*2+[self.yaw_floor**2])-np.diag(covariance)))
            self.estimate,self.covariance=estimate,covariance;self.last_tag=stamp;self.tag_received=received
            self.reason='静止二维码锚定：接收时间；协方差为保守先验，非实测精度'
            return True
        except (ValueError,KeyError,TypeError,AttributeError,StopIteration):return False


class GlobalLocalization(Node):
    def __init__(self):
        super().__init__('qr_global_localization')
        for key,value in [('map_file',''),('local_odom_topic','/qr/odometry/local'),('process_noise_m_sqrt_s',.01),('process_noise_rad_sqrt_s',.02),('covariance_calibrated',False),('synchronized_navigation_confirmed',False),('qr_interval_navigation',False),('max_observation_age_s',.25),('max_innovation_m',.2),('max_position_sigma_m',.03),('enable_stationary_anchor',True),('publish_tf',False)]:self.declare_parameter(key,value)
        path=self.get_parameter('map_file').value
        if not path:raise ValueError('需要已保存的正式地图JSON；不自动使用示例地图定位')
        self.map_path=Path(path);self.map_content=self.map_path.read_text()
        field=json.loads(self.map_content);self.field=field.get('map',field);self.map_version=field.get('version')
        if self.field.get('coordinateStatus')!='reviewed':raise ValueError('全局定位必须使用已接纳的地图')
        self.boards=validate_boards(self.field.get('groups',[]))
        self.tags={t['id']:t for t in self.field['tags']};self.history=deque(maxlen=300);self.estimate=None;self.covariance=np.eye(3);self.last=None;self.last_tag=0.
        self.formal_origin=False;self.formal_published_at=None;self.formal_preview_at=None
        self.enable_stationary_anchor=self.get_parameter('enable_stationary_anchor').value
        self.anchor=StationaryAnchor(self.field,timeout=self.get_parameter('max_observation_age_s').value,
                                     max_innovation=self.get_parameter('max_innovation_m').value)
        self.pending_static=deque(maxlen=20);self.last_odometry=None
        self.create_subscription(Odometry,self.get_parameter('local_odom_topic').value,self.odometry,20)
        self.create_subscription(String,'/qr/tags/observations',self.observe,10)
        if self.enable_stationary_anchor:
            self.create_subscription(String,'/qr/tags/provisional',self.observe_static,10)
            self.create_subscription(ChassisInfoFb,'/chassis_info_fb',self.feedback,qos_profile_sensor_data)
            self.create_subscription(String,'/qr/fusion/status',self.fusion_status,10)
        self.pub=self.create_publisher(Odometry,'/qr/localization/pose',10)
        self.preview_pub=self.create_publisher(Odometry,'/qr/localization/provisional',10)
        self.static_pub=self.create_publisher(Odometry,'/qr/localization/static_pose',10)
        self.status_pub=self.create_publisher(String,'/qr/localization/status',10)
        self.tf=TransformBroadcaster(self) if self.get_parameter('publish_tf').value else None
        self.create_timer(.05,self.status)
        self.create_timer(.5,self.reload_map)
        self.get_logger().info('融合定位等待最后接入的标记观测；无标记锚定不输出map坐标')

    def reload_map(self):
        try:
            content=self.map_path.read_text()
            if content==self.map_content:return
            raw=json.loads(content);field=raw.get('map',raw)
            if field.get('coordinateStatus')!='reviewed':raise ValueError('切换地图必须已确认')
            boards=validate_boards(field.get('groups',[]));tags={t['id']:t for t in field['tags']}
            anchor=StationaryAnchor(field,timeout=self.get_parameter('max_observation_age_s').value,
                                    max_innovation=self.get_parameter('max_innovation_m').value)
            self.field=field;self.boards=boards;self.tags=tags;self.map_version=raw.get('version');self.map_content=content
            self.history.clear();self.estimate=None;self.covariance=np.eye(3);self.last=None;self.last_tag=0.
            self.formal_origin=False;self.formal_published_at=None;self.formal_preview_at=None
            self.anchor=anchor;self.pending_static.clear();self.last_odometry=None
            self.get_logger().info('定位地图已切换：'+field['id']+'；旧原点已清除，等待当前地图二维码')
        except (OSError,ValueError,KeyError,TypeError) as exc:
            self.get_logger().error('定位地图切换失败：'+str(exc))

    def odometry(self,msg):
        stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        if msg.header.frame_id!='odom' or msg.child_frame_id!='base_link':return
        if not 0<=self.get_clock().now().nanoseconds/1e9-stamp<.25:return
        q=msg.pose.pose.orientation;yaw=math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))
        p=np.array([msg.pose.pose.position.x,msg.pose.pose.position.y,yaw])
        if not np.all(np.isfinite(p)) or abs(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w-1)>.02:return
        if self.history and stamp<=self.history[-1][0]:
            self.history.clear();self.estimate=None;self.last=None;self.last_tag=0.;self.formal_origin=False
            self.formal_preview_at=self.formal_published_at=None
            self.anchor.reset('局部里程计时间回退');self.anchor.local=None;self.pending_static.clear()
        self.history.append((stamp,p.copy()))
        self.last_odometry=copy.deepcopy(msg)
        if self.enable_stationary_anchor:self.anchor.update_local(stamp,p,self.now(),time.monotonic())
        if self.estimate is not None and self.last is not None:
            dt=stamp-self.last[0]
            if not 0<dt<.3:
                self.estimate=None;self.formal_origin=False;self.formal_preview_at=self.formal_published_at=None
            else:
                self.estimate=propagate_pose(self.estimate,self.last[1],p)
                position_noise=self.get_parameter('process_noise_m_sqrt_s').value;angle_noise=self.get_parameter('process_noise_rad_sqrt_s').value
                stopped=(self.enable_stationary_anchor
                         and self.anchor.inputs_ready(self.now(),time.monotonic()))
                self.covariance+=process_covariance_increment(self.last[1],p,dt,position_noise,angle_noise,stopped)
                self.publish(msg,p)
        self.last=(stamp,p)
        if self.enable_stationary_anchor:
            self.drain_static();self.publish_anchor()

    def local_at(self,stamp):
        if len(self.history)<2:return None
        timestamps=[t[0] for t in self.history];i=bisect.bisect_left(timestamps,stamp)
        if i<len(timestamps) and timestamps[i]==stamp:return self.history[i][1].copy()
        if i==0 or i>=len(timestamps):return None
        t0,p0=self.history[i-1];t1,p1=self.history[i]
        if t1-t0>.1:return None
        ratio=(stamp-t0)/(t1-t0);p=p0+(p1-p0)*ratio;p[2]=wrap(p0[2]+wrap(p1[2]-p0[2])*ratio);return p

    def observe(self,msg):
        try:
            data=json.loads(msg.data);stamp=float(data['stamp']);now=self.get_clock().now().nanoseconds/1e9
            if data.get('calibrated') is not True or data.get('synchronized') is not True or data.get('frame')!='base_link' or not 0<=now-stamp<=self.get_parameter('max_observation_age_s').value:return
            local=self.local_at(stamp)
            if local is None or self.last is None:return
            if data.get('representation')=='board-centers':
                tags=validated_board_observations(data['tags'],self.boards,data.get('groupLayouts',[]))
            else:
                tags=collapse_group_observations(data['tags'],self.boards)
            candidates=[]
            for t in tags:
                if t['id'] not in self.tags or t.get('sigma',1.)>.05 or t.get('sigma',0.)<=0:continue
                candidate=absolute_tag_pose(self.tags[t['id']],t)
                # 按观测时间的局部位姿推到最新里程计时间，补偿检测处理延迟。
                candidate=propagate_pose(candidate,local,self.last[1])
                angle_sigma=max(.02,float(t.get('angleSigma',.02)))
                position_sigma=math.hypot(max(.01,float(t['sigma'])),math.hypot(t['x'],t['y'])*angle_sigma)
                candidates.append((candidate,position_sigma,angle_sigma))
            if not candidates:return
            position=np.median(np.array([p for p,_,_ in candidates])[:,:2],axis=0)
            candidates=[(p,s,a) for p,s,a in candidates if np.linalg.norm(p[:2]-position)<.08]
            accepted=False
            for observed,sigma,angle_sigma in candidates:
                if self.estimate is None:self.estimate=observed.copy();self.covariance=np.diag([sigma**2,sigma**2,angle_sigma**2]);accepted=True;continue
                update=correction_update(self.estimate,self.covariance,observed,
                    np.diag([sigma**2,sigma**2,angle_sigma**2]),self.get_parameter('max_innovation_m').value)
                if update is None:continue
                self.estimate,self.covariance=update
                accepted=True
            if accepted:self.last_tag=stamp;self.formal_origin=True
        except (ValueError,KeyError,TypeError,AttributeError):self.get_logger().warning('已拒绝不合法标记观测')

    def publish(self,msg,local):
        if not self.formal_origin:return
        q=Odometry();q.header=copy.deepcopy(msg.header);q.header.frame_id='map';q.child_frame_id='base_link';q.pose.pose.position.x=float(self.estimate[0]);q.pose.pose.position.y=float(self.estimate[1]);q.pose.pose.orientation.z=math.sin(self.estimate[2]/2);q.pose.pose.orientation.w=math.cos(self.estimate[2]/2)
        for i,a in enumerate([0,1,5]):
            for j,b in enumerate([0,1,5]):q.pose.covariance[a*6+b]=float(self.covariance[i,j])
        q.twist=copy.deepcopy(msg.twist);self.preview_pub.publish(q);self.formal_preview_at=time.monotonic()
        # Operator-approved testing uses synchronized QR without claiming measured accuracy.
        if not (self.get_parameter('covariance_calibrated').value or self.get_parameter('synchronized_navigation_confirmed').value):return
        self.pub.publish(q);self.formal_published_at=time.monotonic()
        if not self.get_parameter('publish_tf').value or self.tf is None:return
        offset=wrap(self.estimate[2]-local[2]);c,s=math.cos(offset),math.sin(offset)
        transform=TransformStamped();transform.header=q.header;transform.child_frame_id='odom';transform.transform.translation.x=float(self.estimate[0]-c*local[0]+s*local[1]);transform.transform.translation.y=float(self.estimate[1]-s*local[0]-c*local[1]);transform.transform.rotation.z=math.sin(offset/2);transform.transform.rotation.w=math.cos(offset/2);self.tf.sendTransform(transform)

    def now(self):
        return self.get_clock().now().nanoseconds/1e9

    def feedback(self,msg):
        stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        ctrl=msg.ctrl_fb
        velocities=[ctrl.ctrl_fb_x_linear,ctrl.ctrl_fb_y_linear*.1,msg.steering_ctrl_fb.steering_ctrl_fb_velocity,
                    msg.lf_wheel_fb.lf_wheel_fb_velocity,msg.rf_wheel_fb.rf_wheel_fb_velocity,
                    msg.lr_wheel_fb.lr_wheel_fb_velocity,msg.rr_wheel_fb.rr_wheel_fb_velocity]
        self.anchor.update_feedback(stamp,velocities,math.radians(ctrl.ctrl_fb_z_angular),ctrl.ctrl_fb_gear,self.now(),time.monotonic())
        if not self.anchor.inputs_ready(self.now(),time.monotonic()):self.pending_static.clear()
        self.status()

    def fusion_status(self,msg):
        try:data=json.loads(msg.data)
        except (ValueError,TypeError):data={}
        changed=self.anchor.update_fusion(data,self.now(),time.monotonic())
        if changed:
            self.history.clear();self.last=None;self.last_odometry=None;self.estimate=None;self.last_tag=0.
            self.formal_origin=False;self.formal_preview_at=self.formal_published_at=None;self.pending_static.clear()
        if not self.anchor.inputs_ready(self.now(),time.monotonic()):self.pending_static.clear()
        self.status()

    def observe_static(self,msg):
        if not self.enable_stationary_anchor or not self.anchor.inputs_ready(self.now(),time.monotonic()):return
        try:
            data=json.loads(msg.data)
            if not isinstance(data,dict):return
            self.pending_static.append((data,time.monotonic(),self.anchor.epoch))
            self.drain_static();self.publish_anchor();self.status()
        except (ValueError,KeyError,TypeError,AttributeError):self.get_logger().warning('已拒绝不合法静止二维码观测')

    def drain_static(self):
        now=self.now();monotonic_now=time.monotonic()
        if not self.anchor.inputs_ready(now,monotonic_now):self.pending_static.clear();return
        for _ in range(len(self.pending_static)):
            data,received,epoch=self.pending_static.popleft();stamp=data.get('stamp')
            if (epoch!=self.anchor.epoch or not finite_number(stamp) or not 0<=now-stamp<=self.anchor.timeout
                    or not 0<=monotonic_now-received<=self.anchor.timeout):continue
            local=self.local_at(stamp)
            if local is None:
                if not self.history or stamp>self.history[-1][0]:self.pending_static.append((data,received,epoch))
                continue
            self.anchor.observe(data,local,now,monotonic_now,received=received)

    def publish_anchor(self):
        now=self.now();monotonic_now=time.monotonic()
        if (not self.enable_stationary_anchor or not self.anchor.inputs_valid(now,monotonic_now)
                or self.anchor.estimate is None or self.last_odometry is None):return
        q=Odometry();q.header=copy.deepcopy(self.last_odometry.header);q.header.frame_id='map';q.child_frame_id='base_link'
        q.pose.pose.position.x=float(self.anchor.estimate[0]);q.pose.pose.position.y=float(self.anchor.estimate[1])
        q.pose.pose.orientation.z=math.sin(self.anchor.estimate[2]/2);q.pose.pose.orientation.w=math.cos(self.anchor.estimate[2]/2)
        for index in (2,3,4):q.pose.covariance[index*6+index]=1e6
        for i,a in enumerate([0,1,5]):
            for j,b in enumerate([0,1,5]):q.pose.covariance[a*6+b]=float(self.anchor.covariance[i,j])
        q.twist=copy.deepcopy(self.last_odometry.twist)
        if not self.formal_origin or self.estimate is None:self.preview_pub.publish(q)
        if self.anchor.available(now,monotonic_now):self.static_pub.publish(q)

    def status(self):
        now=self.now();monotonic_now=time.monotonic()
        local_available=self.last_odometry is not None and 0<=now-(self.last_odometry.header.stamp.sec+self.last_odometry.header.stamp.nanosec/1e9)<=.25
        formal=(self.formal_origin and self.formal_published_at is not None and local_available
                and 0<=monotonic_now-self.formal_published_at<=.25)
        synchronized=(self.formal_origin and self.formal_preview_at is not None and local_available
                      and 0<=monotonic_now-self.formal_preview_at<=.25)
        static=self.enable_stationary_anchor and self.anchor.available(now,monotonic_now)
        origin=self.enable_stationary_anchor and self.anchor.inputs_valid(now,monotonic_now) and self.anchor.estimate is not None
        stationary=self.anchor.fresh(self.anchor.feedback,now,monotonic_now) and self.anchor.feedback['quiet']
        state='FORMAL' if formal else 'LOCAL_ONLY' if synchronized else 'STATIC_ANCHORED' if static else 'LOCAL_ONLY' if origin or local_available else 'WAITING'
        source='synchronized_qr' if formal or synchronized else 'stationary_qr'
        if not self.anchor.inputs_ready(now,monotonic_now):self.pending_static.clear()
        calibrated=bool(self.get_parameter('covariance_calibrated').value)
        confirmed=bool(self.get_parameter('synchronized_navigation_confirmed').value)
        reason=('正式同步二维码定位' if calibrated else '同步二维码融合定位（用户确认实机测试；精度尚未实测）') if formal else '同步二维码定位；协方差尚未实测验证' if synchronized else self.anchor.reason
        covariance=np.asarray(self.covariance,dtype=float)
        covariance_valid=(covariance.shape==(3,3) and np.all(np.isfinite(covariance))
                          and np.allclose(covariance,covariance.T,rtol=0.,atol=1e-10)
                          and np.all(np.linalg.eigvalsh(covariance)>0.))
        position_sigma=math.sqrt(max(covariance[0,0],covariance[1,1])) if formal and covariance_valid else None
        position_limit=float(self.get_parameter('max_position_sigma_m').value)
        interval_navigation=bool(self.get_parameter('qr_interval_navigation').value)
        within_limit=bool(position_sigma is not None and 0<position_sigma<=position_limit)
        # Explicit QR-interval operation uses real wheel/IMU propagation. Keep its
        # growing covariance visible; the diagnostic threshold is not a stop line.
        # A missing absolute origin, stale odometry or invalid covariance is never
        # promoted to navigation-ready by this mode.
        navigation_ready=bool(formal and covariance_valid and (interval_navigation or within_limit))
        if formal and not covariance_valid:
            reason='定位协方差无效，等待有效融合位姿'
        elif formal and not within_limit:
            reason=(f'二维码间里程计推算，等待下一定位板校正（估计 {position_sigma*100:.1f} cm）'
                    if interval_navigation else f'位置不确定度 {position_sigma*100:.1f} cm，等待定位板重新校正')
        payload={'stamp':now,'state':state,'source':source,'stationary':bool(stationary),
                 'absoluteHeading':bool(formal or synchronized or origin),'poseAvailable':bool(formal or synchronized or origin),
                 'navigationReady':navigation_ready,'captureTimestampVerified':bool(formal or synchronized),
                 'covarianceCalibrated':calibrated,'approvalBasis':'measurement' if calibrated else 'user_confirmation' if confirmed else None,
                 'mapId':self.field['id'],**({'mapVersion':self.map_version} if getattr(self,'map_version',None) is not None else {}),'localEpoch':self.anchor.epoch,
                 'positionSigmaM':position_sigma,'positionLimitM':position_limit,
                 'qrIntervalNavigation':interval_navigation,'positionWithinDiagnosticLimit':within_limit,
                 'reason':reason}
        self.status_pub.publish(String(data=json.dumps(payload,ensure_ascii=False)))


def main(args=None):
    rclpy.init(args=args);node=GlobalLocalization()
    pid_path=Path(os.environ['QR_LOCALIZATION_PID_FILE']) if os.environ.get('QR_LOCALIZATION_PID_FILE') else None
    if pid_path is not None:pid_path.write_text(str(os.getpid()))
    try:rclpy.spin(node)
    except KeyboardInterrupt:pass
    finally:
        if pid_path is not None and pid_path.exists() and pid_path.read_text().strip()==str(os.getpid()):pid_path.unlink()
        node.destroy_node();rclpy.try_shutdown()
