import {test,expect,type Page} from '@playwright/test';

// 第5项：多视口真实 DOM 度量。
// 只测量，不写库、不发运动指令、不保存路径。
const tags=[
 {id:0,x:0,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:1,x:1,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:2,x:1,y:1,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:3,x:0.5,y:0.7,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
];
const map:any={schemaVersion:1,id:'ui-map',name:'多视口核验图',frame:'map',family:'tag36h11',source:'survey',
 coordinateStatus:'draft',routeMode:'waypoints',
 rows:[{id:'route',name:'原路线',width:.6,exitDistance:.8,start:{x:0,y:0},points:[{x:1,y:0},{x:1,y:1}]}],order:['route'],
 tags,zone:[{x:-8,y:-8},{x:9,y:-8},{x:9,y:9},{x:-8,y:9}],
 vehicle:{width:.4,length:.8,margin:.05},notes:''};
const route:any={routeId:'ui-route',mapId:map.id,name:'原路线',mapVersion:1,mapDigest:'d',
 points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}],
 motionSegments:[{id:'a',fromId:0,toId:1,mode:'4t4d',direction:'forward',points:[{x:0,y:0},{x:1,y:0}]},
  {id:'b',fromId:1,toId:2,mode:'4t4d',direction:'crab',points:[{x:1,y:0},{x:1,y:1}]}],
 bodyYawDeg:0,initialHeadingRad:null,distanceModel:'center-euclidean',spacingOverrides:[],
 created:new Date(0).toISOString(),updated:new Date(0).toISOString()};

async function boot(page:Page){
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],events:[],detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:true,quality:'draft',localEpoch:'ui',reason:''}}})));
 await page.routeWebSocket('**/ws/camera',()=>{});
 await page.route('**/api/**',async r=>{
  const p=new URL(r.request().url()).pathname;
  if(p==='/api/maps')return r.fulfill({json:[{id:map.id,name:map.name,version:1}]});
  if(p==='/api/maps/'+map.id)return r.fulfill({json:{map,version:1,acceptance:{kind:'office_test',accepted:true,digestValid:true}}});
  if(p==='/api/maps/'+map.id+'/tag-aliases')return r.fulfill({json:{mapId:map.id,mapVersion:1,aliases:[],disclaimer:'x'}});
  if(p==='/api/routes')return r.fulfill({json:[route]});
  if(p==='/api/tasks')return r.fulfill({json:[{id:'t',name:'t',mapId:map.id,mapVersion:1,routeId:route.routeId,rowOrder:['route'],forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true}]});
  if(p==='/api/surveys'||p==='/api/boards')return r.fulfill({json:[]});
  if(p==='/api/camera/status')return r.fulfill({json:{running:false,present:false}});
  if(p==='/api/localization/map')return r.fulfill({json:{phase:'anchored'}});
  if(p==='/api/localization/scope')return r.fulfill({json:{phase:'anchored'}});
  if(p==='/api/routes/'+route.routeId)return r.fulfill({json:{...route,route,map,version:1,acceptance:{kind:'office_test',accepted:true,digestValid:true}}});
  if(p==='/api/routes/'+route.routeId+'/topology')return r.fulfill({json:{routeId:route.routeId,mapId:map.id,mapVersion:1,stored:false,topology:{nodes:[{tagId:0},{tagId:1},{tagId:2}],edges:[{fromId:0,toId:1,occurrence:1,mode:'4t4d',direction:'forward'},{fromId:1,toId:2,occurrence:1,mode:'crab',direction:'lateral'}]},summary:[],issues:[],strategyChoices:{choices:[],issues:[]},disclaimer:'x'}});
  return r.fulfill({json:{}});
 });
 await page.goto('/');
 await page.waitForTimeout(700);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(400);
 await page.getByTestId('map-select').selectOption(map.id);
 await page.waitForTimeout(700);
 await page.getByTestId('route-select').selectOption(route.routeId);
 await page.waitForTimeout(400);
 const er=page.getByTestId('edit-route');
 const erInfo=await page.evaluate(()=>{
  const el=document.querySelector('[data-testid="edit-route"]') as HTMLElement|null;
  if(!el)return {missing:true};
  const b=el.getBoundingClientRect();
  const top=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2) as HTMLElement|null;
  return {box:{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)},
   vh:window.innerHeight,vw:window.innerWidth,
   top:top?top.tagName+(top.getAttribute('data-testid')?'['+top.getAttribute('data-testid')+']':''):'none'};
 });
 console.log('EDITROUTE '+JSON.stringify(erInfo));
 await er.click({timeout:3000});
 await expect(page.getByTestId('route-editor')).toBeVisible({timeout:20000});
 await expect.poll(async()=>page.evaluate(()=>{
  const c=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  const s=Number(c?.dataset.konvaScale);
  const prev=Number((window as any).__fs); (window as any).__fs=s;
  return prev===s&&Number.isFinite(s)&&s>0;
 }),{timeout:15000,intervals:[200,300,400]}).toBe(true);
 await page.waitForTimeout(300);
 return {errors};
}

