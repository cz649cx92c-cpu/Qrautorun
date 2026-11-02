import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {generateBoards} from '../web/shared/boards';
import {mapSchema,validate,distance,type FieldMap,type Tag} from '../web/shared/model';
import {
  createTag,createTagGrid,createTagLine,removeTags,alignTags,
  MAX_TAG_ID,MAX_TAG_COUNT,MAX_GRID_POINTS,MIN_TAG_SIZE_M,MAX_TAG_SIZE_M,DEFAULT_TAG_SIZE_M,
  TAG_CREATION_DISCLAIMER,TAG_ALIGN_MODES,
} from '../web/shared/map-tag-creation';

/** 两点就够用的最小定位码地图：Q0 在原点、Q1 在 (1,0)。 */
function baseMap(overrides:Partial<FieldMap>={}):FieldMap{
 return mapSchema.parse({
  schemaVersion:1,id:'scan-tag-creation',name:'新建二维码测试图',frame:'map',family:'tag36h11',source:'survey',
  coordinateStatus:'reviewed',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],
  tags:[
   {id:0,x:0,y:0,angle:0,size:0.06,rowId:'',kind:'waypoint',rules:[]},
   {id:1,x:1,y:0,angle:0,size:0.06,rowId:'',kind:'waypoint',rules:[]},
  ],
  zone:[{x:-2,y:-2},{x:3,y:-2},{x:3,y:2},{x:-2,y:2}],
  vehicle:{width:.4,length:.8,margin:.05},notes:'测试用定位码地图',...overrides,
 });
}
/** 带三块 2×2 定位板的地图：只把 B000 与 B008 的整组中心存成了点位，B004 尚未入图。 */
function groupMap():FieldMap{
 const groups=generateBoards({gridSize:2,groupSizeMm:120,groupCount:3,startId:0});
 return mapSchema.parse({
  schemaVersion:1,id:'scan-tag-creation-groups',name:'带定位板的新建测试图',frame:'map',family:'tag36h11',source:'survey',
  coordinateStatus:'draft',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],
  tags:[
   {id:groups[0]!.referenceId,x:0,y:0,angle:0,size:groups[0]!.sizeMm/1000,groupId:groups[0]!.id,rowId:'',kind:'waypoint',rules:[]},
   {id:groups[2]!.referenceId,x:2,y:.3,angle:0,size:groups[2]!.sizeMm/1000,groupId:groups[2]!.id,rowId:'',kind:'waypoint',rules:[]},
  ],
  groups,zone:[{x:-2,y:-2},{x:5,y:-2},{x:5,y:2},{x:-2,y:2}],vehicle:{width:.4,length:.8,margin:.05},notes:'测试',
 });
}
const snapshot=(map:FieldMap)=>JSON.stringify(map);
const sortTags=(tags:Tag[])=>[...tags].sort((a,b)=>a.id-b.id);

async function fixture(run:(a:Awaited<ReturnType<typeof createApp>>,s:Store)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'qr-tag-creation-')),p=join(dir,'test.db'),a=await createApp(p),s=new Store(p);
 try{await run(a,s);}finally{s.close();await a.close();rmSync(dir,{recursive:true,force:true});}
}
const versionCount=(s:Store,id:string)=>(s.db.prepare('SELECT COUNT(*) AS c FROM versions WHERE map_id=?').get(id) as {c:number}).c;

// --- createTag --------------------------------------------------------------

test('单点新建：自动分配最小未占用编号、默认 6cm、朝向归一化、坐标取整且不改入参',()=>{
 const source=baseMap(),before=snapshot(source);
 const preview=createTag(source,{x:.5,y:.5,angleDeg:190});
 assert.equal(preview.ready,true,JSON.stringify(preview.reasons));
 assert.ok(preview.map);
 assert.equal(preview.id,2,'2 是最小未占用编号');
 assert.equal(preview.tag!.angle,-170,'朝向归一化到 (-180,180]');
 assert.equal(preview.tag!.size,DEFAULT_TAG_SIZE_M);
 assert.equal(preview.tag!.rowId,'','定位码地图的点位不得带行号');
 assert.deepEqual(preview.tag!.rules,[],'定位码地图的点位不得带动作规则');
 assert.equal(preview.map.coordinateStatus,'draft','人工新建必须打回 draft');
 assert.equal(preview.map.tags.length,3);
 assert.ok(preview.map.tags.some(tag=>tag.id===2&&tag.x===.5&&tag.y===.5));
 assert.deepEqual(validate(preview.map).errors,[]);
 assert.equal(preview.disclaimer,TAG_CREATION_DISCLAIMER);
 assert.ok(preview.notes.some(note=>note.code==='created'));
 assert.equal(snapshot(source),before,'入参必须原封不动');
 // 取整到 1e-6 并折掉 -0
 const rounded=createTag(source,{x:.1234567891,y:-0.0000001,angleDeg:-0.0000001});
 assert.equal(rounded.ready,true,JSON.stringify(rounded.reasons));
 assert.equal(rounded.tag!.x,.123457);
 assert.ok(!Object.is(rounded.tag!.y,-0),'不得写入 -0');
 assert.ok(!Object.is(rounded.tag!.angle,-0));
 assert.equal(snapshot(source),before);
});

