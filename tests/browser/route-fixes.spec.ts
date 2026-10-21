import {test,expect,type Page} from '@playwright/test';

/**
 * 本轮四个现场问题的浏览器回归（API 全部 mock，不连真实 ROS/数据库）：
 * A. 删除路径后画布立即清空该路线，不残留旧 motionSegments/rows；另一条路径仍可正常显示。
 * B. 新建路径默认名称自动去重、可输入自定义名称；真实同名冲突给出明确错误；删除后同名可复用。
 * C. 画布上斜向点击会被明确正交拆分，保存请求里的控制点全部是水平/垂直直线。
 * D. 导航监控页显示小车；路径编辑页隐藏 vehicle/trail；连续 telemetry 不重建静态二维码/路点层。
 */

const MAP_ID='route-fixes-map';
const MAP_NAME='路线修复测试地图';
const POSITIONS=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:1,y:2}];

interface MockState{
 routes:{routeId:string;name:string;mapId:string;mapVersion:number;mapDigest:string;points:{x:number;y:number}[];motionSegments:any[];bodyYawDeg:number;created:string;updated:string}[];
 tasks:any[];
 designPosts:any[];
 deleted:string[];
 sequence:number;
}

function segmentsFor(points:{x:number;y:number}[]){
 return points.slice(1).map((point,index)=>{
  const from=points[index]!,to=point;
  const horizontal=Math.abs(from.y-to.y)<1e-9;
  const mode=horizontal?'4t4d':'crab';
  const direction=horizontal?'forward':'lateral';
  return {id:'seg-'+index,fromId:index,toId:index+1,mode,direction,bodyYaw:0,endYaw:0,
   wheelAngle:horizontal?0:90,executionProfile:'recorded_slow_trial',
   points:[from,{x:(from.x+to.x)/2,y:(from.y+to.y)/2},to]};
 });
}
function mapBody(){
 return {schemaVersion:1,id:MAP_ID,name:MAP_NAME,frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'reviewed',captureQuality:'verified',routeMode:'waypoints',
  rows:[{id:'r',name:'路线',width:.6,exitDistance:.8,start:POSITIONS[0],points:POSITIONS.slice(1)}],
  tags:POSITIONS.map((point,id)=>({id,groupId:'B'+String(id).padStart(3,'0'),rowId:'r',x:point.x,y:point.y,angle:0,size:.08,kind:'waypoint',rules:[]})),
  order:['r'],zone:[{x:-1,y:-1},{x:2.2,y:-1},{x:2.2,y:3},{x:-1,y:3}],vehicle:{width:.4,length:.8,margin:.05},notes:''};
}
function routeEntity(routeId:string,name:string,points:{x:number;y:number}[]){
 const now='2026-10-21T10:00:00.000Z';
 return {routeId,name,mapId:MAP_ID,mapVersion:1,mapDigest:'digest',points,motionSegments:segmentsFor(points),bodyYawDeg:0,initialHeadingRad:null,created:now,updated:now};
}
function taskFor(route:any){return {id:'task-'+route.routeId,name:route.name+'任务',mapId:MAP_ID,mapVersion:1,routeId:route.routeId,routeSnapshot:route,rowOrder:['r'],forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true};}

function robotStatus(pose:{x:number;y:number;yaw:number}){
 const now=Date.now();
 return {connected:true,state:'IDLE',running:false,paused:false,pose,serverTimeMs:now,
  localization:{mapId:MAP_ID,mapVersion:1,poseAvailable:true,absoluteHeading:true,state:'FORMAL',source:'synchronized_qr',stamp:now/1000-0.05,approvalBasis:'user_confirmation'},
  chassis:{connected:true},conditions:[],events:[],sensors:{},detector:{connected:false},mapping:{ready:true},capabilities:{turnInPlace:true}};
}