const rectOf=(page:Page,sel:string)=>page.evaluate((s)=>{
 const el=document.querySelector(s) as HTMLElement|null;
 if(!el)return null;
 const b=el.getBoundingClientRect();
 return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),bottom:Math.round(b.bottom),right:Math.round(b.right)};
},sel);

/** 记录关键矩形 + 横向溢出 + 步骤状态语义。 */
async function metrics(page:Page){
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
 const canvas=await rectOf(page,'[data-testid="map-canvas"]');
 const sidebar=await rectOf(page,'.sidebar');
 const palette=await rectOf(page,'[data-testid="editor-shell-palette"]');
 const tools=await rectOf(page,'[data-testid="route-tools-panel"]');
 const toolbar=await rectOf(page,'[data-testid="route-editor-toolbar"]');
 const steps=await rectOf(page,'[data-testid="route-steps-entry"]');
 const save=await rectOf(page,'[data-testid="route-save"]');
 const exit=await rectOf(page,'[data-testid="route-exit"]');
 const attrs=await page.evaluate(()=>{
  const c=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  return {scale:c?.getAttribute('data-canvas-fit-scale')??c?.getAttribute('data-konva-scale'),
   mode:c?.getAttribute('data-canvas-fit-mode'),labels:c?.getAttribute('data-canvas-visible-labels')};
 });
 const stepStatus=await page.evaluate(()=>document.querySelector('[data-testid="route-steps-status"]')?.textContent?.trim()??null);
 const stepRowCount=await page.evaluate(()=>document.querySelectorAll('.route-commands-table tbody tr').length);
 const vp=page.viewportSize()!;
 return {vp,overflow,canvas,sidebar,palette,tools,toolbar,steps,save,exit,attrs,stepStatus,stepRowCount};
}

function assertNoOverlap(a:any,b:any,label:string){
 if(!a||!b)return;
 const inter=Math.max(0,Math.min(a.right,b.right)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y));
 expect(inter,label+' 不应互相覆盖').toBe(0);
}

