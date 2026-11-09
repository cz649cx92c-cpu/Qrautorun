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
const task={id:'task-office',name:'办公室任务',mapId:map.id,mapVersion:1,routeId:route.routeId,rowOrder:[],enabled:true,forwardSpeed:8,reverseSpeed:6,lateralSpeed:5,endWaitSeconds:2};
const topoRestore=topologyFromSegments(route.motionSegments);
const topoCenters=map.tags.map(t=>({tagId:t.id,groupId:t.groupId??'',x:t.x,y:t.y}));
const topologyResponse={routeId:route.routeId,mapId:route.mapId,mapVersion:route.mapVersion,stored:false,topology:topoRestore.topology,summary:topologySummary(topoRestore.topology,topoCenters),issues:topoRestore.issues,strategyChoices:[],disclaimer:''};

const failures=new WeakMap<Page,{errors:string[];unexpected:string[]}>();
test.afterEach(async({page})=>{
 const observed=failures.get(page);
 if(observed&&(observed.errors.length||observed.unexpected.length))
  throw new Error('浏览器异常: '+JSON.stringify(observed.errors)+' 未 mock 的 API: '+JSON.stringify(observed.unexpected));
});

async function mock(page:Page){
 const observed={errors:[] as string[],unexpected:[] as string[]};failures.set(page,observed);
 page.on('pageerror',e=>observed.errors.push(e.message));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,
  chassis:{connected:true},sensors:{camera:'位姿已计算 / 待同步',imu:'在线',odom:'在线',localization:'局部已融合'},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]}})));
 await page.route('**/api/**',async req=>{
  const path=new URL(req.request().url()).pathname;
  const json=(body:unknown)=>req.fulfill({json:body as never});
  if(path==='/api/camera/status')return json({running:true,present:true,frameAgeMs:10,error:''});
  if(path==='/api/camera/calibration')return json({});
  if(path==='/api/localization/map')return json({anchored:true,mapId:map.id});
  if(path==='/api/localization/scope')return json({phase:'anchored'});
  if(path==='/api/robot/status')return json({connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]});
  if(path==='/api/maps')return json([{id:map.id,name:map.name,version:1}]);
  if(path==='/api/maps/'+map.id)return json({map:{...map,routeMode:'waypoints'},version:1,acceptance:null});
  if(path==='/api/surveys')return json([]);
  if(path==='/api/tasks')return json([task]);
  if(path==='/api/routes')return json([route]);
  if(path==='/api/routes/'+route.routeId)return json(routeSnapshot);
  if(path==='/api/routes/'+route.routeId+'/topology')return json(topologyResponse);
  if(path==='/api/boards')return json([]);
  if(path.endsWith('/tag-aliases'))return json({aliases:[]});
  if(path==='/api/preview')return json({running:false,present:false});
  if(path==='/api/calibration')return json({});
  observed.unexpected.push(path);
  return req.fulfill({status:404,json:{error:'Unexpected mocked API: '+path}});
 });
 await page.goto('/');
}

async function openEditor(page:Page){
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(map.id);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await page.getByTestId('route-select').selectOption({label:route.name});
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
}

/** Samples an element's state every 100ms for `ms` and reports how many times it changed. */
async function sampleChanges(page:Page,selector:string,ms:number){
 return await page.evaluate(async({selector,ms})=>{
  const el=document.querySelector(selector) as HTMLElement|null;
  if(!el)return {found:false,changes:-1,samples:0,states:[] as string[]};
  const read=()=>`${el.getAttribute('data-open')}|${el.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')}|${getComputedStyle(el.querySelector('.rg-fold__body') as HTMLElement??el).display}`;
  const states:string[]=[read()];let changes=0;let samples=1;
  const end=performance.now()+ms;
  while(performance.now()<end){
   await new Promise(r=>setTimeout(r,100));
   const next=read();samples++;
   if(next!==states[states.length-1]!){changes++;states.push(next);}
  }
  return {found:true,changes,samples,states:states.slice(0,8)};
 },{selector,ms});
}

