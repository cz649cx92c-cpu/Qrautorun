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
const route=snap.route;
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

let noMaps=false;
async function mock(page:Page,options:{emptyMaps?:boolean}={}){
 noMaps=options.emptyMaps===true;
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
  if(path==='/api/routes')return req.fulfill({json:[route,{...route,routeId:'route-other-map',mapId:'design-other-map',name:'另一张图的同名路径'}]});
  if(path==='/api/routes/'+route.routeId)return req.fulfill({json:routeSnapshot});
  if(path==='/api/routes/'+route.routeId+'/topology')return req.fulfill({json:topologyResponse});
  if(path==='/api/maps')return req.fulfill({json:noMaps?[]:[{id:map.id,name:map.name,version:1},{id:'design-route-open-probe',name:'第二张测试地图',version:1}]});
  if(path==='/api/maps/design-route-open-probe')return req.fulfill({json:{map:{...map,id:'design-route-open-probe',name:'第二张测试地图'},version:1}});
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


async function openFileMenu(page:Page){
 await page.getByTestId('editor-menu-file').click();
 await expect(page.getByTestId('editor-menu-panel-file')).toBeVisible();
}
async function openEditor(page:Page){
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
}

test('无地图时打开路径为原生禁用灰色',async({page})=>{
 await page.setViewportSize({width:1440,height:960});await mock(page,{emptyMaps:true});
 await page.getByTitle('开始导航').click();
 await openEditor(page);
 await openFileMenu(page);
 const item=page.getByTestId('editor-command-route-open');
 await expect(item).toBeVisible();
 await expect(item).toBeDisabled();
 await expect(item).toHaveAttribute('aria-disabled','true');
 const style=await item.evaluate(el=>({color:getComputedStyle(el).color,opacity:getComputedStyle(el).opacity,cursor:getComputedStyle(el).cursor}));
 const enabledStyle=await page.getByTestId('editor-command-file-open-map').evaluate(el=>({color:getComputedStyle(el).color}));
 expect(style.color).not.toBe(enabledStyle.color);
 await item.click({force:true}).catch(()=>{});
 await expect(page.getByTestId('route-open-dialog')).toHaveCount(0);
 console.log('ROUTE_OPEN_DISABLED',JSON.stringify({...style,enabledColor:enabledStyle.color}));
});

test('打开地图后启用，同图路径完整进入 33 步且跨图不串用',async({page})=>{
 await page.setViewportSize({width:1440,height:960});await mock(page);
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(map.id);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await page.getByTestId('route-select').selectOption({label:route.name});
 await openEditor(page);
 await openFileMenu(page);
 const item=page.getByTestId('editor-command-route-open');
 await expect(item).toBeEnabled();
 await item.click();
 const dialog=page.getByTestId('route-open-dialog');
 await expect(dialog).toBeVisible();
 const list=page.getByTestId('route-open-list');
 await expect(list).toBeVisible();
 await expect(list.locator('button')).toHaveCount(1);
 await expect(list).not.toContainText('另一张图的同名路径');
 await expect(list).toContainText(route.name);
 await page.getByTestId('route-open-item-'+route.routeId).click();
 await expect(dialog).toHaveCount(0);
 await expect(page.getByTestId('route-editor')).toBeVisible();
 const trigger=page.getByTestId('route-steps-trigger');
 await expect(trigger).toContainText('路径步骤 '+storedCount);
 await trigger.click();
 const popover=page.getByTestId('route-steps-popover');
 await expect(popover.locator('tbody tr')).toHaveCount(storedCount);
 await expect(page.getByTestId('route-heading-value')).toContainText('270');
 await expect(page.getByTestId('route-save')).toBeVisible();
 await expect(page.getByTestId('route-exit')).toBeVisible();
 console.log('ROUTE_OPEN_OK',JSON.stringify({steps:storedCount,listed:1,name:route.name}));
});

test('有地图无路径显示明确空态与新建入口',async({page})=>{
 await page.setViewportSize({width:1440,height:960});await mock(page);
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption('design-route-open-probe');
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await openEditor(page);
 await openFileMenu(page);
 const item=page.getByTestId('editor-command-route-open');
 await expect(item).toBeEnabled();
 await item.click();
 const dialog=page.getByTestId('route-open-dialog');
 await expect(dialog).toBeVisible();
 await expect(page.getByTestId('route-open-empty')).toBeVisible();
 await expect(page.getByTestId('route-open-empty')).toContainText('暂无路径');
 await expect(page.getByTestId('route-open-list')).toHaveCount(0);
 await expect(page.getByTestId('route-open-new')).toBeEnabled();
 await page.getByTestId('route-open-close').click();
 await expect(dialog).toHaveCount(0);
 console.log('ROUTE_OPEN_EMPTY_OK');
});

test('取消/Escape 不改变草稿，确认后才切换',async({page})=>{
 await page.setViewportSize({width:1440,height:960});await mock(page);
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(map.id);
 await page.getByTestId('route-select').selectOption({label:route.name});
 await openEditor(page);
 await openFileMenu(page);
 await page.getByTestId('editor-command-route-open').click();
 await expect(page.getByTestId('route-open-dialog')).toBeVisible();
 await page.getByTestId('route-open-close').click();
 await expect(page.getByTestId('route-open-dialog')).toHaveCount(0);
 await expect(page.getByTestId('route-heading-value')).toContainText('270');
 // A real geometry edit makes the existing dirty flag true.
 await page.getByTestId('route-more').click();
 await page.getByTestId('route-more-auto-chain').click();
 await expect(page.locator('html')).toHaveAttribute('data-editor-dirty','1');
 await openFileMenu(page);
 await page.getByTestId('editor-command-route-open').click();
 await page.keyboard.press('Escape');
 await expect(page.getByTestId('route-open-dialog')).toHaveCount(0);
 await expect(page.locator('html')).toHaveAttribute('data-editor-dirty','1');
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await openFileMenu(page);
 await page.getByTestId('editor-command-route-open').click();
 await page.getByTestId('route-open-item-'+route.routeId).click();
 const confirm=page.getByTestId('route-open-confirm');
 await expect(confirm).toBeVisible();
 await page.getByTestId('route-open-cancel').click();
 await expect(confirm).toHaveCount(0);
 await expect(page.locator('html')).toHaveAttribute('data-editor-dirty','1');
 // Cancel returns to the picker with the draft intact; close it explicitly.
 await expect(page.getByTestId('route-open-dialog')).toBeVisible();
 await page.getByTestId('route-open-close').click();
 await expect(page.getByTestId('route-open-dialog')).toHaveCount(0);
 await expect(page.locator('html')).toHaveAttribute('data-editor-dirty','1');
 await openFileMenu(page);
 await page.getByTestId('editor-command-route-open').click();
 await page.getByTestId('route-open-item-'+route.routeId).click();
 await page.getByTestId('route-open-discard').click();
 await expect(page.getByTestId('route-open-confirm')).toHaveCount(0);
 await expect(page.getByTestId('route-steps-trigger')).toContainText('路径步骤 '+storedCount);
 await expect(page.getByTestId('route-save')).toBeVisible();
 await expect(page.getByTestId('route-exit')).toBeVisible();
 const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1}));
 expect(layout.overflow).toBe(false);
 console.log('ROUTE_OPEN_CONFIRM_OK',JSON.stringify({restored:route.name,steps:storedCount,overflow:layout.overflow}));
});


