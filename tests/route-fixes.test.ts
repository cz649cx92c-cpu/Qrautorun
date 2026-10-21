import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';
import {defaults,generate,mapSchema,type FieldMap,type Point} from '../web/shared/model';
import {generateBoards} from '../web/shared/boards';
import {compileDesignedRoute} from '../web/backend/src/route-design';

/**
 * 本轮四个现场问题的回归：
 * A. 删除路径只删指定 routeId + 其任务绑定；其它路径/地图版本不动；删除后 A 查不到、B 与地图不变。
 * B. 新建路径 routeId 每次唯一；只有“同地图同名真实已存在”才拒绝；删除后同名可复用；刷新/重启恢复；A/B 地图隔离。
 * C. 正交编译：斜线被明确拒绝；水平/垂直路径保存后控制点与 motionSegments 完全保持直线，不产生弧线/曲率点。
 */

const POSITIONS:[number,number][]=[[0,0],[1,0],[1,1],[1,2]];

function fixture(id:string):FieldMap{
 const map=generate({...defaults,count:1,startRow:1});map.id=id;
 const rowId=map.rows[0]!.id,groups=generateBoards({gridSize:1,groupSizeMm:80,groupCount:POSITIONS.length,startId:0});
 map.groups=groups;
 map.tags=POSITIONS.map(([x,y],index)=>({id:index,groupId:groups[index]!.id,rowId,x,y,angle:0,size:.08,kind:'waypoint',rules:[]}));
 const points=POSITIONS.map(([x,y])=>({x,y}));
 map.rows=[{id:rowId,name:'路线',width:.6,exitDistance:.8,start:points[0]!,points:points.slice(1)}];
 map.order=[rowId];map.routeMode='waypoints';
 return mapSchema.parse(map);
}
const routePoints=(map:FieldMap):Point[]=>{const row=map.rows[0]!;return [row.start!,...row.points];};

async function registerMap(app:any,map:FieldMap){
 const saved=await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});
 assert.equal(saved.statusCode,200,saved.body);
}

function saveRoute(app:any,mapId:string,payload:Record<string,unknown>){
 return app.inject({method:'POST',url:'/api/route/design',payload:{mapId,baseVersion:1,points:routePoints(fixture(mapId)),bodyYawDeg:0,...payload}});
}

test('A. 删除路径：只删指定 routeId 及其任务绑定，另一条路径与地图版本不变，删除后 A 不存在、B 可刷新恢复',async()=>{
 const folder=join(process.cwd(),'logs',`route-fixes-delete-${process.pid}-${Date.now()}`);mkdirSync(folder,{recursive:true});
 const db=join(folder,'navigation.db');let app=await createApp(db);
 const report=()=>app.inject('/api/maps/route-fix-map?version=1').then((response:any)=>JSON.stringify(response.json().map));
 try{
  const map=fixture('route-fix-map');await registerMap(app,map);
  const mapBefore=await report();
  const points=routePoints(map);
  const a=await saveRoute(app,'route-fix-map',{routeId:'route-a',routeName:'路线 A',points});
  assert.equal(a.statusCode,200,a.body);assert.equal(a.json().route.routeId,'route-a');
  const b=await saveRoute(app,'route-fix-map',{routeId:'route-b',routeName:'路线 B',points:[points[0]!,{x:1,y:0},{x:1,y:1}]});
  assert.equal(b.statusCode,200,b.body);
  const bBefore=(await app.inject('/api/routes/route-b')).json().route;
  const usageA=(await app.inject('/api/routes/route-a/usage')).json();assert.equal(usageA.tasks.length,1);
  const usageB=(await app.inject('/api/routes/route-b/usage')).json();assert.equal(usageB.tasks.length,1);
  // 另一张地图上的同名路径完全隔离
  const other=fixture('route-fix-other');await registerMap(app,other);
  const otherSave=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:'route-fix-other',baseVersion:1,routeId:'route-other',routeName:'路线 A',points:routePoints(other),bodyYawDeg:0}});
  assert.equal(otherSave.statusCode,200,otherSave.body);
  const mapListBefore=(await app.inject('/api/maps')).json();

  const deleted=await app.inject({method:'DELETE',url:'/api/routes/route-a?detachTasks=1'});
  assert.equal(deleted.statusCode,200,deleted.body);
  assert.equal(deleted.json().deletedTasks,1);
  // A 删除后不存在
  assert.equal((await app.inject('/api/routes/route-a')).statusCode,404);
  assert.equal((await app.inject('/api/routes')).json().length,2); // B + other map route
  const routesNow=(await app.inject('/api/routes?mapId=route-fix-map')).json();
  assert.deepEqual(routesNow.map((route:any)=>route.routeId),['route-b']);
  // B 完全不变（内容、更新时间、快照）
  const bAfter=(await app.inject('/api/routes/route-b')).json().route;
  assert.deepEqual(bAfter.points,bBefore.points);assert.equal(bAfter.updated,bBefore.updated);
  assert.deepEqual((await app.inject('/api/routes/route-b')).json().map.motionSegments,(await app.inject('/api/routes/route-b')).json().map.motionSegments);
  // 任务只移除 A 的绑定，B 与其它地图的任务还在
  const tasks=(await app.inject('/api/tasks')).json();
  assert.equal(tasks.filter((task:any)=>task.routeId==='route-a').length,0);
  assert.equal(tasks.filter((task:any)=>task.routeId==='route-b').length,1);
  assert.equal(tasks.filter((task:any)=>task.routeId==='route-other').length,1);
  // 地图版本与内容不变（删除路径不删地图/不改 rows）
  assert.equal(await report(),mapBefore);
  assert.deepEqual((await app.inject('/api/maps')).json(),mapListBefore);
  // 删除不存在的路径：404，且不误删其它
  assert.equal((await app.inject({method:'DELETE',url:'/api/routes/route-missing'})).statusCode,404);
 }finally{await app.close();}
 // 重启后刷新：A 不再出现，B 仍在
 app=await createApp(db);
 try{
  const routes=(await app.inject('/api/routes?mapId=route-fix-map')).json();
  assert.equal(routes.length,1);assert.equal(routes[0]!.routeId,'route-b');
  assert.equal((await app.inject('/api/routes/route-a')).statusCode,404);
  assert.equal((await app.inject('/api/routes/route-b')).statusCode,200);
 }finally{await app.close();rmSync(folder,{recursive:true,force:true});}
});

