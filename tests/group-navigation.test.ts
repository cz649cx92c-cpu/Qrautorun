import {addStraightMotion} from './motion-fixture';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createApp} from '../web/backend/src/server';
import {generateBoards,boardPoseFromMember} from '../web/shared/boards';

test('多码板：整组尺寸、成员唯一、缺任意子码恢复相同中心、重打不限制',async()=>{
 const app=await createApp(':memory:');try{
  for(const n of [1,2,3,4,5,6]){
   const request={gridSize:n,groupSizeMm:140,groupCount:2,startId:[0,10,30,70,120,200][n-1]!};
   const boards=generateBoards(request),plan=(await app.inject({method:'POST',url:'/api/boards/plan',payload:request})).json();
   assert.equal(plan.memberCount,2*n*n);assert.equal(plan.pages,2);assert.equal(plan.boards[0].sizeMm,140);
   const svg=await app.inject(`/api/boards/preview.svg?gridSize=${n}&groupSizeMm=140&startId=${request.startId}`);assert.equal(svg.statusCode,200);assert.match(svg.body,/<svg/);
   const childMm=(140-(n-1)*2)/n/1.25;assert.ok(Math.abs(plan.childSizeMm-childMm)<1e-9);
   for(const b of boards)for(const child of b.members){const yaw=.6,c=Math.cos(yaw),s=Math.sin(yaw),result=boardPoseFromMember(b,child.id,{x:1+c*child.x-s*child.y,y:2+s*child.x+c*child.y,yaw});assert.ok(Math.abs(result.x-1)<1e-9);assert.ok(Math.abs(result.y-2)<1e-9);}
   const pdf=await app.inject({method:'POST',url:'/api/boards/pdf',payload:request});assert.equal(pdf.statusCode,200,pdf.body);assert.equal(pdf.rawPayload.subarray(0,4).toString(),'%PDF');
   const dir=new URL(`../logs/board-print-verification/${n}x${n}/`,import.meta.url);mkdirSync(dir,{recursive:true});writeFileSync(new URL('groups.pdf',dir),pdf.rawPayload);writeFileSync(new URL('groups.json',dir),JSON.stringify(boards));
   assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:request})).statusCode,200);
   assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{...request,groupSizeMm:150}})).statusCode,200,'不同尺寸重打应允许');
  }
  assert.ok((await app.inject('/api/boards')).json().length>=12,'登记数不应减少');
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{gridSize:4,groupSizeMm:140,groupCount:37,startId:0}})).statusCode,400);
 }finally{await app.close();}
});

test('多码组扫描：不同可见子码保持一个地图节点，保存完整几何与任务，办公室路线无需坐标审核',async()=>{
 const app=await createApp(':memory:');try{
  const request={gridSize:2,groupSizeMm:140,groupCount:3,startId:0},boards=generateBoards(request);
  const preview=await app.inject({method:'POST',url:'/api/boards/plan',payload:request});assert.equal(preview.statusCode,200);assert.equal((await app.inject('/api/boards')).json().length,0);
  await app.inject({method:'POST',url:'/api/boards/pdf',payload:request});
  const session=(await app.inject({method:'POST',url:'/api/survey/start',payload:{name:'仅离线API检查'}})).json();assert.equal(session.boards.length,3);
  const samples=Array.from({length:7},(_,i)=>({stamp:i+1,localEpoch:'offline-fixture',pose:{x:i*.5,y:0,yaw:0},representation:'board-centers',groupLayouts:boards,calibrated:true,synchronized:true,tags:boards.map((b,j)=>({id:b.referenceId,groupId:b.id,x:j*1.5-i*.5,y:0,angle:0,sigma:.02,angleSigma:.04,size:.14,memberIds:[b.members[(i+1)%4]!.id],visibleCount:1,detectedCount:1}))}));
  // 真正非法：id 既不是 referenceId 也不属于任何组内成员
  const bad=structuredClone(samples[0]!);bad.tags[0]!.id=999;
  assert.equal((await app.inject({method:'POST',url:'/api/survey/import',payload:{sessionId:session.id,samples:[bad]}})).statusCode,400);
  const imported=await app.inject({method:'POST',url:'/api/survey/import',payload:{sessionId:session.id,samples}});assert.equal(imported.statusCode,200,imported.body);assert.deepEqual(imported.json().counts,{'0':7,'4':7,'8':7});
assert.equal(imported.json().visibility.B000.visible,1);
  await addStraightMotion(app);
  await app.inject({method:'POST',url:'/api/survey/stop',payload:{}});
  const optimized=await app.inject({method:'POST',url:'/api/survey/optimize',payload:{sessionId:session.id,anchors:[]}});assert.equal(optimized.statusCode,200,optimized.body);
  const saved=await app.inject({method:'POST',url:'/api/workflow/finalize',payload:{sessionId:session.id,name:'多码中心地图',rowWidth:.6,exitDistance:.8}});assert.equal(saved.statusCode,200,saved.body);const result=saved.json();assert.equal(result.map.tags.length,3);assert.equal(result.map.groups.length,3);assert.deepEqual(result.map.groups,boards);assert.equal(result.map.tags[1].groupId,'B004');assert.equal(result.map.tags[1].size,.14);
  const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:result.task.id}});assert.equal(start.statusCode,423);assert.match(start.body,/ROS2/);
  assert.equal((await app.inject({method:'POST',url:'/api/export',payload:{map:result.map,format:'pdf'}})).statusCode,400);
 }finally{await app.close();}
});
