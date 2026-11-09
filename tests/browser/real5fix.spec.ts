import {test,expect,type Page} from '@playwright/test';

/** 导航页现在是只读的：所有点位/规格/批量操作都要先进「路径编辑」。幂等。 */
async function enterEditor(page: import('@playwright/test').Page) {
 if (await page.getByTestId('route-editor').isVisible().catch(() => false)) return;
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await page.waitForTimeout(250);
}
import {readFileSync} from 'node:fs';
import type {FieldMap} from '../../web/shared/model';

/**
 * 真实交互回归（不是截图对照、不是注入状态）：
 * - 用 window.__mapCanvasApi.screenOfTag(id) 取**真实 Konva 节点**在页面里的中心点，
 *   再用 page.mouse 真点/真拖；命中不了就失败，不跳过。
 * - API 全部在浏览器侧 mock，写操作落到测试进程里的 current/currentGroups，
 *   因此"保存了什么坐标"与"刷新后读回什么"都是可断言的真实载荷。
 * - 覆盖 A..G：选中链路 / 正交吸附 / 单码与码组规格 / 框选批量 / 拖动持久化 /
 *   两种视口布局 / 路径编辑可用性。
 */
test.describe.configure({mode:'serial'});
test.use({viewport:{width:1280,height:800}});

const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};
const mapId='regress-real5fix-map';
const TOL=1e-6;

/** 定位板成员几何：与 web/shared/boards.ts 的 boardSchema 完全一致。 */
function rectMembers(rows:number,cols:number,widthMm:number,heightMm:number,ref:number){
 const tileW=(widthMm-(cols-1)*2)/cols;
 const tileH=(heightMm-(rows-1)*2)/rows;
 const out:{id:number;x:number;y:number;angle:number;size:number}[]=[];
 for(let i=0;i<rows*cols;i++){
  const col=i%cols,row=Math.floor(i/cols);
  out.push({id:ref+i,x:(-widthMm/2+tileW/2+col*(tileW+2))/1000,y:(heightMm/2-tileH/2-row*(tileH+2))/1000,angle:0,size:Math.min(tileW,tileH)/1.25/1000});
 }
 return out;
}
const nMembers=(n:number,sizeMm:number,ref:number)=>{
 const tile=(sizeMm-(n-1)*2)/n;
 return Array.from({length:n*n},(_,i)=>{
  const column=i%n,row=Math.floor(i/n);
  return {id:ref+i,x:(-sizeMm/2+tile/2+column*(tile+2))/1000,y:(sizeMm/2-tile/2-row*(tile+2))/1000,angle:0,size:tile/1.25/1000};
 });
};
const group={id:'B910',referenceId:910,gridSize:2,sizeMm:60,gapMm:2,members:nMembers(2,60,910)};
const tags:any[]=[
 {id:900,rowId:'',x:1.0,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:901,rowId:'',x:1.4,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:902,rowId:'',x:1.2,y:0.7,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:903,rowId:'',x:1.8,y:0.7,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:910,groupId:'B910',rowId:'',x:2.2,y:1.5,angle:0,size:.06,kind:'waypoint',rules:[]},
];
const baseMap:any={...snap.map,id:mapId,name:'real5fix disposable map',routeMode:'map-only',rows:[],motionSegments:undefined,order:[],groups:[group],tags,zone:[{x:0,y:0},{x:3,y:0},{x:3,y:3},{x:0,y:3}]};
let current:any[]=[];
let currentGroups:any[]=[];
let writes:{method:string;path:string;body:any}[]=[];
let errors:string[]=[];
const clone=(value:any)=>JSON.parse(JSON.stringify(value));
const find=(id:number)=>current.find(t=>t.id===id)!;
const mapPayload=()=>({map:{...baseMap,tags:clone(current),groups:clone(currentGroups)},version:1,acceptance:null});

