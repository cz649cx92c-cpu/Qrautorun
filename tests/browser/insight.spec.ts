import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FieldMap,Point} from '../../web/shared/model';
import {topologyFromSegments,topologySummary} from '../../web/shared/route-topology';

const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {
 map:FieldMap;version:number;route:{routeId:string;mapId:string;name:string;mapVersion:number;mapDigest:string;points:Point[];motionSegments:{id:string;fromId:number;toId:number;mode:string;direction:string;strategy?:string|null;points:Point[]}[];bodyYawDeg:number;initialHeadingRad:number|null;distanceModel:string;spacingOverrides:unknown[];created:string;updated:string};
};
const baseMap=snap.map,route=snap.route,storedCount=route.points.length;
const path:Point[]=route.motionSegments.length?[route.motionSegments[0]!.points[0]!,...route.motionSegments.flatMap(s=>s.points.slice(1))]:route.points;
const task={id:'task-office',name:'办公室任务',mapId:baseMap.id,mapVersion:1,routeId:route.routeId,rowOrder:[],enabled:true,forwardSpeed:8,reverseSpeed:6,lateralSpeed:5,endWaitSeconds:2};
const topoRestore=topologyFromSegments(route.motionSegments);
const topoCenters=baseMap.tags.map(t=>({tagId:t.id,groupId:t.groupId??'',x:t.x,y:t.y}));
const topologyResponse={routeId:route.routeId,mapId:route.mapId,mapVersion:route.mapVersion,stored:false,topology:topoRestore.topology,summary:topologySummary(topoRestore.topology,topoCenters),issues:topoRestore.issues,strategyChoices:[],disclaimer:''};

// One variant where Q300 is a standalone tag (no group) so the size selector path is reachable.
const standaloneMap:FieldMap={...baseMap,tags:baseMap.tags.map(t=>t.id===300?{...t,groupId:undefined}:t),groups:(baseMap.groups??[]).filter(g=>g.referenceId!==300)};

const failures=new WeakMap<Page,{errors:string[];unexpected:string[]}>();
test.afterEach(async({page})=>{
 const o=failures.get(page);
 if(o&&(o.errors.length||o.unexpected.length))throw new Error('浏览器异常: '+JSON.stringify(o.errors)+' 未 mock: '+JSON.stringify(o.unexpected));
});

let workMap=baseMap;
let savedUpdates:{edits:unknown;baseVersion:number}[]=[];
async function mock(page:Page,variant:'group'|'standalone'){
 workMap=variant==='standalone'?standaloneMap:baseMap;
 savedUpdates=[];
 const o={errors:[] as string[],unexpected:[] as string[]};failures.set(page,o);
 page.on('pageerror',e=>o.errors.push(e.message));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]}})));
 await page.route('**/api/**',async req=>{
  const path=new URL(req.request().url()).pathname;
  const json=(b:unknown)=>req.fulfill({json:b as never});
  if(path==='/api/camera/status')return json({running:true,present:true,frameAgeMs:10,error:''});
  if(path==='/api/camera/calibration')return json({});
  if(path==='/api/localization/map')return json({anchored:true,mapId:workMap.id});
  if(path==='/api/localization/scope')return json({phase:'anchored'});
  if(path==='/api/robot/status')return json({connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]});
  if(path==='/api/maps')return json([{id:workMap.id,name:workMap.name,version:1}]);
  if(path==='/api/maps/'+workMap.id)return json({map:workMap,version:1,acceptance:null});
  if(path==='/api/surveys')return json([]);
  if(path==='/api/tasks')return json([task]);
  if(path==='/api/routes')return json([route]);
  if(path.endsWith('/topology'))return json(topologyResponse);
  if(path==='/api/routes/'+route.routeId)return json({...route,route,map:{...workMap,routeMode:'waypoints' as const,rows:[{id:'route-1',name:route.name,width:.6,exitDistance:.8,start:path[0]!,points:path.slice(1)}],order:['route-1'],motionSegments:route.motionSegments,tags:workMap.tags.map(t=>({...t,rowId:'route-1'}))},version:1,acceptance:null});
  if(path==='/api/maps/'+workMap.id+'/tags/update'){
   const body=req.postData()?JSON.parse(req.postData()!):{edits:[]};
   savedUpdates.push({edits:body.edits,baseVersion:body.baseVersion});
   const edit=body.edits?.[0] as {id:number,size:number}|undefined;
   const nextMap:FieldMap={...workMap,tags:workMap.tags.map(t=>t.id===edit?.id?{...t,size:edit!.size}:t),groups:workMap.groups};
   workMap=nextMap;
   return json({map:nextMap,version:2,acceptance:null});
  }
  if(path==='/api/boards')return json([]);
  if(path.endsWith('/tag-aliases'))return json({aliases:[]});
  o.unexpected.push(path);return req.fulfill({status:404,json:{error:'unexpected '+path}});
 });
 await page.goto('/');
}

async function enterEditor(page:Page,openSteps=false){
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(workMap.id);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await page.getByTestId('route-select').selectOption({label:route.name});
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await expect(page.getByTestId('route-steps-trigger')).toContainText(`路径步骤 ${storedCount}`);
 if(openSteps)await openStepsPanel(page);
}
async function openStepsPanel(page:Page){
 if(!(await page.getByTestId('route-steps-popover').isVisible())){
  await page.getByTestId('route-steps-trigger').click();
 }
 await expect(page.getByTestId('route-steps-popover')).toBeVisible();
}

