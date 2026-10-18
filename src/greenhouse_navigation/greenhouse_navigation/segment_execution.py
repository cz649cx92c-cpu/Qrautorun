"""QR-to-QR execution. Mode changes happen only after measured standstill."""
import copy
import math
import time
from .control import Command, geometry, wrap
from .recorded_trial import limits_for


def inverse(segment):
    result=copy.deepcopy(segment)
    result['points'].reverse()
    result['fromId'],result['toId']=segment['toId'],segment['fromId']
    result['bodyYaw'],result['endYaw']=segment['endYaw'],segment['bodyYaw']
    if segment['mode']=='4t4d':result['direction']='reverse' if segment['direction']=='forward' else 'forward'
    # Same wheel plane, reversed body velocity; no 180 degree body turn.
    return result


def validate_segments(segments):
    if not isinstance(segments,list) or not 1<=len(segments)<=100:raise ValueError('缺少有效二维码区间')
    previous=None
    for segment in segments:
        profile=segment.get('executionProfile')
        if profile not in (None,'recorded_slow_trial'):raise ValueError('未知区间执行配置')
        trial=limits_for(profile)
        curvature_limit=trial['maxCurvature'] if trial else .6
        points=segment.get('points',[])
        if segment.get('mode') not in ('4t4d','crab') or len(points)<2:raise ValueError('区间模式或路径无效')
        if not all(math.isfinite(float(p[k])) for p in points for k in ('x','y')):raise ValueError('区间坐标无效')
        if not all(math.isfinite(float(segment[k])) for k in ('bodyYaw','endYaw','wheelAngle')):raise ValueError('区间车头方向无效')
        if not -90<=segment['wheelAngle']<=90:raise ValueError('平移轮角超出范围')
        if any(math.hypot(b['x']-a['x'],b['y']-a['y'])<.001 for a,b in zip(points,points[1:])):raise ValueError('区间控制点重合')
        if (segment['mode']=='crab')!=(segment.get('direction')=='lateral'):raise ValueError('区间模式与方向不一致')
        if segment['mode']=='4t4d' and segment.get('direction') not in ('forward','reverse'):raise ValueError('4T4D区间方向无效')
        a,b=points[0],points[-1]
        if math.hypot(b['x']-a['x'],b['y']-a['y'])<.08:raise ValueError('区间端点距离不足8厘米')
        tangent=math.atan2(b['y']-a['y'],b['x']-a['x'])
        if segment['mode']=='crab':
            if abs(wrap(segment['endYaw']-segment['bodyYaw']))>.10:raise ValueError('平移区间不能改变车头方向')
            if any(abs(-(p['x']-a['x'])*math.sin(tangent)+(p['y']-a['y'])*math.cos(tangent))>.01 for p in points):raise ValueError('平移区间必须是直线')
            angle=wrap(tangent-segment['bodyYaw']);angle=wrap(angle+math.pi) if abs(angle)>math.pi/2+.00001 else angle
            # +/-90 describe the same wheel plane.
            if abs(math.sin(angle-math.radians(segment['wheelAngle'])))>.03:raise ValueError('平移轮角与路径方向不一致')
        else:
            offset=math.pi if segment['direction']=='reverse' else 0.
            tangents=[math.atan2(q['y']-p['y'],q['x']-p['x']) for p,q in zip(points,points[1:])]
            if abs(wrap(segment['bodyYaw']-tangents[0]-offset))>.10 or abs(wrap(segment['endYaw']-tangents[-1]-offset))>.15:raise ValueError('4T4D车头方向与路径不一致')
            for i in range(1,len(tangents)):
                p0,p1,p2=points[i-1:i+2]
                span=(math.hypot(p1['x']-p0['x'],p1['y']-p0['y'])+math.hypot(p2['x']-p1['x'],p2['y']-p1['y']))/2
                if abs(wrap(tangents[i]-tangents[i-1]))/span>curvature_limit:raise ValueError('4T4D区间曲率超限')
        if previous:
            p=previous['points'][-1]
            if previous['toId']!=segment['fromId'] or math.hypot(p['x']-a['x'],p['y']-a['y'])>.001 or abs(wrap(previous['endYaw']-segment['bodyYaw']))>.15:raise ValueError('相邻区间不连续')
        previous=segment