function applyGroupSpec(body:any){
 const oldRef=currentGroups[0]?.referenceId??910;
 const ref=body.startId??oldRef;
 const rows=Math.max(1,Math.round(body.rows??body.gridSize??2));
 const cols=Math.max(1,Math.round(body.cols??body.gridSize??2));
 const widthMm=body.widthMm??body.sizeMm??currentGroups[0].sizeMm;
 const heightMm=body.heightMm??body.sizeMm??currentGroups[0].sizeMm;
 const gridSize=Math.max(rows,cols),sizeMm=Math.max(widthMm,heightMm);
 const next={id:'B'+String(ref).padStart(3,'0'),referenceId:ref,gridSize,sizeMm,rows,cols,widthMm,heightMm,gapMm:2,members:rectMembers(rows,cols,widthMm,heightMm,ref)};
 currentGroups=[next];
 current=current.map(t=>t.id===oldRef?{...t,groupId:next.id,size:sizeMm/1000}:t);
 return next;
}

async function boot(page:Page){
 current=clone(tags);currentGroups=[clone(group)];writes=[];errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]}})));
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,method=req.method();
  const raw=req.postData();const body=raw?JSON.parse(raw):null;
  const json=(value:any)=>route.fulfill({status:200,json:value});
  if(method!=='GET')writes.push({method,path,body});
  if(path==='/api/camera/status')return json({running:true,present:true,frameAgeMs:10,error:''});
  if(path==='/api/camera/calibration')return json({});
  if(path==='/api/localization/map')return json({anchored:true,mapId});
  if(path==='/api/localization/scope')return json({phase:'anchored'});
  if(path==='/api/robot/status')return json({connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]});
  if(path==='/api/maps'&&method==='GET')return json([{id:mapId,name:baseMap.name,version:1}]);
  if(path==='/api/maps'&&method==='POST'){current=clone(body.map.tags??[]);currentGroups=clone(body.map.groups??[]);return json({map:mapPayload().map,version:1,acceptance:null});}
  if(path==='/api/maps/'+mapId&&method==='GET')return json(mapPayload());
  if(path==='/api/surveys'||path==='/api/tasks'||path==='/api/routes'||path==='/api/boards')return json([]);
  if(path.endsWith('/tag-aliases'))return json({aliases:[]});
  if(path.endsWith('/tags/update')&&method==='POST'){
   for(const edit of body.edits??[])current=current.map(t=>t.id===edit.id?{...t,...edit}:t);
   return json({map:mapPayload().map,version:1,acceptance:null});
  }
  if(path.endsWith('/tags/align')&&method==='POST'){
   const ids:number[]=body.ids??[];const picked=current.filter(t=>ids.includes(t.id));
   if(picked.length){
    if(body.mode==='top'||body.mode==='bottom'){const y=Math.min(...picked.map(t=>t.y));current=current.map(t=>ids.includes(t.id)?{...t,y}:t);}
    else{const x=Math.min(...picked.map(t=>t.x));current=current.map(t=>ids.includes(t.id)?{...t,x}:t);}
   }
   return json({map:mapPayload().map,version:1,acceptance:null});
  }
  if(path.endsWith('/tags')&&method==='DELETE'){
   const ids=new Set<number>(body.ids??[]);current=current.filter(t=>!ids.has(t.id));
   return json({map:mapPayload().map,version:1,acceptance:null});
  }
  if(/\/groups\/[^/]+\/spec$/.test(path)&&method==='POST'){
   const next=applyGroupSpec(body);
   return json({map:mapPayload().map,version:1,acceptance:null,group:next,centerId:910});
  }
  if(method!=='GET')return json({ok:true});
  return json({});
 });
 await gotoMap(page);
}
async function gotoMap(page:Page){
 await page.goto('/');
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(mapId);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await enterEditor(page);
 await page.getByLabel('适应地图').click();
}
/** 真实节点中心（页面坐标）；canvas 还没建好或节点不存在时必须失败。 */
async function point(page:Page,id:number){
 const value=await page.evaluate((tagId)=>{
  const api=(window as any).__mapCanvasApi;
  return api?api.screenOfTag(tagId):null;
 },id);
 if(!value)throw new Error(`screenOfTag(${id}) 返回 null：真实画布节点不存在，不能跳过`);
 return value as {x:number;y:number};
}
/** 等画布取景稳定（fit/ResizeObserver 可能在首帧后改变 scale）。 */
async function stablePoint(page:Page,id:number){
 // 画布首帧还会 fit 一次（字体就绪 / 布局尺寸变化），坐标必须连续多次不动才可信，
 // 否则鼠标按下去时节点已经移位，拖拽增量就会偏 —— 那是取点问题，不是产品问题。
 let previous=await point(page,id);
 let calm=0;
 for(let i=0;i<70;i++){
  await page.waitForTimeout(60);
  const next=await point(page,id);
  if(Math.abs(next.x-previous.x)<0.5&&Math.abs(next.y-previous.y)<0.5){calm+=1;if(calm>=6)return next;}
  else calm=0;
  previous=next;
 }
 return previous;
}
async function clickTag(page:Page,id:number){
 const at=await stablePoint(page,id);
 await page.mouse.move(at.x,at.y);
 await page.mouse.click(at.x,at.y);
}
async function dragTo(page:Page,from:{x:number;y:number},to:{x:number;y:number}){
 await page.mouse.move(from.x,from.y);
 await page.mouse.down();
 for(let i=1;i<=8;i++)await page.mouse.move(from.x+(to.x-from.x)*i/8,from.y+(to.y-from.y)*i/8);
 await page.mouse.up();
}
async function screenOf(page:Page,x:number,y:number){
 const value=await page.evaluate(({x,y})=>(window as any).__mapCanvasApi?.worldToClient({x,y}),{x,y});
 if(!value)throw new Error('worldToClient 不可用');
 return value as {x:number;y:number};
}
/** 画布内、离所有码都足够远的真实空白点（用于加点）：直接扫画布像素网格。 */
async function blankSpot(page:Page,avoid:{x:number;y:number}[]=[]){
 const box=(await page.getByTestId('map-canvas').boundingBox())!;
 const tagsHere:{x:number;y:number}[]=[];
 for(const id of [900,901,902,903,910])tagsHere.push(await point(page,id));
 let best:{x:number;y:number}|null=null;
 let bestDistance=0;
 for(let x=box.x+40;x<box.x+box.width-40;x+=32){
  for(let y=box.y+40;y<box.y+box.height-40;y+=32){
   const pointHere={x,y};
   let nearest=Infinity;
   for(const tag of tagsHere)nearest=Math.min(nearest,Math.hypot(tag.x-x,tag.y-y));
   for(const other of avoid)nearest=Math.min(nearest,Math.hypot(other.x-x,other.y-y));
   if(nearest>bestDistance){bestDistance=nearest;best=pointHere;}
  }
 }
 if(!best||bestDistance<70)throw new Error(`画布内找不到离码足够远的空白点（最近 ${bestDistance.toFixed(1)}px）`);
 return best;
}

