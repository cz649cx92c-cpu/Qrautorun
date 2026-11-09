import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FieldMap,Point} from '../../web/shared/model';
import {topologyFromSegments,topologySummary} from '../../web/shared/route-topology';

const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {
 map:FieldMap;version:number;route:{routeId:string;mapId:string;name:string;mapVersion:number;mapDigest:string;points:Point[];motionSegments:{id:string;fromId:number;toId:number;mode:string;direction:string;strategy?:string|null;points:Point[]}[];bodyYawDeg:number;initialHeadingRad:number|null;distanceModel:string;spacingOverrides:unknown[];created:string;updated:string};
};
const map=snap.map,route=snap.route,storedCount=route.points.length;
const path:Point[]=route.motionSegments.length?[route.motionSegments[0]!.points[0]!,...route.motionSegments.flatMap(s=>s.points.slice(1))]:route.points;
const routeSnapshot={...route,route,map:{...map,routeMode:'waypoints' as const,rows:[{id:'route-1',name:route.name,width:.6,exitDistance:.8,start:path[0]!,points:path.slice(1)}],order:['route-1'],motionSegments:route.motionSegments,tags:map.tags.map(t=>({...t,rowId:'route-1'}))},version:1,acceptance:null};
const second={...route,routeId:'route-second',name:'第二条路径',updated:route.updated};
const secondSnapshot={...routeSnapshot,routeId:'route-second',route:second,points:route.points.slice(0,5)};
const task={id:'task-office',name:'办公室任务',mapId:map.id,mapVersion:1,routeId:route.routeId,rowOrder:[],enabled:true,forwardSpeed:8,reverseSpeed:6,lateralSpeed:5,endWaitSeconds:2};
const topoRestore=topologyFromSegments(route.motionSegments);
const topoCenters=map.tags.map(t=>({tagId:t.id,groupId:t.groupId??'',x:t.x,y:t.y}));
const topologyResponse={routeId:route.routeId,mapId:route.mapId,mapVersion:route.mapVersion,stored:false,topology:topoRestore.topology,summary:topologySummary(topoRestore.topology,topoCenters),issues:topoRestore.issues,strategyChoices:[],disclaimer:''};
const otherMapRoute={...route,routeId:'route-other-map',mapId:'design-other-map',name:'另一张图的同名路径'};

const failures=new WeakMap<Page,{errors:string[];unexpected:string[]}>();
test.afterEach(async({page})=>{
 const o=failures.get(page);
 if(o&&(o.errors.length||o.unexpected.length))throw new Error('浏览器异常: '+JSON.stringify(o.errors)+' 未 mock: '+JSON.stringify(o.unexpected));
});

let routeList=[route,second,otherMapRoute];
async function mock(page:Page){
 const o={errors:[] as string[],unexpected:[] as string[]};failures.set(page,o);
 page.on('pageerror',e=>o.errors.push(e.message));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]}})));
 await page.route('**/api/**',async req=>{
  const path=new URL(req.request().url()).pathname;
  const json=(b:unknown)=>req.fulfill({json:b as never});
  if(path==='/api/camera/status')return json({running:true,present:true,frameAgeMs:10,error:''});
  if(path==='/api/camera/calibration')return json({});
  if(path==='/api/localization/map')return json({anchored:true,mapId:map.id});
  if(path==='/api/localization/scope')return json({phase:'anchored'});
  if(path==='/api/robot/status')return json({connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]});
  if(path==='/api/maps')return json([{id:map.id,name:map.name,version:1}]);
  if(path==='/api/maps/'+map.id)return json({map:{...map,routeMode:'waypoints'},version:1,acceptance:null});
  if(path==='/api/surveys')return json([]);
  if(path==='/api/tasks')return json([task]);
  if(path==='/api/routes')return json(routeList);
  if(path.endsWith('/topology'))return json(topologyResponse);
  if(path==='/api/routes/route-second')return json(secondSnapshot);
  if(path==='/api/routes/'+route.routeId)return json(routeSnapshot);
  if(path==='/api/boards')return json([]);
  if(path.endsWith('/tag-aliases'))return json({aliases:[]});
  o.unexpected.push(path);return req.fulfill({status:404,json:{error:'unexpected '+path}});
 });
 await page.goto('/');
}

async function enterEditor(page:Page){
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(map.id);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
}

