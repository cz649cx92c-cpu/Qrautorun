import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {mapSchema,validate,distance,type FieldMap} from '../web/shared/model';
import {createBlankMap,blankMapDefaults,blankZone,BLANK_MAP_ID_PATTERN,BLANK_MAP_DISCLAIMER,BLANK_MAP_NOTES,type BlankMapResult} from '../web/shared/map-design';

// 新建空白地图（手动铺码）——纯函数 + API 全链路。
// 一张空白图的硬要求：能过 mapSchema + validate（只有 warning），能被
// /api/maps/:id/tags/create 直接铺第一个码，并且永远不能启动导航。
const ID_PATTERN=/^[a-zA-Z0-9_-]{1,80}$/;
const AUTO_ID=/^design-[0-9a-f]{8}$/;
const codes=(result:BlankMapResult)=>result.reasons.map(reason=>reason.code);
const reasonText=(result:BlankMapResult)=>result.reasons.map(reason=>reason.message).join('；');

async function fixture(run:(a:Awaited<ReturnType<typeof createApp>>,s:Store)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'qr-map-design-')),p=join(dir,'test.db'),a=await createApp(p),s=new Store(p);
 try{await run(a,s);}finally{s.close();await a.close();rmSync(dir,{recursive:true,force:true});}
}
const versionCount=(s:Store,id:string)=>(s.db.prepare('SELECT COUNT(*) AS c FROM versions WHERE map_id=?').get(id) as {c:number}).c;

// --- 纯函数：createBlankMap -------------------------------------------------

test('空白地图：合法、自动编号格式正确、routeMode/source/coordinateStatus 正确、无点位',()=>{
 const result=createBlankMap({name:'办公室空白底图'});
 assert.equal(result.ready,true,reasonText(result));
 assert.deepEqual(result.reasons,[]);
 assert.ok(result.map,'ready 时必须交回候选地图');
 const map=result.map!;
 // 自动编号：design-<8位小写 hex>，且必须落在 mapSchema 的 id 正则里。
 assert.match(map.id,AUTO_ID);
 assert.match(map.id,ID_PATTERN);
 assert.match(map.id,BLANK_MAP_ID_PATTERN);
 assert.equal(result.id,map.id);
 // 这是一张定位码底图，不是作物行地图，也不是实测扫描。
 assert.equal(map.routeMode,'map-only');
 assert.equal(map.source,'design');
 assert.equal(map.coordinateStatus,'draft');
 assert.equal(map.schemaVersion,1);
 assert.equal(map.frame,'map');
 assert.equal(map.family,'tag36h11');
 // 空：没有点位、没有定位组、没有行、没有作业顺序、没有区间路线。
 assert.deepEqual(map.tags,[]);
 assert.deepEqual(map.groups,[]);
 assert.deepEqual(map.rows,[]);
 assert.deepEqual(map.order,[]);
 assert.equal(map.motionSegments,undefined);
 // 缺省范围：以原点为中心的 ±10 m 矩形，必须是真正的四边形。
 assert.deepEqual(map.zone,blankZone(blankMapDefaults.zoneHalfSizeM));
 assert.deepEqual(map.zone,[{x:-10,y:-10},{x:10,y:-10},{x:10,y:10},{x:-10,y:10}]);
 assert.equal(blankMapDefaults.zoneEdgeM,20);
 // 缺省车辆包络与说明。
 assert.deepEqual(map.vehicle,{width:.4,length:.8,margin:.05});
 assert.equal(map.notes,BLANK_MAP_NOTES);
 assert.equal(result.disclaimer,BLANK_MAP_DISCLAIMER);
 assert.equal(result.tagSizeMm,60);
});

test('空白地图：validate() 只有 warning 没有 error，且能重新走一遍 mapSchema.parse',()=>{
 const map=createBlankMap({name:'空图校验'}).map!;
 const parsed=mapSchema.parse(map);
 assert.deepEqual(parsed,map,'候选地图必须与 parse 结果完全一致（无默认值补写）');
 const validation=validate(parsed);
 assert.deepEqual(validation.errors,[],'空点位不能是 error');
 assert.deepEqual(validation.warnings,[
  '地图尚无二维码点位：请先在地图上新建二维码后再编辑路径',
  '现场坐标未验收，禁止实体导航',
 ]);
 // 结果里的 validation 必须与外面独立跑一遍完全一致。
 assert.deepEqual(createBlankMap({name:'空图校验'}).validation,validation);
});

