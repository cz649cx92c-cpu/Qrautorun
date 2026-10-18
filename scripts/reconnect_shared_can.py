#!/usr/bin/env python3
"""Recreate the shared mature receive driver; no motion or unlock commands.

Matches autorunlida's documented fault-recovery order: stop only the exact idle
CAN driver, call its existing connect API, then start the unchanged driver.
The running autorunlida application and all control publishers remain intact.
"""
import argparse
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import time
from urllib.request import Request,build_opener,ProxyHandler

ROOT=Path(__file__).resolve().parents[1]
BINARY=Path('/home/orangepi/ugv/install/yhs_can_control/lib/yhs_can_control/yhs_can_control_node')
PARAMS=Path('/home/orangepi/ugv/install/yhs_can_control/share/yhs_can_control/params/cfg.yaml')
OPENER=build_opener(ProxyHandler({}))


def state(body=None):
    path='/api/state' if body is None else '/api/connect_can'
    req=Request('http://127.0.0.1:8765'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with OPENER.open(req,timeout=12) as response:return json.load(response)


def drivers():
    found=[]
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():continue
        try:
            args=[s.decode() for s in (p/'cmdline').read_bytes().split(b'\0') if s]
            if not args or args[0]!=str(BINARY):continue
            if p.stat().st_uid!=os.getuid():raise RuntimeError('CAN driver owner differs')
            expected=['--ros-args','--params-file',str(PARAMS),'-p','can_name:=can0']
            if args[1:] not in (expected,expected+['--disable-external-lib-logs']):
                raise RuntimeError('CAN driver command differs; no process stopped')
            stat=(p/'stat').read_text().rpartition(')')[2].split()
            if stat[0]!='Z':found.append({'pid':int(p.name),'startTicks':stat[19]})
        except (FileNotFoundError,ProcessLookupError,UnicodeError):pass
    return found


def idle(data):
    if data.get('task_status')!='Idle' or data.get('gamepad_control',{}).get('enabled'):
        raise RuntimeError('Existing application is in use; no reconnect')
    v=data.get('vehicle_status',{})
    if v.get('feedback_fresh'):
        m=v.get('motion',{})
        speeds=[float(m.get(key,0)) for key in ('vx','vy','wz')]
        if not all(math.isfinite(value) for value in speeds) or abs(speeds[0])>.002 or abs(speeds[1])>.002 or abs(speeds[2])>.1:
            raise RuntimeError('Vehicle motion is unknown or active; no reconnect')
        if v.get('io',{}).get('remote_control'):raise RuntimeError('Manual takeover active; no reconnect')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reconnect',action='store_true')
    parser.add_argument('--use-mature-bringup',action='store_true')
    args=parser.parse_args();before=state();idle(before);existing=drivers()
    if len(existing)>1:raise RuntimeError('Multiple CAN drivers; no reconnect')
    output={'motionCommandsSent':0,'unlockCommandsSent':0,'sourceModified':False,
            'applicationRestarted':False,'beforeCanStatus':before.get('can_status'),'driversBefore':existing}
    if not args.reconnect or before.get('vehicle_status',{}).get('feedback_fresh'):
        output['reconnected']=False;print(json.dumps(output,ensure_ascii=False));return
    if before.get('settings',{}).get('can_channel')!='can0' or int(before['settings'].get('can_bitrate',0))!=500000:
        raise RuntimeError('CAN configuration mismatch')
    for item in existing:
        if item not in drivers():raise RuntimeError('Driver changed before reconnect')
        idle(state());os.kill(item['pid'],signal.SIGINT)
    deadline=time.monotonic()+5
    while drivers() and time.monotonic()<deadline:time.sleep(.1)
    if drivers():raise RuntimeError('Old CAN driver did not exit; no competing driver started')
    connect_error=None
    try:
        if args.use_mature_bringup:
            reply=subprocess.run(['sudo','-n','/usr/local/bin/bringup_can0.sh','can0','500000'],capture_output=True,text=True,timeout=8)
            output['bringupReply']={'returnCode':reply.returncode,'stdout':reply.stdout[-1500:],'stderr':reply.stderr[-1500:]}
            reply.check_returncode()
        else:output['connectReply']=state({'channel':'can0','bitrate':500000})
    except Exception as error:connect_error=str(error);output['connectError']=connect_error
    # Always restore a single receive driver if the old one has exited.
    # The mature application's own recovery may already have recreated it.
    if not drivers():
        launch='source /opt/ros/humble/setup.bash; source /home/orangepi/ugv/install/setup.bash; exec /home/orangepi/ugv/install/yhs_can_control/lib/yhs_can_control/yhs_can_control_node --ros-args --params-file /home/orangepi/ugv/install/yhs_can_control/share/yhs_can_control/params/cfg.yaml -p can_name:=can0 --disable-external-lib-logs'
        subprocess.run(['systemd-run','--user','--collect','--unit=qr-shared-can-driver-'+str(time.monotonic_ns())+'.service',
            '--property=WorkingDirectory='+str(ROOT),'--property=KillSignal=SIGINT',
            '--property=StandardOutput=journal','--property=StandardError=journal',
            '--property=LogRateLimitIntervalSec=30s','--property=LogRateLimitBurst=30',
            '--setenv=ROS_LOG_DIR='+str(ROOT/'logs/ros'),'/bin/bash','-c',launch],check=True,timeout=10)
    samples=[];deadline=time.monotonic()+10
    while time.monotonic()<deadline:
        data=state();v=data.get('vehicle_status',{})
        samples.append({'state':data.get('can_status'),'fresh':v.get('feedback_fresh'),'seq':v.get('_seq'),'ageMs':v.get('feedback_age_ms')})
        if v.get('feedback_fresh'):break
        time.sleep(.25)
    output.update(reconnected=True,samples=samples,driversAfter=drivers(),feedbackRecovered=bool(data.get('vehicle_status',{}).get('feedback_fresh')),
        interfaceCounters={name:int((Path('/sys/class/net/can0/statistics')/name).read_text()) for name in ('rx_packets','tx_packets','rx_errors','tx_errors')})
    (ROOT/'logs/shared-can-reconnect-result.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in output.items() if k!='samples'},ensure_ascii=False))
    if connect_error:raise RuntimeError(connect_error)


if __name__=='__main__':main()
