#!/usr/bin/env python3
"""Controlled serial IMU consumer reload. Never enables motion or starts the full stack."""
import os,sys,time,json,math,hashlib,subprocess,argparse
from pathlib import Path
from urllib.request import build_opener,ProxyHandler
W=Path('/home/orangepi/ugv/QRautorun/qr_navigation_ws')
CWD=Path('/home/orangepi/hermes xiangmu')
REPORT=W/'logs/imu-replacement-consumer-reload.json'
if os.environ.get('QR_IMU_RELOAD_ROS_READY')!='1':
    setup=('source /opt/ros/humble/setup.bash\n'
           'source /home/orangepi/ugv/install/setup.bash\n'
           'source /home/orangepi/ugv/QRautorun/qr_navigation_ws/install/setup.bash\n'
           'export PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 QR_IMU_RELOAD_ROS_READY=1\n'
           'exec /usr/bin/python3 -B "$@"')
    os.execv('/bin/bash',['bash','--noprofile','--norc','-c',setup,'imu-reload',str(Path(__file__).resolve()),*sys.argv[1:]])
import rclpy
from rclpy.qos import qos_profile_sensor_data
from std_msgs.msg import String
from yhs_can_interfaces.msg import ChassisInfoFb
COMMAND_TOPICS=('/ctrl_cmd','/steering_ctrl_cmd','/io_cmd')

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--apply',action='store_true');args=ap.parse_args()
    if Path.cwd()!=CWD:raise SystemExit('Wrong cwd')
    report={'time':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'operations':[],'completeSourceSwitch':False,'motionEnabled':False,'physicalDirectionCalibrationCompleted':False}
    opener=build_opener(ProxyHandler({}));n=None
    def http():
        with opener.open('http://127.0.0.1:3080/api/robot/status',timeout=3) as response:
            return response.status,json.load(response)
    def records():
        return {name:json.loads((W/'logs/services'/(name+'.json')).read_text()) for name in ['imu','robot','fusion','vision','localization','draft-capture'] if (W/'logs/services'/(name+'.json')).exists()}
    def idle(d):
        return d.get('running') is False and d.get('state')=='IDLE' and isinstance(d.get('speed'),(float,int)) and math.isfinite(d['speed']) and abs(d['speed'])<=.002
    def command_publishers():
        return {t:[p.node_name for p in n.get_publishers_info_by_topic(t)] for t in COMMAND_TOPICS}
    def run_manager(action,name,extra=()):
        cmd=['/usr/bin/python3','-B',str(W/'scripts/service_manager.py'),action,name,*extra]
        print('EXECUTE',cmd,flush=True)
        proc=subprocess.run(cmd,capture_output=True,text=True,timeout=35)
        report['operations'].append({'command':cmd,'exit':proc.returncode,'stdout':proc.stdout,'stderr':proc.stderr})
        print('EXIT',proc.returncode,flush=True)
        if proc.returncode:raise RuntimeError('Scoped service operation failed: '+action+' '+name)
    def spin(seconds):
        end=time.monotonic()+seconds
        while time.monotonic()<end:rclpy.spin_once(n,timeout_sec=.1)
    try:
        digest=lambda:hashlib.sha256((W/'config/navigation.yaml').read_bytes()).hexdigest()
        report['navigationConfigBeforeSha256']=digest();report['servicesBefore']=records()
        for name in ['robot','fusion']:
            proc=subprocess.run(['systemctl','--user','show','qr-navigation-bridge.service' if name=='robot' else 'qr-navigation-fusion.service','--property=Id,ActiveState,ExecStart,WorkingDirectory'],capture_output=True,text=True,timeout=5,check=True)
            if str(W/'scripts/service_manager.py')+' _supervise '+name not in proc.stdout or 'WorkingDirectory='+str(W) not in proc.stdout or 'ActiveState=active' not in proc.stdout:
                raise RuntimeError('Existing service identity mismatch: '+name)
        rclpy.init(args=['--ros-args','--disable-external-lib-logs'])
        n=rclpy.create_node('imu_consumer_reload_guard_'+str(os.getpid()),enable_rosout=False,start_parameter_services=False)
        nav=[];fb=[];fusion=[];imu=[];subs=[]
        def decoded(target,msg):
            try:target.append((time.monotonic(),json.loads(msg.data)))
            except ValueError:pass
        for topic,target in [('/qr/navigation/status',nav),('/qr/fusion/status',fusion),('/qr/imu/status',imu)]:
            subs.append(n.create_subscription(String,topic,lambda m,t=target:decoded(t,m),qos_profile_sensor_data))
        subs.append(n.create_subscription(ChassisInfoFb,'/chassis_info_fb',lambda m:fb.append((time.monotonic(),m)),qos_profile_sensor_data))
        code,web=http();report['httpBefore']={'code':code,**{k:web.get(k) for k in ['connected','running','state','speed','taskId']}}
        if code!=200 or web.get('connected') is not True or not idle(web):raise RuntimeError('Robot is not IDLE/stationary')
        spin(4.5);now=time.monotonic();rosnow=n.get_clock().now().nanoseconds/1e9
        recent=[(t,d) for t,d in nav if now-t<=4.]
        if len(recent)<20 or now-recent[-1][0]>.25 or not all(idle(d) for _,d in recent):raise RuntimeError('Fresh continuous IDLE not established')
        if not all(b.get('seq',0)>a.get('seq',0) for (_,a),(_,b) in zip(recent,recent[1:])):raise RuntimeError('Navigation telemetry not advancing')
        last=recent[-1][1];gates={v['id']:v.get('ready') for v in last.get('conditions',[])}
        if gates.get('imu') is not False or n.get_publishers_info_by_topic('/odin1/imu'):raise RuntimeError('Old navigation execution remains unguarded: expected no old IMU publisher and blocked IMU gate')
        if any(command_publishers().values()):raise RuntimeError('Existing motion/IO publisher detected; cannot guarantee zero-command shutdown')
        fresh=[m for t,m in fb if now-t<=1.]
        def stationary(m):
            vs=[m.ctrl_fb.ctrl_fb_x_linear,m.ctrl_fb.ctrl_fb_y_linear,m.steering_ctrl_fb.steering_ctrl_fb_velocity,m.lf_wheel_fb.lf_wheel_fb_velocity,m.rf_wheel_fb.rf_wheel_fb_velocity,m.lr_wheel_fb.lr_wheel_fb_velocity,m.rr_wheel_fb.rr_wheel_fb_velocity]
            return all(math.isfinite(v) and abs(v)<=.002 for v in vs) and math.isfinite(m.ctrl_fb.ctrl_fb_z_angular) and abs(m.ctrl_fb.ctrl_fb_z_angular)<=.1
        if len(fresh)<10 or not all(stationary(m) for m in fresh) or not 0<=rosnow-fresh[-1].header.stamp.sec-fresh[-1].header.stamp.nanosec/1e9<.25:raise RuntimeError('Fresh chassis/all-wheel standstill not proven')
        if not imu or now-imu[-1][0]>2.5 or imu[-1][1].get('source')!='Yahboom serial' or imu[-1][1].get('online') is not True:raise RuntimeError('New serial source not healthy')
        report['preconditions']={'freshIdleSamples':len(recent),'freshStationaryFeedbackSamples':len(fresh),'oldImuGate':gates['imu'],'commandPublishers':command_publishers(),'queueBoundary':'Queue not observable in old telemetry. Stop old consumer while old-IMU execution gate is blocked; confirm process exit, clearing local pending/queue. New consumer has execution=false and maintenance_mode=true, refuses starts and does not fetch persistent commands. No empty-queue claim.'}
        print('PRECONDITIONS',json.dumps(report['preconditions'],ensure_ascii=False),flush=True)
        if not args.apply:
            report['result']='AUDIT_ONLY';return 0
        code,web=http()
        if code!=200 or not idle(web) or any(command_publishers().values()):raise RuntimeError('State changed immediately before stop')
        run_manager('stop','robot')
        prior=report['servicesBefore']['robot'].get('process') or {};oldpid=prior.get('pid')
        if oldpid and (Path('/proc')/str(oldpid)).exists():raise RuntimeError('Old consumer not fully exited; no fusion restart attempted')
        spin(1.)
        if any(command_publishers().values()):raise RuntimeError('Unexpected command publisher after old consumer exit')
        run_manager('start','robot',['--imu-maintenance'])
        nav.clear();deadline=time.monotonic()+10.
        while time.monotonic()<deadline:
            rclpy.spin_once(n,timeout_sec=.1)
            if nav:
                d=nav[-1][1];maintenance=d.get('maintenance',{})
                if idle(d) and maintenance.get('active') is True and maintenance.get('executionEnabled') is False and maintenance.get('taskCommandPolling') is False and maintenance.get('pendingStart') is False and maintenance.get('queuedLocalCommands')==0:break
        else:raise RuntimeError('New consumer maintenance isolation not verified; fusion untouched')
        report['maintenanceBeforeFusion']=nav[-1][1]['maintenance']
        if any(command_publishers().values()):raise RuntimeError('Maintenance consumer produced forbidden command publisher')
        run_manager('stop','fusion');run_manager('start','fusion')
        report['fusionRestartAt']=time.time();fusion.clear();start=time.monotonic();notice=10.
        while time.monotonic()-start<100.:
            rclpy.spin_once(n,timeout_sec=.1)
            elapsed=time.monotonic()-start;latest=fusion[-1][1] if fusion else {};cal=latest.get('calibration') or {}
            if elapsed>=notice:
                print('CALIBRATION',{'seconds':round(elapsed,1),'state':latest.get('state'),'samples':latest.get('calibrationSamples'),'calibratedCount':cal.get('sampleCount'),'reason':latest.get('reason')},flush=True);notice+=10.
            if nav and (not idle(nav[-1][1]) or nav[-1][1].get('maintenance',{}).get('executionEnabled') is not False):raise RuntimeError('Maintenance state changed; do not enable or issue motion')
            if any(command_publishers().values()):raise RuntimeError('Unexpected motion publisher during validation')
            if elapsed>=24. and latest.get('ready') is True and latest.get('imuSourceHealthy') is True and cal.get('sampleCount',0)>=500 and cal.get('durationS',0)>=5. and cal.get('stamp',0)>report['fusionRestartAt']:break
        report['latestFusion']=fusion[-1][1] if fusion else None
        proc=subprocess.run(['/usr/bin/python3','-B',str(W/'scripts/check_imu_source.py'),'--require-complete'],capture_output=True,text=True,timeout=18)
        print('SOURCE READBACK',proc.stdout,proc.stderr,'exit',proc.returncode,flush=True)
        if not proc.stdout:raise RuntimeError('Missing source readback')
        report['sourceReadback']=json.loads(proc.stdout)
        report['completeSourceSwitch']=proc.returncode==0 and report['sourceReadback'].get('completeSourceSwitch') is True
        code,web=http();report['httpAfter']={'code':code,**{k:web.get(k) for k in ['connected','running','state','speed','taskId','conditions','maintenance','sensors']}}
        report['commandPublishersAfter']=command_publishers()
        report['navigationConfigAfterSha256']=digest()
        report['servicesAfter']=records()
        report['unaffectedServiceProcessIdentityUnchanged']={name:old.get('process')==report['servicesAfter'].get(name,{}).get('process') for name,old in report['servicesBefore'].items() if name not in ['robot','fusion']}
        report['result']='SOURCE_SWITCH_COMPLETE_MAINTENANCE_EXECUTION_DISABLED' if report['completeSourceSwitch'] else 'SOURCE_SWITCH_INCOMPLETE_EXECUTION_DISABLED'
        if digest()!=report['navigationConfigBeforeSha256']:raise RuntimeError('Navigation disk config changed during maintenance')
        return 0 if report['completeSourceSwitch'] else 2
    except Exception as error:
        report['result']='STOPPED_ON_VALIDATION_FAILURE';report['error']=type(error).__name__+': '+str(error)
        print('STOP',report['error'],flush=True);return 3
    finally:
        if n is not None:n.destroy_node();rclpy.try_shutdown()
        REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print('REPORT',REPORT,'RESULT',report.get('result'),flush=True)

if __name__=='__main__':raise SystemExit(main())
