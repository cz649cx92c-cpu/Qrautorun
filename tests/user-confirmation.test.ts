import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {RobotLink} from '../web/backend/src/robot';
import {appendSamples,createSurvey} from '../web/backend/src/survey';
import {defaults,generate,type FieldMap} from '../web/shared/model';

// Fastify inject and temporary SQLite only: no listening server, live POST or ROS commands.
async function fixture(run:(app:Awaited<ReturnType<typeof createApp>>,store:Store,map:FieldMap)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'qr-user-confirmation-')),database=join(dir,'test.db');
 const app=await createApp(database),store=new Store(database);
 try{
  const map:FieldMap={...generate({...defaults,count:1}),id:'office',name:'办公室地图',source:'survey',captureQuality:'draft'};
  const saved=await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});assert.equal(saved.statusCode,200,saved.body);
  await run(app,store,map);
 }finally{store.close();await app.close();rmSync(dir,{recursive:true,force:true});}
}
const confirmation={mapId:'office',version:1,confirm:true,operator:'现场确认人'};
const task=(map:FieldMap,id='office-task',version=1)=>({id,name:id,mapId:map.id,mapVersion:version,rowOrder:map.order,forwardSpeed:.12,reverseSpeed:.1,lateralSpeed:.06,endWaitSeconds:2,enabled:true});
type Acceptance={digest:string,body:string};
function acceptance(store:Store,version=2){return store.db.prepare('SELECT digest,body FROM acceptances WHERE map_id=? AND version=?').get('office',version) as Acceptance;}
function count(store:Store,table:'acceptances'|'runtime_log'){return (store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n;}
const readyStatus=()=>({...new RobotLink().status(),connected:true,conditions:[{id:'execution',label:'实体执行许可',ready:true}]});

test('用户确认记录独立证据，保留草稿采集质量、几何、历史版本及原始样本',async()=>fixture(async(app,store,map)=>{
 const survey=createSurvey(store,'原始草稿');
 appendSamples(store,survey.id,[{stamp:1,pose:{x:0,y:0,yaw:0},tags:[{id:0,x:.1,y:0,sigma:.02}],calibrated:true,synchronized:false,quality:'draft',timestampSource:'server_receive',localEpoch:'epoch-one'}]);
 const before=store.db.prepare('SELECT * FROM survey_samples').all();
 const response=await app.inject({method:'POST',url:'/api/maps/confirm',payload:confirmation});assert.equal(response.statusCode,200,response.body);
 const result=response.json();assert.equal(result.version,2);assert.equal(result.previousVersion,1);assert.deepEqual(result.updatedTasks,[]);
 assert.deepEqual(result.map,{...map,coordinateStatus:'reviewed'});assert.deepEqual(store.get(map.id,1)!.map,map);
 const saved=acceptance(store),evidence=JSON.parse(saved.body);assert.deepEqual(evidence,result.evidence);
 assert.equal(saved.digest,store.digest(result.map));assert.equal(evidence.kind,'user_confirmation');assert.equal(evidence.confirm,true);
 assert.deepEqual(result.acceptance,{kind:'user_confirmation',digestValid:true,accepted:true});
 assert.deepEqual((await app.inject('/api/maps/office')).json().acceptance,result.acceptance);
 assert.deepEqual((await app.inject('/api/maps/office?version=1')).json().acceptance,{kind:null,digestValid:false,accepted:false});
 assert.equal(evidence.operator,confirmation.operator);assert.equal(evidence.version,1);assert.equal(evidence.acceptedVersion,2);assert.equal(evidence.updateTasks,false);
 assert.ok(!('measurements' in evidence));assert.ok(!('residuals' in evidence));assert.ok(Number.isFinite(Date.parse(evidence.created)));
 assert.deepEqual(store.db.prepare('SELECT * FROM survey_samples').all(),before);
 assert.match((await app.inject('/api/logs')).body,/用户确认接纳地图/);
}));

test('确认接口严格要求 true、整数版本，拒绝伪造测量及额外字段；实验员姓名已删除',async()=>fixture(async(app,store)=>{
 const {confirm:_confirm,...noConfirm}=confirmation,{version:_version,...noVersion}=confirmation;
 // 地图区域“实验员姓名”字段已删除：缺少 operator 或传空串都必须成功，长度上限仍然生效。
 const invalid=[noConfirm,noVersion,{...confirmation,confirm:false},{...confirmation,confirm:'true'},{...confirmation,confirm:1},
  {...confirmation,operator:'x'.repeat(81)},
  {...confirmation,version:0},{...confirmation,version:1.1},{...confirmation,version:'1'},
  {...confirmation,updateTasks:'true'},{...confirmation,measurements:[]},{...confirmation,residuals:[0]},
  {...confirmation,kind:'measurement'},{...confirmation,digest:'fake'},{...confirmation,execution_enabled:true}];
 for(const payload of invalid){const response=await app.inject({method:'POST',url:'/api/maps/confirm',payload});assert.equal(response.statusCode,400,JSON.stringify(payload));}
 assert.equal(store.get('office')!.version,1);assert.equal(count(store,'acceptances'),0);
 const legacyFree=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{mapId:'office',version:1,confirm:true}});
 assert.equal(legacyFree.statusCode,200,legacyFree.body);assert.equal(legacyFree.json().evidence.operator,'');
 const response=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{...confirmation,operator:'  张三  '}});
 assert.equal(response.statusCode,409,'确认后版本前进，重复确认必须 409');
 // 版本已前进，用新版本再验证 operator 仍可选且被裁剪
 const advanced=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{mapId:'office',version:2,confirm:true,operator:'  张三  '}});
 assert.equal(advanced.statusCode,200,advanced.body);assert.equal(advanced.json().evidence.operator,'张三');
}));

