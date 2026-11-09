import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FieldMap} from '../../web/shared/model';

const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};
const baseMap:FieldMap={...snap.map,routeMode:'map-only' as const,rows:[],motionSegments:undefined,order:[],tags:[],groups:[],
 zone:[{x:0,y:0},{x:3,y:0},{x:3,y:2},{x:0,y:2}]};

let writes:{method:string;path:string;body:any}[]=[];
let version=1,tags:any[]=[];
const reset=()=>{writes=[];version=1;tags=[]};

async function boot(page:Page){
 reset();
 page.on('pageerror',e=>console.log('PAGE_ERROR',e.message));
 page.on('request',r=>{if(r.url().includes('/api/'))console.log('REQ',r.method(),r.url());});
 page.on('requestfailed',r=>console.log('REQFAIL',r.method(),r.url(),r.failure()?.errorText));
 page.on('console',m=>{const t=m.text();if(t.startsWith('DBG_'))console.log(t);else if(m.type()==='error')console.log('CONSOLE_ERROR',t);});
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]}})));
 await page.route('**/api/**',async req=>{
  const p=new URL(req.request().url()).pathname;
  const method=req.request().method();
  const raw=req.request().postData();
  const body=raw?JSON.parse(raw):null;
  const json=(b:unknown)=>req.fulfill({json:b as never});
  if(p.startsWith('/api/maps'))console.log('MOCK',method,p,raw?raw.length:0);
  if(method!=='GET')writes.push({method,path:p,body});
  if(p==='/api/camera/status')return json({running:true,present:true,frameAgeMs:10,error:''});
  if(p==='/api/camera/calibration')return json({});
  if(p==='/api/localization/map')return json({anchored:true,mapId:baseMap.id});
  if(p==='/api/localization/scope')return json({phase:'anchored'});
  if(p==='/api/robot/status')return json({connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]});
  if(p==='/api/maps'&&method==='GET')return json([{id:baseMap.id,name:baseMap.name,version}]);
  if(p==='/api/maps'&&method==='POST'){tags=body.map.tags;version+=1;return json({map:{...body.map,tags},version,acceptance:null});}
  if(p==='/api/maps/'+baseMap.id)return json({map:{...baseMap,tags},version,acceptance:null});
  if(p==='/api/surveys')return json([]);
  if(p==='/api/tasks')return json([]);
  if(p==='/api/routes')return json([]);
  if(p==='/api/boards')return json([]);
  if(p.endsWith('/tag-aliases'))return json({aliases:[]});
  if(p.endsWith('/tags/update')&&method==='POST'){
   const e=body.edits[0];tags=tags.map(t=>t.id===e.id?{...t,...e}:t);version+=1;
   return json({map:{...baseMap,tags},version,acceptance:null});
  }
  if(p.endsWith('/tags')&&method==='DELETE'){
   const ids=new Set(body.ids);tags=tags.filter(t=>!ids.has(t.id));version+=1;
   return json({map:{...baseMap,tags},version,acceptance:null});
  }
  if(method!=='GET')return json({ok:true});
  return json({});
  return json({});
 });
 await page.goto('/');
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(baseMap.id);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await page.getByTestId('route-tools-group-toggle-tags').click();
 await expect(page.getByTestId('palette-library')).toBeVisible();
}

async function dragItem(page:Page,id:string,dx=60,dy=40){
 const el=page.getByTestId(id);
 await el.scrollIntoViewIfNeeded();
 const b=(await el.boundingBox())!;
 const cb=(await page.getByTestId('map-canvas').boundingBox())!;
 const sx=b.x+b.width/2,sy=b.y+b.height/2;
 const ex=cb.x+cb.width/2+dx,ey=cb.y+cb.height/2+dy;
 await page.mouse.move(sx,sy);
 await page.mouse.down();
 await page.mouse.move(sx+10,sy+6,{steps:3});
 await expect(page.getByTestId('palette-drag-ghost')).toBeVisible();
 await page.mouse.move(ex,ey,{steps:12});
 await page.mouse.up();
 return {ex,ey};
}
const mapWrites=()=>writes.filter(w=>w.path==='/api/maps'&&w.method==='POST');

