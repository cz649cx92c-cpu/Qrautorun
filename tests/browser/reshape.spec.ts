import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FieldMap} from '../../web/shared/model';

const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};
const tags=[] as any[];
let n=0;
for(let r=0;r<2;r++)for(let c=0;c<3;c++)tags.push({id:n++,groupId:undefined,rowId:'',x:0.5+c*0.5,y:0.5+r*0.5,angle:0,size:0.06,kind:'waypoint',rules:[]});
const baseMap:FieldMap={...snap.map,routeMode:'map-only' as const,rows:[],motionSegments:undefined,order:[],groups:[],
 zone:[{x:0,y:0},{x:3,y:0},{x:3,y:2},{x:0,y:2}],tags};

let writes:{method:string;path:string;body:any}[]=[];
let version=1,current=[...tags];
async function boot(page:Page){
 writes=[];version=1;current=tags.map(t=>({...t}));
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
  if(p==='/api/maps'&&method==='POST'){current=body.map.tags;version+=1;return json({map:{...body.map,tags:current},version,acceptance:null});}
  if(p==='/api/maps/'+baseMap.id&&method==='GET')return json({map:{...baseMap,tags:current},version,acceptance:null});
  if(p==='/api/surveys'||p==='/api/tasks'||p==='/api/routes'||p==='/api/boards')return json([]);
  if(p.endsWith('/tag-aliases'))return json({aliases:[]});
  if(p.endsWith('/tags/update')&&method==='POST'){for(const e of body.edits)current=current.map(t=>t.id===e.id?{...t,...e}:t);version+=1;return json({map:{...baseMap,tags:current},version,acceptance:null});}
  if(p.endsWith('/tags/align')&&method==='POST'){version+=1;return json({map:{...baseMap,tags:current},version,acceptance:null});}
  if(p.endsWith('/tags')&&method==='DELETE'){const ids=new Set(body.ids);current=current.filter(t=>!ids.has(t.id));version+=1;return json({map:{...baseMap,tags:current},version,acceptance:null});}
  if(method!=='GET')return json({ok:true});
  return json({});
 });
 await page.goto('/');
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(baseMap.id);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
}

async function boxAll(page:Page){
 const cb=(await page.getByTestId('map-canvas').boundingBox())!;
 await page.mouse.move(cb.x+12,cb.y+12);
 await page.mouse.down();
 await page.mouse.move(cb.x+cb.width/2,cb.y+cb.height/2,{steps:6});
 await page.mouse.move(cb.x+cb.width-12,cb.y+cb.height-12,{steps:10});
 await page.mouse.up();
}

for(const vp of [{width:1024,height:768},{width:1440,height:900}]){
 test(`框选后重排为 2x3 阵列 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  await page.getByLabel('适应地图').click();
  await boxAll(page);
  await expect(page.getByTestId('box-batch-bar')).toBeVisible();
  await expect(page.getByTestId('box-batch-reshape')).toBeVisible();
  await page.getByTestId('box-batch-rows').fill('2');
  await page.getByTestId('box-batch-cols').fill('3');
  await page.getByTestId('box-batch-pitch-x').fill('0.4');
  await page.getByTestId('box-batch-pitch-y').fill('0.3');
  await page.getByTestId('box-batch-reshape').click();
  await expect.poll(()=>writes.filter(w=>w.path==='/api/maps').length,{timeout:8000}).toBeGreaterThanOrEqual(1);
  // 6 points laid out on a 3-col / 2-row grid with the requested pitch
  const xs=[...new Set(current.map((t:any)=>Math.round(t.x*1000)/1000))].sort((a,b)=>a-b);
  const ys=[...new Set(current.map((t:any)=>Math.round(t.y*1000)/1000))].sort((a,b)=>a-b);
  expect(xs.length).toBe(3);
  expect(ys.length).toBe(2);
  expect(Math.round((xs[1]-xs[0])*1000)).toBe(400);
  expect(Math.round((ys[1]-ys[0])*1000)).toBe(300);
  const h=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  expect(h).toBeLessThanOrEqual(1);
  console.log('RESHAPE_OK',JSON.stringify({vp,xs,ys,h}));
 });

 test(`数量不匹配时重排被拒绝并提示 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  await page.getByLabel('适应地图').click();
  await boxAll(page);
  const before=writes.length;
  await page.getByTestId('box-batch-rows').fill('4');
  await page.getByTestId('box-batch-cols').fill('4');
  await page.getByTestId('box-batch-reshape').click();
  await page.waitForTimeout(600);
  expect(writes.length).toBe(before);
  await expect(page.getByTestId('box-batch-bar')).toContainText('数量必须一致');
  console.log('RESHAPE_REJECT',JSON.stringify({vp,writes:writes.length}));
 });
}
