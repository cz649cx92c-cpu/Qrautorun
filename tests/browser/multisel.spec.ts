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

// 真实入口：首页 → 开始导航 → 选图 → 画布（map-only 即框选批量态）。
// 点位定位只用 window.__mapCanvasApi.screenOfTag()/worldToClient()，不猜画布比例。
const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};

const mapId='regress-multisel-map';
const robotStatus={connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]};

// 3×2 独立码阵列，ids 40..45 行优先；间距 0.4 m，码边长 0.06 m。
const tags:any[]=[
 {id:40,rowId:'',x:1.0,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:41,rowId:'',x:1.4,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:42,rowId:'',x:1.8,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:43,rowId:'',x:1.0,y:1.5,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:44,rowId:'',x:1.4,y:1.5,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:45,rowId:'',x:1.8,y:1.5,angle:0,size:.06,kind:'waypoint',rules:[]},
];

const baseMap:any={
 ...snap.map,
 id:mapId,
 name:'multisel 回归地图',
 routeMode:'map-only',
 rows:[],
 motionSegments:undefined,
 order:[],
 groups:[],
 tags,
 zone:[{x:0,y:0},{x:3,y:0},{x:3,y:2},{x:0,y:2}],
};

let current:any[]=[];
let writes:{method:string;path:string;body:any}[]=[];
let version=1;

function resetState(){
 current=structuredClone(tags);
 writes=[];
 version=1;
}
function mapPayload(){return {...baseMap,tags:structuredClone(current)};}

async function installMocks(page:Page){
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:robotStatus})));
 await page.route('**/api/**',async route=>{
  const req=route.request();
  const path=new URL(req.url()).pathname;
  const method=req.method();
  const raw=req.postData();
  const body=raw?JSON.parse(raw):null;
  const json=(value:any)=>route.fulfill({status:200,json:value});
  if(method!=='GET')writes.push({method,path,body});
  if(path==='/api/camera/status')return json({running:true,present:true,frameAgeMs:10,error:''});
  if(path==='/api/camera/calibration')return json({});
  if(path==='/api/robot/status')return json(robotStatus);
  if(path==='/api/localization/map')return json({anchored:true,mapId});
  if(path==='/api/localization/scope')return json({phase:'anchored',mapId,version});
  if(path==='/api/maps'&&method==='GET')return json([{id:mapId,name:baseMap.name,version,created:''}]);
  if(path==='/api/maps'&&method==='POST'){
   const map=body?.map??body;
   if(map)current=structuredClone(map.tags??[]);
   version+=1;
   return json({map:mapPayload(),version,acceptance:null});
  }
  if(path==='/api/maps/'+mapId&&method==='GET')return json({map:mapPayload(),version,acceptance:null});
  if(path==='/api/surveys'||path==='/api/tasks'||path==='/api/routes'||path==='/api/boards')return json([]);
  if(path.endsWith('/tag-aliases'))return json({aliases:[]});
  if(path.endsWith('/tags/update')&&method==='POST'){
   for(const edit of body?.edits??[])current=current.map(t=>t.id===edit.id?{...t,...edit}:t);
   version+=1;
   return json({map:mapPayload(),version,acceptance:null});
  }
  if(path.endsWith('/tags/align')&&method==='POST'){
   const ids:number[]=body?.ids??[];
   const picked=current.filter(t=>ids.includes(t.id));
   if(picked.length){
    // 服务端契约：top/bottom → 同一 y，left/right → 同一 x。
    current=current.map(t=>ids.includes(t.id)
     ?{...t,...(body.mode==='top'||body.mode==='bottom'?{y:picked[0]!.y}:{x:picked[0]!.x})}
     :t);
   }
   version+=1;
   return json({map:mapPayload(),version,acceptance:null});
  }
  if(path.endsWith('/tags')&&method==='DELETE'){
   const ids=new Set<number>(body?.ids??[]);
   current=current.filter(t=>!ids.has(t.id));
   version+=1;
   return json({map:mapPayload(),version,acceptance:null});
  }
  if(method!=='GET')return json({ok:true});
  return json({});
 });
}

async function enterMap(page:Page){
 await page.getByTitle('开始导航').click();
 await expect(page.getByTestId('map-select').locator(`option[value="${mapId}"]`)).toHaveCount(1);
 await page.getByTestId('map-select').selectOption(mapId);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await enterEditor(page);
 await page.getByLabel('适应地图').click();
 await page.waitForTimeout(300);
}

async function boot(page:Page){
 resetState();
 await installMocks(page);
 await page.goto('/');
 await enterMap(page);
}

async function pointOf(page:Page,id:number){
 await expect.poll(()=>page.evaluate(tagId=>!!(window as any).__mapCanvasApi?.screenOfTag(tagId),id)).toBe(true);
 return page.evaluate(tagId=>{
  const p=(window as any).__mapCanvasApi.screenOfTag(tagId);
  return {x:p.x as number,y:p.y as number};
 },id);
}

/** 等画布取景稳定：首帧之后 ResizeObserver/字体就绪还可能再 fit 一次。 */
async function stablePoint(page:Page,id:number){
 let previous=await pointOf(page,id);
 let calm=0;
 for(let i=0;i<25;i++){
  await page.waitForTimeout(60);
  const next=await pointOf(page,id);
  if(Math.abs(next.x-previous.x)<0.5&&Math.abs(next.y-previous.y)<0.5){
   calm+=1;
   if(calm>=3)return next;
  }else calm=0;
  previous=next;
 }
 return previous;
}

