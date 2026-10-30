import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {generateBoards} from '../web/shared/boards';
import {mapSchema,validate,distance,type FieldMap} from '../web/shared/model';
import {
  previewTagDistance,previewEqualSpacing,neighborsOnLine,
  LINE_TOLERANCE_M,MIN_TAG_DISTANCE_M,TAG_DISTANCE_DISCLAIMER,
} from '../web/shared/map-tag-distance';

async function fixture(run:(a:Awaited<ReturnType<typeof createApp>>,s:Store,p:string)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'qr-map-tag-distance-')),p=join(dir,'test.db'),a=await createApp(p),s=new Store(p);
 try{await run(a,s,p);}finally{s.close();await a.close();rmSync(dir,{recursive:true,force:true});}
}

/**
 * Two parallel straight runs an L corner, all on one map-only map:
 *   y = 0     : Q000 (0,0) — Q001 (0.6,0) — Q002 (1.3,0)
 *   x = 0     : Q000 — Q003 (0,0.5) — Q004 (0,1.1)      ← the vertical arm
 *   y = 0.9   : Q005 (1.0,0.9) — Q006 (1.6,0.9)         ← a separate row, 90 cm up
 * Q000 is the L corner and belongs to both arms. Every perpendicular separation
 * here is either 0 or ≥ 20 cm, i.e. outside the 2 cm tolerance, so the horizontal
 * run can never absorb the y = 0.9 row.
 */
function lineMap():FieldMap{
 const tag=(id:number,x:number,y:number)=>({id,x,y,angle:0,size:.08,rowId:'',kind:'waypoint' as const,rules:[]});
 return mapSchema.parse({schemaVersion:1,id:'scan-tag-distance',name:'间距测试图',frame:'map',family:'tag36h11',
  source:'survey',coordinateStatus:'draft',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],
  tags:[tag(0,0,0),tag(1,.6,0),tag(2,1.3,0),tag(3,0,.5),tag(4,0,1.1),tag(5,1,.9),tag(6,1.6,.9)],
  zone:[{x:-1,y:-1},{x:3,y:-1},{x:3,y:2},{x:-1,y:2}],vehicle:{width:.4,length:.8,margin:.05},notes:'测试用定位码地图'});
}
function groupedMap():FieldMap{
 const groups=generateBoards({gridSize:2,groupSizeMm:120,groupCount:2,startId:0});
 return mapSchema.parse({schemaVersion:1,id:'scan-tag-distance-grouped',name:'整组间距测试图',frame:'map',family:'tag36h11',
  source:'survey',coordinateStatus:'draft',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],
  tags:groups.map((group,index)=>({id:group.referenceId,x:index*.6,y:0,angle:0,size:group.sizeMm/1000,groupId:group.id,rowId:'',kind:'waypoint',rules:[]})),
  groups,zone:[{x:-1,y:-1},{x:2,y:-1},{x:2,y:1},{x:-1,y:1}],vehicle:{width:.4,length:.8,margin:.05},notes:'测试用定位码地图'});
}
/** A design map with real crop rows: routeMode is not map-only. */
function rowsMap():FieldMap{
 return mapSchema.parse({schemaVersion:1,id:'design-tag-distance',name:'带作物行地图',frame:'map',family:'tag36h11',
  source:'design',coordinateStatus:'draft',
  rows:[{id:'row-1',name:'第 1 行',width:.6,points:[{x:0,y:0},{x:2,y:0}],exitDistance:.8}],
  tags:[{id:0,x:0,y:0,angle:0,size:.08,rowId:'row-1',kind:'entry',rules:[]},{id:1,x:2,y:0,angle:0,size:.08,rowId:'row-1',kind:'end',rules:[]}],
  order:['row-1'],zone:[{x:-1,y:-1},{x:3,y:-1},{x:3,y:1},{x:-1,y:1}],vehicle:{width:.4,length:.8,margin:.05},notes:''});
}
const near=(actual:number,expected:number,tolerance=1e-5,label?:string)=>
 assert.ok(Math.abs(actual-expected)<=tolerance,`${label??''} 期望 ${expected}，实际 ${actual}`);
