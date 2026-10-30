import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {createSurvey,appendSamples,getSurvey} from '../web/backend/src/survey';
import {generateBoards} from '../web/shared/boards';
import {mapSchema,validate,type FieldMap} from '../web/shared/model';
import {previewTagPositions,normalizeTagAngle,TAG_POSITION_DISCLAIMER} from '../web/shared/map-tag-position';

async function fixture(run:(a:Awaited<ReturnType<typeof createApp>>,s:Store,p:string)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'qr-map-tag-position-')),p=join(dir,'test.db'),a=await createApp(p),s=new Store(p);
 try{await run(a,s,p);}finally{s.close();await a.close();rmSync(dir,{recursive:true,force:true});}
}
const boards=()=>generateBoards({gridSize:2,groupSizeMm:120,groupCount:2,startId:0});
function pointMap():FieldMap{
 const groups=boards();
 return mapSchema.parse({schemaVersion:1,id:'scan-tag-position',name:'点位调整测试图',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],tags:groups.map((group,index)=>({id:group.referenceId,x:index*.6,y:0,angle:index?12:0,size:group.sizeMm/1000,groupId:group.id,rowId:'',kind:'waypoint',rules:[]})),groups,zone:[{x:-1,y:-1},{x:2,y:-1},{x:2,y:1},{x:-1,y:1}],vehicle:{width:.4,length:.8,margin:.05},notes:'测试用定位码地图'});
}
const rotate=(local:{x:number,y:number},deg:number)=>{const a=deg*Math.PI/180;return {x:Math.cos(a)*local.x-Math.sin(a)*local.y,y:Math.sin(a)*local.x+Math.cos(a)*local.y};};
const world=(center:{x:number,y:number},angleDeg:number,local:{x:number,y:number})=>{const r=rotate(local,angleDeg);return {x:center.x+r.x,y:center.y+r.y};};

test('二维码位置预览：移动组中心刚性平移整组成员并保持布局与合法门限',()=>{
 const source=pointMap(),group=source.groups![0]!,center=source.tags[0]!;
 const preview=previewTagPositions(source,[{id:center.id,x:center.x+.2,y:center.y-.1,angle:30}]);
 assert.equal(preview.ready,true,JSON.stringify(preview.reasons));
 assert.ok(preview.map);
 assert.equal(preview.changedIds.length,1);
 assert.equal(preview.points[0]!.rigidMemberCount,group.members.length);
 assert.ok(Math.abs(preview.maxDisplacementM-Math.hypot(.2,.1))<1e-9);
 assert.deepEqual(preview.map.groups,source.groups,'定位组定义必须原样保留');
 assert.deepEqual(validate(preview.map).errors,[]);
 assert.equal(preview.map.coordinateStatus,'draft');
 const beforeWorld=group.members.map(member=>world(center,center.angle,member));
 const afterCenter=preview.map.tags.find(tag=>tag.id===center.id)!;
 const afterWorld=group.members.map(member=>world(afterCenter,afterCenter.angle,member));
 for(let i=0;i<beforeWorld.length;i++)for(let j=i+1;j<beforeWorld.length;j++){
  const before=Math.hypot(beforeWorld[i]!.x-beforeWorld[j]!.x,beforeWorld[i]!.y-beforeWorld[j]!.y);
  const after=Math.hypot(afterWorld[i]!.x-afterWorld[j]!.x,afterWorld[i]!.y-afterWorld[j]!.y);
  assert.ok(Math.abs(before-after)<1e-12,`成员间距必须刚性不变：${i}-${j}`);
 }
 assert.ok(preview.notes.some(note=>note.code==='rigid-group'&&note.message.includes('平移+旋转')));
 const translated=previewTagPositions(source,[{id:center.id,x:center.x+.05,y:center.y+.05}]);
 assert.equal(translated.ready,true);
 assert.ok(translated.notes.some(note=>note.code==='rigid-group'&&note.message.includes('刚性平移')));
 assert.equal(preview.disclaimer,TAG_POSITION_DISCLAIMER);
});

