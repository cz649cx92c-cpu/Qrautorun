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

test.describe.configure({mode:'serial'});
test.use({viewport:{width:1280,height:800}});
const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};
const mapId='regress-pointedit2-map';
const members=(n:number,sizeMm:number,ref:number)=>{const tile=(sizeMm-(n-1)*2)/n;return Array.from({length:n*n},(_,i)=>{const col=i%n,row=Math.floor(i/n);return {id:ref+i,x:(-sizeMm/2+tile/2+col*(tile+2))/1000,y:(sizeMm/2-tile/2-row*(tile+2))/1000,angle:0,size:tile/1.25/1000};});};
const group={id:'B910',referenceId:910,gridSize:2,sizeMm:60,gapMm:2,members:members(2,60,910)};
const tags:any[]=[...[24,26,27].map((id,i)=>({id,rowId:'',x:1+i*.4,y:1,angle:0,size:.06,kind:'waypoint',rules:[]})),...[30,31,32].map((id,i)=>({id,rowId:'',x:1+i*.4,y:1.8,angle:0,size:.06,kind:'waypoint',rules:[]})),{id:910,groupId:'B910',rowId:'',x:2.4,y:2.4,angle:0,size:.06,kind:'waypoint',rules:[]}];
const base:any={...snap.map,id:mapId,name:'pointedit2 disposable',routeMode:'map-only',rows:[],motionSegments:undefined,order:[],groups:[group],tags,zone:[{x:0,y:0},{x:3,y:0},{x:3,y:3},{x:0,y:3}]};
let current:any[],currentGroups:any[],writes:any[],rejectedWrites:any[],errors:string[];
const cp=(x:any)=>structuredClone(x); const payload=()=>({...base,tags:cp(current),groups:cp(currentGroups)});
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
function rebuildSpec(b:any){
 const old=currentGroups[0]?.referenceId??910;
 const ref=b.startId??old;
 const rows=Math.max(1,Math.round(b.rows??b.gridSize??2));
 const cols=Math.max(1,Math.round(b.cols??b.gridSize??2));
 const widthMm=b.widthMm??b.sizeMm??60;
 const heightMm=b.heightMm??b.sizeMm??60;
 const gridSize=Math.max(rows,cols),sizeMm=Math.max(widthMm,heightMm);
 const g={id:'B'+String(ref).padStart(3,'0'),referenceId:ref,gridSize,sizeMm,rows,cols,widthMm,heightMm,gapMm:2,members:rectMembers(rows,cols,widthMm,heightMm,ref)};
 currentGroups=[g];
 current=current.map(t=>t.id===old?{...t,groupId:g.id,size:sizeMm/1000}:t);
 return g;
}
function dist(a:any,b:any){return Math.hypot(b.x-a.x,b.y-a.y);}
async function boot(page:Page){
 current=cp(tags);currentGroups=[cp(group)];writes=[];rejectedWrites=[];errors=[];page.on('pageerror',e=>errors.push(e.name+': '+e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]}})));
 await page.route('**/api/**',async r=>{const q=r.request(),p=new URL(q.url()).pathname,m=q.method(),b=q.postData()?JSON.parse(q.postData()!):null,j=(v:any,status=200)=>r.fulfill({status,json:v});if(m!=='GET')writes.push({method:m,path:p,body:b});
  if(p==='/api/camera/status')return j({running:true,present:true,frameAgeMs:10,error:''});if(p==='/api/robot/status')return j({connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]});if(p==='/api/localization/map')return j({anchored:true,mapId});if(p==='/api/localization/scope')return j({phase:'anchored'});
  if(p==='/api/maps'&&m==='GET')return j([{id:mapId,name:base.name,version:1}]);if(p==='/api/maps'&&m==='POST'){current=cp((b.map??b).tags??[]);currentGroups=cp((b.map??b).groups??[]);return j({map:payload(),version:1});}if(p==='/api/maps/'+mapId&&m==='GET')return j({map:payload(),version:1,acceptance:null});if(['/api/surveys','/api/tasks','/api/routes','/api/boards','/api/camera/calibration'].includes(p))return j([]);if(p.endsWith('/tag-aliases'))return j({aliases:[]});
  if(p.endsWith('/tag-distance')&&m==='POST'){if(b.targetM<.1){rejectedWrites.push({path:p,body:b});return j({error:'目标距离小于最小中心距 0.10 m'},400);}const a=current.find(t=>t.id===b.fromId),to=current.find(t=>t.id===b.toId),others=current.filter(t=>t.id!==b.fromId&&t.id!==b.toId);const d=dist(a,to),u={x:(to.x-a.x)/d,y:(to.y-a.y)/d},next={x:a.x+u.x*b.targetM,y:a.y+u.y*b.targetM};if(others.some(t=>dist(next,t)<.1))return j({error:'目标位置与其他码重合，违反最小中心距'},400);current=current.map(t=>t.id===b.toId?{...t,x:next.x,y:next.y}:t);return j({map:payload(),version:1,beforeM:d,afterM:b.targetM,axis:Math.abs(u.x)>Math.abs(u.y)?'x':'y',changedTags:[b.toId]});}
  if(p.endsWith('/tag-equal-spacing')&&m==='POST'){if(b.targetM<.1){rejectedWrites.push({path:p,body:b});return j({error:'目标距离小于最小中心距 0.10 m'},400);}const ids=b.ids,arr=ids.map((id:number)=>current.find(t=>t.id===id));const axis=Math.abs(arr[0].x-arr[1].x)>=Math.abs(arr[0].y-arr[1].y)?'x':'y';const sorted=[...arr].sort((a,z)=>axis==='x'?a.x-z.x:a.y-z.y);current=current.map(t=>{const i=sorted.findIndex(a=>a.id===t.id);return i<0?t:{...t,[axis]:sorted[0][axis]+i*b.targetM};});return j({map:payload(),version:1,order:sorted.map(t=>t.id),axis,count:ids.length,spanAfterM:(ids.length-1)*b.targetM});}
  if(p.endsWith('/tags/update')&&m==='POST'){for(const e of b.edits??[])current=current.map(t=>t.id===e.id?{...t,...e}:t);return j({map:payload(),version:1});}if(p.endsWith('/tags/align')&&m==='POST'){const ids=b.ids??[],a=current.filter(t=>ids.includes(t.id));const axis=b.mode==='top'||b.mode==='bottom'?'y':'x';const v=a[0]?.[axis];current=current.map(t=>ids.includes(t.id)?{...t,[axis]:v}:t);return j({map:payload(),version:1});}if(p.endsWith('/tags')&&m==='DELETE'){const ids=new Set(b.ids??[]);current=current.filter(t=>!ids.has(t.id));return j({map:payload(),version:1});}
  const sm=p.match(new RegExp('/api/maps/'+mapId+'/groups/([^/]+)/spec$'));if(sm&&m==='POST'){const old=currentGroups[0]?.referenceId??910;const g=rebuildSpec(b);return j({map:payload(),version:1,group:g,centerId:old});}if(m!=='GET')return j({ok:true});return j({});});
 await gotoMap(page);
}
async function gotoMap(page:Page){
 await page.goto('/');await page.getByTitle('开始导航').click();await page.getByTestId('map-select').selectOption(mapId);await expect(page.getByTestId('map-canvas')).toBeVisible();await enterEditor(page);
 await page.getByLabel('适应地图').click();await page.waitForTimeout(200);
}
async function point(page:Page,id:number){const p=await page.evaluate(id=>(window as any).__mapCanvasApi?.screenOfTag(id),id);if(!p)throw new Error('screenOfTag('+id+') returned null');return p;}
async function move(page:Page,a:any,b:any,mid?:(i:number)=>Promise<void>){await page.mouse.move(a.x,a.y);await page.mouse.down();for(let i=1;i<=8;i++){await page.mouse.move(a.x+(b.x-a.x)*i/8,a.y+(b.y-a.y)*i/8);if(mid)await mid(i);}await page.mouse.up();}
async function clickId(page:Page,id:number){const p=await point(page,id);await page.mouse.click(p.x,p.y);}
async function ensureCanvasPoint(page:Page,p:{x:number;y:number}){
 const overCanvas=await page.evaluate(({x,y})=>{
  const el=document.elementFromPoint(x,y) as HTMLElement|null;
  return !!el&&!!el.closest('[data-testid="map-canvas"]');
 },p);
 if(!overCanvas)throw new Error(`(${p.x.toFixed(0)},${p.y.toFixed(0)}) 不在画布上，被浮层或面板挡住了`);
}
async function stablePoint(page:Page,id:number){
 let previous=await point(page,id);
 let calm=0;
 for(let i=0;i<60;i++){
  await page.waitForTimeout(60);
  const next=await point(page,id);
  if(Math.abs(next.x-previous.x)<0.5&&Math.abs(next.y-previous.y)<0.5){calm+=1;if(calm>=5)return next;}
  else calm=0;
  previous=next;
 }
 return previous;
}
async function box(page:Page,ids:number[],reverse=false){const ps=await Promise.all(ids.map(id=>point(page,id)));const x0=Math.min(...ps.map(p=>p.x))-25,x1=Math.max(...ps.map(p=>p.x))+25,y0=Math.min(...ps.map(p=>p.y))-25,y1=Math.max(...ps.map(p=>p.y))+25;await move(page,{x:reverse?x1:x0,y:reverse?y1:y0},{x:reverse?x0:x1,y:reverse?y0:y1});}
async function rowText(loc:Locator){const tag=await loc.evaluate(el=>el.tagName);return tag==='INPUT'?loc.inputValue():loc.innerText();}
function readSize(text:string,label:string){const hit=new RegExp(label+'\\s*([0-9.]+)').exec(text);return hit?Number(hit[1]):NaN;}

