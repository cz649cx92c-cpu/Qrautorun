"""真实反馈驱动的温室导航状态机。没有计时伪造位姿/转角的分支。"""
import math
import time
from .control import Command, Tracker, geometry, wrap
from .segment_execution import SegmentExecutor


def row_heading(row):
    a,b=row['points'][:2]
    return math.atan2(b['y']-a['y'],b['x']-a['x'])


def exit_point(row):
    if row.get('start') is not None:return dict(row['start'])
    h=row_heading(row)
    p=row['points'][0]
    return {'x':p['x']-math.cos(h)*row['exitDistance'],'y':p['y']-math.sin(h)*row['exitDistance']}


class Mission:
    def __init__(self,config):
        self.segment_executor=None
        self.config=config
        self.tracker=Tracker(config['acceleration_mps2'],config['braking_mps2'])
        self.state='IDLE';self.running=False;self.paused=False
        self.job_requests=[];self.field=None;self.task=None;self.row_index=0;self.events=[];self.fired=set();self.completed=[]
        self.entered=time.monotonic();self.last_sample=None;self.stable=0;self.wait_until=0.;self.mode='4t4d';self.target_angle=0.
        self.restore_started=False;self.speed_override=None;self.last_rules=time.monotonic()

    @property
    def row(self):
        if not self.field or not self.task:return None
        return next(r for r in self.field['rows'] if r['id']==self.task['rowOrder'][self.row_index])

    def log(self,text):
        self.events.insert(0,time.strftime('%H:%M:%S')+' '+text)
        self.events=self.events[:100]

    def transition(self,state):
        self.restore_started=False;self.state=state;self.entered=time.monotonic();self.stable=0;self.last_sample=None;self.tracker.reset();self.speed_override=None
        self.log((self.row['name']+' · ' if self.row else '')+state)

    def start(self,field,task,pose):
        if self.running:raise ValueError('已有任务正在运行')
        if field.get('coordinateStatus')!='reviewed':raise ValueError('地图未通过现场坐标验收')
        if not task['rowOrder'] or len(set(task['rowOrder']))!=len(task['rowOrder']):raise ValueError('作业顺序无效')
        self.segment_executor=None
        if field.get('motionSegments'):
            if field.get('routeMode')!='waypoints' or len(field.get('rows',[]))!=1 or task['rowOrder']!=[field['rows'][0]['id']]:raise ValueError('区间路线作业顺序无效')
            for segment in field['motionSegments']:
                for key,p in (('fromId',segment['points'][0]),('toId',segment['points'][-1])):
                    tag=next((t for t in field['tags'] if t['id']==segment[key]),None)
                    if tag is None or math.hypot(tag['x']-p['x'],tag['y']-p['y'])>.03:raise ValueError('区间端点必须对应二维码中心')
            self.field=field;self.task=task;self.row_index=0
            executor=SegmentExecutor(self,field['motionSegments'])
            executor.start(pose);self.segment_executor=executor
            return
        self.field=field;self.task=task;self.row_index=0
        first=exit_point(self.row);heading=row_heading(self.row)
        position_error=math.hypot(pose.x-first['x'],pose.y-first['y'])
        heading_error=abs(wrap(pose.yaw-heading))
        tolerance=self.config.get('start_position_tolerance_m',.05)
        position_allowed=position_error<=tolerance
        if self.config.get('qr_interval_navigation',False):
            # Explicitly starting an interrupted task may use its first straight
            # row corridor. This never chooses another row or starts on its own.
            c,s=math.cos(heading),math.sin(heading)
            along=(pose.x-first['x'])*c+(pose.y-first['y'])*s
            projected=[((p['x']-first['x'])*c+(p['y']-first['y'])*s,
                        -(p['x']-first['x'])*s+(p['y']-first['y'])*c)
                       for p in self.row['points']]
            straight=(all(abs(cross)<=1e-6 for _,cross in projected)
                      and all(b[0]>=a[0] for a,b in zip(projected,projected[1:])))
            end=projected[-1][0]
            position_allowed=(along<=end+1e-9 and (position_allowed
                              or (straight and -tolerance-1e-9<=along<=end+1e-9)))
        if self.config.get('qr_interval_navigation',False) and field.get('routeMode')=='waypoints':
            points=[first]+self.row['points']
            cross,tangent,_,_=geometry(pose,points)
            heading_error=abs(wrap(pose.yaw-tangent))
            distances=[]
            for a,b in zip(points,points[1:]):
                dx,dy=b['x']-a['x'],b['y']-a['y'];length2=dx*dx+dy*dy
                t=max(0.,min(1.,((pose.x-a['x'])*dx+(pose.y-a['y'])*dy)/length2))
                distances.append(math.hypot(pose.x-a['x']-t*dx,pose.y-a['y']-t*dy))
            position_allowed=min(distances)<=tolerance
        if not position_allowed or heading_error>.10:
            if self.config.get('qr_interval_navigation',False):
                raise ValueError(f'当前位置不在首行路径内或未朝向作物行（航向偏差 {math.degrees(heading_error):.1f}°，允许 5.7°）；请沿当前地图的作业行启动')
            raise ValueError(f'启动位置距首行起点 {position_error*100:.1f} cm（允许 {tolerance*100:.0f} cm），航向偏差 {math.degrees(heading_error):.1f}°（允许 5.7°）；请靠近起点并朝向作物行')
        cross=(abs(geometry(pose,[first]+self.row['points'])[0]) if field.get('routeMode')=='waypoints'
               else abs(-(pose.x-first['x'])*math.sin(heading)+(pose.y-first['y'])*math.cos(heading)))
        if cross>self.config['max_cross_track_m']:raise ValueError(f'启动位置侧偏 {cross*100:.1f} cm，超过路径允许的 {self.config["max_cross_track_m"]*100:.0f} cm')
        self.running=True;self.paused=False;self.fired.clear();self.completed=[];self.wait_until=0.;self.mode='4t4d';self.target_angle=0.;self.transition('INITIALIZING')

    def stop(self):
        self.running=False;self.paused=False;self.transition('IDLE')

    def fault(self,text):
        self.running=False;self.paused=False;self.transition('FAULT');self.log(text)

    def pause(self):
        if self.running:
            self.paused=True;self.log('任务暂停，等待实体停稳')
            if self.segment_executor:self.segment_executor.pause()

    def resume(self):
        if self.running:
            self.paused=False;self.tracker.reset();self.log('任务继续')
            if self.segment_executor:self.segment_executor.resume()

    def body_velocity_crab(self):
        return bool(self.config.get('existing_chassis_confirmed',False) and self.config.get('existing_runtime_conditions_accepted',False))

    def body_crab_feedback_ready(self,feedback):
        # autorunlida's actual non-ROS sender controls the wheel plane from vx/vy.
        # Its cached steering angle is not a physical +/-90 degree precondition.
        stamp=feedback.get('aggregate_received');sample=feedback.get('seq')
        return (self.body_velocity_crab() and type(sample) is int and sample>=0
                and isinstance(stamp,(int,float)) and not isinstance(stamp,bool) and math.isfinite(stamp)
                and 0<=time.monotonic()-stamp<self.config['feedback_timeout_s']
                and feedback.get('body_gear') in (7,8) and feedback.get('steering_gear') in (7,8))

    def canonical_steering_ready(self,feedback,angle):
        # Only an independent steering receiver may supply these fields.
        # The mature aggregate receiver deliberately leaves them unavailable.
        sample=feedback.get('steering_seq');received=feedback.get('steering_received')
        steering=feedback.get('steering_angle')
        finite=lambda value:isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)
        if self.config.get('existing_chassis_confirmed',False) and self.config.get('existing_runtime_conditions_accepted',False):
            # Explicit operator acceptance reuses the mature aggregate interface.
            # Its cached angle has no independent stamp; retain that fact in telemetry.
            received=feedback.get('aggregate_received');sample=feedback.get('seq')
            return (feedback.get('angle_source')=='existing_chassis'
                    and type(sample) is int and sample>=0 and finite(received)
                    and 0<=time.monotonic()-received<self.config['feedback_timeout_s']
                    and finite(steering) and abs(steering-angle)<self.config['angle_tolerance_deg'])
        return (feedback.get('angle_source')=='existing_chassis'
                and type(sample) is int and sample>=0 and feedback.get('steering_fresh') is True
                and finite(received) and 0<=time.monotonic()-received<self.config['feedback_timeout_s']
                and finite(steering) and abs(steering-angle)<self.config['angle_tolerance_deg'])

    def stable_feedback(self,feedback,angle=None,gear=None):
        body_crab=bool(self.body_velocity_crab() and gear is not None and any(code in (7,8) for code in gear))
        canonical=(not body_crab and angle is not None and self.config.get('existing_chassis_confirmed',False)
                   and feedback.get('angle_source')=='existing_chassis')
        aggregate=(canonical and self.config.get('existing_chassis_confirmed',False)
                   and self.config.get('existing_runtime_conditions_accepted',False))
        sample=('aggregate',feedback.get('seq')) if aggregate else ('steering',feedback.get('steering_seq')) if canonical else ('body',feedback.get('seq'))
        speed=feedback.get('speed',float('inf'))
        stopped=isinstance(speed,(int,float)) and math.isfinite(speed) and speed<=self.config['stopped_speed_mps']
        angles=feedback.get('angles')
        aligned=angle is None or (angles is not None and len(angles)==4 and all(abs(a-angle)<self.config['angle_tolerance_deg'] for a in angles))
        if body_crab:
            aligned=self.body_crab_feedback_ready(feedback)
        elif canonical:
            aligned=self.canonical_steering_ready(feedback,angle)
            if gear is not None and any(code in (7,8) for code in gear):
                aligned=aligned and feedback.get('body_gear') in (7,8) and feedback.get('steering_gear') in (7,8)
        aligned=aligned and (gear is None or feedback.get('steering_gear') in gear)
        # Revalidate even duplicates: a once-valid steering frame may expire,
        # change mode or no longer represent a stationary vehicle.
        if not stopped or not aligned:
            self.stable=0
            return False
        if sample==self.last_sample:return self.stable>=self.config['stable_feedback_samples']
        if canonical and self.last_sample is not None and self.last_sample[0]==sample[0] and sample[1]<self.last_sample[1]:
            self.stable=0
            return False
        self.last_sample=sample
        self.stable+=1
        return self.stable>=self.config['stable_feedback_samples']

    def rules(self,pose,observations):
        direction='reverse' if self.state in ['REVERSE','ROW_EXIT'] else 'lateral' if self.state in ['SWITCH_TO_LATERAL','LATERAL_SHIFT','SWITCH_TO_ACKERMANN'] else 'forward'
        for observation in observations:
            for tag in self.field['tags']:
                if tag['id']!=observation['id'] or tag['rowId']!=self.row['id']:continue
                for rule in tag['rules']:
                    key=(tag['id'],rule['id'],self.row['id'],self.state,direction)
                    if key in self.fired or rule['task']!=self.task['id'] or rule['state']!=self.state or rule['direction']!=direction:continue
                    if math.hypot(pose.x-tag['x'],pose.y-tag['y'])>rule['radius']:continue
                    self.fired.add(key);self.log(f"Q{tag['id']:03} {rule['action']}")
                    action=rule['action']
                    if action in ['SLOW_DOWN','CONTINUE']:self.speed_override=rule['speed']
                    elif action=='WAIT':self.wait_until=time.monotonic()+rule['waitSeconds']
                    elif action=='STOP':self.pause()
                    elif action=='END_REVERSE':self.task['endWaitSeconds']=rule['waitSeconds']
                    elif action=='TASK_COMPLETE':self.transition('FINISHED');self.running=False
                    elif action=='CUSTOM':self.job_requests.append({'taskId':self.task['id'],'jobName':rule['customTask'],'tagId':tag['id'],'ruleId':rule['id']});self.log('作业请求：'+rule['customTask'])
                    elif action=='ROW_COMPLETE' and self.row['id'] not in self.completed:self.completed.append(self.row['id'])

    def tick(self,pose,feedback,observations,conditions,dt):
        zero=Command(mode=self.mode,wheel_angle=self.target_angle)
        if not self.running:return zero
        missing=[c['label'] for c in conditions if not c['ready']]
        if missing:self.fault('运行条件失效：'+'、'.join(missing));return zero
        if self.segment_executor is not None:return self.segment_executor.tick(pose,feedback,observations,dt)
        if self.state=='LATERAL_SHIFT':
            aligned=(self.body_crab_feedback_ready(feedback) if self.body_velocity_crab() else
                     self.canonical_steering_ready(feedback,self.target_angle)
                     if self.config.get('existing_chassis_confirmed',False)
                     else feedback.get('lateral_aligned',False))
            if feedback.get('body_gear') not in (7,8) or feedback.get('steering_gear') not in (7,8) or not aligned:
                self.fault('横移档位、轮角或独立转向反馈时效失效');return zero
        if self.paused:return zero
        self.rules(pose,observations)
        if self.paused or not self.running or time.monotonic()<self.wait_until:return zero
        row=self.row;heading=row_heading(row);exit_p=exit_point(row)
        if self.state=='INITIALIZING':
            if self.stable_feedback(feedback,0.,(5,6)) :self.transition('FORWARD')
            elif time.monotonic()-self.entered>self.config['mode_timeout_s']:self.fault('初始化轮角或档位未确认')
        elif self.state in ['FORWARD','REVERSE','LATERAL_SHIFT']:
            if self.state=='FORWARD':
                points=[exit_p]+row['points']
                target=self.speed_override if self.speed_override is not None else self.task['forwardSpeed']
                if self.config.get('qr_interval_navigation',False):
                    # Cross/heading errors are tracking inputs between QR anchors.
                    # Reduce speed before the acceleration limiter, without
                    # cancelling the mission when a valid QR update moves the pose.
                    cross,tangent,_,_=geometry(pose,points)
                    angle=wrap(pose.yaw-tangent)
                    scale=max(1.,abs(cross)/.025,abs(angle)/self.config['max_heading_rad'])
                    target*=max(.25,1./scale)
                cmd,cross,angle,remaining,end=self.tracker.forward(pose,points,target,dt)
                target_state='ROW_END'
            elif self.state=='REVERSE':
                points=list(reversed(row['points']))+[exit_p]
                target=self.speed_override if self.speed_override is not None else self.task['reverseSpeed']
                if self.task.get('returnToStart',False) and self.config.get('qr_interval_navigation',False):
                    cross,tangent,_,_=geometry(pose,points)
                    angle=wrap(pose.yaw-wrap(tangent+math.pi))
                    scale=max(1.,abs(cross)/.025,abs(angle)/self.config['max_heading_rad'])
                    target*=max(.25,1./scale)
                cmd,cross,angle,remaining,end=self.tracker.reverse(pose,points,target,dt)
                target_state='ROW_EXIT'
            else:
                next_row=next(r for r in self.field['rows'] if r['id']==self.task['rowOrder'][self.row_index+1])
                cmd,cross,angle,remaining,end=self.tracker.lateral(pose,exit_p,exit_point(next_row),heading,self.task['lateralSpeed'],dt)
                target_state='SWITCH_TO_ACKERMANN'
            continuous=(self.state=='FORWARD' or (self.state=='REVERSE' and self.task.get('returnToStart',False))) and self.config.get('qr_interval_navigation',False)
            if not continuous and (abs(cross)>self.config['max_cross_track_m'] or abs(angle)>self.config['max_heading_rad']):
                self.fault('路径侧偏或航向偏差超限');return zero
            # Stop at the original route end even when a late QR correction
            # leaves lateral error. Do not overshoot or claim measured accuracy.
            if (end<.03 and remaining<.04) or (continuous and remaining<=.025):
                self.transition(target_state)
                self.log(f'路径终点停车：位置残差 {end*100:.1f} cm，侧偏 {cross*100:.1f} cm，航向偏差 {math.degrees(angle):.2f}°')
                return zero
            if not continuous and abs(cross)>.025:cmd.vx*=.5;cmd.vy*=.5
            return cmd
        elif self.state=='ROW_END':
            if self.stable_feedback(feedback) and time.monotonic()-self.entered>=self.task['endWaitSeconds']:
                if self.task.get('returnToStart',False):
                    self.log('前进到点并已停稳，开始原路倒车返回起点')
                    self.transition('REVERSE')
                else:
                    if row['id'] not in self.completed:self.completed.append(row['id'])
                    self.transition('FINISHED');self.running=False
                    self.log('已沿设定路径到达终点，任务结束')
        elif self.state=='ROW_EXIT':
            if self.stable_feedback(feedback):
                if row['id'] not in self.completed:self.completed.append(row['id'])
                if self.task.get('returnToStart',False):
                    self.transition('FINISHED');self.running=False;self.log('原路倒车已回到起点，往返任务结束')
                elif self.row_index+1>=len(self.task['rowOrder']):self.transition('FINISHED');self.running=False
                else:
                    next_row=next(r for r in self.field['rows'] if r['id']==self.task['rowOrder'][self.row_index+1]);next_p=exit_point(next_row)
                    lateral=(next_p['x']-exit_p['x'])*(-math.sin(heading))+(next_p['y']-exit_p['y'])*math.cos(heading)
                    self.mode='crab';self.target_angle=math.copysign(90.,lateral);self.transition('SWITCH_TO_LATERAL')
        elif self.state=='SWITCH_TO_LATERAL':
            if self.stable_feedback(feedback,self.target_angle,(7,8)):self.transition('LATERAL_SHIFT')
            elif time.monotonic()-self.entered>self.config['mode_timeout_s']:self.fault('平移模式切换确认超时' if self.body_velocity_crab() else '四轮90°到位超时')
        elif self.state=='SWITCH_TO_ACKERMANN':
            if not self.restore_started:
                if self.stable_feedback(feedback):
                    self.mode='4t4d';self.target_angle=0.;self.restore_started=True;self.stable=0;self.last_sample=None
            elif self.stable_feedback(feedback,0.,(5,6)):self.row_index+=1;self.transition('NEXT_ROW')
            if time.monotonic()-self.entered>self.config['mode_timeout_s']:self.fault('恢复正常四轮转向超时')
        elif self.state=='NEXT_ROW':self.transition('FORWARD')
        return Command(mode=self.mode,wheel_angle=self.target_angle)
