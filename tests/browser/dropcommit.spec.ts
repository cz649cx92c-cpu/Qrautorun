import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FieldMap} from '../../web/shared/model';

const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};
const map:FieldMap={...snap.map,routeMode:'map-only' as const,rows:[],motionSegments:undefined,order:[],tags:[],groups:[],
 zone:[{x:0,y:0},{x:3,y:0},{x:3,y:2},{x:0,y:2}]};

let writes:{method:string;path:string;body:any}[]=[];
let version=1;
let tags:any[]=[];
async function boot(page:Page){
 writes=[];version=1;tags=[];
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]}})));
 await page.route('**/api/**',async req=>{
  const p=new URL(req.request().url()).pathname;
  const method=req.request().method();
  const raw=req.request().postData();
  const body=raw?JSON.parse(raw):null;
  const json=(b:unknown)=>req.fulfill({json:b as never});
  if(p==='/api/camera/status')return json({running:true,present:true,frameAgeMs:10,error:''});
  if(p==='/api/camera/calibration')return json({});
  if(p==='/api/localization/map')return json({anchored:true,mapId:map.id});
  if(p==='/api/localization/scope')return json({phase:'anchored'});
  if(p==='/api/robot/status')return json({connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]});
  if(p==='/api/maps')return json([{id:map.id,name:map.name,version}]);
  if(p==='/api/maps/'+map.id)return json({map:{...map,tags},version,acceptance:null});
  if(p==='/api/surveys')return json([]);
  if(p==='/api/tasks')return json([]);
  if(p==='/api/routes')return json([]);
  if(p==='/api/boards')return json([]);
  if(p.endsWith('/tag-aliases'))return json({aliases:[]});
  // POST /api/maps -> new version with the submitted map
  if(method==='POST'&&p==='/api/maps'){
   writes.push({method,path:p,body});
   tags=body.map.tags;version=version+1;
   return json({map:{...body.map,tags},version,acceptance:null});
  }
  if(method==='POST'&&p.endsWith('/tags/update')){
   writes.push({method,path:p,body});
   const edit=body.edits[0];
   tags=tags.map(t=>t.id===edit.id?{...t,...('x' in edit?{x:edit.x}:{}),...('y' in edit?{y:edit.y}:{}),...('angle' in edit?{angle:edit.angle}:{})}:t);
   version=version+1;
   return json({map:{...map,tags},version,acceptance:null});
  }
  if(method==='DELETE'&&p.endsWith('/tags')){
   writes.push({method,path:p,body});
   const ids=new Set(body.ids);
   tags=tags.filter(t=>!ids.has(t.id));
   version=version+1;
   return json({map:{...map,tags},version,acceptance:null});
  }
  if(method==='POST'){writes.push({method,path:p,body});return json({ok:true});}
  return json({});
 });
 await page.goto('/');
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(map.id);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await page.getByTestId('route-tools-group-toggle-tags').click();
 await expect(page.getByTestId('tag-palette')).toBeVisible();
}

async function dropPalette(page:Page,item:'palette-single'|'palette-array'|'palette-line',dx=60,dy=40){
 const el=page.getByTestId(item);
 await el.scrollIntoViewIfNeeded();
 const b=(await el.boundingBox())!;
 const cb=(await page.getByTestId('map-canvas').boundingBox())!;
 const sx=b.x+b.width/2, sy=b.y+b.height/2;
 const ex=cb.x+cb.width/2+dx, ey=cb.y+cb.height/2+dy;
 await page.mouse.move(sx,sy);
 await page.mouse.down();
 await page.mouse.move(sx+10,sy+6,{steps:3});
 await expect(page.getByTestId('palette-drag-ghost')).toBeVisible();
 await page.mouse.move(ex,ey,{steps:12});
 await page.mouse.up();
 return {ex,ey};
}
const mapPosts=()=>writes.filter(w=>w.path==='/api/maps'&&w.method==='POST');

