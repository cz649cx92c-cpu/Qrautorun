#!/usr/bin/env python3
"""本工程摄像头共享流与实时检测独立启停，不开启原Odin视觉。"""
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import yaml
import rclpy
from greenhouse_navigation.camera_handoff import legacy_preview_matches
from urllib.request import build_opener,ProxyHandler

ROOT=Path(__file__).resolve().parents[1]
try:
    with build_opener(ProxyHandler({})).open('http://127.0.0.1:3080/api/camera/status',timeout=2) as response:
        status=json.load(response)
    if not status.get('present'):raise ValueError('HBVCAM尚未连接')
except Exception as error:raise SystemExit('请先启动网页并连接HBVCAM：'+str(error))
import websocket
rclpy.init();node=rclpy.create_node('qr_vision_preflight');end=time.monotonic()+1.5
while time.monotonic()<end:rclpy.spin_once(node,timeout_sec=.1)
conflicts=[topic for topic in ('/qr/camera/image/compressed','/qr/detector/status','/qr/tags/observations') if node.count_publishers(topic)]
node.destroy_node();rclpy.shutdown()
if conflicts:raise SystemExit('已有发布者，拒绝争用：'+','.join(conflicts))

def handoff_known_preview():
    """只释放已读源码核实的旧纯预览占用者，保留原CAN/手柄/雷达服务。"""
    configuration=yaml.safe_load((ROOT/'config/camera_stream.yaml').read_text())['qr_camera_stream']['ros__parameters']
    if not configuration.get('handoff_legacy_preview',False):return
    topic=configuration.get('compat_preview_topic')
    if topic!='/autorun_final/uvc_preview/compressed':raise ValueError('旧预览接管必须同时提供已确认的兼容画面Topic')
    device=Path(json.loads((ROOT/'config/camera_preview.json').read_text())['device']).resolve()
    stopped=[]
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():continue
        try:
            command=[p.decode() for p in (entry/'cmdline').read_bytes().split(b'\0') if p]
            if not legacy_preview_matches(command,device,topic):continue
            if not any(fd.resolve()==device for fd in (entry/'fd').iterdir()):continue
            pid=int(entry.name)
            os.kill(pid,signal.SIGTERM)
            stopped.append({'pid':pid,'cameraPreviewCommand':command})
        except (OSError,UnicodeError,ValueError,IndexError):continue
    if not stopped:return
    (ROOT/'logs/camera-handoff.json').write_text(json.dumps({'stopped':stopped,'sourceModified':False,'chassisStopped':False,'replacementTopic':topic},ensure_ascii=False,indent=2)+'\n')
    time.sleep(.4)
    ws=websocket.create_connection('ws://127.0.0.1:3080/ws/camera',timeout=2,http_no_proxy=['127.0.0.1','localhost'])
    try:ws.send(json.dumps({'type':'restart'}))
    finally:ws.close()
    print('旧纯预览已移交到共享采集，原预览Topic继续接收真实画面',flush=True)

pid_file=ROOT/'logs/vision.pid';pid_file.write_text(str(os.getpid()));children=[]
def interrupted(*_):raise KeyboardInterrupt
signal.signal(signal.SIGINT,interrupted);signal.signal(signal.SIGTERM,interrupted)
result=0
try:
    for executable,config in (('camera_stream','camera_stream.yaml'),('detector','camera_last.yaml')):
        children.append(subprocess.Popen(['/usr/bin/python3',str(ROOT/'install/greenhouse_navigation/lib/greenhouse_navigation'/executable),'--ros-args','--params-file',str(ROOT/'config'/config)]))
    time.sleep(.7)
    handoff_known_preview()
    while True:
        if any(child.poll() is not None for child in children):raise RuntimeError('识别子进程退出')
        time.sleep(.2)
except KeyboardInterrupt:pass
except Exception as error:print(str(error),flush=True);result=1
finally:
    signal.signal(signal.SIGINT,signal.SIG_IGN);signal.signal(signal.SIGTERM,signal.SIG_IGN)
    for child in children:
        if child.poll() is None:child.send_signal(signal.SIGINT)
    for child in children:
        try:child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:child.wait(timeout=2)
            except subprocess.TimeoutExpired:child.kill();child.wait()
    if pid_file.exists() and pid_file.read_text().strip()==str(os.getpid()):pid_file.unlink()
raise SystemExit(result)
