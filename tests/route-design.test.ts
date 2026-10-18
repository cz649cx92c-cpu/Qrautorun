import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compileDesignedRoute} from '../web/backend/src/route-design';
import {createApp} from '../web/backend/src/server';
import {defaults,generate,mapSchema,validate,distance,exitPoint,type FieldMap,type Point} from '../web/shared/model';
import {generateBoards} from '../web/shared/boards';
import {orthogonalRoute,routeCorners,snapRoutePoint} from '../web/shared/route-design';
const positions=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
function fixture(points=positions):FieldMap {
 const map=generate({...defaults,count:1,startRow:1});map.id='scan-path-editor-test';
 const rowId=map.rows[0]!.id,groups=generateBoards({gridSize:1,groupSizeMm:80,groupCount:points.length,startId:0});
 map.groups=groups;map.tags=points.map((p,i)=>({id:i,groupId:groups[i]!.id,rowId,...p,angle:0,size:.08,kind:'waypoint',rules:[]}));
 return mapSchema.parse(map);
}
function assertMissionShape(map:FieldMap){
 assert.equal(map.routeMode,'waypoints');assert.equal(map.rows.length,1);assert.deepEqual(map.order,[map.rows[0]!.id]);
 assert.ok(map.rows[0]!.points.length<=1000);assert.deepEqual(validate(map).errors,[]);
 const combined=[exitPoint(map.rows[0]!),...map.rows[0]!.points];
 assert.ok(combined.length<=1001);
 for(const s of map.motionSegments!){
  for(const [id,p] of [[s.fromId,s.points[0]!],[s.toId,s.points.at(-1)!]] as const)assert.ok(distance(map.tags.find(t=>t.id===id)!,p)<=.03);
  assert.equal(s.executionProfile,'recorded_slow_trial');assert.equal(s.bodyYaw,s.endYaw);
  for(let i=1;i<s.points.length;i++){const a=s.points[i-1]!,b=s.points[i]!;assert.ok(a.x===b.x||a.y===b.y);assert.ok(distance(a,b)>=.001&&distance(a,b)<=.050051);}
 }
 assert.deepEqual(combined,[map.motionSegments![0]!.points[0],...map.motionSegments!.flatMap(s=>s.points.slice(1))]);
}