test('B. 新建路径：routeId 每次唯一；同名真实冲突才拒绝；删除后同名可复用；刷新恢复；A/B 隔离',async()=>{
 const folder=join(process.cwd(),'logs',`route-fixes-name-${process.pid}-${Date.now()}`);mkdirSync(folder,{recursive:true});
 const db=join(folder,'navigation.db');let app=await createApp(db);
 try{
  const map=fixture('route-fix-name-map');await registerMap(app,map);
  const points=routePoints(map);
  // 前端“新建路径”不传 routeId（saveAs=true），后端必须生成唯一编号
  const first=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,points,bodyYawDeg:0,routeName:'新路线一',saveAs:true}});
  assert.equal(first.statusCode,200,first.body);
  const firstRoute=first.json().route;assert.match(firstRoute.routeId,/^route-[0-9a-f]{24}$/);assert.equal(firstRoute.name,'新路线一');
  const second=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,points:[points[0]!,{x:1,y:0},{x:1,y:1}],bodyYawDeg:0,routeName:'新路线二',saveAs:true}});
  assert.equal(second.statusCode,200,second.body);
  const secondRoute=second.json().route;assert.notEqual(secondRoute.routeId,firstRoute.routeId);
  // 同地图同名真实冲突 → 409，且错误信息明确
  const duplicate=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,points,bodyYawDeg:0,routeName:'新路线一',saveAs:true}});
  assert.equal(duplicate.statusCode,409,duplicate.body);assert.match(duplicate.body,/同名/);
  // 删除第二条后，同名可重新使用（真实删除，不是“隐藏”）
  assert.equal((await app.inject({method:'DELETE',url:'/api/routes/'+secondRoute.routeId+'?detachTasks=1'})).statusCode,200);
  const reuse=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,points:[points[0]!,{x:1,y:0},{x:1,y:1}],bodyYawDeg:0,routeName:'新路线二',saveAs:true}});
  assert.equal(reuse.statusCode,200,reuse.body);assert.notEqual(reuse.json().route.routeId,secondRoute.routeId);
  // 编辑已有路径（带 routeId+routeUpdated）仍正常更新
  const current=(await app.inject('/api/routes/'+firstRoute.routeId)).json().route;
  const updated=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,routeId:firstRoute.routeId,routeUpdated:current.updated,points,bodyYawDeg:0,routeName:'新路线一（更新）'}});
  assert.equal(updated.statusCode,200,updated.body);assert.equal(updated.json().route.name,'新路线一（更新）');
  // 不同地图可以使用同一名称（隔离）
  const other=fixture('route-fix-name-other');await registerMap(app,other);
  const otherSameName=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:other.id,baseVersion:1,points:routePoints(other),bodyYawDeg:0,routeName:'新路线一（更新）',saveAs:true}});
  assert.equal(otherSameName.statusCode,200,otherSameName.body);
  assert.equal((await app.inject('/api/routes?mapId='+other.id)).json().length,1);
  assert.equal((await app.inject('/api/routes?mapId='+map.id)).json().length,2);
 }finally{await app.close();}
 app=await createApp(db);
 try{
  const routes=(await app.inject('/api/routes?mapId=route-fix-name-map')).json();
  assert.equal(routes.length,2);
  assert.deepEqual(routes.map((route:any)=>route.name).sort(),['新路线一（更新）','新路线二']);
 }finally{await app.close();rmSync(folder,{recursive:true,force:true});}
});

