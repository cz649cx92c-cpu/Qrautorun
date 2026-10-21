"""QR-to-QR execution. Mode changes happen only after measured standstill."""
import copy
import math
import time
from .control import Command, geometry, wrap
from .recorded_trial import limits_for


# Declared to the web bridge so the start API can drop its 423 for this strategy
# instead of assuming the capability exists.
TURN_EXECUTION_AVAILABLE = True
TURN_STRATEGY = 'turn_forward'


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
        if segment.get('strategy') not in (None,'auto','forward','reverse','left','right',TURN_STRATEGY):raise ValueError('未知区间策略')
        if not all(math.isfinite(float(segment[k])) for k in ('bodyYaw','endYaw','wheelAngle')):raise ValueError('区间车头方向无效')
        if not -90<=segment['wheelAngle']<=90:raise ValueError('平移轮角超出范围')
        if any(math.hypot(b['x']-a['x'],b['y']-a['y'])<.001 for a,b in zip(points,points[1:])):raise ValueError('区间控制点重合')
        # The factory only drives straight legs. Reject arcs/bent recorded traces instead of
        # following a curved path; a straight (even crab) diagonal is still a straight line.
        a,b=points[0],points[-1]
        span=math.hypot(b['x']-a['x'],b['y']-a['y'])
        if span>.001:
            for p in points[1:-1]:
                deviation=abs((b['x']-a['x'])*(p['y']-a['y'])-(b['y']-a['y'])*(p['x']-a['x']))/span
                if deviation>.02:raise ValueError('区间必须是直线段，禁止弧线/弯曲线路径')
        if (segment['mode']=='crab')!=(segment.get('direction')=='lateral'):raise ValueError('区间模式与方向不一致')
        if segment['mode']=='4t4d' and segment.get('direction') not in ('forward','reverse'):raise ValueError('4T4D区间方向无效')
        if segment.get('strategy')==TURN_STRATEGY and (segment['mode']!='4t4d' or segment.get('direction')!='forward'):
            raise ValueError('转向后前进策略必须是4T4D前进区间')
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
            if previous['toId']!=segment['fromId'] or math.hypot(p['x']-a['x'],p['y']-a['y'])>.001:raise ValueError('相邻区间不连续')
            # A turn_forward interval is allowed to change the body heading at the
            # shared QR centre; the rotation itself is executed at that standstill.
            if segment.get('strategy')!=TURN_STRATEGY and abs(wrap(previous['endYaw']-segment['bodyYaw']))>.15:raise ValueError('相邻区间车头方向不连续')
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
        self.turn_rate=0.;self.turn_started=0.
        # 转向出口诊断：原地转向期间定位/融合可能重锚，估计位置会跳变；
        # 记录转向开始时的边界横向偏差，用它区分“估计跳变”与“真的没对正”。
        self.turn_start_pose=None;self.turn_start_cross=None
        self.boundary_cross_reference=None;self.boundary_reference_remaining=0.;self.boundary_reference_logged=False
        self.turn_corrections=0

    @property
    def segment(self):return self.segments[self.index]

    @property
    def turning(self):return self.phase in ('TURN','TURN_STOP')

    def turn_required(self):
        """Only an explicitly chosen turn_forward 4T4D interval rotates in place."""
        s=self.segment
        return s.get('strategy')==TURN_STRATEGY and s['mode']=='4t4d'

    def turn_tolerance(self):
        return math.radians(float(self.m.config.get('turn_tolerance_deg',5.)))

    def turn_acceptance_warn(self):
        return math.radians(float(self.m.config.get('turn_acceptance_deg',2.5)))

    def turn_correction_limit(self):
        return int(self.m.config.get('turn_correction_limit',2))

    def turn_exit_window_m(self):
        return float(self.m.config.get('turn_exit_window_m',.30))

    def turn_pose_jump_warn_m(self):
        return float(self.m.config.get('turn_pose_jump_warn_m',.02))

    def prepare_turn_exit(self,pose,jump):
        """原地转向不应平移；若估计位置在转向期间跳变，用转向开始时的边界横向偏差作参考。

        - 跳变在阈值内：完全按绝对横向门限，不做任何放宽。
        - 跳变超阈值且转向开始时横向偏差在到码容差内：记录参考，只在前 window 米内
          用“相对偏差”判定，并要求横向偏差收敛；超过硬限或窗口用尽仍超限则明确 fault。
        - 跳变超阈值但转向开始时横向偏差已超到码容差：明确拒绝前进。
        """
        m=self.m
        if jump<=self.turn_pose_jump_warn_m() or self.turn_start_cross is None:
            return True
        limit=self.BOUNDARY_POSITION_TOLERANCE_M+.01
        if abs(self.turn_start_cross)>limit:
            m.fault(f"转向开始前横向偏差已超到码容差：{self.turn_start_cross*100:.1f} cm（容差 {limit*100:.1f} cm），拒绝前进")
            return False
        self.boundary_cross_reference=self.turn_start_cross
        self.boundary_reference_remaining=self.turn_exit_window_m()
        self.boundary_reference_logged=False
        m.log(f"转向期间位姿估计变化 {jump*100:.1f} cm（原地转不应平移）：以转向开始时边界横向偏差 {self.turn_start_cross*100:.1f} cm 作参考，前进 {self.boundary_reference_remaining*100:.0f} cm 内要求横向误差收敛；若实际发生平移，下一码会纠正")
        return True

    def boundary_heading_tolerance(self):
        return math.radians(float(self.m.config.get('boundary_heading_tolerance_deg',15.)))

    def next_turn_required(self):
        """下一段是否为到码转向段（会在该码中心原地旋转到其 bodyYaw）。"""
        nxt=self.index+1
        if nxt>=len(self.segments):return False
        s=self.segments[nxt]
        return s.get('strategy')==TURN_STRATEGY and s['mode']=='4t4d'

    def start(self,pose):
        s=self.segment;p=s['points'][0]
        if math.hypot(pose.x-p['x'],pose.y-p['y'])>self.m.config.get('start_position_tolerance_m',.05):raise ValueError('请将小车放到首个二维码起点')
        # 车头一致性对照的是第一段的车头朝向，而非“录制时刻”。到码转向段允许任意
        # 初始车头（第一段到达码后会原地转到该段 bodyYaw）。容差取自
        # max_heading_rad（默认 8.6°），可通过 start_heading_tolerance_deg 覆盖。
        if not self.turn_required():
            tolerance=math.radians(float(self.m.config.get('start_heading_tolerance_deg',15.)))
            if abs(wrap(pose.yaw-s['bodyYaw']))>tolerance:raise ValueError(f"车头方向与首段朝向不一致（差 {math.degrees(wrap(pose.yaw-s['bodyYaw'])):.1f}°，容差 {math.degrees(tolerance):.1f}°）；把车头摆正或调低路径起点车头后再开始")
        self.m.running=True;self.m.paused=False;self.m.fired.clear();self.m.completed=[];self.m.wait_until=0.
        self.m.transition('INITIALIZING');self.m.log('按二维码区间执行，共 '+str(self.outbound_count)+' 段；到码停稳后确认下一段模式')

    def zero(self):return Command(mode=self.m.mode,wheel_angle=self.m.target_angle)

    def pause(self):
        self.m.stable=0;self.m.last_sample=None
        if self.phase in ('MOVE','ALIGN','TURN','TURN_STOP'):self.phase='RECOVER_STOP'
        self.turn_rate=0.

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
        self.m.transition('SEGMENT_ALIGN');self.phase='ALIGN';self.align_after_seq=self.last_seq;self.turn_rate=0.
        self.turn_start_pose=None;self.turn_start_cross=None;self.turn_corrections=0
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
                # A turn interval has not rotated yet at its own start boundary;
                # when the NEXT interval is a turn interval it rotates at this QR
                # centre, so the heading at this boundary is irrelevant too.
                skip=(self.phase=='START_STOP' and self.turn_required()) or (self.phase=='END_STOP' and self.next_turn_required())
                tolerance=self.boundary_heading_tolerance()
                if not skip and abs(wrap(pose.yaw-expected_yaw))>tolerance:m.fault(f"二维码边界车头方向与录制不一致（差 {math.degrees(wrap(pose.yaw-expected_yaw)):.1f}°，容差 {math.degrees(tolerance):.1f}°）");return zero
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
                if self.turn_required():
                    # Rotate at this QR centre before the straight interval starts.
                    self.phase='TURN';self.turn_rate=0.;self.turn_started=time.monotonic()
                    self.turn_start_pose=(pose.x,pose.y,pose.yaw)
                    cross_now,_,_,_=geometry(pose,s['points']);self.turn_start_cross=cross_now
                    m.transition('SEGMENT_TURN')
                    m.log(f"到码转向：Q{s['fromId']:03} 处原地旋转到 {math.degrees(s['bodyYaw']):.1f}°，当前 {math.degrees(pose.yaw):.1f}°")
                else:
                    self.phase='MOVE';m.transition('LATERAL_SHIFT' if s['mode']=='crab' else 'REVERSE' if s['direction']=='reverse' else 'FORWARD')
            elif elapsed>timeout:
                m.fault(f"区间换挡或轮角确认超时：模式={s['mode']}，车体档位={fb.get('body_gear')}，转向档位={fb.get('steering_gear')}，目标握手角={m.target_angle:.1f}°，缓存转角={fb.get('steering_angle')}，速度={fb.get('speed')}，反馈序号={fb.get('seq')}")
            return self.zero()
        if self.phase in ('TURN','TURN_STOP'):return self.rotate(pose,fb,observations,dt)
        return self.move_command(pose,fb,observations,dt)

    def move_command(self,pose,fb,observations,dt):
        """Generate the ordinary segment command after all live safety gates."""
        m=self.m;s=self.segment;zero=self.zero()
        if not self.mode_ready(fb):m.fault('区间运行中底盘模式或轮角反馈不匹配');return zero
        points=s['points'];cross,tangent,remaining,end=geometry(pose,points)
        a,b=points[-2:];length=math.hypot(b['x']-a['x'],b['y']-a['y']);past=((pose.x-b['x'])*(b['x']-a['x'])+(pose.y-b['y'])*(b['y']-a['y']))/length
        if remaining<=.03:
            self.boundary_cross_reference=None;self.boundary_reference_remaining=0.
            if end>self.BOUNDARY_POSITION_TOLERANCE_M:
                target_visible=any(o.get('id')==s['toId'] for o in observations)
                yaw_error=wrap(pose.yaw-s['endYaw'])
                m.fault(f"已到区间末端但未靠近目标二维码：目标=Q{s['toId']:03}，距离={end*100:.1f}厘米（容差{self.BOUNDARY_POSITION_TOLERANCE_M*100:.1f}厘米），剩余={remaining*100:.1f}厘米，侧偏={cross*100:.1f}厘米，航向差={math.degrees(yaw_error):.1f}°，目标码可见={target_visible}")
                return zero
            self.phase='END_STOP';self.arrival_seen=any(o.get('id')==s['toId'] for o in observations);m.transition('ROW_END');return zero
        if past>.045 and remaining<.1:m.fault('越过区间终点');return zero
        body_target=s['bodyYaw'] if s['mode']=='crab' else wrap(tangent+(math.pi if s['direction']=='reverse' else 0))
        angle=wrap(pose.yaw-body_target)
        heading_limit=(min(.10,m.config['max_heading_rad']) if s['mode']=='crab' else m.config['max_heading_rad'])
        cross_limit=m.config['max_cross_track_m'];hard_limit=cross_limit+self.BOUNDARY_POSITION_TOLERANCE_M
        effective_cross=cross
        if self.boundary_reference_remaining>0:
            if abs(cross)<=cross_limit:
                m.log(f"横向偏差已回到绝对门限：{cross*100:.1f} cm ≤ {cross_limit*100:.1f} cm")
                self.boundary_cross_reference=None;self.boundary_reference_remaining=0.
            elif abs(cross)<=hard_limit and self.boundary_cross_reference is not None:
                reference=self.boundary_cross_reference
                # 只有估计跳变方向与边界偏差同向时才扣除；反向则可能是真的偏到另一边，
                # 不做放宽，直接按绝对偏差判定。
                effective_cross=abs(cross)-abs(reference) if (cross>0)==(reference>0) else abs(cross)
                if not self.boundary_reference_logged:
                    m.log(f"转向出口容差生效：绝对横向偏差 {cross*100:.1f} cm（硬限 {hard_limit*100:.1f} cm），转向开始时边界偏差 {reference*100:.1f} cm，折算后 {effective_cross*100:.1f} cm；限速前进并要求 {self.boundary_reference_remaining*100:.0f} cm 内收敛")
                    self.boundary_reference_logged=True
            else:
                m.fault(f"转向后横向偏差 {cross*100:.1f} cm 超过转向出口硬限 {hard_limit*100:.1f} cm，停车等待人工纠正（目标角 {math.degrees(body_target):.1f}°，当前 {math.degrees(pose.yaw):.1f}°）")
                return zero
        if abs(effective_cross)>cross_limit or abs(angle)>heading_limit:
            m.fault(f"区间路径侧偏或车头方向超限：横向偏差 {cross*100:.1f} cm（折算 {effective_cross*100:.1f}，门限 {cross_limit*100:.1f}），航向差 {math.degrees(angle):.1f}°（门限 {math.degrees(heading_limit):.1f}°），目标角 {math.degrees(body_target):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，区间 {self.index+1}；若为 turn_forward，请核对转向残差与位姿来源")
            return zero
        if s['mode']=='crab':
            target=m.task['lateralSpeed']*(.5 if abs(effective_cross)>.025 else 1.)
            trial=limits_for(s.get('executionProfile'))
            speed=m.tracker.limit(min(target,trial['maxSpeed']) if trial else target,remaining,dt,trial['acceleration'] if trial else None,trial['braking'] if trial else None)
            travel=math.atan2(points[-1]['y']-points[0]['y'],points[-1]['x']-points[0]['x'])-s['bodyYaw']
            return Command(mode='crab',vx=speed*math.cos(travel),vy=speed*math.sin(travel),wheel_angle=m.target_angle)
        target=m.task['reverseSpeed'] if s['direction']=='reverse' else m.task['forwardSpeed']
        scale=max(1.,abs(effective_cross)/.025,abs(angle)/heading_limit);target*=max(.25,1./scale)
        if self.boundary_reference_remaining>0:target=min(target,float(m.config.get('turn_exit_speed_mps',.04)))
        command=(m.tracker.reverse(pose,points,target,dt,profile=s.get('executionProfile'))[0]
                 if s['direction']=='reverse' else
                 m.tracker.forward(pose,points,target,dt,profile=s.get('executionProfile'))[0])
        # A 4T4D interval only ever translates along the body x axis. Forcing the
        # mode/vy here means a lateral body velocity can never be passed off as
        # forward progress, whatever the tracker returns.
        command.mode='4t4d';command.vy=0.
        if self.boundary_reference_remaining>0:
            self.boundary_reference_remaining-=abs(command.vx)*dt
            if self.boundary_reference_remaining<=0:
                if abs(cross)>cross_limit:
                    m.fault(f"转向出口容差前进已用尽仍横向超限：横向偏差 {cross*100:.1f} cm（门限 {cross_limit*100:.1f} cm），航向差 {math.degrees(angle):.1f}°，目标角 {math.degrees(body_target):.1f}°，当前 {math.degrees(pose.yaw):.1f}°；停车等待人工纠正")
                    return zero
                self.boundary_cross_reference=None;self.boundary_reference_logged=False
        return command

    def rotate(self,pose,fb,observations,dt):
        """In-place turn at the QR centre, under the same live gates as driving.

        Feedback freshness, finite pose and every runtime condition were already
        validated at the top of tick(); losing any of them faults the mission and
        the zero command is sent instead of further rotation.
        """
        m=self.m;s=self.segment;zero=self.zero()
        error=wrap(s['bodyYaw']-pose.yaw)
        tolerance=self.turn_tolerance()
        timeout=float(m.config.get('turn_timeout_s',15.))
        max_rate=float(m.config.get('turn_yaw_rate_max_radps',.3))
        if self.phase=='TURN':
            if abs(error)<=tolerance:
                self.turn_rate=0.;self.phase='TURN_STOP';m.transition('SEGMENT_TURN')
                m.log(f"到码转向到位：残差 {math.degrees(error):.2f}°，容差 {math.degrees(tolerance):.1f}°，等待停稳确认")
                return zero
            if time.monotonic()-self.turn_started>timeout:
                self.turn_rate=0.
                m.fault(f"到码转向超时（超过 {timeout:.0f} 秒）：目标 {math.degrees(s['bodyYaw']):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，残差 {math.degrees(error):.1f}°，容差 {math.degrees(tolerance):.1f}°；未达到目标角，禁止前进")
                return zero
            # 方向反了（目标与当前相差近 180°）时明确报错，不靠超时静默放行。
            if time.monotonic()-self.turn_started>3. and abs(error)>math.radians(100.):
                self.turn_rate=0.
                m.fault(f"到码转向方向异常：目标 {math.degrees(s['bodyYaw']):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，残差 {math.degrees(error):.1f}°（超过 100°，疑似转向方向相反），已停车")
                return zero
            gain=float(m.config.get('turn_yaw_gain',1.5))
            acceleration=float(m.config.get('turn_yaw_accel_radps2',.6))
            # Bounded proportional law with a minimum rate so the chassis actually
            # starts moving, then a slew limit so it eases in and out.
            desired=math.copysign(min(max_rate,max(.06,abs(error)*gain)),error)
            previous=self.turn_rate
            self.turn_rate=max(previous-acceleration*dt,min(previous+acceleration*dt,desired))
            self.turn_rate=max(-max_rate,min(max_rate,self.turn_rate))
            return Command(mode=m.mode,yaw_rate=self.turn_rate)
        # TURN_STOP: confirm measured standstill, then re-check the heading.
        if m.stable_feedback(fb):
            if abs(error)>tolerance:
                m.log(f"转向停稳后残差 {math.degrees(error):.2f}°，继续微调")
                self.phase='TURN';self.turn_rate=0.
                return zero
            if abs(error)>self.turn_acceptance_warn() and self.turn_corrections<self.turn_correction_limit():
                # 5° 容差能停下但转角实际不足 90°（现场实测残差 -4.89°）；先做有限次微调，
                # 把残差压到期望值以内，再进入前进。目标角始终是控制目标，不是“实际真值”。
                self.turn_corrections+=1;self.phase='TURN';self.turn_rate=0.
                m.log(f"转角修正：残差 {math.degrees(error):.2f}° 超过期望 {math.degrees(self.turn_acceptance_warn()):.1f}°，第 {self.turn_corrections} 次微调（目标 {math.degrees(s['bodyYaw']):.1f}°，实测 {math.degrees(pose.yaw):.1f}°）")
                return zero
            jump=0. if self.turn_start_pose is None else math.hypot(pose.x-self.turn_start_pose[0],pose.y-self.turn_start_pose[1])
            m.log(f"到码转向完成：目标 {math.degrees(s['bodyYaw']):.1f}°，实测 {math.degrees(pose.yaw):.1f}°，残差 {math.degrees(error):.2f}°，容差 {math.degrees(tolerance):.1f}°；转向期间位姿变化 {jump*100:.1f} cm")
            if abs(error)>self.turn_acceptance_warn():
                m.log(f"注意：转角残差 {math.degrees(error):.2f}° 仍超过期望 {math.degrees(self.turn_acceptance_warn()):.1f}°（微调上限已用尽，仍在容差 {math.degrees(tolerance):.1f}° 内）；目标角不是实际真值，已按实测角记录")
            if not self.prepare_turn_exit(pose,jump):return zero
            self.phase='MOVE';m.transition('FORWARD')
            m.log('到码转向完成并已停稳，开始前进')
            # Produce the first forward command in the same cycle as TURN_STOP
            # completion. The regular mode, boundary, cross-track, heading and
            # speed gates remain authoritative; a failed gate still returns zero.
            return self.move_command(pose,fb,observations,dt)
        elif time.monotonic()-self.turn_started>timeout:
            m.fault(f"到码转向后停稳确认超时：目标 {math.degrees(s['bodyYaw']):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，残差 {math.degrees(error):.1f}°")
        return zero
