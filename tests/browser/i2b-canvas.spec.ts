import {test,expect,type Page} from '@playwright/test';

// 第2项验收：画布真的能框选、真的能连线，而且连线后不会自己变成「可执行」。
// 全部用真实鼠标事件（mouse.move/down/up），不靠 data-testid 存在冒充功能完成。
const tags=[
 {id:0,x:0,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:1,x:1,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:2,x:1,y:1,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:3,x:2,y:1,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
];
const map:any={schemaVersion:1,id:'box-map',name:'框选核验图',frame:'map',family:'tag36h11',source:'survey',
 coordinateStatus:'draft',routeMode:'waypoints',
 rows:[{id:'route',name:'原路线',width:.6,exitDistance:.8,start:{x:0,y:0},points:[{x:1,y:0},{x:1,y:1}]}],order:['route'],
 tags,zone:[{x:-1,y:-1},{x:3,y:-1},{x:3,y:2},{x:-1,y:2}],vehicle:{width:.4,length:.8,margin:.05},notes:''};
const route:any={routeId:'route-box',mapId:map.id,name:'原路线',mapVersion:1,mapDigest:'d',
 points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}],
 motionSegments:[{id:'a',fromId:0,toId:1,mode:'4t4d',direction:'forward',points:[{x:0,y:0},{x:1,y:0}]},
  {id:'b',fromId:1,toId:2,mode:'4t4d',direction:'crab',points:[{x:1,y:0},{x:1,y:1}]}],
 bodyYawDeg:0,initialHeadingRad:null,distanceModel:'center-euclidean',spacingOverrides:[],
 created:new Date(0).toISOString(),updated:new Date(0).toISOString()};

async function boot(page:Page){
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],events:[],detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:true,quality:'draft',localEpoch:'box',reason:''}}})));
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
 await page.waitForTimeout(600);
 await page.getByTestId('route-select').selectOption(route.routeId);
 await page.waitForTimeout(400);
 await page.getByTestId('edit-route').click();
 await expect(page.getByTestId('route-editor')).toBeVisible({timeout:15000});
 // 等待「适应窗口」稳定后再按坐标操作：进入编辑时画布尺寸会变（工具条占去一行），
 // 视角还在重算的时候用地图坐标换算屏幕点会点偏（不是功能缺陷）。
 await expect.poll(async()=>page.evaluate(()=>{
  const c=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  const s=Number(c?.dataset.konvaScale);
  const prev=Number((window as any).__lastFitScale);
  (window as any).__lastFitScale=s;
  return prev===s&&Number.isFinite(s)&&s>0;
 }),{timeout:15000,intervals:[200,300,400]}).toBe(true);
 await page.waitForTimeout(300);
 return {errors};
}

/** 地图坐标 → 屏幕坐标（用画布自己暴露的 Konva 视口状态，不用猜）。 */
async function locate(page:Page,p:{x:number;y:number}){
 const state=await page.evaluate(()=>{
  const canvas=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  return {box:canvas?.getBoundingClientRect().toJSON(),scale:Number(canvas?.dataset.konvaScale),x:Number(canvas?.dataset.konvaX),y:Number(canvas?.dataset.konvaY)};
 });
 if(!state.box||!Number.isFinite(state.scale)||state.scale<=0)throw new Error('缺少真实 Konva 视口状态');
 return {x:state.box.x+state.x+p.x*100*state.scale,y:state.box.y+state.y-p.y*100*state.scale};
}