const codes=(reasons:{code:string}[])=>reasons.map(reason=>reason.code);

test('共线邻居：按顺序返回同一行、不混入其他行、拐角两条臂各自独立',()=>{
 const map=lineMap();
 const corner=neighborsOnLine(map,0);
 assert.equal(corner.corner,true,'Q000 位于 L 拐角，横竖两条臂都要报告');
 assert.deepEqual(corner.horizontal!.memberIds,[0,1,2],'水平臂必须按 x 升序排列');
 assert.deepEqual(corner.vertical!.memberIds,[0,3,4],'垂直臂必须按 y 升序排列');
 assert.deepEqual(corner.primary!.memberIds,[0,1,2],'等长时稳定选择水平臂');
 // 两条臂绝不能被拼成一条“直线”，否则预览会绕拐角。
 assert.ok(!corner.horizontal!.memberIds.includes(3));
 assert.ok(!corner.vertical!.memberIds.includes(1));
 const middle=neighborsOnLine(map,1);
 assert.deepEqual(middle.horizontal!.memberIds,[0,1,2]);
 assert.equal(middle.vertical,null,'Q001 只有水平邻居');
 // 偏移行 y=0.9 与 y=0 相差 90 cm，远大于 2 cm 容差，不得并入。
 assert.equal(middle.horizontal!.memberIds.filter(id=>id===5||id===6).length,0,'y=0.9 那一行不得并入 y=0');
 assert.equal(neighborsOnLine(map,5).horizontal!.memberIds.length,2,'Q005 所在行只有它和 Q006');
 assert.deepEqual(neighborsOnLine(map,5).horizontal!.memberIds,[5,6]);
 // 容差参数必须真的生效：1 cm 的噪声在默认 2 cm 容差内，收紧到 5 mm 就出局。
 const drift=mapSchema.parse({...map,id:'scan-tag-distance-drift',tags:map.tags.map(tag=>tag.id===2?{...tag,y:.01}:tag)});
 assert.deepEqual(neighborsOnLine(drift,1).horizontal!.memberIds,[0,1,2],'1 cm 扫描噪声仍在 2 cm 容差内');
 assert.deepEqual(neighborsOnLine(drift,1,.005).horizontal!.memberIds,[0,1],'容差收紧到 5 mm 后 1 cm 噪声出局');
 assert.equal(neighborsOnLine(drift,1,1e-6).horizontal!.memberIds.length,2,'完全共线的点在任何容差下都算同线');
 assert.deepEqual(neighborsOnLine(map,3).vertical!.memberIds,[0,3,4]);
 // map-only 地图本身不允许带 rowId（mapSchema 会拒绝带导航路径字段的定位码地图），
 // 所以「按行名隔离」在这张图上永远是惰性的：真正挡住相邻行的是几何容差。
 assert.equal(map.tags.every(tag=>tag.rowId===''),true);
 assert.throws(()=>mapSchema.parse({...map,tags:map.tags.map(tag=>({...tag,rowId:'row-1'}))}),/定位码地图需要有效点位/);
 assert.throws(()=>neighborsOnLine(map,999),/不在这张地图中/);
 assert.equal(LINE_TOLERANCE_M,.02);
 assert.equal(MIN_TAG_DISTANCE_M,.08);
});

