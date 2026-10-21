import {test,expect,type Page} from '@playwright/test';
import type {Point} from '../../web/shared/model';

// Regression for the route editor freeze: live robot telemetry must never rebuild the static map
// layer (QR groups, waypoint/handle knobs) nor the Konva viewport while editing. It also locks the
// single-source visibility rules: scan/build hides the live vehicle, editing hides it by default,
// the navigation monitor keeps it, and the scan capture-trail diagnostic toggle still works.

const points:Point[]=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
const mapId='edit-freeze-map';
const tagTemplate={angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[] as unknown[]};
const source:any={schemaVersion:1,id:mapId,name:'编辑冻结回归地图',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',routeMode:'waypoints',
 rows:[{id:'route',name:'原路线',width:.6,exitDistance:.8,start:points[0],points:points.slice(1,3)}],order:['route'],
 tags:[...points.map((p,id)=>({id,...p,...tagTemplate})),{id:4,x:.5,y:.5,...tagTemplate},{id:5,x:.5,y:.8,...tagTemplate}],
 zone:[{x:-.5,y:-.5},{x:1.5,y:-.5},{x:1.5,y:1.5},{x:-.5,y:1.5}],vehicle:{width:.4,length:.8,margin:.05},notes:''};
const scanSession={id:'scan-telemetry-freeze',name:'扫描遥测回归',state:'stopped',captureQuality:'draft',counts:{'0':1},
 boards:[{id:'B000',referenceId:0,gridSize:2,sizeMm:100,members:[{id:0,row:0,col:0,referenceId:0}]}],
 samples:[
  {stamp:1,pose:{x:0,y:0,yaw:0},tags:[{id:0,groupId:'B000',x:0,y:0,angle:0}]},
  {stamp:2,pose:{x:1,y:0,yaw:0},tags:[{id:0,groupId:'B000',x:-1,y:0,angle:0}]}
 ]};

type Harness={sendFrame:(index:number)=>void,errors:string[]};
type CanvasState={scale:number,x:number,y:number,staticBuilds:number,overlayUpdates:number,vehicle:string,trailPoints:number};
const anchors=(page:Page)=>page.locator('.route-waypoints button');

async function canvasState(page:Page):Promise<CanvasState>{
 return page.evaluate(()=>{
  const el=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  const d=el?.dataset??{};
  return {scale:Number(d.konvaScale),x:Number(d.konvaX),y:Number(d.konvaY),staticBuilds:Number(d.konvaStaticBuilds),overlayUpdates:Number(d.konvaOverlayUpdates??0),vehicle:String(d.konvaVehicle??''),trailPoints:Number(d.konvaTrailPoints??0)};
 });
}
async function location(page:Page,p:Point){
 const state=await page.evaluate(()=>{const canvas=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;return {box:canvas?.getBoundingClientRect().toJSON(),scale:Number(canvas?.dataset.konvaScale),x:Number(canvas?.dataset.konvaX),y:Number(canvas?.dataset.konvaY)};});
 if(!state.box||!Number.isFinite(state.scale)||state.scale<=0)throw new Error('缺少真实 Konva 视口状态');
 return {x:state.box.x+state.x+p.x*100*state.scale,y:state.box.y+state.y-p.y*100*state.scale};
}
async function clickPoint(page:Page,p:Point){const at=await location(page,p);await page.mouse.click(at.x,at.y);}

