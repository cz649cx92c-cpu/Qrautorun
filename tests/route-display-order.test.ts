import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import ts from 'typescript';
import vm from 'node:vm';
import {createApp} from '../web/backend/src/server';
import {defaults,generate,exitPoint,orderedTagsById} from '../web/shared/model';
import {orderMotionSegmentsByChain} from '../web/shared/route';

// 根因回归：路径区间与定位点的“显示身份”必须来自稳定链序（fromId→toId）与稳定 tagId，
// 而不是持久化数组下标或存储顺序。数组下标一旦与链序不一致（旧快照/迁移/手工写入），
// 画布上的路径序号就会与真实执行顺序错乱；未选路径时定位点编号只是 tagId，不是路径顺序。

test('路径区间显示顺序按 fromId→toId 稳定链序推导，而不是数组下标',()=>{
 const shuffled=[
  {id:'design-interval-2',fromId:193,toId:177},
  {id:'design-interval-3',fromId:177,toId:161},
  {id:'design-interval-1',fromId:241,toId:193},
 ];
 const ordered=orderMotionSegmentsByChain(shuffled);
 assert.deepEqual(ordered.map(s=>s.id),['design-interval-1','design-interval-2','design-interval-3']);
 assert.deepEqual(ordered.map(s=>s.fromId+'>'+s.toId),['241>193','193>177','177>161']);
 // 已是链序（当前生产最新路径）：输出与输入完全一致，不重排。
 const inOrder=[shuffled[2]!,shuffled[0]!,shuffled[1]!];
 assert.deepEqual(orderMotionSegmentsByChain(inOrder),inOrder);
 // 断链：不丢区间，剩余按原顺序保留（尽力而为，绝不静默删除）。
 const broken=[{id:'a',fromId:1,toId:2},{id:'b',fromId:9,toId:8},{id:'c',fromId:2,toId:3}];
 assert.deepEqual(orderMotionSegmentsByChain(broken).map(s=>s.id),['a','c','b']);
 // 空/单区间：原样返回且不改原数组。
 const single=[{id:'only',fromId:1,toId:2}];
 assert.deepEqual(orderMotionSegmentsByChain(single),single);
 assert.deepEqual(orderMotionSegmentsByChain([]),[]);
});

test('定位点显示顺序按稳定 tagId，不依赖存储数组顺序，且 tagId 顺序不代表路径顺序',()=>{
 const tags=[{id:257},{id:113},{id:129},{id:145}];
 assert.deepEqual(orderedTagsById(tags).map(t=>t.id),[113,129,145,257]);
 assert.deepEqual(tags.map(t=>t.id),[257,113,129,145],'不得原地修改输入数组');
});

test('MapCanvas 用稳定身份渲染路径区间与定位点，不用数组下标做身份',()=>{
 const src=readFileSync(new URL('../web/frontend/src/components/MapCanvas.vue',import.meta.url),'utf8');
 assert.match(src,/orderMotionSegmentsByChain\(props\.map\.motionSegments\?\?\[\]\)/,'区间必须先按 fromId→toId 链序再渲染/编号');
 assert.match(src,/for\(const t of orderedTagsById\(props\.map\.tags\)\)/,'定位点必须按稳定 tagId 渲染');
 assert.match(src,/name:`segment-\$\{segment\.id\}`/,'区间节点必须用稳定 segment.id 命名');
 assert.match(src,/name:`segment-label-\$\{segment\.id\}`/,'区间序号标签必须用稳定 segment.id 命名');
});

test('canvasMap：未选路径不显示任何路径连线/序号；同图 A/B 路径严格隔离',()=>{
 const source=readFileSync(new URL('../web/frontend/src/App.vue',import.meta.url),'utf8').split('<script setup lang="ts">')[1]!.split('</script>')[0]!;
 const ast=ts.createSourceFile('App.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const wanted=new Set(['canvasMap']);
 const statements=ast.statements.filter(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>wanted.has(d.name.getText(ast))));
 assert.equal(statements.length,1);
 const code=ts.transpileModule(statements.map(s=>s.getText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const state:any={orthogonalPreviewMap:{value:null},page:{value:'navigate'},editingRoute:{value:false},selectedRouteId:{value:''},
  map:{value:{id:'m1',rows:[{id:'old-row',points:[{x:0,y:0},{x:1,y:0}],start:{x:0,y:0},width:.6,exitDistance:.8,name:'旧行'}],motionSegments:[{id:'legacy-seg',fromId:1,toId:2}],tags:[{id:5}]}},
  routes:{value:[{routeId:'route-a',mapId:'m1',motionSegments:[{id:'a1',fromId:1,toId:2}]},{routeId:'route-b',mapId:'m1',motionSegments:[{id:'b1',fromId:3,toId:4}]}]}};
 const context=vm.createContext({...state,computed:(fn:()=>unknown)=>({get value(){return fn()}})});
 vm.runInContext(code,context);
 const read=()=>JSON.parse(vm.runInContext('JSON.stringify(canvasMap.value)',context)??'null') as {rows:unknown[],motionSegments?:{id:string}[]};
 let view=read();
 assert.deepEqual(view.rows,[],'未选路径不得显示旧 rows 连线');
 assert.equal(view.motionSegments,undefined,'未选路径不得显示路径连线/序号');
 state.selectedRouteId.value='route-a';
 view=read();
 assert.deepEqual(view.motionSegments?.map(s=>s.id),['a1'],'只渲染所选路径 A');
 state.selectedRouteId.value='route-b';
 view=read();
 assert.deepEqual(view.motionSegments?.map(s=>s.id),['b1'],'切换到 B 后 A 的区间不得残留');
 state.selectedRouteId.value='';
 view=read();
 assert.equal(view.motionSegments,undefined,'取消选择后回到空状态');
});

test('路径 API：保存→GET→重开返回链序一致的区间；无路径地图返回空',async()=>{
 const folder=join(process.cwd(),'logs',`route-display-${process.pid}-${Date.now()}`);mkdirSync(folder,{recursive:true});const db=join(folder,'navigation.db');
 const app=await createApp(db);let first:any;
 try{
  const map=generate({...defaults,count:1,length:2,tagSpacing:1,angle:0});map.id='display-map';
  assert.equal((await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}})).statusCode,200);
  const points=[exitPoint(map.rows[0]!),...map.rows[0]!.points];
  const saved=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,routeId:'display-route',routeName:'显示顺序',points,bodyYawDeg:0}});
  assert.equal(saved.statusCode,200,saved.body);
  first=(await app.inject('/api/routes?mapId=display-map')).json();
  assert.equal(first.length,1);
  const segs=first[0]!.motionSegments;
  assert.ok(segs.length>=1);
  for(let i=1;i<segs.length;i++)assert.equal(segs[i-1].toId,segs[i].fromId,'区间必须按 fromId→toId 链序返回');
  assert.deepEqual(orderMotionSegmentsByChain(segs),segs,'GET 返回的数组本身即链序，链序函数不改变它');
  assert.deepEqual((await app.inject('/api/routes?mapId=no-such-map')).json(),[]);
 }finally{await app.close();}
 const reopened=await createApp(db);
 try{assert.deepEqual((await reopened.inject('/api/routes?mapId=display-map')).json(),first,'保存→GET→刷新→重载数据完全一致');}
 finally{await reopened.close();rmSync(folder,{recursive:true,force:true});}
});