async function selectStep(page:Page,key:number){
 await openStepsPanel(page);
 await page.locator(`[data-testid="route-step-qr-${key}"]`).locator('xpath=ancestor::tr').click();
 await expect(page.getByTestId('route-inspector')).toBeVisible();
}

for(const vp of [{width:1024,height:768},{width:1440,height:900}]){
 test(`朝向卡紧凑且角度可编辑 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await mock(page,'group');
  await enterEditor(page);
  const heading=page.getByTestId('route-initial-heading');
  const box=await heading.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThan(48);
  const input=page.getByTestId('route-heading-input');
  await input.fill('123');
  await input.blur();
  await expect(page.getByTestId('route-heading-value')).toContainText('123.0');
  await input.fill('270');
  await input.blur();
  await expect(page.getByTestId('route-heading-value')).toContainText('270.0');
  await expect(page.getByText('−15°',{exact:true})).toHaveCount(0);
  await expect(page.getByTestId('adopt-first-leg-heading')).toHaveCount(0);
  await expect(page.getByTestId('reset-initial-heading')).toHaveCount(0);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  console.log('HEADING_COMPACT',JSON.stringify({vp,height:box!.height,overflow}));
 });

 test(`单点删除只删选中点且可取消、撤销、保存 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await mock(page,'group');
  await enterEditor(page);
  // Select step 2 (index key=1, Q160) and P = its own row; Q = another row must survive.
  await selectStep(page,1);
  const beforeQ096Count=(await page.locator('[data-testid^="route-step-qr-"]').allInnerTexts()).filter(t=>t==='Q096').length;
  const coordP=await page.locator(`[data-testid="route-step-qr-1"]`).locator('xpath=ancestor::tr').locator('td').nth(4).innerText();
  await page.getByTestId('route-point-delete').click();
  const confirm=page.getByTestId('route-point-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('第 2 点');
  await expect(confirm).toContainText('Q096');
  // Cancel keeps the draft untouched.
  await page.getByTestId('route-point-cancel').click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('route-steps-trigger')).toContainText(`路径步骤 ${storedCount}`);
  // Confirm deletion of exactly this point.
  await selectStep(page,1);
  await page.getByTestId('route-point-delete').click();
  await page.getByTestId('route-point-confirm-delete').click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('route-steps-trigger')).toContainText(`路径步骤 ${storedCount-1}`);
  // Q160 gone; another point (Q272) still present with its own coordinates.
  const rows=await page.locator('[data-testid^="route-step-qr-"]').allInnerTexts();
  expect(rows.length).toBe(storedCount-1);
  expect(rows[1]).toBe('Q064');
  expect(rows.filter(t=>t==='Q096').length).toBe(2);
  // Undo restores the deleted point; save chain remains reachable.
  await page.getByTestId('route-undo').click();
  await expect(page.getByTestId('route-steps-trigger')).toContainText(`路径步骤 ${storedCount}`);
  await expect(page.getByTestId('route-save')).toBeEnabled();
  await expect(page.getByTestId('route-exit')).toBeVisible();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  console.log('POINT_DELETE_OK',JSON.stringify({vp,coordP,stepsAfter:storedCount-1,overflow}));
 });

 test(`码组规格只读展示且不跨点串改 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await mock(page,'group');
  await enterEditor(page);
  // Q112 (4×4 · 60mm group) vs Q300 (same layout) — both render full group specs, no size editing.
  await selectStep(page,0);
  await expect(page.getByTestId('route-tag-spec-value')).toContainText('网格 4×4');
  await expect(page.getByTestId('route-tag-spec-value')).toContainText('60 mm');
  await expect(page.getByTestId('route-tag-spec-select')).toHaveCount(0);
  await selectStep(page,5);
  const spec2=await page.getByTestId('route-tag-spec-value').innerText();
  expect(spec2).toContain('60 mm');
  expect(savedUpdates.length).toBe(0);
  console.log('GROUP_SPEC_OK',JSON.stringify({vp,spec2}));
 });

 test(`码组规格只读分列展示且跨点不串改 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await mock(page,'group');
  await enterEditor(page);
  await selectStep(page,18);
  const spec=page.getByTestId('route-tag-spec-value');
  await expect(spec).toContainText('网格 4×4');
  await expect(spec).toContainText('板宽 60 mm');
  await expect(spec).toContainText('间距 2 mm');
  await expect(page.getByTestId('route-tag-spec-select')).toHaveCount(0);
  await expect(page.getByText('码组规格属于整组打印布局')).toBeVisible();
  await selectStep(page,22);
  await expect(page.getByTestId('route-tag-spec-value')).toContainText('60 mm');
  await selectStep(page,18);
  await expect(spec).toContainText('60 mm');
  expect(savedUpdates.length).toBe(0);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  console.log('GROUP_SPEC_RO',JSON.stringify({vp,overflow}));
 });
}
test('拓扑打开后移动路点 5 秒稳定 @insight',async({page})=>{
 await page.setViewportSize({width:1440,height:900});await mock(page,'group');
 await enterEditor(page);
 await page.getByTestId('route-steps-trigger').click();
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
});