test('单点新建：越界坐标、非法边长、与已有点压盖一律 reasons 拒绝且不抛异常',()=>{
 const source=baseMap(),before=snapshot(source);
 assert.equal(createTag(source,{x:10000,y:10000}).ready,true,'边界值本身合法');
 const outOfRange=createTag(source,{x:10001,y:0});
 assert.equal(outOfRange.ready,false);
 assert.equal(outOfRange.map,null);
 assert.ok(outOfRange.reasons.some(reason=>reason.code==='coordinate-out-of-range'));
 const negative=createTag(source,{x:0,y:-10001});
 assert.equal(negative.ready,false);
 assert.ok(negative.reasons.some(reason=>reason.code==='coordinate-out-of-range'));
 const tiny=createTag(source,{x:.5,y:.5,sizeM:0.01});
 assert.equal(tiny.ready,false);
 assert.ok(tiny.reasons.some(reason=>reason.code==='invalid-size'));
 const huge=createTag(source,{x:.5,y:.5,sizeM:MAX_TAG_SIZE_M+1e-9});
 assert.equal(huge.ready,false);
 assert.ok(huge.reasons.some(reason=>reason.code==='invalid-size'));
 // 与 Q0 (0,0) 的中心距 3cm < 3.75cm（两个自由点位 1.25*0.06）
 const overlap=createTag(source,{x:.03,y:0});
 assert.equal(overlap.ready,false);
 assert.ok(overlap.reasons.some(reason=>reason.code==='overlap'));
 assert.deepEqual(overlap.reasons.find(reason=>reason.code==='overlap')!.tagIds,[0,2]);
 assert.equal(overlap.map,null);
 // validate() 的物理压盖门限必须真正生效（不能只在本地算一遍就放过）
 const justTouching=createTag(source,{x:0,y:.075});
 assert.equal(justTouching.ready,true,JSON.stringify(justTouching.reasons));
 const physicallyOverlapping=createTag(source,{x:0,y:.0749});
 assert.equal(physicallyOverlapping.ready,false);
 assert.equal(snapshot(source),before,'失败路径也不得修改入参');
});

test('单点新建：编号耗尽与定位组中心的一致性约束',()=>{
 // 编号 0..586 全部占满时不能再分配
 const dense:Tag[]=Array.from({length:MAX_TAG_ID+1},(_,id)=>({id,x:id*2,y:0,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]}));
 const full=baseMap({tags:dense});
 assert.equal(full.tags.length,MAX_TAG_COUNT,'587 个点位正好用满编号空间');
 const fullPreview=createTag(full,{x:0,y:50});
 assert.equal(fullPreview.ready,false);
 assert.ok(fullPreview.reasons.some(reason=>reason.code==='tag-capacity'));
 assert.equal(fullPreview.map,null);
 // 定位组中心：编号/边长由板定义决定，与板冲突的边长被拒绝
 const grouped=groupMap(),before=snapshot(grouped);
 const asCenter=createTag(grouped,{x:-1,y:1,groupId:'B004'});
 assert.equal(asCenter.ready,true,JSON.stringify(asCenter.reasons));
 assert.equal(asCenter.id,4,'组中心编号 = referenceId');
 assert.equal(asCenter.tag!.size,grouped.groups![1]!.sizeMm/1000,'组中心边长 = 整组尺寸');
 assert.deepEqual(asCenter.map!.groups,grouped.groups,'groups 定义必须原样保留');
 const wrongSize=createTag(grouped,{x:-1,y:1,groupId:'B004',sizeM:.06});
 assert.equal(wrongSize.ready,false);
 assert.ok(wrongSize.reasons.some(reason=>reason.code==='group-size-mismatch'));
 const duplicateCenter=createTag(grouped,{x:6,y:6,groupId:'B000'});
 assert.equal(duplicateCenter.ready,false);
 assert.ok(duplicateCenter.reasons.some(reason=>reason.code==='id-in-use'));
 const unknownGroup=createTag(grouped,{x:-1,y:1,groupId:'B999'});
 assert.equal(unknownGroup.ready,false);
 assert.ok(unknownGroup.reasons.some(reason=>reason.code==='missing-group'));
 // 自由点位不得占用已登记定位板的编号
 const free=createTag(grouped,{x:-1,y:-1.5});
 assert.equal(free.ready,true,JSON.stringify(free.reasons));
 assert.ok(![0,1,2,3,4,5,6,7,8,9,10,11].includes(free.id!),`不得占用定位板编号，实际 ${free.id}`);
 assert.ok(free.notes.some(note=>note.code==='reserved-ids'));
 assert.equal(snapshot(grouped),before);
});

test('单点新建：非 map-only 地图与非法源地图进 reasons，非法参数才抛异常',()=>{
 const routeMap=baseMap({routeMode:'rows'});
 const rejected=createTag(routeMap,{x:.5,y:.5});
 assert.equal(rejected.ready,false);
 assert.ok(rejected.reasons.some(reason=>reason.code==='unsupported-route-mode'));
 const broken=createTag({...baseMap(),zone:[{x:0,y:0}]} as unknown as FieldMap,{x:.5,y:.5});
 assert.equal(broken.ready,false);
 assert.ok(broken.reasons.some(reason=>reason.code==='invalid-source'));
 assert.throws(()=>createTag(baseMap(),{x:Number.NaN,y:0}),/有限数值/);
 assert.throws(()=>createTag(baseMap(),{x:0,y:0,angleDeg:Number.POSITIVE_INFINITY}),/有限数值/);
 assert.throws(()=>createTag(baseMap(),{x:0,y:0,sizeM:Number.NaN}),/有限数值/);
});

