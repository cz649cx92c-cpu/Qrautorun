import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';
import {defaults,generate,mapSchema,distance,type FieldMap,type Point} from '../web/shared/model';
import {generateBoards} from '../web/shared/boards';
import {
 AXIS_EPS,diagnoseRouteBindings,equalizeLegs,insertAnchorAt,mirrorRoute,moveAnchorKeepingOrthogonal,
 removeAnchor,rotateRoute,snapToGrid,translateRoute,validateRouteGeometry,
} from '../web/shared/route-geometry';

const pts=(...pairs:[number,number][]) => pairs.map(([x,y])=>({x,y}));
const orthogonal=(points:Point[]) => points.every((point,index) => !index || Math.abs(point.x-points[index-1]!.x)<=AXIS_EPS || Math.abs(point.y-points[index-1]!.y)<=AXIS_EPS);
const outer=(points:Point[]) => points.map(point=>({x:point.x,y:point.y}));

// --- batch anchor editing ---------------------------------------------------

test('几何编辑：插入锚点保持正交，直线中间不插拐点，偏移插入自动补拐点',()=>{
 const source=pts([0,0],[1,0],[1,1]),before=JSON.stringify(source);
 const straight=insertAnchorAt(source,1,{x:.5,y:0});
 assert.equal(straight.ready,true,JSON.stringify(straight.issues));
 assert.deepEqual(straight.points,pts([0,0],[.5,0],[1,0],[1,1]));
 assert.equal(straight.insertedIndex,1);assert.deepEqual(straight.cornerIndexes,[]);
 assert.ok(orthogonal(straight.points));

 const offset=insertAnchorAt(source,1,{x:.5,y:.2});
 assert.equal(offset.ready,true,JSON.stringify(offset.issues));
 assert.ok(orthogonal(offset.points),'偏移插入后仍必须正交');
 assert.equal(offset.cornerIndexes.length,2);
 assert.deepEqual(offset.points,pts([0,0],[.5,0],[.5,.2],[1,.2],[1,0],[1,1]));
 assert.equal(JSON.stringify(source),before,'入参不得被修改');

 assert.equal(insertAnchorAt(source,5,{x:0,y:0}).issues[0]!.code,'bad-index');
 assert.equal(insertAnchorAt(source,1,{x:0,y:0}).issues[0]!.code,'duplicate-point');
 assert.equal(insertAnchorAt(source,1,{x:Number.NaN,y:0}).issues[0]!.code,'bad-point');
 assert.equal(insertAnchorAt(source,1,{x:9,y:9}).ready,true,'超出地图范围由吸附与编译门负责，这里只保证正交');
 assert.ok(orthogonal(insertAnchorAt(source,1,{x:9,y:9}).points));
});

test('几何编辑：删除锚点，直线中间可删，拐点与折返顶点拒绝并说明原因',()=>{
 const line=pts([0,0],[.5,0],[1,0]);
 const middle=removeAnchor(line,1);
 assert.equal(middle.ready,true,JSON.stringify(middle.issues));
 assert.deepEqual(middle.points,pts([0,0],[1,0]));assert.equal(middle.changed,true);

 const corner=removeAnchor(pts([0,0],[1,0],[1,1]),1);
 assert.equal(corner.ready,false);assert.equal(corner.issues[0]!.code,'corner-required');
 assert.match(corner.issues[0]!.message,/拐点/);
 assert.deepEqual(corner.points,pts([0,0],[1,0],[1,1]),'拒绝时不得改动路径');

 assert.equal(removeAnchor(line,2).ready,true,'终点可删除');
 assert.equal(removeAnchor(line,0).ready,true,'起点可删除');
 assert.equal(removeAnchor(pts([0,0],[1,0]),1).issues[0]!.code,'too-few-points');
 assert.equal(removeAnchor(pts([0,0],[1,0],[0,0]),1).issues[0]!.code,'fold-required');
 assert.equal(removeAnchor(line,7).issues[0]!.code,'bad-index');
});

