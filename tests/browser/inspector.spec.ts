import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FieldMap,Point} from '../../web/shared/model';
import {topologyFromSegments,topologySummary} from '../../web/shared/route-topology';

// 只读旧路径快照：真实生产数据「手动铺码图-10300759 v1 + 办公室（33 点 / 32 段）」，
// 通过 mock 接口注入浏览器，不写任何生产数据、不触发导航指令。
const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {
 map:FieldMap;version:number;route:{routeId:string;mapId:string;name:string;mapVersion:number;mapDigest:string;points:Point[];motionSegments:{id:string;fromId:number;toId:number;mode:string;direction:string;strategy?:string|null;points:Point[]}[];bodyYawDeg:number;initialHeadingRad:number|null;distanceModel:string;spacingOverrides:unknown[];created:string;updated:string};
};
const map=snap.map;
const route={...snap.route,points:snap.route.points.filter(p=>!snap.map.tags.filter(t=>[300,32].includes(t.id)).some(t=>Math.hypot(t.x-p.x,t.y-p.y)<0.01))};
const storedCount=route.points.length; // 33
const storedSegments=route.motionSegments.length; // 32
const path:Point[]=route.motionSegments.length?[route.motionSegments[0]!.points[0]!,...route.motionSegments.flatMap(s=>s.points.slice(1))]:route.points;
const routeSnapshot={...route,route,map:{...map,routeMode:'waypoints' as const,rows:[{id:'route-1',name:route.name,width:.6,exitDistance:.8,start:path[0]!,points:path.slice(1)}],order:['route-1'],motionSegments:route.motionSegments,tags:map.tags.map(t=>({...t,rowId:'route-1'}))},version:1,acceptance:null};
const task={id:'task-office',name:'办公室任务',mapId:map.id,mapVersion:1,routeId:route.routeId,rowOrder:[],enabled:true,forwardSpeed:8,reverseSpeed:6,lateralSpeed:5,endWaitSeconds:2};
// 旧路径也有拓扑：与后端同源（shared 纯函数）从 motionSegments 还原，而不是给空拓扑。
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
  chassis:{connected:true},sensors:{camera:'位姿已计算 / 待同步',imu:'在线',odom:'在线',localization:'局部已融合 / 待标定'},
  conditions:[{id:'execution',label:'实体执行许可',ready:false}],events:[],
  detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:true,quality:'draft',localEpoch:'ui2-origin',reason:''}}})));
 await page.routeWebSocket('**/ws/camera',ws=>ws.send(JSON.stringify({type:'camera',name:'HBVCAM',profile:'720p',profiles:[],error:''})));
 await page.route('**/api/**',async req=>{
  const path=new URL(req.request().url()).pathname;
  if(path==='/api/camera/status')return req.fulfill({json:{running:true,present:true,frameAgeMs:10,error:''}});
  if(path==='/api/camera/calibration')return req.fulfill({json:{}});
  if(path==='/api/localization/map')return req.fulfill({json:{anchored:true,mapId:map.id}});
  if(path==='/api/localization/scope')return req.fulfill({json:{phase:'anchored'}});
  if(path==='/api/boards')return req.fulfill({json:[]});
  if(path==='/api/routes')return req.fulfill({json:[route]});
  if(path==='/api/routes/'+route.routeId)return req.fulfill({json:routeSnapshot});
  if(path==='/api/routes/'+route.routeId+'/topology')return req.fulfill({json:topologyResponse});
  if(path==='/api/maps')return req.fulfill({json:[{id:map.id,name:map.name,version:1}]});
  if(path==='/api/maps/'+map.id)return req.fulfill({json:{map,version:1}});
  if(path==='/api/tasks')return req.fulfill({json:[task]});
  if(path==='/api/surveys')return req.fulfill({json:[]});
  if(path.endsWith('/tag-aliases'))return req.fulfill({json:{aliases:[]}});
  observed.unexpected.push(path);return req.fulfill({status:404,json:{error:'Unexpected mocked API: '+path}});
 });
 await page.goto('/');
}

async function selectMapAndRoute(page:Page){
 await page.getByRole('button',{name:'开始导航',exact:true}).click();
 await page.getByTestId('map-select').selectOption(map.id);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await page.getByTestId('route-select').selectOption({label:route.name});
 // 本图路径列表展示存储点数（33 点）——数据链在 API 侧从未丢步骤。
 await expect(page.getByTestId('route-manage-list').getByText(`${storedCount} 点`)).toBeVisible();
}

async function enterEditorAndOpenSteps(page:Page){
 await page.getByTestId('nav-route-edit').click();
 const trigger=page.getByTestId('route-steps-trigger');
 await expect(trigger).toContainText(`路径步骤 ${storedCount}`);
 if(await trigger.isVisible())await trigger.click();
 const popover=page.getByTestId('route-steps-popover');
 await expect(popover).toBeVisible();
 return popover;
}

/** 世界坐标（米，y 向上）→ 页面坐标：Konva 绝对变换 + 画布盒子偏移。 */
async function worldToScreen(page:Page,worldX:number,worldY:number){
 return await page.evaluate(([wx,wy])=>{
  const stage=(window as unknown as {__stage?:any}).__stage;
  const abs=stage.getAbsoluteTransform().point({x:wx*100,y:-wy*100});
  const b=document.querySelector('[data-testid=map-canvas]')!.getBoundingClientRect();
  return {x:b.left+abs.x,y:b.top+abs.y,sx:abs.x,sy:abs.y,box:{left:b.left,top:b.top,width:b.width,height:b.height},scale:stage.scaleX()};
 },[worldX,worldY] as [number,number]);
}


