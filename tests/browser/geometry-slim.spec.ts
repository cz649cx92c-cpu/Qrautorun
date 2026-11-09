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


test('只读几何信息删除且操作、拓扑、33步、保存退出保留',async({page})=>{
 await mock(page);
 await selectMapAndRoute(page);
 await enterEditorAndOpenSteps(page);
 const panel=page.getByTestId('route-geometry-panel');
 // DOM 中彻底删除，不用折叠或 display:none 冒充移除。
 await expect(panel).toHaveCount(1);
 for(const id of ['route-geometry-summary','route-geometry-diagnostics','route-geometry-diag-legs','route-geometry-validate'])
  await expect(page.getByTestId(id)).toHaveCount(0);
 await expect(panel.locator('.rg-head,.rg-hint')).toHaveCount(0);
 for(const text of ['路径几何','诊断与校验只读','码到码段','吸附端点','未绑定端点','沿途经过的码','未使用的码','逐段绑定'])
  await expect(panel).not.toContainText(text);
 await expect(panel.locator(':scope > section').first()).toHaveAttribute('data-testid','route-geometry-grid');
 for(const id of ['route-geometry-grid','route-geometry-insert','route-geometry-remove','route-geometry-move','route-geometry-equalize'])
  await expect(page.getByTestId(id)).toHaveCount(1);
 await expect(page.getByTestId('route-topology-panel')).toHaveCount(1);
 await expect(page.getByTestId('route-topology-add-from')).toHaveCount(1);
 await expect(page.getByTestId('route-topology-add-confirm')).toHaveCount(1);
 await expect(page.getByTestId('route-steps-popover')).toContainText('路径步骤 33');
 await expect(page.getByTestId('route-steps-popover').locator('tbody tr')).toHaveCount(33);
 await expect(page.getByTestId('route-save')).toBeVisible();
 await expect(page.getByTestId('route-exit')).toBeVisible();
 console.log('PAGE_CHECK_OK: readonly nodes absent; first section grid; geometry operations and topology retained; steps=33; save/exit visible');
});
