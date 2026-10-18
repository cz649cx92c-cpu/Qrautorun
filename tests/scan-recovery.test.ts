import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../web/backend/src/store';
import {surveyTables,createSurvey,appendLiveSamples,getSurvey,pointDraftMap} from '../web/backend/src/survey';
import {generateBoards} from '../web/shared/boards';
const sample=(epoch:string,stamp:number)=>({stamp,pose:{x:0,y:0,yaw:0},tags:[{id:0,x:.1,y:0,sigma:.02}],calibrated:true,synchronized:false,quality:'draft',timestampSource:'server_receive',localEpoch:epoch});
function setup(){const store=new Store(':memory:');surveyTables(store);return {store,session:createSurvey(store,'恢复扫描')};}
const sessionCount=(store:Store)=>(store.db.prepare('SELECT COUNT(*) n FROM survey_sessions').get() as {n:number}).n;
test('真正原点变化时保留原扫描及全部定位组，不另建空记录',()=>{
 const {store,session}=setup();try{
  const prior=[0,1,2,3].map((id,i)=>({...sample('old',i+1),tags:[{id,x:.1,y:0,sigma:.02}]}));
  appendLiveSamples(store,session.id,prior,'old');
  const stopped=appendLiveSamples(store,session.id,[sample('new',5)],'new');
  assert.equal(stopped.sessionId,session.id);assert.equal(stopped.stored,0);assert.equal(stopped.stopped,true);
  const saved=getSurvey(store,session.id);assert.equal(saved.state,'stopped');assert.equal(saved.samples.length,4);assert.equal(Object.keys(saved.counts).length,4);assert.equal(sessionCount(store),1);
  const draft=pointDraftMap(saved);assert.equal(draft.tags.length,4);assert.equal(draft.motionSegments,undefined);assert.equal(draft.routeMode,undefined);
 }finally{store.close();}
});
test('原点变化前的迟到帧丢弃，不反复切换原点；零帧扫描恢复后保持同一记录',()=>{
 const {store,session}=setup();try{
  const started=appendLiveSamples(store,session.id,[sample('old',1),sample('new',2)],'new');
  assert.equal(started.sessionId,session.id);assert.equal(started.stored,1);
  assert.deepEqual(appendLiveSamples(store,session.id,[sample('old',3)],'new'),{sessionId:session.id,stored:0});
  assert.equal(getSurvey(store,session.id).samples[0].localEpoch,'new');
  const unknown=appendLiveSamples(store,session.id,[sample('future',4)]);assert.equal(unknown.stored,0);assert.equal(unknown.sessionId,session.id);
 }finally{store.close();}
});
test('无效组观测触发事务回滚，旧扫描继续采集且不产生空记录',()=>{
 const {store,session}=setup();try{
  appendLiveSamples(store,session.id,[sample('old',1)],'old');
  const invalid={...sample('old',2),tags:[{...sample('old',2).tags[0]!,groupId:'unknown'}]};
  assert.throws(()=>appendLiveSamples(store,session.id,[invalid],'old'),/布局/);
  assert.equal(getSurvey(store,session.id).state,'collecting');assert.equal(sessionCount(store),1);assert.equal(getSurvey(store,session.id).samples.length,1);
 }finally{store.close();}
});
test('扫描保留定位组几何；正式观测不自动降级为草稿',()=>{
 const store=new Store(':memory:');try{
  surveyTables(store);const boards=generateBoards({gridSize:1,groupSizeMm:100,groupCount:1,startId:0});const session=createSurvey(store,'多码扫描',boards);
  const grouped=(epoch:string,stamp:number)=>({...sample(epoch,stamp),representation:'board-centers',groupLayouts:boards,tags:[{...sample(epoch,stamp).tags[0]!,groupId:boards[0]!.id,memberIds:[0],visibleCount:1,size:.1}]});
  appendLiveSamples(store,session.id,[grouped('old',1)],'old');const result={sessionId:session.id};assert.deepEqual(getSurvey(store,result.sessionId).boards,boards);
  assert.throws(()=>appendLiveSamples(store,result.sessionId,[{...grouped('old',3),quality:'verified',synchronized:true}], 'old'),/质量/);assert.equal(getSurvey(store,result.sessionId).samples.length,1);
 }finally{store.close();}
});

