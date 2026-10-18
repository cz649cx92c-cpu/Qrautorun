import {test,expect,type Page} from '@playwright/test';
import type {FieldMap,Point} from '../../web/shared/model';
import {generateBoards} from '../../web/shared/boards';

const boards=generateBoards({gridSize:4,groupSizeMm:180,groupCount:3,startId:0});
function field(id='distance-map'):FieldMap {
 return {schemaVersion:1,id,name:id,frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',captureQuality:'draft',
  // Labels must also work without looking up registered board definitions.
  groups:[],rows:[],order:[],zone:[{x:-1,y:-1},{x:4,y:-1},{x:4,y:5},{x:-1,y:5}],
  tags:[{id:0,groupId:'B000',x:0,y:0},{id:16,groupId:'B016',x:3,y:4},{id:32,groupId:'B032',x:3,y:0}].map(t=>({...t,angle:0,size:.18,rowId:'',kind:'waypoint',rules:[]})),
  vehicle:{width:.4,length:.8,margin:.05},notes:'浏览器测距草稿 fixture'};
}
function survey() {
 const tags=field().tags.map(({id,x,y})=>({id,x,y,angle:0}));
 return {id:'distance-survey',name:'中心测距扫描',created:'2026-10-14T00:00:00Z',state:'stopped',anchors:[],boards,
  samples:[{quality:'draft',localEpoch:'distance-origin',pose:{x:0,y:0,yaw:0},tags}],
  result:{tags,poses:[[0,0,0]],rmsM:.01},counts:{0:1,16:1,32:1},visibility:{},captureQuality:'draft',
  sampleCount:1,groupCount:3,mapId:null,deletable:true,protectedReason:null};
}
const failures=new WeakMap<Page,{errors:string[],unexpected:string[]}>();
test.afterEach(async({page})=>{
 const observed=failures.get(page);
 if(observed){expect(observed.errors,'浏览器未捕获异常').toEqual([]);expect(observed.unexpected,'所有 API 必须被明确 mock').toEqual([]);}
});

async function mock(page:Page,{scan=false,maps=[field(),field('other-distance-map')]}:{scan?:boolean,maps?:FieldMap[]}={}) {
 const records=new Map<string,ReturnType<typeof survey>>(scan?[[survey().id,survey()]]:[]);
 const calls:string[]=[];
 const observed={errors:[] as string[],unexpected:[] as string[]};failures.set(page,observed);
 page.on('pageerror',e=>observed.errors.push(e.message));
 let cameraConnections=0;
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,
  chassis:{connected:true},sensors:{camera:'位姿已计算 / 待同步',imu:'在线',odom:'原底盘已接入',localization:'局部已融合 / 待标定'},
  conditions:[{id:'execution',label:'实体执行许可',ready:false}],events:[],
  detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:true,quality:'draft',localEpoch:'distance-origin',reason:''}}})));
 await page.routeWebSocket('**/ws/camera',ws=>{cameraConnections++;ws.send(JSON.stringify({type:'camera',name:'HBVCAM',profile:'720p',profiles:[],error:''}));});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;calls.push(path);
  if(path==='/api/camera/status')return route.fulfill({json:{running:true,present:true,frameAgeMs:10,error:''}});
  if(path==='/api/camera/calibration')return route.fulfill({json:{}});
  if(path==='/api/boards')return route.fulfill({json:boards});
  if(path==='/api/tasks')return route.fulfill({json:maps.map(m=>({id:'task-scan-'+m.id,name:m.name,mapId:m.id,mapVersion:1,rowOrder:[],enabled:true}))});
  if(path==='/api/surveys')return route.fulfill({json:[...records.values()]});
  if(path.startsWith('/api/surveys/')){
   const id=path.split('/').at(-1)!;
   if(route.request().method()==='DELETE'){const record=records.get(id);records.delete(id);return route.fulfill({json:{name:record?.name}});}
   const record=records.get(id);if(record)return route.fulfill({json:record});
  }
  if(path.startsWith('/api/maps/')){const map=maps.find(m=>m.id===path.split('/').at(-1));if(map)return route.fulfill({json:{map,version:1}});}
  observed.unexpected.push(path);return route.fulfill({status:404,json:{error:'Unexpected mocked API: '+path}});
 });
 await page.goto('/');
 await page.getByTestId('advanced-diagnostics').locator('summary').first().click();
 await expect(page.locator('[data-sensor="preview"]')).toContainText('在线（预览画面）');
 await page.getByTestId('advanced-diagnostics').locator('summary').first().click();
 if(scan)await expect(page.locator('.state-card>span')).toHaveText('扫描已保存');
 else {await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();await expect(page.getByLabel('导航地图')).toHaveValue('task-scan-'+maps[0]!.id);}
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 return {records,calls,cameraConnections:()=>cameraConnections};
}
const toggle=(page:Page)=>page.getByRole('button',{name:'中心测距',exact:true});
const result=(page:Page)=>page.getByTestId('center-distance-result');
async function enable(page:Page) {
 await expect(toggle(page)).toHaveAttribute('aria-pressed','false');
 await expect(page.getByLabel('测距起点',{exact:true})).toHaveCount(0);
 await toggle(page).click();await expect(toggle(page)).toHaveAttribute('aria-pressed','true');
}
async function choose(page:Page,from='B000',to='B016') {
 await page.getByLabel('测距起点',{exact:true}).selectOption({label:from});
 await page.getByLabel('测距终点',{exact:true}).selectOption({label:to});
}
async function fiveMeters(page:Page) {
 await expect(result(page).locator('strong')).toHaveText('中心距离 5.000 m （500.0 cm）');
}
async function cleared(page:Page) {
 await expect(page.getByLabel('测距起点',{exact:true})).toHaveValue('');
 await expect(page.getByLabel('测距终点',{exact:true})).toHaveValue('');
 await expect(result(page).locator('strong')).toHaveCount(0);
}