function robotStatus(index:number,overrides:Record<string,unknown>={}){
 const now=Date.now();
 return {connected:true,serverTimeMs:now,state:'IDLE',running:false,paused:false,rowId:'',pose:{x:.1+index*.01,y:.2-index*.005,yaw:index*.01},speed:0,wheelAngle:null,tagId:null,
  chassis:{connected:true,feedback:null},sensors:{camera:'在线',odom:'在线',imu:'在线',localization:'静止已定位'},
  conditions:[{id:'execution',label:'实体执行许可',ready:false},{id:'pose',label:'正式定位',ready:false}],events:[],cycleMs:1,
  localization:{stamp:now/1000,state:'STATIC_ANCHORED',source:'stationary_qr',stationary:true,absoluteHeading:true,poseAvailable:true,navigationReady:false,captureTimestampVerified:false,mapId,localEpoch:'epoch-one',reason:'静止二维码定位',headingDeg:30},
  ...overrides};
}

 async function setup(page:Page,mode:'navigate'|'scan'):Promise<Harness>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const map=structuredClone(source),version=1;
 const task={id:'task-scan-'+mapId,name:'编辑冻结回归任务',mapId,mapVersion:version,rowOrder:['route'],forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true};
 let wsRoute:any,sessionReads=0;
 let frame=0;
 await page.routeWebSocket('**/ws',ws=>{wsRoute=ws;ws.send(JSON.stringify({type:'robot',status:robotStatus(0)}));});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/surveys')return route.fulfill({json:mode==='scan'?[scanSession]:[]});
  // The scan page polls the selected record every 2 s; the mock returns the record only once so a
  // poll-driven preview rebuild cannot be mistaken for a telemetry-driven redraw in this regression.
  if(path==='/api/surveys/'+scanSession.id)return route.fulfill(mode==='scan'&&sessionReads++===0?{json:scanSession}:{status:404,json:{error:'not found'}});
  if(path==='/api/boards')return route.fulfill({json:mode==='scan'?scanSession.boards:[]});
  if(path==='/api/tasks')return route.fulfill({json:mode==='navigate'?[task]:[]});
  if(path==='/api/routes')return route.fulfill({json:[]});
  if(path==='/api/maps')return route.fulfill({json:mode==='navigate'?[{id:map.id,name:map.name,version}]:[]});
  if(path==='/api/maps/'+map.id&&mode==='navigate')return route.fulfill({json:{map,version}});
  if(path==='/api/camera/status')return route.fulfill({json:{running:false,present:false}});
  if(path.startsWith('/api/maps/scan-'))return route.fulfill({status:404,json:{error:'not found'}});
  return route.fulfill({status:404,json:{error:'unexpected '+path}});
 });
 await page.goto('/');
 return {errors,sendFrame:(index:number)=>{if(!wsRoute)throw new Error('遥测 WebSocket 尚未连接');const current=frame++;wsRoute.send(JSON.stringify({type:'robot',status:robotStatus(index+current)}));}};
}

async function sendBurst(page:Page,h:Harness,start:number,count:number,gap=15){
 for(let i=0;i<count;i++){h.sendFrame(start+i);await page.waitForTimeout(gap);}
}
// The pose expires 250 ms after the last message (real safety gate), so keep refreshing it while
// polling instead of checking once after a long wait.
async function expectVehicle(page:Page,h:Harness,want:'0'|'1'){
 await expect.poll(async()=>{h.sendFrame(900);await page.waitForTimeout(40);return (await canvasState(page)).vehicle;},{timeout:5000}).toBe(want);
}

