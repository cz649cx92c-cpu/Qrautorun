#!/usr/bin/env python3
"""将已结束的真实实测记录保存为点位草稿，不发布任何ROS消息。"""
import json
import math
import sqlite3
import sys
from collections import deque
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler
from rclpy.serialization import deserialize_message
from rosidl_runtime_py.utilities import get_message

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.control import wrap
from greenhouse_navigation.draft_capture import interpolate_pose

active=json.loads((ROOT/'logs/motion-tests/active.json').read_text())
folder=Path(active['folder']).resolve()
if not folder.is_relative_to((ROOT/'logs/motion-tests').resolve()):raise SystemExit('记录路径无效')
if not (folder/'rosbag/metadata.yaml').exists():raise SystemExit('请先停止并保存记录')
meta=json.loads((folder/'test.json').read_text())
opener=build_opener(ProxyHandler({}))
def api(path,data=None):
    request=Request('http://127.0.0.1:3080/api'+path,
        data=None if data is None else json.dumps(data,ensure_ascii=False).encode(),
        headers={'Content-Type':'application/json'})
    with opener.open(request,timeout=10) as response:return json.load(response)

if meta.get('draftSurveyId'):
    print(json.dumps({'alreadyImported':True,'surveyId':meta['draftSurveyId']},ensure_ascii=False))
    raise SystemExit(0)
poses=deque();batches=[];origin=None
for file in sorted((folder/'rosbag').glob('*.db3')):
    with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True) as db:
        topics={name:(identifier,get_message(kind)) for identifier,name,kind in db.execute('SELECT id,name,type FROM topics')}
        for name in ('/odom','/qr/tags/provisional'):
            identifier,cls=topics[name]
            for raw, in db.execute('SELECT data FROM messages WHERE topic_id=? ORDER BY timestamp',(identifier,)):
                msg=deserialize_message(raw,cls)
                if name=='/qr/tags/provisional':batches.append(json.loads(msg.data));continue
                q=msg.pose.pose.orientation;yaw=math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))
                x=msg.pose.pose.position.x;y=msg.pose.pose.position.y
                if origin is None:origin=(x,y,yaw)
                dx=x-origin[0];dy=y-origin[1];c=math.cos(origin[2]);s=math.sin(origin[2])
                stamp=msg.header.stamp.sec+msg.header.stamp.nanosec/1e9
                poses.append((stamp,{'x':c*dx+s*dy,'y':-s*dx+c*dy,'yaw':wrap(yaw-origin[2])}))
samples=[]
for batch in batches:
    pose=interpolate_pose(poses,batch['stamp'])
    if pose is None or batch.get('calibrated') is not True:continue
    samples.append({'stamp':batch['stamp'],'pose':pose,'tags':batch['tags'],
        'groupLayouts':batch['groupLayouts'],'representation':'board-centers',
        'calibrated':True,'synchronized':False,'quality':'draft',
        'localEpoch':'recorded-'+active['id'],'timestampSource':'server_receive'})
if not samples:raise SystemExit('记录内没有可用定位组观测')
if any(s['state']=='collecting' for s in api('/surveys')):raise SystemExit('已有现场扫描，请先保存现有扫描')
session=api('/survey/start',{'name':'一米遥控实测（草稿）'})
try:
    api('/survey/import',{'sessionId':session['id'],'samples':samples})
finally:
    api('/survey/stop',{})
session=api('/surveys/'+session['id']);estimates={}
for sample in samples:
    p=sample['pose'];c=math.cos(p['yaw']);s=math.sin(p['yaw'])
    for tag in sample['tags']:
        e=estimates.setdefault(tag['id'],{'x':0.,'y':0.,'c':0.,'s':0.,'n':0})
        e['x']+=p['x']+c*tag['x']-s*tag['y'];e['y']+=p['y']+s*tag['x']+c*tag['y']
        e['c']+=math.cos(p['yaw']+tag['angle']);e['s']+=math.sin(p['yaw']+tag['angle']);e['n']+=1
boards=session['boards'];tags=[]
for identifier,e in estimates.items():
    board=next(b for b in boards if b['referenceId']==identifier)
    tags.append({'id':identifier,'groupId':board['id'],'rowId':'','x':e['x']/e['n'],
        'y':e['y']/e['n'],'angle':math.degrees(math.atan2(e['s'],e['c'])),
        'size':board['sizeMm']/1000,'kind':'waypoint','rules':[]})
field={'schemaVersion':1,'id':'draft-scan-'+session['id'].replace('-',''),
    'name':session['name']+'点位草稿','frame':'map','family':'tag36h11','source':'survey',
    'coordinateStatus':'draft','captureQuality':'draft','rows':[],'tags':tags,'groups':boards,
    'order':[],'zone':[{'x':0.,'y':0.} for _ in range(4)],
    'vehicle':{'width':.4,'length':.8,'margin':.05},
    'notes':'真实遥控测试记录的相对点位草稿；里程计以记录起点归零。实际距离仅估计约1米；时戳未经验证，作物行、换行区和整车尺寸尚未定义。'}
saved=api('/maps',{'map':field,'baseVersion':0})
meta.update(draftSurveyId=session['id'],draftMapId=saved['map']['id'])
(folder/'test.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
(folder/'draft-import.json').write_text(json.dumps({'surveyId':session['id'],'mapId':field['id'],'sampleCount':len(samples),'groupCount':len(tags)},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'surveyId':session['id'],'mapId':field['id'],'sampleCount':len(samples),'groupCount':len(tags)},ensure_ascii=False))
