"""Read-only execution diagnostics from the exact control pose and active segment."""
import copy
import math
from .control import geometry, wrap


def finite(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)


class ExecutionDiagnostics:
    def __init__(self):
        self.executor = None
        self.epoch = None
        self.held = None
        self.last_live = None

    def capture(self, mission, pose, feedback, observations, now, pose_received,
                now_ros, localization, localization_received):
        executor = mission.segment_executor
        if mission.state=='IDLE' or executor is None:
            self.executor=None;self.epoch=None;self.held=None;self.last_live=None
            return {'status':'idle','reason':'尚未执行二维码区间任务','sampledAt':now_ros}
        if self.executor is not executor:
            self.executor=executor;self.epoch=localization.get('localEpoch');self.held=None;self.last_live=None
        if self.held is not None and mission.state in ('FAULT','FINISHED'):
            return copy.deepcopy(self.held)
        field=mission.field or {};task=mission.task or {}
        base={'status':'unavailable','reason':'等待控制位姿','sampledAt':now_ros,
              'taskId':task.get('id',''),'mapId':field.get('id',''),
              'mapVersion':task.get('mapVersion'),'localEpoch':self.epoch or '',
              'poseSource':'control_fused','controllerState':mission.state,
              'covarianceCalibrated':bool(localization.get('covarianceCalibrated',False))}
        limit=mission.config.get('localization_timeout_s',.25)
        if (not self.epoch or localization.get('localEpoch')!=self.epoch
                or localization.get('mapId')!=base['mapId']
                or localization.get('mapVersion')!=base['mapVersion']):
            return {**base,'reason':'执行任务与定位地图版本或原点不一致'}
        if (not 0<=now-localization_received<=limit
                or not finite(localization.get('stamp'))
                or not 0<=now_ros-localization['stamp']<=limit
                or localization.get('state')!='FORMAL'
                or localization.get('source')!='synchronized_qr'):
            return {**base,'reason':'正式定位状态缺失或过期'}
        if (pose is None or not all(finite(v) for v in (pose.x,pose.y,pose.yaw,pose.stamp,pose.sigma))
                or not 0<=now-pose_received<=limit or not 0<=now_ros-pose.stamp<=limit):
            return {**base,'reason':'控制位姿缺失或过期'}
        s=executor.segment;phase=executor.phase;points=s['points']
        cross,tangent,remaining,end_distance=geometry(pose,points)
        a,b=points[-2:];length=math.hypot(b['x']-a['x'],b['y']-a['y'])
        along_to_end=((b['x']-pose.x)*(b['x']-a['x'])+(b['y']-pose.y)*(b['y']-a['y']))/length
        stop_phase=phase in ('START_STOP','END_STOP','RECOVER_STOP','TURN_RECENTER')
        boundary=points[-1] if phase=='END_STOP' else points[0]
        tag=s['toId'] if phase=='END_STOP' else s['fromId']
        target_visible=any(o.get('id')==tag for o in observations)
        if phase=='END_STOP':heading=s['endYaw'];reference='区间终点录制朝向'
        elif phase in ('START_STOP','RECOVER_STOP','ALIGN','TURN_RECENTER') or s['mode']=='crab':
            heading=s['bodyYaw'];reference='区间录制车头朝向'
        else:
            heading=wrap(tangent+(math.pi if s['direction']=='reverse' else 0.));reference='当前路径切线对应车头方向'
        heading_error=wrap(pose.yaw-heading)
        heading_limit=(.10 if stop_phase and phase!='RECOVER_STOP' else
                       min(.10,mission.config['max_heading_rad']) if s['mode']=='crab' else mission.config['max_heading_rad'])
        boundary_distance=math.hypot(pose.x-boundary['x'],pose.y-boundary['y'])
        radius=executor.BOUNDARY_POSITION_TOLERANCE_M
        speed=feedback.get('speed');stamp=feedback.get('aggregate_received')
        feedback_fresh=finite(stamp) and 0<=now-stamp<mission.config['feedback_timeout_s']
        stopped=bool(feedback_fresh and finite(speed) and 0<=speed<=mission.config['stopped_speed_mps'])
        mode_ready=bool(feedback_fresh and executor.mode_ready(feedback)) if phase in ('ALIGN','MOVE') else None
        stage={'MOVE':'区间行驶','ALIGN':'换挡确认','START_STOP':'起点停车确认',
               'END_STOP':'终点停车确认','RECOVER_STOP':'暂停恢复停车',
               'CENTER_ALIGN':'横向对中换挡','CENTER_MOVE':'横向对中',
               'CENTER_STOP':'对中停稳确认','TURN_RECENTER':'转向后轮子回正与档位确认'}.get(phase,phase)
        reason='已暂停，保持停车' if mission.paused else stage
        if phase=='MOVE' and not mission.paused:
            if not mode_ready:reason='区间模式或轮角反馈不匹配'
            elif remaining<=.03:reason='末端距离超过边界容差' if end_distance>radius else '进入末端停车确认'
            elif along_to_end<-.045 and remaining<.1:reason='越过区间终点'
            elif abs(cross)>mission.config['max_cross_track_m']:reason='路径侧偏超过阈值'
            elif abs(heading_error)>heading_limit:reason='车头角偏差超过阈值'
            else:reason='按当前区间模式跟踪路线'
        elif phase=='RECOVER_STOP' and not mission.paused:
            reason='等待连续停稳确认后恢复区间模式'
        elif stop_phase and not mission.paused:
            reason=('等待停稳' if not stopped else '等待目标二维码' if not target_visible
                    else '边界位置未进入容差' if boundary_distance>radius
                    else '车头方向未进入容差' if abs(heading_error)>.10 and phase!='RECOVER_STOP'
                    else '等待连续停稳确认')
        elif phase=='TURN_RECENTER' and not mission.paused:
            turn=executor.turn_info if isinstance(getattr(executor,'turn_info',None),dict) else {}
            recenter=turn.get('recenter') or {}
            reason=('等待轮子回正与档位确认（实测转角 %s°，目标 %s°，允许 ±%s°，车体/转向档位 %s/%s）'
                    %(recenter.get('measuredAngleDeg'),recenter.get('targetAngleDeg'),
                      recenter.get('angleToleranceDeg'),recenter.get('bodyGear'),recenter.get('steeringGear')))
        elif phase=='ALIGN' and not mission.paused:
            reason='等待档位或轮角确认' if not mode_ready else '等待连续停稳确认'
        elif phase in ('CENTER_ALIGN','CENTER_MOVE','CENTER_STOP') and not mission.paused:
            centering=getattr(executor,'centering_info',None) or {}
            current=centering.get('endCrossM')
            reason={'CENTER_ALIGN':'等待横移档位确认','CENTER_MOVE':'横移收敛横向偏差',
                    'CENTER_STOP':'等待横移停稳确认'}[phase]
            if finite(current):
                reason+=f"（当前 {current*100:+.1f} cm，目标 {executor.centering_done_cross()*100:.1f} cm）"
        base.update(status='live',reason='',poseStamp=pose.stamp,poseAgeS=max(0.,now_ros-pose.stamp),
                    pose={'x':pose.x,'y':pose.y,'yaw':pose.yaw},
                    segment={'index':executor.index+1,'total':len(executor.segments),'fromId':s['fromId'],'toId':s['toId'],
                             'mode':s['mode'],'direction':s['direction'],'phase':phase,
                             'leg':'return' if executor.index>=executor.outbound_count else 'outbound'},
                    measured={'crossTrackM':cross,'headingErrorRad':heading_error,'headingReference':reference,
                              'remainingM':remaining,'endDistanceM':end_distance,'alongToEndM':along_to_end,
                              'sigmaM':pose.sigma},
                    decision={'stage':stage,'reason':reason,'paused':mission.paused,
                              'crossLimitM':mission.config['max_cross_track_m'] if ((phase=='MOVE' and remaining>.03) or phase in ('END_STOP','CENTER_ALIGN','CENTER_MOVE','CENTER_STOP')) else None,
                              'centeringTriggerM':executor.centering_trigger_cross() if phase in ('END_STOP','CENTER_ALIGN','CENTER_MOVE','CENTER_STOP') else None,
                              'centeringDoneM':executor.centering_done_cross() if phase in ('END_STOP','CENTER_ALIGN','CENTER_MOVE','CENTER_STOP') else None,
                              'headingLimitRad':heading_limit if (phase=='MOVE' and remaining>.03) or (stop_phase and phase!='RECOVER_STOP') else None,
                              'boundaryRadiusM':radius if stop_phase or phase=='MOVE' else None,
                              'boundaryDistanceM':boundary_distance if stop_phase else end_distance if phase=='MOVE' else None,
                              'boundaryTagId':tag if stop_phase else s['toId'],
                              'targetTagVisible':target_visible if stop_phase else any(o.get('id')==s['toId'] for o in observations),
                              'stopped':stopped,'stopRequiredFrames':mission.config['stable_feedback_samples'],
                              'modeReady':mode_ready,'stopRemainingM':.03 if phase=='MOVE' else None})
        # Structured turn / turn-exit / centering diagnostics (never only Chinese event text).
        turn=getattr(executor,'turn_info',None)
        exit_info=getattr(executor,'exit_info',None)
        centering=getattr(executor,'centering_info',None)
        base['turn']=copy.deepcopy(turn) if isinstance(turn,dict) else {}
        base['turnExit']=copy.deepcopy(exit_info) if isinstance(exit_info,dict) else {}
        # 末段动态制动闭环的同一制动度量（速度/制动距离/预测停车误差/零速样本）。
        brake=getattr(executor,'endpoint_brake',None)
        base['endpointBrake']=copy.deepcopy(brake) if isinstance(brake,dict) else {}
        base['centering']=copy.deepcopy(centering) if isinstance(centering,dict) else {}
        history=getattr(executor,'centering_history',None)
        base['centeringHistory']=copy.deepcopy(history) if isinstance(history,list) else []
        dr_state=getattr(executor,'dr_state',None)
        dr_history=getattr(executor,'dr_history',None)
        if isinstance(dr_state,dict):
            base['deadReckoning']={
                'active':dr_state.get('segment_index')==executor.index and phase=='MOVE',
                'decision':dr_state.get('last_decision'),
                'predictedPose':dr_state.get('predictedPose'),
                'predictedCrossM':dr_state.get('crossM'),
                'predictedHeadingDeg':round(math.degrees((dr_state.get('predictedPose') or {}).get('yaw',0.)),1) if dr_state.get('predictedPose') else None,
                'staleS':dr_state.get('staleS'),'anchorStamp':dr_state.get('anchor_stamp'),
                'crossTrackTargetM':executor.dr_target() if hasattr(executor,'dr_target') else None,
                'correctionCount':dr_state.get('corrections'),
                'qrCorrectionResidual':{k:(dr_state.get('last_residual') or {}).get(k) for k in ('lateralResidualM','headingResidualDeg','decision')} if dr_state.get('last_residual') else None,
                'corrections':copy.deepcopy(dr_history[-4:]) if isinstance(dr_history,list) else [],
            }
        else:
            base['deadReckoning']={'active':False,'decision':'idle'}
        jump=getattr(executor,'localization_jump',None)
        base['localizationJump']=copy.deepcopy(jump) if isinstance(jump,dict) else {}
        calibration=mission.config.get('turn_calibration') if hasattr(mission,'config') else None
        base['calibration']=copy.deepcopy(calibration) if isinstance(calibration,dict) else {}
        return base

    def finalize(self, sample, mission):
        if self.held is not None and mission.state in ('FAULT','FINISHED'):
            return copy.deepcopy(self.held)
        sample['controllerState']=mission.state
        if mission.state in ('FAULT','FINISHED'):
            if sample['status']!='live' and self.last_live is not None:
                unavailable_reason=sample['reason']
                sample=copy.deepcopy(self.last_live)
                sample['controllerState']=mission.state
                sample['status']='held'
                sample['reason']='最后有效快照，非故障瞬时位姿：'+unavailable_reason
            elif sample['status']=='live':
                sample['status']='held'
                sample['reason']='故障时快照' if mission.state=='FAULT' else '完成时快照'
            if sample.get('decision') is not None:
                sample['decision']['outcome']=mission.events[0] if mission.events else mission.state
            self.held=copy.deepcopy(sample)
        elif sample['status']=='live':
            self.last_live=copy.deepcopy(sample)
        return sample
