import {test,expect,type Page,type Locator} from '@playwright/test';

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
// 点位定位只用 window.__mapCanvasApi.screenOfTag()/worldToClient()，不猜画布比例；
// 所有交互都是 page.mouse 的真实点击/拖动。API 全部在浏览器内 mock，数据只在本进程。
test.describe.configure({mode:'serial'});
test.use({viewport:{width:1280,height:800}});

const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};
const mapId='regress-rectarray-map';
const GAP_MM=2;

/** 板式几何：tileW/tileH 由整组宽高减去 (n-1) 道 2 mm 白缝再均分；成员边长 = min/1.25。 */
const groupMembers=(rows:number,cols:number,widthMm:number,heightMm:number,ref:number)=>{
 const tileW=(widthMm-(cols-1)*GAP_MM)/cols;
 const tileH=(heightMm-(rows-1)*GAP_MM)/rows;
 return Array.from({length:rows*cols},(_,i)=>{
  const col=i%cols,row=Math.floor(i/cols);
  return {
   id:ref+i,
   x:(-widthMm/2+tileW/2+col*(tileW+GAP_MM))/1000,
   y:(heightMm/2-tileH/2-row*(tileH+GAP_MM))/1000,
   angle:0,
   size:Math.min(tileW,tileH)/1.25/1000,
  };
 });
};
// 旧数据：2×2 / 60 mm（tile=29 mm），只有旧字段 gridSize/sizeMm。
const groupB910={id:'B910',referenceId:910,gridSize:2,sizeMm:60,gapMm:2,members:groupMembers(2,2,60,60,910)};

const tag=(id:number,x:number,y:number)=>({id,rowId:'',x,y,angle:0,size:.06,kind:'waypoint',rules:[]});
// 2×3 批量阵列（6 个独立码）：x=1.0/1.5/2.0，y=1.0/1.6，行优先。
// 注：契约里 Q024 同时被要求放在 (3.0,1.0) 当独立回归码，24 不可能又出现在阵列里，
// 所以阵列第六个用 27，坐标/尺寸完全一样（见交付说明）。
const BATCH_IDS=[20,21,22,23,25,27];
const batch:[number,number,number][]=[[20,1.0,1.0],[21,1.5,1.0],[22,2.0,1.0],[23,1.0,1.6],[25,1.5,1.6],[27,2.0,1.6]];
const tags:any[]=[
 ...batch.map(([id,x,y])=>tag(id,x,y)),
 tag(24,3.0,1.0),
 tag(26,3.4,1.0),
 tag(40,1.0,3.0),
 tag(41,1.4,3.0),
 tag(42,1.8,3.0),
 {id:910,groupId:'B910',rowId:'',x:2.6,y:2.6,angle:0,size:.06,kind:'waypoint',rules:[]},
];

const base:any={
 ...snap.map,
 id:mapId,
 name:'rectarray disposable map',
 routeMode:'map-only',
 rows:[],
 motionSegments:undefined,
 order:[],
 groups:[groupB910],
 tags,
 zone:[{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}],
};

let current:any[]=[];
let currentGroups:any[]=[];
let writes:{method:string;path:string;body:any}[]=[];
let rejectedWrites:{path:string;body:any}[]=[];
let errors:string[]=[];

const cp=(value:any)=>structuredClone(value);
const payload=()=>({...base,tags:cp(current),groups:cp(currentGroups)});
const specWrites=()=>writes.filter(w=>w.method==='POST'&&/\/groups\/[^/]+\/spec$/.test(w.path));
const mapWrites=()=>writes.filter(w=>w.method==='POST'&&w.path==='/api/maps');