test('A 点选、切换、点空白清除',async({page})=>{
 await boot(page);
 await clickTag(page,901);
 await expect(page.getByTestId('object-inspector')).toBeVisible();
 await expect(page.getByTestId('object-inspector')).toContainText('Q901');
 await clickTag(page,902);
 await expect(page.getByTestId('object-inspector')).toContainText('Q902');
 const box=(await page.getByTestId('map-canvas').boundingBox())!;
 await page.mouse.click(box.x+20,box.y+box.height-20);
 await expect(page.getByTestId('object-inspector')).toHaveCount(0);
 await expect(page.locator('[data-testid="map-canvas"]')).toHaveAttribute('data-canvas-selected','');
 expect(errors.filter(message=>message.includes('TypeError'))).toEqual([]);
});

test('B 拖动后水平/垂直吸附到共线坐标并落库',async({page})=>{
 await boot(page);
 // 水平：把 901 拖到 900 同一 Y（差 4 mm，小于容差），必须吸附成完全相同的 Y。
 await dragTo(page,await stablePoint(page,901),await screenOf(page,1.75,1.004));
 await expect.poll(()=>Math.abs(find(901).y-find(900).y),{timeout:6000}).toBeLessThanOrEqual(TOL);
 // 垂直：再拖到 902 的 X 附近（差 4 mm），必须吸附成完全相同的 X。
 await dragTo(page,await stablePoint(page,901),await screenOf(page,1.204,1.6));
 await expect.poll(()=>Math.abs(find(901).x-find(902).x),{timeout:6000}).toBeLessThanOrEqual(TOL);
 const saves=writes.filter(write=>write.method==='POST'&&write.path==='/api/maps');
 expect(saves.length).toBeGreaterThan(0);
 const saved=saves.at(-1)!.body.map.tags.find((tag:any)=>tag.id===901);
 expect(Math.abs(saved.x-find(901).x)).toBeLessThanOrEqual(1e-9);
 expect(Math.abs(saved.y-find(901).y)).toBeLessThanOrEqual(1e-9);
});

