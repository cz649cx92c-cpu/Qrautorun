import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {createSurvey,appendSamples,getSurvey} from '../web/backend/src/survey';
import {generateBoards} from '../web/shared/boards';

async function fixture(run:(a:Awaited<ReturnType<typeof createApp>>,s:Store)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'qr-single-tag-')),p=join(dir,'test.db'),a=await createApp(p),s=new Store(p);
 try{await run(a,s);}finally{s.close();await a.close();rmSync(dir,{recursive:true,force:true});}
}
// 只观测一个成员（例如 B049 的 Q064），只 1 帧
function singleMemberRecording(s:Store,boards:ReturnType<typeof generateBoards>,memberId:number,groupId:string){
 const board=boards.find(b=>b.id===groupId)!;
 const member=board.members.find(m=>m.id===memberId)!;
 const r=createSurvey(s,'single-tag',boards);
 // 单码观测：tag.id 就是被观测到的那个成员，坐标是该成员相对组中心的偏移
 appendSamples(s,r.id,[{stamp:1,pose:{x:1,y:2,yaw:0},representation:'board-centers',groupLayouts:[board],
  calibrated:true,synchronized:true,quality:'verified',localEpoch:'epoch',
  tags:[{id:memberId,groupId:board.id,x:member.x,y:member.y,angle:member.angle,sigma:.05,
   memberIds:[memberId],visibleCount:1,size:board.sizeMm/1000}]}]);
 s.db.prepare('UPDATE survey_sessions SET state=? WHERE id=?').run('stopped',r.id);
 return {session:getSurvey(s,r.id),board,member};
}
const save=(a:Awaited<ReturnType<typeof createApp>>,id:string)=>a.inject({method:'POST',url:'/api/survey/map',payload:{sessionId:id,baseVersion:0}});

test('单码推断整组：只观测 B049 的一个成员即保存完整 16 码地图',async()=>fixture(async(a,s)=>{
 const boards=generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:49});
 const board=boards[0]!;
 const {session}=singleMemberRecording(s,boards,64,board.id);
 assert.equal(session.samples.length,1,'只有 1 帧观测');
 const res=await save(a,session.id);
 assert.equal(res.statusCode,200,res.body);
 const map=res.json().map;
 assert.equal(map.routeMode,'map-only');
 // 地图模型：每组只存 1 个组中心 tag，完整成员在 groups[].members
 assert.equal(map.tags.length,1,'单码推断生成 1 个组中心');
 const center=map.tags[0];
 assert.equal(center.id,board.referenceId,'组中心 id = referenceId');
 assert.equal(center.groupId,board.id);
 assert.ok(Math.abs(center.size-board.sizeMm/1000)<1e-9,'尺寸按 board 规格');
 const g=map.groups.find((x:any)=>x.id===board.id);
 assert.ok(g,'groups 必须包含该定位组');
 assert.equal(g.members.length,16,'完整 16 个成员');
 assert.deepEqual(g.members.map((m:any)=>m.id).sort((x:number,y:number)=>x-y),board.members.map(m=>m.id).sort((x,y)=>x-y));
 assert.equal(map.coordinateStatus,'draft');
 assert.deepEqual(map.rows,[]);assert.deepEqual(map.order,[]);
 assert.equal(res.json().route,null);assert.equal(res.json().task,null);
}));

test('单码推断：观测成员位置正确换算为整组中心，几何相对关系保持',async()=>fixture(async(a,s)=>{
 const boards=generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:49});
 const board=boards[0]!;
 const {session,member}=singleMemberRecording(s,boards,64,board.id);
 const res=await save(a,session.id);
 assert.equal(res.statusCode,200,res.body);
 const map=res.json().map;
 const center=map.tags[0];
 // 观测成员位于 pose(1,2)+member 偏移；组中心应回推到 (1,2)
 assert.ok(Math.abs(center.x-1)<1e-6,`组中心 x 应=1 实际=${center.x}`);
 assert.ok(Math.abs(center.y-2)<1e-6,`组中心 y 应=2 实际=${center.y}`);
 // groups 中成员几何保持 board 定义（相对偏移不变）
 const g=map.groups.find((x:any)=>x.id===board.id);
 const m49=g.members.find((m:any)=>m.id===49),m50=g.members.find((m:any)=>m.id===50);
 const d49=board.members.find(m=>m.id===49)!,d50=board.members.find(m=>m.id===50)!;
 assert.ok(Math.abs(Math.hypot(m49.x-m50.x,m49.y-m50.y)-Math.hypot(d49.x-d50.x,d49.y-d50.y))<1e-9,'组内间距保持');
}));