for(const vp of [{width:1024,height:768},{width:1440,height:900}]){
 test(`单点拖入即保存并自动选中 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  await dragItem(page,'palette-single');
  await page.waitForTimeout(1500);
  console.log('PROBE',JSON.stringify({writes:writes.map(w=>w.method+' '+w.path),
   msg:await page.locator('[role="status"]').allInnerTexts(),
   err:await page.locator('[role="alert"]').allInnerTexts(),
   insp:await page.getByTestId('object-inspector').count()}));
  await expect.poll(()=>mapWrites().length,{timeout:8000}).toBe(1);
  expect(mapWrites()[0]!.body.map.tags.length).toBe(1);
  await expect(page.getByTestId('object-inspector')).toBeVisible();
  await expect(page.getByTestId('object-delete')).toBeVisible();
  // library item still there for repeated drags
  await expect(page.getByTestId('palette-single')).toBeVisible();
  const h=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  expect(h).toBeLessThanOrEqual(1);
  console.log('LIB_SINGLE',JSON.stringify({vp,posts:mapWrites().length,h}));
 });

 test(`阵列拖入即保存且浮窗改行列即时保存 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  await dragItem(page,'palette-array');
  await expect.poll(()=>mapWrites().length,{timeout:8000}).toBe(1);
  const n=mapWrites()[0]!.body.map.tags.length;
  expect(n).toBe(12); // 默认 4 列 × 3 行
  await expect(page.getByTestId('object-grid-params')).toBeVisible();
  const before=mapWrites().length;
  await page.getByTestId('object-grid-columns').fill('3');
  await page.getByTestId('object-grid-columns').blur();
  await expect.poll(()=>mapWrites().length,{timeout:8000}).toBeGreaterThan(before);
  const now=tags.length;
  expect(now).toBe(3*3);
  console.log('LIB_ARRAY',JSON.stringify({vp,initial:n,afterCols3:now,writes:mapWrites().length}));
 });

 test(`直线拖入即保存且浮窗改数量即时保存 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  await dragItem(page,'palette-line',150,8);
  await expect.poll(()=>mapWrites().length,{timeout:8000}).toBe(1);
  const n=mapWrites()[0]!.body.map.tags.length;
  expect(n).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('object-line-params')).toBeVisible();
  const before=mapWrites().length;
  await page.getByTestId('object-line-count').fill('3');
  await page.getByTestId('object-line-count').blur();
  await expect.poll(()=>mapWrites().length,{timeout:8000}).toBeGreaterThan(before);
  expect(tags.length).toBe(3);
  console.log('LIB_LINE',JSON.stringify({vp,initial:n,after:tags.length}));
 });

 test(`拖动画布对象即保存位置 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  const {ex,ey}=await dragItem(page,'palette-single');
  await expect.poll(()=>mapWrites().length,{timeout:8000}).toBe(1);
  const before=mapWrites().length;
  // 先点中该点，确保拖拽命中对象而不是平移画布
  await page.mouse.click(ex,ey);
  await expect(page.getByTestId('object-inspector')).toBeVisible();
  await page.mouse.move(ex,ey);
  await page.mouse.down();
  await page.mouse.move(ex+6,ey+4,{steps:3});
  await page.mouse.move(ex+28,ey+18,{steps:10});
  await page.mouse.up();
  await expect.poll(()=>mapWrites().length,{timeout:8000}).toBeGreaterThan(before);
  console.log('LIB_MOVE',JSON.stringify({vp,writes:mapWrites().length}));
 });

 test(`删除当前对象即保存 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  await dragItem(page,'palette-array');
  await expect.poll(()=>mapWrites().length,{timeout:8000}).toBe(1);
  const n=mapWrites()[0]!.body.map.tags.length;
  await expect(page.getByTestId('object-inspector')).toBeVisible();
  await page.getByTestId('object-delete').click();
  await expect.poll(()=>writes.filter(w=>w.method==='DELETE').length,{timeout:8000}).toBe(1);
  const del=writes.find(w=>w.method==='DELETE')!;
  expect(del.body.ids.length).toBe(1);
  expect(tags.length).toBe(n-1);
  console.log('LIB_DELETE',JSON.stringify({vp,before:n,after:tags.length}));
 });

 test(`拖到画布外取消不产生写入 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  const el=page.getByTestId('palette-single');
  await el.scrollIntoViewIfNeeded();
  const b=(await el.boundingBox())!;
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);
  await page.mouse.down();
  await page.mouse.move(b.x+b.width/2+30,b.y+b.height/2+18,{steps:5});
  await expect(page.getByTestId('palette-drag-ghost')).toBeVisible();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:5});
  await page.mouse.up();
  await page.waitForTimeout(700);
  expect(writes.filter(w=>w.path!=='/api/localization/map').length).toBe(0);
  await expect(page.getByTestId('object-inspector')).toHaveCount(0);
  console.log('LIB_CANCEL',JSON.stringify({vp,writes:writes.length}));
 });
}