test('空白地图：自动编号每次不同、长度固定，且都能过 mapSchema',()=>{
 const ids=new Set<string>();
 for(let i=0;i<16;i++){
  const result=createBlankMap({name:'随机编号'});
  assert.equal(result.ready,true,reasonText(result));
  assert.match(result.map!.id,AUTO_ID);
  ids.add(result.map!.id);
 }
 assert.equal(ids.size,16,'16 次新建必须拿到 16 个不同编号');
 // 显式 id 原样保留，不额外加前缀。
 const fixed=createBlankMap({name:'固定编号',id:'design-office-01'}).map!;
 assert.equal(fixed.id,'design-office-01');
});

test('自定义 zone / vehicle / tagSizeMm / notes 生效',()=>{
 const zone=[{x:-3,y:-2},{x:7,y:-2},{x:7,y:6},{x:-3,y:6}];
 const result=createBlankMap({name:'自定义范围',id:'design-custom',zone,vehicle:{width:.62,length:1.1,margin:.08},tagSizeMm:120,notes:'自定义说明'});
 assert.equal(result.ready,true,reasonText(result));
 assert.deepEqual(result.map!.zone,zone);
 assert.deepEqual(result.map!.vehicle,{width:.62,length:1.1,margin:.08});
 assert.deepEqual(result.map!.notes,'自定义说明');
 assert.equal(result.map!.id,'design-custom');
 // tagSizeMm 不进 FieldMap（空图没有点位），只在结果里回传，且不污染地图本体。
 assert.equal(result.tagSizeMm,120);
 assert.equal((result.map as unknown as Record<string,unknown>).tagSizeMm,undefined);
 assert.deepEqual(result.map!.tags,[]);
 // 入参不被修改。
 assert.deepEqual(zone,[{x:-3,y:-2},{x:7,y:-2},{x:7,y:6},{x:-3,y:6}]);
 // 车辆包络部分覆盖时其余字段取默认值。
 const partial=createBlankMap({name:'部分车辆参数',vehicle:{width:.5}});
 assert.equal(partial.ready,true,reasonText(partial));
 assert.deepEqual(partial.map!.vehicle,{width:.5,length:.8,margin:.05});
});

test('空白地图：非法 name / id / zone / vehicle / tagSizeMm 一律 ready=false 且 reasons 有说明',()=>{
 const cases:({input:Parameters<typeof createBlankMap>[0];code:string;message:RegExp})[]=[
  {input:{name:''},code:'invalid-name',message:/名称不能为空/},
  {input:{name:'   '},code:'invalid-name',message:/名称不能为空/},
  {input:{name:null as unknown as string},code:'invalid-name',message:/名称必须是文本/},
  {input:{name:'地'.repeat(101)},code:'invalid-name',message:/最多 100 个字符/},
  {input:{name:'x',id:'bad id'},code:'invalid-id',message:/编号/},
  {input:{name:'x',id:''},code:'invalid-id',message:/编号/},
  {input:{name:'x',id:'a'.repeat(81)},code:'invalid-id',message:/编号/},
  {input:{name:'x',id:null as unknown as string},code:'invalid-id',message:/编号必须是文本/},
  {input:{name:'x',id:42 as unknown as string},code:'invalid-id',message:/编号必须是文本/},
  {input:{name:'x',zone:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]},code:'invalid-zone',message:/4 个点/},
  {input:{name:'x',zone:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1},{x:-1,y:-1}]},code:'invalid-zone',message:/4 个点/},
  {input:{name:'x',zone:[{x:0,y:0},{x:0,y:0},{x:0,y:0},{x:0,y:0}]},code:'degenerate-zone',message:/零面积/},
  {input:{name:'x',zone:[{x:0,y:0},{x:1,y:0},{x:1,y:0},{x:0,y:0}]},code:'degenerate-zone',message:/零面积/},
  {input:{name:'x',zone:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:Number.NaN}]},code:'invalid-zone',message:/有限数值/},
  {input:{name:'x',zone:[{x:-20000,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]},code:'invalid-zone',message:/±10000/},
  {input:{name:'x',vehicle:{width:5}},code:'invalid-vehicle',message:/车辆宽度/},
  {input:{name:'x',vehicle:{length:.1}},code:'invalid-vehicle',message:/车辆长度/},
  {input:{name:'x',vehicle:{margin:0}},code:'invalid-vehicle',message:/安全余量/},
  {input:{name:'x',tagSizeMm:5},code:'invalid-tag-size',message:/20–180 mm/},
  {input:{name:'x',tagSizeMm:300},code:'invalid-tag-size',message:/20–180 mm/},
 ];
 for(const item of cases){
  const result=createBlankMap(item.input);
  assert.equal(result.ready,false,`应拒绝：${JSON.stringify(item.input)}`);
  assert.equal(result.map,null,'ready=false 时不得交回候选地图');
  assert.ok(codes(result).includes(item.code),`期望 ${item.code}，实际 ${codes(result).join(',')}：${reasonText(result)}`);
  assert.ok(result.reasons.some(reason=>item.message.test(reason.message)),`提示语不匹配：${reasonText(result)}`);
 }
});