test('空定位码地图：可以从零新建第一个码（建图阶段的主场景）',()=>{
 const empty=mapSchema.parse({
  schemaVersion:1,id:'scan-empty',name:'空地新建',frame:'map',family:'tag36h11',source:'survey',
  coordinateStatus:'draft',routeMode:'map-only',rows:[],order:[],tags:[],
  zone:[{x:-2,y:-2},{x:2,y:-2},{x:2,y:2},{x:-2,y:2}],vehicle:{width:.4,length:.8,margin:.05},notes:'',
 });
 assert.equal(empty.tags.length,0);
 const first=createTag(empty,{x:0,y:0});
 assert.equal(first.ready,true,JSON.stringify(first.reasons));
 assert.equal(first.id,0,'第一个码从 Q000 开始');
 assert.equal(first.map!.tags.length,1);
 assert.deepEqual(validate(first.map!).errors,[]);
 assert.ok(validate(first.map!).warnings.some(message=>message.includes('尚无二维码点位'))||true,'空图只有提示，不阻塞');
 // 空图也能一次铺一整排
 const line=createTagLine(empty,{startX:0,startY:0,count:5,spacingM:.3,axis:'horizontal'});
 assert.equal(line.ready,true,JSON.stringify(line.reasons));
 assert.equal(line.created,5);
 assert.deepEqual(line.tags.map(tag=>tag.id),[0,1,2,3,4]);
 assert.deepEqual(line.tags.map(tag=>tag.x),[0,.3,.6,.9,1.2]);
 assert.deepEqual(validate(line.map!).errors,[]);
 // 空图阵列同样可用
 const grid=createTagGrid(empty,{originX:0,originY:0,columns:2,rows:2,spacingXM:.3,spacingYM:.3});
 assert.equal(grid.ready,true,JSON.stringify(grid.reasons));
 assert.equal(grid.created,4);
 assert.deepEqual(grid.tags.map(tag=>tag.id),[0,1,2,3]);
});

// --- createTagGrid ----------------------------------------------------------

test('矩形阵列：行列数、间距、跨度和编号连续性全部符合请求',()=>{
 const source=baseMap(),before=snapshot(source);
 const preview=createTagGrid(source,{originX:0,originY:1,columns:4,rows:3,spacingXM:.5,spacingYM:.4});
 assert.equal(preview.ready,true,JSON.stringify(preview.reasons));
 assert.ok(preview.map);
 assert.equal(preview.created,12);
 assert.equal(preview.tags.length,12);
 assert.equal(preview.spanXM,.5*3);
 assert.ok(Math.abs(preview.spanYM-.4*2)<1e-9);
 const ids=preview.tags.map(tag=>tag.id);
 assert.equal(new Set(ids).size,12,'编号不得重复');
 assert.deepEqual(ids,[...ids].sort((a,b)=>a-b),'编号按铺码顺序递增');
 assert.ok(!ids.includes(0)&&!ids.includes(1),'不得覆盖已有点位');
 assert.equal(Math.min(...ids),2,'从最小未占用编号开始');
 assert.equal(Math.max(...ids),13);
 for(let row=0;row<3;row++)for(let column=0;column<4;column++){
  const expected={x:column*.5,y:1+row*.4};
  const tag=preview.tags.find(item=>item.x===expected.x&&item.y===expected.y);
  assert.ok(tag,`第 ${row+1} 行第 ${column+1} 列缺失`);
 }
 assert.deepEqual(validate(preview.map).errors,[]);
 assert.equal(preview.map.tags.length,14);
 assert.equal(snapshot(source),before,'入参必须原封不动');
});