test('select 使用定位组中心计算 3/4 三角距离，草稿明确注明地图计算值',async({page})=>{
 await mock(page);await enable(page);
 for(const label of ['测距起点','测距终点'])await expect(page.getByLabel(label,{exact:true}).locator('option')).toHaveText(['请选择定位组','B000','B016','B032']);
 await choose(page);await fiveMeters(page);
 await expect(result(page)).toContainText('地图计算值');await expect(result(page)).toContainText('尚未实测验收');
});

test('单点提示选择第二点，同一 ID 不显示零距离结果',async({page})=>{
 await mock(page);await enable(page);await page.getByLabel('测距起点',{exact:true}).selectOption({label:'B000'});
 await expect(result(page)).toContainText('第二个定位组');await expect(result(page).locator('strong')).toHaveCount(0);
 await choose(page,'B000','B000');await expect(result(page)).toContainText('请选择两个不同的定位组');
 await expect(result(page).locator('strong')).toHaveCount(0);await expect(result(page)).not.toContainText('0.000 m');
});

test('清除测距保留模式，关闭再打开不保留旧选择',async({page})=>{
 await mock(page);await enable(page);await choose(page);await fiveMeters(page);
 await page.getByRole('button',{name:'清除测距',exact:true}).click();await cleared(page);
 await expect(toggle(page)).toHaveAttribute('aria-pressed','true');
 await choose(page);await toggle(page).click();await expect(toggle(page)).toHaveAttribute('aria-pressed','false');
 await expect(result(page)).toHaveCount(0);await enable(page);await cleared(page);
});

test('切换导航地图关闭模式并清除结果',async({page})=>{
 await mock(page);await enable(page);await choose(page);await fiveMeters(page);
 await page.getByLabel('导航地图').selectOption({label:'other-distance-map'});
 await expect(toggle(page)).toHaveAttribute('aria-pressed','false');await expect(result(page)).toHaveCount(0);
 await enable(page);await cleared(page);
});

test('页面切换清除测距，实时画面仍可打开且导航门禁不变',async({page})=>{
 const h=await mock(page,{scan:true});await enable(page);await choose(page);await fiveMeters(page);
 await page.getByRole('button',{name:'实时画面',exact:true}).click();await expect(page.getByLabel('摄像头实时画面',{exact:true})).toBeVisible();
 await expect.poll(h.cameraConnections).toBe(1);
 await page.getByRole('button',{name:'地图',exact:true}).click();await fiveMeters(page);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await expect(toggle(page)).toHaveAttribute('aria-pressed','false');await expect(result(page)).toHaveCount(0);
 const start=page.locator('.left-panel').getByRole('button',{name:'开始导航',exact:true});await expect(start).toBeDisabled();
 await enable(page);await cleared(page);await choose(page);await fiveMeters(page);await expect(start).toBeDisabled();
 expect(h.calls.filter(p=>p.startsWith('/api/navigation/'))).toEqual([]);
 await page.locator('.sidebar').getByRole('button',{name:'扫描建图',exact:true}).click();
 await expect(toggle(page)).toHaveAttribute('aria-pressed','false');await enable(page);await cleared(page);
});

test('扫描 preview 使用优化后中心坐标，轮询更新地图时重新计算',async({page})=>{
 const h=await mock(page,{scan:true});await enable(page);await choose(page);await fiveMeters(page);
 const previous=h.records.get('distance-survey')!;
 // Raw observations stay at (3,4); only the optimized map center changes to (6,8).
 h.records.set(previous.id,{...previous,result:{...previous.result,tags:previous.result.tags.map(t=>t.id===16?{...t,x:6,y:8}:t)}});
 await expect(result(page).locator('strong')).toHaveText('中心距离 10.000 m （1000.0 cm）');
 await expect(toggle(page)).toHaveAttribute('aria-pressed','true');
 await expect(page.getByLabel('测距起点',{exact:true})).toHaveValue('0');await expect(page.getByLabel('测距终点',{exact:true})).toHaveValue('16');
});

