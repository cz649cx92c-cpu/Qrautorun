import {test,expect,type Page} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import type {Point} from '../../web/shared/model';

type Viewport={width:number;height:number};
type Snapshot={step:string;documentScrollTop:number;bodyScrollTop:number;editorScrollTop:number;canvasSection:{top:number;height:number;width:number};canvas:{top:number;height:number;width:number};stage:{scale:number;x:number;y:number};anchors:number;scrollContainers:Array<{selector:string;scrollTop:number;scrollHeight:number;clientHeight:number}>};
const viewports:Viewport[]=[{width:1366,height:768},{width:1280,height:720},{width:1600,height:900},{width:375,height:812}];
const points:Point[]=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
const source:any={schemaVersion:1,id:'editor-ux-v3-map',name:'编辑交互复现地图',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',routeMode:'waypoints',rows:[{id:'route',name:'原路线',width:.6,exitDistance:.8,start:points[0],points:points.slice(1,3)}],order:['route'],tags:points.map((p,id)=>({id,...p,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]})),zone:[{x:-.5,y:-.5},{x:1.5,y:-.5},{x:1.5,y:1.5},{x:-.5,y:1.5}],vehicle:{width:.4,length:.8,margin:.05},notes:''};

async function setup(page:Page){
 let map=structuredClone(source),version=1;
 const task=()=>({id:'task-scan-editor-ux-v3',name:'编辑交互复现任务',mapId:map.id,mapVersion:version,rowOrder:['route'],forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true});
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:false,state:'OFFLINE',running:false,paused:false,pose:null,chassis:{connected:false},conditions:[],events:[],sensors:{}}})));
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/api/routes')return route.fulfill({json:[]});
  if(path==='/api/tasks')return route.fulfill({json:[task()]});
  if(path==='/api/surveys'||path==='/api/boards')return route.fulfill({json:[]});
  if(path==='/api/camera/status')return route.fulfill({json:{running:false,present:false}});
  if(path==='/api/maps/'+map.id)return route.fulfill({json:{map,version}});
  if(path==='/api/route/design'){
   const body=request.postDataJSON();
   if(body.routeName==='冲突验证')return route.fulfill({status:409,json:{error:'路径已被其他页面更新，保留当前草稿'}});
   map={...map,rows:map.rows,motionSegments:[{fromId:0,toId:1}]};version++;return route.fulfill({json:{map,version,task:task(),trimmed:{startM:0,endM:0},routeGroups:{skipped:[]},mapApproval:{accepted:true,digestValid:true}}});
  }
  return route.fulfill({status:404,json:{error:'Unexpected mocked API: '+path}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:'开始导航',exact:true}).click();
 await expect(page.getByTestId('edit-route')).toBeEnabled();
 await page.getByTestId('edit-route').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await page.getByTestId('map-canvas').scrollIntoViewIfNeeded();
}

async function snapshot(page:Page,step:string):Promise<Snapshot>{
 return page.evaluate(step=>{
  const rect=(selector:string)=>{const el=document.querySelector(selector);const r=el?.getBoundingClientRect();return {top:r?.top??-1,height:r?.height??-1,width:r?.width??-1};};
  const canvas=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  const dataset=canvas?.dataset??{};
  const selectors=['html','body','.workspace','.editor-body','.canvas-section','.route-editor','.route-waypoints','.route-skipped-groups'];
  return {step,documentScrollTop:document.documentElement.scrollTop,bodyScrollTop:document.body.scrollTop,editorScrollTop:(document.querySelector('.editor-body') as HTMLElement|null)?.scrollTop??0,canvasSection:rect('.canvas-section'),canvas:rect('[data-testid="map-canvas"]'),stage:{scale:Number(dataset.konvaScale??0),x:Number(dataset.konvaX??0),y:Number(dataset.konvaY??0)},anchors:document.querySelectorAll('.route-waypoints button').length,scrollContainers:selectors.map(selector=>{const el=document.querySelector(selector) as HTMLElement|null;return {selector,scrollTop:el?.scrollTop??0,scrollHeight:el?.scrollHeight??0,clientHeight:el?.clientHeight??0};})};
 },step);
}