test('几何编辑：移动锚点保持正交，直线内移动不补拐点，离轴移动补拐点且邻居不动',()=>{
 const source=pts([0,0],[.5,0],[1,0],[1,1]);
 const along=moveAnchorKeepingOrthogonal(source,1,{x:.2,y:0});
 assert.equal(along.ready,true,JSON.stringify(along.issues));
 assert.deepEqual(along.points,pts([0,0],[.7,0],[1,0],[1,1]));
 assert.equal(along.cornerIndexes.length,0);assert.equal(along.movedIndex,1);

 const offAxis=moveAnchorKeepingOrthogonal(source,1,{x:0,y:.3});
 assert.equal(offAxis.ready,true,JSON.stringify(offAxis.issues));
 assert.ok(orthogonal(offAxis.points));assert.equal(offAxis.cornerIndexes.length,2);
 assert.deepEqual(offAxis.points,pts([0,0],[.5,0],[.5,.3],[1,.3],[1,0],[1,1]));
 assert.deepEqual(offAxis.points[0],{x:0,y:0},'前一个锚点不动');
 assert.deepEqual(offAxis.points.at(-1),{x:1,y:1},'后一个锚点不动');

 const still=moveAnchorKeepingOrthogonal(source,1,{x:0,y:0});
 assert.equal(still.ready,true);assert.equal(still.changed,false);assert.deepEqual(still.points,source);
 assert.equal(moveAnchorKeepingOrthogonal(source,1,{x:.5,y:0}).issues[0]!.code,'duplicate-point');
 assert.equal(moveAnchorKeepingOrthogonal(source,9,{x:0,y:.1}).issues[0]!.code,'bad-index');
 assert.equal(moveAnchorKeepingOrthogonal(source,1,{x:Number.POSITIVE_INFINITY,y:0}).issues[0]!.code,'bad-delta');
});

test('几何编辑：网格吸附按尺寸取整，非法网格拒绝',()=>{
 assert.deepEqual(snapToGrid({x:.131,y:.137}),{x:.15,y:.15});
 assert.deepEqual(snapToGrid({x:.026,y:-.024},.01),{x:.03,y:-.02});
 assert.deepEqual(snapToGrid({x:.1234,y:0},1),{x:0,y:0});
 assert.equal(Object.is(snapToGrid({x:-.001,y:0},.05).x,0),true,'-0 必须折叠为 0');
 assert.throws(()=>snapToGrid({x:0,y:0},0),/网格尺寸/);
});

// --- equal spacing ----------------------------------------------------------

test('几何编辑：等间距重排直线段，中间点按目标间距落位，其后整体平移',()=>{
 const source=pts([0,0],[.5,0],[1,0],[1,1]),result=equalizeLegs(source,0,2,.8);
 assert.equal(result.ready,true,JSON.stringify(result.issues));
 assert.deepEqual(result.points,pts([0,0],[.8,0],[1.6,0],[1.6,1]));
 assert.deepEqual(result.gapsAfterM,[.8,.8]);
 assert.ok(Math.abs(result.spanBeforeM-1)<1e-9);assert.ok(Math.abs(result.spanAfterM-1.6)<1e-9);
 assert.ok(Math.abs(result.tailDeltaM-.6)<1e-9);
 assert.deepEqual(result.movedIndexes,[1,2,3]);
 assert.ok(Math.abs(distance(result.points[3]!,result.points[2]!)-1)<1e-9,'其后路段长度不变');
 assert.ok(orthogonal(result.points));

 const single=equalizeLegs(pts([0,0],[.41,0],[.41,1]),0,1,.5);
 assert.equal(single.ready,true);assert.deepEqual(single.points,pts([0,0],[.5,0],[.5,1]));
 assert.ok(Math.abs(single.tailDeltaM-.09)<1e-9);
});

