import {readFileSync} from 'node:fs';
import {createApp,root} from '../web/backend/src/server';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {longitudinalTravel} from '../web/backend/src/segment-route';
import {compileScan} from '../web/backend/src/scan-map';
import {motionRecordSchema} from '../web/backend/src/survey-motion';
import {mapSchema} from '../web/shared/model';
const positions=[[0,0],[.3,0],[.3,.3],[.6,.6],[.3,.6]];
const samples=positions.map(([x,y],i)=>({stamp:1+i*3,localEpoch:'epoch',pose:{x:x!,y:y!,yaw:0},tags:[{id:i,x:0,y:0}]}));
const records=Array.from({length:241},(_,i)=>{
 const section=Math.min(3,Math.floor(i/60)),stopped=i%60===0;
 const gear=section===1||section===2?8:6;
 const vx=stopped?0:section===1?0:section===3?-.1:.1,vy=stopped?0:section===1||section===2?.1:0;
 return motionRecordSchema.parse({stamp:1+i*.05,seq:i,receivedMonotonic:i*.05,localEpoch:'epoch',bodyGear:gear,steeringGear:gear===8?7:5,vx,vy,vyRaw:vy*10,wz:0,feedbackAgeS:.01,feedbackSource:'chassis_info_fb_aggregate'});
});
const result={tags:positions.map(([x,y],id)=>({id,x,y,angle:0,count:5,residualM:0})),poses:positions.map(([x,y])=>[x,y,0]),rmsM:0};
const settings={sessionId:'mixed-route',name:'混合区间验证',tagSizeMm:80,rowWidth:.6,exitDistance:.8};
const compile=(rs=records)=>compileScan(result,settings,[],[],{samples,optimizedSamples:samples,records:rs});
test('混合路线保留每段模式、车头方向和斜向平移轮角，地图往返序列化不丢档',()=>{
 const built=compile();assert.equal(built.validation.errors.length,0);
 const segments=built.map.motionSegments!;
 assert.deepEqual(segments.map(s=>[s.mode,s.direction]),[['4t4d','forward'],['crab','lateral'],['crab','lateral'],['4t4d','reverse']]);
 assert.ok(Math.abs(segments[1]!.wheelAngle-90)<1e-8);assert.ok(Math.abs(segments[2]!.wheelAngle-45)<1e-8);
 assert.equal(segments[1]!.bodyYaw,0);assert.equal(segments[1]!.endYaw,0);
 assert.deepEqual(mapSchema.parse(JSON.parse(JSON.stringify(built.map))).motionSegments,segments);
});
test('一个二维码区间混用模式，生成阶段直接拒绝',()=>{
 const changed=records.map(r=>({...r}));changed[15]!.bodyGear=8;
 assert.throws(()=>compile(changed),/区间模式校验未通过/);
});
test('不能通过手工改端点让区间路径脱离二维码',()=>{
 const map=compile().map;map.motionSegments![1]!.points[0]!.x+=.1;
 assert.throws(()=>mapSchema.parse(map),/区间端点/);
});
test('只有两个二维码也能生成有效区间路线',()=>{
 const sub={tags:result.tags.slice(0,2),poses:[result.poses[0]!,[.15,0,0],result.poses[1]!],rmsM:0};
 const middle={...samples[0]!,stamp:2.5,pose:{x:.15,y:0,yaw:0}};
 const built=compileScan(sub,settings,[],[],{samples:samples.slice(0,2),optimizedSamples:[samples[0]!,middle,samples[1]!],records:records.slice(0,61)});
 assert.equal(built.map.motionSegments!.length,1);assert.ok(built.map.rows[0]!.points.length>=2);
});

test('实际API：录制档位→整理→保存地图→加载，平移段进入任务地图',async()=>{
 const app=await createApp(':memory:');try{
  const config=JSON.parse(readFileSync(root+'/config/web.json','utf8'));
  const key=readFileSync(root+'/'+config.bridgeKeyFile,'utf8').trim();
  const session=(await app.inject({method:'POST',url:'/api/survey/start',payload:{name:'离线混合执行验证'}})).json();
  const imported=samples.map(s=>({...s,calibrated:true,synchronized:true,tags:s.tags.map(t=>({...t,angle:0,sigma:.02}))}));
  const sr=await app.inject({method:'POST',url:'/api/survey/import',payload:{sessionId:session.id,samples:imported}});assert.equal(sr.statusCode,200,sr.body);
  for(let i=0;i<records.length;i+=200){const response=await app.inject({method:'POST',url:'/api/robot/motion-records',headers:{'x-bridge-key':key},payload:{records:records.slice(i,i+200)}});assert.equal(response.statusCode,200,response.body);}
  await app.inject({method:'POST',url:'/api/survey/stop',payload:{}});
  const optimized=await app.inject({method:'POST',url:'/api/survey/optimize',payload:{sessionId:session.id,anchors:[]}});assert.equal(optimized.statusCode,200,optimized.body);
  const finalized=await app.inject({method:'POST',url:'/api/workflow/finalize',payload:{...settings,sessionId:session.id}});assert.equal(finalized.statusCode,200,finalized.body);
  const saved=finalized.json();assert.equal(saved.map.motionSegments.length,4);assert.equal(saved.map.motionSegments[1].mode,'crab');
  const loaded=(await app.inject('/api/maps/'+saved.map.id)).json();assert.deepEqual(loaded.map.motionSegments,saved.map.motionSegments);
  assert.equal((await app.inject('/api/robot/status')).json().running,false);
 }finally{await app.close();}
});

