import {test,expect,type Page} from '@playwright/test';

// 第5项回归：初始化链的**健壮性**。
// 线上真实故障：一条 collecting 会话的 detail 请求挂 27 秒 → act() 的 busy 恒 true
// → 全站按钮「正在处理…」/disabled，且 act 的 busy 守卫把用户点击静默丢弃。
// 这里用 mock 精确复现「可选接口超时 / 失败 / 挂起」，验证：
//   1. 一个慢或失败的可选接口不得锁死全站入口；
//   2. busy 必须有上界，超时后必须解除；
//   3. 无地图时点「路径编辑」必须给出下一步引导，不能静默无反应；
//   4. 地图加载成功后可正常进入路径编辑并操作（离线可用）。
const MAP_ID='init-map';
const map:any={schemaVersion:1,id:MAP_ID,name:'初始化核验图',frame:'map',family:'tag36h11',source:'survey',
 coordinateStatus:'draft',routeMode:'waypoints',
 rows:[{id:'route',name:'原路线',width:.6,exitDistance:.8,start:{x:0,y:0},points:[{x:1,y:0},{x:1,y:1}]}],order:['route'],
 tags:[{id:0,x:0,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
       {id:1,x:1,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
       {id:2,x:1,y:1,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]}],
 zone:[{x:-1,y:-1},{x:2,y:-1},{x:2,y:2},{x:-1,y:2}],vehicle:{width:.4,length:.8,margin:.05},notes:''};

type Mode={
 /** /api/surveys 挂起（永不响应）。 */
 hangSurveys?:boolean;
 /** /api/surveys/:id 挂起。 */
 hangDetail?:boolean;
 /** /api/boards 返回 500。 */
 failBoards?:boolean;
 /** /api/tasks 返回 500。 */
 failTasks?:boolean;
 /** maps 列表为空（模拟未选择地图）。 */
 noMaps?:boolean;
};

const HEALTHY_SURVEYS=[
 {id:'s-ok',name:'正常记录',created:'2026-10-29T09:59:36.412Z',state:'stopped',sampleCount:1175,groupCount:17,
  mapId:MAP_ID,deletable:true,protectedReason:null,mapVersions:1,routeCount:0,taskCount:0},
];

async function boot(page:Page,mode:Mode={}){
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],events:[],detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:true,quality:'draft',localEpoch:'init',reason:''}}})));
 await page.routeWebSocket('**/ws/camera',()=>{});
 let detailCalls=0;
 await page.route('**/api/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  // 永不响应的挂起：用不 fulfill 也不 abort 来模拟「服务端 27 秒无响应」。
  if(mode.hangSurveys&&path==='/api/surveys')return; // 故意悬挂
  if(mode.hangDetail&&path.startsWith('/api/surveys/')&&path!=='/api/surveys'){detailCalls++;return;}
  if(path==='/api/surveys')return r.fulfill({json:HEALTHY_SURVEYS});
  if(path==='/api/surveys/s-ok'){
   return r.fulfill({json:{...HEALTHY_SURVEYS[0],anchors:[],motionRecords:[]}});
  }
  if(path==='/api/maps')return r.fulfill({json:mode.noMaps?[]:[{id:MAP_ID,name:map.name,version:1}]});
  if(path==='/api/maps/'+MAP_ID)return r.fulfill({json:{map,version:1,acceptance:{kind:'office_test',accepted:true,digestValid:true}}});
  if(path==='/api/maps/'+MAP_ID+'/tag-aliases')return r.fulfill({json:{mapId:MAP_ID,mapVersion:1,aliases:[],disclaimer:'x'}});
  if(path==='/api/tasks')return mode.failTasks?r.fulfill({status:500,json:{error:'任务服务暂不可用'}}):r.fulfill({json:[]});
  if(path==='/api/routes')return r.fulfill({json:[]});
  if(path==='/api/boards')return mode.failBoards?r.fulfill({status:500,json:{error:'定位板服务暂不可用'}}):r.fulfill({json:[]});
  if(path==='/api/camera/status')return r.fulfill({json:{running:false,present:false}});
  if(path==='/api/localization/map')return r.fulfill({json:{phase:'anchored'}});
  if(path==='/api/localization/scope')return r.fulfill({json:{phase:'anchored'}});
  return r.fulfill({json:{}});
 });
 await page.goto('/');
 return {errors,detailCalls:()=>detailCalls};
}