async function setup(page:Page,seed:Partial<MockState>={}){
 const state:MockState={routes:[],tasks:[],designPosts:[],deleted:[],sequence:0,...seed};
 state.tasks=state.routes.map(taskFor);
 const errors:string[]=[];const writes:string[]=[];
 let socket:any;
 page.on('pageerror',reason=>errors.push(reason.message));
 await page.routeWebSocket('**/ws',ws=>{socket=ws;ws.send(JSON.stringify({type:'robot',status:robotStatus({x:.2,y:.1,yaw:0})}));});
 const send=(route:any,data:any,status=200)=>route.fulfill({status,json:data});
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(method!=='GET')writes.push(method+' '+path);
  if(path==='/api/surveys'||path==='/api/boards'||path==='/api/print/options')return send(route,path==='/api/print/options'?{}:[]);
  if(path==='/api/camera/status')return send(route,{running:false,present:false});
  if(path==='/api/robot/status')return send(route,robotStatus({x:.2,y:.1,yaw:0}));
  if(path==='/api/maps'&&method==='GET')return send(route,[{id:MAP_ID,name:MAP_NAME,version:1,created:'2026-10-21T09:00:00.000Z'}]);
  if(path==='/api/maps/'+MAP_ID&&method==='GET')return send(route,{map:mapBody(),version:1,acceptance:{accepted:true,digestValid:true,kind:'user_confirmation'}});
  if(path==='/api/routes'&&method==='GET')return send(route,state.routes);
  if(path==='/api/tasks'&&method==='GET')return send(route,state.tasks);
  if(path==='/api/tasks'&&method==='POST')return send(route,{});
  if(path==='/api/localization/map')return send(route,{ok:true});
  const routeMatch=path.match(/^\/api\/routes\/([^/]+)$/);
  if(routeMatch&&method==='GET'){
   const found=state.routes.find(item=>item.routeId===routeMatch[1]);
   if(!found)return send(route,{error:'路径不存在'},404);
   return send(route,{route:found,map:{...mapBody(),rows:[],motionSegments:found.motionSegments},version:1,acceptance:{accepted:true,digestValid:true,kind:'user_confirmation'}});
  }
  const usageMatch=path.match(/^\/api\/routes\/([^/]+)\/usage$/);
  if(usageMatch&&method==='GET'){
   return send(route,{routeId:usageMatch[1],mapId:MAP_ID,tasks:state.tasks.filter(task=>task.routeId===usageMatch[1]).map(task=>({id:task.id,name:task.name}))});
  }
  if(routeMatch&&method==='DELETE'){
   const id=routeMatch[1];const removedTasks=state.tasks.filter(task=>task.routeId===id).length;
   const before=state.routes.length;
   state.routes=state.routes.filter(item=>item.routeId!==id);
   state.deleted.push(id);state.tasks=state.tasks.filter(task=>task.routeId!==id);
   if(state.routes.length===before)return send(route,{error:'路径不存在'},404);
   return send(route,{deleted:true,routeId:id,deletedTasks:removedTasks});
  }
  if(path==='/api/route/design'&&method==='POST'){
   const body=request.postDataJSON();state.designPosts.push(body);
   if(state.routes.some(item=>item.mapId===body.mapId&&item.name===body.routeName&&item.routeId!==body.routeId))
    return send(route,{error:'同一地图已有同名路径，请换一个名称'},409);
   const routeId=body.routeId??'route-new-'+(++state.sequence);
   const saved=routeEntity(routeId,body.routeName,body.points.map((point:any)=>({x:point.x,y:point.y})));
   saved.bodyYawDeg=body.bodyYawDeg;
   const index=state.routes.findIndex(item=>item.routeId===routeId);
   if(index>=0)state.routes[index]=saved;else state.routes.push(saved);
   const task=taskFor(saved);state.tasks=state.tasks.filter(item=>item.routeId!==routeId).concat(task);
   return send(route,{...saved,route:saved,map:{...mapBody(),rows:[],motionSegments:saved.motionSegments},version:1,task,updatedTasks:[task],trimmed:{startM:0,endM:0},lengthM:1,routeGroups:{usedIds:[],skipped:[]},acceptance:{accepted:true,digestValid:true,kind:'user_confirmation'}});
  }
  if(path.startsWith('/api/routes/')||path.startsWith('/api/route/'))return send(route,{error:'未 mock '+method+' '+path},404);
  return send(route,{error:'未 mock 的接口 '+method+' '+path},404);
 });
 await page.goto('/');
 await expect(page.getByTestId('global-status')).toBeVisible();
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await expect(page.getByTestId('map-select')).toBeVisible();
 await page.getByTestId('map-select').selectOption(MAP_ID);
 const canvas=page.getByTestId('map-canvas');
 await expect(canvas).toHaveAttribute('data-konva-tags','4');
 return {state,errors,writes,canvas,sendStatus:(pose:{x:number;y:number;yaw:number})=>socket?.send(JSON.stringify({type:'robot',status:robotStatus(pose)}))};
}
async function canvasPoint(page:Page,point:{x:number;y:number}){
 const view=await page.getByTestId('map-canvas').evaluate(node=>({box:node.getBoundingClientRect().toJSON(),scale:Number((node as HTMLElement).dataset.konvaScale),x:Number((node as HTMLElement).dataset.konvaX),y:Number((node as HTMLElement).dataset.konvaY)}));
 return {x:view.box.x+view.x+point.x*100*view.scale,y:view.box.y+view.y-point.y*100*view.scale};
}
async function clickCanvas(page:Page,point:{x:number;y:number}){
 const at=await canvasPoint(page,point);await page.mouse.click(at.x,at.y);
}
async function drawRoute(page:Page,from:{x:number;y:number},to:{x:number;y:number}){
 await clickCanvas(page,from);await clickCanvas(page,to);
}