test('空白地图：zone 只有 4 点且面积非零才放行，退化形状逐个点名',()=>{
 // 共线四点（面积为 0）。
 const collinear=[{x:0,y:0},{x:1,y:1},{x:2,y:2},{x:3,y:3}];
 const result=createBlankMap({name:'共线',zone:collinear});
 assert.equal(result.ready,false);
 assert.ok(codes(result).includes('degenerate-zone'),reasonText(result));
 // 同一条零面积问题只报一次，validate() 的重复描述不再追加。
 assert.equal(codes(result).filter(code=>code!=='degenerate-zone').length,0,reasonText(result));
 assert.equal(result.reasons.length,1);
 assert.match(reasonText(result),/零面积/);
 // 顺时针 / 逆时针都合法：validate() 只看 |面积|。
 const clockwise=[{x:-1,y:-1},{x:-1,y:1},{x:1,y:1},{x:1,y:-1}];
 assert.equal(createBlankMap({name:'顺时针',zone:clockwise}).ready,true);
 const counterClosewise=[{x:-1,y:-1},{x:1,y:-1},{x:1,y:1},{x:-1,y:1}];
 assert.equal(createBlankMap({name:'逆时针',zone:counterClosewise}).ready,true);
 // 极小但非零面积仍然合法（门限与 validate() 一致，是 1e-8）。
 const tiny=[{x:0,y:0},{x:.001,y:0},{x:.001,y:.001},{x:0,y:.001}];
 assert.equal(createBlankMap({name:'极小范围',zone:tiny}).ready,true);
});

// --- API：POST /api/maps/new ------------------------------------------------

const newMap=(a:Awaited<ReturnType<typeof createApp>>,payload:unknown)=>a.inject({method:'POST',url:'/api/maps/new',payload:payload as Record<string,unknown>});

test('API 新建空白地图：写入 v1、返回 created:true、立刻能在列表和详情里读到',async()=>fixture(async(a,s)=>{
 const res=await newMap(a,{name:'现场空白图'});
 assert.equal(res.statusCode,200,res.body);
 const body=res.json();
 assert.equal(body.created,true);
 assert.equal(body.version,1);
 assert.equal(body.map.routeMode,'map-only');
 assert.equal(body.map.source,'design');
 assert.equal(body.map.coordinateStatus,'draft');
 assert.deepEqual(body.map.tags,[]);
 assert.deepEqual(body.map.groups,[]);
 assert.deepEqual(body.map.rows,[]);
 assert.deepEqual(body.map.order,[]);
 assert.match(body.map.id,AUTO_ID);
 assert.equal(body.id,body.map.id);
 assert.equal(body.tagSizeMm,60);
 assert.deepEqual(body.validation.errors,[]);
 assert.equal(body.validation.warnings.length,2);
 // baseVersion 就是 0：库里只有 v1，没有 v0，也没有多出来的版本。
 assert.equal(versionCount(s,body.map.id),1);
 assert.equal(s.get(body.map.id)?.version,1);
 // 列表与详情都能读到同一张图，且带上验收状态（未验收）。
 const list=(await a.inject('/api/maps')).json();
 assert.ok(list.some((item:any)=>item.id===body.map.id&&item.version===1));
 const detail=(await a.inject('/api/maps/'+body.map.id)).json();
 assert.deepEqual(detail.map,body.map);
 assert.equal(detail.version,1);
 assert.equal(detail.acceptance.accepted,false);
 assert.equal((await a.inject('/api/maps/'+body.map.id+'/versions')).json().length,1);
}));