test('几何编辑：等间距拒绝拐角、斜线、折返与越界间距并给出原因',()=>{
 const corner=equalizeLegs(pts([0,0],[1,0],[1,1]),0,2,.5);
 assert.equal(corner.ready,false);assert.equal(corner.issues[0]!.code,'corner-in-run');
 assert.match(corner.issues[0]!.message,/拐角/);

 assert.equal(equalizeLegs(pts([0,0],[1,1]),0,1,.5).issues[0]!.code,'not-a-straight-run');
 assert.equal(equalizeLegs(pts([0,0],[1,0],[.5,0]),0,2,.5).issues[0]!.code,'fold-in-run');
 assert.equal(equalizeLegs(pts([0,0],[1,0]),0,1,.05).issues[0]!.code,'too-small');
 assert.equal(equalizeLegs(pts([0,0],[1,0]),0,1,51).issues[0]!.code,'too-large');
 assert.equal(equalizeLegs(pts([0,0],[1,0]),1,0,.5).issues[0]!.code,'bad-index');
 assert.equal(equalizeLegs(pts([0,0],[1,0]),0,5,.5).issues[0]!.code,'bad-index');
 assert.equal(equalizeLegs(pts([0,0],[0,0]),0,1,.5).issues[0]!.code,'zero-leg');
});

// --- whole-route transforms -------------------------------------------------

test('几何变换：整体平移/90°旋转/镜像保持正交与段长，非 90° 旋转拒绝',()=>{
 const source=pts([0,0],[1,0],[1,1]);
 const lengths=source.slice(1).map((point,index)=>distance(source[index]!,point));

 const moved=translateRoute(source,.3,-.2);
 assert.equal(moved.ready,true);assert.deepEqual(moved.points,pts([.3,-.2],[1.3,-.2],[1.3,.8]));
 assert.deepEqual(moved.translation,{x:.3,y:-.2});
 assert.equal(translateRoute(source,Number.NaN,0).issues[0]!.code,'bad-delta');

 const rotated=rotateRoute(source,{x:0,y:0},90);
 assert.equal(rotated.ready,true,JSON.stringify(rotated.issues));
 assert.deepEqual(rotated.points,pts([0,0],[0,1],[-1,1]));
 assert.ok(orthogonal(rotated.points));
 assert.deepEqual(rotated.points.slice(1).map((point,index)=>distance(rotated.points[index]!,point)),lengths);
 assert.deepEqual(rotateRoute(source,{x:0,y:0},180).points,pts([0,0],[-1,0],[-1,-1]));
 assert.deepEqual(rotateRoute(source,{x:0,y:0},270).points,pts([0,0],[0,-1],[1,-1]));
 assert.deepEqual(rotateRoute(source,{x:0,y:0},360).points,source,'整周旋转回到原位');
 assert.deepEqual(rotateRoute(source,{x:1,y:0},90).points,pts([1,-1],[1,0],[0,0]));

 const refused=rotateRoute(source,{x:0,y:0},45);
 assert.equal(refused.ready,false);assert.equal(refused.issues[0]!.code,'not-right-angle');
 assert.match(refused.issues[0]!.message,/90°/);
 assert.deepEqual(refused.points,source,'拒绝时原样返回');
 assert.equal(rotateRoute(source,{x:0,y:0},Number.NaN).issues[0]!.code,'bad-angle');
 assert.equal(rotateRoute(source,{x:Number.NaN,y:0},90).issues[0]!.code,'bad-pivot');

 const mirrored=mirrorRoute(source,'horizontal',0);
 assert.equal(mirrored.ready,true);assert.deepEqual(mirrored.points,pts([0,0],[1,0],[1,-1]));
 assert.ok(orthogonal(mirrored.points));
 assert.deepEqual(mirrorRoute(source,'vertical',2).points,pts([4,0],[3,0],[3,1]));
 assert.deepEqual(mirrorRoute(pts([0,0],[-1,0]),'vertical',0).points,pts([0,0],[1,0]));
 assert.equal(mirrorRoute(source,'diagonal' as unknown as 'horizontal',0).issues[0]!.code,'bad-axis');
});

// --- geometry validation ----------------------------------------------------

