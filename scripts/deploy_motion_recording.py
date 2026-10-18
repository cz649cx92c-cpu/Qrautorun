from pathlib import Path
import json,subprocess,urllib.request,time
root=Path('.')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(path):
 with opener.open('http://127.0.0.1:3080/api'+path,timeout=5) as response:return json.load(response)
s=api('/robot/status')
assert not s.get('running') and abs(s.get('speed',1))<.01,'车辆未静止'
assert not any(s['state']=='collecting' for s in api('/surveys')),'仍有采集任务'
configs={name:json.loads((root/('logs/services/'+name+'.desired.json')).read_text()) for name in ['robot','vision','web']}
checks=json.loads(Path('logs/motion-recording-checks.json').read_text());assert all(v==0 for v in checks.values()) and len(checks)==4
results=[]
for name in ['robot','vision','web']:
 p=subprocess.run(['python3','scripts/service_manager.py','stop',name],capture_output=True,text=True)
 results.append({'action':'stop','name':name,'code':p.returncode});assert p.returncode==0,p.stderr
for name in ['web','vision','robot']:
 config=configs[name]
 if not config.get('enabled'):continue
 args=config.get('arguments',[])
 if name=='robot' and config.get('executionEnabled') and '--enable-execution' not in args:args=args+['--enable-execution']
 p=subprocess.run(['python3','scripts/service_manager.py','start',name,*args],capture_output=True,text=True)
 results.append({'action':'start','name':name,'code':p.returncode});assert p.returncode==0,p.stderr
Path('logs/motion-recording-deployment.json').write_text(json.dumps({'checks':checks,'services':results,'backup':'backups/motion-recording-20261016-160314','motionCommandsSent':False},indent=2))