test('P2-1 Q024/Q026 稳定命中',async({page})=>{await boot(page);for(let i=0;i<2;i++){await clickId(page,24);await expect(page.getByTestId('object-inspector')).toContainText('Q024');await clickId(page,26);await expect(page.getByTestId('object-inspector')).toContainText('Q026');const c=await page.getByTestId('map-canvas').boundingBox();await page.mouse.click(c!.x+20,c!.y+c!.height-20);await expect(page.getByTestId('object-inspector')).toHaveCount(0);}expect(errors.filter(e=>e.includes('TypeError'))).toEqual([]);});
test('P2-2 码组 1×1 与 2×2 真实可选可存',async({page})=>{await boot(page);await clickId(page,910);const gs=page.getByTestId('object-group-spec');await expect(gs).toBeVisible();await expect(page.getByTestId('object-group-grid')).toHaveValue('2');await expect(page.getByTestId('object-group-rows')).toHaveValue('2');await expect(page.getByTestId('object-group-size')).toHaveValue('60');expect(await rowText(page.getByTestId('object-group-gap'))).toContain('2');await expect(page.getByTestId('object-group-tag-size')).toHaveValue('29');await page.getByTestId('object-group-grid').selectOption('1');await page.getByTestId('object-group-rows').selectOption('1');await expect(page.getByTestId('object-group-rows')).toHaveValue('1');await page.getByTestId('object-group-apply').click();await expect.poll(()=>currentGroups[0]?.gridSize).toBe(1);await expect.poll(()=>currentGroups[0]?.members.length).toBe(1);await expect(page.getByTestId('object-group-tag-size')).toHaveValue('60');expect(await rowText(page.getByTestId('object-group-gap'))).toContain('—');expect(currentGroups[0].members[0].size).toBeCloseTo(60/1.25/1000,9);await page.reload();await gotoMap(page);await clickId(page,910);await expect(page.getByTestId('object-group-grid')).toHaveValue('1');await expect(page.getByTestId('object-group-tag-size')).toHaveValue('60');await page.getByTestId('object-group-grid').selectOption('2');await page.getByTestId('object-group-rows').selectOption('2');await page.getByTestId('object-group-apply').click();await expect.poll(()=>currentGroups[0]?.gridSize).toBe(2);await expect.poll(()=>currentGroups[0]?.members.length).toBe(4);await expect(page.getByTestId('object-group-tag-size')).toHaveValue('29');await page.reload();await gotoMap(page);await clickId(page,910);await expect(page.getByTestId('object-group-grid')).toHaveValue('2');await expect(page.getByTestId('object-group-tag-size')).toHaveValue('29');await expect(page.locator('body')).not.toContainText('4×8');});
test('P2-3 单行批量不显示 0 尺寸',async({page})=>{await boot(page);await box(page,[24,26,27]);const bar=page.getByTestId('box-batch-bar');await expect(bar).toBeVisible();await expect(page.getByTestId('box-batch-rows')).toHaveText('1');await expect(page.getByTestId('box-batch-cols')).toHaveText('3');const facts=page.getByTestId('box-batch-facts');const ft=await facts.innerText();const lengthM=readSize(ft,'长'),heightM=readSize(ft,'高');expect(Number.isFinite(lengthM)).toBe(true);expect(Number.isFinite(heightM)).toBe(true);expect(Math.abs(lengthM-0.86)).toBeLessThanOrEqual(0.01);expect(Math.abs(heightM-0.06)).toBeLessThanOrEqual(0.005);const dim=/整组尺寸\s*(\d+)\s*×\s*(\d+)/.exec(ft);expect(dim).not.toBeNull();expect(Math.abs(Number(dim![1])-860)).toBeLessThanOrEqual(1);expect(Math.abs(Number(dim![2])-60)).toBeLessThanOrEqual(1);const bt=await bar.innerText();expect(bt).not.toMatch(/×0\s*mm/);expect(bt).toContain('单行');});
test('P2-4 两点距离下限 0.10 前置拦截',async({page})=>{await boot(page);await box(page,[24,26]);const card=page.getByTestId('tag-distance-card');await expect(card).toBeVisible();const target=page.getByTestId('tag-distance-target'),apply=page.getByTestId('tag-distance-apply');await target.fill('0.05');await expect(apply).toBeDisabled();await expect(card).toContainText('0.10');await target.fill('0.55');await expect(apply).toBeEnabled();const before=cp(current);await apply.click();await expect.poll(()=>dist(current.find(t=>t.id===24),current.find(t=>t.id===26))).toBeCloseTo(.55,3);for(const id of [24,27,30,31,32,910]){const a=before.find(t=>t.id===id)!,b=current.find(t=>t.id===id)!;expect(b.x).toBeCloseTo(a.x,9);expect(b.y).toBeCloseTo(a.y,9);}expect(current.find(t=>t.id===26)!.x).toBeGreaterThan(before.find(t=>t.id===26)!.x+.1);const sent=writes.filter(w=>w.path.endsWith('/tag-distance'));expect(sent.length).toBe(1);expect(sent[0].body.targetM).toBeCloseTo(.55,9);expect(sent.every(w=>w.body.targetM>=.1)).toBe(true);expect(rejectedWrites).toEqual([]);});
test('P2-5 批量删除只删选中',async({page})=>{await boot(page);await box(page,[30,31]);await expect(page.getByTestId('box-batch-bar')).toContainText('已选 2');await page.getByTestId('box-batch-delete').click();await expect.poll(()=>current.filter(t=>[30,31].includes(t.id)).length).toBe(0);for(const id of [24,26,27,32,910])expect(current.some(t=>t.id===id)).toBe(true);});
test('P2-6 1024×768 无横向溢出且浮窗不出视口',async({page})=>{await page.setViewportSize({width:1024,height:768});await boot(page);await clickId(page,24);const insp=page.getByTestId('object-inspector');await expect(insp).toBeVisible();const r=await insp.boundingBox();expect(r).not.toBeNull();expect(r!.x).toBeGreaterThanOrEqual(0);expect(r!.y).toBeGreaterThanOrEqual(0);expect(r!.x+r!.width).toBeLessThanOrEqual(1024);expect(r!.y+r!.height).toBeLessThanOrEqual(768);const size=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,iw:window.innerWidth}));expect(size.sw).toBeLessThanOrEqual(size.iw+1);});
