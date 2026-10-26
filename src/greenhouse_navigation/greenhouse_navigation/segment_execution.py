"""QR-to-QR execution. Mode changes happen only after measured standstill."""
import copy
import math
import time
from .control import Command, Pose, geometry, wrap
from .dr_anchor import anchor_event_ok, mission_scope, propagate_anchor
from .recorded_trial import limits_for
from .start_gate import segment_start_check


# Declared to the web bridge so the start API can drop its 423 for this strategy
# instead of assuming the capability exists.
TURN_EXECUTION_AVAILABLE = True
TURN_STRATEGY = 'turn_forward'


def _finite(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)


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


def feedback_lateral_velocity(fb):
    """返回横向速度 SI（m/s）；来源不明返回 None，绝不把缺失伪装成有效 0。

    既有成熟底盘协议里 ctrl_fb_y_linear 为 /100 单位（SI 的 10 倍），
    只有确认走 existing_chassis 适配时才乘 0.1；node 若已给出 vy_mps 则直接采用，
    不重复缩放。其他适配源未验证缩放，返回 None。
    """
    value = (fb or {}).get('vy_mps')
    if _finite(value):
        return float(value)
    raw = (fb or {}).get('vy_raw')
    if _finite(raw) and (fb or {}).get('angle_source') == 'existing_chassis':
        return float(raw) * .1
    return None


YAW_LOCAL_MAX_GAP_S = .3