test('单点改距离：固定 A 只移动 B，读当前/新距离，位移与受影响点可核对',()=>{
 const map=lineMap(),snapshot=JSON.stringify(map);
 const preview=previewTagDistance(map,{fromId:0,toId:1,targetM:.4});
 assert.equal(preview.ready,true,JSON.stringify(preview.reasons));
 assert.equal(preview.axis,'horizontal');
 assert.deepEqual(preview.from,{x:0,y:0},'A 是固定端');
 near(preview.beforeM,.6,1e-9,'当前中心距离');
 near(preview.before.m,.6,1e-9); near(preview.before.cm,60,1e-6); near(preview.before.mm,600,1e-6);
 near(preview.afterM,.4,1e-6,'预览新距离');
 near(preview.after.cm,40,1e-6); near(preview.after.mm,400,1e-6);
 near(preview.displacementM,.2,1e-6); near(preview.deltaM,-.2,1e-6);
 assert.deepEqual(preview.changedIds,[1],'只移动 B');
 assert.deepEqual(preview.affectedIds,[1]);
 assert.deepEqual(preview.line!.memberIds,[0,1,2],'预览需要标出所在直线');
 assert.equal(preview.disclaimer,TAG_DISTANCE_DISCLAIMER);
 assert.equal(JSON.stringify(map),snapshot,'预览绝不修改入参');
 assert.equal(preview.map!.coordinateStatus,'draft','人工改间距强制退回草稿');
 assert.deepEqual(preview.map!.groups,map.groups);
 assert.deepEqual(validate(preview.map!).errors,[]);
 const moved=preview.map!.tags.find(tag=>tag.id===1)!,fixed=preview.map!.tags.find(tag=>tag.id===0)!;
 near(distance(fixed,moved),.4,1e-6);
 near(moved.y,0,1e-9,'沿现有直线移动，不引入横向偏移');
 // 未涉及的点必须逐字节不变。
 for(const tag of map.tags.filter(item=>item.id!==1)) assert.deepEqual(preview.map!.tags.find(item=>item.id===tag.id),tag);
 // 反向：缩短/拉长都沿 A→B 方向。
 const longer=previewTagDistance(map,{fromId:0,toId:1,targetM:.9});
 near(longer.afterM,.9,1e-6); near(longer.displacementM,.3,1e-6);
 const viaCornerNeighbour=previewTagDistance(map,{fromId:3,toId:4,targetM:.8});
 assert.equal(viaCornerNeighbour.axis,'vertical'); near(viaCornerNeighbour.afterM,.8,1e-6);
 // 轻微偏离直线的两点：沿原方向移动，横向偏差按比例保持，不被静默拉直。
 const drift=mapSchema.parse({...map,tags:map.tags.map(tag=>tag.id===1?{...tag,y:.01}:tag)});
 const drifting=previewTagDistance(drift,{fromId:0,toId:1,targetM:.5});
 assert.equal(drifting.ready,true,JSON.stringify(drifting.reasons));
 const driftAfter=drifting.map!.tags.find(tag=>tag.id===1)!;
 // 坐标按 1e-6 m 取整后保存，所以这里用 1e-5 的容差核对等比缩放。
 near(driftAfter.y,.01*.5/.6,1e-5,'横向偏差按目标距离等比缩放，不做横向校正');
});

test('单点改距离：跨拐角/非共线、同码、<8cm、未变化一律拒绝且不改地图',()=>{
 const map=lineMap(),snapshot=JSON.stringify(map);
 const corner=previewTagDistance(map,{fromId:1,toId:3,targetM:.5});
 assert.equal(corner.ready,false);
 assert.ok(codes(corner.reasons).includes('non-collinear'),'跨拐角必须拒绝：'+JSON.stringify(corner.reasons));
 assert.equal(corner.map,null);
 // 偏移行必须整行排除：Q002(y=0) 不能和 Q005(y=0.9) 拼成一条“直线”。
 const acrossRows=previewTagDistance(map,{fromId:2,toId:5,targetM:.5});
 assert.equal(acrossRows.ready,false);
 assert.ok(codes(acrossRows.reasons).includes('non-collinear'),JSON.stringify(acrossRows.reasons));
 // 20 cm 的偏差同样越界（容差是 2 cm，不是“看着差不多”）。
 const farRow=mapSchema.parse({...map,id:'scan-tag-distance-far',tags:map.tags.map(tag=>tag.id===1?{...tag,y:.02}:tag)});
 assert.equal(previewTagDistance(farRow,{fromId:0,toId:1,targetM:.5}).ready,true,'2 cm 恰好在容差内');
 const overTolerance=mapSchema.parse({...map,id:'scan-tag-distance-over',tags:map.tags.map(tag=>tag.id===1?{...tag,y:.021}:tag)});
 const over=previewTagDistance(overTolerance,{fromId:0,toId:1,targetM:.5});
 assert.equal(over.ready,false); assert.ok(codes(over.reasons).includes('non-collinear'),'超过 2 cm 容差必须拒绝');
 const same=previewTagDistance(map,{fromId:1,toId:1,targetM:.5});
 assert.equal(same.ready,false); assert.ok(codes(same.reasons).includes('same-tag'));
 const unknown=previewTagDistance(map,{fromId:0,toId:999,targetM:.5});
 assert.equal(unknown.ready,false); assert.ok(codes(unknown.reasons).includes('unknown-tag'));
 for(const targetM of [.079,.05,.01,0,-.5,Number.NaN,Number.POSITIVE_INFINITY]){
  const tooSmall=previewTagDistance(map,{fromId:0,toId:1,targetM});
  assert.equal(tooSmall.ready,false,`targetM=${targetM} 必须拒绝`);
  assert.ok(codes(tooSmall.reasons).some(code=>code==='distance-too-small'||code==='invalid-target'),JSON.stringify(tooSmall.reasons));
 }
 const boundary=previewTagDistance(map,{fromId:0,toId:1,targetM:.08});
 assert.equal(boundary.ready,false,'8 cm 恰好等于下限但 8 cm 码仍会压盖，必须由几何校验拦下');
 assert.ok(codes(boundary.reasons).includes('overlap'),JSON.stringify(boundary.reasons));
 const unchanged=previewTagDistance(map,{fromId:0,toId:1,targetM:.6});
 assert.equal(unchanged.ready,false); assert.ok(codes(unchanged.reasons).includes('no-changes'));
 const rows=previewTagDistance(rowsMap(),{fromId:0,toId:1,targetM:.5});
 assert.equal(rows.ready,false); assert.ok(codes(rows.reasons).includes('unsupported-route-mode'));
 assert.equal(JSON.stringify(map),snapshot,'被拒绝的预览同样不得修改入参');
});