for(const [w,h] of [[1024,768],[1280,800],[1440,900],[1920,1080],[760,900],[375,812]] as [number,number][]){
 test(`第5项：${w}x${h} 路径编辑布局与可操作性`,async({page})=>{
  await page.setViewportSize({width:w,height:h});
  const {errors}=await boot(page);
  const m=await metrics(page);
  console.log(`METRICS_${w}x${h} `+JSON.stringify(m));

  // 1) 无横向溢出（窄屏允许纵向滚动）
  expect(m.overflow,`${w}x${h} 出现横向溢出 ${m.overflow}px`).toBeLessThanOrEqual(1);
  // 2) 画布有真实可用面积（不是被面板挤成一条）
  expect(m.canvas!.w,`${w}x${h} 画布宽度过小`).toBeGreaterThan(Math.min(320,w*0.35));
  expect(m.canvas!.h,`${w}x${h} 画布高度过小`).toBeGreaterThan(Math.min(240,h*0.28));
  // 3) 保存/退出可见且在视口内（不会被裁掉）
  expect(m.save,`${w}x${h} 保存按钮缺失`).not.toBeNull();
  expect(m.exit,`${w}x${h} 退出按钮缺失`).not.toBeNull();
  expect(m.save!.bottom,`${w}x${h} 保存按钮被裁出视口`).toBeLessThanOrEqual(h+1);
  expect(m.exit!.bottom,`${w}x${h} 退出按钮被裁出视口`).toBeLessThanOrEqual(h+1);
  // 水平方向必须完整在视口内（不能靠裁切掩盖溢出）
  expect(m.save!.x,`${w}x${h} 保存按钮左边界越界`).toBeGreaterThanOrEqual(0);
  expect(m.save!.right,`${w}x${h} 保存按钮右边界越界(${m.save!.right}>${w})`).toBeLessThanOrEqual(w);
  expect(m.exit!.x,`${w}x${h} 退出按钮左边界越界`).toBeGreaterThanOrEqual(0);
  expect(m.exit!.right,`${w}x${h} 退出按钮右边界越界(${m.exit!.right}>${w})`).toBeLessThanOrEqual(w);
  // 中心点必须真的命中所属按钮（不是被别的元素盖住）
  const hits=await page.evaluate(()=>{
   const at=(id:string)=>{const el=document.querySelector('[data-testid="'+id+'"]') as HTMLElement|null;
    if(!el)return null;const b=el.getBoundingClientRect();
    const top=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2) as HTMLElement|null;
    return top? (top.closest('[data-testid="'+id+'"]')? 'self' : (top.getAttribute('data-testid')||top.tagName)) : 'none';};
   return {save:at('route-save'),exit:at('route-exit')};
  });
  expect(hits.save,`${w}x${h} 保存按钮中心被 ${hits.save} 遮挡`).toBe('self');
  expect(hits.exit,`${w}x${h} 退出按钮中心被 ${hits.exit} 遮挡`).toBe('self');
  // 4) 工具条不与画布互相覆盖
  assertNoOverlap(m.toolbar,m.canvas,`${w}x${h} 工具条与画布`);
  // 5) 步骤栏不覆盖画布
  assertNoOverlap(m.steps,m.canvas,`${w}x${h} 步骤栏与画布`);

  // 6) 步骤状态必须与「实际步骤行数」一致，且绝不出现含糊的「可执行」
  if(m.steps){
   expect(m.stepStatus,`${w}x${h} 不得使用「可执行」这种会被误读为实车可执行的措辞`).not.toBe('可执行');
   if(m.stepRowCount===0){
    expect(['未绘制','待添加路点'],`${w}x${h} 0 步骤状态语义错误：${m.stepStatus}`).toContain(m.stepStatus);
   }else if(m.stepRowCount<2){
    expect(m.stepStatus,`${w}x${h} 单点状态语义错误`).toBe('待添加路点');
   }else{
    expect(m.stepStatus,`${w}x${h} 多点无阻断应为「规划通过」，实际 ${m.stepStatus}`).toBe('规划通过');
   }
  }

  // 7) 真实点选：点标签覆盖的二维码必须选中
  const clickOk=await page.evaluate(()=>{
   const c=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
   if(!c)return null;
   const b=c.getBoundingClientRect();
   const scale=Number(c.dataset.konvaScale), ox=Number(c.dataset.konvaX), oy=Number(c.dataset.konvaY);
   const sx=b.x+ox+0*100*scale, sy=b.y+oy-0*100*scale;
   return {x:sx,y:sy,inside:sx>=b.x&&sx<=b.right&&sy>=b.y&&sy<=b.bottom};
  });
  if(clickOk?.inside){
   await page.mouse.click(clickOk.x,clickOk.y);
   await page.waitForTimeout(500);
   const sel=await page.evaluate(()=>({
    tag:(document.querySelector('[data-testid="map-canvas"]') as HTMLElement)?.getAttribute('data-canvas-selected'),
    route:(document.querySelector('[data-testid="map-canvas"]') as HTMLElement)?.getAttribute('data-route-selected'),
   }));
   expect(sel.route==='0'||sel.tag==='0',`${w}x${h} 点二维码未选中: ${JSON.stringify(sel)}`).toBe(true);
  }

  // 8) 标签可读：至少 2 个可见标签，且缩放不是被 zone 压到极小
  expect(Number(m.attrs.labels),`${w}x${h} 可见标签过少`).toBeGreaterThanOrEqual(2);
  expect(m.attrs.mode).toBe('tags-and-route');
  expect(Number(m.attrs.scale),`${w}x${h} 缩放被压得过小`).toBeGreaterThan(0.5);

  expect(errors).toEqual([]);
 });
}