test('几何校验：正交/最小段长/总长/点数/重复点分类为 errors',()=>{
 const ok=validateRouteGeometry(pts([0,0],[1,0],[1,1]));
 assert.equal(ok.ok,true);assert.deepEqual(ok.errors,[]);
 assert.equal(ok.legs.length,2);assert.equal(ok.axisAligned,true);assert.equal(ok.corners,1);
 assert.ok(Math.abs(ok.lengthM-2)<1e-9);assert.equal(ok.shortestLegM,1);
 assert.deepEqual(ok.bounds,{minX:0,minY:0,maxX:1,maxY:1});

 assert.equal(validateRouteGeometry(pts([0,0],[1,1])).errors[0]!.code,'not-orthogonal');
 assert.equal(validateRouteGeometry(pts([0,0],[.05,0])).errors[0]!.code,'leg-too-short');
 assert.equal(validateRouteGeometry(pts([0,0],[0,0])).errors[0]!.code,'zero-leg');
 assert.equal(validateRouteGeometry(pts([0,0],[51,0])).errors[0]!.code,'too-long');
 assert.equal(validateRouteGeometry(pts([0,0]),{}).errors[0]!.code,'too-few-points');
 const many=Array.from({length:6},(_,index)=>({x:index*.2,y:0}));
 assert.equal(validateRouteGeometry(many,{maxPoints:5}).errors.some(issue=>issue.code==='too-many-points'),true);
 assert.equal(validateRouteGeometry(pts([0,0],[.079,0])).errors[0]!.code,'leg-too-short');
 assert.equal(validateRouteGeometry(pts([0,0],[.08,0])).ok,true,'8 厘米边界允许');
 assert.equal(validateRouteGeometry([{x:0,y:0},{x:Number.NaN,y:0}]).errors[0]!.code,'bad-points');
});

test('几何校验：自交默认告警，可升级为错误；折返共点不算自交',()=>{
 const crossing=pts([0,0],[1,0],[1,1],[.5,1],[.5,-.5]);
 const warned=validateRouteGeometry(crossing);
 assert.equal(warned.ok,true);assert.equal(warned.warnings.length,1);
 assert.equal(warned.warnings[0]!.code,'self-intersection');
 assert.deepEqual(warned.selfIntersections.map(hit=>[hit.a,hit.b]),[[0,3]]);
 assert.ok(Math.abs(warned.selfIntersections[0]!.point.x-.5)<1e-9);
 assert.ok(Math.abs(warned.lengthM-4)<1e-9);

 const strict=validateRouteGeometry(crossing,{selfIntersection:'error'});
 assert.equal(strict.ok,false);assert.equal(strict.errors[0]!.code,'self-intersection');
 assert.equal(validateRouteGeometry(crossing,{selfIntersection:'ignore'}).warnings.length,0);

 assert.deepEqual(validateRouteGeometry(pts([0,0],[1,0],[1,1],[0,1],[0,0])).selfIntersections,[],'闭环首尾相接不算交叉');
 assert.deepEqual(validateRouteGeometry(pts([0,0],[1,0],[1,1],[.5,1],[.5,0],[.5,.5])).selfIntersections,[],'端点相接不算交叉');
});

// --- route / QR binding diagnostics ----------------------------------------

test('绑定诊断：区分码到码、精确中心、吸附端点、未绑定端点与沿途点',()=>{
 const tags=[{id:0,x:0,y:0},{id:1,x:1,y:0},{id:2,x:.5,y:0},{id:3,x:2,y:2}];
 const exact=diagnoseRouteBindings(pts([0,0],[1,0]),tags);
 assert.equal(exact.ok,true);
 assert.deepEqual(exact.legs.map(leg=>leg.kind),['tag-to-tag']);
 assert.equal(exact.legs[0]!.exact,true);
 assert.deepEqual(exact.exactTagToTagLegs,[0]);assert.deepEqual(exact.snappedTagToTagLegs,[]);
 assert.deepEqual(exact.passedTags.map(tag=>tag.id),[2],'沿途未停的码单独报告');
 // tag3 在 (2,2)，离该段 2.24 m，既非端点也非沿途点，只能进 unused
 assert.deepEqual(exact.unusedTagIds,[3]);
 assert.equal(exact.endpoints[0]!.status,'exact');

 const snapped=diagnoseRouteBindings(pts([0,0],[1.09,0]),tags);
 assert.equal(snapped.endpoints[1]!.status,'snapped');
 assert.deepEqual(snapped.snappedTagToTagLegs,[0]);
 assert.deepEqual(snapped.snappedEndpoints.map(endpoint=>endpoint.tagId),[1]);
 assert.ok(Math.abs(snapped.snappedEndpoints[0]!.distanceM-.09)<1e-9);

 const unbound=diagnoseRouteBindings(pts([0,0],[1.5,1.5]),tags);
 assert.equal(unbound.ok,false);
 assert.deepEqual(unbound.unboundEndpoints.map(endpoint=>endpoint.pointIndex),[1]);
 assert.deepEqual(unbound.legs.map(leg=>leg.kind),['tag-to-free']);
 assert.ok(unbound.warnings.some(message=>message.includes('不在任何定位码')));

 const free=diagnoseRouteBindings(pts([5,5],[6,5]),tags);
 assert.deepEqual(free.legs.map(leg=>leg.kind),['free-to-free']);
 assert.deepEqual(free.unusedTagIds,[0,1,2,3]);
 assert.equal(diagnoseRouteBindings(pts([0,0],[1,0]),[]).ok,false,'没有定位码时明确报告');
 assert.equal(diagnoseRouteBindings([],tags).ok,false);
});

