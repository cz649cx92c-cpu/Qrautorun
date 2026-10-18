#!/usr/bin/env python3
"""Explicit hardware check of mature zero-speed initialization; never navigates."""
import argparse
import json
import math
from pathlib import Path
import sys
import time

import rclpy
from rclpy.qos import qos_profile_sensor_data
from yhs_can_interfaces.msg import ChassisInfoFb,CtrlCmd,SteeringCtrlCmd,IoCmd
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.control import Command
from greenhouse_navigation.motion_interface import ExistingMotionInterface,COMMAND_TOPICS


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--align-zero-speed',action='store_true',required=True)
    parser.add_argument('--output',type=Path,default=ROOT/'logs/mature-zero-speed-alignment-20261015.json')
    args=parser.parse_args()
    rclpy.init();node=rclpy.create_node('qr_mature_zero_speed_check')
    sample=None;received=0.;sequence=0;history=[];max_speed=0.;motion=None
    result={'zeroSpeedCommandsOnly':True,'translationCommandsSent':0,'aligned':False,'samples':history,'observedCommands':{'body':0,'steering':0,'io':0},'commandCodeCounts':{}}
    def observe_command(kind,msg):
        result['observedCommands'][kind]+=1
        if kind in ('body','steering'):
            code=str(msg.ctrl_cmd_gear);counts=result['commandCodeCounts'].setdefault(kind,{})
            counts[code]=counts.get(code,0)+1
        if kind=='body' and any(abs(v)>1e-9 for v in (msg.ctrl_cmd_x_linear,msg.ctrl_cmd_y_linear,msg.ctrl_cmd_z_angular)):
            result['translationCommandsSent']+=1
    for topic,kind,typ in (('/ctrl_cmd','body',CtrlCmd),('/steering_ctrl_cmd','steering',SteeringCtrlCmd),('/io_cmd','io',IoCmd)):
        node.create_subscription(typ,topic,lambda msg,kind=kind:observe_command(kind,msg),10)
    def receive(msg):
        nonlocal sample,received,sequence,max_speed
        now_ros=node.get_clock().now().nanoseconds/1e9
        stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
        if not 0<=now_ros-stamp<.3:return
        sample=msg;received=time.monotonic();sequence+=1
        speeds=[msg.ctrl_fb.ctrl_fb_x_linear,msg.ctrl_fb.ctrl_fb_y_linear*.1,
                msg.steering_ctrl_fb.steering_ctrl_fb_velocity,
                msg.lf_wheel_fb.lf_wheel_fb_velocity,msg.rf_wheel_fb.rf_wheel_fb_velocity,
                msg.lr_wheel_fb.lr_wheel_fb_velocity,msg.rr_wheel_fb.rr_wheel_fb_velocity]
        max_speed=max(max_speed,*(abs(v) for v in speeds))
    node.create_subscription(ChassisInfoFb,'/chassis_info_fb',receive,qos_profile_sensor_data)
    def safe():
        return (sample is not None and time.monotonic()-received<.3
                and not sample.io_fb.io_fb_estop and not sample.io_fb.io_fb_joypad_ctrl
                and not sample.io_fb.io_fb_charge_state and max_speed<=.015)
    def record():
        if sample is None:return None
        fb=sample
        row={'at':time.time(),'seq':sequence,'bodyCode':fb.ctrl_fb.ctrl_fb_gear,
             'steeringCode':fb.steering_ctrl_fb.steering_ctrl_fb_gear,
             'vx':fb.ctrl_fb.ctrl_fb_x_linear,'vy':fb.ctrl_fb.ctrl_fb_y_linear*.1,
             'unlock':fb.io_fb.io_fb_unlock,
             'angles':[fb.front_angle_fb.front_angle_fb_l,fb.front_angle_fb.front_angle_fb_r,
                       fb.rear_angle_fb.rear_angle_fb_l,fb.rear_angle_fb.rear_angle_fb_r]}
        history.append(row);return row
    try:
        deadline=time.monotonic()+4
        while not safe() and time.monotonic()<deadline:rclpy.spin_once(node,timeout_sec=.02)
        if not safe():raise RuntimeError('未收到停稳且无人工接管/急停的真实反馈')
        for topic in COMMAND_TOPICS:
            if node.count_publishers(topic):raise RuntimeError('已有控制发布者，拒绝争用：'+topic)
        motion=ExistingMotionInterface(True,publisher_snapshot=lambda:{topic:node.get_publishers_info_by_topic(topic) for topic in COMMAND_TOPICS},node_snapshot=node.get_node_names_and_namespaces,command_allowed=safe)
        deadline=time.monotonic()+5;prepared=False
        while time.monotonic()<deadline:
            rclpy.spin_once(node,timeout_sec=.02)
            if motion.prepare():prepared=True;break
        if not prepared:raise RuntimeError('成熟接口发布者发现未完成')
        result['senderSource']=motion.api.sender_source
        result['subscribers']={topic:[endpoint.node_name for endpoint in node.get_subscriptions_info_by_topic(topic)] for topic in COMMAND_TOPICS}
        start=time.monotonic();next_send=start;next_log=start;stable=0;previous_seq=None
        while time.monotonic()-start<8.:
            rclpy.spin_once(node,timeout_sec=.01);now=time.monotonic()
            if not safe():raise RuntimeError('零速检查实时反馈/急停/人工接管条件失效')
            if now>=next_send:
                if not motion.send(Command(),'INITIALIZING'):raise RuntimeError('成熟接口未接受零速初始化')
                next_send=now+.05
            if now>=next_log:
                row=record();print(json.dumps(row,ensure_ascii=False),flush=True);next_log=now+.5
            if sequence!=previous_seq:
                previous_seq=sequence
                angles=[sample.front_angle_fb.front_angle_fb_l,sample.front_angle_fb.front_angle_fb_r,
                        sample.rear_angle_fb.rear_angle_fb_l,sample.rear_angle_fb.rear_angle_fb_r]
                aligned=(sample.ctrl_fb.ctrl_fb_gear==6 and sample.steering_ctrl_fb.steering_ctrl_fb_gear==6
                         and all(math.isfinite(a) and abs(a)<=3. for a in angles))
                stable=stable+1 if aligned else 0
                if stable>=5 and now-start>=.6:
                    result['aligned']=True;break
        result['durationSeconds']=round(time.monotonic()-start,3)
        if not result['aligned']:raise RuntimeError('成熟模块零速初始化未得到车体6、转向反馈6和四轮回正')
    except Exception as error:
        result['error']=str(error)
    finally:
        result['maxObservedSpeedMps']=max_speed
        if motion is not None:
            result['matureRuntime']=motion.sender.feedback_snapshot() if motion.sender is not None else None
            motion.close()
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        node.destroy_node();rclpy.try_shutdown()
    print(json.dumps({key:value for key,value in result.items() if key!='samples'},ensure_ascii=False,indent=2),flush=True)
    return 0 if result['aligned'] else 1

if __name__=='__main__':raise SystemExit(main())