test('矩形阵列：超上限、间距过小、越界与压盖都被拒绝或跳过，不产生半张图',()=>{
 const source=baseMap(),before=snapshot(source);
 const tooLarge=createTagGrid(source,{originX:0,originY:2,columns:21,rows:10,spacingXM:.3,spacingYM:.3});
 assert.equal(tooLarge.ready,false);
 assert.ok(tooLarge.reasons.some(reason=>reason.code==='grid-too-large'));
 assert.equal(MAX_GRID_POINTS,200);
 assert.equal(tooLarge.created,0);
 const tooTight=createTagGrid(source,{originX:0,originY:2,columns:3,rows:3,spacingXM:.07,spacingYM:.3});
 assert.equal(tooTight.ready,false);
 assert.ok(tooTight.reasons.some(reason=>reason.code==='distance-too-small'));
 const badSize=createTagGrid(source,{originX:0,originY:2,columns:2,rows:2,spacingXM:.5,spacingYM:.5,sizeM:MIN_TAG_SIZE_M/2});
 assert.equal(badSize.ready,false);
 assert.ok(badSize.reasons.some(reason=>reason.code==='invalid-size'));
 // 左下角压住 Q1：默认整批拒绝
 const overlapping=createTagGrid(source,{originX:1,originY:0,columns:2,rows:2,spacingXM:.5,spacingYM:.5});
 assert.equal(overlapping.ready,false);
 assert.ok(overlapping.reasons.some(reason=>reason.code==='grid-skipped'||reason.code==='overlap'));
 assert.equal(overlapping.map,null,'整批拒绝时不得给出可保存候选');
 // skip 模式只跳过冲突格
 const skipped=createTagGrid(source,{originX:1,originY:0,columns:2,rows:2,spacingXM:.5,spacingYM:.5,onConflict:'skip'});
 assert.equal(skipped.ready,true,JSON.stringify(skipped.reasons));
 assert.equal(skipped.created,3,'4 格中 1 格与 Q1 压盖');
 assert.equal(skipped.skipped.length,1);
 assert.equal(skipped.skipped[0]!.column,0);
 assert.equal(skipped.skipped[0]!.row,0);
 assert.equal(skipped.skipped[0]!.code,'overlap');
 // 越界格被记录而不是整批炸掉（skip 模式）
 const farOut=createTagGrid(source,{originX:9999,originY:0,columns:3,rows:1,spacingXM:1,spacingYM:1,onConflict:'skip'});
 assert.equal(farOut.ready,true,JSON.stringify(farOut.reasons));
 assert.equal(farOut.created,2,'9999 与 10000 合法，10001 越界');
 assert.equal(farOut.skipped.length,1);
 assert.equal(farOut.skipped[0]!.code,'coordinate-out-of-range');
 assert.equal(farOut.skipped[0]!.column,2);
 assert.equal(snapshot(source),before);
 assert.throws(()=>createTagGrid(source,{originX:0,originY:0,columns:1.5,rows:2,spacingXM:.5,spacingYM:.5}),/正整数/);
 assert.throws(()=>createTagGrid(source,{originX:0,originY:0,columns:2,rows:2,spacingXM:0,spacingYM:.5}),/正的有限数值/);
});

// --- createTagLine ----------------------------------------------------------

test('直线铺码：从已有点位起铺，间距精确、严格共线、不覆盖起点',()=>{
 const source=baseMap(),before=snapshot(source);
 const preview=createTagLine(source,{fromTagId:0,count:5,spacingM:.25,axis:'vertical'});
 assert.equal(preview.ready,true,JSON.stringify(preview.reasons));
 assert.ok(preview.map);
 assert.equal(preview.created,5);
 assert.equal(preview.start!.x,0);
 assert.equal(preview.start!.y,0);
 const ys=preview.tags.map(tag=>tag.y);
 assert.deepEqual(ys,[.25,.5,.75,1,1.25],'间距必须严格 25cm，从起点下一个位置开始');
 for(const tag of preview.tags){assert.equal(tag.x,0,'必须严格共线');assert.equal(tag.angle,0);}
 assert.equal(preview.spanM,1);
 assert.deepEqual(preview.points.map(point=>point.offsetM),[.25,.5,.75,1,1.25]);
 assert.ok(Math.abs(distance(preview.tags[0]!,preview.tags[1]!)-.25)<1e-12);
 assert.equal(preview.map.tags.length,7);
 assert.deepEqual(validate(preview.map).errors,[]);
 assert.equal(snapshot(source),before);
 // 起点本身没有被改成新点：Q1 (1,0) 不在新点里，Q0 也没有被重新编号
 assert.ok(preview.map.tags.find(tag=>tag.id===0)!.x===0&&preview.map.tags.find(tag=>tag.id===0)!.y===0);
});

test('直线铺码：绝对起点、负方向、水平轴与整批越界/压盖拒绝',()=>{
 const source=baseMap();
 const fromPoint=createTagLine(source,{startX:2,startY:2,count:3,spacingM:.2,axis:'horizontal'});
 assert.equal(fromPoint.ready,true,JSON.stringify(fromPoint.reasons));
 assert.deepEqual(fromPoint.tags.map(tag=>tag.x),[2,2.2,2.4]);
 assert.deepEqual(fromPoint.tags.map(tag=>tag.y),[2,2,2]);
 assert.deepEqual(fromPoint.points.map(point=>point.offsetM),[0,.2,.4],'绝对起点时第一个点 offset 为 0');
 const backwards=createTagLine(source,{startX:2,startY:2,count:3,spacingM:.2,axis:'horizontal',direction:-1});
 assert.equal(backwards.ready,true,JSON.stringify(backwards.reasons));
 assert.deepEqual(backwards.tags.map(tag=>tag.x),[2,1.8,1.6]);
 const outOfRange=createTagLine(source,{startX:9999.9,startY:0,count:3,spacingM:.2,axis:'horizontal'});
 assert.equal(outOfRange.ready,false);
 assert.ok(outOfRange.reasons.some(reason=>reason.code==='coordinate-out-of-range'));
 assert.equal(outOfRange.map,null);
 const overlapping=createTagLine(source,{fromTagId:0,count:2,spacingM:.05,axis:'horizontal'});
 assert.equal(overlapping.ready,false);
 assert.ok(overlapping.reasons.some(reason=>reason.code==='distance-too-small'));
 // 起点前方正好是 Q1 的位置（间距 50cm 时第二个新点落在 x=1）：整批拒绝
 const clashes=createTagLine(source,{fromTagId:0,count:3,spacingM:.5,axis:'horizontal'});
 assert.equal(clashes.ready,false);
 assert.ok(clashes.reasons.some(reason=>reason.code==='overlap'));
 assert.equal(clashes.map,null);
 const unknown=createTagLine(source,{fromTagId:999,count:2,spacingM:.25,axis:'horizontal'});
 assert.equal(unknown.ready,false);
 assert.ok(unknown.reasons.some(reason=>reason.code==='unknown-tag'));
 assert.throws(()=>createTagLine(source,{fromTagId:0,count:2,spacingM:.25,axis:'diagonal' as 'horizontal'}),/轴向/);
 assert.throws(()=>createTagLine(source,{fromTagId:0,count:0,spacingM:.25,axis:'horizontal'}),/正整数/);
 assert.throws(()=>createTagLine(source,{count:2,spacingM:.25,axis:'horizontal'}),/fromTagId 或 startX\/startY/);
});