// --- API --------------------------------------------------------------------

function fixture():FieldMap{
 const positions=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
 const map=generate({...defaults,count:1,startRow:1});map.id='scan-route-geometry-test';
 const rowId=map.rows[0]!.id,groups=generateBoards({gridSize:1,groupSizeMm:80,groupCount:positions.length,startId:0});
 map.groups=groups;map.tags=positions.map((point,index)=>({id:index,groupId:groups[index]!.id,rowId,...point,angle:0,size:.08,kind:'waypoint',rules:[]}));
 return mapSchema.parse(map);
}

const square=pts([0,0],[1,0],[1,1],[0,1]);
const geometryUrl=(id:string)=>`/api/routes/${id}/geometry`;

async function withApp(run:(app:Awaited<ReturnType<typeof createApp>>,db:string)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'qr-route-geometry-')),db=join(dir,'test.db');
 const app=await createApp(db);
 try{await run(app,db);}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
}

async function seeded(app:Awaited<ReturnType<typeof createApp>>){
 const map=fixture();
 assert.equal((await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}})).statusCode,200);
 const created=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,routeId:'route-geom',routeName:'几何编辑',points:square,bodyYawDeg:0}});
 assert.equal(created.statusCode,200,created.body);
 return {map,created:created.json()};
}

test('API 几何端点：插入/移动/等间距/删除默认原地覆盖，不新增 routeId 与地图版本',async()=>{
 await withApp(async app=>{
  const {map,created}=await seeded(app);
  const routeId=created.route.routeId,updated=created.route.updated;
  assert.equal(routeId,'route-geom');assert.equal(created.route.points.length,4);

  const insert=await app.inject({method:'POST',url:geometryUrl(routeId),payload:{mapId:map.id,baseVersion:1,routeUpdated:updated,points:square,operation:'insert',params:{index:1,point:{x:.5,y:0}}}});
  assert.equal(insert.statusCode,200,insert.body);
  const inserted=insert.json();
  assert.equal(inserted.route.routeId,routeId,'默认原地覆盖必须沿用同一个 routeId');
  assert.equal(inserted.newRoute,false);
  assert.deepEqual(inserted.route.points,pts([0,0],[.5,0],[1,0],[1,1],[0,1]));
  assert.equal(inserted.motionSegments.length,3);
  assert.deepEqual(inserted.routeGroups.usedIds,[0,1,2,3]);
  assert.ok(inserted.geometry.lengthM>=2);
  assert.equal(inserted.diagnostics.pointCount,5);
  assert.equal(inserted.diagnostics.endpoints[0].status,'exact');
  assert.equal(inserted.diagnostics.endpoints.at(-1).tagId,3);
  assert.deepEqual(inserted.diagnostics.unboundEndpoints.map((endpoint:{pointIndex:number})=>endpoint.pointIndex),[1],'直线中间的锚点不在地图点上，诊断必须说明');
  assert.equal((await app.inject('/api/maps/'+map.id)).json().version,1,'几何编辑不得改动地图版本');

  const move=await app.inject({method:'POST',url:geometryUrl(routeId),payload:{mapId:map.id,baseVersion:1,routeUpdated:inserted.route.updated,points:inserted.route.points,operation:'move',params:{index:1,delta:{x:.2,y:0}}}});
  assert.equal(move.statusCode,200,move.body);
  assert.deepEqual(move.json().route.points,pts([0,0],[.7,0],[1,0],[1,1],[0,1]));

  const equalize=await app.inject({method:'POST',url:geometryUrl(routeId),payload:{mapId:map.id,baseVersion:1,routeUpdated:move.json().route.updated,points:move.json().route.points,operation:'equalize',params:{fromIndex:0,toIndex:2,targetM:.5}}});
  assert.equal(equalize.statusCode,200,equalize.body);
  assert.deepEqual(equalize.json().route.points,pts([0,0],[.5,0],[1,0],[1,1],[0,1]));
  assert.equal(equalize.json().params.targetM,.5);

  const remove=await app.inject({method:'POST',url:geometryUrl(routeId),payload:{mapId:map.id,baseVersion:1,routeUpdated:equalize.json().route.updated,points:equalize.json().route.points,operation:'remove',params:{index:1}}});
  assert.equal(remove.statusCode,200,remove.body);
  assert.deepEqual(remove.json().route.points,square);
  assert.equal(remove.json().newRoute,false);

  const routes=(await app.inject('/api/routes?mapId='+map.id)).json();
  assert.equal(routes.length,1,'默认原地覆盖不得新增路径');
  assert.equal(routes[0].routeId,routeId);
  const tasks=(await app.inject('/api/tasks')).json();
  assert.equal(tasks.length,1);
  assert.deepEqual(tasks[0].routeSnapshot.points,square,'原地编辑必须刷新任务里的路径快照');
  assert.equal((await app.inject('/api/maps/'+map.id)).json().version,1);
 });
});