def local_yaw_step(state, loco, now_mono, max_gap=YAW_LOCAL_MAX_GAP_S):
    """局部 EKF 连续 yaw 增量；身份(epoch/source)先于重复判定，失效即重置基准。

    规则：invalid → (0,False,reason) 并清空 last_local_yaw/stamp（禁止跨失效区间补积）；
    stamp 相同且 epoch 相同 → (0,True,'duplicate')；stamp 相同但 epoch 不同 → invalid。
    """
    if not isinstance(loco, dict):
        return 0., False, 'noLocalOdom'
    yaw = loco.get('yaw'); stamp = loco.get('stamp'); recv = loco.get('recvMono'); epoch = loco.get('epoch')
    if not _finite(yaw) or not _finite(stamp) or not _finite(recv):
        state['last_local_yaw']=None; state['last_local_stamp']=None
        return 0., False, 'localOdomInvalid'
    age = now_mono - recv
    if age < -.05 or age > max_gap:
        state['last_local_yaw']=None; state['last_local_stamp']=None
        return 0., False, 'stale'
    last_epoch = state.get('local_epoch')
    if epoch is not None and last_epoch is not None and epoch != last_epoch:
        state['last_local_yaw']=None; state['last_local_stamp']=None
        state['local_epoch']=epoch
        return 0., False, 'epochChanged'
    last_stamp = state.get('last_local_stamp')
    if _finite(last_stamp) and stamp < last_stamp:
        state['last_local_yaw']=None; state['last_local_stamp']=None
        return 0., False, 'stampReversed'
    if _finite(last_stamp) and stamp == last_stamp:
        return 0., True, 'duplicate'
    last_yaw = state.get('last_local_yaw')
    dyaw = 0. if not _finite(last_yaw) else wrap(float(yaw) - last_yaw)
    state['last_local_yaw'] = float(yaw)
    state['last_local_stamp'] = float(stamp)
    if epoch is not None:
        state['local_epoch'] = epoch
    return dyaw, True, 'ok'


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
        # 结构化转向/出口诊断（写入 executionDiagnostics）。
        self.turn_start_pose=None;self.turn_start_cross=None
        self.turn_info={'status':'idle','targetDeg':None,'beforeYawDeg':None,'completionYawDeg':None,
                        'residualDeg':None,'acceptanceDeg':None,'correctionToleranceDeg':None,
                        'poseJumpM':None,'boundaryCrossStartM':None,'corrections':[]}
        self.exit_info={'status':'idle','startCrossM':None,'endCrossM':None,'headingErrorDeg':None,
                        'targetTagId':None,'windowM':None,'converged':False,'centeringUsed':False,
                        'reason':''}
        self.centering_info={}
        # 每个二维码边界一次对中的结构化记录；align() 不清空，便于跨段回看。
        self.centering_history=[]
        # 轮速+IMU 航向的区间内独立推算（dead reckoning）状态与修正历史。
        self.dr_state=None;self.dr_history=[]
        self.correction_active=False;self.correction_started=0.;self.correction_start_yaw=0.
        self.correction_index=0;self.correction_wz_max=0.
        self.turn_done=False;self.centering=None
        # Last normal cross-track sample before any suspected localization jump.
        self.last_gate_pose=None;self.last_gate_cross=None
        self.localization_jump={};self.jump_state=None

    @property
    def segment(self):return self.segments[self.index]

    @property
    def turning(self):return self.phase in ('TURN','TURN_STOP')

    def turn_required(self):
        """Only an explicitly chosen turn_forward 4T4D interval rotates in place."""
        s=self.segment
        return (s.get('strategy')==TURN_STRATEGY and s['mode']=='4t4d' and not self.turn_done)

    def turn_tolerance(self):
        """Outer safety tolerance (timeout / final safety gate)."""
        return math.radians(float(self.m.config.get('turn_tolerance_deg',5.)))

    def turn_acceptance(self):
        """Normal turn completion residual target; may come from read-only calibration."""
        return math.radians(float(self.m.config.get('turn_acceptance_deg',2.5)))

    def correction_tolerance(self):
        """Stricter residual target for corrective micro-turns."""
        return math.radians(float(self.m.config.get('turn_correction_tolerance_deg',1.0)))

    def correction_limit(self):
        return int(self.m.config.get('turn_correction_limit',3))

    def correction_min_s(self):
        return float(self.m.config.get('turn_correction_min_s',.2))

    def correction_min_delta(self):
        return math.radians(float(self.m.config.get('turn_correction_min_delta_deg',.2)))

    def boundary_heading_tolerance(self):
        return math.radians(float(self.m.config.get('boundary_heading_tolerance_deg',15.)))

    def next_turn_required(self):
        """下一段是否为到码转向段（会在该码中心原地旋转到其 bodyYaw）。"""
        nxt=self.index+1
        if nxt>=len(self.segments):return False
        s=self.segments[nxt]
        return s.get('strategy')==TURN_STRATEGY and s['mode']=='4t4d'

    def start(self,pose):
        s=self.segment
        # Start offset is measured along/cross the first straight leg, not plain
        # Euclidean distance: being a few cm ahead of the QR along the route with
        # the body laterally centred is a valid start; lateral/heading gates stay.
        check=segment_start_check(pose,s,self.m.config)
        if not check['ok']:raise ValueError(check['message'])
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
        if self.phase in ('MOVE','ALIGN','TURN','TURN_STOP','TURN_RECENTER','CENTER_ALIGN','CENTER_MOVE','CENTER_STOP'):self.phase='RECOVER_STOP'
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
        self.turn_start_pose=None;self.turn_start_cross=None;self.turn_done=False
        self.correction_active=False;self.correction_index=0;self.centering=None;self.recenter_started=0.
        self.last_gate_pose=None;self.last_gate_cross=None;self.localization_jump={};self.jump_state=None
        # 每段进入 MOVE 时重新建立 dead-reckoning 锚点。
        self.dr_state=None
        self.turn_info={'status':'idle','targetDeg':None,'beforeYawDeg':None,'completionYawDeg':None,
                        'residualDeg':None,'acceptanceDeg':math.degrees(self.turn_acceptance()),
                        'correctionToleranceDeg':math.degrees(self.correction_tolerance()),
                        'poseJumpM':None,'boundaryCrossStartM':None,'corrections':[]}
        self.centering_info={}
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
                # 每个二维码边界都先把「下一段」的横向偏差收敛，再进入下一段；
                # 不是只在原地转向出口做对中。
                # 新运动语义：到码不做自动横移对中。残余在 5cm 硬门内直接进入下一计划动作
                # （原地 TURN / TURN_RECENTER / 4T4D 行进转向纠偏），超过硬门才停车。
                # 这里不再调用 prepare_boundary_center 的 crab 分支；保留其 fault 语义不可用，
                # 因为其判据完全围绕横移运动设计。
                if self.index+1<len(self.segments):
                    nxt=self.segments[self.index+1]
                    if nxt.get('mode')=='4t4d':
                        nx_cross,_,_,_=geometry(pose,nxt['points'])
                        self.exit_info['boundaryCrossM']=round(nx_cross,4)
                        hard=float(m.config['max_cross_track_m'])
                        if abs(nx_cross)>hard:
                            m.fault(f"到码后下一段横向偏差 {nx_cross*100:.1f} cm 超过硬门 {hard*100:.1f} cm（不做自动横移）；停车")
                            return zero
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
                    self.correction_active=False;self.correction_index=0;self.correction_wz_max=0.
                    self.turn_info={'status':'turning','targetDeg':math.degrees(s['bodyYaw']),
                                    'beforeYawDeg':math.degrees(pose.yaw),'completionYawDeg':None,
                                    'residualDeg':None,'acceptanceDeg':math.degrees(self.turn_acceptance()),
                                    'correctionToleranceDeg':math.degrees(self.correction_tolerance()),
                                    'poseJumpM':None,'boundaryCrossStartM':cross_now,'corrections':[]}
                    self.exit_info={'status':'pending','startCrossM':None,'endCrossM':None,
                                    'headingErrorDeg':None,'targetTagId':s['fromId'],'windowM':None,
                                    'converged':False,'centeringUsed':False,'reason':''}
                    m.transition('SEGMENT_TURN')
                    m.log(f"到码转向：Q{s['fromId']:03} 处原地旋转到 {math.degrees(s['bodyYaw']):.1f}°，当前 {math.degrees(pose.yaw):.1f}°")
                else:
                    self.phase='MOVE';m.transition('LATERAL_SHIFT' if s['mode']=='crab' else 'REVERSE' if s['direction']=='reverse' else 'FORWARD')
            elif elapsed>timeout:
                m.fault(f"区间换挡或轮角确认超时：模式={s['mode']}，车体档位={fb.get('body_gear')}，转向档位={fb.get('steering_gear')}，目标握手角={m.target_angle:.1f}°，缓存转角={fb.get('steering_angle')}，速度={fb.get('speed')}，反馈序号={fb.get('seq')}")
            return self.zero()
        if self.phase in ('TURN','TURN_STOP','TURN_RECENTER'):return self.rotate(pose,fb,observations,dt)
        if self.phase in ('CENTER_ALIGN','CENTER_MOVE','CENTER_STOP'):return self.center(pose,fb,observations,dt)
        return self.move_command(pose,fb,observations,dt)

    # ---- degraded QR localization-jump guard (turn_forward forward only) ----
    def jump_scope(self):
        s=self.segment
        return (s.get('strategy')==TURN_STRATEGY and s['mode']=='4t4d'
                and s.get('direction')=='forward' and self.phase in ('MOVE','CENTER_MOVE'))

    @staticmethod
    def _pose_snapshot(pose):
        if isinstance(pose,dict):
            values=(pose.get('x'),pose.get('y'),pose.get('yaw'))
        else:
            values=(getattr(pose,'x',None),getattr(pose,'y',None),getattr(pose,'yaw',None))
        if not all(_finite(value) for value in values):return None
        return {'x':round(float(values[0]),6),'y':round(float(values[1]),6),'yaw':round(float(values[2]),6)}

    def observation_quality(self, observations):
        """Worst QR board quality in the current observation batch.

        The detector/collapse layer provides groupId, visibleCount and sigma;
        total members comes from the selected map's board definition. Missing
        quality fields stay explicit as ``unknown`` and never enable mitigation.
        """
        config=self.m.config
        groups={group.get('id'):group for group in ((self.m.field or {}).get('groups') or [])
                if isinstance(group,dict) and group.get('id')}
        low_ratio=float(config.get('localization_jump_low_ratio',.5))
        sigma_low=float(config.get('localization_jump_sigma_m',.02))
        high_ratio=float(config.get('localization_jump_high_ratio',.75))
        high_sigma=float(config.get('localization_jump_high_sigma_m',.02))
        candidates=[]
        for observation in observations or []:
            if not isinstance(observation,dict):continue
            group_id=observation.get('groupId')
            if not group_id:continue
            group=groups.get(group_id)
            members=(group or {}).get('members') if isinstance(group,dict) else None
            total=len(members) if isinstance(members,list) and members else None
            visible=observation.get('visibleCount');sigma=observation.get('sigma')
            if total is None or not _finite(visible) or not _finite(sigma):
                candidates.append({'quality':'unknown','tagId':observation.get('id'),'groupId':group_id,
                                   'visible':visible,'total':total,'ratio':None,'uncertaintyM':sigma,
                                   'degraded':None,'lowQuality':False,'highQuality':False})
                continue
            ratio=float(visible)/total;degraded=visible<total
            low=ratio<=low_ratio or sigma>=sigma_low
            high=(not degraded) and ratio>=high_ratio and sigma<=high_sigma
            candidates.append({'quality':'low' if low else 'high' if high else 'medium',
                               'tagId':observation.get('id'),'groupId':group_id,
                               'visible':int(visible),'total':total,'ratio':ratio,
                               'uncertaintyM':float(sigma),'degraded':degraded,
                               'lowQuality':low,'highQuality':high})
        if not candidates:
            return {'quality':'unknown','tagId':None,'groupId':None,'visible':None,'total':None,
                    'ratio':None,'uncertaintyM':None,'degraded':None,'lowQuality':False,'highQuality':False}
        known=[item for item in candidates if item['quality']!='unknown']
        low=[item for item in known if item['lowQuality']]
        if low:return min(low,key=lambda item:(item['ratio'],-item['uncertaintyM']))
        if known and all(item['highQuality'] for item in known):return known[0]
        return known[0] if known else candidates[0]

    def _jump_diag_update(self, pose, cross, quality, decision='suspected'):
        state=self.jump_state
        if state is None:return
        loc=self.m.localization if isinstance(getattr(self.m,'localization',None),dict) else {}
        now_pose=self._pose_snapshot(pose)
        self.localization_jump.update({
            'status':'active' if decision not in ('recovered',) else 'recovered',
            'decision':decision,
            'beforePose':state['before_pose'],'afterPose':now_pose,
            'crossBeforeM':round(state['trusted_cross'],4),'crossAfterM':round(cross,4),
            'deltaCrossM':round(cross-state['trusted_cross'],4),
            'tagId':quality.get('tagId'),'groupId':quality.get('groupId'),
            'visible':quality.get('visible'),'total':quality.get('total'),
            'uncertaintyM':quality.get('uncertaintyM'),'degraded':quality.get('degraded'),
            'quality':quality.get('quality'),
            'epoch':loc.get('localEpoch'),
            'timestamp':loc.get('stamp'),
            'elapsedS':round(state['elapsed'],3),'travelM':round(state['travel'],4),
        })
        if self.exit_info is not None:self.exit_info['localizationJump']=copy.deepcopy(self.localization_jump)
        if self.centering_info:self.centering_info['localizationJump']=copy.deepcopy(self.localization_jump)

    def _jump_fault(self, code, text):
        decision={'localization_jump_low_quality':'fault_low_quality',
                  'localization_jump_timeout':'fault_timeout',
                  'localization_jump_travel_limit':'fault_travel_limit',
                  'localization_jump_hard_cross':'fault_hard_cross',
                  'localization_jump_real_cross':'fault_real_cross',
                  'localization_jump_chassis_vy':'fault_chassis_vy',
                  'localization_jump_forward_velocity':'fault_forward_velocity',
                  'localization_jump_heading':'fault_heading',
                  'localization_jump_quality_unknown':'fault_quality_unknown'}.get(code,code)
        self.localization_jump['decision']=decision;self.localization_jump['status']='fault'
        self.localization_jump['finalDecision']='fault';self.localization_jump['reasonCode']=code
        self.localization_jump['reason']=text
        if self.exit_info is not None:self.exit_info['localizationJump']=copy.deepcopy(self.localization_jump)
        if self.centering_info:self.centering_info['localizationJump']=copy.deepcopy(self.localization_jump)
        self.m.log('定位跳变确认失败：'+text)
        self.m.fault(text)

    def _start_localization_jump(self, before_pose, pose, cross_before, cross_after, quality, delta):
        self.jump_state={'elapsed':0.,'travel':0.,'trusted_cross':cross_before,
                         'before_pose':self._pose_snapshot(before_pose),
                         'predicted_pose':self._pose_snapshot(before_pose) or self._pose_snapshot(pose),
                         'high_count':0,'low_quality_s':0.}
        self.localization_jump={'status':'suspected','decision':'suspected','finalDecision':'pending',
                                'reasonCode':'localization_jump_suspected',
                                'beforePose':self._pose_snapshot(before_pose),'afterPose':self._pose_snapshot(pose),
                                'crossBeforeM':round(cross_before,4),'crossAfterM':round(cross_after,4),
                                'deltaCrossM':round(delta,4),'tagId':quality.get('tagId'),
                                'groupId':quality.get('groupId'),'visible':quality.get('visible'),
                                'total':quality.get('total'),'uncertaintyM':quality.get('uncertaintyM'),
                                'degraded':quality.get('degraded'),'quality':quality.get('quality'),
                                'epoch':(self.m.localization or {}).get('localEpoch'),
                                'timestamp':(self.m.localization or {}).get('stamp'),
                                'elapsedS':0.,'travelM':0.}
        if self.exit_info is not None:self.exit_info['localizationJump']=copy.deepcopy(self.localization_jump)
        if self.centering_info:self.centering_info['localizationJump']=copy.deepcopy(self.localization_jump)
        self.m.log(f"定位跳变疑似：cross {cross_before*100:.1f}→{cross_after*100:.1f} cm，"
                   f"tag={quality.get('tagId')} 可见 {quality.get('visible')}/{quality.get('total')}，"
                   f"σ={quality.get('uncertaintyM')}，暂缓 FAULT 并等待连续观测确认")

    def guard_localization_jump(self, pose, fb, observations, dt, cross):
        """Return (effective_cross, jump_active).

        A single degraded/low-visibility QR update may move the fused pose and
        cross-track faster than the chassis could physically move. Keep the last
        trusted cross for a bounded, low-speed confirmation window; hard cross,
        chassis lateral velocity, heading, quality loss and time/distance limits
        still fault. High-quality observations always use the normal 5 cm gate.
        """
        if not self.jump_scope():return cross,False
        m=self.m;config=m.config
        quality=self.observation_quality(observations)
        vx=fb.get('vx',fb.get('speed',0.));vy=feedback_lateral_velocity(fb)
        heading_error=wrap(pose.yaw-self.segment['bodyYaw'])
        heading_limit=float(config['max_heading_rad'])
        cross_limit=float(config['max_cross_track_m'])
        hard_cross=float(config.get('localization_jump_hard_cross_m',.08))
        max_vy=float(config.get('localization_jump_max_vy_mps',.01))
        state=self.jump_state
        if state is None:
            previous=self.last_gate_pose;previous_cross=self.last_gate_cross
            if (previous is not None and previous_cross is not None and quality['quality']=='low'
                    and _finite(vx) and vx>=-.005 and vy is not None and abs(vy)<=max_vy
                    and _finite(heading_error) and abs(heading_error)<=heading_limit
                    and abs(cross)<=hard_cross):
                delta=cross-previous_cross
                step=max(float(config.get('localization_jump_step_m',.005)),abs(vx)*dt*.5+.002)
                if abs(delta)>step:
                    self._start_localization_jump(previous,pose,previous_cross,cross,quality,delta)
                    return self.jump_state['trusted_cross'],True
            self.last_gate_pose=self._pose_snapshot(pose);self.last_gate_cross=cross
            return cross,False
        state['elapsed']+=dt
        if quality['quality']=='low':state['low_quality_s']+=dt
        self._jump_diag_update(pose,cross,quality,'waiting_confirmation')
        if quality['quality']=='unknown':
            self._jump_fault('localization_jump_quality_unknown',
                             f"低质量观测后定位质量字段缺失，无法确认横向误差：横向 {cross*100:.1f} cm")
            return cross,False
        if abs(cross)>hard_cross:
            self._jump_fault('localization_jump_hard_cross',
                             f"定位跳变横向超过硬上限：{cross*100:.1f} cm（硬上限 {hard_cross*100:.1f} cm）")
            return cross,False
        if vy is None or abs(vy)>max_vy:
            self._jump_fault('localization_jump_chassis_vy',
                             f"定位跳变期间底盘横向速度异常：vy={vy} m/s（SI，允许 {max_vy:.2f}）")
            return cross,False
        if not _finite(vx) or vx<-.005:
            self._jump_fault('localization_jump_forward_velocity',
                             f"定位跳变期间前进速度异常：vx={vx}")
            return cross,False
        if not _finite(heading_error) or abs(heading_error)>heading_limit:
            self._jump_fault('localization_jump_heading',
                             f"定位跳变期间航向异常：{math.degrees(heading_error):.1f}°（允许 {math.degrees(heading_limit):.1f}°）")
            return cross,False
        if quality['quality']=='high':
            if self.phase in ('CENTER_ALIGN','CENTER_MOVE','CENTER_STOP'):
                # A valid centering may legitimately start beyond the normal 5 cm
                # straight-line gate; high-quality observation confirms the pose, so
                # clear the jump guard and let the centering limits decide.
                self.localization_jump['decision']='recovered';self.localization_jump['status']='recovered'
                self.localization_jump['finalDecision']='pass'
                self.jump_state=None;self.last_gate_pose=self._pose_snapshot(pose);self.last_gate_cross=cross
                if self.exit_info is not None:self.exit_info['localizationJump']=copy.deepcopy(self.localization_jump)
                m.log(f"对中期间定位跳变已由高质量观测确认结束：横向 {cross*100:.1f} cm，继续对中")
                return cross,False
            state['high_count']+=1
            if state['high_count']>=int(config.get('localization_jump_recover_samples',2)):
                if abs(cross)<=cross_limit:
                    self.localization_jump['decision']='recovered';self.localization_jump['status']='recovered'
                    self.localization_jump['finalDecision']='pass'
                    self.jump_state=None;self.last_gate_pose=self._pose_snapshot(pose);self.last_gate_cross=cross
                    if self.exit_info is not None:self.exit_info['localizationJump']=copy.deepcopy(self.localization_jump)
                    m.log(f"定位跳变已由高质量观测确认结束：横向 {cross*100:.1f} cm 在门限内，恢复前进")
                    return cross,False
                self._jump_fault('localization_jump_real_cross',
                                 f"高质量观测确认真实横向超限：{cross*100:.1f} cm（门限 {cross_limit*100:.1f} cm）")
                return cross,False
        else:
            state['high_count']=0
        if state['low_quality_s']>float(config.get('localization_jump_low_quality_s',1.5)):
            self._jump_fault('localization_jump_low_quality',
                             f"连续低质量二维码观测未恢复：横向 {cross*100:.1f} cm，tag={quality.get('tagId')} "
                             f"可见 {quality.get('visible')}/{quality.get('total')}")
            return cross,False
        if state['elapsed']>float(config.get('localization_jump_confirm_s',2.)):
            self._jump_fault('localization_jump_timeout',
                             f"定位跳变确认超时 {state['elapsed']:.1f} s：横向 {cross*100:.1f} cm，"
                             f"tag={quality.get('tagId')} 可见 {quality.get('visible')}/{quality.get('total')}")
            return cross,False
        if state['travel']>float(config.get('localization_jump_confirm_m',.08)):
            self._jump_fault('localization_jump_travel_limit',
                             f"定位跳变确认距离超限 {state['travel']*100:.1f} cm：横向 {cross*100:.1f} cm")
            return cross,False
        return state['trusted_cross'],True

    def localization_jump_command(self, dt):
        state=self.jump_state
        speed=float(self.m.config.get('localization_jump_speed_mps',.03))
        speed=max(0.,min(speed,float(self.m.task.get('forwardSpeed',.08))))
        predicted=state.get('predicted_pose') if state else None
        if predicted:
            heading=float(self.segment['bodyYaw'])
            predicted['x']=round(predicted['x']+speed*math.cos(heading)*dt,6)
            predicted['y']=round(predicted['y']+speed*math.sin(heading)*dt,6)
        if state:
            state['travel']+=speed*dt
            self.localization_jump['travelM']=round(state['travel'],4)
        return Command(mode='4t4d',vx=speed,vy=0.,yaw_rate=0.)

    # ---- dead reckoning: wheel vx/vy + chassis(IMU) yaw between QR anchors ----
    def dr_enabled(self):
        return bool(self.m.config.get('dr_correction_enabled',True))

    def dr_target(self):
        """控制目标：预测横向偏差收敛到该值以内（精度目标，非安全门）。"""
        return abs(float(self.m.config.get('dr_cross_target_m',.008)))

    def dr_trigger(self):
        return abs(float(self.m.config.get('dr_correction_trigger_m',self.dr_target())))

    def dr_correction_limit(self):
        return int(self.m.config.get('dr_correction_limit',2))

    def dr_correction_travel(self):
        return abs(float(self.m.config.get('dr_correction_travel_m',.05)))

    def dr_min_remaining(self):
        return abs(float(self.m.config.get('dr_correction_min_remaining_m',.15)))

    def dr_min_stale_s(self):
        return abs(float(self.m.config.get('dr_correction_min_stale_s',.25)))

    def dr_rebase_limit(self):
        return abs(float(self.m.config.get('dr_rebase_residual_limit_m',.05)))

    def dr_rebase_max_sigma(self):
        return abs(float(self.m.config.get('dr_rebase_max_sigma_m',
                                           self.m.config.get('max_position_sigma_m',.03))))

    def dr_divergence_frames(self):
        return max(1,int(self.m.config.get('dr_divergence_frames',3)))

    def _dr_snapshot(self,pose):
        return {'x':round(pose.x,4),'y':round(pose.y,4),'yaw':round(pose.yaw,6)}

    def dr_start(self,pose,fb,cross):
        """MOVE 进入时建立锚点。stamp<=0（无时间戳的桩/离线）保持被动，只记录。"""
        loc=self.m.localization if isinstance(getattr(self.m,'localization',None),dict) else {}
        self.dr_state={'segment_index':self.index,'anchor_stamp':0.,
                       'anchor_cross':cross,'anchor_pose':None,'anchor_valid':False,
                       'last_correction_id':None,'needs_anchor':False,'frozen':False,
                       'anchor_epoch':loc.get('localEpoch'),
                       'pred':{'x':pose.x,'y':pose.y,'yaw':pose.yaw},
                       'last_yaw_deg':fb.get('yaw_deg') if _finite(fb.get('yaw_deg')) else None,
                       'local_epoch':(self.m.localization or {}).get('localEpoch') if isinstance(getattr(self.m,'localization',None),dict) else None,
                       'last_stamp':float(getattr(pose,'stamp',0.) or 0.),
                       'last_local_yaw':None,'last_local_stamp':None,
                       'yawSourceOk':True,'yawSourceReason':'init','vySourceOk':True,'mechanicalCorrections':0,
                       'last_qr_source':None,'last_qr_qualified_source':None,
                       'qr_qualified_mono':None,'last_rebase_source':None,
                       'last_qr_recv_mono':None,'qr_skipped_reason':None,
                       'stamp_time':time.monotonic(),'corrections':0,'travel':0.,
                       'divergence_pending':0,'last_decision':'anchor','crossM':cross,
                       'last_residual':None}

    def dr_integrate(self,fb,dt,loco=None):
        """轮速 vx/vy(SI) + 局部 EKF 连续 yaw 增量积分；来源失效时不瞎积分。"""
        state=self.dr_state
        if state is None or dt<=0:return
        # 底盘原始角速度仅保留诊断，绝不再当绝对角做差
        if _finite(fb.get('yaw_deg')):state['last_chassis_yaw_rate_deg']=fb.get('yaw_deg')
        dyaw,yaw_ok,yaw_reason=local_yaw_step(state,loco,time.monotonic())
        state['yawSourceOk']=bool(yaw_ok)
        state['yawSourceReason']=yaw_reason
        if not yaw_ok:
            # 源失效：冻结 xy/yaw，禁止继续用旧航向积分；要求新合格锚才能恢复纠偏
            state['frozen']=True;state['needs_anchor']=True
            return
        if state.get('frozen'):
            # 恢复首帧只重建局部基准，不补积失联区间
            state['frozen']=False;state['needs_anchor']=True
            return
        vx=fb.get('vx') if _finite(fb.get('vx')) else 0.
        vy=feedback_lateral_velocity(fb)
        state['vySourceOk']=vy is not None
        lateral=0. if vy is None else vy   # 无有效来源时不加横向位移，但不标记为有效
        yaw=state['pred']['yaw']
        state['pred']['x']+= (vx*math.cos(yaw)-lateral*math.sin(yaw))*dt
        state['pred']['y']+= (vx*math.sin(yaw)+lateral*math.cos(yaw))*dt
        state['pred']['yaw']=wrap(yaw+dyaw)

    def dr_try_rebase(self,pose,fb,observations,pose_cross,remaining,anchor=None,loco=None):
        """只用 localization 真正接受 QR 校正的事件锚；事件须同 scope/版本/epoch/新鲜/未重复，
        且能用同源局部里程把后验位姿传播到当前局部里程时刻；不拿任意当前全局 pose 冒充。"""
        m=self.m;state=self.dr_state
        if not isinstance(anchor,dict):
            return False
        now=time.monotonic()
        loc=m.localization if isinstance(getattr(m,'localization',None),dict) else {}
        ok,why=anchor_event_ok(anchor,mission_scope(m),now,max_age=.5,
                               current_epoch=loc.get('localEpoch'),
                               last_correction_id=state.get('last_correction_id'))
        if not ok:
            state['anchor_reject_reason']=why
            return False
        pose_now,prop_ok,prop_why=propagate_anchor(anchor,loco)
        if not prop_ok:
            state['anchor_reject_reason']=prop_why
            return False
        state['anchor_reject_reason']=None
        entry={'stamp':round(float(anchor['sourceStamp']),3),'qrSourceStamp':round(float(anchor['sourceStamp']),3),
               'correctionId':anchor.get('correctionId'),'kind':anchor.get('kind'),
               'eventRecvMono':round(float(anchor['recvMono']),3),'mapId':anchor.get('mapId'),
               'mapVersion':anchor.get('mapVersion'),'epoch':anchor.get('localEpoch'),
               'anchorPose':[round(v,5) for v in pose_now],'predictedPose':dict(state['pred']),
               'poseCrossM':round(pose_cross,4),'sigmaM':anchor.get('sigma'),
               'anchorSource':'accepted_qr_event+local_odom'}
        if not state.get('anchor_valid') or state.get('needs_anchor'):
            state['pred']={'x':pose_now[0],'y':pose_now[1],'yaw':pose_now[2]}
            state['anchor_pose']=tuple(pose_now);state['anchor_valid']=True
            state['anchor_stamp']=float(anchor['sourceStamp']);state['anchor_cross']=pose_cross
            state['crossM']=pose_cross;state['needs_anchor']=False;state['divergence_pending']=0
            state['last_correction_id']=anchor.get('correctionId')
            state['qr_qualified_mono']=float(anchor['recvMono'])
            state['last_decision']='anchored'
            entry['decision']='anchored'
            self.dr_history.append(entry);self.dr_history=self.dr_history[-8:]
            return True
        res=math.hypot(pose_now[0]-state['pred']['x'],pose_now[1]-state['pred']['y'])
        entry['rebaseResidualM']=round(res,4)
        if res>self.dr_rebase_limit():
            state['divergence_pending']+=1
            entry.update({'decision':'diverged','frames':state['divergence_pending'],
                          'reason':'accepted QR 锚与预测差异超硬限'})
            self.dr_history.append(entry);self.dr_history=self.dr_history[-8:]
            if state['divergence_pending']>=self.dr_divergence_frames():
                m.fault(f"dead-reckoning 与二维码绝对定位差异连续 {state['divergence_pending']} 帧超过 {self.dr_rebase_limit()*100:.1f} cm（本次残差 {res*100:+.1f} cm，correctionId={anchor.get('correctionId')}）：预测发散，停车")
            state['last_decision']='diverged'
            return True
        state['pred']={'x':pose_now[0],'y':pose_now[1],'yaw':pose_now[2]}
        state['anchor_pose']=tuple(pose_now);state['anchor_stamp']=float(anchor['sourceStamp'])
        state['anchor_cross']=pose_cross;state['crossM']=pose_cross
        state['corrections']+=1;state['divergence_pending']=0;state['last_decision']='qr_track'
        state['last_correction_id']=anchor.get('correctionId')
        state['qr_qualified_mono']=float(anchor['recvMono'])
        state['last_rebase_source']=float(anchor['sourceStamp'])
        state['last_residual']=entry
        entry.update({'decision':'rebased','correctionIndex':state['corrections']})
        self.dr_history.append(entry);self.dr_history=self.dr_history[-8:]
        return True

    def dr_update(self,pose,fb,observations,dt,pose_cross,remaining):
        """每个 MOVE 周期：积分、QR 校正判定、提前纠偏决策。返回 (effective_cross, action)。

        action=='zero' 表示本周期已切换到对中/已 FAULT，调用方直接返回零指令。
        """
        m=self.m
        if self.phase!='MOVE':
            return pose_cross,None
        if self.dr_state is None or self.dr_state.get('segment_index')!=self.index:
            self.dr_start(pose,fb,pose_cross)
        if not self.dr_enabled():
            # 显式禁用：建立被动状态供诊断，不做任何纠偏。
            self.dr_state['last_decision']='disabled'
            return pose_cross,None
        state=self.dr_state
        loc=(m.localization if isinstance(getattr(m,'localization',None),dict) else {})
        loco=loc.get('localOdom');anchor=loc.get('qrAnchor');raw=loc.get('qrRaw')
        self.dr_integrate(fb,dt,loco)
        pred=Pose(state['pred']['x'],state['pred']['y'],state['pred']['yaw'])
        dr_cross,_,_,_=geometry(pred,self.segment['points'])
        state['crossM']=dr_cross;state['predictedPose']=dict(state['pred'])
        now=time.monotonic()
        mono=state.get('qr_qualified_mono')
        stale_s=now-float(mono) if _finite(mono) else now-float(state['stamp_time'])
        state['staleS']=round(stale_s,3)
        state['qrLastQualifiedAgeS']=round(stale_s,3)
        state['qrSourceStamp']=state.get('last_qr_qualified_source') or state.get('anchor_stamp')
        rebased=False
        if isinstance(anchor,dict):
            rebased=self.dr_try_rebase(pose,fb,observations,pose_cross,remaining,anchor=anchor,loco=loco)
            mono=state.get('qr_qualified_mono')
            stale_s=now-float(mono) if _finite(mono) else now-float(state['stamp_time'])
            state['staleS']=round(stale_s,3);state['qrLastQualifiedAgeS']=round(stale_s,3)
        raw_fresh=isinstance(raw,dict) and _finite(raw.get('recvMono')) and 0<=now-float(raw['recvMono'])<=.4
        accepted_recent=_finite(state.get('qr_qualified_mono')) and now-float(state['qr_qualified_mono'])<=.4
        state['qrRawFresh']=bool(raw_fresh)
        if raw_fresh and not accepted_recent:
            # 板可见但观测未被接受（低质/scope 等原因）：不得当作真实无码去主动纠偏
            state['last_decision']='qr_visible_rejected'
            return pose_cross,None
        if not state.get('anchor_valid'):
            state['last_decision']='no_anchor'
            return pose_cross,None
        if state.get('needs_anchor'):
            state['last_decision']='needs_anchor'
            return pose_cross,None
        if m.state=='FAULT':return pose_cross,'zero'
        if self.centering is not None:
            state['last_decision']='correcting'
            return pose_cross,None
        if not state.get('yawSourceOk',True):
            state['last_decision']='yaw_source_invalid'
            return pose_cross,None
        # try_rebase 已给出明确决策（skip_low_quality/rebased/diverged...）时保留之
        if not rebased:
            state['last_decision']='predict' if stale_s>self.dr_min_stale_s() else 'qr_track'
        trigger=self.dr_trigger();hard=float(m.config['max_cross_track_m'])
        budget=(int(state.get('mechanicalCorrections',0))<self.dr_correction_limit()
                and state['travel']<self.dr_correction_travel())
        s=self.segment
        if (s.get('mode')=='4t4d' and s.get('direction')=='forward'
                and abs(dr_cross)>=trigger and budget and remaining>=self.dr_min_remaining()
                and stale_s>=self.dr_min_stale_s()):
            if abs(dr_cross)>hard:
                m.fault(f"DR 预测横向偏差 {dr_cross*100:+.1f} cm 超过硬上限 {hard*100:.1f} cm（二维码间丢失校正），停车")
                return pose_cross,'zero'
            # 新运动语义：行驶中只允许 4T4D 左右行进转向，不切 crab、不平移、不原地转、不倒退。
            # 转向由下方 Tracker 的既有航向/横向负反馈闭环消费（预测 cross 作为唯一码间参考）。
            state['mechanicalCorrections']=int(state.get('mechanicalCorrections',0))+1
            state['last_decision']='steer_4t4d'
            state['steerBiasM']=round(dr_cross,4)
            state['steeringActive']=True
            self.exit_info.update({'status':'steering_4t4d','centeringUsed':False,
                                   'steerCrossM':round(dr_cross,4)})
            m.log(f"DR 4T4D 转向纠偏：预测横向 {dr_cross*100:+.1f} cm（QR 失联 {stale_s:.1f}s），保持 vy=0，仅左右行进转向")
            return pose_cross,None
        return pose_cross,None

    def move_command(self,pose,fb,observations,dt):
        """Generate the ordinary segment command after all live safety gates."""
        m=self.m;s=self.segment;zero=self.zero()
        if not self.mode_ready(fb):
            try:
                from .diag_log import get as _diag_get
                _diag_get('control').write({'type':'modeMismatchDetail','segment':[s['fromId'],s['toId']],
                    'phase':self.phase,'bodyGear':fb.get('body_gear'),'steerGear':fb.get('steering_gear'),
                    'anglesRaw':fb.get('angles_raw'),'steerAngle':fb.get('steering_angle'),
                    'seq':fb.get('seq'),'aggregateReceived':fb.get('aggregate_received'),
                    'vx':fb.get('vx'),'recv':round(time.time(),6),
                    'action':'protectiveStopRootCauseUnfixed'})
            except Exception:
                pass
            m.fault('区间运行中底盘模式或轮角反馈不匹配');return zero
        points=s['points'];cross,tangent,remaining,end=geometry(pose,points)
        # 二维码间的连续推算与提前纠偏：预测横向偏差不等 END_STOP 才处理。
        cross,dr_action=self.dr_update(pose,fb,observations,dt,cross,remaining)
        if dr_action=='zero':return zero
        a,b=points[-2:];length=math.hypot(b['x']-a['x'],b['y']-a['y']);past=((pose.x-b['x'])*(b['x']-a['x'])+(pose.y-b['y'])*(b['y']-a['y']))/length
        if remaining<=.03:
            if end>self.BOUNDARY_POSITION_TOLERANCE_M:
                target_visible=any(o.get('id')==s['toId'] for o in observations)
                yaw_error=wrap(pose.yaw-s['endYaw'])
                m.fault(f"已到区间末端但未靠近目标二维码：目标=Q{s['toId']:03}，距离={end*100:.1f}厘米（容差{self.BOUNDARY_POSITION_TOLERANCE_M*100:.1f}厘米），剩余={remaining*100:.1f}厘米，侧偏={cross*100:.1f}厘米，航向差={math.degrees(yaw_error):.1f}°，目标码可见={target_visible}")
                return zero
            self.phase='END_STOP';self.arrival_seen=any(o.get('id')==s['toId'] for o in observations);m.transition('ROW_END')
            self.exit_info['endCrossM']=cross;self.exit_info['status']='completed'
            return zero
        if past>.045 and remaining<.1:m.fault('越过区间终点');return zero
        body_target=s['bodyYaw'] if s['mode']=='crab' else wrap(tangent+(math.pi if s['direction']=='reverse' else 0))
        angle=wrap(pose.yaw-body_target)
        heading_limit=(min(.10,m.config['max_heading_rad']) if s['mode']=='crab' else m.config['max_heading_rad'])
        cross_limit=m.config['max_cross_track_m']
        if self.jump_scope():
            cross,jump_active=self.guard_localization_jump(pose,fb,observations,dt,cross)
            self.exit_info['endCrossM']=cross
            if m.state=='FAULT':return zero
            if jump_active:
                self.exit_info['localizationJump']=copy.deepcopy(self.localization_jump)
                return self.localization_jump_command(dt)
        self.exit_info['endCrossM']=cross;self.exit_info['headingErrorDeg']=math.degrees(angle)
        if abs(cross)>cross_limit or abs(angle)>heading_limit:
            if self.jump_scope():
                quality=self.observation_quality(observations)
                if quality['quality']=='unknown':
                    self.localization_jump={'status':'fault','decision':'fault_quality_unknown',
                                            'finalDecision':'fault','reasonCode':'localization_jump_quality_unknown',
                                            'quality':'unknown','tagId':quality.get('tagId'),
                                            'groupId':quality.get('groupId'),'visible':quality.get('visible'),
                                            'total':quality.get('total'),'uncertaintyM':quality.get('uncertaintyM'),
                                            'crossAfterM':round(cross,4),
                                            'epoch':(self.m.localization or {}).get('localEpoch'),
                                            'timestamp':(self.m.localization or {}).get('stamp'),
                                            'reason':'定位质量字段缺失，按保守策略停车'}
                    self.exit_info['localizationJump']=copy.deepcopy(self.localization_jump)
                    m.fault(f"定位质量字段缺失，按保守策略停车：横向 {cross*100:.1f} cm，航向差 {math.degrees(angle):.1f}°（无法确认是否为低质量单码跳变）")
                    return zero
            m.fault(f"区间路径侧偏或车头方向超限：横向偏差 {cross*100:.1f} cm（门限 {cross_limit*100:.1f}），航向差 {math.degrees(angle):.1f}°（门限 {math.degrees(heading_limit):.1f}°），目标角 {math.degrees(body_target):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，区间 {self.index+1}")
            return zero
        if s['mode']=='crab':
            target=m.task['lateralSpeed']*(.5 if abs(cross)>.025 else 1.)
            trial=limits_for(s.get('executionProfile'))
            speed=m.tracker.limit(min(target,trial['maxSpeed']) if trial else target,remaining,dt,trial['acceleration'] if trial else None,trial['braking'] if trial else None)
            travel=math.atan2(points[-1]['y']-points[0]['y'],points[-1]['x']-points[0]['x'])-s['bodyYaw']
            return Command(mode='crab',vx=speed*math.cos(travel),vy=speed*math.sin(travel),wheel_angle=m.target_angle)
        target=m.task['reverseSpeed'] if s['direction']=='reverse' else m.task['forwardSpeed']
        scale=max(1.,abs(cross)/.025,abs(angle)/heading_limit);target*=max(.25,1./scale)
        st=self.dr_state
        cross_override=None
        if (s['direction']=='forward' and st is not None and st.get('anchor_valid')
                and float(st.get('staleS',0.))>=self.dr_min_stale_s() and _finite(st.get('steerBiasM'))):
            # QR 失联期间：DR 预测 cross 是唯一横向反馈来源；位姿/剩余距离仍用实测融合位姿。
            cross_override=float(st['steerBiasM'])
            self.exit_info['steeringSource']='predicted_cross_4t4d'
            self.exit_info['steerCrossM']=round(cross_override,4)
        else:
            self.exit_info['steeringSource']='fused_4t4d'
        command=(m.tracker.reverse(pose,points,target,dt,profile=s.get('executionProfile'))[0]
                 if s['direction']=='reverse' else
                 m.tracker.forward(pose,points,target,dt,profile=s.get('executionProfile'),
                                   cross_override=cross_override)[0])
        # A 4T4D interval only ever translates along the body x axis. Forcing the
        # mode/vy here means a lateral body velocity can never be passed off as
        # forward progress, whatever the tracker returns.
        command.mode='4t4d';command.vy=0.
        return command

    def rotate(self,pose,fb,observations,dt):
        """In-place turn at the QR centre under live safety gates.

        Normal completion uses the calibration-derived acceptance target; corrective
        micro-turns use a stricter tolerance, require a real non-zero yaw command and
        a measurable yaw change before they can be counted as successful.
        """
        m=self.m;s=self.segment;zero=self.zero()
        if self.phase=='TURN_RECENTER':
            return self.recenter_wheels(pose,fb,observations,dt)
        error=wrap(s['bodyYaw']-pose.yaw)
        acceptance=self.turn_acceptance()
        correction_tolerance=self.correction_tolerance()
        now=time.monotonic()
        timeout=float(m.config.get('turn_timeout_s',15.))
        max_rate=float(m.config.get('turn_yaw_rate_max_radps',.3))
        if self.phase=='TURN':
            tolerance=correction_tolerance if self.correction_active else acceptance
            if self.correction_active:
                elapsed=now-self.correction_started
                moved=abs(wrap(pose.yaw-self.correction_start_yaw))
                if elapsed>=self.correction_min_s() and moved<self.correction_min_delta():
                    m.fault(f"转角修正未产生姿态变化：目标 {math.degrees(s['bodyYaw']):.1f}°，修正前 {math.degrees(self.correction_start_yaw):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，已发最大wz {self.correction_wz_max:.3f} rad/s，持续 {elapsed:.2f} s；目标角不是实际真值")
                    return zero
                if elapsed>float(m.config.get('turn_correction_timeout_s',3.)):
                    m.fault(f"转角修正超时：目标 {math.degrees(s['bodyYaw']):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，残差 {math.degrees(error):.1f}°，修正容差 {math.degrees(correction_tolerance):.1f}°")
                    return zero
            if abs(error)<=tolerance:
                self.turn_rate=0.;self.phase='TURN_STOP';m.transition('SEGMENT_TURN')
                m.log(f"到码转向到位（{'修正' if self.correction_active else '正常'}）：目标 {math.degrees(s['bodyYaw']):.1f}°，实测 {math.degrees(pose.yaw):.1f}°，残差 {math.degrees(error):.2f}°，容差 {math.degrees(tolerance):.1f}°，等待停稳确认")
                return zero
            if not self.correction_active:
                if now-self.turn_started>timeout:
                    self.turn_rate=0.
                    m.fault(f"到码转向超时（超过 {timeout:.0f} 秒）：目标 {math.degrees(s['bodyYaw']):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，残差 {math.degrees(error):.1f}°，完成容差 {math.degrees(acceptance):.1f}°；未达到目标角，禁止前进")
                    return zero
                if now-self.turn_started>3. and abs(error)>math.radians(100.):
                    self.turn_rate=0.
                    m.fault(f"到码转向方向异常：目标 {math.degrees(s['bodyYaw']):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，残差 {math.degrees(error):.1f}°（超过 100°，疑似转向方向相反），已停车")
                    return zero
            gain=float(m.config.get('turn_yaw_gain',1.5))
            acceleration=float(m.config.get('turn_yaw_accel_radps2',.6))
            desired=math.copysign(min(max_rate,max(.06,abs(error)*gain)),error)
            previous=self.turn_rate
            self.turn_rate=max(previous-acceleration*dt,min(previous+acceleration*dt,desired))
            self.turn_rate=max(-max_rate,min(max_rate,self.turn_rate))
            if self.correction_active:self.correction_wz_max=max(self.correction_wz_max,abs(self.turn_rate))
            return Command(mode=m.mode,yaw_rate=self.turn_rate)
        # TURN_STOP: confirm measured standstill, then re-check the heading.
        if not m.stable_feedback(fb):
            if now-self.turn_started>timeout:
                m.fault(f"到码转向后停稳确认超时：目标 {math.degrees(s['bodyYaw']):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，残差 {math.degrees(error):.1f}°")
            return zero
        if abs(error)>acceptance:
            if self.correction_active:
                delta=math.degrees(wrap(pose.yaw-self.correction_start_yaw))
                duration=now-self.correction_started
                success=abs(error)<=correction_tolerance
                if abs(delta)<math.degrees(self.correction_min_delta()):
                    m.fault(f"转角修正未产生姿态变化：目标 {math.degrees(s['bodyYaw']):.1f}°，修正前 {math.degrees(self.correction_start_yaw):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，Δyaw {delta:.2f}°，已发最大wz {self.correction_wz_max:.3f} rad/s；不得记为修正成功")
                    return zero
                self.turn_info['corrections'].append({'index':self.correction_index,'beforeYawDeg':round(math.degrees(self.correction_start_yaw),3),'afterYawDeg':round(math.degrees(pose.yaw),3),'deltaDeg':round(delta,3),'wzMaxRadps':round(self.correction_wz_max,4),'durationS':round(duration,3),'success':success})
                self.correction_active=False
            if self.correction_index<self.correction_limit():
                self.correction_index+=1
                self.correction_active=True;self.correction_started=time.monotonic();self.correction_start_yaw=pose.yaw;self.correction_wz_max=0.
                self.phase='TURN';self.turn_rate=0.
                m.log(f"转角修正：残差 {math.degrees(error):.2f}° 超过完成容差 {math.degrees(acceptance):.1f}°，第 {self.correction_index} 次微调（目标 {math.degrees(s['bodyYaw']):.1f}°，实测 {math.degrees(pose.yaw):.1f}°，修正容差 {math.degrees(correction_tolerance):.1f}°）")
                return zero
            if abs(error)>self.turn_tolerance():
                m.fault(f"转角修正未收敛：目标 {math.degrees(s['bodyYaw']):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，残差 {math.degrees(error):.1f}°，超过安全容差 {math.degrees(self.turn_tolerance()):.1f}°；禁止前进")
                return zero
            m.log(f"注意：转角修正 {self.correction_index} 次后残差 {math.degrees(error):.2f}° 仍 > 完成容差 {math.degrees(acceptance):.1f}°（≤安全容差 {math.degrees(self.turn_tolerance()):.1f}°），按诊断继续，目标角不是实际真值")
        elif self.correction_active:
            delta=math.degrees(wrap(pose.yaw-self.correction_start_yaw))
            self.turn_info['corrections'].append({'index':self.correction_index,'beforeYawDeg':round(math.degrees(self.correction_start_yaw),3),'afterYawDeg':round(math.degrees(pose.yaw),3),'deltaDeg':round(delta,3),'wzMaxRadps':round(self.correction_wz_max,4),'durationS':round(now-self.correction_started,3),'success':True})
            self.correction_active=False
        jump=0. if self.turn_start_pose is None else math.hypot(pose.x-self.turn_start_pose[0],pose.y-self.turn_start_pose[1])
        self.turn_info.update({'status':'completed','completionYawDeg':round(math.degrees(pose.yaw),3),
                               'residualDeg':round(math.degrees(error),3),'poseJumpM':round(jump,4)})
        m.log(f"到码转向完成：目标 {math.degrees(s['bodyYaw']):.1f}°，实测 {math.degrees(pose.yaw):.1f}°，残差 {math.degrees(error):.2f}°，完成容差 {math.degrees(acceptance):.1f}°，转向期间位姿变化 {jump*100:.1f} cm，修正 {len(self.turn_info['corrections'])} 次")
        action=self.prepare_turn_exit(pose)
        if action=='fault':return zero
        if action=='center':
            # 新运动语义：转向出口不再自动横移；只在超过 5cm 硬门时停车，
            # 否则直接进入 TURN_RECENTER（轮角回正、零速），随后由 4T4D 行进转向纠偏。
            exit_cross,_,_,_=geometry(pose,s['points'])
            self.exit_info['turnExitCrossM']=round(exit_cross,4)
            hard=float(m.config['max_cross_track_m'])
            if abs(exit_cross)>hard:
                m.fault(f"转向出口横向偏差 {exit_cross*100:.1f} cm 超过硬门 {hard*100:.1f} cm（不做自动横移）；停车")
                return zero
        self.turn_done=True
        # 只确认“停稳 + yaw 到位”不等于轮子已回正：实车此时四轮仍在大转角回正中。
        # 必须先进入独立的回正/档位确认阶段（只发零速），确认后才允许下发 vx。
        self.phase='TURN_RECENTER'
        self.recenter_started=now
        self.turn_info['status']='recenter'
        self.turn_info['recenter']={'status':'waiting',
                                    'targetAngleDeg':round(math.degrees(0. if s['mode']!='crab' else m.target_angle),3),
                                    'angleToleranceDeg':m.config['angle_tolerance_deg'],
                                    'stableFeedbackSamples':m.config['stable_feedback_samples'],
                                    'timeoutS':float(m.config['mode_timeout_s']),
                                    'elapsedS':0.,
                                    'measuredAngleDeg':None if not isinstance(fb.get('steering_angle'),(int,float)) else round(fb['steering_angle'],3),
                                    'bodyGear':fb.get('body_gear'),'steeringGear':fb.get('steering_gear')}
        m.stable=0;m.last_sample=None
        m.log(f"到码转向到位并停稳（目标 {math.degrees(s['bodyYaw']):.1f}°，实测 {math.degrees(pose.yaw):.1f}°），"
              f"等待轮子回正与 4T4D 档位确认：实测转角 {fb.get('steering_angle')}°，"
              f"允许 ±{m.config['angle_tolerance_deg']:.1f}°，未确认前禁止前进")
        return zero

    def recenter_wheels(self,pose,fb,observations,dt):
        """转向后、前进前的硬门禁：轮子回正到直行角 + 档位确认回直行模式。

        只有四轮转角进入现有 angle_tolerance_deg、底盘 gear 已回到直行档、
        且连续 stable_feedback_samples 帧新鲜反馈都成立后才允许进入 MOVE；
        否则保持零速，超时结构化 FAULT，绝不带大转角下发 vx。
        """
        m=self.m;s=self.segment;zero=self.zero()
        straight=0. if s['mode']!='crab' else m.target_angle
        gears=(7,8) if s['mode']=='crab' else (5,6)
        now=time.monotonic()
        info=self.turn_info.setdefault('recenter',{})
        # mode_ready 复用现有档位判定；stable_feedback 复用现有轮角容差与新鲜度判定。
        ready=self.mode_ready(fb) and m.stable_feedback(fb,straight,gears)
        angle=fb.get('steering_angle')
        info.update({'status':'ready' if ready else 'waiting',
                     'targetAngleDeg':round(math.degrees(straight),3),
                     'measuredAngleDeg':None if not isinstance(angle,(int,float)) else round(angle,3),
                     'angleToleranceDeg':m.config['angle_tolerance_deg'],
                     'bodyGear':fb.get('body_gear'),'steeringGear':fb.get('steering_gear'),
                     'requiredSamples':m.config['stable_feedback_samples'],'stableSamples':m.stable,
                     'elapsedS':round(now-self.recenter_started,3),
                     'timeoutS':float(m.config['mode_timeout_s'])})
        self.turn_info['status']='recenter'
        if not ready:
            if now-self.recenter_started>float(m.config['mode_timeout_s']):
                m.fault('转向后轮子回正或档位确认超时：目标转角 %.1f°（允许 ±%.1f°），实测转角 %s，'
                        '车体档位 %s，转向档位 %s，速度 %s，反馈序号 %s，已等待 %.2f s；禁止前进'
                        %(math.degrees(straight),m.config['angle_tolerance_deg'],angle,
                          fb.get('body_gear'),fb.get('steering_gear'),fb.get('speed'),fb.get('seq'),
                          now-self.recenter_started))
            return zero
        self.phase='MOVE'
        m.transition('LATERAL_SHIFT' if s['mode']=='crab' else 'REVERSE' if s['direction']=='reverse' else 'FORWARD')
        m.log('轮子回正与档位确认完成：转角 %s°（允许 ±%.1f°），档位 %s/%s；开始前进'
              %(info.get('measuredAngleDeg'),m.config['angle_tolerance_deg'],fb.get('body_gear'),fb.get('steering_gear')))
        return self.move_command(pose,fb,observations,dt)

    # ---- boundary cross-track centering (every QR boundary, every mode) ----
    def centering_done_cross(self):
        """收敛目标：abs(cross) 进入该值即视为对中完成。"""
        return abs(float(self.m.config.get('centering_done_cross_m',.02)))

    def centering_trigger_cross(self):
        """触发阈值：abs(cross) 超过该值才进入有限横移对中。"""
        return abs(float(self.m.config.get('centering_trigger_cross_m',self.centering_done_cross())))

    def centering_max_travel(self):
        """单次对中的横移距离窗口，用尽即 FAULT，不无限走。"""
        return abs(float(self.m.config.get('centering_max_travel_m',.10)))

    def centering_max_sigma(self):
        """对中前的定位质量门限；sigma 缺失或超限一律不做横移。"""
        return abs(float(self.m.config.get('centering_max_sigma_m',
                                           self.m.config.get('max_position_sigma_m',.03))))

    def boundary_centering_enabled(self):
        return bool(self.m.config.get('centering_enabled',True))

    def next_segment(self):
        index=self.index+1
        return self.segments[index] if 0<=index<len(self.segments) else None

    def prepare_boundary_center(self,pose):
        """有符号 cross-track：到码停稳后相对「下一段直线」计算并决定是否对中。

        偏差永远相对下一段要走的直线来量，所以上一段留下的 2-3 cm 不会混进下一段。
        第一段的起点偏差不参与这个判定：它已经由 start_gate 按 max_cross_track_m
        把关，这里只处理二维码边界，避免把起点误差误判成后续区间误差。
        """
        m=self.m;target=self.next_segment()
        if target is None or not self.boundary_centering_enabled():return 'advance'
        points=target['points']
        cross,_,_,_=geometry(pose,points)
        done=self.centering_done_cross();limit=abs(float(m.config['max_cross_track_m']))
        heading_error=wrap(pose.yaw-target['bodyYaw'])
        self.exit_info.update({'status':'pending','startCrossM':round(cross,4),
                               'headingErrorDeg':round(math.degrees(heading_error),3),
                               'targetTagId':self.segment['toId'],'windowM':None,
                               'converged':False,'centeringUsed':False,'reason':''})
        if abs(cross)<=done:
            self.exit_info.update({'status':'converged','converged':True,'endCrossM':round(cross,4)})
            return 'advance'
        info={'start_cross':cross,'start_pose':(pose.x,pose.y),'started':time.monotonic(),
              'moved':0.,'points':points,'body_yaw':target['bodyYaw'],'on_done':'advance',
              'for_index':self.index+1,'tag_id':self.segment['toId'],'start_yaw':pose.yaw,
              'last_command':{'vx':0.,'vy':0.,'wz':0.,'mode':'crab'},
              'direction':'left' if cross>0 else 'right'}
        # 硬上限沿用既有 max_cross_track_m（5 cm），不为让车走而放宽。
        if abs(cross)>limit:
            self.exit_info.update({'status':'fault','reason':'over_limit','endCrossM':round(cross,4)})
            self.centering_record(info,cross,'fault','over_limit')
            m.fault(f"区间 {self.index+2} 起点横向偏差 {cross*100:+.1f} cm 超过硬上限 {limit*100:.1f} cm（收敛目标 {done*100:.1f} cm），拒绝进入下一段")
            return 'fault'
        if abs(heading_error)>self.boundary_heading_tolerance():
            self.exit_info.update({'status':'fault','reason':'heading','endCrossM':round(cross,4)})
            self.centering_record(info,cross,'fault','heading')
            m.fault(f"区间 {self.index+2} 起点航向偏差 {math.degrees(heading_error):.1f}° 超过边界容差 {math.degrees(self.boundary_heading_tolerance()):.1f}°，横移对中会走错方向，拒绝进入下一段")
            return 'fault'
        sigma=getattr(pose,'sigma',None)
        if not _finite(sigma) or sigma>self.centering_max_sigma():
            self.exit_info.update({'status':'fault','reason':'low_quality','endCrossM':round(cross,4)})
            self.centering_record(info,cross,'fault','low_quality')
            m.fault(f"定位质量不足，禁止横移对中：横向 {cross*100:+.1f} cm，sigma={sigma}，门限 {self.centering_max_sigma()*100:.1f} cm；等待定位稳定后重试")
            return 'fault'
        if not m.body_velocity_crab():
            self.exit_info.update({'status':'fault','reason':'no_crab','endCrossM':round(cross,4)})
            self.centering_record(info,cross,'fault','no_crab')
            m.fault(f"区间 {self.index+2} 起点横向偏差 {cross*100:+.1f} cm 超过收敛目标但底盘未确认横移能力，无法正交对中，拒绝进入下一段")
            return 'fault'
        self.centering=info
        self.centering_info={'required':True,'startCrossM':round(cross,4),'done':False,'mode':'crab',
                             'travelM':0.,'for_index':self.index+1,'boundaryTagId':self.segment['toId'],
                             'doneCrossM':done,'triggerCrossM':self.centering_trigger_cross(),
                             'limitCrossM':round(limit,4),'direction':info['direction'],
                             'decision':'centering'}
        self.exit_info.update({'status':'centering','centeringUsed':True,'endCrossM':round(cross,4)})
        m.log(f"区间 {self.index+2} 起点横向偏差 {cross*100:+.1f} cm（收敛目标 {done*100:.1f} cm，硬上限 {limit*100:.1f} cm）：执行定点横移对中（crab 纯横移，不引入弧线）")
        return 'center'

    def prepare_turn_exit(self,pose):
        """Check the signed cross-track error against the target straight line.

        A real lateral offset inside the centering limit is corrected with an
        orthogonal crab shift (pure lateral translation, no arc), then the robot
        resumes 4T4D straight motion. Beyond the limit it faults explicitly.
        """
        m=self.m;s=self.segment
        cross,_,_,_=geometry(pose,s['points']);heading_error=wrap(pose.yaw-s['bodyYaw'])
        cross_limit=m.config['max_cross_track_m']
        self.exit_info.update({'status':'pending','startCrossM':round(cross,4),
                               'headingErrorDeg':round(math.degrees(heading_error),3),
                               'targetTagId':s['fromId']})
        if abs(cross)<=cross_limit:
            self.exit_info.update({'status':'converged','converged':True,'endCrossM':round(cross,4)})
            return 'move'
        max_offset=float(m.config.get('centering_max_offset_m',.12))
        if abs(cross)>max_offset:
            self.exit_info.update({'status':'fault','reason':'over_limit'})
            m.fault(f"转向出口横向偏差 {cross*100:.1f} cm 超过对中上限 {max_offset*100:.1f} cm（门限 {cross_limit*100:.1f} cm），拒绝前进")
            return 'fault'
        if not m.body_velocity_crab():
            self.exit_info.update({'status':'fault','reason':'no_crab'})
            m.fault(f"转向出口横向偏差 {cross*100:.1f} cm 超过门限但底盘未确认横移能力，无法正交对中，拒绝前进")
            return 'fault'
        self.centering={'start_cross':cross,'start_pose':(pose.x,pose.y),'started':time.monotonic(),
                        'moved':0.,'points':s['points'],'body_yaw':s['bodyYaw'],'on_done':'resume',
                        'for_index':self.index,'tag_id':s['fromId'],'start_yaw':pose.yaw,
                        'last_command':{'vx':0.,'vy':0.,'wz':0.,'mode':'crab'},
                        'direction':'left' if cross>0 else 'right'}
        self.centering_info={'required':True,'startCrossM':round(cross,4),'done':False,'mode':'crab','travelM':0.}
        self.exit_info.update({'status':'centering','centeringUsed':True,'endCrossM':round(cross,4)})
        m.log(f"转向出口横向偏差 {cross*100:.1f} cm 超过门限 {cross_limit*100:.1f} cm：执行定点横移对中（crab，纯横移，不引入弧线）")
        return 'center'

    def centering_frame(self):
        """正在被收敛的直线与车体参考方向。"""
        info=self.centering or {}
        points=info.get('points')
        return (points if points else self.segment['points']),float(info.get('body_yaw',self.segment['bodyYaw']))

    def centering_record(self,info,cross,decision,reason=''):
        """结构化记录：起始/结束 cross、delta、指令、横移距离、耗时、判定。"""
        m=self.m
        record={'targetSegment':int(info.get('for_index',self.index))+1,
                'boundaryTagId':info.get('tag_id'),'source':info.get('source','boundary'),
                'startCrossM':round(info['start_cross'],4),'endCrossM':round(cross,4),
                'deltaCrossM':round(cross-info['start_cross'],4),
                'direction':info.get('direction'),
                'doneCrossM':round(self.centering_done_cross(),4),
                'triggerCrossM':round(self.centering_trigger_cross(),4),
                'limitCrossM':round(abs(float(m.config['max_cross_track_m'])),4),
                'command':dict(info.get('last_command') or {}),
                'travelM':round(info.get('moved',0.),4),
                'durationS':round(max(0.,time.monotonic()-info['started']),3),
                'decision':decision,'reason':reason}
        self.centering_history.append(record)
        self.centering_history=self.centering_history[-8:]
        self.centering_info.update(record)
        if self.exit_info is not None:
            self.exit_info['centeringDecision']=decision
            self.exit_info['centeringReason']=reason
        return record

    def center(self,pose,fb,observations,dt):
        """Orthogonal lateral centering via the existing crab mode.

        Shared by the in-place-turn exit (resume the same segment) and every QR
        boundary (advance to the next segment). The straight line being centred
        on, the body reference and the resume action all come from the
        ``self.centering`` record, so no arc or diagonal shortcut is introduced
        and a lateral correction is never passed off as forward motion.
        """
        m=self.m;zero=self.zero();info=self.centering
        if info is None:
            m.fault('对中状态丢失');return zero
        points,body_yaw=self.centering_frame()
        cross,_,_,_=geometry(pose,points)
        # DR 触发的纠偏以“预测位姿的横向偏差”为收敛判据：QR 已失联时控制位姿
        # 不再更新，只有预测 cross 才反映纠偏指令的真实效果。
        if info.get('source')=='dead_reckoning' and self.dr_state is not None:
            pred=Pose(self.dr_state['pred']['x'],self.dr_state['pred']['y'],self.dr_state['pred']['yaw'])
            cross,_,_,_=geometry(pred,points)
        if self.phase=='CENTER_MOVE':
            cross,_=self.guard_localization_jump(pose,fb,observations,dt,cross)
            if m.state=='FAULT':return zero
            # DR 触发的纠偏期间继续轮速积分：横移指令的效果必须反映到预测位姿，
            # 否则预测 cross 永不收敛、纠偏窗口必然耗尽。
            if info.get('source')=='dead_reckoning' and self.dr_state is not None:
                mloc=m.localization if isinstance(getattr(m,'localization',None),dict) else {}
                self.dr_integrate(fb,dt,mloc.get('localOdom'))
        if self.phase=='CENTER_ALIGN':
            m.mode='crab';m.target_angle=0.
            ready=(m.body_crab_feedback_ready(fb) if m.body_velocity_crab() else m.canonical_steering_ready(fb,0.))
            if ready and m.stable_feedback(fb,None if m.body_velocity_crab() else 0.,(7,8)):
                self.phase='CENTER_MOVE';m.stable=0;m.last_sample=None
                m.log('横移对中档位已确认，开始横移')
            elif time.monotonic()-info['started']>m.config['mode_timeout_s']:
                self.centering_record(info,cross,'fault','align_timeout')
                m.fault('横移对中换挡确认超时');return zero
            return zero
        if self.phase=='CENTER_MOVE':
            done=self.dr_target() if info.get('source')=='dead_reckoning' else self.centering_done_cross()
            if abs(cross)<=done:
                self.centering_info.update({'endCrossM':round(cross,4)})
                self.phase='CENTER_STOP';m.stable=0;m.last_sample=None
                m.log(f"横移对中到达门限内：横向 {cross*100:+.1f} cm，等待停稳")
                return zero
            if abs(cross)>abs(info['start_cross'])+.02 or (cross>0)!=(info['start_cross']>0):
                self.centering_info.update({'done':False,'reason':'diverged','endCrossM':round(cross,4)})
                self.centering_record(info,cross,'fault','diverged')
                m.fault(f"横移对中方向异常/发散：起始 {info['start_cross']*100:+.1f} cm，当前 {cross*100:+.1f} cm；停止")
                return zero
            elapsed=time.monotonic()-info['started']
            if elapsed>float(m.config.get('centering_timeout_s',8.)):
                self.centering_info.update({'done':False,'reason':'timeout','endCrossM':round(cross,4)})
                self.centering_record(info,cross,'fault','timeout')
                m.fault(f"横移对中未收敛：起始 {info['start_cross']*100:+.1f} cm，当前 {cross*100:+.1f} cm，超时 {elapsed:.1f} s；停止等待人工纠正")
                return zero
            travel_cap=info.get('dr_travel_cap') or self.centering_max_travel()
            if info['moved']>travel_cap:
                self.centering_info.update({'done':False,'reason':'travel','endCrossM':round(cross,4)})
                self.centering_record(info,cross,'fault','travel_limit')
                m.fault(f"横移对中距离窗口用尽：起始 {info['start_cross']*100:+.1f} cm，当前 {cross*100:+.1f} cm，已横移 {info['moved']*100:.1f} cm（窗口 {self.centering_max_travel()*100:.1f} cm）；停止")
                return zero
            start_yaw=info.get('start_yaw')
            yaw_drift=wrap(pose.yaw-start_yaw) if _finite(start_yaw) else 0.
            drift_limit=math.radians(float(m.config.get('centering_heading_drift_deg',3.)))
            if _finite(start_yaw) and abs(yaw_drift)>drift_limit:
                self.centering_info.update({'done':False,'reason':'heading_drift','endCrossM':round(cross,4)})
                self.centering_record(info,cross,'fault','heading_drift')
                m.fault(f"横移对中航向异常：起始 {math.degrees(info['start_yaw']):.1f}°，当前 {math.degrees(pose.yaw):.1f}°，漂移 {math.degrees(yaw_drift):.1f}°（容差 {math.degrees(drift_limit):.1f}°）；停止")
                return zero
            speed=float(m.config.get('centering_lateral_speed_mps',.02))
            speed_limit=float(m.config.get('centering_speed_limit_mps',.06))
            measured=fb.get('speed')
            if _finite(measured) and measured>speed_limit:
                self.centering_info.update({'done':False,'reason':'speed','endCrossM':round(cross,4)})
                self.centering_record(info,cross,'fault','speed')
                m.fault(f"横移对中速度异常：指令 {speed:.3f} m/s，底盘反馈 {measured:.3f} m/s 超过 {speed_limit:.3f} m/s；停止")
                return zero
            tangent=math.atan2(points[-1]['y']-points[0]['y'],points[-1]['x']-points[0]['x'])
            travel=tangent-(math.pi/2)*math.copysign(1.0,cross)
            rel=wrap(travel-body_yaw)
            vx=speed*math.cos(rel);vy=speed*math.sin(rel)
            info['moved']+=abs(speed)*dt
            info['last_command']={'vx':round(vx,4),'vy':round(vy,4),'wz':0.,'mode':'crab','relRad':round(rel,4)}
            self.centering_info.update({'travelM':round(info['moved'],4),'endCrossM':round(cross,4),
                                        'command':dict(info['last_command'])})
            return Command(mode='crab',vx=vx,vy=vy,wheel_angle=m.target_angle)
        if m.stable_feedback(fb):
            self.centering_info.update({'done':True,'endCrossM':round(cross,4)})
            self.exit_info.update({'status':'converged','converged':True,'endCrossM':round(cross,4)})
            self.centering_record(info,cross,'converged','converged')
            advance=info.get('on_done')=='advance'
            m.log(f"横移对中完成：横向 {info['start_cross']*100:+.1f} → {cross*100:+.1f} cm；"
                  +('进入下一段' if advance else '恢复 4T4D 直线前进'))
            self.turn_done=True;self.centering=None
            return self.resume_after_center(advance)
        if time.monotonic()-info['started']>float(m.config.get('centering_timeout_s',8.))+m.config['mode_timeout_s']:
            self.centering_record(info,cross,'fault','stop_timeout')
            m.fault('横移对中停稳确认超时');return zero
        return zero

    def resume_after_center(self,advance=False):
        m=self.m
        if advance:
            # 边界对中完成：进入下一段（仍从换挡确认开始，不跳过任何安全门）。
            self.index+=1;self.arrival_seen=False
            return self.align()
        s=self.segment
        m.mode=s['mode']
        m.target_angle=s['wheelAngle'] if s['mode']=='crab' and not m.body_velocity_crab() else 0.
        m.transition('SEGMENT_ALIGN');self.phase='ALIGN';self.align_after_seq=self.last_seq
        m.stable=0;m.last_sample=None
        m.log(f"对中完成，恢复区间 {self.index+1} 换挡确认")
        return self.zero()