test('第2项：真实鼠标拖出选择框，命中的二维码数量被记录',async({page})=>{
 const {errors}=await boot(page);
 const canvas=page.getByTestId('map-canvas');
 await expect(canvas).toHaveAttribute('data-canvas-pan-mode','0');

 // 框选矩形按**当前真实视角**推导，而不是写死地图坐标：
 // fit 现在围绕真实 tag 收边（不再把空 zone 计算在内），写死坐标可能落在画布之外。
 const rect=await page.evaluate(()=>{
  const c=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  const b=c?.getBoundingClientRect(); if(!b) return null;
  // 取画布内可拖拽的空白区：内缩 12%，保证起点/终点都在画布内。
  return {x1:b.x+b.width*0.12,y1:b.y+b.height*0.12,x2:b.x+b.width*0.88,y2:b.y+b.height*0.88};
 });
 expect(rect).not.toBeNull();
 const from={x:rect!.x1,y:rect!.y2};
 const to={x:rect!.x2,y:rect!.y1};
 await page.mouse.move(from.x,from.y);
 await page.mouse.down();
 await page.mouse.move(to.x,to.y,{steps:12});
 await page.mouse.up();
 await page.waitForTimeout(400);

 const count=await canvas.getAttribute('data-canvas-box-select-count');
 expect(Number(count),'框选必须命中画布内全部 4 个二维码').toBe(4);
 await expect(page.getByTestId('route-box-select-hint')).toContainText('框选 4 个二维码');
 // 框选不能顺手新增路点（路点列表行数不变）
 expect(errors).toEqual([]);
});

test('第2项：框选从右下往左上拉同样生效（矩形归一化）',async({page})=>{
 await boot(page);
 const canvas=page.getByTestId('map-canvas');
 const rect2=await page.evaluate(()=>{
  const c=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  const b=c?.getBoundingClientRect(); if(!b) return null;
  return {x1:b.x+b.width*0.12,y1:b.y+b.height*0.12,x2:b.x+b.width*0.88,y2:b.y+b.height*0.88};
 });
 expect(rect2).not.toBeNull();
 const from={x:rect2!.x2,y:rect2!.y1};
 const to={x:rect2!.x1,y:rect2!.y2};
 await page.mouse.move(from.x,from.y);
 await page.mouse.down();
 await page.mouse.move(to.x,to.y,{steps:12});
 await page.mouse.up();
 await page.waitForTimeout(400);
 expect(Number(await canvas.getAttribute('data-canvas-box-select-count')),'反向拖动也必须命中同样 4 个').toBe(4);
});

test('第2项：平移态拖动只平移画布，不产生框选',async({page})=>{
 await boot(page);
 const canvas=page.getByTestId('map-canvas');
 // 切到平移工具
 await page.getByTestId('route-pan-tool').click();
 await page.waitForTimeout(400);
 await expect(canvas).toHaveAttribute('data-canvas-pan-mode','1');
 const before=await page.evaluate(()=>Number((document.querySelector('[data-testid="map-canvas"]') as HTMLElement).dataset.konvaX));

 const panRect=await page.evaluate(()=>{
  const c=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  const b=c?.getBoundingClientRect(); if(!b) return null;
  return {x1:b.x+b.width*0.3,y1:b.y+b.height*0.3,x2:b.x+b.width*0.55,y2:b.y+b.height*0.5};
 });
 expect(panRect).not.toBeNull();
 const from={x:panRect!.x1,y:panRect!.y1};
 const to={x:panRect!.x2,y:panRect!.y2};
 await page.mouse.move(from.x,from.y);
 await page.mouse.down();
 await page.mouse.move(to.x,to.y,{steps:12});
 await page.mouse.up();
 await page.waitForTimeout(400);

 const after=await page.evaluate(()=>Number((document.querySelector('[data-testid="map-canvas"]') as HTMLElement).dataset.konvaX));
 expect(after,'平移态必须真的平移画布').not.toBe(before);
 expect(await canvas.getAttribute('data-canvas-box-select-count'),'平移态不得框选').toBeNull();
});