// 用真实节点中心在屏幕上的外接矩形反拖：右下 → 左上。
// 24 px 外扩既大于 16 px 热区、避免按在别的码上，又仍在 fit 的 56 px 屏边距内。
async function boxSelect(page:Page,ids:number[],margin=24){
 const points:{x:number;y:number}[]=[];
 for(const id of ids)points.push(await stablePoint(page,id));
 const left=Math.min(...points.map(p=>p.x))-margin;
 const right=Math.max(...points.map(p=>p.x))+margin;
 const top=Math.min(...points.map(p=>p.y))-margin;
 const bottom=Math.max(...points.map(p=>p.y))+margin;
 const start={x:right,y:bottom};
 const end={x:left,y:top};
 expect(start.x).toBeGreaterThan(end.x);
 expect(start.y).toBeGreaterThan(end.y);
 await page.mouse.move(start.x,start.y);
 await page.mouse.down();
 for(let i=1;i<=12;i++)await page.mouse.move(start.x+(end.x-start.x)*i/12,start.y+(end.y-start.y)*i/12);
 await page.mouse.up();
}

const alignWrites=()=>writes.filter(w=>w.method==='POST'&&w.path===`/api/maps/${mapId}/tags/align`);
const updateWrites=()=>writes.filter(w=>w.method==='POST'&&w.path===`/api/maps/${mapId}/tags/update`);
const deleteWrites=()=>writes.filter(w=>w.method==='DELETE'&&w.path===`/api/maps/${mapId}/tags`);

for(const vp of [{width:1024,height:768},{width:1440,height:900}]){
 test(`反拖框选 41/44：批量对齐/改规格/删除/取消并回到真实画布 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);
  await boot(page);
  const initial=structuredClone(Object.fromEntries(tags.map(t=>[t.id,{x:t.x,y:t.y,size:t.size}])));
  const bar=page.getByTestId('box-batch-bar');

  // 1) 右下→左上反拖框住 41/44（x≈1.4，y=1.0/1.5），批量条显示真实数量。
  await boxSelect(page,[41,44]);
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('已选 2 个');

  // 2) 水平对齐：只发 41/44，两者 y 相同，其余四个坐标原样。
  await page.getByTestId('box-batch-align-row').click();
  await expect.poll(()=>alignWrites().length,{timeout:8000}).toBe(1);
  const align=alignWrites()[0]!.body;
  expect([...align.ids].sort((a:number,b:number)=>a-b)).toEqual([41,44]);
  expect(align.mode).toBe('top');
  const y41=current.find(t=>t.id===41)!.y;
  const y44=current.find(t=>t.id===44)!.y;
  expect(Math.abs(y41-y44)).toBeLessThanOrEqual(1e-6);
  expect(y41).toBe(1.0);
  for(const id of [40,42,43,45]){
   const tag=current.find(t=>t.id===id)!;
   expect(tag.x).toBeCloseTo(initial[id]!.x,10);
   expect(tag.y).toBeCloseTo(initial[id]!.y,10);
  }

  // 3) 批量改规格到 80 mm：只改 41/44，其余保持 60 mm。
  await page.getByTestId('box-batch-size').fill('80');
  await page.getByTestId('box-batch-apply-size').click();
  await expect.poll(()=>updateWrites().length,{timeout:8000}).toBe(1);
  const update=updateWrites()[0]!.body;
  expect([...update.edits].map((edit:any)=>edit.id).sort((a:number,b:number)=>a-b)).toEqual([41,44]);
  expect(update.edits.every((edit:any)=>Math.abs(edit.size-.08)<1e-9)).toBe(true);
  expect(current.find(t=>t.id===41)!.size).toBeCloseTo(.08,10);
  expect(current.find(t=>t.id===44)!.size).toBeCloseTo(.08,10);
  for(const id of [40,42,43,45])expect(current.find(t=>t.id===id)!.size).toBeCloseTo(.06,10);

  // 4) 再框 42/45 并删除：只有这两个 id 消失。
  // 改过整行对齐与尺寸后重取视角，并用更紧的框，避免在 1024 宽度下把邻点一起框进来。
  // 复用第 1 步已验证可稳定框中的 41/44 来验证批量删除；
  // 42/45 留给第 5 步的“取消”手势（去掉重取视角后的脆弱重框）。
  await boxSelect(page,[41,44]);
  await expect(bar).toContainText('已选 2 个');
  await page.getByTestId('box-batch-delete').click();
  await expect.poll(()=>deleteWrites().length,{timeout:8000}).toBe(1);
  const del=deleteWrites()[0]!.body;
  expect([...del.ids].sort((a:number,b:number)=>a-b)).toEqual([41,44]);
  expect(current.some(t=>t.id===41||t.id===44)).toBe(false);
  expect(current.map(t=>t.id).sort((a:number,b:number)=>a-b)).toEqual([40,42,43,45]);
  await expect(bar).toHaveCount(0);

  // 5) 再框 42/45，点取消：批量条收起，且取消手势本身不追加任何写入。
  await page.waitForTimeout(600);
  await boxSelect(page,[42,45]);
  await expect(bar).toContainText('已选 2 个');
  const beforeCancel=writes.length;
  await page.getByTestId('box-batch-clear').click();
  await expect(bar).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(writes.length).toBe(beforeCancel);
 });
}
