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

// 真实入口：首页 → 开始导航 → 选图 → 画布。不再经过「路径编辑」旧工具项。
// 所有点位定位都用 window.__mapCanvasApi.screenOfTag()（真实 Konva 节点），
// 不按画布比例猜像素。
const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};

const mapId='regress-groupspec-map';
const robotStatus={connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]};

// 与服务端 groups/:gid/spec 完全相同的重建公式：n=gridSize，
// tile=(sizeMm-(n-1)*2)/n，members 按行优先铺满 n×n。
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
 return Array.from({length:n*n},(_,i)=>({
  id:ref+i,
  x:(-sizeMm/2+tile/2+(i%n)*(tile+2))/1000,
  y:(sizeMm/2-tile/2-Math.floor(i/n)*(tile+2))/1000,
  angle:0,
  size:tile/1.25/1000,
 }));
};

// 3×3 m 区域：三个独立码 24/26/27（y=1.0），以及 2×2 / 60 mm 的码组 B910，
// 组中心标签 910 位于 (2.2, 1.6)。
const group={id:'B910',referenceId:910,gridSize:2,sizeMm:60,gapMm:2,members:nMembers(2,60,910)};
const tags:any[]=[
 {id:24,rowId:'',x:1.0,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:26,rowId:'',x:1.4,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:27,rowId:'',x:1.8,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:910,groupId:'B910',rowId:'',x:2.2,y:1.6,angle:0,size:.06,kind:'waypoint',rules:[]},
];

const baseMap:any={
 ...snap.map,
 id:mapId,
 name:'groupspec 回归地图',
 routeMode:'map-only',
 rows:[],
 motionSegments:undefined,
 order:[],
 groups:[group],
 tags,
 zone:[{x:0,y:0},{x:3,y:0},{x:3,y:3},{x:0,y:3}],
};

let current:any[]=[];
let currentGroups:any[]=[];
let writes:{method:string;path:string;body:any}[]=[];
let version=1;

function resetState(){
 current=structuredClone(tags);
 currentGroups=structuredClone([group]);
 writes=[];
 version=1;
}
function mapPayload(){return {...baseMap,tags:structuredClone(current),groups:structuredClone(currentGroups)};}