test('API 几何端点：newVersion:true 才新建 routeId，旧路径保持可读',async()=>{
 await withApp(async app=>{
  const {map,created}=await seeded(app);
  const oldId=created.route.routeId,oldPoints=created.route.points;
  const result=await app.inject({method:'POST',url:geometryUrl(oldId),payload:{mapId:map.id,baseVersion:1,points:square,operation:'insert',params:{index:1,point:{x:.5,y:0}},newVersion:true,routeName:'几何编辑副本'}});
  assert.equal(result.statusCode,200,result.body);
  const body=result.json();
  assert.equal(body.newRoute,true);
  assert.notEqual(body.route.routeId,oldId);
  assert.match(body.route.routeId,/^route-[a-f0-9]{24}$/);
  assert.equal((await app.inject('/api/routes?mapId='+map.id)).json().length,2);
  const old=(await app.inject('/api/routes/'+oldId)).json().route;
  assert.deepEqual(old.points,oldPoints);
  assert.equal(old.name,created.route.name);
  const tasks=(await app.inject('/api/tasks')).json();
  assert.equal(tasks.length,1,'新建副本不得改写原路径的任务快照');
  assert.deepEqual(tasks[0].routeSnapshot.points,oldPoints);
 });
});

test('API 几何端点：地图/路径版本与摘要冲突一律 409，路径不存在 404',async()=>{
 await withApp(async app=>{
  const {map,created}=await seeded(app);
  const routeId=created.route.routeId,updated=created.route.updated;
  const payload={mapId:map.id,baseVersion:1,routeUpdated:updated,points:square,operation:'insert',params:{index:1,point:{x:.5,y:0}}};

  const staleVersion=await app.inject({method:'POST',url:geometryUrl(routeId),payload:{...payload,baseVersion:99}});
  assert.equal(staleVersion.statusCode,409,staleVersion.body);
  assert.match(staleVersion.json().error,/地图/);

  const staleRoute=await app.inject({method:'POST',url:geometryUrl(routeId),payload:{...payload,routeUpdated:'2020-01-01T00:00:00.000Z'}});
  assert.equal(staleRoute.statusCode,409,staleRoute.body);
  assert.match(staleRoute.json().error,/路径已被其他页面更新/);

  const noRouteUpdated=await app.inject({method:'POST',url:geometryUrl(routeId),payload:{...payload,routeUpdated:undefined}});
  assert.equal(noRouteUpdated.statusCode,409,noRouteUpdated.body);

  const wrongMap=await app.inject({method:'POST',url:geometryUrl(routeId),payload:{...payload,mapId:'other-map'}});
  assert.equal(wrongMap.statusCode,409,wrongMap.body);

  const stalePreview=await app.inject({method:'POST',url:geometryUrl(routeId),payload:{...payload,points:pts([0,0],[2,0],[2,1],[0,1])}});
  assert.equal(stalePreview.statusCode,409,`编辑器预览与服务端路径不一致时必须拒绝 ${stalePreview.body}`);

  assert.equal((await app.inject({method:'POST',url:geometryUrl('route-missing'),payload})).statusCode,404);
  assert.deepEqual((await app.inject('/api/routes/'+routeId)).json().route.points,square,'冲突后路径保持不变');
 });
});

