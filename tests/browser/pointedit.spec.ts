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

test.describe.configure({mode:'serial'});
test.use({viewport:{width:1280,height:800}});
const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};
const mapId='regress-pointedit-map';
const members=(n:number,sizeMm:number,ref:number)=>{const tile=(sizeMm-(n-1)*2)/n;return Array.from({length:n*n},(_,i)=>{const col=i%n,row=Math.floor(i/n);return {id:ref+i,x:(-sizeMm/2+tile/2+col*(tile+2))/1000,y:(sizeMm/2-tile/2-row*(tile+2))/1000,angle:0,size:tile/1.25/1000};});};
const group={id:'B910',referenceId:910,gridSize:2,sizeMm:60,gapMm:2,members:members(2,60,910)};
const tags:any[]=[24,26,27].map((id,i)=>({id,rowId:'',x:1+i*.4,y:1,angle:0,size:.06,kind:'waypoint',rules:[]})).concat([30,31,32].map((id,i)=>({id,rowId:'',x:1+i*.4,y:1.8,angle:0,size:.06,kind:'waypoint',rules:[]})),[{id:910,groupId:'B910',rowId:'',x:2.4,y:2.4,angle:0,size:.06,kind:'waypoint',rules:[]}]);
const base:any={...snap.map,id:mapId,name:'pointedit disposable',routeMode:'map-only',rows:[],motionSegments:undefined,order:[],groups:[group],tags,zone:[{x:0,y:0},{x:3,y:0},{x:3,y:3},{x:0,y:3}]};
let current:any[],currentGroups:any[],writes:any[],errors:string[];
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
 current=cp(tags);currentGroups=[cp(group)];writes=[];errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]}})));
 await page.route('**/api/**',async r=>{const q=r.request(),p=new URL(q.url()).pathname,m=q.method(),b=q.postData()?JSON.parse(q.postData()!):null,j=(v:any,status=200)=>r.fulfill({status,json:v});if(m!=='GET')writes.push({method:m,path:p,body:b});
  if(p==='/api/camera/status')return j({running:true,present:true,frameAgeMs:10,error:''});if(p==='/api/robot/status')return j({connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]});if(p==='/api/localization/map')return j({anchored:true,mapId});if(p==='/api/localization/scope')return j({phase:'anchored'});
  if(p==='/api/maps'&&m==='GET')return j([{id:mapId,name:base.name,version:1}]);if(p==='/api/maps'&&m==='POST'){current=cp((b.map??b).tags??[]);currentGroups=cp((b.map??b).groups??[]);return j({map:payload(),version:1});}if(p==='/api/maps/'+mapId&&m==='GET')return j({map:payload(),version:1,acceptance:null});if(['/api/surveys','/api/tasks','/api/routes','/api/boards','/api/camera/calibration'].includes(p))return j([]);if(p.endsWith('/tag-aliases'))return j({aliases:[]});
  if(p.endsWith('/tag-distance')&&m==='POST'){if(b.targetM<.1)return j({error:'目标距离小于最小中心距 0.10 m'},400);const a=current.find(t=>t.id===b.fromId),to=current.find(t=>t.id===b.toId),others=current.filter(t=>t.id!==b.fromId&&t.id!==b.toId);const d=dist(a,to),u={x:(to.x-a.x)/d,y:(to.y-a.y)/d},next={x:a.x+u.x*b.targetM,y:a.y+u.y*b.targetM};if(others.some(t=>dist(next,t)<.1))return j({error:'目标位置与其他码重合，违反最小中心距'},400);const dx=next.x-to.x,dy=next.y-to.y;current=current.map(t=>t.id===b.toId?{...t,x:next.x,y:next.y}:t);return j({map:payload(),version:1,beforeM:d,afterM:b.targetM,axis:Math.abs(u.x)>Math.abs(u.y)?'x':'y',changedTags:[b.toId]});}
  if(p.endsWith('/tag-equal-spacing')&&m==='POST'){const ids=b.ids,arr=ids.map((id:number)=>current.find(t=>t.id===id));const axis=Math.abs(arr[0].x-arr[1].x)>=Math.abs(arr[0].y-arr[1].y)?'x':'y';const sorted=[...arr].sort((a,z)=>axis==='x'?a.x-z.x:a.y-z.y);current=current.map(t=>{const i=sorted.findIndex(a=>a.id===t.id);return i<0?t:{...t,[axis]:sorted[0][axis]+i*b.targetM};});return j({map:payload(),version:1,order:sorted.map(t=>t.id),axis,count:ids.length,spanAfterM:(ids.length-1)*b.targetM});}
  if(p.endsWith('/tags/update')&&m==='POST'){for(const e of b.edits??[])current=current.map(t=>t.id===e.id?{...t,...e}:t);return j({map:payload(),version:1});}if(p.endsWith('/tags/align')&&m==='POST'){const ids=b.ids??[],a=current.filter(t=>ids.includes(t.id));const axis=b.mode==='top'||b.mode==='bottom'?'y':'x';const v=a[0]?.[axis];current=current.map(t=>ids.includes(t.id)?{...t,[axis]:v}:t);return j({map:payload(),version:1});}if(p.endsWith('/tags')&&m==='DELETE'){const ids=new Set(b.ids??[]);current=current.filter(t=>!ids.has(t.id));return j({map:payload(),version:1});}
  const sm=p.match(new RegExp('/api/maps/'+mapId+'/groups/([^/]+)/spec$'));if(sm&&m==='POST'){const g=rebuildSpec(b);return j({map:payload(),version:1,group:g,centerId:910});}if(m!=='GET')return j({ok:true});return j({});});
 await gotoMap(page);}
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

