import {addStraightMotion} from './motion-fixture';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileScan,scanSettings} from '../web/backend/src/scan-map';
import {optimizationSamples} from '../web/backend/src/survey';
import {createApp} from '../web/backend/src/server';
const settings=scanSettings.parse({sessionId:'abc',name:'扫描地图',tagSizeMm:80,rowWidth:.6,exitDistance:.8});
test('办公室扫描连接全部定位点，保留方向与坐标，不生成温室换行任务',()=>{
 const poses=Array.from({length:7},(_,i)=>[i*.5,0,0]);
 const tags=[{id:400,x:3,y:0,angle:30,count:5,residualM:.01},{id:5,x:0,y:0,angle:90,count:5,residualM:.01},{id:1,x:1.5,y:0,angle:0,count:5,residualM:.01}];
 const result=compileScan({poses,tags,rmsM:.01},settings);
 assert.equal(result.map.routeMode,'waypoints');assert.equal(result.map.rows.length,1);assert.deepEqual(result.map.rows[0]!.start,{x:0,y:0});
 assert.deepEqual(result.map.tags.map(t=>t.id),[5,1,400]);assert.ok(result.map.tags.every(t=>t.rowId===result.map.rows[0]!.id));
 assert.equal(result.map.tags.find(t=>t.id===400)!.kind,'end');assert.equal(result.map.tags.find(t=>t.id===400)!.angle,30);
 assert.equal(result.map.coordinateStatus,'draft');assert.ok(result.map.tags.every(t=>t.rules.every(r=>r.task===result.task.id&&r.action==='LOCALIZE'&&r.direction==='forward')));
 assert.throws(()=>compileScan({poses,tags,rmsM:.1},settings),/残差/);
 const long=Array.from({length:800},(_,i)=>({stamp:i,pose:{x:i*.01,y:0,yaw:0},tags:[{id:1,x:0,y:0,angle:0,sigma:.02}],calibrated:true,synchronized:true}));const kept=optimizationSamples(long);assert.ok(kept.length<=500);assert.equal(kept[0]!.stamp,0);assert.equal(kept.at(-1)!.stamp,799);
});
test('扫描→停止→优化→保存地图与任务，禁止自动生成验收证据',async()=>{
 const app=await createApp(':memory:');try{
  const session=(await app.inject({method:'POST',url:'/api/survey/start',payload:{name:'端到端示教'}})).json();
  const samples=Array.from({length:7},(_,i)=>({stamp:i+1,localEpoch:'offline-fixture',pose:{x:i*.5,y:0,yaw:0},tags:[{id:5,x:-i*.5,y:0,angle:Math.PI/6,sigma:.02},{id:200,x:3-i*.5,y:0,angle:0,sigma:.02},{id:99,x:1.5-i*.5,y:0,angle:0,sigma:.02}],calibrated:true,synchronized:true}));
  assert.equal((await app.inject({method:'POST',url:'/api/survey/import',payload:{sessionId:session.id,samples}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/survey/optimize',payload:{sessionId:session.id,anchors:[]}})).statusCode,400);
  await addStraightMotion(app);
  await app.inject({method:'POST',url:'/api/survey/stop',payload:{}});
  const optimized=await app.inject({method:'POST',url:'/api/survey/optimize',payload:{sessionId:session.id,anchors:[]}});assert.equal(optimized.statusCode,200,optimized.body);
  const payload={...settings,sessionId:session.id};const saved=await app.inject({method:'POST',url:'/api/workflow/finalize',payload});assert.equal(saved.statusCode,200,saved.body);const result=saved.json();assert.equal(result.map.coordinateStatus,'reviewed');assert.equal(result.acceptance.kind,'office_test');assert.ok(Math.abs(result.map.tags[0].angle-30)<1e-8);
  const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:result.task.id}});assert.equal(start.statusCode,423);assert.match(start.body,/ROS2/);
  assert.equal((await app.inject({method:'POST',url:'/api/workflow/finalize',payload})).statusCode,409);
  const resume=await app.inject({method:'POST',url:'/api/survey/resume',payload:{sessionId:session.id}});
  assert.equal(resume.statusCode,400);assert.match(resume.body,/原点/);
  assert.notEqual((await app.inject('/api/surveys/'+session.id)).json().result,null);
 }finally{await app.close();}
});