for(const width of [375,1024,1280,1440,1920])test(`浮卡选择与布局 ${width}`,async({page})=>{
 await page.setViewportSize({width,height:960});await mock(page);await selectMapAndRoute(page);
 await page.getByTestId('nav-route-edit').click();await page.getByTestId('route-select-tool').click();
 // Give the narrow canvas its full width, as a user can with the existing layout button.
 if(width===375){const b=page.getByTestId('layout-toggle-left');await b.click();}
 const canvas=page.getByTestId('map-canvas');await expect(canvas).toHaveAttribute('data-route-waypoints',String(route.points.length));
 await expect(page.locator('.draw-hint')).toHaveCount(0);
 await expect(page.getByTestId('editor-shell-inspector')).toHaveCount(0);
 const card=page.getByTestId('route-inspector');await expect(card).toHaveCount(0);
 const before=await canvas.boundingBox();
 await page.getByRole('button',{name:'适应地图',exact:true}).click();
 const selectTag=async(id:number)=>{
  const tag=map.tags.find(t=>t.id===id)!;
  await page.getByRole('button',{name:'放大地图',exact:true}).click();
  const p=await worldToScreen(page,tag.x,tag.y);
  const hit=await page.evaluate(({id,x,y})=>{const stage=(window as any).__stage;const b=document.querySelector('[data-testid=map-canvas]')!.getBoundingClientRect();for(const dy of [0,4,-4,8,-8,12,-12,16,-16,20,-20])for(const dx of [0,4,-4,8,-8,12,-12,16,-16,20,-20]){const node=stage.getIntersection({x:x+dx-b.x,y:y+dy-b.y});let ancestor=node;while(ancestor){if(ancestor.name()==='tag-'+id)return{x:x+dx,y:y+dy};ancestor=ancestor.getParent();}}return null;},{id,x:p.x,y:p.y});if(!hit){console.log('QR_DEBUG',p,await page.evaluate(()=>{const s=(window as any).__stage;return s.find('Group').map((n:any)=>({name:n.name(),pos:n.getAbsolutePosition()})).slice(0,25)}));throw new Error('No visible QR hot area '+id);}await page.mouse.click(hit.x,hit.y);await expect(card).toBeVisible();await expect(card).toContainText('二维码属性');
  await expect(card.locator('dd').first()).toHaveText(String(id));await expect(card).toContainText(`${tag.x.toFixed(2)}, ${tag.y.toFixed(2)}`);
 };
 await selectTag(300);
 const tagBox=await card.boundingBox();expect(tagBox!.height).toBeGreaterThan(60);expect(tagBox!.height).toBeLessThan(230);
 await page.getByTestId('route-inspector-close').click();await expect(card).toHaveCount(0);
 await page.getByTestId('route-properties-toggle').click();await expect(card).toBeVisible();
 await page.getByTestId('route-inspector-close').click();
 // Click actual waypoint handle, using its screen bounds from the rendered Konva stage.
 const handle=await page.evaluate(()=>{
  const stage=(window as any).__stage;const nodes=stage.find('Rect').filter((n:any)=>String(n.name()).startsWith('route-waypoint-hit-'));
  const box=document.querySelector('[data-testid=map-canvas]')!.getBoundingClientRect();
  return nodes.map((n:any)=>{const r=n.getClientRect();return{name:n.name(),x:box.x+r.x+r.width/2,y:box.y+r.y+r.height/2}});
 });
 console.log('HANDLE_NAMES',width,JSON.stringify(handle.slice(0,3)));
 if(!handle.length)throw new Error('No actual rendered waypoint handles found');
 await page.mouse.click(handle[0].x,handle[0].y);await expect(card).toContainText('路点属性');
 const waypointBox=await card.boundingBox();expect(waypointBox!.height).toBeGreaterThanOrEqual(tagBox!.height);
 await page.getByTestId('route-inspector-close').click();await selectTag(32);
 const after=await canvas.boundingBox();expect(after!.width).toBeCloseTo(before!.width,0);
 const layout=await page.evaluate(()=>{
  const box=(s:string)=>{const r=document.querySelector(s)!.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
  return {canvas:box('[data-testid=map-canvas]'),card:box('[data-testid=route-inspector]'),main:box('.editor-shell__main'),row:box('.editor-shell__row'),overflow:document.documentElement.scrollWidth>innerWidth+1};
 });
 expect(layout.overflow).toBe(false);expect(layout.card.x).toBeGreaterThanOrEqual(layout.canvas.x);expect(layout.card.right).toBeLessThanOrEqual(layout.canvas.right);
 expect(layout.main.right).toBeGreaterThanOrEqual(layout.row.right-2);expect(layout.card.width).toBeLessThanOrEqual(280);expect(layout.card.bottom).toBeLessThan(layout.canvas.bottom);
 for(const target of [page.getByTestId('route-save'),page.getByTestId('route-exit'),page.getByRole('button',{name:'放大地图',exact:true}),page.getByRole('button',{name:'缩小地图',exact:true})]){
  await expect(target).toBeVisible();await target.scrollIntoViewIfNeeded();
  const unobscured=await target.evaluate(el=>{const r=el.getBoundingClientRect();const stack=document.elementsFromPoint(r.x+r.width/2,r.y+r.height/2);return stack.length>0&&(el===stack[0]||el.contains(stack[0]));});expect(unobscured).toBe(true);
 }
 console.log('INSPECTOR_LAYOUT',width,JSON.stringify({...layout,tagHeight:tagBox!.height,waypointHeight:waypointBox!.height}));
});