test('P1 selection is stable and blank clears',async({page})=>{await boot(page);for(let i=0;i<2;i++){await clickId(page,24);await expect(page.getByTestId('object-inspector')).toContainText('Q024');await clickId(page,26);await expect(page.getByTestId('object-inspector')).toContainText('Q026');const c=await page.getByTestId('map-canvas').boundingBox();await page.mouse.click(c!.x+20,c!.y+c!.height-20);await expect(page.getByTestId('object-inspector')).toHaveCount(0);}expect(errors.filter(e=>e.includes('TypeError'))).toEqual([]);});
test('P2 drag snap and minimum-distance gate',async({page})=>{await boot(page);await clickId(page,24);const a=await stablePoint(page,26),target=await page.evaluate(()=>{const p=(window as any).__mapCanvasApi.worldToClient({x:1.2,y:1.004});return p});await ensureCanvasPoint(page,a);let seen=false;await move(page,a,target,async()=>{seen ||= await page.evaluate(()=>document.querySelector('[data-testid="map-canvas"]')?.getAttribute('data-canvas-snap')==='y');});expect(seen).toBe(true);expect(Math.abs(current[1].y-current[0].y)).toBeLessThanOrEqual(1e-6);const gapAfterSnap=dist(current[0],current[1]);expect(gapAfterSnap).toBeGreaterThan(.1);const p=await stablePoint(page,26),same=await stablePoint(page,24);await ensureCanvasPoint(page,p);let blockedSeen=false;await move(page,p,same,async()=>{blockedSeen ||= await page.evaluate(()=>document.querySelector('[data-testid="map-canvas"]')?.getAttribute('data-canvas-snap-blocked')==='1');});const finalGap=dist(current[0],current[1]);expect(finalGap).toBeGreaterThanOrEqual(.1);expect(Math.abs(finalGap-gapAfterSnap)).toBeGreaterThan(.02);await expect(page.getByTestId('snap-blocked-notice')).toBeVisible();await expect(page.getByTestId('snap-blocked-notice')).toContainText(/重合|最小/);expect(await page.getByTestId('map-canvas').getAttribute('data-canvas-snap-blocked')).toBe('1');});
test('P3 pair distance and cancel',async({page})=>{await boot(page);await box(page,[24,26]);await expect(page.getByTestId('box-batch-bar')).toContainText(/Q024|Q026/);const card=page.getByTestId('tag-distance-card');await expect(card).toBeVisible();await card.getByRole('spinbutton').fill('0.55');await card.getByRole('button',{name:'确定'}).click();expect(dist(current[0],current[1])).toBeCloseTo(.55,3);const before=writes.length;await card.getByRole('spinbutton').fill('0.30');await card.getByRole('button',{name:'取消'}).click();expect(writes.length).toBe(before);await page.reload();await gotoMap(page);await box(page,[24,26]);await expect(page.getByTestId('tag-distance-card')).toContainText('0.55');});
test('P4 equal spacing',async({page})=>{await boot(page);await box(page,[24,26,27]);const card=page.getByTestId('tag-spacing-card');await expect(card).toBeVisible();await card.getByRole('spinbutton').fill('0.55');await card.getByRole('button',{name:'应用'}).click();const w=writes.find(w=>w.path.endsWith('/tag-equal-spacing'))!;expect(w.body.ids).toEqual([24,26,27]);expect(dist(current[0],current[1])).toBeCloseTo(.55,3);expect(dist(current[1],current[2])).toBeCloseTo(.55,3);});
test('P5 array rearrange',async({page})=>{await boot(page);await box(page,[24,26,30,31]);const bar=page.getByTestId('box-batch-bar');await expect(bar).toContainText('已选 4');await expect(bar).toContainText(/行数|列数/);await bar.getByLabel(/横向间距/).fill('0.6');await bar.getByLabel(/纵向间距/).fill('1.0');await bar.getByRole('button',{name:'重排'}).click();const xs=current.filter(t=>[24,26,30,31].includes(t.id));expect(Math.min(...xs.map(t=>t.x))!==Math.max(...xs.map(t=>t.x))).toBe(true);expect(Math.min(...xs.map(t=>t.y))).not.toBe(Math.max(...xs.map(t=>t.y)));});
test('P6 batch align and delete',async({page})=>{await boot(page);await box(page,[24,26,27]);await page.getByTestId('box-batch-align-row').click();const ys=current.filter(t=>[24,26,27].includes(t.id)).map(t=>t.y);expect(Math.max(...ys)-Math.min(...ys)).toBeLessThanOrEqual(1e-6);await page.getByTestId('box-batch-delete').click();expect(current.some(t=>[24,26,27].includes(t.id))).toBe(false);expect(current.some(t=>t.id===30)).toBe(true);});
test('P7 move persists',async({page})=>{await boot(page);const before={...current.find(t=>t.id===27)};const a=await stablePoint(page,27),b=await page.evaluate(()=> (window as any).__mapCanvasApi.worldToClient({x:2,y:1}));await ensureCanvasPoint(page,a);await move(page,a,b);await expect.poll(()=>current.find(t=>t.id===27).x-before.x,{timeout:8000}).toBeGreaterThan(.05);const saved=cp(current.find(t=>t.id===27));expect(writes.some(w=>w.method==='POST'&&w.path==='/api/maps')).toBe(true);await page.reload();await gotoMap(page);await clickId(page,27);await expect(page.getByTestId('object-x')).toHaveValue(saved.x.toFixed(3));await expect(page.getByTestId('object-y')).toHaveValue(saved.y.toFixed(3));});
test('P8 group and standalone specifications',async({page})=>{await boot(page);await clickId(page,910);const gs=page.getByTestId('object-group-spec');await expect(gs).toContainText(/2/);await expect(page.getByTestId('object-group-tag-size')).toHaveValue('29');await page.getByTestId('object-group-size').fill('70');await page.getByTestId('object-group-apply').click();expect(currentGroups[0].sizeMm).toBe(70);await page.reload();await gotoMap(page);await clickId(page,910);await expect(page.getByTestId('object-group-size')).toHaveValue('70');await clickId(page,24);await expect(page.getByTestId('object-tag-spec')).toContainText(/60/);await page.getByTestId('object-tag-size').fill('80');await page.getByTestId('object-tag-size').blur();await page.reload();await gotoMap(page);await clickId(page,24);await expect(page.getByTestId('object-tag-size')).toHaveValue('80');await expect(page.locator('body')).not.toContainText('4×8');});
test('P9 fixed viewport layout',async({page})=>{for(const vp of [{width:1024,height:768},{width:1440,height:900}]){await page.setViewportSize(vp);await boot(page);const p=await point(page,24);await page.mouse.click(p.x,p.y);const r=await page.getByTestId('object-inspector').boundingBox();expect(r).not.toBeNull();expect(r!.x).toBeGreaterThanOrEqual(0);expect(r!.y).toBeGreaterThanOrEqual(0);expect(r!.x+r!.width).toBeLessThanOrEqual(vp.width);expect(r!.y+r!.height).toBeLessThanOrEqual(vp.height);expect(p.x<r!.x+r!.width&&p.x>r!.x&&p.y<r!.y+r!.height&&p.y>r!.y).toBe(false);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width+1);await expect(page.getByTestId('box-batch-bar')).toBeVisible().catch(()=>{});}});
test('P10 route inspector replaces object inspector',async({page})=>{await boot(page);await enterEditor(page);await expect(page.getByTestId('route-editor')).toBeVisible();await clickId(page,26);await expect(page.getByTestId('object-inspector')).toContainText('Q026');expect(await page.getByTestId('route-inspector').count()).toBe(0);await expect(page.getByTestId('route-editor')).toBeVisible();await page.getByTitle('开始导航').click();await expect(page.getByTestId('map-canvas')).toBeVisible();await clickId(page,26);await expect(page.getByTestId('object-inspector')).toContainText('Q026');});
