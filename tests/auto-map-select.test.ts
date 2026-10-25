/**
 * 「切图即生效」回归：界面上不再有"启用此地图 / 确认启用地图"按钮。
 *
 * 现场契约（2026-10-22 之后的自用版）：
 *   1) 用户在地图下拉里选中哪张地图，该 mapId + 当前 mapVersion 立刻成为
 *      "当前导航地图 / 定位目标"，并自动走已有切图重锚链路；
 *   2) 前端不再要求点击任何"启用/确认"按钮，也不再因 coordinateStatus 为 draft
 *      而拒绝切图或拒绝定位跟随；
 *   3) 但"开始导航"的真实安全门一条都不能少：定位作用域（mapId+mapVersion+已锚定）、
 *      相机/IMU/底盘条件、地图质量、路径策略、地图与路径版本一致性；
 *   4) 多张地图共用同一批物理二维码时，A 的位姿绝不能当成 B 的（同 tag 不串图）；
 *   5) 路径只能加载当前 mapId+mapVersion，旧图路径被忽略；旧接口保留兼容。
 *
 * 本文件只读源码 + 运行 App.vue 里的真实函数 + Fastify inject 临时 SQLite，
 * 不启动导航、不发 cmd_vel、不碰真实数据库。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import vm from 'node:vm';
import {createApp,localizationScopeBlock,localizationScopePhase} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {defaults,generate,exitPoint,type FieldMap} from '../web/shared/model';

const appSource=readFileSync(new URL('../web/frontend/src/App.vue',import.meta.url),'utf8');
const script=appSource.split('<script setup lang="ts">')[1]!.split('</script>')[0]!;
const template=appSource.split('</script>')[1]!.split('<style')[0]!;
// 注释里会解释"为什么不再有某按钮"，静态扫描只针对可执行代码与模板。
const scriptCode=script.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const templateCode=template.replace(/<!--[\s\S]*?-->/g,'');

/** 取出 App.vue 中真实的函数声明并转成可执行 JS。 */
function extractFunction(name:string){
 const ast=ts.createSourceFile('App.ts',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const node=ast.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name);
 assert.ok(node,`App.vue 必须存在函数 ${name}()`);
 return ts.transpileModule(node!.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
}

// ------------------------------------------------- 切图即生效（真实前端函数）

test('切到另一张地图：立刻把该 mapId+mapVersion 设为定位目标，不再依赖任务/验收',async()=>{
 const calls:{url:string;body?:unknown}[]=[];
 const state:any={
  api:async(url:string,body?:unknown)=>{calls.push({url,body});return {phase:'switching'};},
  field:{value:{id:'office-b',name:'办公室B'}},
  version:{value:5},
  robot:{value:{connected:true,running:false}},
  localizationScope:{value:{phase:'idle',mapId:'',version:0,message:''}},
  waitScopeAnchored:async(mapId:string,mapVersion:number)=>{
   state.localizationScope.value={phase:'anchored',mapId,version:mapVersion,message:'定位已锚定到当前地图 v'+mapVersion};
  }
 };
 const context=vm.createContext(state);
 vm.runInContext(`let scopeSeq=0;\n${extractFunction('syncLocalizationScope')}\nglobalThis.__sync=syncLocalizationScope;`,context);
 await vm.runInContext('__sync()',context);
 assert.deepEqual(calls.map(call=>call.url),['/localization/map'],'选图必须真的调用切图接口');
 // 注意：body 由 vm 沙箱内创建，原型来自另一个 realm，只能逐字段比较
 const body:any=calls[0]!.body;
 assert.equal(body.mapId,'office-b','必须使用当前所选地图的 mapId');
 assert.equal(body.version,5,'必须使用当前所选地图的 mapVersion');
 assert.equal(state.localizationScope.value.mapId,'office-b','切图后作用域必须指向新地图');
 assert.equal(state.localizationScope.value.version,5,'切图后作用域必须指向当前版本');
 assert.equal(state.localizationScope.value.phase,'anchored','锚定后状态必须前进到 anchored');
 // 切图链路里不许出现人工确认/验收状态
 const fn=script.slice(script.indexOf('async function syncLocalizationScope'),script.indexOf('watch([()=>field.value?.id'));
 for(const forbidden of ['mapApproval','coordinateStatus','selectedTask','userConfirmedMap']){
  assert.equal(fn.includes(forbidden),false,`切图不得依赖 ${forbidden}`);
 }
});

test('切图由"地图/版本/连接状态"变化自动触发，没有任何手动启用动作',()=>{
 assert.ok(appSource.includes('watch([()=>field.value?.id,()=>version.value,()=>robot.value.connected]'),'地图切换必须自动触发定位跟随');
 assert.ok(appSource.includes('void syncLocalizationScope()'),'watcher 必须真的执行切图');
 assert.ok(appSource.includes('waitScopeAnchored'),'切图后必须等待当前地图重新锚定');
 assert.equal(appSource.includes('function confirmCoordinates'),false,'不应再有手动确认坐标函数');
 assert.equal(appSource.includes('async function confirmCoordinates'),false,'不应再有手动确认坐标函数');
});

// ------------------------------------------------- 界面：当前地图，无启用按钮

test('界面不再有「启用此地图」按钮，只显示「当前地图」',()=>{
 for(const forbidden of ['enable-map','启用此地图','确认启用地图','confirm-coordinates','confirm-map']){
  assert.equal(templateCode.includes(forbidden),false,`模板不应再出现「${forbidden}」`);
 }
 assert.equal(scriptCode.includes('confirmCoordinates'),false,'脚本不应再有手动确认坐标');
 assert.equal(scriptCode.includes("api('/maps/confirm'"),false,'前端不应再调用 /maps/confirm');
 assert.equal(scriptCode.includes("api('/maps/accept'"),false,'前端不应再提交手工实测坐标');
 assert.match(templateCode,/data-testid="coordinate-status"/,'必须有简洁坐标状态区');
 assert.match(templateCode,/data-testid="current-map"/,'必须显示「当前地图」');
 assert.match(templateCode,/当前地图 · \{\{field\.name\}\} v\{\{version\}\}/,'当前地图必须绑定所选地图名与版本');
 assert.match(templateCode,/data-testid="coordinate-source"/,'坐标来源仍需可见（扫描/已验收）');
});

// ------------------------------------------------- A/B 共用同一批二维码不串图

test('A/B 两张图共用同一批二维码：定位还在 A 时不得当成 B 已就绪',()=>{
 const poseOnA={mapId:'office-a',mapVersion:4,poseAvailable:true};
 assert.equal(localizationScopePhase(true,'office-b',5,poseOnA),'switching','定位仍在 A 时必须报切换中');
 const blockA=String(localizationScopeBlock('office-b',5,poseOnA));
 assert.match(blockA,/正在切换/,'定位仍在 A 时导航必须被拦');
 assert.match(blockA,/office-a v4/,'必须点明实际定位在哪张图，便于现场判断');
 // 同一张图但版本不同，也算串图（不能拿 v4 的位姿跑 v5 的任务）
 assert.equal(localizationScopePhase(true,'office-b',5,{mapId:'office-b',mapVersion:4,poseAvailable:true}),'switching');
 // 地图和版本都对了但还没重新锚定，同样不许放行
 assert.equal(localizationScopePhase(true,'office-b',5,{mapId:'office-b',mapVersion:5,poseAvailable:false}),'waiting-anchor');
 assert.match(String(localizationScopeBlock('office-b',5,{mapId:'office-b',mapVersion:5,poseAvailable:false})),/等待二维码重新锚定/);
 // 只有 B 自己重新锚定后才报 anchored / 放行
 const poseOnB={mapId:'office-b',mapVersion:5,poseAvailable:true};
 assert.equal(localizationScopePhase(true,'office-b',5,poseOnB),'anchored');
 assert.equal(localizationScopeBlock('office-b',5,poseOnB),null);
});

// ------------------------------------------------- 路径只加载当前地图+版本

test('路径只能加载当前 mapId+mapVersion，旧图/旧版本路径被忽略（真实前端函数）',()=>{
 const make=()=>{
  const state:any={
   routes:{value:[
    {routeId:'route-a',mapId:'office-a',mapVersion:4,name:'A 的旧路径'},
    {routeId:'route-b',mapId:'office-b',mapVersion:5,name:'B 的当前路径'}
   ]},
   field:{value:{id:'office-b',name:'办公室B'}},
   version:{value:5},
   message:{value:''},
   selectedRouteId:{value:'route-a'},
   selectedTask:{value:'task-route-a'},
   routeNameDraft:{value:'A 的旧路径'},
   taskForRoute:(route:any)=>({id:'task-'+route.routeId}),
   loadTask:()=>{}
  };
  const context=vm.createContext(state);
  vm.runInContext(`${extractFunction('chooseRoute')}\nglobalThis.__choose=chooseRoute;`,context);
  return {state,context};
 };
 // 选中旧图路径 → 必须被清空并给出原因，绝不能带着 A 的坐标跑 B
 const stale=make();
 vm.runInContext('__choose()',stale.context);
 assert.equal(stale.state.selectedRouteId.value,'','旧图路径必须被忽略');
 assert.equal(stale.state.selectedTask.value,'','旧图任务必须被清空');
 assert.equal(stale.state.routeNameDraft.value,'','旧图路径名必须被清空');
 assert.match(stale.state.message.value,/不属于当前地图/,'必须明确提示路径不属于当前地图');
 // 选中当前图的路径 → 正常绑定任务
 const fresh=make();
 fresh.state.selectedRouteId.value='route-b';
 vm.runInContext('__choose()',fresh.context);
 assert.equal(fresh.state.selectedTask.value,'task-route-b','当前图路径必须正常绑定任务');
 assert.equal(fresh.state.routeNameDraft.value,'B 的当前路径');
});

// ------------------------------------------------- 安全门不退化

test('pose/camera/IMU 未就绪时仍然不能开始导航（前端门禁逐条保留）',()=>{
 const gate=scriptCode.match(/const canNavigate=computed\(\(\)=>\{[\s\S]*?\}\);/)?.[0]??'';
 assert.ok(gate,'canNavigate 必须存在');
 for(const condition of ['robot.value.connected','robot.value.localization?.mapId===field.value?.id','robot.value.localization?.mapVersion===version.value','robot.value.localization?.poseAvailable===true','robot.value.conditions.length>0','robot.value.conditions.every','!robot.value.running','task.mapId===field.value?.id','task.mapVersion===version.value']){
  assert.ok(gate.includes(condition),`canNavigate 缺少安全条件 ${condition}`);
 }
 // 人工确认类条件必须已移除，否则又回到"必须点按钮"
 for(const removed of ['mapApproval','coordinateStatus','userConfirmedMap']){
  assert.equal(gate.includes(removed),false,`canNavigate 不应再依赖人工确认 ${removed}`);
 }
});

test('后端仍拦 draft 地图：没有人工启用也照样 423，理由不再是"坐标未启用"',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qr-auto-map-'));
 const database=join(dir,'navigation.db');
 const app=await createApp(database),store=new Store(database);
 try{
  const map:FieldMap={...generate({...defaults,count:1,length:2,tagSpacing:1,angle:0}),id:'office-draft',name:'草稿图',source:'survey',captureQuality:'draft'};
  const saved=await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});
  assert.equal(saved.statusCode,200,saved.body);
  const points=[exitPoint(map.rows[0]!),...map.rows[0]!.points];
  const designed=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,routeName:'草稿路径',points,bodyYawDeg:0}});
  assert.equal(designed.statusCode,200,designed.body);
  const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:designed.json().task.id}});
  assert.equal(start.statusCode,423,start.body);
  assert.match(start.json().error,/草稿/,'draft 地图必须以地图质量为由拦截');
  assert.equal(start.json().error.includes('尚未启用'),false,'不得再以"坐标未启用"为由拦截');
  assert.equal(start.json().error.includes('坐标'),false,'拦截理由不应再指向坐标人工确认');
  // 切图接口对 draft 地图不设坐标门槛：本用例无底盘遥测，只允许被"小车必须静止"拦下，
  // 绝不能出现"坐标未启用/确认该地图的扫描坐标"这类要求人工启用的拒绝。
  const switched=await app.inject({method:'POST',url:'/api/localization/map',payload:{mapId:map.id,version:1}});
  assert.doesNotMatch(switched.body,/确认该地图的扫描坐标/,'切图不得因 draft 被拒');
  assert.doesNotMatch(switched.body,/坐标未启用/,'切图不得因坐标未启用被拒');
  assert.match(switched.body,/请在小车停止且底盘反馈在线时切换定位地图/,'切图仍要求小车静止且底盘在线');
 }finally{store.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('旧路径兼容：路径列表按 mapId 隔离，跨图复用 routeId 仍被拒',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qr-auto-map-routes-'));
 const database=join(dir,'navigation.db');
 const app=await createApp(database),store=new Store(database);
 try{
  const base=generate({...defaults,count:1,length:2,tagSpacing:1,angle:0});
  const mapA:FieldMap={...base,id:'office-a',name:'办公室A',source:'survey',captureQuality:'draft'};
  const mapB:FieldMap={...base,id:'office-b',name:'办公室B',source:'survey',captureQuality:'draft'};
  assert.equal((await app.inject({method:'POST',url:'/api/maps',payload:{map:mapA,baseVersion:0}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/maps',payload:{map:mapB,baseVersion:0}})).statusCode,200);
  const points=[exitPoint(mapA.rows[0]!),...mapA.rows[0]!.points];
  const designed=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:mapA.id,baseVersion:1,routeName:'办公室A新路径',points,bodyYawDeg:0}});
  assert.equal(designed.statusCode,200,designed.body);
  const routeId=designed.json().route.routeId;
  // A 的路径在 B 下不可见 —— 这正是前端"旧图路径被忽略"的服务端依据
  assert.deepEqual((await app.inject('/api/routes?mapId='+mapB.id)).json(),[]);
  const listA=(await app.inject('/api/routes?mapId='+mapA.id)).json();
  assert.equal(listA.length,1);
  assert.equal(listA[0].mapId,mapA.id,'路径必须带自己的 mapId');
  assert.equal(listA[0].mapVersion,1,'路径必须带自己绑定的版本');
  assert.deepEqual((await app.inject('/api/routes/'+routeId)).json().route.points,designed.json().route.points,'旧路径坐标不得被改写');
  // 跨图复用 routeId 必须 409
  const cross=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:mapB.id,baseVersion:1,routeId,routeName:'跨图覆盖',routeUpdated:designed.json().route.updated,points,bodyYawDeg:0}});
  assert.equal(cross.statusCode,409,'跨 mapId 复用 routeId 必须被拒');
 }finally{store.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});
