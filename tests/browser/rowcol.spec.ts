import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FieldMap} from '../../web/shared/model';

const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};
const baseMap:FieldMap={...snap.map,routeMode:'map-only' as const,rows:[],motionSegments:undefined,order:[],tags:[],groups:[],
 zone:[{x:0,y:0},{x:3,y:0},{x:3,y:2},{x:0,y:2}]};

let writes:{method:string;path:string;body:any}[]=[];
let version=1,tags:any[]=[];
async function boot(page:Page){
 writes=[];version=1;tags=[];
 page.on('console',m=>{const t=m.text();if(t.startsWith('DBG_'))console.log(t);});
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]}})));
 await page.route('**/api/**',async req=>{
  const p=new URL(req.request().url()).pathname;
  const method=req.request().method();
  const raw=req.request().postData();
  const body=raw?JSON.parse(raw):null;
  const json=(b:unknown)=>req.fulfill({json:b as never});
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
  if(p.endsWith('/tags/update')&&method==='POST'){const e=body.edits[0];tags=tags.map(t=>t.id===e.id?{...t,...e}:t);version+=1;return json({map:{...baseMap,tags},version,acceptance:null});}
  if(p.endsWith('/tags')&&method==='DELETE'){const ids=new Set(body.ids);tags=tags.filter(t=>!ids.has(t.id));version+=1;return json({map:{...baseMap,tags},version,acceptance:null});}
  if(method!=='GET')return json({ok:true});
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

async function dropArray(page:Page){
 const el=page.getByTestId('palette-array');
 await el.scrollIntoViewIfNeeded();
 const b=(await el.boundingBox())!;
 const cb=(await page.getByTestId('map-canvas').boundingBox())!;
 await page.mouse.move(b.x+b.width/2,b.y+b.height/2);
 await page.mouse.down();
 await page.mouse.move(b.x+b.width/2+10,b.y+b.height/2+6,{steps:3});
 await expect(page.getByTestId('palette-drag-ghost')).toBeVisible();
 await page.mouse.move(cb.x+cb.width/2+60,cb.y+cb.height/2+40,{steps:12});
 await page.mouse.up();
 await expect.poll(()=>writes.filter(w=>w.path==='/api/maps').length,{timeout:8000}).toBe(1);
}

for(const vp of [{width:1024,height:768},{width:1440,height:900}]){
 test(`行列输入不被遥测刷新回写且即时生效 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  await dropArray(page);
  expect(tags.length).toBe(12);

  const cols=page.getByTestId('object-grid-columns');
  const rows=page.getByTestId('object-grid-rows');
  await expect(cols).toHaveValue('4');
  await expect(rows).toHaveValue('3');

  // Type new values; the page re-renders every 100 ms (telemetry clock).
  await cols.fill('3');
  await cols.blur();
  // let the commit-triggered re-render settle before the next field
  await expect.poll(()=>writes.filter(w=>w.path==='/api/maps').length,{timeout:8000}).toBeGreaterThanOrEqual(2);
  await expect(rows).toBeVisible();
  await rows.fill('2');
  await rows.blur();
  // Survive several re-render ticks: values must stay what the operator typed.
  await page.waitForTimeout(1200);
  await expect(cols).toHaveValue('3');
  await expect(rows).toHaveValue('2');

  // And the change is committed: 3 x 2 = 6 points.
  await expect.poll(()=>tags.length,{timeout:8000}).toBe(6);
  await expect.poll(()=>writes.filter(w=>w.path==='/api/maps').length,{timeout:8000}).toBeGreaterThanOrEqual(2);
  await expect(cols).toHaveValue('3');
  await expect(rows).toHaveValue('2');

  const h=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  expect(h).toBeLessThanOrEqual(1);
  console.log('ROWCOL_OK',JSON.stringify({vp,cols:await cols.inputValue(),rows:await rows.inputValue(),points:tags.length,writes:writes.filter(w=>w.path==='/api/maps').length,h}));
 });
}