test('导航监控显示真实车位；进入路径编辑后连续遥测不显示车位、不重建交互节点，视角与选择保持且二维码仍可点击',async({page})=>{
 const h=await setup(page,'navigate');
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await expect(page.getByTestId('edit-route')).toBeEnabled();
 await page.evaluate(()=>document.fonts.ready);
 await expectVehicle(page,h,'1');
 await expect(page.getByTestId('map-pose-status')).toContainText('静止二维码定位');
 await sendBurst(page,h,1,22,15);
 h.sendFrame(999);await page.waitForTimeout(60);
 const navigateBefore=await canvasState(page);
 await sendBurst(page,h,30,22,15);
 h.sendFrame(998);await page.waitForTimeout(60);
 const navigateAfter=await canvasState(page);
 expect(navigateAfter.vehicle,'导航页持续遥测仍保留车位').toBe('1');
 expect(navigateAfter.staticBuilds,'导航页遥测不重建静态层').toBe(navigateBefore.staticBuilds);
 expect(navigateAfter.scale).toBeCloseTo(navigateBefore.scale,6);
 expect(navigateAfter.x).toBeCloseTo(navigateBefore.x,3);
 expect(navigateAfter.y).toBeCloseTo(navigateBefore.y,3);
 await expect(page.getByTestId('map-pose-status')).toContainText('静止二维码定位');

 await page.getByTestId('edit-route').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await expect.poll(async()=>(await canvasState(page)).vehicle,{timeout:5000}).toBe('0');
 await page.waitForTimeout(300);
 const baseAnchors=await anchors(page).count();
 await clickPoint(page,{x:.5,y:.5});
 await expect(anchors(page)).toHaveCount(baseAnchors+1);
 await expect(anchors(page).nth(baseAnchors)).toHaveClass(/active/);
 const selectedText=await anchors(page).nth(baseAnchors).textContent();
 await page.waitForTimeout(150);
 const frozen=await canvasState(page);
 for(let i=0;i<25;i++){h.sendFrame(100+i);await page.waitForTimeout(15);}
 h.sendFrame(997);await page.waitForTimeout(60);
 const after=await canvasState(page);
 expect(after.vehicle,'编辑页默认不显示车位，且持续遥测也不显示').toBe('0');
 expect(after.staticBuilds,'编辑页遥测不得重建底图/二维码/手柄').toBe(frozen.staticBuilds);
 expect(after.scale,'编辑页遥测不得重置缩放').toBeCloseTo(frozen.scale,6);
 expect(after.x,'编辑页遥测不得重置 stage x').toBeCloseTo(frozen.x,3);
 expect(after.y,'编辑页遥测不得重置 stage y').toBeCloseTo(frozen.y,3);
 expect(await anchors(page).count()).toBe(baseAnchors+1);
 await expect(anchors(page).nth(baseAnchors)).toHaveClass(/active/);
 expect(await anchors(page).nth(baseAnchors).textContent()).toBe(selectedText);
 await clickPoint(page,{x:.5,y:.8});
 await expect(anchors(page)).toHaveCount(baseAnchors+2);
 await expect(anchors(page).nth(baseAnchors+1)).toHaveClass(/active/);
 expect(h.errors).toEqual([]);
});

test('扫描建图页：默认不显示真实车位/采集轨迹，连续遥测不重建底图，诊断轨迹开关仍可用',async({page})=>{
 const h=await setup(page,'scan');
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await expect(page.getByTestId('capture-trail-toggle')).not.toBeChecked();
 await page.evaluate(()=>document.fonts.ready);
 await page.waitForTimeout(300);
 const base=await canvasState(page);
 expect(base.vehicle,'扫描页不得显示真实车位').toBe('0');
 expect(base.trailPoints,'扫描页默认不显示采集轨迹').toBe(0);
 for(let i=0;i<25;i++){h.sendFrame(i);await page.waitForTimeout(15);}
 await page.waitForTimeout(250);
 const afterTelemetry=await canvasState(page);
 expect(afterTelemetry.vehicle,'扫描页持续遥测也不显示车位').toBe('0');
 expect(afterTelemetry.trailPoints,'遥测不产生位姿轨迹').toBe(0);
 expect(afterTelemetry.staticBuilds,'扫描页遥测不重建底图').toBe(base.staticBuilds);
 await page.getByTestId('capture-trail-toggle').check();
 await expect.poll(async()=>(await canvasState(page)).trailPoints,{timeout:5000}).toBe(scanSession.samples.length);
 const withTrail=await canvasState(page);
 for(let i=0;i<10;i++){h.sendFrame(100+i);await page.waitForTimeout(15);}
 await page.waitForTimeout(200);
 const afterTrail=await canvasState(page);
 expect(afterTrail.trailPoints,'显式诊断开关仍绘制采集轨迹').toBe(scanSession.samples.length);
 expect(afterTrail.staticBuilds,'遥测不重建静态层').toBe(withTrail.staticBuilds);
 expect(afterTrail.vehicle).toBe('0');
 expect(h.errors).toEqual([]);
});