test('C 单码尺寸与码组规格（网格/整组/派生单码）真实可改且持久',async({page})=>{
 await boot(page);
 // 码组中心：显示真实网格 2×2、整组 60 mm、派生单码 (60-2)/2=29 mm。
 await clickTag(page,910);
 await expect(page.getByTestId('object-group-spec')).toBeVisible();
 await expect(page.getByTestId('object-group-grid')).toHaveValue('2');
 await expect(page.getByTestId('object-group-size')).toHaveValue('60');
 await expect(page.getByTestId('object-group-tag-size')).toHaveValue('29');
 // 独立码：单码尺寸可直接改，保存后刷新仍在。
 await clickTag(page,903);
 await expect(page.getByTestId('object-tag-spec')).toBeVisible();
 await page.getByTestId('object-tag-size').fill('80');
 await page.getByTestId('object-tag-size').blur();
 await expect.poll(()=>find(903).size,{timeout:6000}).toBeCloseTo(0.08,6);
 await page.reload();
 await gotoMap(page);
 await clickTag(page,903);
 await expect(page.getByTestId('object-tag-size')).toHaveValue('80');
 // 码组：改 3×3，成员重建为 9 个，刷新后仍是 3×3。
 await clickTag(page,910);
 await page.getByTestId('object-group-grid').selectOption('3');await page.getByTestId('object-group-rows').selectOption('3');
 await page.getByTestId('object-group-apply').click();
 await expect.poll(()=>currentGroups[0].gridSize,{timeout:8000}).toBe(3);
 expect(currentGroups[0].members).toHaveLength(9);
 await page.reload();
 await gotoMap(page);
 await clickTag(page,910);
 await expect(page.getByTestId('object-group-grid')).toHaveValue('3');
 // 3×3 · 整组 60 mm：单码派生值 =(60-2*2)/3=18.666…→18.7
 await expect(page.getByTestId('object-group-tag-size')).toHaveValue('18.7');
});

test('D 反向框选 → 批量对齐/移动/删除只作用于选中集合',async({page})=>{
 await boot(page);
 const p902=await stablePoint(page,902),p903=await stablePoint(page,903);
 const left=Math.min(p902.x,p903.x)-24,right=Math.max(p902.x,p903.x)+24;
 const top=Math.min(p902.y,p903.y)-24,bottom=Math.max(p902.y,p903.y)+24;
 // 反向：从右下拖到左上。
 await dragTo(page,{x:right,y:bottom},{x:left,y:top});
 await expect(page.getByTestId('box-batch-bar')).toBeVisible();
 await expect(page.getByTestId('box-batch-bar')).toContainText('已选 2');
 // 对齐：两者 Y 相同，未选中的点不动。
 const untouched={...find(900)};
 await page.getByTestId('box-batch-align-row').click();
 await expect.poll(()=>Math.abs(find(902).y-find(903).y),{timeout:8000}).toBeLessThanOrEqual(TOL);
 expect(find(900).y).toBe(untouched.y);
 // 批量移动：拖动其中一个，整批同量平移。
 const before902={...find(902)},before903={...find(903)};
 await dragTo(page,await stablePoint(page,902),{x:p902.x+70,y:p902.y-40});
 await expect.poll(()=>find(902).x-before902.x,{timeout:8000}).toBeGreaterThan(0.05);
 expect(Math.abs((find(903).x-before903.x)-(find(902).x-before902.x))).toBeLessThanOrEqual(TOL);
 expect(Math.abs((find(903).y-before903.y)-(find(902).y-before902.y))).toBeLessThanOrEqual(TOL);
 expect(find(900).x).toBe(untouched.x);
 // Delete 删除整批选中，其余保留。
 await page.keyboard.press('Delete');
 await expect.poll(()=>current.filter(t=>[902,903].includes(t.id)).length,{timeout:8000}).toBe(0);
 expect(current.some(t=>t.id===900)).toBe(true);
 expect(current.some(t=>t.id===910)).toBe(true);
 await expect(page.getByTestId('box-batch-bar')).toHaveCount(0);
});