// 与后端一致：重建 members，组 id 由起始编号推出，只改旧中心标签的 groupId/size。
function applySpec(body:any){
 const old=currentGroups[0];
 const oldRef=old?.referenceId??910;
 const ref=body.startId??oldRef;
 const rows=Math.max(1,Math.round(body.rows??body.gridSize??2));
 const cols=Math.max(1,Math.round(body.cols??body.gridSize??2));
 const widthMm=body.widthMm??body.sizeMm??old?.sizeMm??60;
 const heightMm=body.heightMm??body.sizeMm??old?.sizeMm??60;
 const gridSize=Math.max(rows,cols),sizeMm=Math.max(widthMm,heightMm);
 const next={id:'B'+String(ref).padStart(3,'0'),referenceId:ref,gridSize,sizeMm,rows,cols,widthMm,heightMm,gapMm:2,members:rectMembers(rows,cols,widthMm,heightMm,ref)};
 current=current.map(t=>t.id===oldRef?{...t,groupId:next.id,size:sizeMm/1000}:t);
 currentGroups=[next];
 return {group:next,centerId:oldRef};
}

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
   if(map){current=structuredClone(map.tags??[]);currentGroups=structuredClone(map.groups??[]);}
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
  if(/\/api\/maps\/[^/]+\/groups\/[^/]+\/spec$/.test(path)&&method==='POST'){
   const result=applySpec(body);
   version+=1;
   return json({map:mapPayload(),version,acceptance:null,group:result.group,centerId:result.centerId});
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

async function point(page:Page,id:number){
 await expect.poll(()=>page.evaluate(tagId=>!!(window as any).__mapCanvasApi?.screenOfTag(tagId),id)).toBe(true);
 return page.evaluate(tagId=>{
  const p=(window as any).__mapCanvasApi.screenOfTag(tagId);
  return {x:p.x as number,y:p.y as number};
 },id);
}

/** 等画布取景稳定：首帧之后 ResizeObserver/字体就绪还可能再 fit 一次。 */
async function stablePoint(page:Page,id:number){
 let previous=await point(page,id);
 let calm=0;
 for(let i=0;i<25;i++){
  await page.waitForTimeout(60);
  const next=await point(page,id);
  if(Math.abs(next.x-previous.x)<0.5&&Math.abs(next.y-previous.y)<0.5){
   calm+=1;
   if(calm>=3)return next;
  }else calm=0;
  previous=next;
 }
 return previous;
}

async function clickTag(page:Page,id:number){
 const p=await stablePoint(page,id);
 await page.mouse.click(p.x,p.y);
}

const specWrites=()=>writes.filter(w=>w.method==='POST'&&w.path.endsWith('/spec'));

for(const vp of [{width:1024,height:768},{width:1440,height:900}]){
 test(`组中心显示码组规格 2×2→3×3→1×1 并持久化 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);
  await boot(page);

  // 1) 点真实组中心 910：码组规格卡与当前几何。
  await clickTag(page,910);
  const spec=page.getByTestId('object-group-spec');
  await expect(spec).toBeVisible();
  await expect(page.getByTestId('object-group-grid')).toHaveValue('2');
  await expect(page.getByTestId('object-group-rows')).toHaveValue('2');
  await expect(page.getByTestId('object-group-size')).toHaveValue('60');
  await expect(page.getByTestId('object-group-tag-size')).toHaveValue('29');
  await expect(page.getByTestId('object-group-gap')).toHaveValue('2');

  // 2) 1024×768 / 1440×900：无横向溢出，浮窗完整落在视口内。
  const layout=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth}));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth+1);
  const popover=await page.getByTestId('object-inspector').boundingBox();
  expect(popover).not.toBeNull();
  expect(popover!.x).toBeGreaterThanOrEqual(0);
  expect(popover!.y).toBeGreaterThanOrEqual(0);
  expect(popover!.x+popover!.width).toBeLessThanOrEqual(vp.width+1);
  expect(popover!.y+popover!.height).toBeLessThanOrEqual(vp.height+1);

  // 3) 2×2 → 3×3：只提交新网格，尺寸不变；真实 payload 与回写状态都检查。
  await page.getByTestId('object-group-grid').selectOption('3');await page.getByTestId('object-group-rows').selectOption('3');
  await expect(page.getByTestId('object-group-rows')).toHaveValue('3');
  await page.getByTestId('object-group-apply').click();
  await expect.poll(()=>specWrites().length,{timeout:8000}).toBe(1);
  const grid3=specWrites()[0]!.body;
  // 新契约：面板提交独立 rows/cols/widthMm/heightMm（正方形时 3×3 / 60×60）
  expect(grid3.rows).toBe(3);
  expect(grid3.cols).toBe(3);
  expect(grid3.widthMm).toBe(60);
  expect(grid3.heightMm).toBe(60);
  expect(currentGroups[0]!.gridSize).toBe(3);
  expect(currentGroups[0]!.members).toHaveLength(9);
  expect(current.find(t=>t.id===910)!.size).toBeCloseTo(.06,10);
  await expect(page.getByTestId('object-group-tag-size')).toHaveValue('18.7');

  // 4) 重载后重新进入地图，3×3 仍是真实状态，重复点 910 仍显示 18.7。
  await page.reload();
  await enterMap(page);
  await clickTag(page,910);
  await expect(page.getByTestId('object-group-spec')).toBeVisible();
  await expect(page.getByTestId('object-group-grid')).toHaveValue('3');
  await expect(page.getByTestId('object-group-rows')).toHaveValue('3');
  await expect(page.getByTestId('object-group-tag-size')).toHaveValue('18.7');
  expect(currentGroups[0]!.members).toHaveLength(9);

  // 5) 3×3 → 1×1：成员缩为 1 个，整组尺寸不变，单码边长=整组尺寸，间距显示 —。
  await page.getByTestId('object-group-grid').selectOption('1');await page.getByTestId('object-group-rows').selectOption('1');
  await page.getByTestId('object-group-apply').click();
  await expect.poll(()=>specWrites().length,{timeout:8000}).toBe(2);
  const grid1=specWrites()[1]!.body;
  expect(grid1.rows).toBe(1);
  expect(grid1.cols).toBe(1);
  expect(grid1.widthMm).toBe(60);
  expect(grid1.heightMm).toBe(60);
  expect(currentGroups[0]!.gridSize).toBe(1);
  expect(currentGroups[0]!.members).toHaveLength(1);
  expect(currentGroups[0]!.sizeMm).toBe(60);
  await expect(page.getByTestId('object-group-tag-size')).toHaveValue('60');
  await expect(page.getByTestId('object-group-gap')).toHaveValue('—');

  // 6) 1×1 也持久化：重载后仍是 1×1 / 60 mm / 间距 —。
  await page.reload();
  await enterMap(page);
  await clickTag(page,910);
  await expect(page.getByTestId('object-group-spec')).toBeVisible();
  await expect(page.getByTestId('object-group-grid')).toHaveValue('1');
  await expect(page.getByTestId('object-group-rows')).toHaveValue('1');
  await expect(page.getByTestId('object-group-tag-size')).toHaveValue('60');
  await expect(page.getByTestId('object-group-gap')).toHaveValue('—');
  expect(currentGroups[0]!.members).toHaveLength(1);
 });
}