test('API 几何端点：非法操作一律 400，且不写库',async()=>{
 await withApp(async app=>{
  const {map,created}=await seeded(app);
  const routeId=created.route.routeId,updated=created.route.updated;
  const call=(payload:Record<string,unknown>)=>app.inject({method:'POST',url:geometryUrl(routeId),payload:{mapId:map.id,baseVersion:1,routeUpdated:updated,points:square,...payload}});

  const rotate=await call({operation:'rotate',params:{pivot:{x:0,y:0},degrees:45}});
  assert.equal(rotate.statusCode,400,rotate.body);assert.match(rotate.json().error,/90°/);

  const corner=await call({operation:'remove',params:{index:1}});
  assert.equal(corner.statusCode,400,corner.body);assert.match(corner.json().error,/拐点/);

  const equalize=await call({operation:'equalize',params:{fromIndex:0,toIndex:3,targetM:.5}});
  assert.equal(equalize.statusCode,400,equalize.body);assert.match(equalize.json().error,/拐角/);

  const missing=await call({operation:'insert',params:{index:1}});
  assert.equal(missing.statusCode,400,missing.body);assert.match(missing.json().error,/缺少参数/);

  const unknown=await call({operation:'explode',params:{}});
  assert.equal(unknown.statusCode,400,unknown.body);

  const extra=await call({operation:'translate',params:{dx:.1,dy:0},unexpected:true});
  assert.equal(extra.statusCode,400,`严格 schema 不接受多余字段 ${extra.body}`);

  const badPoints=await call({operation:'translate',params:{dx:.1,dy:0},points:[{x:0,y:0}]});
  assert.equal(badPoints.statusCode,400,badPoints.body);

  assert.deepEqual((await app.inject('/api/routes/'+routeId)).json().route.points,square,'被拒绝的操作不得修改路径');
  assert.equal((await app.inject('/api/routes?mapId='+map.id)).json().length,1);
 });
});

test('API 几何端点：编译安全门不放宽，几何合法但无法串码时 400 且不落库',async()=>{
 await withApp(async app=>{
  const {map,created}=await seeded(app);
  const routeId=created.route.routeId,updated=created.route.updated;
  const call=(payload:Record<string,unknown>)=>app.inject({method:'POST',url:geometryUrl(routeId),payload:{mapId:map.id,baseVersion:1,routeUpdated:updated,points:square,...payload}});

  const rotated=await call({operation:'rotate',params:{pivot:{x:0,y:0},degrees:90}});
  assert.equal(rotated.statusCode,400,rotated.body);
  assert.match(rotated.json().error,/定位组|串联|正交|8厘米/);

  const translated=await call({operation:'translate',params:{dx:5,dy:0}});
  assert.equal(translated.statusCode,400,translated.body);

  const tooLong=await call({operation:'translate',params:{dx:0,dy:60}});
  assert.equal(tooLong.statusCode,400,tooLong.body);

  assert.deepEqual((await app.inject('/api/routes/'+routeId)).json().route.points,square);
  assert.equal((await app.inject('/api/routes?mapId='+map.id)).json().length,1);
 });
});