for(const viewport of [{width:1024,height:768},{width:1440,height:900}]){
 test(`打开路线拓扑后移动路点 5 秒无自动切换 @${viewport.width}x${viewport.height}`,async({page})=>{
  await page.setViewportSize(viewport);await mock(page);
  await openEditor(page);
  const move=page.getByTestId('route-geometry-move');
  // Establish the pre-existing stable state (default open) before touching topology.
  await expect(move).toHaveAttribute('data-open','1');
  await expect(page.getByTestId('route-geometry-move-toggle')).toHaveAttribute('aria-expanded','true');

  await page.getByTestId('route-tools-group-toggle-topology').click();
  await expect(page.getByTestId('route-tools-group-topology')).toHaveAttribute('data-open','1');
  await expect(page.getByTestId('route-geometry-panel')).toBeVisible();

  const sampled=await sampleChanges(page,'[data-testid="route-geometry-move"]',5000);
  console.log('TOPO_OPEN_SAMPLE',JSON.stringify({viewport,...sampled}));
  expect(sampled.found).toBe(true);
  expect(sampled.changes).toBe(0);
  expect(sampled.samples).toBeGreaterThanOrEqual(45);
  await expect(move).toHaveAttribute('data-open','1');

  // Each control toggles exactly once: move closes, then reopens.
  const toggles=await page.evaluate(async()=>{
   const move=document.querySelector('[data-testid="route-geometry-move"]') as HTMLElement;
   const topo=document.querySelector('[data-testid="route-tools-group-topology"]') as HTMLElement;
   const read=()=>`${move.getAttribute('data-open')}|${topo.getAttribute('data-open')}`;
   const clicks:string[]=[];const states:string[]=[read()];
   const fire=(sel:string)=>{const b=document.querySelector(sel) as HTMLElement;b.click();clicks.push(sel);};
   const wait=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   fire('[data-testid="route-geometry-move-toggle"]');await wait();states.push(read());
   fire('[data-testid="route-geometry-move-toggle"]');await wait();states.push(read());
   fire('[data-testid="route-tools-group-toggle-topology"]');await wait();states.push(read());
   fire('[data-testid="route-tools-group-toggle-topology"]');await wait();states.push(read());
   return {clicks,states};
  });
  console.log('TOPO_TOGGLE_SEQUENCE',JSON.stringify({viewport,...toggles}));
  expect(toggles.states.length).toBe(5);
  // move open -> closed -> open
  expect(toggles.states[1]!.split('|')[0]).toBe('0');
  expect(toggles.states[2]!.split('|')[0]).toBe('1');
  // Topology is already open from the 5s sampling: it must close, then reopen,
  // and the move group must stay open across both topology clicks.
  expect(toggles.states[3]!.split('|')[1]).toBe('0');
  expect(toggles.states[4]!.split('|')[1]).toBe('1');
  expect(toggles.states[3]!.split('|')[0]).toBe('1');
  expect(toggles.states[4]!.split('|')[0]).toBe('1');

  // Correctness preserved: 33 steps, save and exit reachable.
  await expect(page.getByTestId('route-steps-trigger')).toContainText(`路径步骤 ${storedCount}`);
  await expect(page.getByTestId('route-save')).toBeVisible();
  await expect(page.getByTestId('route-exit')).toBeVisible();
  await page.getByTestId('route-exit').click();
  await expect(page.getByTestId('route-editor')).toHaveCount(0);

  const overflow=await page.evaluate(()=>({h:document.documentElement.scrollWidth-document.documentElement.clientWidth,v:document.documentElement.scrollHeight-document.documentElement.clientHeight}));
  expect(overflow.h).toBeLessThanOrEqual(1);
  console.log('TOPO_LAYOUT_OK',JSON.stringify({viewport,...overflow,steps:storedCount}));
 });
}