class SegmentExecutor:
    # Approach and stopped QR confirmation use the same endpoint acceptance radius.
    BOUNDARY_POSITION_TOLERANCE_M = .06

    def __init__(self,mission,segments):
        validate_segments(segments)
        self.m=mission;self.segments=copy.deepcopy(segments);self.index=0
        self.outbound_count=len(segments)
        if mission.task.get('returnToStart',False):self.segments += [inverse(s) for s in reversed(segments)]
        self.phase='START_STOP';self.last_seq=None;self.arrival_seen=False;self.align_after_seq=None

    @property
    def segment(self):return self.segments[self.index]

    def start(self,pose):
        s=self.segment;p=s['points'][0]
        if math.hypot(pose.x-p['x'],pose.y-p['y'])>self.m.config.get('start_position_tolerance_m',.05):raise ValueError('请将小车放到首个二维码起点')
        if abs(wrap(pose.yaw-s['bodyYaw']))>.10:raise ValueError('车头方向与首段录制方向不一致')
        self.m.running=True;self.m.paused=False;self.m.fired.clear();self.m.completed=[];self.m.wait_until=0.
        self.m.transition('INITIALIZING');self.m.log('按二维码区间执行，共 '+str(self.outbound_count)+' 段；到码停稳后确认下一段模式')

    def zero(self):return Command(mode=self.m.mode,wheel_angle=self.m.target_angle)

    def pause(self):
        self.m.stable=0;self.m.last_sample=None
        if self.phase in ('MOVE','ALIGN'):self.phase='RECOVER_STOP'

    def resume(self):
        self.m.stable=0;self.m.last_sample=None;self.m.entered=time.monotonic();self.m.tracker.reset()
        if self.phase=='RECOVER_STOP':self.m.transition('ROW_END')

    def feedback_valid(self,fb):
        stamp=fb.get('aggregate_received');seq=fb.get('seq');speed=fb.get('speed')
        finite=lambda v:isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v)
        if not finite(stamp) or not 0<=time.monotonic()-stamp<self.m.config['feedback_timeout_s'] or type(seq) is not int or not finite(speed) or speed<0:return False
        if self.last_seq is not None and seq<self.last_seq:return False
        self.last_seq=seq
        return True

    def align(self):
        s=self.segment;self.m.mode=s['mode'];self.m.target_angle=s['wheelAngle'] if s['mode']=='crab' and not self.m.body_velocity_crab() else 0.
        self.m.transition('SEGMENT_ALIGN');self.phase='ALIGN';self.align_after_seq=self.last_seq
        self.m.log(f"区间 {self.index+1}：Q{s['fromId']:03} → Q{s['toId']:03}，"+('平移' if s['mode']=='crab' else '4T4D '+s['direction']))
        return self.zero()

    def mode_ready(self,fb,stationary=False):
        s=self.segment
        if s['mode']=='crab':
            if self.m.body_velocity_crab():return self.m.body_crab_feedback_ready(fb)
            # Feedback decoding follows the existing mature controller; command mode
            # remains crab (body command 8), never a new user-selectable gear.
            return (fb.get('body_gear') in (7,8) and fb.get('steering_gear') in (7,8)
                    and self.m.canonical_steering_ready(fb,self.m.target_angle))
        return fb.get('body_gear') in (5,6) and fb.get('steering_gear') in (5,6)

    def tick(self,pose,fb,observations,dt):
        m=self.m;s=self.segment;zero=self.zero()
        if not self.feedback_valid(fb):m.fault('区间执行：底盘反馈缺失、过期或序号异常');return zero
        if pose is None or not all(math.isfinite(v) for v in (pose.x,pose.y,pose.yaw)):m.fault('区间执行：实时位姿无效');return zero
        if m.paused:return zero
        elapsed=time.monotonic()-m.entered;timeout=m.config['mode_timeout_s']
        if self.phase in ('START_STOP','END_STOP','RECOVER_STOP'):
            # Keep the previous mode while decelerating, including a pause recovery.
            target=s['points'][-1] if self.phase=='END_STOP' else s['points'][0]
            tag=s['toId'] if self.phase=='END_STOP' else s['fromId']
            near=math.hypot(pose.x-target['x'],pose.y-target['y'])<=self.BOUNDARY_POSITION_TOLERANCE_M
            self.arrival_seen=near and any(o.get('id')==tag for o in observations)
            stopped=m.stable_feedback(fb)
            if stopped and self.phase=='RECOVER_STOP':return self.align()
            if stopped and self.arrival_seen:
                expected_yaw=s['endYaw'] if self.phase=='END_STOP' else s['bodyYaw']
                if abs(wrap(pose.yaw-expected_yaw))>.10:m.fault('二维码边界车头方向与录制不一致');return zero
                if self.phase=='START_STOP':return self.align()
                wait=m.task['endWaitSeconds'] if self.index+1 in (self.outbound_count,len(self.segments)) else .2
                if elapsed<wait:return zero
                if self.index+1==len(self.segments):
                    m.completed=[m.row['id']];m.running=False;m.transition('FINISHED');m.log('全部二维码区间已完成并停稳');return zero
                self.index+=1;self.arrival_seen=False;return self.align()
            if elapsed>max(timeout,m.task['endWaitSeconds']+timeout):m.fault('二维码边界停车超时或未确认目标二维码')
            return zero
        if self.phase=='ALIGN':
            gears=(7,8) if s['mode']=='crab' else (5,6)
            ready=self.mode_ready(fb) and (self.align_after_seq is None or fb['seq']>self.align_after_seq)
            if not ready:m.stable=0;m.last_sample=None
            confirmation_angle=None if s['mode']=='crab' and m.body_velocity_crab() else m.target_angle
            if ready and m.stable_feedback(fb,confirmation_angle,gears):
                self.phase='MOVE';m.transition('LATERAL_SHIFT' if s['mode']=='crab' else 'REVERSE' if s['direction']=='reverse' else 'FORWARD')
            elif elapsed>timeout:
                m.fault(f"区间换挡或轮角确认超时：模式={s['mode']}，车体档位={fb.get('body_gear')}，转向档位={fb.get('steering_gear')}，目标握手角={m.target_angle:.1f}°，缓存转角={fb.get('steering_angle')}，速度={fb.get('speed')}，反馈序号={fb.get('seq')}")
            return self.zero()
        if not self.mode_ready(fb):m.fault('区间运行中底盘模式或轮角反馈不匹配');return zero
        points=s['points'];cross,tangent,remaining,end=geometry(pose,points)
        a,b=points[-2:];length=math.hypot(b['x']-a['x'],b['y']-a['y']);past=((pose.x-b['x'])*(b['x']-a['x'])+(pose.y-b['y'])*(b['y']-a['y']))/length
        if remaining<=.03:
            if end>self.BOUNDARY_POSITION_TOLERANCE_M:
                target_visible=any(o.get('id')==s['toId'] for o in observations)
                yaw_error=wrap(pose.yaw-s['endYaw'])
                m.fault(f"已到区间末端但未靠近目标二维码：目标=Q{s['toId']:03}，距离={end*100:.1f}厘米（容差{self.BOUNDARY_POSITION_TOLERANCE_M*100:.1f}厘米），剩余={remaining*100:.1f}厘米，侧偏={cross*100:.1f}厘米，航向差={math.degrees(yaw_error):.1f}°，目标码可见={target_visible}")
                return zero
            self.phase='END_STOP';self.arrival_seen=any(o.get('id')==s['toId'] for o in observations);m.transition('ROW_END');return zero
        if past>.045 and remaining<.1:m.fault('越过区间终点');return zero
        body_target=s['bodyYaw'] if s['mode']=='crab' else wrap(tangent+(math.pi if s['direction']=='reverse' else 0))
        angle=wrap(pose.yaw-body_target)
        if abs(cross)>m.config['max_cross_track_m'] or abs(angle)>(min(.10,m.config['max_heading_rad']) if s['mode']=='crab' else m.config['max_heading_rad']):
            m.fault('区间路径侧偏或车头方向超限');return zero
        if s['mode']=='crab':
            target=m.task['lateralSpeed']*(.5 if abs(cross)>.025 else 1.)
            trial=limits_for(s.get('executionProfile'))
            speed=m.tracker.limit(min(target,trial['maxSpeed']) if trial else target,remaining,dt,trial['acceleration'] if trial else None,trial['braking'] if trial else None)
            travel=math.atan2(points[-1]['y']-points[0]['y'],points[-1]['x']-points[0]['x'])-s['bodyYaw']
            return Command(mode='crab',vx=speed*math.cos(travel),vy=speed*math.sin(travel),wheel_angle=m.target_angle)
        target=m.task['reverseSpeed'] if s['direction']=='reverse' else m.task['forwardSpeed']
        scale=max(1.,abs(cross)/.025,abs(angle)/m.config['max_heading_rad']);target*=max(.25,1./scale)
        command= m.tracker.reverse(pose,points,target,dt,profile=s.get('executionProfile'))[0] if s['direction']=='reverse' else m.tracker.forward(pose,points,target,dt,profile=s.get('executionProfile'))[0]
        return command