test('第3项：步骤面板默认收起、展开停靠不遮挡画布、可调高度、可关闭',async({page})=>{
 await page.setViewportSize({width:1440,height:900});
 await boot(page);

 const dockVisible=async()=>page.getByTestId('route-steps-dock').isVisible();
 // 默认必须收起
 expect(await dockVisible(),'步骤面板默认应收起').toBe(false);

 const canvasBefore=await rectOf(page,'[data-testid="map-canvas"]');
 // 展开
 await page.getByTestId('route-steps-trigger').click();
 await expect(page.getByTestId('route-steps-dock')).toBeVisible();
 await page.waitForTimeout(300);
 const dock=await rectOf(page,'[data-testid="route-steps-dock"]');
 const pop=await rectOf(page,'[data-testid="route-steps-popover"]');
 const canvasAfter=await rectOf(page,'[data-testid="map-canvas"]');
 console.log('STEPDOCK '+JSON.stringify({dock,pop,canvasBefore,canvasAfter}));

 // 面板必须真的展开且有可编辑高度
 expect(pop!.h,'展开后步骤面板应有可编辑高度').toBeGreaterThanOrEqual(120);
 // 面板有真实高度（不是被压扁）
 expect(dock!.h,'步骤面板应有可编辑高度').toBeGreaterThanOrEqual(200);
 // 不得覆盖画布
 const overlap=Math.max(0,Math.min(dock!.right,canvasAfter!.right)-Math.max(dock!.x,canvasAfter!.x))
  *Math.max(0,Math.min(dock!.bottom,canvasAfter!.bottom)-Math.max(dock!.y,canvasAfter!.y));
 expect(overlap,'步骤面板不得覆盖画布').toBe(0);
 // 画布不被压没
 expect(canvasAfter!.h,'展开步骤后画布仍须可用').toBeGreaterThan(200);
 // 触发器仍可点（不被自己的面板盖住）
 const trigTop=await page.evaluate(()=>{
  const t=document.querySelector('[data-testid="route-steps-trigger"]') as HTMLElement|null;
  if(!t)return 'missing';
  const b=t.getBoundingClientRect();
  const el=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2) as HTMLElement|null;
  return el?.getAttribute('data-testid')??el?.tagName??'none';
 });
 expect(trigTop,'触发器不得被步骤面板盖住').toBe('route-steps-trigger');

 // 可调高度：拖分隔条变高（此时面板仍展开）
 const h0=(await rectOf(page,'[data-testid="route-steps-popover"]'))!.h;
 const bar=(await rectOf(page,'[data-testid="route-steps-resize-bar"]'))!;
 await page.mouse.move(bar.x+bar.w/2,bar.y+bar.h/2);
 await page.mouse.down();
 await page.mouse.move(bar.x+bar.w/2,Math.max(bar.y-60,40),{steps:10});
 await page.mouse.up();
 await page.waitForTimeout(300);
 const h1=(await rectOf(page,'[data-testid="route-steps-popover"]'))!.h;
 expect(h1,'拖动分隔条必须真的改变高度').not.toBe(h0);
 // 调高后仍有合理上限（不会无限制长到吃掉整页）
 const dockAfter=await rectOf(page,'[data-testid="route-steps-dock"]');
 expect(dockAfter!.h,'调高后高度应有上限').toBeLessThanOrEqual(Math.round(900*0.5)+20);

 // 用户必须能真的关闭：点面板内的关闭按钮（此时面板仍展开、按钮可见）
 const closeBtn=page.getByRole('button',{name:'关闭路径步骤'});
 const cInfo=await page.evaluate(()=>{
  const b=document.querySelector('[aria-label="关闭路径步骤"]') as HTMLElement|null;
  if(!b)return {missing:true};
  const r=b.getBoundingClientRect();const cs=getComputedStyle(b);
  const head=b.parentElement as HTMLElement|null;
  const hr=head?.getBoundingClientRect();
  return {btn:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
   btnDisplay:cs.display,btnVis:cs.visibility,
   head:hr?{y:Math.round(hr.y),h:Math.round(hr.height)}:null,
   scrollY:window.scrollY,vh:window.innerHeight};
 });
 console.log('CINFO '+JSON.stringify(cInfo));
 await closeBtn.scrollIntoViewIfNeeded();
 await page.waitForTimeout(200);
 await expect(closeBtn).toBeVisible();
 const closeBox=await closeBtn.boundingBox();
 expect(closeBox!.width,'关闭按钮必须有真实可点尺寸').toBeGreaterThan(0);
 await closeBtn.click({timeout:3000});
 await expect(page.getByTestId('route-steps-dock')).toBeHidden();

 // 触发器再次点击可重新展开（用户可开可关）
 await page.getByTestId('route-steps-trigger').click({timeout:3000});
 await expect(page.getByTestId('route-steps-dock')).toBeVisible();
 await page.getByTestId('route-steps-trigger').click({timeout:3000});
 await expect(page.getByTestId('route-steps-dock')).toBeHidden();
});
