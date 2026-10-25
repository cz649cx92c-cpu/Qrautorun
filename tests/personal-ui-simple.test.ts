/**
 * 自用版（v8）UI 简化回归。
 *
 * 背景：QRautorun 是自用内部工具，不做商业化流程。UI 已去掉
 *   1) 实验员/用户姓名字段及必填校验；
 *   2) 地图名 / 任务名 / 路径名等需要用户手填的名称输入（改为自动生成）；
 *   3) 「确认扫描坐标」「用户确认坐标（无需实测）」等复杂人工确认按钮与大段说明；
 *   4) 顶部阶段流程图 / 作业概览 / 使用指南大块区域。
 *
 * 必须保留（不许退化）：
 *   - 地图、路径选择/新建、二维码点位、编辑路径、开始/暂停/停止、错误提示；
 *   - 后端 mapId/mapVersion/routeId 隔离；
 *   - 定位/导航安全门（draft 地图必须显式确认、map-only 必须先有路径）；
 *   - 旧数据兼容（旧路径仍可加载、旧库无 routes 表仍可用）。
 *
 * 本文件只读源码 + Fastify inject 临时 SQLite，不启动导航、不发 cmd_vel。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import {createApp} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {compileDesignedRoute} from '../web/backend/src/route-design';
import {defaults,generate,exitPoint,type FieldMap} from '../web/shared/model';

const appSource=readFileSync(new URL('../web/frontend/src/App.vue',import.meta.url),'utf8');
const script=appSource.split('<script setup lang="ts">')[1]!.split('</script>')[0]!;
const template=appSource.split('</script>')[1]!.split('<style')[0]!;
// 注释里会说明“不再出现某按钮”，静态扫描只针对可执行代码与模板。
const scriptCode=script.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const templateCode=template.replace(/<!--[\s\S]*?-->/g,'');

// ---------------------------------------------------------------- 源码层回归

test('UI 无姓名字段、无必填校验、无手填名称输入',()=>{
 for(const forbidden of ['姓名','实验员','测量人员','操作员','请填写确认人姓名','请填写实际测量坐标']){
  assert.equal(scriptCode.includes(forbidden),false,`App.vue 脚本不应再出现「${forbidden}」`);
  assert.equal(templateCode.includes(forbidden),false,`App.vue 模板不应再出现「${forbidden}」`);
 }
 // 扫描名 / 路径名不再有输入框
 assert.equal(templateCode.includes('扫描名称'),false,'扫描名称输入框应已移除');
 assert.equal(templateCode.includes('路径名称<input'),false,'路径名称输入框应已移除');
 assert.equal(templateCode.includes('data-testid="route-name-input"'),false,'不应再有 route-name-input');
 assert.equal(/<input[^>]*v-model="name"/.test(templateCode),false,'不应再有绑定扫描名称的输入框');
 assert.equal(/<input[^>]*v-model="routeNameDraft"/.test(templateCode),false,'不应再有绑定路径名称的输入框');
 // 自动命名能力必须存在
 assert.match(scriptCode,/function autoSurveyName\(\)/, '扫描名应自动生成');
 assert.match(scriptCode,/const surveyName=name\.value\.trim\(\)\|\|autoSurveyName\(\)/,'开始扫描时自动取名');
 assert.match(scriptCode,/routeNameDraft\.value=uniqueRouteName\(field\.value\.name\+'新路径'\)/,'新建路径应自动命名并去重');
 assert.match(templateCode,/data-testid="scan-auto-name"/,'应显示自动生成的记录名');
 assert.match(templateCode,/data-testid="route-name-field"/,'路径名应仍可见（只读自动名）');
});

test('UI 无商业确认按钮、无阶段流程图/作业概览/使用指南大块',()=>{
 for(const forbidden of ['确认扫描坐标','用户确认坐标','实测X','实测Y','组中心ID','作业概览','使用指南','当前阶段 · 0','next-step-card','context-help','overview-stats','stat-card']){
  assert.equal(templateCode.includes(forbidden),false,`模板不应再出现「${forbidden}」`);
 }
 // 使用指南页面/入口彻底下线
 assert.equal(scriptCode.includes("'guide'"),false,'页面枚举不应再有 guide');
 assert.equal(templateCode.includes("page='guide'"),false,'不应再有使用指南入口');
 assert.equal(appSource.includes('UserGuide'),false,'App.vue 不应再引用 UserGuide 组件');
 // 坐标改为简洁状态：只显示「当前地图」，不再有任何"启用此地图"按钮
 assert.match(templateCode,/data-testid="coordinate-status"/,'应有简洁坐标状态');
 for(const gone of ['data-testid="enable-map"','启用此地图','确认启用地图','confirm-coordinates','confirm-map']){
  assert.equal(templateCode.includes(gone),false,`模板不应再出现「${gone}」`);
 }
 assert.match(templateCode,/data-testid="current-map"/,'必须显示「当前地图」');
 assert.match(templateCode,/当前地图 · \{\{field\.name\}\} v\{\{version\}\}/,'当前地图必须跟随所选地图与版本');
 assert.match(templateCode,/data-testid="coordinate-source"/,'坐标来源应自动读取');
 // 前端不再要求手动启用；旧接口保留兼容，但前端不再调用
 assert.equal(scriptCode.includes("api('/maps/confirm'"),false,'前端不应再调用 /maps/confirm');
 assert.equal(scriptCode.includes('confirmCoordinates'),false,'不应再有手动确认坐标函数');
 assert.equal(scriptCode.includes("api('/maps/accept'"),false,'前端不再提交手工实测坐标');
});

test('核心操作入口与安全门在简化后仍然存在',()=>{
 // 保留：地图选择、路径选择/新建、编辑路径、二维码、开始/暂停/停止、错误提示
 for(const keep of ['map-select','route-select','new-route','edit-route','view-tag-reprint','delete-route','route-manage-list']){
  assert.ok(templateCode.includes(`data-testid="${keep}"`),`缺少核心入口 ${keep}`);
 }
 for(const text of ['开始导航','暂停','停止','新建路径','编辑路径','当前地图']){
  assert.ok(templateCode.includes(text),`缺少操作文案「${text}」`);
 }
 assert.match(templateCode,/class="scan-alert" role="alert"/,'错误提示必须保留');
 assert.match(templateCode,/data-testid="navigation-block-reason"/,'导航阻断原因必须保留');
 // canNavigate 安全门不许被简化掉
 const gate=scriptCode.match(/const canNavigate=computed\(\(\)=>\{[\s\S]*?\}\);/)?.[0]??'';
 assert.ok(gate,'canNavigate 必须存在');
 // 自用版不再要求人工"启用地图"，但真实安全门一条都不许少
 for(const condition of ["robot.value.connected","robot.value.localization?.mapId===field.value?.id","robot.value.localization?.mapVersion===version.value","robot.value.localization?.poseAvailable===true","robot.value.conditions.length>0","robot.value.conditions.every","!robot.value.running","task.mapId===field.value?.id","task.mapVersion===version.value"]){
  assert.ok(gate.includes(condition),`canNavigate 缺少安全条件 ${condition}`);
 }
 // 人工确认类条件必须已从门禁移除，否则又退回"必须点按钮才能走"
 for(const removed of ["mapApproval","coordinateStatus","userConfirmedMap"]){
  assert.equal(gate.includes(removed),false,`canNavigate 不应再依赖人工确认 ${removed}`);
 }
 // mapId / mapVersion / routeId 隔离不许删除
 assert.match(scriptCode,/task\.mapId===field\.value\?\.id/,'导航必须校验 task.mapId');
 assert.match(scriptCode,/task\.mapVersion===version\.value/,'导航必须校验 task.mapVersion');
 assert.match(scriptCode,/routes\.value\.filter\(route=>!selectedMapId\.value\|\|route\.mapId===selectedMapId\.value\)/,'路径必须按 mapId 隔离');
});

test('新建路径自动命名且同名自动去重（真实前端函数）',()=>{
 const wanted=new Set(['uniqueRouteName','beginNewRoute']);
 const ast=ts.createSourceFile('App.ts',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const statements=ast.statements.filter(s=>ts.isFunctionDeclaration(s)&&!!s.name&&wanted.has(s.name.text));
 assert.equal(statements.length,2,'必须运行真实的 uniqueRouteName 与 beginNewRoute');
 const code=ts.transpileModule(statements.map(s=>s.getText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const make=()=>{
  const field={value:{id:'office-map',name:'办公室地图',rows:[],tags:[]} as unknown as FieldMap};
  const state:any={field,routes:{value:[] as {routeId:string;mapId:string;name:string}[]},routeLocked:{value:false},orthogonalPreviewMap:{value:null},routeModes:{value:[]},routePolicyHistory:{value:[]},inspectedTagId:{value:null},tagInspectorVisible:{value:false},selectedSegmentKey:{value:''},routeDetailsOpen:{value:false},routeTool:{value:'pan'},measuring:{value:false},routeSelected:{value:-1},routeHistory:{value:[]},routeSkippedHold:{value:[]},routeEditId:{value:'keep'},routeEditUpdated:{value:'keep'},routeAnchors:{value:[]},initialHeadingManual:{value:true},bodyYawDeg:{value:90},routeNameDraft:{value:''},editingRoute:{value:false},error:{value:'旧错误'},message:{value:''}};
  const context=vm.createContext({...state,clearMeasurement:()=>{}});
  vm.runInContext(code,context);
  return {state,context};
 };
 const first=make();
 vm.runInContext('beginNewRoute()',first.context);
 assert.equal(first.state.routeNameDraft.value,'办公室地图新路径','新建路径必须自动取名');
 assert.equal(first.state.editingRoute.value,true);
 assert.equal(first.state.error.value,'');
 assert.equal(first.state.routeEditId.value,'','新建路径不得复用旧 routeId');
 assert.equal(first.state.bodyYawDeg.value,0,'新建路径朝向应重置');
 // 已存在同名路径 → 自动追加序号，不覆盖
 first.state.routes.value.push({routeId:'r1',mapId:'office-map',name:'办公室地图新路径'});
 first.state.routes.value.push({routeId:'r2',mapId:'office-map',name:'办公室地图新路径 2'});
 // 另一张地图的同名路径不应影响本图去重（mapId 隔离）
 first.state.routes.value.push({routeId:'r3',mapId:'other-map',name:'办公室地图新路径 3'});
 vm.runInContext('beginNewRoute()',first.context);
 assert.equal(first.state.routeNameDraft.value,'办公室地图新路径 3','去重只看同一 mapId，别的地图同名不得占用序号');
});

// ---------------------------------------------------------------- 后端 API 回归

type Fixture=(
 app:Awaited<ReturnType<typeof createApp>>,
 store:Store,
 map:FieldMap,
 dir:string,
)=>Promise<void>;

async function fixture(run:Fixture){
 const dir=mkdtempSync(join(tmpdir(),'qr-personal-ui-'));
 const database=join(dir,'navigation.db');
 const app=await createApp(database),store=new Store(database);
 try{
  const map:FieldMap={...generate({...defaults,count:1,length:2,tagSpacing:1,angle:0}),id:'office',name:'办公室地图',source:'survey',captureQuality:'draft'};
  const saved=await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});
  assert.equal(saved.statusCode,200,saved.body);
  await run(app,store,map,dir);
 }finally{store.close();await app.close();rmSync(dir,{recursive:true,force:true});}
}

const pointsOf=(map:FieldMap)=>[exitPoint(map.rows[0]!),...map.rows[0]!.points];

test('无姓名字段也能启用地图：/maps/confirm 不要求 operator，旧库旧路径跟随新版本',async()=>{
 await fixture(async(app,store,map)=>{
  // 旧路径先绑在 v1 上
  const designed=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,routeName:'办公室地图新路径',points:pointsOf(map),bodyYawDeg:0}});
  assert.equal(designed.statusCode,200,designed.body);
  const routeId=designed.json().route.routeId;
  const before=designed.json().route;
  // 不传 operator（姓名已从 UI 删除），仍必须成功
  const confirmed=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{mapId:map.id,version:1,confirm:true,updateTasks:true}});
  assert.equal(confirmed.statusCode,200,confirmed.body);
  const result=confirmed.json();
  assert.equal(result.version,2,'确认后必须生成新版本');
  assert.equal(result.evidence.operator,'','缺省 operator 必须是空串');
  assert.equal(result.evidence.kind,'user_confirmation');
  assert.deepEqual(result.acceptance,{kind:'user_confirmation',digestValid:true,accepted:true});
  // 旧路径仍可加载，且前移到新版本（旧数据兼容）
  const loaded=await app.inject('/api/routes/'+routeId);
  assert.equal(loaded.statusCode,200,loaded.body);
  assert.equal(loaded.json().route.mapVersion,2,'旧路径必须跟随到新地图版本');
  assert.deepEqual(loaded.json().route.points,before.points,'旧路径坐标不得被改写');
  assert.equal(loaded.json().route.name,'办公室地图新路径','路径名保持自动生成的原名');
  // 旧版本仍然读得到
  assert.equal((await app.inject('/api/maps/'+map.id+'?version=1')).statusCode,200,'旧版本必须保留');
 });
});

test('安全门不退化：draft 地图即使没有人工启用也禁止启动导航，旧 confirm 接口保留兼容',async()=>{
 await fixture(async(app,store,map)=>{
  // 缺 confirm / confirm 非字面 true 一律 400
  for(const payload of [{mapId:map.id,version:1},{mapId:map.id,version:1,confirm:false},{mapId:map.id,version:1,confirm:'true'},{mapId:map.id,version:1,confirm:1}]){
   const response=await app.inject({method:'POST',url:'/api/maps/confirm',payload});
   assert.equal(response.statusCode,400,JSON.stringify(payload));
  }
  assert.equal(store.get(map.id)!.version,1,'非法 confirm 不得产生新版本');
  // 未确认 + draft：不再以"坐标未启用"拒绝切图，否则多张图共用同一批二维码时会永久卡在旧图。
  // 本用例没有底盘遥测，因此只允许被"小车必须静止且底盘在线"这条安全门拦下。
  const localized=await app.inject({method:'POST',url:'/api/localization/map',payload:{mapId:map.id,version:1}});
  assert.doesNotMatch(localized.body,/确认该地图的扫描坐标/,'切图不得再以坐标未启用为由拒绝');
  assert.match(localized.body,/请在小车停止且底盘反馈在线时切换定位地图/,'切图仍要求小车静止');
  // 未确认 + draft：导航启动被拒（423），拦截来自后端而不是 UI 隐藏按钮
  const designed=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,routeName:'草稿路径',points:pointsOf(map),bodyYawDeg:0}});
  assert.equal(designed.statusCode,200,designed.body);
  const taskId=designed.json().task.id;
  const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId}});
  assert.equal(start.statusCode,423,start.body);
  assert.ok(start.json().error.length>0,'必须给出阻断原因');
  assert.match(start.json().error,/草稿|尚未满足|正在切换|等待/,'阻断原因必须指向真实门禁');
  assert.equal(start.json().error.includes('尚未启用'),false,'不得再以"坐标未启用"作为拦截理由');
  // 验收状态由后端数据决定：确认前 accepted=false
  assert.equal((await app.inject('/api/maps/'+map.id)).json().acceptance.accepted,false);
  assert.equal((await app.inject({method:'POST',url:'/api/maps/confirm',payload:{mapId:map.id,version:1,confirm:true,updateTasks:true}})).statusCode,200);
  assert.equal((await app.inject('/api/maps/'+map.id)).json().acceptance.accepted,true,'启用后后端必须记录 acceptance');
 });
});

test('mapId / mapVersion / routeId 隔离在简化后仍然成立',async()=>{
 await fixture(async(app,store,map)=>{
  const other={...map,id:'warehouse',name:'仓库地图'};
  assert.equal((await app.inject({method:'POST',url:'/api/maps',payload:{map:other,baseVersion:0}})).statusCode,200);
  const a=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,routeName:'办公室地图新路径',points:pointsOf(map),bodyYawDeg:0}});
  assert.equal(a.statusCode,200,a.body);
  const routeId=a.json().route.routeId;
  assert.equal(a.json().route.mapId,map.id);
  // 另一张图看不到这条路径
  assert.deepEqual((await app.inject('/api/routes?mapId=warehouse')).json(),[]);
  assert.equal((await app.inject('/api/routes?mapId='+map.id)).json().length,1);
  // 跨图覆盖必须 409
  const cross=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:'warehouse',baseVersion:1,routeId,routeName:'跨图覆盖',routeUpdated:a.json().route.updated,points:pointsOf(map),bodyYawDeg:0}});
  assert.equal(cross.statusCode,409,'跨 mapId 复用 routeId 必须被拒');
  // 版本冲突必须 409
  const stale=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:99,routeName:'过期版本',points:pointsOf(map),bodyYawDeg:0}});
  assert.equal(stale.statusCode,409,'baseVersion 过期必须被拒');
  // 同一地图同名路径必须 409（自动命名去重由前端负责，后端兜底）
  const dup=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,routeName:'办公室地图新路径',points:pointsOf(map),bodyYawDeg:0}});
  assert.equal(dup.statusCode,409,'同图同名路径必须被拒');
 });
});

test('旧库（无 routes 表）升级后旧路径仍可加载，且不被改写',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qr-personal-legacy-'));
 const database=join(dir,'navigation.db');
 // 模拟 v7 旧库：只有 versions 表，没有 routes 表。
 const base=generate({...defaults,count:1,length:2,tagSpacing:1,angle:0});base.id='legacy-map';
 const map=compileDesignedRoute(base,[exitPoint(base.rows[0]!),...base.rows[0]!.points],0).map;
 const raw=new Database(database);
 raw.exec('CREATE TABLE versions(map_id TEXT,version INTEGER,name TEXT,created TEXT,body TEXT,PRIMARY KEY(map_id,version));');
 raw.prepare('INSERT INTO versions VALUES(?,?,?,?,?)').run(map.id,1,map.name,'old-map-time',JSON.stringify(map));
 raw.close();
 const app=await createApp(database);
 let firstPoints:unknown;
 try{
  const listed=(await app.inject('/api/routes?mapId=legacy-map')).json();
  assert.equal(listed.length,1,'旧库升级必须自动迁移出旧路径');
  assert.match(listed[0].routeId,/^legacy-/,'旧路径必须使用 legacy- 前缀 id');
  assert.ok(listed[0].routeId.length<=80,'旧路径 id 不得超过 80 字符');
  firstPoints=listed[0].points;
  const loaded=await app.inject('/api/routes/'+listed[0].routeId);
  assert.equal(loaded.statusCode,200,'旧路径必须可加载');
  assert.deepEqual(loaded.json().route.points,firstPoints,'旧路径坐标不得被改写');
 }finally{await app.close();}
 // 二次启动不得重复迁移或改写旧路径
 const reopened=await createApp(database);
 try{
  const again=(await reopened.inject('/api/routes?mapId=legacy-map')).json();
  assert.equal(again.length,1,'重复启动不得产生重复旧路径');
  assert.deepEqual(again[0].points,firstPoints,'重复启动不得改写旧路径坐标');
 }finally{await reopened.close();rmSync(dir,{recursive:true,force:true});}
});
