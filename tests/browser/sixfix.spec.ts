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

const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};
const group={id:'B100',referenceId:100,gridSize:2,sizeMm:60,gapMm:2,members:[
 {id:100,x:-0.014,y:0.014,angle:0,size:0.0432},{id:101,x:0.014,y:0.014,angle:0,size:0.0432},
 {id:102,x:-0.014,y:-0.014,angle:0,size:0.0432},{id:103,x:0.014,y:-0.014,angle:0,size:0.0432}]};
const tags=[
 {id:100,groupId:'B100',rowId:'',x:1.5,y:1.0,angle:0,size:0.06,kind:'waypoint' as const,rules:[]},
 {id:200,groupId:undefined,rowId:'',x:1.5,y:0.75,angle:0,size:0.06,kind:'waypoint' as const,rules:[]},
 {id:201,groupId:undefined,rowId:'',x:1.8,y:1.0,angle:0,size:0.06,kind:'waypoint' as const,rules:[]},
];
const baseMap:FieldMap={...snap.map,routeMode:'map-only' as const,rows:[],motionSegments:undefined,order:[],groups:[group],
 zone:[{x:0,y:0},{x:3,y:0},{x:3,y:2},{x:0,y:2}],tags};
const ROBOT_STATUS={connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],detector:{connected:true,ids:[],groups:[],positionReady:false,reason:''},mapping:{ready:true},events:[],trail:[]};

let writes:{method:string;path:string;body:any}[]=[];
let current=tags.map(t=>({...t}));

/**
 * 唯一的选中入口是真实画布：遮住 API 后点标签必须走 MapCanvas 的 select/blank 事件，
 * 测试绝不直接设置 inspectedTagId / data-canvas-selected。
 */
async function installMock(page:Page){
 writes=[];current=tags.map(t=>({...t}));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:ROBOT_STATUS})));
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
  if(p==='/api/robot/status')return json(ROBOT_STATUS);
  if(p==='/api/maps'&&method==='GET')return json([{id:baseMap.id,name:baseMap.name,version:1}]);
  // 读图必须回读最新的可变 tags：改完尺寸再刷新/再选中才能看到新值。
  if(p==='/api/maps/'+baseMap.id&&method==='GET')return json({map:{...baseMap,tags:current},version:1,acceptance:null});
  if(p==='/api/surveys'||p==='/api/tasks'||p==='/api/routes'||p==='/api/boards')return json([]);
  if(p.endsWith('/tag-aliases'))return json({aliases:[]});
  if(p.endsWith('/tags/update')&&method==='POST'){
   for(const e of body.edits)current=current.map(t=>t.id===e.id?{...t,...e}:t);
   return json({map:{...baseMap,tags:current},version:1,acceptance:null});
  }
  if(method!=='GET')return json({ok:true});
  return json({});
 });
}

/** map-only 导航页：不进入路径编辑，画布工具就是「选择」，单击画布二维码即选中它本身。 */
async function openMap(page:Page){
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(baseMap.id);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await enterEditor(page);
 await page.getByLabel('适应地图').click();
 await page.waitForTimeout(120);
}
async function bootMap(page:Page){await installMock(page);await page.goto('/');await openMap(page);}
/** 左侧「点位与铺码」素材库只在路径编辑面板里，展开 tags 分组后才可见。 */
async function bootPalette(page:Page){
 await bootMap(page);
 await enterEditor(page);
 await expect(page.getByTestId('route-editor')).toBeVisible();
 const groupSection=page.getByTestId('route-tools-group-tags');
 await groupSection.scrollIntoViewIfNeeded();
 if(await groupSection.getAttribute('data-open')!=='1')await page.getByTestId('route-tools-group-toggle-tags').click();
 await expect(groupSection).toHaveAttribute('data-open','1');
}

/** 真实 Konva 节点中心：不用比例估算，不跳过空命中。 */
async function point(page:Page,id:number){
 const p=await page.evaluate((tagId:number)=>{
  const api=(window as any).__mapCanvasApi as {screenOfTag?:(id:number)=>{x:number;y:number}|null}|undefined;
  return api?.screenOfTag?.(tagId)??null;
 },id);
 if(!p)throw new Error(`screenOfTag(${id}) 返回 null：真实画布节点不存在`);
 return p;
}
async function clickTag(page:Page,id:number){const p=await point(page,id);await page.mouse.click(p.x,p.y);}
/** 点画布左下角空白处取消选中（三个码都在别的角落，这里只有空白）。 */
async function clickEmptyCanvas(page:Page){
 const cb=(await page.getByTestId('map-canvas').boundingBox())!;
 await page.mouse.click(cb.x+30,cb.y+cb.height-24);
}