async function clickCanvasPoint(page:Page,index:number){
 const box=await page.getByTestId('map-canvas').boundingBox();
 if(!box)throw new Error('画布不可见');
 const column=index%5,row=Math.floor(index/5);
 await page.mouse.click(box.x+box.width*(.24+column*.13),box.y+box.height*(.2+row*.13));
}

async function dragCanvas(page:Page,button:'left'|'middle'='left',withSpace=false){
 const box=await page.getByTestId('map-canvas').boundingBox();if(!box)throw new Error('画布不可见');
 const from={x:box.x+box.width*.58,y:box.y+box.height*.52},to={x:from.x+72,y:from.y+36};
 if(withSpace)await page.keyboard.down('Space');await page.mouse.move(from.x,from.y);await page.mouse.down({button});await page.mouse.move(to.x,to.y,{steps:8});await page.mouse.up({button});if(withSpace)await page.keyboard.up('Space');
}
async function wheelCanvas(page:Page,modifier:boolean){
 const box=await page.getByTestId('map-canvas').boundingBox();if(!box)throw new Error('画布不可见');await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);if(modifier)await page.keyboard.down('Control');await page.mouse.wheel(0,320);if(modifier)await page.keyboard.up('Control');
}

async function dragKnownWaypoint(page:Page){
 const state=await page.evaluate(()=>{const canvas=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;return {box:canvas?.getBoundingClientRect().toJSON(),scale:Number(canvas?.dataset.konvaScale),x:Number(canvas?.dataset.konvaX),y:Number(canvas?.dataset.konvaY)};});
 if(!state.box||!state.scale)throw new Error('缺少 Konva 状态');
 const from={x:state.box.x+state.x+100*state.scale,y:state.box.y+state.y-100*state.scale};
 const to={x:from.x-state.scale*26,y:from.y+state.scale*18};
 await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});await page.mouse.up();
}