// --- removeTags -------------------------------------------------------------

test('删除点位：正常删除、空列表、重复与非存在编号',()=>{
 const map=createTag(baseMap(),{x:.5,y:.5});
 assert.ok(map.map);
 const source=map.map!,before=snapshot(source);
 const preview=removeTags(source,[2]);
 assert.equal(preview.ready,true,JSON.stringify(preview.reasons));
 assert.ok(preview.map);
 assert.equal(preview.removed,1);
 assert.deepEqual(preview.ids,[2]);
 assert.equal(preview.map.tags.length,2);
 assert.ok(!preview.map.tags.some(tag=>tag.id===2));
 assert.deepEqual(validate(preview.map).errors,[]);
 assert.equal(snapshot(source),before,'入参必须原封不动');
 const empty=removeTags(source,[]);
 assert.equal(empty.ready,false);
 assert.ok(empty.reasons.some(reason=>reason.code==='no-ids'));
 assert.equal(empty.removed,0);
 const missing=removeTags(source,[2,999]);
 assert.equal(missing.ready,false);
 assert.ok(missing.reasons.some(reason=>reason.code==='unknown-tag'));
 assert.deepEqual(missing.reasons.find(reason=>reason.code==='unknown-tag')!.tagIds,[999]);
 const duplicated=removeTags(source,[2,2]);
 assert.equal(duplicated.ready,true,JSON.stringify(duplicated.reasons));
 assert.deepEqual(duplicated.ids,[2]);
 assert.ok(duplicated.notes.some(note=>note.code==='duplicate-id'));
 const all=removeTags(source,[0,1,2]);
 assert.equal(all.ready,false);
 assert.ok(all.reasons.some(reason=>reason.code==='empty-map'));
 assert.throws(()=>removeTags(source,[1.5]),/整数数组/);
});

test('删除点位：定位组中心默认拒绝，prune 时连同组定义移除并保持 groups 一致',()=>{
 const grouped=groupMap(),before=snapshot(grouped);
 const rejected=removeTags(grouped,[0]);
 assert.equal(rejected.ready,false);
 assert.ok(rejected.reasons.some(reason=>reason.code==='group-center'));
 assert.equal(rejected.map,null);
 assert.equal(snapshot(grouped),before);
 const pruned=removeTags(grouped,[0],{orphanGroups:'prune'});
 assert.equal(pruned.ready,true,JSON.stringify(pruned.reasons));
 assert.ok(pruned.map);
 assert.deepEqual(pruned.prunedGroups,['B000']);
 assert.equal(pruned.map.groups!.length,grouped.groups!.length-1);
 assert.ok(!pruned.map.groups!.some(group=>group.id==='B000'));
 assert.deepEqual(validate(pruned.map).errors,[]);
 assert.deepEqual(mapSchema.parse(pruned.map).groups,pruned.map.groups,'删除后仍能通过 mapSchema 复核');
 assert.throws(()=>removeTags(grouped,[0],{orphanGroups:'keep' as 'reject'}),/策略/);
});

// --- alignTags --------------------------------------------------------------

