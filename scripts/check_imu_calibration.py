#!/usr/bin/env python3
"""Passive live-data statistics for the unchanged stationary calibration gates."""
import json,time,math,sys
from pathlib import Path
import numpy as np
import rclpy
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Imu
from std_msgs.msg import String
W=Path('/home/orangepi/ugv/QRautorun/qr_navigation_ws')
sys.path.insert(0,str(W/'src/greenhouse_navigation'))
from greenhouse_navigation.fusion import StationaryCalibration

def main():
    rclpy.init(args=['--ros-args','--disable-external-lib-logs'])
    n=rclpy.create_node('imu_calibration_statistics',enable_rosout=False,start_parameter_services=False)
    samples=[];statuses=[];subs=[]
    subs.append(n.create_subscription(Imu,'/qr/imu/raw',samples.append,qos_profile_sensor_data))
    def status(msg):
        try:statuses.append(json.loads(msg.data))
        except ValueError:pass
    subs.append(n.create_subscription(String,'/qr/fusion/status',status,qos_profile_sensor_data))
    try:
        start=time.monotonic()
        while time.monotonic()-start<28. and len(samples)<550:rclpy.spin_once(n,timeout_sec=.1)
        gyro=np.array([[m.angular_velocity.x,m.angular_velocity.y,m.angular_velocity.z] for m in samples])
        accel=np.array([[m.linear_acceleration.x,m.linear_acceleration.y,m.linear_acceleration.z] for m in samples])
        stamps=np.array([m.header.stamp.sec+m.header.stamp.nanosec/1e9 for m in samples])
        report={'time':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'samples':len(samples),'thresholdsUnchanged':True,'gyroStdLimit':.005,'accelerationStdLimit':.15,'gyroNormLimit':.02,'requiredSamples':500,'requiredDurationS':5.,'lastFusion':statuses[-1] if statuses else None}
        if len(samples)>=500:
            g=gyro[:500];a=accel[:500];delta=np.diff(stamps[:500])
            report.update(gyroMean=np.mean(g,axis=0).tolist(),gyroStd=np.std(g,axis=0).tolist(),gyroMin=np.min(g,axis=0).tolist(),gyroMax=np.max(g,axis=0).tolist(),accelerationMean=np.mean(a,axis=0).tolist(),accelerationStd=np.std(a,axis=0).tolist(),gyroNormRange=[float(np.min(np.linalg.norm(g,axis=1))),float(np.max(np.linalg.norm(g,axis=1)))],accelerationNormRange=[float(np.min(np.linalg.norm(a,axis=1))),float(np.max(np.linalg.norm(a,axis=1)))],durationS=float(stamps[499]-stamps[0]),maxStampGapS=float(np.max(delta)),strictlyIncreasing=bool(np.all(delta>0)))
            report['windowRejectReasons']=[]
            if np.max(np.std(g,axis=0))>.005:report['windowRejectReasons'].append('gyro per-axis std > 0.005 rad/s')
            if np.max(np.std(a,axis=0))>.15:report['windowRejectReasons'].append('acceleration per-axis std > 0.15 m/s^2')
            if np.max(np.linalg.norm(g,axis=1))>.02:report['windowRejectReasons'].append('gyro norm > 0.02 rad/s')
            if np.min(np.linalg.norm(a,axis=1))<8.5 or np.max(np.linalg.norm(a,axis=1))>11.:report['windowRejectReasons'].append('acceleration norm outside [8.5,11] m/s^2')
            if np.max(delta)>.1 or np.any(delta<=0):report['windowRejectReasons'].append('non-increasing stamp or gap >0.1 s')
            for axis in range(3):
                values,counts=np.unique(g[:,axis],return_counts=True)
                report['gyroAxis'+str(axis)+'ObservedValues']=[{'value':float(v),'count':int(c)} for v,c in zip(values,counts)]
            cal=StationaryCalibration()
            for stamp,g,a in zip(stamps[:500],g,a):cal.add(float(stamp),g,a,True)
            report['unchangedCalibrationReplayResult']=cal.result
        out=W/'logs/imu-replacement-calibration-statistics.json'
        out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
        print('REPORT',out,flush=True)
    finally:n.destroy_node();rclpy.shutdown()
if __name__=='__main__':main()
