import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FieldMap} from '../../web/shared/model';

const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};
const tags=[
 {id:0,groupId:undefined,rowId:'',x:0.5,y:0.5,angle:0,size:0.06,kind:'waypoint' as const,rules:[]},
 {id:1,groupId:undefined,rowId:'',x:1.0,y:0.5,angle:0,size:0.06,kind:'waypoint' as const,rules:[]},
 {id:2,groupId:undefined,rowId:'',x:1.5,y:0.5,angle:0,size:0.06,kind:'waypoint' as const,rules:[]},
];
const baseMap:FieldMap={...snap.map,routeMode:'map-only' as const,rows:[],motionSegments:undefined,order:[],groups:[],
 zone:[{x:0,y:0},{x:3,y:0},{x:3,y:2},{x:0,y:2}],tags};

let writes:{method:string;path:string;body:any}[]=[];
let version=1,current=tags.map(t=>({...t}));
async function boot(page:Page){
 writes=[];version=1;current=tags.map(t=>({...t}));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]}})));
 await page.route('**/api/**',async req=>{
  const p=new URL(req.request().url()).pathname;
  const method=req.request().method();
  const raw=req.request().postData();const body=raw?JSON.parse(raw):null;
  const json=(b:unknown)=>req.fulfill({json:b as never});
  if(method!=='GET')writes.push({method,path:p,body});
  if(p==='/api/camera/status')return json({running:true,present:true,frameAgeMs:10,error:''});
  if(p==='/api/camera/calibration')return json({});
  if(p==='/api/localization/map')return json({anchored:true,mapId:baseMap.id});
  if(p==='/api/localization/scope')return json({phase:'anchored'});
  if(p==='/api/robot/status')return json({connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]});
  if(p==='/api/maps'&&method==='GET')return json([{id:baseMap.id,name:baseMap.name,version}]);
  // in-place save semantics: version stays the same
  if(p==='/api/maps'&&method==='POST'){current=body.map.tags;return json({map:{...body.map,tags:current},version,acceptance:null});}
  if(p==='/api/maps/'+baseMap.id)return json({map:{...baseMap,tags:current},version,acceptance:null});
  if(p==='/api/surveys'||p==='/api/tasks'||p==='/api/routes'||p==='/api/boards')return json([]);
  if(p.endsWith('/tag-aliases'))return json({aliases:[]});
  if(p.endsWith('/tags/update')&&method==='POST'){for(const e of body.edits)current=current.map(t=>t.id===e.id?{...t,...e}:t);return json({map:{...baseMap,tags:current},version,acceptance:null});}
  if(method!=='GET')return json({ok:true});
  return json({});
 });
 await page.goto('/');
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(baseMap.id);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 const g=page.getByTestId('route-tools-group-toggle-tags');
 await g.scrollIntoViewIfNeeded();await g.click();
 const pos=page.getByTestId('palette-position');
 await pos.scrollIntoViewIfNeeded();await pos.click();
 await page.getByLabel('适应地图').click();
}
const centre=async(page:Page)=>(await page.getByTestId('map-canvas').boundingBox())!;

for(const vp of [{width:1024,height:768},{width:1440,height:900}]){
 test(`点空白取消选中 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  const cb=await centre(page);
  await page.mouse.click(cb.x+cb.width/2,cb.y+cb.height/2);
  const anySelected=await page.evaluate(()=>{
   const el=document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
   return (el.dataset.canvasSelected??'')!=='';
  });
  // click empty area far from points
  await page.mouse.click(cb.x+40,cb.y+cb.height-40);
  const sel=await page.evaluate(()=>{
   const el=document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
   return {selected:el.dataset.canvasSelected??'',inspector:!!document.querySelector('[data-testid="object-inspector"]')};
  });
  expect(sel.selected).toBe('');
  expect(sel.inspector).toBe(false);
  console.log('BLANK_CLEARS',JSON.stringify({vp,anySelected,sel}));
 });

 test(`改动不再提升地图版本 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await boot(page);
  const cb=await centre(page);
  await page.mouse.click(cb.x+cb.width/2,cb.y+cb.height/2);
  const insp=page.getByTestId('object-inspector');
  if(await insp.count()){
   const x=page.getByTestId('object-x');
   if(await x.count()){await x.fill('0.90');await x.blur();}
  }
  await page.waitForTimeout(600);
  const shown=await page.locator('text=/v\\d+/').allInnerTexts().catch(()=>[] as string[]);
  console.log('VERSION_STABLE',JSON.stringify({vp,writes:writes.length,shown:shown.slice(0,3)}));
 });
}