test('删除当前扫描重置地图并清除测距',async({page})=>{
 const h=await mock(page,{scan:true});await enable(page);await choose(page);await fiveMeters(page);
 await page.getByRole('button',{name:'管理扫描记录'}).click();await page.getByRole('button',{name:'删除扫描 中心测距扫描'}).click();
 await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('button',{name:'关闭扫描记录'}).click();
 await expect(page.getByTestId('map-canvas')).toHaveCount(0);await expect(result(page)).toHaveCount(0);await expect(toggle(page)).toHaveCount(0);
 expect(h.records.size).toBe(0);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();await enable(page);await cleared(page);
});

test('不足两个定位组禁用工具按钮',async({page})=>{
 const map=field();map.tags=map.tags.slice(0,1);await mock(page,{maps:[map]});await expect(toggle(page)).toBeDisabled();
 await expect(toggle(page)).toHaveAttribute('aria-pressed','false');await expect(result(page)).toHaveCount(0);
});

// Use actual pointer events and the existing fit control; no Konva globals or app hooks.
async function clickCenter(page:Page,map:FieldMap,point:Point) {
 const canvas=page.getByTestId('map-canvas');await canvas.scrollIntoViewIfNeeded();
 await page.getByRole('button',{name:'适应地图',exact:true}).click();
 const box=await canvas.boundingBox();expect(box).not.toBeNull();if(!box)throw new Error('地图画布没有尺寸');
 const points=[...map.zone,...map.rows.flatMap(r=>r.points),...map.tags];
 const xs=points.map(p=>p.x*100),ys=points.map(p=>-p.y*100),minX=Math.min(...xs),minY=Math.min(...ys);
 const width=Math.max(...xs)-minX,height=Math.max(...ys)-minY;
 const scale=Math.min((box.width-140)/Math.max(width,100),(box.height-120)/Math.max(height,100));
 const x=(box.width-width*scale)/2+(point.x*100-minX)*scale,y=(box.height-height*scale)/2+(-point.y*100-minY)*scale;
 await page.mouse.click(box.x+x,box.y+y);
}

test('真实点击画布两中心测距，第三次点击重新选择起点',async({page})=>{
 const map=field();await mock(page,{maps:[map]});
 await clickCenter(page,map,map.tags[0]!);await expect(toggle(page)).toHaveAttribute('aria-pressed','false');await expect(result(page)).toHaveCount(0);
 await enable(page);await clickCenter(page,map,map.tags[0]!);await expect(page.getByLabel('测距起点',{exact:true})).toHaveValue('0');
 await expect(result(page)).toContainText('第二个定位组');
 await clickCenter(page,map,map.tags[0]!);await expect(page.getByLabel('测距终点',{exact:true})).toHaveValue('');
 await clickCenter(page,map,map.tags[1]!);await fiveMeters(page);
 await clickCenter(page,map,map.tags[2]!);await expect(page.getByLabel('测距起点',{exact:true})).toHaveValue('32');
 await expect(page.getByLabel('测距终点',{exact:true})).toHaveValue('');await expect(result(page).locator('strong')).toHaveCount(0);
 await clickCenter(page,map,map.tags[0]!);await expect(result(page).locator('strong')).toHaveText('中心距离 3.000 m （300.0 cm）');
});

for(const width of [375,760])test(`窄屏 ${width}px 测距选择、结果和清除按钮无横向溢出`,async({page})=>{
 await page.setViewportSize({width,height:900});await mock(page);await enable(page);await choose(page);await fiveMeters(page);
 for(const locator of [page.locator('.canvas-toolbar'),page.locator('.distance-panel'),page.getByLabel('测距起点',{exact:true}),page.getByLabel('测距终点',{exact:true}),result(page),page.getByRole('button',{name:'清除测距',exact:true})]){
  const box=await locator.boundingBox();expect(box).not.toBeNull();if(box){expect(box.x).toBeGreaterThanOrEqual(-1);expect(box.x+box.width).toBeLessThanOrEqual(width+1);}
 }
 const overflow=await page.evaluate(()=>({document:document.documentElement.scrollWidth-document.documentElement.clientWidth,panel:(()=>{const el=document.querySelector('.distance-panel')!;return el.scrollWidth-el.clientWidth;})()}));
 expect(overflow.document).toBeLessThanOrEqual(1);expect(overflow.panel).toBeLessThanOrEqual(1);
 await page.getByRole('button',{name:'清除测距',exact:true}).click();await cleared(page);
});
