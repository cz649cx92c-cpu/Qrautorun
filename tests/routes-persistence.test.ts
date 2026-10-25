import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';
import {defaults,generate,exitPoint} from '../web/shared/model';
import Database from 'better-sqlite3';
import {Store,legacyRouteId} from '../web/backend/src/store';
import {compileDesignedRoute} from '../web/backend/src/route-design';
import {RobotLink} from '../web/backend/src/robot';

test('命名路径持久化：A/B独立、updated冲突、任务快照与地图版本不污染',async()=>{
 const folder=join(process.cwd(),'logs',`editor-ux-v3-route-${process.pid}-${Date.now()}`);mkdirSync(folder,{recursive:true});const db=join(folder,'navigation.db');
 const app=await createApp(db);
 try{
  const map=generate({...defaults,count:1,length:2,tagSpacing:1,angle:0});map.id='route-v3-map';
  assert.equal((await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}})).statusCode,200);
  const original=JSON.stringify((await app.inject('/api/maps/route-v3-map?version=1')).json().map);
  const points=[exitPoint(map.rows[0]!),...map.rows[0]!.points];
  const save=(routeId:string,name:string,routePoints=points,extra:Record<string,unknown>={})=>app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,routeId,routeName:name,points:routePoints,bodyYawDeg:0,...extra}});
  const a=await save('route-a','路线 A');assert.equal(a.statusCode,200,a.body);const aJson=a.json();assert.equal(aJson.route.routeId,'route-a');
  assert.deepEqual(aJson.task.routeSnapshot,aJson.route);
  const b=await save('route-b','路线 B',[points[0]!,{x:1,y:0},{x:1,y:1}]);assert.equal(b.statusCode,200,b.body);
  const bTask=b.json().task;assert.deepEqual(bTask.routeSnapshot,b.json().route);
  const routes=(await app.inject('/api/routes?mapId=route-v3-map')).json();assert.equal(routes.length,2);assert.deepEqual(routes.map((r:any)=>r.name).sort(),['路线 A','路线 B']);
  const aBefore=routes.find((r:any)=>r.routeId==='route-a');const bBefore=routes.find((r:any)=>r.routeId==='route-b');
  const update=await save('route-a','路线 A（更新）',[points[0]!,{x:2,y:0},{x:2,y:1}],{routeUpdated:aBefore.updated});assert.equal(update.statusCode,200,update.body);
  const bAfter=(await app.inject('/api/routes/route-b')).json().route;assert.deepEqual(bAfter.points,bBefore.points);assert.equal(bAfter.updated,bBefore.updated);
  const stale=await save('route-a','错误覆盖',[points[0]!,{x:1,y:0},{x:1,y:1}],{routeUpdated:aBefore.updated});assert.equal(stale.statusCode,409,stale.body);
  assert.equal(JSON.stringify((await app.inject('/api/maps/route-v3-map?version=1')).json().map),original);
  const tasks=(await app.inject('/api/tasks')).json();assert.equal(tasks.filter((t:any)=>t.routeId).length,2);assert.ok(tasks.every((t:any)=>t.mapVersion===1));assert.deepEqual(tasks.find((t:any)=>t.id===bTask.id),bTask);
  assert.equal((await save('route-a','无基准')).statusCode,409);
  assert.equal((await save('duplicate','路线 B')).statusCode,409);
  const other={...map,id:'other-map'};assert.equal((await app.inject({method:'POST',url:'/api/maps',payload:{map:other,baseVersion:0}})).statusCode,200);
  assert.deepEqual((await app.inject('/api/routes?mapId=other-map')).json(),[]);
  const cross=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:other.id,baseVersion:1,routeId:'route-a',routeName:'跨图覆盖',routeUpdated:update.json().route.updated,points,bodyYawDeg:0}});assert.equal(cross.statusCode,409);
  assert.equal((await app.inject({method:'DELETE',url:'/api/routes/route-a'})).statusCode,409);
  assert.equal((await app.inject({method:'DELETE',url:'/api/routes/not-found'})).statusCode,404);
 }finally{await app.close();}
 const reopened=await createApp(db);try{const routes=(await reopened.inject('/api/routes?mapId=route-v3-map')).json();assert.equal(routes.length,2);assert.equal(routes.find((r:any)=>r.routeId==='route-a').name,'路线 A（更新）');}finally{await reopened.close();rmSync(folder,{recursive:true,force:true});}
});