test('只确认指定最新版本，不自动接纳其他地图，过期或重复请求无写入',async()=>fixture(async(app,store,map)=>{
 const other={...map,id:'other-office'};store.save(other,0);
 const absent=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{...confirmation,mapId:'missing'}});assert.equal(absent.statusCode,404);
 store.save({...map,notes:'新版本'},1);
 const stale=await app.inject({method:'POST',url:'/api/maps/confirm',payload:confirmation});assert.equal(stale.statusCode,409);
 assert.equal(count(store,'acceptances'),0);
 const confirmed=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{...confirmation,version:2}});assert.equal(confirmed.statusCode,200);
 const repeated=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{...confirmation,version:2}});assert.equal(repeated.statusCode,409);
 assert.equal(store.get('office')!.version,3);assert.deepEqual(store.get(other.id)!.map,other);
 assert.equal(count(store,'acceptances'),1);
}));

test('用户确认保留地图几何校验，错误地图不生成新版本或证据',async()=>fixture(async(app,store,map)=>{
 store.save({...map,order:['missing-row']},1);
 const response=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{...confirmation,version:2}});assert.equal(response.statusCode,400);assert.match(response.body,/作业顺序/);
 assert.equal(store.get(map.id)!.version,2);assert.equal(count(store,'acceptances'),0);
}));

test('默认或 updateTasks:false 不更新任务，响应提供新旧版本供调用方处理',async()=>fixture(async(app,store,map)=>{
 await app.inject({method:'POST',url:'/api/tasks',payload:task(map)});
 const response=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{...confirmation,updateTasks:false}});
 assert.equal(response.statusCode,200);assert.deepEqual(response.json().updatedTasks,[]);assert.equal(response.json().previousVersion,1);
 assert.equal((await app.inject('/api/tasks')).json()[0].mapVersion,1);
 const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'office-task'}});assert.equal(start.statusCode,400);assert.match(start.body,/绑定版本/);
}));

test('显式 updateTasks:true 只更新所确认地图旧版本任务，保留启用状态和参数',async()=>fixture(async(app,store,map)=>{
 store.save(map,1);const other={...map,id:'other-office'};store.save(other,0);
 const tasks=[{...task(map,'current',2),returnToStart:true},{...task(map,'disabled',2),enabled:false},task(map,'historical',1),task(other,'other',1)];
 for(const payload of tasks)assert.equal((await app.inject({method:'POST',url:'/api/tasks',payload})).statusCode,200);
 const response=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{...confirmation,version:2,updateTasks:true}});assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json().updatedTasks.map((t:{id:string})=>t.id).sort(),['current','disabled']);
 const saved=(await app.inject('/api/tasks')).json();
 for(const original of tasks)assert.deepEqual(saved.find((t:{id:string})=>t.id===original.id),{returnToStart:false,...original,mapVersion:['current','disabled'].includes(original.id)?3:original.mapVersion});
 assert.equal(response.json().evidence.updateTasks,true);
}));