test('A. 删除路径后画布立即清空该路线（不残留旧 rows/motionSegments），另一条路径仍显示',async({page})=>{
 const routeA=routeEntity('route-a','路线A',POSITIONS);
 const routeB=routeEntity('route-b','路线B',[{x:0,y:0},{x:1,y:0},{x:1,y:1}]);
 const {state,errors,canvas}=await setup(page,{routes:[routeA,routeB]});
 await page.getByTestId('route-select').selectOption('route-a');
 await expect(canvas).toHaveAttribute('data-konva-route-segments','3');
 await expect(canvas).toHaveAttribute('data-konva-rows','0');
 await page.getByRole('button',{name:'删除路径 路线A'}).click();
 await expect(page.getByTestId('route-delete-confirm')).toBeVisible();
 await page.getByTestId('confirm-delete-route').click();
 await expect(page.locator('.message')).toContainText('已删除路径「路线A」');
 await expect(canvas).toHaveAttribute('data-konva-route-segments','0');
 await expect(canvas).toHaveAttribute('data-konva-rows','0');
 await expect(page.getByTestId('route-select')).toHaveValue('');
 expect(await page.getByTestId('route-select').locator('option').allTextContents()).toEqual(['选择路径','路线B']);
 expect(state.deleted).toEqual(['route-a']);
 expect(state.routes.map(item=>item.routeId)).toEqual(['route-b']);
 // B 仍然可以正常打开并显示它自己的快照
 await page.getByTestId('route-select').selectOption('route-b');
 await expect(canvas).toHaveAttribute('data-konva-route-segments','2');
 expect(errors).toEqual([]);
});