test('二维码位置预览：角度归一化、未知/重复/重叠/未变化均被拒绝且不放宽范围',()=>{
 const source=pointMap();
 assert.equal(normalizeTagAngle(190),-170);
 const normalized=previewTagPositions(source,[{id:0,x:0.02,y:0.01,angle:190}]);
 assert.equal(normalized.ready,true,JSON.stringify(normalized.reasons));
 assert.equal(normalized.map!.tags.find(tag=>tag.id===0)!.angle,-170);
 const unknown=previewTagPositions(source,[{id:999,x:0,y:0}]);
 assert.equal(unknown.ready,false);
 assert.ok(unknown.reasons.some(reason=>reason.code==='unknown-tag'));
 const duplicate=previewTagPositions(source,[{id:0,x:.1,y:0},{id:0,x:.2,y:0}]);
 assert.equal(duplicate.ready,false);
 assert.ok(duplicate.reasons.some(reason=>reason.code==='duplicate-edit'));
 const overlap=previewTagPositions(source,[{id:4,x:.02,y:0}]);
 assert.equal(overlap.ready,false);
 assert.ok(overlap.reasons.some(reason=>reason.code==='invalid-geometry'&&reason.message.includes('重叠')));
 const unchanged=previewTagPositions(source,[{id:0,x:source.tags[0]!.x,y:source.tags[0]!.y,angle:source.tags[0]!.angle}]);
 assert.equal(unchanged.ready,false);
 assert.ok(unchanged.reasons.some(reason=>reason.code==='no-changes'));
 const outOfRange=previewTagPositions(source,[{id:0,x:10001,y:0}]);
 assert.equal(outOfRange.ready,false);
 assert.ok(outOfRange.reasons.some(reason=>reason.code==='invalid-map'||reason.code==='invalid-geometry'));
});