test('版本、证据和任务更新事务一致，任务异常时全部回滚',async()=>fixture(async(app,store)=>{
 store.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run('broken',JSON.stringify({id:'broken'}),new Date().toISOString());
 const response=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{...confirmation,updateTasks:true}});assert.equal(response.statusCode,400);
 assert.equal(store.get('office')!.version,1);assert.equal(count(store,'acceptances'),0);
 assert.equal(count(store,'runtime_log'),0);
}));

test('地图确认不启用实体执行、不入队命令；导航仍检查执行、连接和其他条件',async t=>{
 t.mock.method(RobotLink.prototype,'enqueue',()=>{assert.fail('静止确认不应入队命令');});
 await fixture(async(app,store,map)=>{
  await app.inject({method:'POST',url:'/api/tasks',payload:task(map)});
  assert.equal((await app.inject({method:'POST',url:'/api/maps/confirm',payload:{...confirmation,updateTasks:true}})).statusCode,200);
  let start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'office-task'}});assert.equal(start.statusCode,423);assert.match(start.body,/ROS2/);assert.doesNotMatch(start.body,/来自草稿|实测坐标验收/);
  const status=new RobotLink().status();t.mock.method(RobotLink.prototype,'status',()=>({...status,connected:true,conditions:[{id:'execution',label:'实体执行许可',ready:false},{id:'pose',label:'正式定位',ready:false}]}));
  start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'office-task'}});assert.equal(start.statusCode,423);assert.match(start.body,/实体执行许可/);assert.match(start.body,/正式定位/);
  assert.equal((await app.inject('/api/health')).json().hardwareControl,false);assert.equal(store.get(map.id)!.map.captureQuality,'draft');
 });
});

test('导航分支承认合法摘要的用户确认草稿，离线替身验证入队内容',async t=>{
 const status=readyStatus();t.mock.method(RobotLink.prototype,'status',()=>status);
 const send=t.mock.method(RobotLink.prototype,'enqueue',(type:string,payload:unknown)=>({type,payload,offline:true}));
 await fixture(async(app,_store,map)=>{
  await app.inject({method:'POST',url:'/api/tasks',payload:task(map)});
  const confirmed=(await app.inject({method:'POST',url:'/api/maps/confirm',payload:{...confirmation,updateTasks:true}})).json();assert.equal(send.mock.callCount(),0);
  const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'office-task'}});assert.equal(start.statusCode,200,start.body);
  assert.equal(send.mock.callCount(),1);assert.equal(start.json().type,'start');assert.deepEqual(start.json().payload.map,confirmed.map);assert.equal(start.json().payload.task.mapVersion,2);
 });
});

test('草稿导航拒绝缺失、损坏、非确认、错地图/版本及摘要不匹配的证据',async t=>{
 const status=readyStatus();t.mock.method(RobotLink.prototype,'status',()=>status);t.mock.method(RobotLink.prototype,'enqueue',()=>assert.fail('非法证据不应入队'));
 await fixture(async(app,store,map)=>{
  await app.inject({method:'POST',url:'/api/tasks',payload:task(map)});
  await app.inject({method:'POST',url:'/api/maps/confirm',payload:{...confirmation,updateTasks:true}});
  const saved=acceptance(store),evidence=JSON.parse(saved.body);
  // 实验员姓名字段已删除：operator 为空/缺省不再是非法证据，因此不再列入 bad。
  const bad=[{...saved,digest:'bad'}, {...saved,body:'not json'}, {...saved,body:'null'},
   ...[{...evidence,kind:'measurement'},{...evidence,confirm:false},{...evidence,mapId:'other-office'},
    {...evidence,version:2},{...evidence,acceptedVersion:1},{...evidence,measurements:[]},{...evidence,residuals:[0]}].map(body=>({...saved,body:JSON.stringify(body)}))];
  for(const row of bad){store.db.prepare('UPDATE acceptances SET digest=?,body=? WHERE map_id=? AND version=2').run(row.digest,row.body,'office');
   assert.equal((await app.inject('/api/maps/office')).json().acceptance.accepted,false);
   const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'office-task'}});assert.equal(start.statusCode,423,JSON.stringify(row));assert.match(start.body,/草稿/);}
  store.db.prepare('UPDATE acceptances SET digest=?,body=? WHERE map_id=? AND version=2').run(saved.digest,saved.body,'office');
  const changed={...store.get('office')!.map,notes:'数据库几何内容变更'};
  store.db.prepare('UPDATE versions SET body=? WHERE map_id=? AND version=2').run(JSON.stringify(changed),'office');
  assert.deepEqual((await app.inject('/api/maps/office')).json().acceptance,{kind:null,digestValid:false,accepted:false});
  assert.equal((await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'office-task'}})).statusCode,423);
  store.db.prepare('DELETE FROM acceptances').run();
  assert.equal((await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'office-task'}})).statusCode,423);
 });
});