for(const vp of [{width:1024,height:768},{width:1440,height:900}]){
 test(`摘要已移除且蓝框只剩朝向角度 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);routeList=[route,second,otherMapRoute];await mock(page);
  await enterEditor(page);
  // A: red box gone from the DOM entirely (not merely hidden)
  await expect(page.getByTestId('route-anchors-length')).toHaveCount(0);
  await expect(page.getByTestId('route-group-badge')).toHaveCount(0);
  await expect(page.getByTestId('route-name-field')).toHaveCount(0);
  await expect(page.getByTestId('route-name-input')).toHaveCount(0);
  const residual=await page.evaluate(()=>{
   const panel=document.querySelector('[data-testid="route-panel-params"]') as HTMLElement|null;
   const texts=(panel?.innerText??'').replace(/\s+/g,' ');
   return {texts,hasAnchorRow:/路点\s*\/\s*长度/.test(texts),hasVisitRow:/经过\s*\/\s*跳过/.test(texts),hasName:/路径名称/.test(texts),panelHeight:panel?.getBoundingClientRect().height??0};
  });
  console.log('SUMMARY_REMOVED',JSON.stringify({vp,...residual}));
  expect(residual.hasAnchorRow).toBe(false);
  expect(residual.hasVisitRow).toBe(false);
  expect(residual.hasName).toBe(false);
  expect(residual.panelHeight).toBeLessThan(140);

  // B: only the heading angle input remains
  const heading=page.getByTestId('route-initial-heading');
  await expect(heading).toBeVisible();
  await expect(page.getByTestId('route-heading-value')).toBeVisible();
  const input=page.getByTestId('route-heading-input');
  await expect(input).toBeVisible();
  const before=await input.inputValue();
  await input.fill('123');
  await input.blur();
  await expect(page.getByTestId('route-heading-value')).toContainText('123.0');
  await input.fill(before);
  await input.blur();
  await expect(page.getByText('−15°',{exact:true})).toHaveCount(0);
  await expect(page.getByText('+15°',{exact:true})).toHaveCount(0);
  await expect(page.getByTestId('adopt-first-leg-heading')).toHaveCount(0);
  await expect(page.getByTestId('reset-initial-heading')).toHaveCount(0);
  await expect(page.getByText('用首段方向')).toHaveCount(0);
  await expect(page.getByText('恢复默认')).toHaveCount(0);

  const overflow=await page.evaluate(()=>({h:document.documentElement.scrollWidth-document.documentElement.clientWidth}));
  expect(overflow.h).toBeLessThanOrEqual(1);
  console.log('HEADING_ONLY_OK',JSON.stringify({vp,...overflow}));
 });

 test(`编辑已选路径弹当前地图选择器并正确加载 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);routeList=[route,second,otherMapRoute];await mock(page);
  await enterEditor(page);
  await page.getByTestId('unified-pick-route').click();
  const dialog=page.getByTestId('route-open-dialog');
  await expect(dialog).toBeVisible();
  const list=page.getByTestId('route-open-list');
  await expect(list).toBeVisible();
  // Only this map's two routes; the other map's same-named route never appears.
  await expect(list.locator('button')).toHaveCount(2);
  await expect(list).not.toContainText('另一张图的同名路径');
  await expect(list).toContainText(route.name);
  await expect(list).toContainText('第二条路径');
  // Cancel keeps the current draft untouched.
  await page.getByTestId('route-open-close').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('route-editor')).toBeVisible();
  // Pick the second route and confirm the real loader ran.
  await page.getByTestId('unified-pick-route').click();
  await page.getByTestId('route-open-item-route-second').click();
  await expect(page.getByTestId('route-open-dialog')).toHaveCount(0);
  await expect(page.getByTestId('route-steps-trigger')).toContainText('路径步骤 5');
  await expect(page.getByTestId('route-save')).toBeVisible();
  await expect(page.getByTestId('route-exit')).toBeVisible();
  // Back to the 33-point route.
  await page.getByTestId('unified-pick-route').click();
  await page.getByTestId('route-open-item-'+route.routeId).click();
  await expect(page.getByTestId('route-steps-trigger')).toContainText(`路径步骤 ${storedCount}`);
  await expect(page.getByTestId('route-heading-value')).toContainText('270');
  const overflow=await page.evaluate(()=>({h:document.documentElement.scrollWidth-document.documentElement.clientWidth}));
  expect(overflow.h).toBeLessThanOrEqual(1);
  console.log('PICK_ROUTE_OK',JSON.stringify({vp,steps:storedCount,...overflow}));
 });

 test(`无路径时编辑已选路径显示明确空态 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);routeList=[otherMapRoute];await mock(page);
  await enterEditor(page);
  await page.getByTestId('unified-pick-route').click();
  await expect(page.getByTestId('route-open-dialog')).toBeVisible();
  await expect(page.getByTestId('route-open-empty')).toContainText('暂无路径');
  await expect(page.getByTestId('route-open-list')).toHaveCount(0);
  await expect(page.getByTestId('route-open-new')).toBeEnabled();
  await page.getByTestId('route-open-close').click();
  await expect(page.getByTestId('route-open-dialog')).toHaveCount(0);
  console.log('EMPTY_STATE_OK',JSON.stringify({vp}));
 });
}

test('拓扑打开后移动路点 5 秒无自动开关（保留回归）',async({page})=>{
 await page.setViewportSize({width:1440,height:900});routeList=[route,second,otherMapRoute];await mock(page);
 await enterEditor(page);
 await page.getByTestId('unified-pick-route').click();
 await page.getByTestId('route-open-item-'+route.routeId).click();
 await expect(page.getByTestId('route-geometry-move')).toHaveAttribute('data-open','1');
 await page.getByTestId('route-tools-group-toggle-topology').click();
 await expect(page.getByTestId('route-tools-group-topology')).toHaveAttribute('data-open','1');
 const sampled=await page.evaluate(async()=>{
  const el=document.querySelector('[data-testid="route-geometry-move"]') as HTMLElement;
  const read=()=>`${el.getAttribute('data-open')}|${el.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')}`;
  const states=[read()];let changes=0;const end=performance.now()+5000;
  while(performance.now()<end){await new Promise(r=>setTimeout(r,100));const n=read();if(n!==states[states.length-1]){changes++;states.push(n);}}
  return {changes,samples:states.length};
 });
 console.log('TOPO_STABLE',JSON.stringify(sampled));
 expect(sampled.changes).toBe(0);
 expect(sampled.samples).toBeGreaterThanOrEqual(1);
});