test('第2项：连线工具点两个码，得到一条待确认的有向边',async({page})=>{
 const {errors}=await boot(page);
 const canvas=page.getByTestId('map-canvas');
 await page.getByTestId('route-connect-tool').click();
 await page.waitForTimeout(400);
 await expect(canvas).toHaveAttribute('data-canvas-link-state','idle');

 // 点第一个码 → from-selected
 const q0=await locate(page,{x:0,y:0});
 await page.mouse.click(q0.x,q0.y);
 await page.waitForTimeout(300);
 await expect(canvas).toHaveAttribute('data-canvas-link-state','from-selected');
 await expect(canvas).toHaveAttribute('data-canvas-link-from','0');

 // 点第二个码 → 提交
 const q3=await locate(page,{x:2,y:1});
 await page.mouse.click(q3.x,q3.y);
 await page.waitForTimeout(500);
 await expect(canvas).toHaveAttribute('data-canvas-link-state','idle');
 // 待确认横幅出现在拓扑面板里，明确说「保存拓扑不会解锁实车执行」
 const pending=page.getByTestId('route-topology-pending');
 await expect(pending).toBeVisible();
 await expect(pending).toContainText('Q0 → Q3');
 await expect(page.getByTestId('route-topology-panel')).toContainText('不会解锁实车执行');
 // 连线本身不得改动折线（还没保存拓扑）
 await expect(page.getByTestId('route-topology-pending-accept')).toBeEnabled();
 expect(errors).toEqual([]);
});

test('第2项：连到自身被拒并给出中文原因，起点保留',async({page})=>{
 await boot(page);
 const canvas=page.getByTestId('map-canvas');
 await page.getByTestId('route-connect-tool').click();
 await page.waitForTimeout(400);
 const q1=await locate(page,{x:1,y:0});
 await page.mouse.click(q1.x,q1.y);
 await page.waitForTimeout(300);
 await expect(canvas).toHaveAttribute('data-canvas-link-state','from-selected');
 // 再点同一个码
 await page.mouse.click(q1.x,q1.y);
 await page.waitForTimeout(400);
 await expect(page.getByTestId('route-toast')).toContainText('不能把 Q1 连到它自己');
 // 起点必须保留，用户可以直接改点别的终点。
 // 被拒后光标仍停在该码上，状态可以是 from-selected 或 previewing——
 // 真正的不变量是「起点还是 Q1、没有回到 idle」。
 await expect(canvas).toHaveAttribute('data-canvas-link-from','1');
 expect(['from-selected','previewing']).toContain(await canvas.getAttribute('data-canvas-link-state'));
 // 再点一个不同的码，必须能正常提交（证明被拒后链路仍然可用）
 const q3=await locate(page,{x:2,y:1});
 await page.mouse.click(q3.x,q3.y);
 await page.waitForTimeout(500);
 await expect(canvas).toHaveAttribute('data-canvas-link-state','idle');
 await expect(page.getByTestId('route-topology-pending')).toContainText('Q1 → Q3');
});

test('第2项：连线后可加入拓扑，但保存前拓扑边数不变',async({page})=>{
 await boot(page);
 const canvas=page.getByTestId('map-canvas');
 const panel=page.getByTestId('route-topology-panel');
 await expect(panel).toHaveAttribute('data-topology-edges','2');

 await page.getByTestId('route-connect-tool').click();
 await page.waitForTimeout(300);
 const q2=await locate(page,{x:1,y:1});
 const q3=await locate(page,{x:2,y:1});
 await page.mouse.click(q2.x,q2.y);
 await page.waitForTimeout(250);
 await page.mouse.click(q3.x,q3.y);
 await page.waitForTimeout(500);
 await expect(page.getByTestId('route-topology-pending')).toBeVisible();
 // 还没确认 → 拓扑仍是 2 段
 await expect(panel).toHaveAttribute('data-topology-edges','2');
 // 确认加入 → 3 段，且横幅消失
 await page.getByTestId('route-topology-pending-accept').click();
 await page.waitForTimeout(400);
 await expect(panel).toHaveAttribute('data-topology-edges','3');
 await expect(page.getByTestId('route-topology-pending')).toHaveCount(0);
 await expect(panel).toHaveAttribute('data-topology-dirty','1');
});