test('后续保存的新版本不继承确认；其他地图也不继承确认',async()=>fixture(async(app,store,map)=>{
 await app.inject({method:'POST',url:'/api/maps/confirm',payload:confirmation});
 const confirmed=store.get('office')!;store.save({...confirmed.map,notes:'后续编辑'},2);
 assert.deepEqual((await app.inject('/api/maps/office')).json().acceptance,{kind:null,digestValid:false,accepted:false});
 assert.deepEqual((await app.inject('/api/maps/office?version=2')).json().acceptance,{kind:null,digestValid:true,accepted:false});
 await app.inject({method:'POST',url:'/api/tasks',payload:task(map,'new-version',3)});
 const other={...map,id:'other-office',coordinateStatus:'reviewed' as const};store.save(other,0);
 await app.inject({method:'POST',url:'/api/tasks',payload:task(other,'other')});
 for(const taskId of ['new-version','other']){const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId}});assert.equal(start.statusCode,423);assert.match(start.body,/草稿/);}
}));

test('原实测 accept 分支保留测量及残差要求，不转换为用户确认或接纳草稿',async()=>fixture(async(app,store,map)=>{
 const measurements=map.tags.slice(0,3).map(({id,x,y})=>({id,x,y}));
 let response=await app.inject({method:'POST',url:'/api/maps/accept',payload:{mapId:map.id,version:1,operator:'实测测试',measurements}});assert.equal(response.statusCode,400);assert.match(response.body,/草稿/);
 store.save({...map,captureQuality:'verified'},1);
 response=await app.inject({method:'POST',url:'/api/maps/accept',payload:{mapId:map.id,version:2,operator:'实测测试',measurements}});assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json().evidence.measurements,measurements);assert.deepEqual(response.json().evidence.residuals,[0,0,0]);assert.notEqual(response.json().evidence.kind,'user_confirmation');
 assert.equal(acceptance(store,3).digest,store.digest(response.json().map));
 assert.deepEqual((await app.inject('/api/maps/office')).json().acceptance,{kind:'measurement',digestValid:true,accepted:true});
}));

test('仅 reviewed 没有验收记录的草稿，GET 不称已接纳且导航拒绝',async t=>{
 const status=readyStatus();t.mock.method(RobotLink.prototype,'status',()=>status);t.mock.method(RobotLink.prototype,'enqueue',()=>assert.fail('缺少证据不应入队'));
 await fixture(async(app,store,map)=>{
  store.save({...map,coordinateStatus:'reviewed'},1);
  await app.inject({method:'POST',url:'/api/tasks',payload:task(map,'office-task',2)});
  const loaded=(await app.inject('/api/maps/office')).json();assert.equal(loaded.map.coordinateStatus,'reviewed');assert.equal(loaded.map.captureQuality,'draft');
  assert.deepEqual(loaded.acceptance,{kind:null,digestValid:false,accepted:false});
  const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'office-task'}});assert.equal(start.statusCode,423);assert.match(start.body,/草稿/);
 });
});

test('即使摘要匹配，实测类证据也不能绕过草稿的显式用户确认',async t=>{
 const status=readyStatus();t.mock.method(RobotLink.prototype,'status',()=>status);t.mock.method(RobotLink.prototype,'enqueue',()=>assert.fail('实测类记录不能冒充用户确认'));
 await fixture(async(app,store,map)=>{
  await app.inject({method:'POST',url:'/api/maps/confirm',payload:confirmation});
  const saved=store.get(map.id)!;
  const body={mapId:map.id,version:1,operator:'离线伪实测记录',measurements:map.tags.slice(0,3).map(({id,x,y})=>({id,x,y})),residuals:[0,0,0],created:new Date().toISOString()};
  store.db.prepare('UPDATE acceptances SET digest=?,body=? WHERE map_id=? AND version=2').run(store.digest(saved.map),JSON.stringify(body),map.id);
  await app.inject({method:'POST',url:'/api/tasks',payload:task(map,'office-task',2)});
  assert.deepEqual((await app.inject('/api/maps/office')).json().acceptance,{kind:null,digestValid:true,accepted:false});
  const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'office-task'}});assert.equal(start.statusCode,423);assert.match(start.body,/草稿/);
 });
});