for(const vp of [{width:1024,height:768},{width:1440,height:900}]){
 test(`单点拖入即保存并落地 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  await dropPalette(page,'palette-single');
  await expect.poll(()=>mapPosts().length,{timeout:8000}).toBe(1);
  const post=mapPosts()[0]!;
  expect(post.body.map.tags.length).toBe(1);
  expect(post.body.baseVersion).toBe(1);
  // object card is the only parameter surface
  await expect(page.getByTestId('draft-object-card')).toBeVisible();
  await expect(page.getByTestId('map-tag-create')).toHaveCount(0);
  const h=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  expect(h).toBeLessThanOrEqual(1);
  console.log('DROP_SAVE_SINGLE',JSON.stringify({vp,posts:mapPosts().length,tags:post.body.map.tags.length,h}));
 });

 test(`阵列拖入即保存且浮窗可改参 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  await dropPalette(page,'palette-array');
  await expect.poll(()=>mapPosts().length,{timeout:8000}).toBe(1);
  const n=mapPosts()[0]!.body.map.tags.length;
  expect(n).toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId('draft-object-card')).toBeVisible();
  // parameter tweak on the selected object -> another write
  const before=writes.length;
  await page.getByTestId('draft-object-angle').fill('45');
  await page.getByTestId('draft-object-angle').blur();
  await expect.poll(()=>writes.length,{timeout:8000}).toBeGreaterThan(before);
  console.log('DROP_SAVE_ARRAY',JSON.stringify({vp,points:n,writes:writes.length}));
 });

 test(`直线拖入即保存且改参即时更新 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  await dropPalette(page,'palette-line',150,8);
  await expect.poll(()=>mapPosts().length,{timeout:8000}).toBe(1);
  const n=mapPosts()[0]!.body.map.tags.length;
  expect(n).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('draft-object-card')).toBeVisible();
  const before=writes.length;
  await page.getByTestId('draft-object-x').fill('1.2');
  await page.getByTestId('draft-object-x').blur();
  await expect.poll(()=>writes.length,{timeout:8000}).toBeGreaterThan(before);
  console.log('DROP_SAVE_LINE',JSON.stringify({vp,points:n,writes:writes.length}));
 });

 test(`拖动画布对象即保存位置 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  const {ex,ey}=await dropPalette(page,'palette-single');
  await expect.poll(()=>mapPosts().length,{timeout:8000}).toBe(1);
  const before=writes.length;
  // drag the just-created tag on the canvas
  await page.mouse.move(ex,ey);
  await page.mouse.down();
  await page.mouse.move(ex+30,ey+20,{steps:10});
  await page.mouse.up();
  await expect.poll(()=>writes.length,{timeout:8000}).toBeGreaterThan(before);
  console.log('MOVE_SAVE',JSON.stringify({vp,writes:writes.length}));
 });

 test(`删除选中对象即保存 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  await dropPalette(page,'palette-array');
  await expect.poll(()=>mapPosts().length,{timeout:8000}).toBe(1);
  const n=mapPosts()[0]!.body.map.tags.length;
  await expect(page.getByTestId('draft-object-card')).toBeVisible();
  await page.getByTestId('draft-object-delete').click();
  await expect.poll(()=>writes.filter(w=>w.method==='DELETE').length,{timeout:8000}).toBe(1);
  const del=writes.find(w=>w.method==='DELETE')!;
  expect(del.body.ids.length).toBe(1);
  expect(tags.length).toBe(n-1);
  console.log('DELETE_SAVE',JSON.stringify({vp,before:n,after:tags.length,ids:del.body.ids}));
 });

 test(`取消拖放不产生写入 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  const el=page.getByTestId('palette-single');
  await el.scrollIntoViewIfNeeded();
  const b=(await el.boundingBox())!;
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);
  await page.mouse.down();
  await page.mouse.move(b.x+b.width/2+30,b.y+b.height/2+20,{steps:5});
  await expect(page.getByTestId('palette-drag-ghost')).toBeVisible();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:5});
  await page.mouse.up();
  await page.waitForTimeout(600);
  expect(writes.length).toBe(0);
  await expect(page.getByTestId('draft-object-card')).toHaveCount(0);
  console.log('CANCEL_NO_WRITE',JSON.stringify({vp,writes:writes.length}));
 });
}