test('单点改距离：整组中心刚性平移，组定义与成员布局不变',()=>{
 const map=groupedMap(),snapshot=JSON.stringify(map);
 const preview=previewTagDistance(map,{fromId:0,toId:4,targetM:.9});
 assert.equal(preview.ready,true,JSON.stringify(preview.reasons));
 assert.equal(preview.rigidMemberCount,4,'2×2 定位板的组中心带动 4 个成员');
 assert.deepEqual(preview.changedIds,[4]);
 assert.deepEqual(preview.map!.groups,map.groups,'组定义不得改变');
 assert.ok(preview.notes.some(note=>note.code==='rigid-group'&&note.message.includes('刚性平移')));
 near(distance(preview.map!.tags.find(tag=>tag.id===0)!,preview.map!.tags.find(tag=>tag.id===4)!),.9,1e-6);
 assert.equal(JSON.stringify(map),snapshot);
 assert.deepEqual(validate(preview.map!).errors,[]);
});

test('批量等间距：固定首点与方向，逐点间距等于目标，顺序与朝向保持，最大位移可核对',()=>{
 const map=lineMap(),snapshot=JSON.stringify(map);
 const before=map.tags.slice(0,3).map(tag=>({...tag}));
 const preview=previewEqualSpacing(map,{ids:[0,1,2],targetM:.5});
 assert.equal(preview.ready,true,JSON.stringify(preview.reasons));
 assert.equal(preview.axis,'horizontal');
 assert.equal(preview.fixedId,0,'固定首点');
 assert.deepEqual(preview.ids,[0,1,2],'提交顺序即结果顺序');
 assert.deepEqual(preview.changedIds,[1,2],'首点不动');
 assert.equal(preview.count,3);
 near(preview.spanBeforeM,1.3,1e-9); near(preview.spanAfterM,1,1e-9);
 assert.deepEqual(preview.map!.tags.find(tag=>tag.id===0),{...before[0]!},'首点必须逐字节保留');
 const positions=preview.map!.tags.filter(tag=>[0,1,2].includes(tag.id)).sort((a,b)=>a.id-b.id);
 near(positions[0]!.x,0,1e-9); near(positions[1]!.x,.5,1e-6); near(positions[2]!.x,1,1e-6);
 for(let index=1;index<positions.length;index++) near(distance(positions[index-1]!,positions[index]!),.5,1e-6,'逐点间距');
 for(const point of preview.points) near(point.afterGapM,point.index===0?0:.5,1e-6);
 // 最大位移来自移动最远的 Q002（1.3 → 1.0）。
 near(preview.maxDisplacementM,.3,1e-6);
 near(preview.points[2]!.displacementM,.3,1e-6);
 near(preview.points[1]!.displacementM,.1,1e-6);
 // 朝向（angle）不得被间距重排改写，顺序不得倒置。
 for(const [index,tag] of map.tags.slice(0,3).entries()) assert.equal(preview.map!.tags.find(item=>item.id===tag.id)!.angle,before[index]!.angle);
 assert.deepEqual(preview.direction,{x:1,y:0});
 assert.ok(preview.notes.some(note=>note.code==='order-preserved'));
 assert.equal(preview.map!.coordinateStatus,'draft');
 assert.deepEqual(validate(preview.map!).errors,[]);
 assert.equal(JSON.stringify(map),snapshot,'预览绝不修改入参');
 // 未选中的点逐字节不变。
 for(const tag of map.tags.filter(item=>item.id>2)) assert.deepEqual(preview.map!.tags.find(item=>item.id===tag.id),tag);
 // 竖向一组同样成立。
 const vertical=previewEqualSpacing(map,{ids:[0,3,4],targetM:.45});
 assert.equal(vertical.ready,true,JSON.stringify(vertical.reasons));
 assert.equal(vertical.axis,'vertical');
 near(vertical.spanAfterM,.9,1e-9);
});