test('单码推断不依赖旧地图：旧地图存在且 mapId/version 不同仍建新地图',async()=>fixture(async(a,s)=>{
 // 先建一张旧地图
 const old=generateBoards({gridSize:2,groupSizeMm:140,groupCount:1,startId:200});
 const oldRec=createSurvey(s,'old-map',old);
 appendSamples(s,oldRec.id,[{stamp:1,pose:{x:0,y:0,yaw:0},representation:'board-centers',groupLayouts:[old[0]!],
  calibrated:true,synchronized:true,quality:'verified',localEpoch:'epoch',
  tags:[{id:200,groupId:old[0]!.id,x:0,y:0,angle:0,sigma:.05,memberIds:[200],visibleCount:1,size:.14}]}]);
 s.db.prepare('UPDATE survey_sessions SET state=? WHERE id=?').run('stopped',oldRec.id);
 const oldRes=await save(a,oldRec.id);assert.equal(oldRes.statusCode,200,oldRes.body);
 const oldMap=oldRes.json().map;
 // 新扫描只观测 B049 的一个成员
 const boards=generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:49});
 const {session}=singleMemberRecording(s,boards,64,boards[0]!.id);
 const res=await save(a,session.id);assert.equal(res.statusCode,200,res.body);
 const newMap=res.json().map;
 assert.notEqual(newMap.id,oldMap.id,'必须是新 mapId');
 assert.equal(newMap.tags.length,1,'单码推断生成 1 个组中心');
 assert.equal(newMap.groups.find((g:any)=>g.id===boards[0]!.id).members.length,16);
 // 旧地图仍存在且内容不变
 const stillOld=(await a.inject('/api/maps/'+oldMap.id)).json();
 assert.deepEqual(stillOld.map,oldMap,'旧地图内容不变');
}));

test('多板单码：各自只观测 1 个成员，按 board 去重生成多个完整组',async()=>fixture(async(a,s)=>{
 const boards=[...generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:49}),
               ...generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:65})];
 const b49=boards[0]!,b65=boards[1]!;
 const r=createSurvey(s,'multi-board',boards);
 appendSamples(s,r.id,[{stamp:1,pose:{x:0,y:0,yaw:0},representation:'board-centers',groupLayouts:[b49,b65],
  calibrated:true,synchronized:true,quality:'verified',localEpoch:'epoch',
  tags:[{id:b49.members[0]!.id,groupId:b49.id,x:b49.members[0]!.x,y:b49.members[0]!.y,angle:0,sigma:.05,memberIds:[b49.members[0]!.id],visibleCount:1,size:b49.sizeMm/1000}]},
  {stamp:2,pose:{x:3,y:0,yaw:0},representation:'board-centers',groupLayouts:[b49,b65],
   calibrated:true,synchronized:true,quality:'verified',localEpoch:'epoch',
   tags:[{id:b65.members[0]!.id,groupId:b65.id,x:b65.members[0]!.x,y:b65.members[0]!.y,angle:0,sigma:.05,memberIds:[b65.members[0]!.id],visibleCount:1,size:b65.sizeMm/1000}]}]);
 s.db.prepare('UPDATE survey_sessions SET state=? WHERE id=?').run('stopped',r.id);
 const res=await save(a,getSurvey(s,r.id).id);assert.equal(res.statusCode,200,res.body);
 const map=res.json().map;
 assert.equal(map.tags.length,2,'两组各 1 个组中心');
 const gids=new Set(map.tags.map((t:any)=>t.groupId));
 assert.equal(gids.size,2);
 assert.ok(gids.has(b49.id)&&gids.has(b65.id));
 for(const gid of [b49.id,b65.id]){
  const g=map.groups.find((x:any)=>x.id===gid);
  assert.equal(g.members.length,16,`${gid} 完整 16 成员`);
 }
}));

test('未知单码：未登记定位组时明确拒绝，不伪造整组',async()=>fixture(async(a,s)=>{
 // session.boards 只登记 B049；观测指向未登记的板，采集或保存任一环节都必须拒绝
 const registered=generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:49});
 const foreign=generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:300})[0]!;
 const r=createSurvey(s,'unknown',registered);
 let rejected=false,message='';
 try{
  appendSamples(s,r.id,[{stamp:1,pose:{x:0,y:0,yaw:0},representation:'board-centers',groupLayouts:[foreign],
   calibrated:true,synchronized:true,quality:'verified',localEpoch:'epoch',
   tags:[{id:foreign.referenceId,groupId:foreign.id,x:0,y:0,angle:0,sigma:.05,memberIds:[foreign.referenceId],visibleCount:1,size:foreign.sizeMm/1000}]}]);
  s.db.prepare('UPDATE survey_sessions SET state=? WHERE id=?').run('stopped',r.id);
  const res=await save(a,r.id);
  rejected=res.statusCode!==200;message=res.body;
 }catch(e){rejected=true;message=String(e);}
 assert.ok(rejected,'未知码必须被拒绝');
 assert.match(message,/未登记定位组|无法推断|不一致|成员|布局/);
 assert.equal((await a.inject('/api/maps')).json().length,0,'不得产生地图');
}));