test('二维码位置 API：保存新版本、旧版本与旧路线/任务绑定保持不变、409 冲突与非法几何拒绝',async()=>fixture(async(a,s)=>{
 const map=pointMap();
 const v1=await a.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});
 assert.equal(v1.statusCode,200,v1.body);
 const saved=v1.json();
 assert.equal(saved.version,1);
 const routeResponse=await a.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,points:[{x:0,y:0},{x:1,y:0}],bodyYawDeg:0,routeName:'旧路线'}});
 assert.equal(routeResponse.statusCode,200,routeResponse.body);
 const route=routeResponse.json().route;
 assert.equal(route.mapVersion,1);
 assert.equal(route.mapDigest,s.digest(map));
 const task={id:'task-tag-position-old',name:'旧任务',mapId:map.id,mapVersion:1,routeId:route.routeId,routeSnapshot:route,rowOrder:[],forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true};
 s.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.id,JSON.stringify(task),new Date().toISOString());
 const routesBefore=JSON.stringify(s.db.prepare('SELECT * FROM routes ORDER BY route_id').all());
 const tasksBefore=JSON.stringify(s.db.prepare('SELECT * FROM tasks ORDER BY id').all());
 const save=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-positions`,payload:{baseVersion:1,newVersion:true,tags:[{id:0,x:.25,y:-.15,angle:15},{id:4,x:1.4,y:.2}]}});
 assert.equal(save.statusCode,200,save.body);
 const result=save.json();
 assert.equal(result.version,2);
 assert.equal(result.previousVersion,1);
 assert.equal(result.map.coordinateStatus,'draft');
 assert.deepEqual(result.map.groups,map.groups);
 assert.equal(result.changedTags.length,2);
 assert.equal(result.disclaimer,TAG_POSITION_DISCLAIMER);
 const v2=result.map as FieldMap;
 assert.ok(Math.abs(v2.tags.find(tag=>tag.id===0)!.x-.25)<1e-9);
 assert.ok(Math.abs(v2.tags.find(tag=>tag.id===0)!.y+.15)<1e-9);
 assert.equal(v2.tags.find(tag=>tag.id===0)!.angle,15);
 // The original scan evidence (v1) must stay byte-for-byte unchanged.
 const version1=(await a.inject(`/api/maps/${map.id}?version=1`)).json();
 assert.deepEqual(version1.map,map);
 assert.equal(version1.version,1);
 const versions=(await a.inject(`/api/maps/${map.id}/versions`)).json();
 assert.deepEqual(versions.map((item:{version:number})=>item.version),[2,1]);
 // Old route and task are not migrated to the new map version.
 assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM routes ORDER BY route_id').all()),routesBefore);
 assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM tasks ORDER BY id').all()),tasksBefore);
 const oldRoute=(await a.inject('/api/routes/'+route.routeId)).json();
 assert.equal(oldRoute.mapVersion,1);
 assert.equal(oldRoute.mapDigest,s.digest(map));
 assert.notEqual(oldRoute.mapDigest,s.digest(v2));
 // Stable conflict: a stale base version must not create a version.
 const conflict=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-positions`,payload:{baseVersion:1,newVersion:true,tags:[{id:0,x:.3,y:0}]}});
 assert.equal(conflict.statusCode,409);
 // Invalid geometry, unknown IDs and out-of-schema coordinates are rejected, still no new version.
 const overlap=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-positions`,payload:{baseVersion:2,newVersion:true,tags:[{id:4,x:.25,y:-.15}]}});
 assert.equal(overlap.statusCode,400);
 const unknown=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-positions`,payload:{baseVersion:2,newVersion:true,tags:[{id:999,x:0,y:0}]}});
 assert.equal(unknown.statusCode,400);
 const duplicate=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-positions`,payload:{baseVersion:2,newVersion:true,tags:[{id:0,x:.3,y:0},{id:0,x:.4,y:0}]}});
 assert.equal(duplicate.statusCode,400);
 const outOfRange=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-positions`,payload:{baseVersion:2,newVersion:true,tags:[{id:0,x:10001,y:0}]}});
 assert.equal(outOfRange.statusCode,400);
 const unchanged=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-positions`,payload:{baseVersion:2,newVersion:true,tags:[{id:0,x:.25,y:-.15,angle:15}]}});
 assert.equal(unchanged.statusCode,400);
 assert.deepEqual((await a.inject(`/api/maps/${map.id}/versions`)).json().map((item:{version:number})=>item.version),[2,1]);
}));

test('单码推断整组建图后点位调整仍保留整组布局（不回归）',async()=>fixture(async(a,s)=>{
 const boardList=generateBoards({gridSize:2,groupSizeMm:120,groupCount:1,startId:0});
 const session=createSurvey(s,'单码推断',boardList);
 appendSamples(s,session.id,boardList.flatMap(board=>[0,.2,0].map((offset,index)=>({stamp:1+index,pose:{x:offset,y:0,yaw:0},representation:'board-centers',groupLayouts:[board],calibrated:true,synchronized:true,quality:'verified',localEpoch:'epoch',tags:[{id:board.referenceId,groupId:board.id,x:-offset,y:0,angle:.3,sigma:.02,memberIds:[board.referenceId],visibleCount:1,size:board.sizeMm/1000}]}))));
 s.db.prepare('UPDATE survey_sessions SET state=? WHERE id=?').run('stopped',session.id);
 const saved=await a.inject({method:'POST',url:'/api/survey/map',payload:{sessionId:session.id,baseVersion:0}});
 assert.equal(saved.statusCode,200,saved.body);
 const map=saved.json().map as FieldMap;
 assert.equal(map.tags.length,1,'单码只保存组中心一个点');
 assert.deepEqual(map.groups,boardList);
 const adjusted=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-positions`,payload:{baseVersion:1,newVersion:true,tags:[{id:map.tags[0]!.id,x:map.tags[0]!.x+.1,y:map.tags[0]!.y-.05,angle:map.tags[0]!.angle+10}]}});
 assert.equal(adjusted.statusCode,200,adjusted.body);
 assert.deepEqual(adjusted.json().map.groups,boardList,'整组定义保持不变，成员随组中心刚性移动');
}));

test('二维码位置预览：重复提交当前坐标（含浮点原值）不得产生新版本',()=>{
 const source=pointMap();
 const tag=source.tags[0]!;
 const exact=previewTagPositions(source,[{id:tag.id,x:tag.x,y:tag.y,angle:tag.angle}]);
 assert.equal(exact.ready,false,'重复提交原坐标必须判定为无改动');
 assert.ok(exact.reasons.some(reason=>reason.code==='no-changes'));
 const rounded=previewTagPositions(source,[{id:tag.id,x:Number(tag.x.toFixed(6)),y:Number(tag.y.toFixed(6)),angle:Number(tag.angle.toFixed(6))}]);
 assert.equal(rounded.ready,false,'取整到 1e-6 后与原值相同也不得算改动');
 assert.deepEqual(rounded.changedIds,[]);
 const tiny=previewTagPositions(source,[{id:tag.id,x:tag.x+5e-7,y:tag.y}]);
 assert.equal(tiny.ready,false,'亚微米级抖动不得生成新版本');
});