test('批量等间距：拒绝非共线、跨拐角、顺序不单调、重复 id、数量不足与 <8cm',()=>{
 const map=lineMap(),snapshot=JSON.stringify(map);
 const crossCorner=previewEqualSpacing(map,{ids:[1,2,3],targetM:.5});
 assert.equal(crossCorner.ready,false);
 assert.ok(codes(crossCorner.reasons).includes('non-collinear'),JSON.stringify(crossCorner.reasons));
 assert.equal(crossCorner.map,null);
 const otherRow=previewEqualSpacing(map,{ids:[5,6,2],targetM:.5});
 assert.equal(otherRow.ready,false);
 assert.ok(codes(otherRow.reasons).includes('non-collinear'));
 const nonMonotonic=previewEqualSpacing(map,{ids:[0,2,1],targetM:.5});
 assert.equal(nonMonotonic.ready,false);
 assert.ok(codes(nonMonotonic.reasons).includes('order-not-monotonic'),JSON.stringify(nonMonotonic.reasons));
 const repeated=previewEqualSpacing(map,{ids:[0,1,1],targetM:.5});
 assert.equal(repeated.ready,false); assert.ok(codes(repeated.reasons).includes('duplicate-id'));
 const one=previewEqualSpacing(map,{ids:[0],targetM:.5});
 assert.equal(one.ready,false); assert.ok(codes(one.reasons).includes('too-few-points'));
 const none=previewEqualSpacing(map,{ids:[],targetM:.5});
 assert.equal(none.ready,false);
 const tooSmall=previewEqualSpacing(map,{ids:[0,1,2],targetM:.079});
 assert.equal(tooSmall.ready,false); assert.ok(codes(tooSmall.reasons).includes('distance-too-small'));
 const unknown=previewEqualSpacing(map,{ids:[0,999],targetM:.5});
 assert.equal(unknown.ready,false); assert.ok(codes(unknown.reasons).includes('unknown-tag'));
 const rows=previewEqualSpacing(rowsMap(),{ids:[0,1],targetM:.5});
 assert.equal(rows.ready,false); assert.ok(codes(rows.reasons).includes('unsupported-route-mode'));
 const unchanged=previewEqualSpacing(map,{ids:[5,6],targetM:.6});
 assert.equal(unchanged.ready,false); assert.ok(codes(unchanged.reasons).includes('no-changes'));
 assert.equal(JSON.stringify(map),snapshot,'被拒绝的预览同样不得修改入参');
 // 按几何倒序提交仍然合法（顺序单调），固定首点是提交的第一个。
 const descending=previewEqualSpacing(map,{ids:[2,1,0],targetM:.5});
 assert.equal(descending.ready,true,JSON.stringify(descending.reasons));
 assert.equal(descending.fixedId,2);
 assert.deepEqual(descending.direction,{x:-1,y:0});
 near(descending.map!.tags.find(tag=>tag.id===0)!.x,.3,1e-6);
});