for(const vp of [{width:1024,height:768},{width:1440,height:900}]){
 test(`选中后点空白取消、点别的码切换 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await bootMap(page);
  // 整轮循环两遍：选中 Q100 → 切到 Q200 → 点空白清空。
  for(let round=1;round<=2;round++){
   await clickTag(page,100);
   await expect(page.getByTestId('object-inspector')).toContainText('Q100');
   await clickTag(page,200);
   await expect(page.getByTestId('object-inspector')).toContainText('Q200');
   await clickEmptyCanvas(page);
   await expect(page.getByTestId('object-inspector')).toHaveCount(0);
  }
  console.log('SELECT_CYCLE_OK',JSON.stringify({vp}));
 });

 test(`独立码显示二维码规格并可改尺寸 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await bootMap(page);
  // 独立码 Q200：1×1，工单里唯一可改的规格。
  await clickTag(page,200);
  await expect(page.getByTestId('object-inspector')).toContainText('Q200');
  const tagSpec=page.getByTestId('object-tag-spec');
  await expect(tagSpec).toBeVisible();
  await expect(tagSpec).toContainText('二维码规格');
  await expect(page.getByTestId('object-tag-grid')).toHaveValue('1×1');

  await page.getByTestId('object-tag-size').fill('80');
  await page.getByTestId('object-tag-size').blur();
  await expect.poll(()=>writes.filter(w=>w.path.endsWith('/tags/update')).length,{timeout:8000}).toBeGreaterThan(0);
  const upd=writes.find(w=>w.path.endsWith('/tags/update'))!;
  expect(upd.method).toBe('POST');
  expect(upd.body.edits).toHaveLength(1);
  expect(upd.body.edits[0].id).toBe(200);
  expect(Math.abs(upd.body.edits[0].size-0.08)).toBeLessThan(1e-9);
  await expect.poll(()=>Math.abs((current.find(t=>t.id===200)?.size??-1)-0.08),{timeout:8000}).toBeLessThan(1e-9);
  // 等保存与 refresh 收尾（tagSpecBusy 复位）再点下一个码，避免画布重建瞬间点空。
  await expect(page.getByTestId('object-tag-size')).toBeEnabled({timeout:8000});

  // 码组中心 Q100：2×2、整组 60 mm、白缝 2 mm → 单码 29 mm。
  await clickTag(page,100);
  await expect(page.getByTestId('object-inspector')).toContainText('Q100');
  const groupSpec=page.getByTestId('object-group-spec');
  await expect(groupSpec).toBeVisible();
  await expect(groupSpec).toContainText('码组规格');
  await expect(page.getByTestId('object-group-grid')).toHaveValue('2');
  await expect(page.getByTestId('object-group-tag-size')).toHaveValue('29');

  // 刷新后 GET /api/maps/:id 必须返回刚写入的新尺寸：再点 Q200 仍是 80 mm。
  await page.reload();
  await openMap(page);
  await clickTag(page,200);
  await expect(page.getByTestId('object-tag-spec')).toBeVisible();
  await expect(page.getByTestId('object-tag-size')).toHaveValue('80');

  await expect(page.locator('body')).not.toContainText('4×8');
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  expect(overflow,`${vp.width}x${vp.height} 出现横向溢出 ${overflow}px`).toBeLessThanOrEqual(1);
  console.log('SPEC_OK',JSON.stringify({vp,edits:upd.body.edits.length,overflow}));
 });

 test(`左侧不再有调整点位/点位表/调整间距 @${vp.width}x${vp.height}`,async({page})=>{
  await page.setViewportSize(vp);await bootPalette(page);
  await expect(page.getByTestId('palette-position')).toHaveCount(0);
  await expect(page.getByTestId('palette-table')).toHaveCount(0);
  await expect(page.getByTestId('palette-spacing')).toHaveCount(0);
  // 三项素材仍在
  await expect(page.getByTestId('palette-single')).toBeVisible();
  await expect(page.getByTestId('palette-array')).toBeVisible();
  await expect(page.getByTestId('palette-line')).toBeVisible();
  console.log('PALETTE_SLIM',JSON.stringify({vp}));
 });
}
