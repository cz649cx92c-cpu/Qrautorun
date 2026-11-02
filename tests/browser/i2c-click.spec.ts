import {test,expect,type Page} from '@playwright/test';

// 第2项回归：路径编辑的真实鼠标验收。
// 覆盖用户反馈的「点不进去 / 选不中路径点」，以及工具互斥、加点与拖动的区分。
// 全部用真实 mouse.move/down/up 与 mouse.click，不靠 data-testid 存在冒充功能完成。
const tags=[
 {id:0,x:0,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:1,x:1,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:2,x:1,y:1,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 // 第 4 个码不在路径上：用来验证「选择态点二维码 → 选中该码」，
 // 且它与任何路点都不重合，不会被路点手柄抢先接管点击。
 {id:3,x:0.5,y:0.7,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
];
const map:any={schemaVersion:1,id:'click-map',name:'点选核验图',frame:'map',family:'tag36h11',source:'survey',
 coordinateStatus:'draft',routeMode:'waypoints',
 rows:[{id:'route',name:'原路线',width:.6,exitDistance:.8,start:{x:0,y:0},points:[{x:1,y:0},{x:1,y:1}]}],order:['route'],
 tags,zone:[{x:-1,y:-1},{x:2,y:-1},{x:2,y:2},{x:-1,y:2}],vehicle:{width:.4,length:.8,margin:.05},notes:''};
const route:any={routeId:'route-click',mapId:map.id,name:'原路线',mapVersion:1,mapDigest:'d',
 points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}],
 motionSegments:[{id:'a',fromId:0,toId:1,mode:'4t4d',direction:'forward',points:[{x:0,y:0},{x:1,y:0}]},
  {id:'b',fromId:1,toId:2,mode:'4t4d',direction:'crab',points:[{x:1,y:0},{x:1,y:1}]}],
 bodyYawDeg:0,initialHeadingRad:null,distanceModel:'center-euclidean',spacingOverrides:[],
 created:new Date(0).toISOString(),updated:new Date(0).toISOString()};

async function boot(page:Page){
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],events:[],detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:true,quality:'draft',localEpoch:'click',reason:''}}})));
 await page.routeWebSocket('**/ws/camera',()=>{});
 await page.route('**/api/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path==='/api/maps')return r.fulfill({json:[{id:map.id,name:map.name,version:1}]});
  if(path==='/api/maps/'+map.id)return r.fulfill({json:{map,version:1,acceptance:{kind:'office_test',accepted:true,digestValid:true}}});
  if(path==='/api/maps/'+map.id+'/tag-aliases')return r.fulfill({json:{mapId:map.id,mapVersion:1,aliases:[],disclaimer:'x'}});
  if(path==='/api/routes')return r.fulfill({json:[route]});
  if(path==='/api/tasks')return r.fulfill({json:[{id:'t',name:'t',mapId:map.id,mapVersion:1,routeId:route.routeId,rowOrder:['route'],forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true}]});
  if(path==='/api/surveys'||path==='/api/boards')return r.fulfill({json:[]});
  if(path==='/api/camera/status')return r.fulfill({json:{running:false,present:false}});
  if(path==='/api/localization/map')return r.fulfill({json:{phase:'anchored'}});
  if(path==='/api/localization/scope')return r.fulfill({json:{phase:'anchored'}});
  if(path==='/api/routes/'+route.routeId)return r.fulfill({json:{...route,route,map,version:1,acceptance:{kind:'office_test',accepted:true,digestValid:true}}});
  if(path==='/api/routes/'+route.routeId+'/topology')return r.fulfill({json:{routeId:route.routeId,mapId:map.id,mapVersion:1,stored:false,topology:{nodes:[{tagId:0},{tagId:1},{tagId:2}],edges:[{fromId:0,toId:1,occurrence:1,mode:'4t4d',direction:'forward'},{fromId:1,toId:2,occurrence:1,mode:'crab',direction:'lateral'}]},summary:[],issues:[],strategyChoices:{choices:[],issues:[]},disclaimer:'保存拓扑不会解锁实车执行。'}});
  return r.fulfill({json:{}});
 });
 await page.goto('/');
 await page.waitForTimeout(800);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(400);
 await page.getByTestId('map-select').selectOption(map.id);
 await page.waitForTimeout(700);
 return {errors};
}

/** 地图坐标 → 屏幕坐标（读画布自己暴露的真实 Konva 视口）。 */
async function locate(page:Page,p:{x:number;y:number}){
 const st=await page.evaluate(()=>{
  const c=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  return {box:c?.getBoundingClientRect().toJSON(),scale:Number(c?.dataset.konvaScale),x:Number(c?.dataset.konvaX),y:Number(c?.dataset.konvaY)};
 });
 if(!st.box||!Number.isFinite(st.scale)||st.scale<=0)throw new Error('缺少 Konva 视口状态: '+JSON.stringify(st));
 return {x:st.box.x+st.x+p.x*100*st.scale,y:st.box.y+st.y-p.y*100*st.scale};
}