test('实机接口在原点变化后保留原记录，重启后不偷偷续采且单组草稿可保存',async()=>{
 const {createApp,root}=await import('../web/backend/src/server');
 const {readFileSync,mkdtempSync,rmSync}=await import('node:fs');
 const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=mkdtempSync(join(tmpdir(),'qr-scan-recovery-')),db=join(dir,'scan.db');
 const headers={'x-bridge-key':readFileSync(join(root,'config/bridge.key'),'utf8').trim()};
 let app=await createApp(db);
 const telemetry=(seq:number,epoch:string)=>({bootId:'recovery-test',seq,state:'IDLE',running:false,paused:false,rowId:'',pose:null,speed:0,wheelAngle:null,tagId:null,chassis:{connected:true,feedback:null},sensors:{camera:'识别中',odom:'在线',imu:'在线',localization:'局部已融合'},conditions:[],events:[],cycleMs:1,mapping:{ready:true,quality:'draft',reason:'',localEpoch:epoch,lateralSupported:false}});
 try{
  const session=(await app.inject({method:'POST',url:'/api/survey/start',payload:{name:'接口恢复'}})).json();
  assert.equal((await app.inject({method:'POST',url:'/api/robot/observations',payload:{samples:[sample('old',1)]}})).statusCode,401);
  await app.inject({method:'POST',url:'/api/robot/telemetry',headers,payload:telemetry(1,'old')});
  assert.equal((await app.inject({method:'POST',url:'/api/robot/observations',headers,payload:{samples:[sample('old',1)]}})).json().stored,1);
  await app.inject({method:'POST',url:'/api/robot/telemetry',headers,payload:telemetry(2,'new')});
  const recovered=await app.inject({method:'POST',url:'/api/robot/observations',headers,payload:{samples:[sample('old',2),sample('new',3)]}});
  assert.equal(recovered.statusCode,200,recovered.body);const stopped=recovered.json();assert.equal(stopped.stored,0);assert.equal(stopped.stopped,true);assert.equal(stopped.sessionId,session.id);
  await app.close();app=await createApp(db);
  await app.inject({method:'POST',url:'/api/robot/telemetry',headers,payload:telemetry(3,'new')});
  const appended=(await app.inject({method:'POST',url:'/api/robot/observations',headers,payload:{samples:[sample('new',4)]}})).json();assert.equal(appended.stored,0);
  const current=(await app.inject('/api/surveys/'+session.id)).json();assert.equal(current.samples.length,1);assert.equal(current.state,'stopped');assert.match(current.stop_reason,/原点/);
  const draft=await app.inject({method:'POST',url:'/api/survey/draft',payload:{sessionId:session.id}});assert.equal(draft.statusCode,200,draft.body);assert.equal(draft.json().map.tags.length,1);assert.equal(draft.json().map.coordinateStatus,'draft');
  const again=await app.inject({method:'POST',url:'/api/survey/draft',payload:{sessionId:session.id}});assert.equal(again.statusCode,200,again.body);assert.equal(again.json().version,draft.json().version+1);
  assert.equal(again.json().map.routeMode,undefined);assert.equal(again.json().map.motionSegments,undefined);
  assert.equal((await app.inject('/api/tasks')).json().length,0);
  const empty=await app.inject({method:'POST',url:'/api/survey/start',payload:{name:'new recording'}});assert.equal(empty.statusCode,200,empty.body);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('扫描达到单段上限时自动保存续采，原记录完整保留',()=>{
 const {store,session}=setup();try{
  store.db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10000)
   INSERT INTO survey_samples(session_id,stamp,body) SELECT ?,n,json_set(?,'$.stamp',n) FROM seq`).run(session.id,JSON.stringify(sample('one',1)));
  const result=appendLiveSamples(store,session.id,[sample('one',10001),sample('one',10002)],'one');
  assert.notEqual(result.sessionId,session.id);assert.equal(result.stored,2);assert.equal(result.continuedFrom,session.id);
  assert.equal(getSurvey(store,session.id).samples.length,10000);assert.equal(getSurvey(store,session.id).state,'stopped');
  const current=getSurvey(store,result.sessionId);assert.equal(current.samples.length,2);assert.equal(current.samples[0].localEpoch,'one');
 }finally{store.close();}
});