test('没有档位的旧记录不能默认为全部前进生成路线',async()=>{
 const app=await createApp(':memory:');try{
  const session=(await app.inject({method:'POST',url:'/api/survey/start',payload:{name:'无档位旧记录'}})).json();
  await app.inject({method:'POST',url:'/api/survey/import',payload:{sessionId:session.id,samples:samples.map(s=>({...s,calibrated:true,synchronized:true,tags:s.tags.map(t=>({...t,angle:0,sigma:.02}))}))}});
  await app.inject({method:'POST',url:'/api/survey/stop',payload:{}});
  await app.inject({method:'POST',url:'/api/survey/optimize',payload:{sessionId:session.id,anchors:[]}});
  const response=await app.inject({method:'POST',url:'/api/workflow/finalize',payload:{...settings,sessionId:session.id}});
  assert.equal(response.statusCode,400,response.body);assert.match(response.body,/旧记录没有连续档位/);
 }finally{await app.close();}
});


test('停车毫米级回弹按累计行程处理，原始记录保持不变',()=>{
 for(const sign of [1,-1]){
  const rs=records.slice(0,61).map((r,i)=>({...r,vx:(i>=50&&i<=53?-.04:r.vx)*sign}));
  const before=JSON.stringify(rs);
  const ss=samples.slice(0,2).map(s=>({...s,pose:{...s.pose,x:s.pose.x*sign}}));
  const optimized=[ss[0]!,{...ss[0]!,stamp:2.5,pose:{x:.15*sign,y:0,yaw:0}},ss[1]!];
  const rr={...result,tags:result.tags.slice(0,2).map(t=>({...t,x:t.x!*sign})),poses:optimized.map(s=>[s.pose.x,s.pose.y,0])};
  const built=compileScan(rr,settings,[],[],{samples:ss,optimizedSamples:optimized,records:rs});
  const segment=built.map.motionSegments![0]!;
  assert.equal(segment.direction,sign===1?'forward':'reverse');assert.equal(JSON.stringify(rs),before);
  for(let i=1;i<segment.points.length;i++)assert.ok((segment.points[i]!.x-segment.points[i-1]!.x)*sign>0);
 }
});
test('真实反向行程和累计多次回退仍拒绝自动路线',()=>{
 for(const negative of [[45,46,47,48,49,50,51,52],[12,13,14,15,30,31,32,33,48,49,50,51]]){
  const rs=records.slice(0,61).map((r,i)=>({...r,vx:negative.includes(i)?-.1:r.vx}));
  assert.ok(longitudinalTravel(rs).reverseM>.015);
  const optimized=[samples[0]!,{...samples[0]!,stamp:2.5,pose:{x:.15,y:0,yaw:0}},samples[1]!];
  assert.throws(()=>compileScan({...result,tags:result.tags.slice(0,2),poses:optimized.map(s=>[s.pose.x,s.pose.y,0])},settings,[],[],{samples:samples.slice(0,2),optimizedSamples:optimized,records:rs}),/前后换向|区间模式校验未通过/);
 }
});
test('方向行程分别积分过零面积，重采样不改变结果',()=>{
 const original=[{stamp:0,vx:.2},{stamp:1,vx:-.1},{stamp:2,vx:.2}];
 const dense=original.flatMap((p,i)=>i===original.length-1?[p]:[p,{stamp:p.stamp+.5,vx:(p.vx+original[i+1]!.vx)/2}]);
 const a=longitudinalTravel(original),b=longitudinalTravel(dense);
 assert.ok(Math.abs(a.forwardM-2/15)<1e-12);assert.ok(Math.abs(a.reverseM-1/30)<1e-12);
 assert.ok(Math.abs(a.forwardM-b.forwardM)<1e-12);assert.ok(Math.abs(a.reverseM-b.reverseM)<1e-12);
});

test('示教路线携带显式低速试用配置，平移小幅回调允许但真实换向拒绝',()=>{
 const rs=records.map((r,i)=>i>=80&&i<82?{...r,vy:-.1}:r);
 const built=compile(rs);assert.ok(built.map.motionSegments!.every(s=>s.executionProfile==='recorded_slow_trial'));
 const before=JSON.stringify(rs);compile(rs);assert.equal(JSON.stringify(rs),before);
 const reversed=records.map((r,i)=>i>=80&&i<94?{...r,vy:-.1}:r);
 assert.throws(()=>compile(reversed),/方向|区间模式校验未通过/);
});