const state=async(page:Page)=>page.evaluate(()=>{
 const c=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
 const p=(n:string)=>c?.getAttribute(n)??null;
 return {selected:p('data-canvas-selected'),routeSelected:p('data-route-selected'),waypoints:p('data-route-waypoints'),
  drawMode:p('data-canvas-draw-mode'),panMode:p('data-canvas-pan-mode'),mode:p('data-canvas-mode'),tool:p('data-canvas-tool'),
  badge:document.querySelector('[data-testid="editor-mode-badge"]')?.textContent?.trim()??null,
  steps:document.querySelectorAll('.route-commands-table tbody tr').length};
});

async function enterRouteEditing(page:Page){
 await page.getByTestId('route-select').selectOption(route.routeId);
 await page.waitForTimeout(400);
 await page.getByTestId('edit-route').click();
 await expect(page.getByTestId('route-editor')).toBeVisible({timeout:15000});
 // 等待「适应窗口」真正稳定：fit 由 ResizeObserver + 图层重建驱动，
 // 视角还在动的时候按坐标点会因为换算基准变化而点偏（不是功能缺陷）。
 await expect.poll(async()=>page.evaluate(()=>{
  const c=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  const s=Number(c?.dataset.konvaScale);
  // @ts-ignore 记录上一帧 scale，用于判定稳定
  const prev=Number((window as any).__lastFitScale);
  (window as any).__lastFitScale=s;
  return prev===s&&Number.isFinite(s)&&s>0;
 }),{timeout:15000,intervals:[200,300,400]}).toBe(true);
 await page.waitForTimeout(300);
}

test('第2项：进入路径编辑默认是选择工具，点二维码能选中并读出选中态',async({page})=>{
 const {errors}=await boot(page);
 await enterRouteEditing(page);

 // 默认工具必须是「选择」——这是用户「点不进去」的根因，之前的默认是「加点」
 await expect(page.getByTestId('route-select-tool')).toHaveAttribute('aria-pressed','true');
 const s0=await state(page);
 expect(s0.badge).toBe('选择');
 expect(s0.drawMode).toBe('0');
 expect(s0.panMode).toBe('0');
 // 已有 3 个路点（来自保存的路径），一个都没被选中
 expect(s0.waypoints).toBe('3');
 expect(s0.routeSelected).toBe('-1');

 // 点一个不在路径上的二维码 → 选中态必须变成该真实 tagId。
 // 注意不能点 (1,0)/(1,1)/(0,0)：那里有路点手柄，路点优先接管点击是对的。
 const at=await locate(page,{x:0.5,y:0.7});
 await page.mouse.click(at.x,at.y);
 await page.waitForTimeout(500);
 const s1=await state(page);
 expect(s1.selected,'点二维码必须真的选中它').toBe('3');
 // 选择态点码绝不追加路点
 expect(s1.waypoints,'选择态点码不得新增路点').toBe('3');
 expect(errors).toEqual([]);
});

test('第2项：选择态点路点能选中，并同步到路径步骤的选中行',async({page})=>{
 await boot(page);
 await enterRouteEditing(page);
 const s0=await state(page);
 expect(s0.waypoints).toBe('3');

 // 点第一个路点（0,0 位置有方块手柄）
 const at=await locate(page,{x:0,y:0});
 await page.mouse.click(at.x,at.y);
 await page.waitForTimeout(600);
 const s1=await state(page);
 expect(s1.routeSelected,'点路点必须把它设为选中').toBe('0');
 expect(s1.waypoints,'选中不得增删路点').toBe('3');

 // 再点第三个路点 → 选中跟着变
 const at2=await locate(page,{x:1,y:1});
 await page.mouse.click(at2.x,at2.y);
 await page.waitForTimeout(600);
 expect((await state(page)).routeSelected,'点另一个路点必须换选中').toBe('2');
});