const busyButtons=async(page:Page)=>page.evaluate(()=>[...document.querySelectorAll('button')]
 .filter(b=>/正在处理/.test(b.textContent||'')).map(b=>b.textContent?.trim().slice(0,16)));

test('第5项：/api/surveys 永不响应时，busy 必须有上界，入口不能永久锁死',async({page})=>{
 const {errors}=await boot(page,{hangSurveys:true});
 // 等过 api 超时（8s）+ act 余量
 await page.waitForTimeout(5000);
 // 期间允许处于 busy：这是诚实的状态，但必须有可见的「正在处理」
 const during=await busyButtons(page);
 // 等到超时上界之后，busy 必须解除
 await page.waitForTimeout(14000);
 const after=await busyButtons(page);
 console.log('BUSY during='+JSON.stringify(during)+' after='+JSON.stringify(after));
 expect(after,'慢接口不得让全站永久停在「正在处理…」').toEqual([]);
 // 侧栏入口仍可用（不被 busy 永久禁用）
 const navEdit=page.getByTestId('nav-route-edit');
 await expect(navEdit).toBeEnabled();
 // 关键：点下去必须有反应（有地图时能进编辑，无地图时给引导），不能静默
 await navEdit.click();
 await page.waitForTimeout(1200);
 const responded=await page.evaluate(()=>({
  routeEditor:!!document.querySelector('[data-testid="route-editor"]'),
  h1:document.querySelector('h1')?.textContent??'',
  hasNotice:document.body.innerText.includes('路径编辑')||document.body.innerText.includes('还没有地图')||document.body.innerText.includes('请先'),
 }));
 console.log('RESPONDED '+JSON.stringify(responded));
 expect(responded.routeEditor||responded.hasNotice,'点「路径编辑」不能毫无反应').toBe(true);
 expect(errors).toEqual([]);
});

test('第5项：可选接口 /api/boards 与 /api/tasks 失败不得阻断地图加载与路径编辑',async({page})=>{
 const {errors}=await boot(page,{failBoards:true,failTasks:true});
 // 地图必须仍然加载出来（这是能不能干活的前提）
 await page.waitForTimeout(2500);
 // map-select 在「开始导航」页，扫描页没有它；先切页再量可选地图数。
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(1200);
 const loaded=await page.evaluate(()=>{
  const sel=document.querySelector('[data-testid="map-select"]') as HTMLSelectElement|null;
  return {mapOptions:sel?.options.length??0,value:sel?.value??null,
   busy:[...document.querySelectorAll('button')].filter(b=>/正在处理/.test(b.textContent||'')).length};
 });
 console.log('LOADED '+JSON.stringify(loaded));
 expect(loaded.busy,'可选接口失败后 busy 必须已释放').toBe(0);
 expect(loaded.mapOptions,'/api/boards 与 /api/tasks 失败不得阻断地图列表').toBeGreaterThan(1);
 // 地图可选中并进入路径编辑
 await page.getByTestId('map-select').selectOption(MAP_ID);
 await page.waitForTimeout(1000);
 // 选中后必须真的有地图被载入（离线编辑的前提）
 await expect(page.getByTestId('map-canvas')).toBeVisible({timeout:15000});
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible({timeout:20000});
 // 进编辑后默认必须是选择工具（上一轮修复），不是加点
 await expect(page.getByTestId('route-select-tool')).toHaveAttribute('aria-pressed','true');
 expect(errors).toEqual([]);
});

test('第5项：完全没有地图时点「路径编辑」必须给出下一步引导',async({page})=>{
 const {errors}=await boot(page,{noMaps:true});
 await page.waitForTimeout(2500);
 await page.getByTestId('nav-route-edit').click();
 await page.waitForTimeout(1200);
 // 不能静默：必须切到可操作页面并给出明确提示
 const state=await page.evaluate(()=>({
  routeEditor:!!document.querySelector('[data-testid="route-editor"]'),
  h1:document.querySelector('h1')?.textContent??'',
  body:document.body.innerText,
 }));
 console.log('NO_MAP '+JSON.stringify({routeEditor:state.routeEditor,h1:state.h1}));
 expect(state.routeEditor,'没有地图时不应强行进入编辑').toBe(false);
 const guided=/还没有地图|请先.*地图|新建空白地图|选择一张地图/.test(state.body);
 expect(guided,'没有地图时必须告诉用户下一步怎么做，不能静默无反应').toBe(true);
 expect(errors).toEqual([]);
});