test('API 新建空白地图：自定义 zone/vehicle/tagSizeMm/notes 写进库，且 strict 拒绝未知字段',async()=>fixture(async(a)=>{
 const zone=[{x:-4,y:-3},{x:6,y:-3},{x:6,y:5},{x:-4,y:5}];
 const res=await newMap(a,{name:'自定义空白图',id:'design-field-01',zone,vehicle:{width:.55,length:1.2,margin:.09},tagSizeMm:100,notes:'自定义说明'});
 assert.equal(res.statusCode,200,res.body);
 const body=res.json();
 assert.equal(body.map.id,'design-field-01');
 assert.deepEqual(body.map.zone,zone);
 assert.deepEqual(body.map.vehicle,{width:.55,length:1.2,margin:.09});
 assert.equal(body.map.notes,'自定义说明');
 assert.equal(body.tagSizeMm,100);
 // strict：未知字段不能静默忽略。
 for(const payload of [{name:'x',tags:[]},{name:'x',bogus:1},{name:'x',vehicle:{width:.4,colour:'red'}},{name:'x',zone:[{x:0,y:0,label:'a'},{x:1,y:0},{x:1,y:1},{x:0,y:1}]},{bogus:true}]){
  assert.equal((await newMap(a,payload)).statusCode,400,JSON.stringify(payload));
 }
}));

test('API 新建空白地图：非法参数返回 400 且带中文原因，绝不写库',async()=>fixture(async(a,s)=>{
 const cases:[unknown,RegExp][]=[
  [{name:''},/名称不能为空/],
  [{name:'地'.repeat(101)},/最多 100 个字符/],
  [{name:'x',zone:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]},/4 个点/],
  [{name:'x',zone:[{x:0,y:0},{x:0,y:0},{x:0,y:0},{x:0,y:0}]},/零面积/],  [{name:'x',id:'bad id'},/编号/],
  [{name:'x',vehicle:{width:9}},/车辆宽度/],
  [{name:'x',tagSizeMm:1},/20–180 mm/],
 ];
 for(const [payload,pattern] of cases){
  const res=await newMap(a,payload);
  assert.equal(res.statusCode,400,JSON.stringify(payload)+' → '+res.body);
  assert.match(res.json().error,pattern);
 }
 assert.equal(versionCount(s,'design-nothing'),0);
 assert.deepEqual((await a.inject('/api/maps')).json(),[],'非法请求不得留下任何地图');
}));

test('API 新建空白地图：同 id 已存在返回 409，已有地图一个字节都不动',async()=>fixture(async(a,s)=>{
 const first=await newMap(a,{name:'第一张',id:'design-dup'});
 assert.equal(first.statusCode,200,first.body);
 const before=s.get('design-dup')!;
 const second=await newMap(a,{name:'第二张（撞号）',id:'design-dup',zone:[{x:-1,y:-1},{x:1,y:-1},{x:1,y:1},{x:-1,y:1}]});
 assert.equal(second.statusCode,409,second.body);
 assert.match(second.json().error,/已存在/);
 // 版本数、内容、名称都没被覆盖。
 assert.equal(versionCount(s,'design-dup'),1);
 assert.deepEqual(s.get('design-dup')!.map,before.map);
 assert.equal(s.get('design-dup')!.version,1);
 assert.equal(s.get('design-dup')!.map.name,'第一张');
 // 自动编号之间也不会互相撞。
 const auto=await Promise.all([newMap(a,{name:'a'}),newMap(a,{name:'b'}),newMap(a,{name:'c'})]);
 assert.deepEqual(auto.map(res=>res.statusCode),[200,200,200]);
 assert.equal(new Set(auto.map(res=>res.json().map.id)).size,3);
}));

// --- 端到端：空图 → 铺第一个码 → 读回 ---------------------------------------