test('E 拖动后的新坐标提交到保存载荷，刷新后仍是新坐标',async({page})=>{
 await boot(page);
 const before=await stablePoint(page,903);
 const origin={...find(903)};
 await dragTo(page,before,await screenOf(page,origin.x-0.25,origin.y-0.15));
 // 真实拖拽必须让模型坐标朝指针方向移动（不是只看画布上的节点）。
 await expect.poll(()=>origin.x-find(903).x,{timeout:8000}).toBeGreaterThan(0.15);
 expect(origin.y-find(903).y).toBeGreaterThan(0.05);
 const moved={...find(903)};
 const saves=writes.filter(write=>write.method==='POST'&&write.path==='/api/maps');
 expect(saves.length).toBeGreaterThan(0);
 const saved=saves.at(-1)!.body.map.tags.find((tag:any)=>tag.id===903);
 expect(saved.x).toBeCloseTo(moved.x,9);
 expect(saved.y).toBeCloseTo(moved.y,9);
 await page.reload();
 await gotoMap(page);
 await clickTag(page,903);
 await expect(page.getByTestId('object-x')).toHaveValue(moved.x.toFixed(3));
 await expect(page.getByTestId('object-y')).toHaveValue(moved.y.toFixed(3));
 const after=await stablePoint(page,903);
 expect(Math.abs(after.x-before.x)).toBeGreaterThan(10);
});

for(const viewport of [{width:1024,height:768},{width:1440,height:900}]){
 test(`F ${viewport.width}x${viewport.height} 不溢出且浮窗不遮挡选中对象`,async({page})=>{
  await page.setViewportSize(viewport);
  await boot(page);
  const at=await stablePoint(page,901);
  await page.mouse.click(at.x,at.y);
  const panel=await page.getByTestId('object-inspector').boundingBox();
  expect(panel).not.toBeNull();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.y).toBeGreaterThanOrEqual(0);
  expect(panel!.x+panel!.width).toBeLessThanOrEqual(viewport.width+0.5);
  expect(panel!.y+panel!.height).toBeLessThanOrEqual(viewport.height+0.5);
  const covers=at.x>panel!.x&&at.x<panel!.x+panel!.width&&at.y>panel!.y&&at.y<panel!.y+panel!.height;
  expect(covers).toBe(false);
  const size=await page.evaluate(()=>({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight,iw:innerWidth,ih:innerHeight}));
  expect(size.w).toBeLessThanOrEqual(size.iw+1);
  expect(size.h).toBeLessThanOrEqual(size.ih+1);
 });
}

test('G 路径编辑仍可用：加点、选中码、无 TypeError',async({page})=>{
 await boot(page);
 await enterEditor(page);
 await expect(page.getByTestId('route-editor')).toBeVisible();
 // 路径工具分组默认展开：先看加点按钮是否已经可见，不可见才去点分组头，
 // 否则会把本来展开的分组点成收起（旧测试就是这样卡到超时）。
 if(!(await page.getByTestId('route-panel-draw').isVisible().catch(()=>false))){
  await page.getByTestId('route-tools-group-toggle-route').click();
 }
 await page.getByTestId('route-panel-draw').click();
 const first=await blankSpot(page);
 await page.mouse.click(first.x,first.y);
 await page.mouse.click((await blankSpot(page,[first])).x,(await blankSpot(page,[first])).y);
 await expect.poll(async()=>Number(await page.getByTestId('map-canvas').getAttribute('data-route-waypoints')),{timeout:6000}).toBeGreaterThan(0);
 await clickTag(page,901);
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-canvas-selected',/901/);
 expect(errors.filter(message=>message.includes('TypeError'))).toEqual([]);
});