test('间距 API：单点改距离保存 vN+1、旧版本/未涉及点/groups/路由/任务全部不变',async()=>fixture(async(a,s)=>{
 const map=lineMap();
 assert.equal((await a.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}})).statusCode,200);
 const route=await a.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,points:[{x:0,y:0},{x:1.3,y:0}],bodyYawDeg:0,routeName:'旧路线'}});
 assert.equal(route.statusCode,200,route.body);
 const routeBody=route.json().route;
 const task={id:'task-tag-distance-old',name:'旧任务',mapId:map.id,mapVersion:1,routeId:routeBody.routeId,routeSnapshot:routeBody,rowOrder:[],forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true};
 s.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.id,JSON.stringify(task),new Date().toISOString());
 const routesBefore=JSON.stringify(s.db.prepare('SELECT * FROM routes ORDER BY route_id').all());
 const tasksBefore=JSON.stringify(s.db.prepare('SELECT * FROM tasks ORDER BY id').all());
 // 保存前先读当前距离：GET 最新版本，前端据此显示 before。
 const latest=(await a.inject(`/api/maps/${map.id}`)).json();
 near(distance(latest.map.tags.find((tag:{id:number})=>tag.id===0),latest.map.tags.find((tag:{id:number})=>tag.id===1)),.6,1e-9,'可读当前距离');
 const save=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-distance`,payload:{baseVersion:1,newVersion:true,fromId:0,toId:1,targetM:.4}});
 assert.equal(save.statusCode,200,save.body);
 const result=save.json();
 assert.equal(result.version,2,'保存生成 vN+1');
 assert.equal(result.previousVersion,1);
 assert.equal(result.map.coordinateStatus,'draft');
 assert.deepEqual(result.map.groups,map.groups,'groups 不变');
 assert.equal(result.changedTags.length,1);
 assert.deepEqual(result.changedTags[0].before,{x:.6,y:0});
 assert.deepEqual(result.changedTags[0].after,{x:.4,y:0});
 near(result.beforeM,.6,1e-9); near(result.afterM,.4,1e-6);
 near(result.beforeDistance.cm,60,1e-6); near(result.afterDistance.cm,40,1e-6);
 near(result.maxDisplacementM,.2,1e-6);
 assert.deepEqual(result.neighbors,[0,1,2]);
 assert.equal(result.disclaimer,TAG_DISTANCE_DISCLAIMER);
 // 旧版本必须逐字节不变。
 const v1=(await a.inject(`/api/maps/${map.id}?version=1`)).json();
 assert.deepEqual(v1.map,map);
 // 未涉及的点不得移动。
 for(const tag of map.tags.filter(item=>item.id!==1)) assert.deepEqual(result.map.tags.find((item:{id:number})=>item.id===tag.id),tag);
 assert.deepEqual((await a.inject(`/api/maps/${map.id}/versions`)).json().map((item:{version:number})=>item.version),[2,1]);
 assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM routes ORDER BY route_id').all()),routesBefore,'路由不变');
 assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM tasks ORDER BY id').all()),tasksBefore,'任务不变');
 const oldRoute=(await a.inject('/api/routes/'+routeBody.routeId)).json();
 assert.equal(oldRoute.mapVersion,1,'旧路线仍绑定旧版本');
 assert.notEqual(oldRoute.mapDigest,s.digest(result.map));
 assert.deepEqual(validate(result.map).errors,[]);
}));

test('间距 API：批量等距逐点间距等于目标、重复 id/超范围 400、baseVersion 过期与非 map-only 409',async()=>fixture(async(a,s)=>{
 const map=lineMap();
 assert.equal((await a.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}})).statusCode,200);
 const equal=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-equal-spacing`,payload:{baseVersion:1,newVersion:true,ids:[0,1,2],targetM:.5}});
 assert.equal(equal.statusCode,200,equal.body);
 const result=equal.json();
 assert.equal(result.version,2);
 assert.equal(result.previousVersion,1);
 assert.deepEqual(result.order,[0,1,2]);
 assert.equal(result.targetM,.5);
 assert.equal(result.count,3);
 near(result.spanAfterM,1,1e-9);
 near(result.maxDisplacementM,.3,1e-6);
 near(result.maxLateralM,0,1e-9,'本来共线则不做横向修正');
 assert.equal(result.map.coordinateStatus,'draft');
 assert.deepEqual(result.map.groups,map.groups);
 const positions=result.map.tags.filter((tag:{id:number})=>[0,1,2].includes(tag.id)).sort((a:{id:number},b:{id:number})=>a.id-b.id);
 near(positions[0].x,0,1e-9,'首点固定');
 for(let index=1;index<positions.length;index++) near(distance(positions[index-1],positions[index]),.5,1e-6,'逐点距离等于目标');
 assert.ok(positions.every((tag:{angle:number})=>tag.angle===0),'朝向保持不变');
 assert.equal(JSON.stringify((await a.inject(`/api/maps/${map.id}?version=1`)).json().map),JSON.stringify(map));
 // 重复 id、数量不足、<8cm、未知 id、非共线顺序都要 400，且不产生新版本。
 for(const payload of [
  {baseVersion:2,ids:[0,1,1],targetM:.5},
  {baseVersion:2,ids:[0],targetM:.5},
  {baseVersion:2,ids:[0,1,2],targetM:.079},
  {baseVersion:2,ids:[0,999],targetM:.5},
  {baseVersion:2,ids:[0,2,1],targetM:.5},
  {baseVersion:2,ids:[1,2,3],targetM:.5},
 ]){
  const rejected=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-equal-spacing`,payload});
  assert.equal(rejected.statusCode,400,`payload ${JSON.stringify(payload)} 必须 400：${rejected.body}`);
 }
 const singleRejects=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-distance`,payload:{baseVersion:2,newVersion:true,fromId:1,toId:3,targetM:.5}});
 assert.equal(singleRejects.statusCode,400,'跨拐角必须 400');
 const smallSingle=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-distance`,payload:{baseVersion:2,newVersion:true,fromId:0,toId:1,targetM:.05}});
 assert.equal(smallSingle.statusCode,400,'<8cm 必须 400');
 assert.deepEqual((await a.inject(`/api/maps/${map.id}/versions`)).json().map((item:{version:number})=>item.version),[2,1]);
 // baseVersion 过期 → 409，且不会产生新版本。
 const stale=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-distance`,payload:{baseVersion:1,newVersion:true,fromId:0,toId:1,targetM:.3}});
 assert.equal(stale.statusCode,409,stale.body);
 const staleBatch=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-equal-spacing`,payload:{baseVersion:1,newVersion:true,ids:[0,1,2],targetM:.3}});
 assert.equal(staleBatch.statusCode,409,staleBatch.body);
 assert.deepEqual((await a.inject(`/api/maps/${map.id}/versions`)).json().map((item:{version:number})=>item.version),[2,1]);
 // 非 map-only 地图 → 409（带作物行的设计图不允许用间距工具改点位）。
 const rows=rowsMap();
 assert.equal((await a.inject({method:'POST',url:'/api/maps',payload:{map:rows,baseVersion:0}})).statusCode,200);
 const notMapOnly=await a.inject({method:'POST',url:`/api/maps/${rows.id}/tag-distance`,payload:{baseVersion:1,newVersion:true,fromId:0,toId:1,targetM:.5}});
 assert.equal(notMapOnly.statusCode,409,notMapOnly.body);
 const notMapOnlyBatch=await a.inject({method:'POST',url:`/api/maps/${rows.id}/tag-equal-spacing`,payload:{baseVersion:1,newVersion:true,ids:[0,1],targetM:.5}});
 assert.equal(notMapOnlyBatch.statusCode,409,notMapOnlyBatch.body);
 assert.deepEqual((await a.inject(`/api/maps/${rows.id}/versions`)).json().map((item:{version:number})=>item.version),[1]);
 const missing=await a.inject({method:'POST',url:'/api/maps/no-such-map/tag-distance',payload:{baseVersion:1,newVersion:true,fromId:0,toId:1,targetM:.5}});
 assert.equal(missing.statusCode,404);
}));