test('端到端：新建空白图后立刻铺第一个码，读回 tags.length === 1',async()=>fixture(async(a,s)=>{
 const created=(await newMap(a,{name:'先建图再铺码'})).json();
 const id:string=created.map.id;
 assert.equal(created.version,1);
 // 第一个码：baseVersion 必须是新建后拿到的 1（不是 0）。
 const add=await a.inject({method:'POST',url:'/api/maps/'+id+'/tags/create',payload:{baseVersion:1,x:.5,y:.5,angleDeg:0,sizeM:.1}});
 assert.equal(add.statusCode,200,add.body);
 const added=add.json();
 assert.equal(added.created,1);
 assert.equal(added.map.tags.length,1);
 assert.equal(added.map.tags[0].id,0,'第一个码必须自动分配 Q0');
 assert.equal(added.map.tags[0].x,.5);
 assert.equal(added.map.tags[0].y,.5);
 assert.equal(added.map.tags[0].size,.1);
 // 默认原地覆盖：版本号不变，仍是 v1。
 assert.equal(added.version,1);
 assert.equal(versionCount(s,id),1);
 // 读回：详情、列表都是 1 个码，空图提示已消失。
 // 注意 GET /api/maps/:id 只回 {map,version,acceptance}，校验结果必须在测试里自己跑一遍。
 const detail=(await a.inject('/api/maps/'+id)).json();
 assert.equal(detail.map.tags.length,1);
 assert.equal(detail.map.tags[0].id,0);
 assert.deepEqual(detail.map.rows,[]);
 assert.deepEqual(detail.map.order,[]);
 assert.equal(detail.map.routeMode,'map-only');
 const recheck=validate(detail.map);
 assert.deepEqual(recheck.errors,[]);
 assert.equal(recheck.warnings.includes('地图尚无二维码点位：请先在地图上新建二维码后再编辑路径'),false);
 assert.ok((await a.inject('/api/maps')).json().some((item:any)=>item.id===id));
 // 再铺第二个码：编号递增、点位累加。
 const second=await a.inject({method:'POST',url:'/api/maps/'+id+'/tags/create',payload:{baseVersion:1,x:2,y:.5}});
 assert.equal(second.statusCode,200,second.body);
 assert.deepEqual(second.json().map.tags.map((tag:any)=>tag.id),[0,1]);
 assert.equal((await a.inject('/api/maps/'+id)).json().map.tags.length,2);
 // 用错 baseVersion（0，也就是新建之前的语义）必须 409，不能悄悄改动。
 const stale=await a.inject({method:'POST',url:'/api/maps/'+id+'/tags/create',payload:{baseVersion:0,x:5,y:5}});
 assert.equal(stale.statusCode,409,stale.body);
 assert.equal((await a.inject('/api/maps/'+id)).json().map.tags.length,2);
}));

test('端到端：空白图上指定坐标/边长的第一个码仍受 validate() 的物理压盖约束',async()=>fixture(async(a)=>{
 const id:string=(await newMap(a,{name:'压盖检查'})).json().map.id;
 assert.equal((await a.inject({method:'POST',url:'/api/maps/'+id+'/tags/create',payload:{baseVersion:1,x:0,y:0,sizeM:.1}})).statusCode,200);
 // 中心距 1 cm，远小于 10 cm 边长的一半 → 必须被拒。
 const overlap=await a.inject({method:'POST',url:'/api/maps/'+id+'/tags/create',payload:{baseVersion:1,x:.01,y:0,sizeM:.1}});
 assert.equal(overlap.statusCode,400,overlap.body);
 assert.match(overlap.json().error,/压盖|间距/);
 assert.equal((await a.inject('/api/maps/'+id)).json().map.tags.length,1);
}));

// --- 导航门禁：新建的空白图不能启动导航 -------------------------------------

