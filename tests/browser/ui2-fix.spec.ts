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

test('需求2：编辑旧路径时全部 33 步完整加载、首末可达、动作语义保留、刷新不丢',async({page})=>{
 await mock(page);
 await selectMapAndRoute(page);
 const popover=await enterEditorAndOpenSteps(page);
 const rows=popover.locator('tbody tr');
 await expect(rows).toHaveCount(storedCount);
 // 第一步：起点。
 await expect(rows.first()).toContainText('起点');
 // 动作语义：真实分段含 12 段倒车、3 段平移、转向前进——步骤表必须能看到它们。
 const reverseRows=await rows.filter({hasText:'倒车'}).count();
 expect(reverseRows,`倒车步骤数（真实分段 12 段倒车）`).toBeGreaterThanOrEqual(10);
 await expect(rows.filter({hasText:/平移/}).first()).toBeVisible();
 await expect(rows.filter({hasText:'转向前进'}).first()).toBeVisible();
 // 折返访问未被坐标去重：路线回到起点坐标 (0,2.3)，首行与末行都落在 Q032 组。
 await expect(rows.first()).toContainText('Q032');
 const lastRow=rows.nth(storedCount-1);
 await expect(lastRow).toContainText('Q032');
 // 列表从第一步到最后一步可到达：滚动容器到底后最后一行可见。
 const scroll=popover.locator('.route-commands-scroll');
 await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight;});
 await expect(lastRow).toBeVisible();
 // 刷新不丢步骤：重载后重新进入，仍为 33 步。
 await page.reload();
 await selectMapAndRoute(page);
 const popover2=await enterEditorAndOpenSteps(page);
 await expect(popover2.locator('tbody tr')).toHaveCount(storedCount);
});

async function canvasState(page:Page){
 return await page.evaluate(()=>{
  const stage=(window as unknown as {__stage?:any}).__stage;
  if(!stage)throw new Error('Konva stage 未暴露（__stage 缺失）');
  const labels:{name:string;visible:boolean}[]=[];
  stage.find('Text').forEach((n:any)=>{const name=String(n.name());if(name.startsWith('segment-label-'))labels.push({name,visible:!!n.visible()});});
  const arrows=stage.find('Arrow').filter((n:any)=>String(n.name()).startsWith('travel-')).length;
  const tagLabels=stage.find('Text').filter((n:any)=>String(n.name()).startsWith('tag-label-')&&n.visible()).length;
  return {labels,arrows,tagLabels,scale:stage.scaleX()};
 });
}

/** 世界坐标（米，y 向上）→ 页面坐标：Konva 绝对变换 + 画布盒子偏移。 */
async function worldToScreen(page:Page,worldX:number,worldY:number){
 return await page.evaluate(([wx,wy])=>{
  const stage=(window as unknown as {__stage?:any}).__stage;
  const abs=stage.getAbsoluteTransform().point({x:wx,y:wy});
  const b=document.querySelector('[data-testid=map-canvas]')!.getBoundingClientRect();
  return {x:b.left+abs.x,y:b.top+abs.y,sx:abs.x,sy:abs.y,box:{left:b.left,top:b.top,width:b.width,height:b.height},scale:stage.scaleX()};
 },[worldX,worldY] as [number,number]);
}

test('需求1：导航地图段动作标签常态隐藏，悬停/选中按需显示，B编号与方向箭头保留',async({page})=>{
 await mock(page);
 await selectMapAndRoute(page);
 await page.waitForTimeout(400);
 // 常态：所有段标签（步骤·4T4D 前进/倒车/平移）不可见；旧实现在 scale>=0.9 会全部常驻。
 let state=await canvasState(page);
 expect(state.labels.length).toBe(storedSegments);
 expect(state.labels.every(l=>!l.visible),`常态应全部隐藏，实际点亮 ${state.labels.filter(l=>l.visible).length}`).toBe(true);
 // 常态保留元素：方向箭头与 B 组编号仍在。
 expect(state.arrows).toBeGreaterThanOrEqual(20);
 expect(state.tagLabels).toBeGreaterThanOrEqual(10);
 // 本图尺寸小，初始 fit 缩放即高于旧显示阈值 0.9：直接在此缩放下断言「高于阈值仍隐藏」。
 expect(state.scale,`初始缩放 ${state.scale} 应高于旧阈值 0.9 以覆盖回归断言`).toBeGreaterThan(0.9);
 // 悬停 32→96 段（中点离最近二维码 0.30m，不会被码热区抢占）→ 仅该段标签点亮。
 const seg=route.motionSegments[0]!;
 const mid=seg.points[Math.floor(seg.points.length/2)]!;
 const target=await worldToScreen(page,mid.x,mid.y);
 // 位置必须在画布可视区域内。
 expect(target.x).toBeGreaterThan(target.box.left+8);
 expect(target.x).toBeLessThan(target.box.left+target.box.width-8);
 expect(target.y).toBeGreaterThan(target.box.top+8);
 expect(target.y).toBeLessThan(target.box.top+target.box.height-8);
 // 真实指针路径：从画布左上角缓慢移入目标，途径 mousemove 触发 Konva mouseenter。
 const start={x:target.box.left+6,y:target.box.top+6};
 await page.mouse.move(start.x,start.y);
 await page.waitForTimeout(80);
 await page.mouse.move(target.x,target.y,{steps:10});
 await page.waitForTimeout(300);
 state=await canvasState(page);
 const lit=state.labels.filter(l=>l.visible);
 if(lit.length!==1){
  const debug=await page.evaluate(([px,py,sx,sy])=>{
   const el=document.elementFromPoint(px,py);
   const stage=(window as unknown as {__stage?:any}).__stage;
   let hit=null;try{const n=stage.getIntersection({x:sx,y:sy});hit=n?String(n.name()||n.className()||n.getType()):null;}catch(e){hit='ERR:'+e;}
   return {el:el?el.tagName+'#'+(el.id||'')+'.'+String(el.className).slice(0,50):null,hit};
  },[target.x,target.y,target.sx,target.sy] as [number,number]);
  throw new Error(`悬停未点亮：lit=${lit.length} target=${JSON.stringify(target)} debug=${JSON.stringify(debug)}`);
 }
 // 移开 → 熄灭。
 await page.mouse.move(start.x,start.y,{steps:10});
 await page.waitForTimeout(300);
 state=await canvasState(page);
 expect(state.labels.every(l=>!l.visible)).toBe(true);
 // 单击该段 → 选中后标签常显（按需查看详情）。
 await page.mouse.click(target.x,target.y);
 await page.waitForTimeout(400);
 state=await canvasState(page);
 expect(state.labels.filter(l=>l.visible)).toHaveLength(1);
});