test('B. 新建路径：默认名称自动去重、可自定义；同名真实冲突报错；删除后同名可复用',async({page})=>{
 const existing=routeEntity('route-existing',MAP_NAME+'新路径',POSITIONS);
 const {state,errors,canvas}=await setup(page,{routes:[existing]});
 await page.getByTestId('new-route').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await expect(page.getByTestId('route-name-input')).toHaveValue(MAP_NAME+'新路径 2');
 await page.getByTestId('route-name-input').fill('自定义名称A');
 await drawRoute(page,{x:0,y:0},{x:.9,y:.6});
 await page.getByRole('button',{name:'保存路径',exact:true}).click();
 await expect(page.getByTestId('route-editor')).toHaveCount(0);
 expect(state.designPosts).toHaveLength(1);
 expect(state.designPosts[0].routeName).toBe('自定义名称A');
 // 斜向点击必须被正交拆分：保存请求里每段只能是水平/垂直直线
 const points=state.designPosts[0].points as {x:number;y:number}[];
 for(let i=1;i<points.length;i++)expect(Math.abs(points[i]!.x-points[i-1]!.x)<1e-9||Math.abs(points[i]!.y-points[i-1]!.y)<1e-9).toBe(true);
 expect(points.length).toBeGreaterThanOrEqual(3);
 // 再次新建：默认名称不重复
 await page.getByTestId('new-route').click();
 const suggested=await page.getByTestId('route-name-input').inputValue();
 expect([existing.name,'自定义名称A','路线B']).not.toContain(suggested);
 // 真实同名冲突：明确提示，不静默失败
 await page.getByTestId('route-name-input').fill('自定义名称A');
 await drawRoute(page,{x:0,y:0},{x:1,y:0});
 await page.getByRole('button',{name:'保存路径',exact:true}).click();
 await expect(page.locator('.route-toast-error')).toContainText('同名');
 expect(state.designPosts).toHaveLength(2);
 // 删除后同名可复用
 await page.getByRole('button',{name:'退出',exact:true}).click();
 await page.getByRole('button',{name:'删除路径 自定义名称A'}).click();
 await page.getByTestId('confirm-delete-route').click();
 await expect(page.locator('.message')).toContainText('已删除路径「自定义名称A」');
 await page.getByTestId('new-route').click();
 await page.getByTestId('route-name-input').fill('自定义名称A');
 await drawRoute(page,{x:0,y:0},{x:1,y:0});
 await page.getByRole('button',{name:'保存路径',exact:true}).click();
 await expect(page.getByTestId('route-editor')).toHaveCount(0);
 expect(state.designPosts).toHaveLength(3);
 expect(state.routes.some(item=>item.name==='自定义名称A')).toBe(true);
 await expect(canvas).toHaveAttribute('data-konva-tags','4');
 expect(errors).toEqual([]);
});

test('D. 导航监控页显示小车；路径编辑页隐藏 vehicle/trail；telemetry 不重建静态二维码层',async({page})=>{
 const routeA=routeEntity('route-a','路线A',POSITIONS);
 const {errors,canvas,sendStatus}=await setup(page,{routes:[routeA]});
 await page.getByTestId('route-select').selectOption('route-a');
 // 真实桥接会持续推送位姿；持续喂 fresh status 才能让 250ms 新鲜度门禁保持开启。
 const telemetry=setInterval(()=>sendStatus({x:.2,y:.1,yaw:0}),100);
 try{
  await expect(canvas).toHaveAttribute('data-konva-vehicle','1',{timeout:8000});
  await page.getByTestId('edit-route').click();
  await expect(page.getByTestId('route-editor')).toBeVisible();
  await expect(canvas).toHaveAttribute('data-konva-vehicle','0');
  await expect(canvas).toHaveAttribute('data-konva-trail-points','0');
  const buildsEditing=await canvas.getAttribute('data-konva-static-builds');
  // 编辑期间继续推送变化的位姿：只能更新 overlay，静态二维码/路点层不能重建。
  for(let i=0;i<6;i++){sendStatus({x:.2+i*.05,y:.1+i*.02,yaw:.1*i});await page.waitForTimeout(120);}
  expect(await canvas.getAttribute('data-konva-static-builds')).toBe(buildsEditing);
  expect(Number(await canvas.getAttribute('data-konva-overlay-updates'))).toBeGreaterThan(0);
  await page.getByRole('button',{name:'退出',exact:true}).click();
  await expect(canvas).toHaveAttribute('data-konva-vehicle','1',{timeout:8000});
 }finally{clearInterval(telemetry);}
 expect(errors).toEqual([]);
});