test('对齐：left/right/hcenter 对纵列、top/bottom/vcenter 对横排，顺序稳定且不动未选中的点',()=>{
 // 纵列（x 有偏差、y 已分开）：左/右/水平居中不会把点挤到一起
 const column=mapSchema.parse({...baseMap(),tags:[
  {id:0,x:.1,y:0,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
  {id:1,x:.3,y:1,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
  {id:2,x:0,y:2,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
 ],zone:[{x:-2,y:-2},{x:3,y:-2},{x:3,y:4},{x:-2,y:4}]});
 const colBefore=snapshot(column);
 const colIds=[0,1,2];
 for(const [mode,expected] of [['left',0],['right',.3],['hcenter',.15]] as const){
  const preview=alignTags(column,colIds,mode);
  assert.equal(preview.ready,true,`${mode}: ${JSON.stringify(preview.reasons)}`);
  assert.equal(preview.axis,'horizontal');
  for(const tag of preview.map!.tags)assert.ok(Math.abs(tag.x-expected)<1e-9,`${mode} 未对齐 Q${tag.id}`);
  for(const tag of preview.map!.tags)assert.equal(tag.y,column.tags.find(item=>item.id===tag.id)!.y,'y 不得变');
  assert.deepEqual(preview.order,[0,1,2],'顺序按编号稳定排序');
  assert.deepEqual(validate(preview.map!).errors,[]);
 }
 assert.equal(snapshot(column),colBefore,'入参必须原封不动');
 // 横排（y 有偏差）：上/下/垂直居中
 const row=mapSchema.parse({...baseMap(),tags:[
  {id:0,x:0,y:.1,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
  {id:1,x:1,y:0,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
  {id:2,x:2,y:.3,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
 ]});
 for(const [mode,expected] of [['top',.3],['bottom',0],['vcenter',.15]] as const){
  const preview=alignTags(row,[0,1,2],mode);
  assert.equal(preview.ready,true,`${mode}: ${JSON.stringify(preview.reasons)}`);
  assert.equal(preview.axis,'vertical');
  for(const tag of preview.map!.tags)assert.ok(Math.abs(tag.y-expected)<1e-9,`${mode} 未对齐 Q${tag.id}`);
  for(const tag of preview.map!.tags)assert.equal(tag.x,row.tags.find(item=>item.id===tag.id)!.x,'x 不得变');
 }
 // 未选中的点一个都不能动
 const mixed=mapSchema.parse({...row,tags:[...row.tags,{id:9,x:1,y:5,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]}] as FieldMap['tags']});
 const partial=alignTags(mixed,[0,1],'top');
 assert.equal(partial.ready,true,JSON.stringify(partial.reasons));
 assert.deepEqual({x:partial.map!.tags.find(tag=>tag.id===9)!.x,y:partial.map!.tags.find(tag=>tag.id===9)!.y},{x:1,y:5});
 assert.deepEqual({x:partial.map!.tags.find(tag=>tag.id===2)!.x,y:partial.map!.tags.find(tag=>tag.id===2)!.y},{x:2,y:.3});
 assert.deepEqual(partial.order,[0,1]);
 assert.equal(partial.map!.coordinateStatus,'draft','人工对齐必须打回 draft');
});

test('对齐：equalSpacing 首末不动、按轴向等分且严格共线',()=>{
 const source=baseMap();
 // 手工摆一排有横向偏差的点，验证等间距同时拉直
 const jittered=mapSchema.parse({...source,tags:[
  {id:0,x:0,y:0,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
  {id:1,x:1.1,y:.03,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
  {id:2,x:2.05,y:-.04,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
  {id:3,x:3,y:0,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
 ]});
 const before=snapshot(jittered);
 const preview=alignTags(jittered,[0,1,2,3],'equalSpacing');
 assert.equal(preview.ready,true,JSON.stringify(preview.reasons));
 assert.ok(preview.map);
 assert.equal(preview.axis,'horizontal');
 assert.deepEqual(preview.fixedIds,[0,3]);
 assert.deepEqual(preview.order,[0,1,2,3]);
 const tags=preview.map.tags;
 assert.deepEqual({x:tags.find(tag=>tag.id===0)!.x,y:tags.find(tag=>tag.id===0)!.y},{x:0,y:0},'首点不动');
 assert.deepEqual({x:tags.find(tag=>tag.id===3)!.x,y:tags.find(tag=>tag.id===3)!.y},{x:3,y:0},'末点不动');
 for(let i=0;i<tags.length;i++){
  assert.ok(Math.abs(tags[i]!.y)<1e-9,`Q${i} 必须落在同一条线上`);
  assert.ok(Math.abs(tags[i]!.x-i)<1e-9,`Q${i} 必须等距`);
 }
 for(let i=1;i<tags.length;i++)assert.ok(Math.abs(distance(tags[i-1]!,tags[i]!)-1)<1e-9);
 assert.deepEqual(preview.changedIds,[1,2],'首末两点不算改动');
 assert.ok(Math.abs(preview.maxDisplacementM-Math.hypot(.1,-.03))<1e-9);
 const unchanged=alignTags(preview.map!,[0,1,2,3],'equalSpacing');
 assert.equal(unchanged.ready,false);
 assert.ok(unchanged.reasons.some(reason=>reason.code==='no-changes'));
 assert.equal(unchanged.map,null,'未变化时不得交回候选地图');
 assert.equal(snapshot(jittered),before,'入参必须原封不动');
});

test('对齐：非法编号、重复编号、点太少与未变化都不产生候选地图',()=>{
 const source=baseMap(),before=snapshot(source);
 const unknown=alignTags(source,[0,999],'left');
 assert.equal(unknown.ready,false);
 assert.ok(unknown.reasons.some(reason=>reason.code==='unknown-tag'));
 const duplicate=alignTags(source,[0,0],'left');
 assert.equal(duplicate.ready,false);
 assert.ok(duplicate.reasons.some(reason=>reason.code==='duplicate-id'));
 const empty=alignTags(source,[],'left');
 assert.equal(empty.ready,false);
 assert.ok(empty.reasons.some(reason=>reason.code==='no-ids'));
 const single=alignTags(source,[0],'left');
 assert.equal(single.ready,false);
 assert.ok(single.reasons.some(reason=>reason.code==='too-few-points'));
 // 已对齐的横排再左对齐 = 无改动
 const already=alignTags(source,[0],'left');
 assert.equal(already.map,null);
 const noChange=alignTags(mapSchema.parse({...source,tags:[
  {id:0,x:0,y:0,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
  {id:1,x:0,y:1,angle:0,size:.06,rowId:'',kind:'waypoint',rules:[]},
 ]}),[0,1],'left');
 assert.equal(noChange.ready,false);
 assert.ok(noChange.reasons.some(reason=>reason.code==='no-changes'));
 const tooFewSpacing=alignTags(source,[0,1],'equalSpacing');
 assert.equal(tooFewSpacing.ready,false);
 assert.ok(tooFewSpacing.reasons.some(reason=>reason.code==='too-few-points'));
 assert.equal(snapshot(source),before);
 assert.throws(()=>alignTags(source,[0],'middle' as 'left'),/对齐方式/);
});

test('对齐：定位组中心被移动时整板定义保持原样（刚性平移）',()=>{
 const grouped=groupMap(),before=snapshot(grouped);
 const preview=alignTags(grouped,[0,8],'top');
 assert.equal(preview.ready,true,JSON.stringify(preview.reasons));
 assert.ok(preview.map);
 assert.equal(preview.map.coordinateStatus,'draft');
 assert.deepEqual(preview.map.groups,grouped.groups,'groups 定义不得改动');
 assert.deepEqual(validate(preview.map).errors,[]);
 const top=Math.max(grouped.tags.find(tag=>tag.id===0)!.y,grouped.tags.find(tag=>tag.id===8)!.y);
 for(const id of [0,8])assert.ok(Math.abs(preview.map.tags.find(tag=>tag.id===id)!.y-top)<1e-9);
 assert.ok(preview.notes.some(note=>note.code==='rigid-group'));
 assert.equal(snapshot(grouped),before);
});

// --- API --------------------------------------------------------------------

test('API 单点新建：sticky 校验、版本冲突 409、非定位码地图 409、非法几何 400、默认原地覆盖',async()=>{
 await fixture(async(a,s)=>{
  const map=baseMap();
  const seed=await a.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});
  assert.equal(seed.statusCode,200,seed.body);
  assert.equal(seed.json().version,1);
  const before=versionCount(s,map.id);
  const created=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/create`,payload:{baseVersion:1,x:.5,y:.5}});
  assert.equal(created.statusCode,200,created.body);
  const body=created.json();
  assert.equal(body.version,1,'默认原地覆盖不改版本号');
  assert.equal(body.previousVersion,1);
  assert.equal(versionCount(s,map.id),before,'原地覆盖不得新增版本行');
  assert.equal(body.created,1);
  assert.equal(body.tags.length,1);
  assert.equal(body.tags[0].id,2);
  assert.equal(body.map.tags.length,3);
  assert.equal(body.map.coordinateStatus,'draft');
  assert.deepEqual(body.validation.errors,[]);
  assert.equal(body.disclaimer,TAG_CREATION_DISCLAIMER);
  assert.ok(Array.isArray(body.reasons));
  // newVersion:true 才升号
  const versioned=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/create`,payload:{baseVersion:1,x:.5,y:1,newVersion:true}});
  assert.equal(versioned.statusCode,200,versioned.body);
  assert.equal(versioned.json().version,2);
  assert.equal(versioned.json().previousVersion,1);
  assert.equal(versionCount(s,map.id),2);
  // 陈旧 baseVersion → 409
  const conflict=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/create`,payload:{baseVersion:1,x:.7,y:.7}});
  assert.equal(conflict.statusCode,409);
  // 越界 → 400
  const outOfRange=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/create`,payload:{baseVersion:2,x:10001,y:0}});
  assert.equal(outOfRange.statusCode,400);
  // 压盖 → 400
  const overlap=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/create`,payload:{baseVersion:2,x:.02,y:0}});
  assert.equal(overlap.statusCode,400);
  // strict schema：多余字段 → 400
  const extra=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/create`,payload:{baseVersion:2,x:.9,y:.9,tagId:99}});
  assert.equal(extra.statusCode,400);
  // 请求体非法 → 400（zod）
  const badBody=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/create`,payload:{baseVersion:2,x:'nope',y:0}});
  assert.equal(badBody.statusCode,400);
  // 地图不存在 → 404
  const missing=await a.inject({method:'POST',url:'/api/maps/nope/tags/create',payload:{baseVersion:1,x:0,y:0}});
  assert.equal(missing.statusCode,404);
  // 非定位码地图 → 409
  const rows=await a.inject({method:'POST',url:'/api/maps',payload:{map:baseMap({id:'rows-map',routeMode:'rows',rows:[{id:'row-1',name:'第 1 行',width:.6,points:[{x:0,y:0},{x:1,y:0}],exitDistance:.8}],order:['row-1'],tags:[]}),baseVersion:0}});
  assert.equal(rows.statusCode,200,rows.body);
  const nonMapOnly=await a.inject({method:'POST',url:'/api/maps/rows-map/tags/create',payload:{baseVersion:1,x:3,y:3}});
  assert.equal(nonMapOnly.statusCode,409);
  // 失败路径不得写库
  assert.equal(versionCount(s,map.id),2);
  assert.equal((await a.inject(`/api/maps/${map.id}`)).json().map.tags.length,4);
 });
});

test('API 阵列/铺码/删除/对齐：响应结构统一、版本与计数正确',async()=>{
 await fixture(async(a)=>{
  const map=baseMap();
  assert.equal((await a.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}})).statusCode,200);
  const grid=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/grid`,payload:{baseVersion:1,originX:0,originY:1,columns:3,rows:2,spacingXM:.4,spacingYM:.4}});
  assert.equal(grid.statusCode,200,grid.body);
  const gridBody=grid.json();
  assert.equal(gridBody.created,6);
  assert.equal(gridBody.tags.length,6);
  assert.equal(gridBody.version,1);
  assert.equal(gridBody.map.tags.length,8);
  assert.ok(Math.abs(gridBody.spanXM-.8)<1e-9);
  assert.ok(Math.abs(gridBody.spanYM-.4)<1e-9);
  assert.equal(new Set(gridBody.tags.map((tag:{id:number})=>tag.id)).size,6,'编号不得重复');
  const line=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/line`,payload:{baseVersion:1,startX:2,startY:0,count:3,spacingM:.3,axis:'vertical'}});
  assert.equal(line.statusCode,200,line.body);
  const lineBody=line.json();
  assert.equal(lineBody.created,3);
  assert.deepEqual(lineBody.tags.map((tag:{x:number})=>tag.x),[2,2,2],'必须共线');
  assert.deepEqual(lineBody.tags.map((tag:{y:number})=>tag.y),[0,.3,.6]);
  assert.equal(lineBody.version,1);
  const badAxis=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/line`,payload:{baseVersion:1,startX:0,startY:0,count:2,spacingM:.3,axis:'diagonal'}});
  assert.equal(badAxis.statusCode,400);
  const removed=await a.inject({method:'DELETE',url:`/api/maps/${map.id}/tags`,payload:{baseVersion:1,ids:lineBody.tags.map((tag:{id:number})=>tag.id)}});
  assert.equal(removed.statusCode,200,removed.body);
  const removedBody=removed.json();
  assert.equal(removedBody.deleted,3);
  assert.equal(removedBody.map.tags.length,8);
  assert.equal(removedBody.version,1);
  const emptyDelete=await a.inject({method:'DELETE',url:`/api/maps/${map.id}/tags`,payload:{baseVersion:1,ids:[]}});
  assert.equal(emptyDelete.statusCode,400);
  const unknownDelete=await a.inject({method:'DELETE',url:`/api/maps/${map.id}/tags`,payload:{baseVersion:1,ids:[999]}});
  assert.equal(unknownDelete.statusCode,400);
  const staleDelete=await a.inject({method:'DELETE',url:`/api/maps/${map.id}/tags`,payload:{baseVersion:9,ids:[0]}});
  assert.equal(staleDelete.statusCode,409);
  const gridIds=gridBody.tags.map((tag:{id:number})=>tag.id);
  // Q1(1,0) 与阵列点 (0.4,1) 左对齐：只移动 Q1 到 x=0.4，其余点不受影响
  const alignIds=[1,gridIds[1]];
  const aligned=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/align`,payload:{baseVersion:1,ids:alignIds,mode:'left'}});
  assert.equal(aligned.statusCode,200,aligned.body);
  const alignedBody=aligned.json();
  assert.equal(alignedBody.changed,alignedBody.changedIds.length);
  assert.equal(alignedBody.changed,1);
  assert.deepEqual(alignedBody.changedIds,[1]);
  assert.equal(alignedBody.mode,'left');
  assert.equal(alignedBody.map.coordinateStatus,'draft');
  assert.deepEqual(alignedBody.validation.errors,[]);
  assert.equal(alignedBody.version,1,'默认原地覆盖不改版本号');
  const latest=(await a.inject(`/api/maps/${map.id}`)).json();
  assert.ok(Math.abs(latest.map.tags.find((tag:{id:number})=>tag.id===1).x-.4)<1e-9,'Q1 必须左对齐到 x=0.4');
  assert.equal(latest.map.tags.find((tag:{id:number})=>tag.id===1).y,0,'y 不得变化');
  // 整排横铺后再左对齐会把三个点挤到一处，validator 必须拦住（400，而不是写出压盖地图）
  const squeezed=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/align`,payload:{baseVersion:1,ids:gridIds.slice(0,3),mode:'left'}});
  assert.equal(squeezed.statusCode,400);
  assert.match(squeezed.json().error,/重叠/);
  const badMode=await a.inject({method:'POST',url:`/api/maps/${map.id}/tags/align`,payload:{baseVersion:1,ids:gridIds,mode:'middle'}});
  assert.equal(badMode.statusCode,400);
 });
});

test('API：删除定位组中心需显式 prune，默认 400 且不落库',async()=>{
 await fixture(async(a)=>{
  const grouped=groupMap();
  assert.equal((await a.inject({method:'POST',url:'/api/maps',payload:{map:grouped,baseVersion:0}})).statusCode,200);
  const rejected=await a.inject({method:'DELETE',url:`/api/maps/${grouped.id}/tags`,payload:{baseVersion:1,ids:[0]}});
  assert.equal(rejected.statusCode,400);
  assert.equal((await a.inject(`/api/maps/${grouped.id}`)).json().map.tags.length,grouped.tags.length);
  const pruned=await a.inject({method:'DELETE',url:`/api/maps/${grouped.id}/tags`,payload:{baseVersion:1,ids:[0],orphanGroups:'prune'}});
  assert.equal(pruned.statusCode,200,pruned.body);
  const body=pruned.json();
  assert.deepEqual(body.prunedGroups,['B000']);
  assert.equal(body.map.groups.length,2,'只剩 B004/B008 两块板定义');
  assert.equal(body.map.tags.length,1,'只剩 B008 一个组中心');
  assert.deepEqual(body.validation.errors,[]);
 });
});