test('C. 正交路线：斜线明确拒绝；水平/垂直保存后控制点与 motionSegments 保持直线，不生成弧线/曲率点',async()=>{
 const folder=join(process.cwd(),'logs',`route-fixes-ortho-${process.pid}-${Date.now()}`);mkdirSync(folder,{recursive:true});
 const db=join(folder,'navigation.db');const app=await createApp(db);
 try{
  const map=fixture('route-fix-ortho');await registerMap(app,map);
  const points=routePoints(map);
  // 斜线：明确拒绝，不能保存
  const diagonal=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,points:[{x:0,y:0},{x:.5,y:.5},{x:1,y:.5}],bodyYawDeg:0,routeName:'斜线路径',saveAs:true}});
  assert.equal(diagonal.statusCode,400,diagonal.body);
  assert.match(diagonal.body,/正交/);
  const arc=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,points:[{x:0,y:0},{x:.5,y:.25},{x:1,y:0}],bodyYawDeg:0,routeName:'弧线路径',saveAs:true}});
  assert.equal(arc.statusCode,400,arc.body);assert.match(arc.body,/正交/);
  // 直接调用编译：斜线抛错，水平/垂直线段逐点共线
  assert.throws(()=>compileDesignedRoute(map,[{x:0,y:0},{x:.5,y:.5}],0),/正交/);
  const compiled=compileDesignedRoute(map,points,0);
  const assertStraight=(list:Point[])=>{for(let i=1;i<list.length;i++){const a=list[i-1]!,b=list[i]!;assert.ok(Math.abs(a.x-b.x)<1e-9||Math.abs(a.y-b.y)<1e-9,`${JSON.stringify([a,b])} 不是水平/垂直直线`);}};
  assertStraight(compiled.map.motionSegments!.flatMap(segment=>segment.points));
  assertStraight(compiled.map.rows[0]!.points);
  const allowedModes=new Set(['4t4d','crab']);const allowedDirections=new Set(['forward','reverse','lateral']);const allowedStrategies=new Set([undefined,'auto','forward','reverse','left','right','turn_forward']);
  for(const segment of compiled.map.motionSegments!){
   assert.ok(allowedModes.has(segment.mode));assert.ok(allowedDirections.has(segment.direction));assert.ok(allowedStrategies.has(segment.strategy));
   assert.equal(segment.executionProfile,'recorded_slow_trial');
  }
  // 保存水平/垂直路径：控制点原样保留（不插斜点），motionSegments 全为直线
  const saved=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,points,bodyYawDeg:0,routeName:'正交路径',saveAs:true}});
  assert.equal(saved.statusCode,200,saved.body);
  assert.deepEqual(saved.json().route.points,points);
  assertStraight(saved.json().route.motionSegments.flatMap((segment:any)=>segment.points));
  assertStraight(saved.json().route.points);
  // rows 是给画布用的加密折线，只要求仍是正交直线、端点与控制点一致（不是另一条曲线）
  const rowsPoints=saved.json().map.rows[0].points as Point[];
  assertStraight(rowsPoints);
  assert.deepEqual([saved.json().map.rows[0].start,rowsPoints.at(-1)],[saved.json().route.points[0],saved.json().route.points.at(-1)]);
  // 水平单段保持不变
  const horizontal=[{x:0,y:0},{x:1,y:0}];
  const flat=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,points:horizontal,bodyYawDeg:0,routeName:'水平路径',saveAs:true}});
  assert.equal(flat.statusCode,200,flat.body);assert.deepEqual(flat.json().route.points,horizontal);
 }finally{await app.close();rmSync(folder,{recursive:true,force:true});}
});