test('旧库迁移不改 versions/tasks/acceptances，长ID、幂等及无tasks表删除安全',()=>{
 const folder=join(process.cwd(),'logs','editor-ux-v3-legacy-'+process.pid+'-'+Date.now());mkdirSync(folder,{recursive:true});const path=join(folder,'legacy.db');
 const raw=new Database(path);const base=generate({...defaults,count:1,length:2,tagSpacing:1,angle:0});base.id='m'.repeat(80);
 const map=compileDesignedRoute(base,[exitPoint(base.rows[0]!),...base.rows[0]!.points],0).map;
 raw.exec('CREATE TABLE versions(map_id TEXT,version INTEGER,name TEXT,created TEXT,body TEXT,PRIMARY KEY(map_id,version)); CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT,updated TEXT); CREATE TABLE acceptances(map_id TEXT,version INTEGER,digest TEXT,body TEXT,PRIMARY KEY(map_id,version));');
 raw.prepare('INSERT INTO versions VALUES(?,?,?,?,?)').run(map.id,1,map.name,'old-map-time',JSON.stringify(map));
 raw.prepare('INSERT INTO tasks VALUES(?,?,?)').run('old-task',JSON.stringify({id:'old-task',mapId:map.id,mapVersion:1,custom:'原样保留'}),'old-task-time');
 raw.prepare('INSERT INTO acceptances VALUES(?,?,?,?)').run(map.id,1,'unchanged-digest','原验收正文');
 const bodies=()=>['versions','tasks','acceptances'].map(table=>raw.prepare('SELECT * FROM '+table).all());const before=bodies();
 let store=new Store(path);assert.deepEqual(bodies(),before);const first=store.listRoutes();assert.equal(first.length,1);assert.equal(first[0]!.routeId,legacyRouteId(map.id));assert.ok(first[0]!.routeId.length<=80);store.close();
 store=new Store(path);assert.deepEqual(store.listRoutes(),first);assert.deepEqual(bodies(),before);store.close();raw.close();
 const empty=new Store(':memory:');const route=first[0]!;empty.saveRoute(route);empty.deleteRoute(route.routeId);assert.deepEqual(empty.listRoutes(),[]);empty.close();rmSync(folder,{recursive:true,force:true});
});

test('任务使用保存路线快照，导航拒绝旧地图、损坏摘要和disabled（机器人替身）',async()=>{
 const folder=join(process.cwd(),'logs','editor-ux-v3-safe-'+process.pid+'-'+Date.now());mkdirSync(folder,{recursive:true});const path=join(folder,'safe.db');
 const oldStatus=RobotLink.prototype.status,oldEnqueue=RobotLink.prototype.enqueue;const commands:any[]=[];
 RobotLink.prototype.status=function(){return {...oldStatus.call(this),connected:true,running:false,conditions:[{id:'mock',label:'纯软件替身',ready:true}]};};
 RobotLink.prototype.enqueue=function(type,payload){commands.push({type,payload});return {accepted:true,commandId:'00000000-0000-4000-8000-000000000000',state:'mock'};};
 const app=await createApp(path);const db=new Database(path);
 try{
  const base=generate({...defaults,count:1,length:2,tagSpacing:1,angle:0});const points=[exitPoint(base.rows[0]!),...base.rows[0]!.points];const map=compileDesignedRoute(base,points,0).map;map.id='snapshot-map';
  assert.equal((await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}})).statusCode,200);
  const saved=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,routeId:'snapshot-route',routeName:'快照路线',points,bodyYawDeg:0}});assert.equal(saved.statusCode,200,saved.body);const task=saved.json().task;
  assert.equal((await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:task.id}})).statusCode,200);assert.deepEqual(commands[0].payload.map.motionSegments,task.routeSnapshot.motionSegments);
  const replace=(value:any)=>db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(value),task.id);
  replace({...task,enabled:false});assert.equal((await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:task.id}})).statusCode,423);
  replace({...task,routeSnapshot:{...task.routeSnapshot,mapDigest:'0'.repeat(64)}});assert.equal((await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:task.id}})).statusCode,400);
  // 自用版：切图即生效，acceptance 记录不再是导航放行条件（前端也不再要求点击启用）。
  replace(task);db.prepare('DELETE FROM acceptances WHERE map_id=?').run(map.id);assert.equal((await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:task.id}})).statusCode,200,'没有验收记录也不得阻止导航');
  assert.equal((await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:1}})).statusCode,200);const stale=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:task.id}});assert.equal(stale.statusCode,400);assert.match(stale.body,/地图已有修改/);assert.equal(commands.length,2,'只有两次合法启动可以入队');
 }finally{db.close();await app.close();RobotLink.prototype.status=oldStatus;RobotLink.prototype.enqueue=oldEnqueue;rmSync(folder,{recursive:true,force:true});}
});
