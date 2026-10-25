/**
 * 多张地图共用同一批二维码时的"切图→重锚→放行"回归。
 *
 * 现场问题（2026-10-22 16:13 截图）：办公室9/8/7 与办公室6 用的是同一批物理二维码板
 * （19 个组 B000…B316 完全一致），在界面里切换地图后：
 *   1) 前端只在"已选任务 + 地图已验收"时才调用切换接口，draft 地图根本不发请求；
 *   2) 后端 /api/localization/map 又直接以"坐标未启用"拒绝，定位永远留在办公室6；
 *   3) 于是定位卡片只能显示"当前定位属于其他地图"，并且没有任何恢复路径（卡死）；
 *   4) 而 /api/navigation/start 只在 routeMode==='waypoints' 时比较定位地图，
 *      这几张图都是 map-only，等于导航放行完全不看定位作用域（可能误放行）。
 *
 * 本文件覆盖：切图重锚的作用域判定、旧地图/旧位姿的拒绝、导航门禁口径，
 * 以及"不许回退成只改提示"的源码契约。只读源码 + 纯函数，不启动导航、不发 cmd_vel。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {localizationScopeBlock,localizationScopePhase} from '../web/backend/src/server';

const serverSource=readFileSync('web/backend/src/server.ts','utf8');
const appSource=readFileSync('web/frontend/src/App.vue','utf8');
const localizationSource=readFileSync('src/greenhouse_navigation/greenhouse_navigation/localization.py','utf8');
const startScript=readFileSync('scripts/start_localization.sh','utf8');

// 去掉注释后再做文案契约断言，避免注释里的历史说明误判。
function stripComments(source:string){
 return source
  .replace(/\/\*[\s\S]*?\*\//g,'')
  .replace(/^\s*\/\/.*$/gm,'')
  .replace(/^\s*#.*$/gm,'');
}

const cleanApp=stripComments(appSource);

test('定位作用域：所选地图与定位地图不一致时必须拦住（旧图/旧位姿不许复用）',()=>{
 // 定位仍在办公室6，用户已切到办公室9 —— 这正是"卡在属于其他地图"的现场。
 assert.match(String(localizationScopeBlock('office-9',4,{mapId:'office-6',mapVersion:6,poseAvailable:true})),/正在切换/);
 assert.match(String(localizationScopeBlock('office-9',4,{mapId:'office-6',mapVersion:6,poseAvailable:true})),/office-6 v6/);
 // 同一张图但版本不同，同样算作用域不一致（不能拿 v6 的位姿去跑 v4 的任务）。
 assert.match(String(localizationScopeBlock('office-9',4,{mapId:'office-9',mapVersion:3,poseAvailable:true})),/正在切换/);
 // 地图对上了但还没重新锚定 —— 不允许拿旧原点直接放行。
 assert.match(String(localizationScopeBlock('office-9',4,{mapId:'office-9',mapVersion:4,poseAvailable:false})),/等待二维码重新锚定/);
 // 完全没有定位遥测时也不放行。
 assert.match(String(localizationScopeBlock('office-9',4,null)),/等待定位服务/);
 assert.match(String(localizationScopeBlock('office-9',4,undefined)),/等待定位服务/);
 assert.match(String(localizationScopeBlock('office-9',4,{mapId:'',mapVersion:4,poseAvailable:true})),/等待定位服务/);
 // 只有 mapId+version+poseAvailable 全部匹配才放行。
 assert.equal(localizationScopeBlock('office-9',4,{mapId:'office-9',mapVersion:4,poseAvailable:true}),null);
});

test('切图阶段：unknown → switching → waiting-anchor → anchored，不把未锚定说成已锚定',()=>{
 assert.equal(localizationScopePhase(false,'office-9',4,null),'unknown');
 assert.equal(localizationScopePhase(true,'office-9',4,null),'switching');
 assert.equal(localizationScopePhase(true,'office-9',4,{mapId:'office-6',mapVersion:6,poseAvailable:true}),'switching');
 assert.equal(localizationScopePhase(true,'office-9',4,{mapId:'office-9',mapVersion:4,poseAvailable:false}),'waiting-anchor');
 assert.equal(localizationScopePhase(true,'office-9',4,{mapId:'office-9',mapVersion:4,poseAvailable:true}),'anchored');
});

test('切图接口不得再以"坐标未启用"拒绝，否则 draft 地图永远切不过去',()=>{
 const start=serverSource.indexOf("app.post('/api/localization/map'");
 const end=serverSource.indexOf("app.get('/api/localization/scope'");
 assert.ok(start>0&&end>start,'切图与作用域接口都应存在');
 const route=serverSource.slice(start,end);
 assert.equal(route.includes("coordinateStatus!=='reviewed'"),false,'切图不应再被 coordinateStatus 拦截');
 assert.ok(route.includes('maps/office-confirmed.json'),'切图必须写定位地图文件以触发重锚');
 assert.ok(route.includes('switched'),'切图必须回报是否真的发生切换');
 assert.ok(route.includes('请在小车停止且底盘反馈在线时切换定位地图'),'切图仍要求小车静止');
 assert.ok(route.includes('（坐标来自扫描：未做人工验收）'),'坐标来源要留审计日志');
});

test('导航门禁对所有路线模式都比较定位作用域，不再是 waypoints 专用',()=>{
 assert.ok(serverSource.includes('localizationScopeBlock(item.map.id,item.version,robot.status().localization)'),'导航启动必须调用作用域判定');
 assert.equal(serverSource.includes("routeMode==='waypoints'&&(robot.status().localization"),false,'不得保留只看 waypoints 的旧判定');
 assert.ok(serverSource.includes('{statusCode:423}'),'作用域不匹配应以 423 拦截');
});

test('前端选图即切图，不再依赖"已选任务+已验收"才发请求',()=>{
 const start=appSource.indexOf('async function syncLocalizationScope()');
 const end=appSource.indexOf('watch([()=>field.value?.id',start);
 assert.ok(start>0&&end>start,'应存在 syncLocalizationScope');
 const fn=appSource.slice(start,end);
 assert.ok(fn.includes("api('/localization/map'"),'切图必须真的调用后端接口');
 assert.equal(fn.includes('selectedTask'),false,'切图不得依赖已选任务');
 assert.equal(fn.includes('mapApproval'),false,'切图不得依赖地图验收状态');
 assert.ok(appSource.includes('watch([()=>field.value?.id,()=>version.value,()=>robot.value.connected]'),'地图/版本变化必须触发切图');
 assert.ok(appSource.includes('waitScopeAnchored'),'切图后必须等待当前地图重新锚定');
 assert.equal(cleanApp.includes('当前定位属于其他地图'),false,'不许再输出会让人以为卡死的旧文案');
});

test('导航按钮与阻塞原因都绑定定位作用域，匹配后才放行',()=>{
 const gate=appSource.slice(appSource.indexOf('const canNavigate=computed'),appSource.indexOf('const pendingConditions'));
 assert.ok(gate.includes('robot.value.localization?.mapId===field.value?.id'),'canNavigate 必须比较 mapId');
 assert.ok(gate.includes('robot.value.localization?.mapVersion===version.value'),'canNavigate 必须比较 mapVersion');
 assert.ok(gate.includes('robot.value.localization?.poseAvailable===true'),'canNavigate 必须要求当前地图已锚定');
 // 切图即生效后不再要求人工启用地图，但作用域/位姿门禁必须仍在
 assert.equal(gate.includes('mapApproval'),false,'切图即生效后不再要求人工启用地图');
 assert.equal(gate.includes('coordinateStatus'),false,'不再要求坐标被人工验收');
 assert.ok(appSource.includes('已切换到当前地图，等待二维码重新锚定'),'等待重锚要有明确原因');
});

test('定位节点跟随所选地图：清旧原点但不伪造导航就绪',()=>{
 assert.equal(localizationSource.includes("切换地图必须已确认"),false,'重载不得再因坐标未启用直接放弃');
 assert.equal(localizationSource.includes("全局定位必须使用已接纳的地图"),false,'启动不得再因坐标未启用直接退出');
 assert.ok(localizationSource.includes("self.coordinate_reviewed=reviewed"),'重载后要记录坐标是否已启用');
 assert.ok(localizationSource.includes('旧原点与旧二维码缓存已清除'),'重载必须清旧原点并留日志');
 assert.ok(localizationSource.includes('navigation_ready=bool(formal and covariance_valid and (interval_navigation or within_limit))'),'导航就绪仍必须要求正式同步定位+有效协方差+误差达标');
 assert.equal(localizationSource.includes("and getattr(self,'coordinate_reviewed',True))"),false,'坐标来源不得参与导航放行（否则又要人工启用）');
 assert.equal(localizationSource.includes('该地图坐标尚未启用'),false,'不得再以坐标未启用为由阻止导航');
 assert.ok(localizationSource.includes('坐标来自扫描，未做人工验收'),'坐标来源仍要留在日志里可追溯');
});

test('定位启动预检：坐标未启用仍可启动（否则重启即失去定位），已启用仍校验接纳证据',()=>{
 assert.equal(startScript.includes("raise SystemExit('地图未接纳')"),false,'启动预检不得因未启用直接退出');
 assert.ok(startScript.includes("reviewed=m.get('coordinateStatus')=='reviewed'"),'启动预检要区分是否已启用');
 assert.ok(startScript.includes('地图接纳证据缺失或摘要失效'),'已启用地图仍必须校验接纳摘要');
 assert.ok(startScript.includes('草稿地图需要有效用户确认'),'草稿质量地图仍必须有用户确认');
});