for(const viewport of viewports){
 test(`编辑交互复现 GREEN ${viewport.width}x${viewport.height}`,async({page})=>{
  await page.setViewportSize(viewport);await setup(page);
  const snapshots:Snapshot[]=[await snapshot(page,'entered')];
  await expect(page.locator('.route-details-scroll')).toBeHidden();
  for(const name of ['保存路径','退出','属性'])await expect(page.getByRole('button',{name,exact:true})).toBeInViewport();
  expect(snapshots[0]!.canvas.height).toBeGreaterThanOrEqual((viewport.height-64)*.6);
  const panBase=snapshots[0]!;
  await page.getByTestId('route-pan-tool').click();
  await expect(page.getByTestId('route-pan-tool')).toHaveAttribute('aria-pressed','true');
  await dragCanvas(page,'left');const afterGrab=await snapshot(page,'pan-hand');
  expect(afterGrab.anchors).toBe(panBase.anchors);
  expect(afterGrab.stage.x!==panBase.stage.x||afterGrab.stage.y!==panBase.stage.y,JSON.stringify({panBase,afterGrab})).toBe(true);
  await page.getByTestId('route-draw-tool').click();
  await expect(page.getByTestId('route-draw-tool')).toHaveAttribute('aria-pressed','true');
  const ordinaryBefore=await snapshot(page,'ordinary-wheel-before');await wheelCanvas(page,false);const ordinaryAfter=await snapshot(page,'ordinary-wheel-after');expect(ordinaryAfter.stage.scale).toBeCloseTo(ordinaryBefore.stage.scale,6);await wheelCanvas(page,true);const zoomAfter=await snapshot(page,'ctrl-wheel');expect(zoomAfter.stage.scale).not.toBeCloseTo(ordinaryAfter.stage.scale,6);snapshots.push(afterGrab,ordinaryBefore,ordinaryAfter,zoomAfter);
  for(let i=0;i<20;i++){await clickCanvasPoint(page,i);snapshots.push(await snapshot(page,`click-${i+1}`));}
  expect(snapshots.at(-1)!.anchors).toBeGreaterThanOrEqual(panBase.anchors+19);
  await page.getByTestId('route-properties-toggle').click();snapshots.push(await snapshot(page,'properties-open'));
  await page.locator('.route-waypoints button').nth(5).click();snapshots.push(await snapshot(page,'select-point'));
  await page.getByRole('button',{name:'关闭路径属性',exact:true}).click();snapshots.push(await snapshot(page,'properties-close'));
  await dragKnownWaypoint(page);snapshots.push(await snapshot(page,'drag-point'));
  await page.getByRole('button',{name:'撤销',exact:true}).click();snapshots.push(await snapshot(page,'undo'));
  await page.getByTestId('route-properties-toggle').click();await page.getByTestId('auto-chain-route').click();snapshots.push(await snapshot(page,'auto-chain'));
  await page.getByTestId('route-more').locator('summary').click();snapshots.push(await snapshot(page,'more-open'));
  await page.getByLabel('路径名称',{exact:true}).fill('冲突验证');const draft=await page.locator('.route-waypoints button').allTextContents();await page.getByRole('button',{name:'保存路径',exact:true}).click();await expect(page.getByRole('alert')).toContainText('保留当前草稿');expect(await page.locator('.route-waypoints button').allTextContents()).toEqual(draft);snapshots.push(await snapshot(page,'conflict-toast'));
  await page.getByLabel('路径名称',{exact:true}).fill('保存验证');await page.getByRole('button',{name:'关闭路径属性',exact:true}).click();snapshots.push(await snapshot(page,'properties-close-final'));
  mkdirSync('logs',{recursive:true});writeFileSync(`logs/editor-ux-v3-compact-${viewport.width}x${viewport.height}.json`,JSON.stringify({viewport,snapshots},null,2));
  await page.screenshot({path:`logs/editor-ux-v3-compact-${viewport.width}x${viewport.height}.png`,fullPage:true});
  const entered=snapshots[0]!;
  const ctrlWheel=snapshots.find(snapshot=>snapshot.step==='ctrl-wheel')!;
  const violations=snapshots.slice(1).flatMap(item=>[
   Math.abs(item.documentScrollTop-entered.documentScrollTop)>2?`${item.step}: document scrollTop ${item.documentScrollTop}`:'',
   Math.abs(item.bodyScrollTop-entered.bodyScrollTop)>2?`${item.step}: body scrollTop ${item.bodyScrollTop}`:'',
   Math.abs(item.editorScrollTop-entered.editorScrollTop)>2?`${item.step}: editor scrollTop ${item.editorScrollTop}`:'',
   Math.abs(item.canvasSection.top-entered.canvasSection.top)>2?`${item.step}: canvas section top ${item.canvasSection.top} vs ${entered.canvasSection.top}`:'',
   Math.abs(item.canvas.top-entered.canvas.top)>2?`${item.step}: canvas top ${item.canvas.top} vs ${entered.canvas.top}`:'',
   Math.abs(item.canvas.height-entered.canvas.height)>2?`${item.step}: canvas height ${item.canvas.height} vs ${entered.canvas.height}`:'',
   Math.abs(item.canvas.width-entered.canvas.width)>2?`${item.step}: canvas width ${item.canvas.width} vs ${entered.canvas.width}`:'',
   Math.abs(item.stage.scale-(['entered','pan-hand','ordinary-wheel-before','ordinary-wheel-after'].includes(item.step)?entered.stage.scale:ctrlWheel.stage.scale))>.001?`${item.step}: stage scale ${item.stage.scale}`:'',
   !['entered','pan-hand','ordinary-wheel-before','ordinary-wheel-after'].includes(item.step)&&(Math.abs(item.stage.x-ctrlWheel.stage.x)>.001||Math.abs(item.stage.y-ctrlWheel.stage.y)>.001)?`${item.step}: viewport position reset`:'',
   item.anchors<entered.anchors?`${item.step}: anchors ${item.anchors}`:''
  ].filter(Boolean));
  expect(violations,{message:JSON.stringify({viewport,violations,snapshots},null,2)}).toEqual([]);
  await page.getByRole('button',{name:'保存路径',exact:true}).click();await expect(page.getByTestId('route-editor')).toHaveCount(0);
 });
}