async function boot(page:Page){
 current=cp(tags);currentGroups=[cp(groupB910)];writes=[];rejectedWrites=[];errors=[];
 page.on('pageerror',error=>errors.push(error.name+': '+error.message));
 page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]}})));
 await page.route('**/api/**',async route=>{
  const req=route.request();
  const p=new URL(req.url()).pathname;
  const method=req.method();
  const body=req.postData()?JSON.parse(req.postData()!):null;
  const json=(value:any,status=200)=>route.fulfill({status,json:value});
  if(method!=='GET')writes.push({method,path:p,body});
  if(p==='/api/camera/status')return json({running:true,present:true,frameAgeMs:10,error:''});
  if(p==='/api/robot/status')return json({connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]});
  if(p==='/api/localization/map')return json({anchored:true,mapId});
  if(p==='/api/localization/scope')return json({phase:'anchored'});
  if(p==='/api/maps'&&method==='GET')return json([{id:mapId,name:base.name,version:1}]);
  if(p==='/api/maps'&&method==='POST'){
   const map=body?.map??body;
   current=cp(map?.tags??[]);
   if(Array.isArray(map?.groups))currentGroups=cp(map.groups);
   return json({map:payload(),version:1,acceptance:null});
  }
  if(p==='/api/maps/'+mapId&&method==='GET')return json({map:payload(),version:1,acceptance:null});
  if(['/api/surveys','/api/tasks','/api/routes','/api/boards','/api/camera/calibration'].includes(p))return json([]);
  if(p.endsWith('/tag-aliases'))return json({aliases:[]});
  if(p.endsWith('/tag-distance')&&method==='POST'){
   if(body.targetM<.1){rejectedWrites.push({path:p,body});return json({error:'目标距离小于最小中心距 0.10 m'},400);}
   const from=current.find(t=>t.id===body.fromId),to=current.find(t=>t.id===body.toId);
   const others=current.filter(t=>t.id!==body.fromId&&t.id!==body.toId);
   const d=Math.hypot(to.x-from.x,to.y-from.y),u={x:(to.x-from.x)/d,y:(to.y-from.y)/d};
   const next={x:from.x+u.x*body.targetM,y:from.y+u.y*body.targetM};
   if(others.some(t=>Math.hypot(next.x-t.x,next.y-t.y)<.1))return json({error:'目标位置与其他码重合，违反最小中心距'},400);
   current=current.map(t=>t.id===body.toId?{...t,x:next.x,y:next.y}:t);
   return json({map:payload(),version:1,beforeM:d,afterM:body.targetM,axis:Math.abs(u.x)>Math.abs(u.y)?'x':'y',changedTags:[body.toId]});
  }
  if(p.endsWith('/tag-equal-spacing')&&method==='POST'){
   if(body.targetM<.1){rejectedWrites.push({path:p,body});return json({error:'目标距离小于最小中心距 0.10 m'},400);}
   const ids:number[]=body.ids;
   const picked=ids.map(id=>current.find(t=>t.id===id));
   const axis=Math.abs(picked[0].x-picked[1].x)>=Math.abs(picked[0].y-picked[1].y)?'x':'y';
   const sorted=[...picked].sort((a,z)=>axis==='x'?a.x-z.x:a.y-z.y);
   current=current.map(t=>{
    const i=sorted.findIndex(a=>a.id===t.id);
    return i<0?t:{...t,[axis]:sorted[0][axis]+i*body.targetM};
   });
   return json({map:payload(),version:1,order:sorted.map(t=>t.id),axis,count:ids.length,spanAfterM:(ids.length-1)*body.targetM});
  }
  if(p.endsWith('/tags/update')&&method==='POST'){
   for(const edit of body?.edits??[])current=current.map(t=>t.id===edit.id?{...t,...edit}:t);
   return json({map:payload(),version:1});
  }
  if(p.endsWith('/tags/align')&&method==='POST'){
   const ids:number[]=body?.ids??[];
   const picked=current.filter(t=>ids.includes(t.id));
   const axis=body.mode==='top'||body.mode==='bottom'?'y':'x';
   const value=picked[0]?.[axis];
   current=current.map(t=>ids.includes(t.id)?{...t,[axis]:value}:t);
   return json({map:payload(),version:1});
  }
  if(p.endsWith('/tags')&&method==='DELETE'){
   const ids=new Set<number>(body?.ids??[]);
   current=current.filter(t=>!ids.has(t.id));
   return json({map:payload(),version:1});
  }
  const spec=p.match(/\/api\/maps\/[^/]+\/groups\/([^/]+)\/spec$/);
  if(spec&&method==='POST'){
   const oldRef=currentGroups[0]?.referenceId??910;
   const ref=body.startId??oldRef;
   // 新契约：rows/cols/widthMm/heightMm；旧契约 gridSize/sizeMm 也接受（gridSize→rows=cols）。
   const rows=body.rows??body.gridSize;
   const cols=body.cols??body.gridSize;
   const widthMm=body.widthMm??body.sizeMm;
   const heightMm=body.heightMm??body.sizeMm;
   const members=groupMembers(rows,cols,widthMm,heightMm,ref);
   const group={
    id:'B'+String(ref).padStart(3,'0'),referenceId:ref,
    gridSize:Math.max(rows,cols),sizeMm:Math.max(widthMm,heightMm),
    rows,cols,widthMm,heightMm,gapMm:2,members,
   };
   currentGroups=[group];
   const size=Math.max(widthMm,heightMm)/1000;
   current=current.map(t=>t.id===oldRef?{...t,groupId:group.id,size}:t);
   return json({map:payload(),version:1,group,centerId:oldRef});
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
 await page.waitForTimeout(250);
}
async function pointOf(page:Page,id:number):Promise<{x:number;y:number}>{
 const p=await page.evaluate(tagId=>(window as any).__mapCanvasApi?.screenOfTag(tagId),id);
 if(!p)throw new Error('screenOfTag('+id+') returned null');
 return p;
}
async function move(page:Page,a:{x:number;y:number},b:{x:number;y:number}){
 await page.mouse.move(a.x,a.y);
 await page.mouse.down();
 for(let i=1;i<=10;i++)await page.mouse.move(a.x+(b.x-a.x)*i/10,a.y+(b.y-a.y)*i/10);
 await page.mouse.up();
}
async function clickId(page:Page,id:number){
 const p=await pointOf(page,id);
 await page.mouse.click(p.x,p.y);
}
async function clickBlank(page:Page){
 const box=await page.getByTestId('map-canvas').boundingBox();
 if(!box)throw new Error('map-canvas 没有 boundingBox');
 await page.mouse.click(box.x+20,box.y+box.height-20);
}
async function stablePoint(page:Page,id:number){
 let previous=await pointOf(page,id);
 let calm=0;
 for(let i=0;i<60;i++){
  await page.waitForTimeout(60);
  const next=await pointOf(page,id);
  if(Math.abs(next.x-previous.x)<0.5&&Math.abs(next.y-previous.y)<0.5){
   calm+=1;
   if(calm>=4)return next;
  }else calm=0;
  previous=next;
 }
 return previous;
}
async function box(page:Page,ids:number[]){
 const points:({x:number;y:number})[]=[];
 for(const id of ids)points.push(await stablePoint(page,id));
 const margin=26;
 const x0=Math.min(...points.map(p=>p.x))-margin;
 const x1=Math.max(...points.map(p=>p.x))+margin;
 const y0=Math.min(...points.map(p=>p.y))-margin;
 const y1=Math.max(...points.map(p=>p.y))+margin;
 await move(page,{x:x0,y:y0},{x:x1,y:y1});
}
async function ensureCanvasPoint(page:Page,p:{x:number;y:number}){
 const over=await page.evaluate(({x,y})=>{
  const el=document.elementFromPoint(x,y) as HTMLElement|null;
  return !!el&&!!el.closest('[data-testid="map-canvas"]');
 },p);
 if(!over)throw new Error(`(${p.x.toFixed(0)},${p.y.toFixed(0)}) 不在画布上，被浮层或面板挡住了`);
}
async function rowText(loc:Locator){
 const tag=await loc.evaluate(el=>el.tagName);
 return tag==='INPUT'||tag==='SELECT'?await loc.inputValue():await loc.innerText();
}
async function rawField(page:Page,testId:string){
 const loc=page.getByTestId(testId);
 if(await loc.evaluate(el=>el.tagName)==='LABEL'){
  const control=loc.locator('input,select').first();
  return (await rowText(control)).trim();
 }
 return (await rowText(loc)).trim();
}
async function numField(page:Page,testId:string){
 const n=Number(await rawField(page,testId));
 return Number.isFinite(n)?n:NaN;
}
async function setField(page:Page,testId:string,value:string){
 const loc=page.getByTestId(testId);
 await expect(loc).toBeVisible();
 // 有些字段的 testid 在 <label> 上（真实控件是它的 input/select），两种都支持。
 const control=(await loc.evaluate(el=>el.tagName))==='LABEL'?loc.locator('input,select').first():loc;
 const tag=await control.evaluate(el=>el.tagName);
 if(tag==='SELECT')await control.selectOption(value);
 else await control.fill(value);
 expect(Number(await rawField(page,testId))).toBe(Number(value));
}
/** 面板显示值必须真的就是这一位小数（例如 30.9 而不是 30.93）。 */
async function expectShown(page:Page,testId:string,pattern:RegExp){
 await expect.poll(async()=>pattern.test(await rawField(page,testId))).toBe(true);
 expect(await rawField(page,testId)).toMatch(pattern);
}
function factM(text:string,label:string){
 const hit=new RegExp('(?:^|[\\s])'+label+'\\s*([0-9.]+)\\s*m','m').exec(text);
 return hit?Number(hit[1]):NaN;
}
function changedIds(before:any[]){
 const old=new Map(before.map(t=>[t.id,t]));
 return current.filter(t=>{
  const prev=old.get(t.id);
  return !prev||Math.abs(prev.x-t.x)>1e-9||Math.abs(prev.y-t.y)>1e-9;
 }).map(t=>t.id).sort((a,b)=>a-b);
}

test('矩形码组 2×3 可选可存',async({page})=>{
 await boot(page);
 await clickId(page,910);
 await expect(page.getByTestId('object-group-spec')).toBeVisible();
 await setField(page,'object-group-cols','3');
 await setField(page,'object-group-rows','2');
 await setField(page,'object-group-width','120');
 await setField(page,'object-group-height','80');
 await page.getByTestId('object-group-apply').click();
 await expect.poll(()=>currentGroups[0]?.rows).toBe(2);
 await expect.poll(()=>currentGroups[0]?.cols).toBe(3);
 await expect.poll(()=>currentGroups[0]?.widthMm).toBe(120);
 await expect.poll(()=>currentGroups[0]?.heightMm).toBe(80);
 await expect.poll(()=>currentGroups[0]?.gridSize).toBe(3);
 await expect.poll(()=>currentGroups[0]?.sizeMm).toBe(120);
 await expect.poll(()=>currentGroups[0]?.members?.length).toBe(6);
 expect(currentGroups[0].gapMm).toBe(2);
 expect(currentGroups[0].id).toBe('B910');
 expect(currentGroups[0].members[0].id).toBe(910);
 expect(currentGroups[0].members[5].id).toBe(915);
 const tileW=(120-(3-1)*GAP_MM)/3,tileH=(80-(2-1)*GAP_MM)/2;
 expect(currentGroups[0].members[0].size).toBeCloseTo(Math.min(tileW,tileH)/1.25/1000,9);
 expect(currentGroups[0].members[0].x).toBeCloseTo((-120/2+tileW/2)/1000,9);
 expect(currentGroups[0].members[0].y).toBeCloseTo((80/2-tileH/2)/1000,9);
 const sent=specWrites();
 expect(sent.length).toBe(1);
 expect(sent[0]!.body.rows).toBe(2);
 expect(sent[0]!.body.cols).toBe(3);
 expect(sent[0]!.body.widthMm).toBe(120);
 expect(sent[0]!.body.heightMm).toBe(80);
 expect(typeof sent[0]!.body.baseVersion).toBe('number');
 expect(current.find(t=>t.id===910)!.groupId).toBe('B910');
 expect(current.find(t=>t.id===910)!.size).toBeCloseTo(0.12,9);
 // 面板显示的是「单码占位边长」(tile)，与旧数据 2×2/60 显示 29 同一口径：
 // min(116/3,78/2)=38.6667 → 38.7。成员物理边长 30.933 mm 在上面的 members[0].size 里已断言。
 // 契约文字里的 30.9 与同一契约的 1×3/3×1=38.7、旧数据=29 冲突，见交付说明。
 await expectShown(page,'object-group-tag-size',/^38\.7(?:0*)$/);
 await page.reload();
 await gotoMap(page);
 await clickId(page,910);
 await expect(page.getByTestId('object-group-spec')).toBeVisible();
 await expect.poll(()=>numField(page,'object-group-cols')).toBe(3);
 await expect.poll(()=>numField(page,'object-group-rows')).toBe(2);
 await expect.poll(()=>numField(page,'object-group-width')).toBe(120);
 await expect.poll(()=>numField(page,'object-group-height')).toBe(80);
 await expectShown(page,'object-group-tag-size',/^38\.7(?:0*)$/);
 expect(errors.filter(e=>e.includes('TypeError'))).toEqual([]);
});

test('1×3 与 3×1 合法',async({page})=>{
 await boot(page);
 await clickId(page,910);
 await expect(page.getByTestId('object-group-spec')).toBeVisible();
 await setField(page,'object-group-cols','3');
 await setField(page,'object-group-rows','1');
 await setField(page,'object-group-width','120');
 await setField(page,'object-group-height','40');
 await page.getByTestId('object-group-apply').click();
 await expect.poll(()=>currentGroups[0]?.rows).toBe(1);
 await expect.poll(()=>currentGroups[0]?.cols).toBe(3);
 await expect.poll(()=>currentGroups[0]?.widthMm).toBe(120);
 await expect.poll(()=>currentGroups[0]?.heightMm).toBe(40);
 await expect.poll(()=>currentGroups[0]?.members?.length).toBe(3);
 await expect.poll(()=>currentGroups[0]?.gridSize).toBe(3);
 expect(currentGroups[0].members[0].size).toBeCloseTo(Math.min((120-2*GAP_MM)/3,40)/1.25/1000,9);
 await setField(page,'object-group-cols','1');
 await setField(page,'object-group-rows','3');
 await setField(page,'object-group-width','40');
 await setField(page,'object-group-height','120');
 await page.getByTestId('object-group-apply').click();
 await expect.poll(()=>currentGroups[0]?.rows).toBe(3);
 await expect.poll(()=>currentGroups[0]?.cols).toBe(1);
 await expect.poll(()=>currentGroups[0]?.widthMm).toBe(40);
 await expect.poll(()=>currentGroups[0]?.heightMm).toBe(120);
 await expect.poll(()=>currentGroups[0]?.members?.length).toBe(3);
 const sent=specWrites();
 expect(sent.length).toBe(2);
 expect(sent[0]!.body.rows).toBe(1);
 expect(sent[0]!.body.cols).toBe(3);
 expect(sent[1]!.body.rows).toBe(3);
 expect(sent[1]!.body.cols).toBe(1);
 expect(sent[1]!.body.widthMm).toBe(40);
 expect(sent[1]!.body.heightMm).toBe(120);
 await page.reload();
 await gotoMap(page);
 await clickId(page,910);
 await expect(page.getByTestId('object-group-spec')).toBeVisible();
 await expect.poll(()=>numField(page,'object-group-cols')).toBe(1);
 await expect.poll(()=>numField(page,'object-group-rows')).toBe(3);
 await expect.poll(()=>numField(page,'object-group-width')).toBe(40);
 await expect.poll(()=>numField(page,'object-group-height')).toBe(120);
 await expectShown(page,'object-group-tag-size',/^38\.7(?:0*)$/);
});

test('2×2 旧数据不回归',async({page})=>{
 await boot(page);
 await page.reload();
 await gotoMap(page);
 await clickId(page,910);
 await expect(page.getByTestId('object-group-spec')).toBeVisible();
 await expect.poll(()=>numField(page,'object-group-cols')).toBe(2);
 await expect.poll(()=>numField(page,'object-group-rows')).toBe(2);
 await expect.poll(()=>numField(page,'object-group-width')).toBe(60);
 await expect.poll(()=>numField(page,'object-group-height')).toBe(60);
 const gap=/([0-9.]+)/.exec(await rowText(page.getByTestId('object-group-gap')));
 expect(gap).not.toBeNull();
 expect(Number(gap![1])).toBe(2);
 await expectShown(page,'object-group-tag-size',/^29(?:\.0+)?$/);
 await page.getByTestId('object-group-apply').click();
 await expect.poll(()=>specWrites().length).toBe(1);
 const body=specWrites()[0]!.body;
 expect(body.rows).toBe(2);
 expect(body.cols).toBe(2);
 expect(body.widthMm).toBe(60);
 expect(body.heightMm).toBe(60);
 await expect.poll(()=>currentGroups[0]?.rows).toBe(2);
 await expect.poll(()=>currentGroups[0]?.cols).toBe(2);
 await expect.poll(()=>currentGroups[0]?.members?.length).toBe(4);
 await expect.poll(()=>currentGroups[0]?.members?.[3]?.id).toBe(913);
 expect(currentGroups[0].members[0].size).toBeCloseTo(29/1.25/1000,9);
 await expectShown(page,'object-group-tag-size',/^29(?:\.0+)?$/);
 expect(current.find(t=>t.id===910)!.size).toBeCloseTo(.06,9);
});

test('二维阵列批量不是一条线',async({page})=>{
 await boot(page);
 await box(page,BATCH_IDS);
 const bar=page.getByTestId('box-batch-bar');
 await expect(bar).toBeVisible();
 await expect(bar).toContainText('已选 6');
 await expect(page.getByTestId('box-batch-rows')).toHaveText('2');
 await expect(page.getByTestId('box-batch-cols')).toHaveText('3');
 await expect(page.getByTestId('tag-spacing-card')).toHaveCount(0);
 const facts=page.getByTestId('box-batch-facts');
 await expect(facts).toBeVisible();
 const factText=await facts.innerText();
 const lengthM=factM(factText,'长'),heightM=factM(factText,'高');
 expect(Number.isFinite(lengthM)).toBe(true);
 expect(Number.isFinite(heightM)).toBe(true);
 expect(Math.abs(lengthM-1.06)).toBeLessThanOrEqual(0.001);
 expect(Math.abs(heightM-0.66)).toBeLessThanOrEqual(0.001);
 const arrayLabel=page.getByTestId('box-batch-array-label');
 const scope=await arrayLabel.count()?arrayLabel:facts;
 await expect(scope).toContainText('二维阵列');

 // 整组宽/高与横/纵向间距是同一个模型的两种输入：改宽高要立刻反算出间距。
 // 3 列 2 行、单码 60 mm：宽 800 → 横距 (800-60)/2 = 0.37 m；高 600 → 纵距 (600-60)/1 = 0.54 m。
 await page.getByTestId('box-batch-width').fill('800');
 await expect(page.getByTestId('box-batch-pitch-x')).toHaveValue('0.37');
 await page.getByTestId('box-batch-height').fill('600');
 await expect(page.getByTestId('box-batch-pitch-y')).toHaveValue('0.54');
 const before=cp(current);
 await page.getByTestId('box-batch-pitch-x').fill('0.8');
 await page.getByTestId('box-batch-pitch-y').fill('0.9');
 await page.getByTestId('box-batch-reshape').click();
 // 重排以左上角为原点，因此原点那个点本来就在目标位置，不会变；其余 5 个必须移动。
 await expect.poll(()=>changedIds(before).length,{timeout:8000}).toBeGreaterThanOrEqual(5);
 expect(writes.length).toBeGreaterThanOrEqual(1);
 for(const id of changedIds(before))expect(BATCH_IDS.includes(id)).toBe(true);
 const moved=current.filter(t=>BATCH_IDS.includes(t.id));
 const xs=[...new Set(moved.map(t=>Math.round(t.x*1e6)/1e6))].sort((a,b)=>a-b);
 const ys=[...new Set(moved.map(t=>Math.round(t.y*1e6)/1e6))].sort((a,b)=>a-b);
 expect(xs.length).toBe(3);
 expect(ys.length).toBe(2);
 expect(Math.abs((xs[1]-xs[0])-0.8)).toBeLessThanOrEqual(0.001);
 expect(Math.abs((xs[2]-xs[1])-0.8)).toBeLessThanOrEqual(0.001);
 expect(Math.abs((ys[1]-ys[0])-0.9)).toBeLessThanOrEqual(0.001);
 for(const t of moved){
  expect(xs.some(x=>Math.abs(x-t.x)<=0.001)).toBe(true);
  expect(ys.some(y=>Math.abs(y-t.y)<=0.001)).toBe(true);
 }
 const old=new Map<number,any>(before.map((t:any)=>[t.id,t] as [number,any]));
 for(const id of [24,26,40,41,42,910]){
  const now=current.find(t=>t.id===id)!;
  const prev=old.get(id)!;
  expect(now.x).toBeCloseTo(prev.x,9);
  expect(now.y).toBeCloseTo(prev.y,9);
  expect(now.size).toBeCloseTo(prev.size,9);
 }
});

test('共线一行改相邻间距',async({page})=>{
 await boot(page);
 await box(page,[40,41,42]);
 const card=page.getByTestId('tag-spacing-card');
 await expect(card).toBeVisible();
 await expect(card).toContainText('Q040');
 await expect(card).toContainText('Q041');
 await expect(card).toContainText('Q042');
 const before=cp(current);
 await page.getByTestId('tag-spacing-target').fill('0.55');
 await page.getByTestId('tag-spacing-apply').click();
 await expect.poll(()=>writes.filter(w=>w.path.endsWith('/tag-equal-spacing')).length,{timeout:8000}).toBe(1);
 const body=writes.find(w=>w.path.endsWith('/tag-equal-spacing'))!.body;
 expect(body.ids).toEqual([40,41,42]);
 expect(body.targetM).toBeCloseTo(0.55,9);
 const xs=[40,41,42].map(id=>current.find(t=>t.id===id)!.x).sort((a,b)=>a-b);
 expect(Math.abs((xs[1]-xs[0])-0.55)).toBeLessThanOrEqual(0.001);
 expect(Math.abs((xs[2]-xs[1])-0.55)).toBeLessThanOrEqual(0.001);
 for(const id of [40,41,42]){
  expect(current.find(t=>t.id===id)!.y).toBeCloseTo(3.0,9);
 }
 const old=new Map<number,any>(before.map((t:any)=>[t.id,t] as [number,any]));
 for(const id of [20,21,22,23,25,27,24,26,910]){
  const now=current.find(t=>t.id===id)!;
  const prev=old.get(id)!;
  expect(now.x).toBeCloseTo(prev.x,9);
  expect(now.y).toBeCloseTo(prev.y,9);
 }
});

test('0.10 m 前置拦截',async({page})=>{
 await boot(page);
 await box(page,[24,26]);
 const card=page.getByTestId('tag-distance-card');
 await expect(card).toBeVisible();
 await expect(page.getByTestId('box-batch-bar')).toContainText('已选 2');
 const target=page.getByTestId('tag-distance-target');
 const apply=page.getByTestId('tag-distance-apply');
 await target.fill('0.05');
 await expect(apply).toBeDisabled();
 await expect(card).toContainText('0.10');
 await expect(target).toHaveValue('0.05');
 await page.waitForTimeout(300);
 expect(writes.filter(w=>w.path.endsWith('/tag-distance')&&Number(w.body?.targetM)<.1)).toEqual([]);
 expect(writes.filter(w=>w.path.endsWith('/tag-distance'))).toEqual([]);
 expect(rejectedWrites).toEqual([]);
});

test('回归 Q024/Q026/移动/框选删除',async({page})=>{
 await boot(page);
 await clickId(page,24);
 await expect(page.getByTestId('object-inspector')).toContainText('Q024');
 await clickId(page,26);
 await expect(page.getByTestId('object-inspector')).toContainText('Q026');
 await clickBlank(page);
 await expect(page.getByTestId('object-inspector')).toHaveCount(0);
 const from=await stablePoint(page,26);
 const pxPerM=await page.evaluate(()=>{
  const api=(window as any).__mapCanvasApi;
  const a=api.worldToClient({x:0,y:0}),b=api.worldToClient({x:1,y:0});
  return Math.hypot(b.x-a.x,b.y-a.y);
 });
 expect(pxPerM).toBeGreaterThan(20);
 const to={x:from.x+0.2*pxPerM,y:from.y};
 await ensureCanvasPoint(page,from);
 await ensureCanvasPoint(page,to);
 await move(page,from,to);
 await expect.poll(()=>current.find(t=>t.id===26)?.x,{timeout:8000}).toBeGreaterThan(3.55);
 const dragged=current.find(t=>t.id===26)!;
 expect(Math.abs(dragged.x-3.6)).toBeLessThan(0.03);
 expect(Math.abs(dragged.y-1.0)).toBeLessThan(0.01);
 expect(mapWrites().length).toBeGreaterThanOrEqual(1);
 const sent=mapWrites()[mapWrites().length-1]!.body.map.tags.find((t:any)=>t.id===26);
 expect(sent).toBeTruthy();
 expect(Math.abs(sent.x-dragged.x)).toBeLessThan(1e-9);
 expect(Math.abs(sent.y-1.0)).toBeLessThan(0.01);
 await page.waitForTimeout(400);
 await clickBlank(page);
 await box(page,[20,21]);
 await expect(page.getByTestId('box-batch-bar')).toContainText('已选 2');
 await page.getByTestId('box-batch-delete').click();
 await expect.poll(()=>current.some(t=>t.id===20||t.id===21)).toBe(false);
 const del=writes.find(w=>w.method==='DELETE'&&w.path.endsWith('/tags'))!.body;
 expect([...del.ids].sort((a:number,b:number)=>a-b)).toEqual([20,21]);
 for(const id of [22,23,25,27,24,26,40,41,42,910])expect(current.some(t=>t.id===id)).toBe(true);
});

test('1024×768 布局',async({page})=>{
 await page.setViewportSize({width:1024,height:768});
 await boot(page);
 await clickId(page,24);
 const inspector=page.getByTestId('object-inspector');
 await expect(inspector).toBeVisible();
 const box=await inspector.boundingBox();
 expect(box).not.toBeNull();
 expect(box!.x).toBeGreaterThanOrEqual(0);
 expect(box!.y).toBeGreaterThanOrEqual(0);
 expect(box!.x+box!.width).toBeLessThanOrEqual(1024);
 expect(box!.y+box!.height).toBeLessThanOrEqual(768);
 const size=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,iw:window.innerWidth}));
 expect(size.sw).toBeLessThanOrEqual(size.iw+1);
});