test('路径编辑布局：当前点操作展开，其余操作折叠且左栏独立滚动',async({page})=>{
 await page.setViewportSize({width:1024,height:768});await mock(page);
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(map.id);
 await page.getByTestId('route-select').selectOption({label:route.name});
 await openEditor(page);
 const routeGroup=page.getByTestId('route-tools-group-route');
 await expect(routeGroup).toHaveAttribute('data-open','1');
 await expect(page.getByTestId('route-tools-group-map')).toHaveAttribute('data-open','0');
 await expect(page.getByTestId('route-tools-group-tags')).toHaveAttribute('data-open','0');
 await expect(page.getByTestId('route-tools-group-topology')).toHaveAttribute('data-open','0');
 await expect(page.getByTestId('route-steps-summary')).toContainText(`${storedCount}`);
 await expect(page.getByTestId('route-steps-summary')).toContainText('m');
 await page.getByTestId('route-tools-group-toggle-topology').click();
 const geometry=page.getByTestId('route-geometry-panel');
 await expect(geometry).toBeVisible();
 await expect(page.getByTestId('route-geometry-move')).toHaveAttribute('data-open','1');
 for(const id of ['grid','insert','remove','equalize','translate','rotate','mirror']){
  await expect(page.getByTestId('route-geometry-'+id)).toHaveAttribute('data-open','0');
 }
 const metrics=await page.evaluate(()=>{
  const left=document.querySelector('[data-testid="editor-shell-left"]') as HTMLElement|null;
  const body=document.querySelector('[data-testid="route-tools-body"]') as HTMLElement|null;
  const doc=document.documentElement, scrolling=document.scrollingElement as HTMLElement;
  const target=(body&&body.scrollHeight>body.clientHeight?body:left)!;
  const before={docTop:scrolling.scrollTop,bodyTop:document.body.scrollTop,leftTop:left?.scrollTop??0,targetHeight:target?.clientHeight??0,targetScrollHeight:target?.scrollHeight??0,overflow:getComputedStyle(target).overflowY,hOverflow:doc.scrollWidth-doc.clientWidth};
  if(target){target.scrollTop=Math.min(120,Math.max(0,target.scrollHeight-target.clientHeight));}
  return {...before,afterTargetTop:target?.scrollTop??0,afterDocTop:scrolling.scrollTop,afterBodyTop:document.body.scrollTop};
 });
 expect(metrics.hOverflow).toBeLessThanOrEqual(1);
 expect(metrics.targetScrollHeight).toBeGreaterThanOrEqual(metrics.targetHeight);
 expect(['auto','scroll']).toContain(metrics.overflow);
 expect(metrics.afterDocTop).toBe(0);expect(metrics.afterBodyTop).toBe(0);
 console.log('LAYOUT_OK',JSON.stringify(metrics));
});