test('第2项：拖动路点改变坐标，且拖动后不误加点',async({page})=>{
 await boot(page);
 await enterRouteEditing(page);
 const before=await state(page);
 // 打开路径步骤浮窗读坐标（真实 DOM）
 await page.getByTestId('route-steps-trigger').click();
 await expect(page.getByTestId('route-steps-popover')).toBeVisible();
 const coords=()=>page.locator('.route-commands-table tbody tr td:nth-child(5)').allTextContents();
 expect(await coords()).toEqual(['0.00, 0.00','1.00, 0.00','1.00, 1.00']);
 // 产品语义变化（本轮改动）：路径步骤从「浮在画布上的 absolute 浮窗」改成
 // 「停靠在底部面板内、可调高度的面板」，它**不再覆盖画布**，所以不再需要
 // 「先关掉才能点画布」。这里保留「展开→收起」的真实操作路径，并断言它确实收起，
 // 但不再依赖旧的遮罩前提。
 await page.getByTestId('route-steps-trigger').click();
 await expect(page.getByTestId('route-steps-dock')).toBeHidden();

 // 拖第二个路点（1,0）到 (0.6,0.4)
 const from=await locate(page,{x:1,y:0});
 const to=await locate(page,{x:0.6,y:0.4});

 // 先点一下该路点，确认选中链路通畅，并等图层重建完成再拖
 // （工具/选中变化会重建静态图层，按在一个即将销毁的节点上会吞掉拖动）。
 // 按下点最上层必须是画布本身：浮窗/菜单/左栏都不得盖住可操作区域
 const topTag=await page.evaluate(({x,y})=>{
  const el=document.elementFromPoint(x,y) as HTMLElement|null;
  if(!el)return 'nothing';
  if(el.closest('[data-testid="route-steps-popover"]'))return 'popover-covers-canvas';
  if(el.closest('[data-testid="editor-chrome__"]'))return 'chrome-covers-canvas';
  if(el.tagName==='CANVAS')return 'canvas';
  return el.tagName+'.'+(el.className||'').toString().slice(0,40);
 },{x:from.x,y:from.y});
 expect(topTag,'路点位置最上层必须是画布，不能被浮窗/面板盖住').toBe('canvas');
 await page.mouse.click(from.x,from.y);
 await page.waitForTimeout(600);
 expect((await state(page)).routeSelected,'点路点必须先把它设为选中').toBe('1');
 await page.mouse.move(from.x,from.y);
 await page.mouse.down();
 await page.mouse.move(to.x,to.y,{steps:12});
 await page.mouse.up();
 await page.waitForTimeout(700);

 const after=await state(page);
 const afterCoords=await coords();

 expect(after.waypoints,'拖动不得新增路点（误加点）').toBe(before.waypoints);
 const moved=afterCoords[1]!;
 expect(moved,'路点坐标必须真的变了').not.toBe('1.00, 0.00');
 // 拖动结束必须保持「刚操作的那个点」处于选中，否则右侧属性/步骤高亮对不上
 expect(after.routeSelected,'拖动应保持该路点选中').toBe('1');
});

test('第2项：切到平移后拖画布只平移、不选点；切回选择后又能选中',async({page})=>{
 await boot(page);
 await enterRouteEditing(page);

 // 平移态
 await page.getByTestId('route-pan-tool').click();
 await page.waitForTimeout(500);
 const panState=await state(page);
 expect(panState.badge).toBe('平移');
 expect(panState.panMode).toBe('1');

 const beforeX=await page.evaluate(()=>Number((document.querySelector('[data-testid="map-canvas"]') as HTMLElement).dataset.konvaX));
 const from=await locate(page,{x:0.5,y:0.5});
 const to=await locate(page,{x:1.0,y:0.2});
 await page.mouse.move(from.x,from.y);
 await page.mouse.down();
 await page.mouse.move(to.x,to.y,{steps:12});
 await page.mouse.up();
 await page.waitForTimeout(600);
 const afterX=await page.evaluate(()=>Number((document.querySelector('[data-testid="map-canvas"]') as HTMLElement).dataset.konvaX));
 expect(afterX,'平移态拖动必须真的平移画布').not.toBe(beforeX);
 const panAfter=await state(page);
 expect(panAfter.routeSelected,'平移态不得选中路点').toBe('-1');
 expect(panAfter.waypoints,'平移态不得增删路点').toBe('3');

 // 切回选择 → 又能选中
 await page.getByTestId('route-select-tool').click();
 await page.waitForTimeout(500);
 expect((await state(page)).panMode).toBe('0');
 const at=await locate(page,{x:1,y:1});
 await page.mouse.click(at.x,at.y);
 await page.waitForTimeout(600);
 expect((await state(page)).routeSelected,'切回选择后必须能选中').toBe('2');
});

test('第2项：只有加点模式才追加路点，选择态点空白不新增',async({page})=>{
 await boot(page);
 await enterRouteEditing(page);

 // 选择态点空白：既不新增路点也不选中
 const blank=await locate(page,{x:0.5,y:0.5});
 await page.mouse.click(blank.x,blank.y);
 await page.waitForTimeout(500);
 const sel=await state(page);
 expect(sel.waypoints,'选择态点空白不得新增路点').toBe('3');
 expect(sel.routeSelected).toBe('-1');

 // 加点态点空白：必须新增
 await page.getByTestId('route-draw-tool').click();
 await page.waitForTimeout(500);
 const drawState=await state(page);
 expect(drawState.badge).toBe('加点');
 expect(drawState.drawMode).toBe('1');
 const blank2=await locate(page,{x:0,y:0.6});
 await page.mouse.click(blank2.x,blank2.y);
 await page.waitForTimeout(600);
 const added=await state(page);
 expect(Number(added.waypoints),'加点态点空白必须追加路点').toBe(4);
});