test('编辑器：水平/垂直优先布线、组中心优先吸附、拖动与删除后仍正交',()=>{
 assert.deepEqual(orthogonalRoute([{x:0,y:0},{x:1,y:.5}]),[{x:0,y:0},{x:1,y:0},{x:1,y:.5}]);
 assert.deepEqual(orthogonalRoute([{x:0,y:0},{x:.5,y:1}]),[{x:0,y:0},{x:0,y:1},{x:.5,y:1}]);
 assert.deepEqual(orthogonalRoute([{x:0,y:0},{x:1,y:1}])[1],{x:1,y:0});
 assert.deepEqual(snapRoutePoint({x:.131,y:.137},[{x:.123,y:.139}]),{x:.123,y:.139});
 assert.deepEqual(snapRoutePoint({x:.04,y:0},[{x:0,y:0}]),{x:0,y:0});
 assert.deepEqual(snapRoutePoint({x:.126,y:.173},[]),{x:.15000000000000002,y:.15000000000000002});
 const moved=orthogonalRoute([{x:0,y:0},{x:.3,y:.7},{x:1,y:1}]);
 assert.ok(moved.every((p,i)=>!i||p.x===moved[i-1]!.x||p.y===moved[i-1]!.y));
 assert.deepEqual(routeCorners([{x:0,y:0},{x:.5,y:0},{x:1,y:0}]),[{x:0,y:0},{x:1,y:0}]);
});
test('编译器：按定位组切分、方向与字段完整、保留组中心和单行绑定',()=>{
 const source=fixture(),before=JSON.stringify(source),result=compileDesignedRoute(source,positions,0);assertMissionShape(result.map);
 assert.deepEqual(result.map.motionSegments!.map(s=>[s.fromId,s.toId,s.mode,s.direction]),[[0,1,'4t4d','forward'],[1,2,'crab','lateral'],[2,3,'4t4d','reverse']]);
 assert.equal(result.map.motionSegments![1]!.wheelAngle,90);assert.equal(JSON.stringify(source),before);assert.deepEqual(result.map.groups,source.groups);
 assert.equal(result.map.rows[0]!.id,source.rows[0]!.id);
});
test('编译器：直线途经组中心也切分，非组起终点被截去',()=>{
 const result=compileDesignedRoute(fixture([{x:0,y:0},{x:1,y:0},{x:2,y:0}]),[{x:-.5,y:0},{x:2.5,y:0}],0);
 assertMissionShape(result.map);assert.equal(result.map.motionSegments!.length,2);assert.deepEqual(result.trimmed,{startM:.5,endM:.5});assert.equal(result.lengthM,2);
});
test('编译器：端点3厘米容差保留正交，不把中心强行投影改成斜线',()=>{
 const source=fixture([{x:0,y:.03},{x:1,y:.029999}]);
 const result=compileDesignedRoute(source,[{x:0,y:0},{x:1,y:0}],0);assertMissionShape(result.map);
 assert.deepEqual(result.map.tags.map(t=>({x:t.x,y:t.y})),[{x:0,y:.03},{x:1,y:.029999}]);
 assert.throws(()=>compileDesignedRoute(fixture([{x:0,y:.030001},{x:1,y:0}]),[{x:0,y:0},{x:1,y:0}],0),/两个定位组/);
});
test('编译器：拒绝斜线、重复点、非有限值、点数/长度超限、缺定位组拐角与过短区间',()=>{
 const source=fixture();
 assert.throws(()=>compileDesignedRoute(source,[{x:0,y:0},{x:1,y:1}],0),/正交/);
 assert.throws(()=>compileDesignedRoute(source,[{x:0,y:0},{x:0,y:0}],0),/1毫米/);
 assert.throws(()=>compileDesignedRoute(source,[{x:NaN,y:0},{x:1,y:0}],0));
 assert.throws(()=>compileDesignedRoute(source,Array.from({length:502},(_,x)=>({x,y:0})),0),/501/);
 assert.throws(()=>compileDesignedRoute(source,[{x:0,y:0},{x:51,y:0}],0),/50米/);
 assert.throws(()=>compileDesignedRoute(fixture([{x:0,y:0},{x:1,y:1}]),positions.slice(0,3),0),/缺少定位组/);
 assert.throws(()=>compileDesignedRoute(fixture([{x:0,y:0},{x:.079,y:0}]),[{x:0,y:0},{x:.079,y:0}],0),/8厘米/);
 assert.throws(()=>compileDesignedRoute(source,positions,NaN),/车头朝向/);
});
test('编译器：角度分类服从执行器语义，45/135度前后边界不能绕过航向校验',()=>{
 const source=fixture([{x:0,y:0},{x:1,y:0}]),points=[{x:0,y:0},{x:1,y:0}];
 for(const yaw of [0,5,175,180,-180,90,-90,46,134,-60]){
  const result=compileDesignedRoute(source,points,yaw);assertMissionShape(result.map);
  const s=result.map.motionSegments![0]!;
  assert.equal(s.direction,Math.abs(yaw)<=45?'forward':Math.abs(yaw)>=135?'reverse':'lateral');
  assert.ok(Math.abs(s.wheelAngle)<=90);
 }
 for(const yaw of [45,135,-45,-135,6])assert.throws(()=>compileDesignedRoute(source,points,yaw),/5.7度/);
});
test('编译器：同组折返与100段/1001点上限',()=>{
 const result=compileDesignedRoute(fixture(),[...positions,{x:0,y:0}],0);assertMissionShape(result.map);assert.equal(result.map.motionSegments!.at(-1)!.toId,0);
 const nodes=Array.from({length:102},(_,i)=>({x:i*.1,y:0}));assert.throws(()=>compileDesignedRoute(fixture(nodes),[nodes[0]!,nodes.at(-1)!],0),/100段/);
 const nearLimit=[{x:0,y:0},{x:25,y:0},{x:49.99,y:0}];const last=compileDesignedRoute(fixture(nearLimit),nearLimit,0);assertMissionShape(last.map);assert.equal(last.map.rows[0]!.points.length,1000);
 const uneven=[{x:0,y:0},{x:.081,y:0},{x:50,y:0}];assert.throws(()=>compileDesignedRoute(fixture(uneven),[uneven[0]!,uneven[2]!],0),/1001点/);
});
test('交叉验证：编译产物通过真实 Python validate_segments 与 Mission.start（含返回路径）',()=>{
 const maps=[compileDesignedRoute(fixture(),positions,0).map,compileDesignedRoute(fixture(),positions,90).map,
  compileDesignedRoute(fixture([{x:0,y:0},{x:1,y:0}]),[{x:0,y:0},{x:1,y:0}],60).map];
 const script=`import json,sys,yaml
from pathlib import Path
from greenhouse_navigation.segment_execution import validate_segments
from greenhouse_navigation.mission import Mission
from greenhouse_navigation.control import Pose
config=yaml.safe_load(Path('config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters']
for field in json.load(sys.stdin):
 field['coordinateStatus']='reviewed'
 validate_segments(field['motionSegments'])
 for returning in (False,True):
  task={'id':'test','rowOrder':[field['rows'][0]['id']],'returnToStart':returning}
  s=field['motionSegments'][0];p=s['points'][0]
  m=Mission(config);m.start(field,task,Pose(p['x'],p['y'],s['bodyYaw']))
  validate_segments(m.segment_executor.segments)
  assert m.running and m.segment_executor is not None
print('Python mission + segment validation OK')`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',script],{cwd:fileURLToPath(new URL('../',import.meta.url)),input:JSON.stringify(maps),encoding:'utf8',env:{...process.env,PYTHONPATH:fileURLToPath(new URL('../src/greenhouse_navigation',import.meta.url)),PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/validation OK/);
});
test('实际API：保存新版本/接纳/任务创建与更新/版本冲突/错误不产生新版本',async()=>{
 const app=await createApp(':memory:');try{
  const map=fixture();const initial=await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});assert.equal(initial.statusCode,200,initial.body);
  const payload={mapId:map.id,baseVersion:1,points:positions,bodyYawDeg:0};
  const saved=await app.inject({method:'POST',url:'/api/route/design',payload});assert.equal(saved.statusCode,200,saved.body);
  const value=saved.json();assert.equal(value.version,2);assert.equal(value.map.coordinateStatus,'reviewed');assert.equal(value.acceptance.kind,'office_test');assert.equal(value.acceptance.accepted,true);assert.equal(value.acceptance.digestValid,true);
  assertMissionShape(value.map);assert.equal(value.task.mapVersion,2);assert.deepEqual(value.task.rowOrder,value.map.order);
  const custom={...value.task,id:'task-second',forwardSpeed:.12,returnToStart:true};assert.equal((await app.inject({method:'POST',url:'/api/tasks',payload:custom})).statusCode,200);
  const again=await app.inject({method:'POST',url:'/api/route/design',payload:{...payload,baseVersion:2}});assert.equal(again.statusCode,200,again.body);assert.equal(again.json().updatedTasks.length,2);
  const updated=(await app.inject('/api/tasks')).json();assert.ok(updated.every((t:any)=>t.mapVersion===3&&JSON.stringify(t.rowOrder)===JSON.stringify(value.map.order)));assert.equal(updated.find((t:any)=>t.id==='task-second').forwardSpeed,.12);
  assert.equal((await app.inject({method:'POST',url:'/api/route/design',payload})).statusCode,409);
  const bad=await app.inject({method:'POST',url:'/api/route/design',payload:{...payload,baseVersion:3,points:[{x:0,y:0},{x:1,y:1}]}});assert.equal(bad.statusCode,400);assert.match(bad.json().error,/正交/);
  assert.equal((await app.inject('/api/maps/'+map.id)).json().version,3);
  const missing=await app.inject({method:'POST',url:'/api/route/design',payload:{...payload,mapId:'missing'}});assert.equal(missing.statusCode,404);
  const invalid=await app.inject({method:'POST',url:'/api/route/design',payload:{...payload,bodyYawDeg:999}});assert.equal(invalid.statusCode,400);assert.match(invalid.json().error,/路径参数无效/);
  assert.equal((await app.inject('/api/robot/status')).json().running,false);
 }finally{await app.close();}
});