test('新建的空白地图不能启动导航：/api/navigation/start 对 map-only 返回 423',async()=>fixture(async(a,s)=>{
 const created=(await newMap(a,{name:'禁止导航的空图'})).json();
 const mapId:string=created.map.id;
 assert.equal(created.map.routeMode,'map-only');
 // 用已有 task：直接插一条绑定这张空图的任务，绕过 /api/tasks 的"必须引用已存在的行"限制。
 // （真实 UI 也不会给空图建任务，这里只为证明导航入口本身会拦住 map-only。）
 s.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run('blank-task',JSON.stringify({
  id:'blank-task',name:'空图任务',mapId,mapVersion:1,rowOrder:['row-1'],
  forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true,
 }),new Date().toISOString());
 assert.equal((await a.inject('/api/tasks')).json().length,1);
 const start=await a.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'blank-task'}});
 assert.equal(start.statusCode,423,start.body);
 assert.match(start.json().error,/请先手动编辑并保存导航路径/);
 // 铺了码也还是 423：map-only 地图必须先编辑路径，与有没有点位无关。
 assert.equal((await a.inject({method:'POST',url:'/api/maps/'+mapId+'/tags/create',payload:{baseVersion:1,x:0,y:0}})).statusCode,200);
 const again=await a.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'blank-task'}});
 assert.equal(again.statusCode,423,again.body);
 // 依然没有路线、没有被验收，导航侧状态没被悄悄改动。
 assert.deepEqual((await a.inject('/api/routes')).json(),[]);
 assert.equal((await a.inject('/api/maps/'+mapId)).json().acceptance.accepted,false);
}));

// --- 与既有路径的边界 -------------------------------------------------------

test('POST /api/maps 的旧语义不受影响：仍要求调用方自带完整 map + baseVersion',async()=>fixture(async(a)=>{
 const map=createBlankMap({name:'旧路径保存',id:'design-legacy'}).map!;
 // 用 /api/maps 保存一张新图：baseVersion 0 → v1，与 /api/maps/new 结果等价但必须自带全部字段。
 const res=await a.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});
 assert.equal(res.statusCode,200,res.body);
 assert.equal(res.json().version,1);
 // 再存一次必须 409（旧语义照旧），不会因为新增端点而放宽。
 assert.equal((await a.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}})).statusCode,409);
 // /api/maps/new 撞上这张图也必须是 409。
 assert.equal((await newMap(a,{name:'撞旧路径的图',id:'design-legacy'})).statusCode,409);
}));

test('空图上的 zone 参与坐标校验：铺到显示范围外的点位照样能存，但会被提示',async()=>fixture(async(a)=>{
 const id:string=(await newMap(a,{name:'小范围空图',zone:[{x:-1,y:-1},{x:1,y:-1},{x:1,y:1},{x:-1,y:1}]})).json().map.id;
 const res=await a.inject({method:'POST',url:'/api/maps/'+id+'/tags/create',payload:{baseVersion:1,x:8,y:8}});
 assert.equal(res.statusCode,200,res.body);
 assert.ok(res.json().notes.some((note:any)=>note.code==='outside-zone'),JSON.stringify(res.json().notes));
 // validate() 里没有点位重叠 / 零面积之类的 error（写库后的地图再验一遍）。
 assert.deepEqual(validate(res.json().map).errors,[]);
 const detail=(await a.inject('/api/maps/'+id)).json();
 assert.ok(distance(detail.map.tags[0],{x:0,y:0})>1);
 // 范围确实是自定义的那个。
 assert.deepEqual(detail.map.zone,[{x:-1,y:-1},{x:1,y:-1},{x:1,y:1},{x:-1,y:1}]);
}));

test('blankMapDefaults 与 model/tag-creation 的默认口径一致',()=>{
 assert.deepEqual(blankMapDefaults.vehicle,{width:.4,length:.8,margin:.05});
 assert.equal(blankMapDefaults.tagSizeMm,60);
 assert.equal(blankMapDefaults.minTagSizeMm,20);
 assert.equal(blankMapDefaults.maxTagSizeMm,180);
 assert.deepEqual(blankZone(),[{x:-10,y:-10},{x:10,y:-10},{x:10,y:10},{x:-10,y:10}]);
 assert.deepEqual(blankZone(3),[{x:-3,y:-3},{x:3,y:-3},{x:3,y:3},{x:-3,y:3}]);
 // 缺省的 ±10 m 范围必须落在 pointSchema 的 ±10000 m 之内。
 for(const point of blankZone())assert.ok(Math.abs(point.x)<=10000&&Math.abs(point.y)<=10000);
 // 车辆包络必须落在 mapSchema 的 vehicle 范围内。
 const map=createBlankMap({name:'默认值自检'}).map as FieldMap;
 assert.ok(map.vehicle.width>=.1&&map.vehicle.width<=1);
 assert.ok(map.vehicle.length>=.2&&map.vehicle.length<=3);
 assert.ok(map.vehicle.margin>=.01&&map.vehicle.margin<=.1);
});
