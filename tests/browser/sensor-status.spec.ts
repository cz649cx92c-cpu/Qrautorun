import {test,expect,type Page} from '@playwright/test';
const sample={quality:'draft',localEpoch:'old-origin',pose:{x:0,y:0,yaw:0},tags:[]};
function record(id:string,state='stopped',anchors:any[]=[],samples:any[]=[]){return {id,name:'恢复测试',created:'2026-10-14T00:00:00Z',state,anchors,samples,boards:[],counts:{},visibility:{},captureQuality:'draft',result:null,sampleCount:samples.length,groupCount:0,mapId:null,deletable:state==='stopped',protectedReason:null};}
function status(){return {connected:true,state:'IDLE',running:false,chassis:{connected:true},sensors:{camera:'位姿已计算 / 待同步',imu:'在线（融合输入）',odom:'原底盘已接入',localization:'局部已融合 / 待标定'},conditions:[],events:[],detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:true,localEpoch:'old-origin',reason:'',quality:'draft'}};}
async function mock(page:Page,initial:any[],robot:any=status()){
 const records=new Map(initial.map(r=>[r.id,r]));let telemetry=robot;
 const calls:string[]=[];const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 let failLists=0;let blockDetail:((id:string)=>Promise<void>)|undefined;
 let send:(value:any)=>void=()=>{};
 await page.routeWebSocket('**/ws',ws=>{send=value=>ws.send(JSON.stringify({type:'robot',status:value}));send(telemetry);});
 await page.routeWebSocket('**/ws/camera',()=>{});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;calls.push(path);
  if(path==='/api/camera/status')return route.fulfill({json:{running:true,present:true,frameAgeMs:10,error:''}});
  // refresh() 会一次性取 surveys/tasks/routes/maps/boards；漏掉任何一个，
  // 整个 refresh 都会抛错，开始扫描根本走不到 /api/survey/start。
  if(path==='/api/maps')return route.fulfill({json:[]});
  if(path==='/api/boards')return route.fulfill({json:[{id:'B000',referenceId:0}]});
  if(path==='/api/routes')return route.fulfill({json:[]});
  if(path==='/api/tasks')return route.fulfill({json:[]});
  if(path==='/api/surveys'){
   if(failLists>0){failLists--;return route.fulfill({status:503,json:{error:'临时不可用'}});}
   return route.fulfill({json:[...records.values()]});
  }
  if(path.startsWith('/api/surveys/')){
   if(blockDetail)await blockDetail(path.split('/').at(-1)!);
   return route.fulfill({json:records.get(path.split('/').at(-1)!)});
  }
  if(path==='/api/survey/start'){const r=record('started','collecting');records.set(r.id,r);return route.fulfill({json:r});}
  if(path==='/api/camera/calibration')return route.fulfill({json:{}});
  // 加载地图后 App 会把定位锚定到该版本（v1 起的真实行为）。
  if(path==='/api/localization/map')return route.fulfill({json:{anchored:true}});
  if(path==='/api/localization/scope')return route.fulfill({json:{phase:'anchored'}});
  return route.fulfill({status:404,json:{error:'Unexpected mocked API: '+path}});
 });
 await page.goto('/');await page.getByTestId('advanced-diagnostics').locator('summary').first().click();await expect(page.locator('[data-sensor="preview"]')).toContainText('在线（预览画面）');
 // 状态卡文案已简化为「正在记录 / 已保存」。
 if(initial.some(r=>r.state==='collecting'))await expect(page.locator('.state-card>span')).toHaveText('正在记录');
 else if(initial.length)await expect(page.locator('.state-card>span')).toHaveText('已保存');
 else await expect(page.getByRole('button',{name:'开始扫描',exact:true})).toBeEnabled();
 return {records,calls,errors,robot:(r:any)=>{telemetry=r;send(r);},failNextList:()=>{failLists++;},block:(fn:((id:string)=>Promise<void>)|undefined)=>{blockDetail=fn;}};
}
async function openRecords(page:Page){await page.getByRole('button',{name:'管理扫描记录'}).click();}
const selectedName=(page:Page)=>page.locator('.records-trigger strong');

test('预览在线与识别离线分开显示，提前启动后明确等待原因',async({page})=>{
 const robot=status();robot.detector.connected=false;robot.detector.reason='定位识别服务心跳超时';robot.mapping.ready=false;robot.mapping.reason='传感器观测中断，需重启融合';robot.sensors.imu='IMU数据超时 / 等待恢复';robot.sensors.localization='融合不可用 / 需重启';
 const h=await mock(page,[],robot);
 await expect(page.locator('[data-sensor="detector"]')).toContainText('定位识别服务心跳超时');
 await expect(page.locator('[data-sensor="imu"]')).toContainText('IMU数据超时');
 await expect(page.locator('[data-sensor="localization"]')).toContainText('等待自动恢复');
 await page.getByRole('button',{name:'开始扫描',exact:true}).click();
 // 等待原因常显在状态卡上，不再只藏在默认折叠的采集诊断里。
 await expect(page.getByTestId('scan-wait-primary')).toContainText('等待扫描数据');
 await expect(page.getByTestId('scan-wait-primary')).toContainText('识别服务心跳超时');
 // 「保持车辆静止」属于完整原因列表（在采集诊断里），不是常显的那一条。
 await expect(page.locator('.capture-diagnostics .scan-wait')).toContainText('保持车辆静止');
 await expect(page.locator('.right-panel')).not.toContainText('需重启');
 expect(h.calls).toContain('/api/survey/start');expect(h.errors).toEqual([]);
});

test('定位恢复后旧扫描停止会提示已保存并保留记录，可手动打开新一段',async({page})=>{
 const old=record('old','collecting',[{id:0,x:1,y:2}],[sample]);const h=await mock(page,[old]);
 // 原断言引用了不存在的「参数设置」锚点编辑器与「旧扫描已保存，已继续新一段扫描」自动切段 UI；
 // 产品已把组中心坐标改为只读展示（App.vue「组中心坐标只读展示扫描结果」），也没有自动抢选新段的入口。
 // 改为验证真实能力：旧段停止后提示已保存、记录列表同时保留新旧两段、操作员可手动打开续接段。
 h.records.set('old',{...old,state:'stopped'});h.records.set('new',{...record('new','collecting',[],[{...sample,localEpoch:'new-origin'}]),name:'新一段'});
 h.robot({...status(),mapping:{...status().mapping,localEpoch:'new-origin'}});
 await expect(page.locator('.message')).toContainText('本次扫描已保存，路径和定位组已保留');
 await expect(page.locator('.state-card>span')).toHaveText('已保存');
 await openRecords(page);
 await expect(page.locator('[data-record-id="old"]')).toContainText('已保存');
 await expect(page.locator('[data-record-id="new"]')).toContainText('采集中');
 await expect(page.locator('[data-record-id="old"]')).toHaveClass(/selected/);
 await page.getByRole('button',{name:'打开扫描 新一段'}).click();
 await expect(selectedName(page)).toHaveText('新一段');
 await expect(page.locator('.state-card>span')).toHaveText('正在记录');
 await expect(page.getByTestId('capture-count')).toContainText('1 帧');
 expect(h.errors).toEqual([]);
});

test('打开历史时选中该记录，存在新collecting也不抢选择',async({page})=>{
 const old=record('history','stopped',[{id:1,x:3,y:4}]);const h=await mock(page,[old]);
 // 原断言通过不存在的锚点编辑器读取基准点；改为验证真实存在的能力：历史记录保持当前选择，新 collecting 不抢。
 await expect(selectedName(page)).toHaveText('恢复测试');
 h.records.set('new',{...record('new','collecting'),name:'新一段'});
 await expect.poll(()=>h.calls.filter(p=>p==='/api/surveys/history').length).toBeGreaterThan(1);
 await expect(selectedName(page)).toHaveText('恢复测试');await expect(page.locator('.state-card>span')).toHaveText('已保存');
 await expect(page.locator('.message')).toHaveCount(0);
 await openRecords(page);
 await expect(page.locator('[data-record-id="history"]')).toHaveClass(/selected/);
 await expect(page.locator('[data-record-id="new"]')).not.toHaveClass(/selected/);
 expect(h.errors).toEqual([]);
});

test('轮询本记录只刷新当前记录，不切到其他采集中记录',async({page})=>{
 const h=await mock(page,[record('history')]);
 // 原断言验证「用户编辑的基准点」不被轮询覆盖；产品已移除手工锚点编辑（组中心只读），改为验证同一意图下真实存在的选择稳定性。
 await expect(selectedName(page)).toHaveText('恢复测试');
 h.records.set('new',{...record('new','collecting'),name:'新一段'});
 await expect.poll(()=>h.calls.filter(p=>p==='/api/surveys/history').length).toBeGreaterThan(1);
 await expect(selectedName(page)).toHaveText('恢复测试');await expect(page.locator('.state-card>span')).toHaveText('已保存');
 await openRecords(page);
 await expect(page.locator('[data-record-id="history"]')).toHaveClass(/selected/);
 expect(h.errors).toEqual([]);
});

test('续接列表暂时失败时保留采集选择并重试',async({page})=>{
 const old=record('old','collecting',[],[sample]);const h=await mock(page,[old]);
 h.records.set('old',{...old,state:'stopped'});h.records.set('new',{...record('new','collecting'),name:'新一段'});h.failNextList();
 // 原断言引用从未存在的「旧扫描已保存，已继续新一段扫描」自动切段文案；改为验证真实保存提示与重试后仍保留选择。
 await expect(page.locator('.message')).toContainText('本次扫描已保存，路径和定位组已保留',{timeout:10000});
 await expect(page.locator('.state-card>span')).toHaveText('已保存');
 expect(h.calls.filter(p=>p==='/api/surveys').length).toBeGreaterThanOrEqual(3);expect(h.errors).toEqual([]);
});

test('旧记录0帧仍collecting时继续等数据，无需切换记录',async({page})=>{
 const old=record('empty','collecting');const h=await mock(page,[old]);
 h.robot({...status(),mapping:{...status().mapping,localEpoch:'new-origin'}});
 h.records.set('empty',{...old,samples:[{...sample,localEpoch:'new-origin'}]});
 // 原断言引用从未存在的「1 帧草稿观测」文案；真实状态卡是「已采集 … 个定位点 · … 帧」。
 await expect(page.getByTestId('capture-count')).toHaveText('已采集 0 个定位点 · 1 帧');
 expect(h.calls.filter(p=>p==='/api/surveys')).toHaveLength(1);
 await expect(page.locator('.message')).toHaveCount(0);expect(h.errors).toEqual([]);
});

test('桥离线时不保留识别和IMU在线标签，预览独立在线',async({page})=>{
 const h=await mock(page,[]);h.robot({...status(),connected:false});
 await expect(page.locator('[data-sensor="detector"]')).toContainText('ROS桥离线');
 await expect(page.locator('[data-sensor="imu"]')).toContainText('状态未知');
 await expect(page.locator('[data-sensor="preview"]')).toContainText('在线（预览画面）');expect(h.errors).toEqual([]);
});

test('用户打开另一历史记录后，迟到轮询不会覆盖选择',async({page})=>{
 const first=record('first','stopped',[{id:0,x:1,y:1}]),second={...record('second','stopped',[{id:2,x:8,y:9}]),name:'另一段历史'};
 const h=await mock(page,[first,second]);
 // 原断言通过不存在的锚点编辑器读取基准点；改为验证真实存在的记录选择不被迟到轮询覆盖。
 await expect(selectedName(page)).toHaveText('恢复测试');
 let release:()=>void=()=>{},entered=false;const gate=new Promise<void>(resolve=>release=resolve);
 h.block(async id=>{if(id==='first'){entered=true;await gate;}});
 await expect.poll(()=>entered).toBe(true);
 await openRecords(page);
 await page.getByRole('button',{name:'打开扫描 另一段历史'}).click();
 await expect(selectedName(page)).toHaveText('另一段历史');
 release();h.block(undefined);
 await expect.poll(()=>h.calls.filter(p=>p==='/api/surveys/second').length).toBeGreaterThan(1);
 await expect(selectedName(page)).toHaveText('另一段历史');
 await expect(page.locator('.state-card>span')).toHaveText('已保存');expect(h.errors).toEqual([]);
});

test('同原点10000帧记录显示真实帧数，容量停止后不误称定位恢复并可从记录列表打开续接段',async({page})=>{
 const old={...record('full','collecting',[],Array.from({length:10000},()=>sample)),name:'满容量段'};
 const h=await mock(page,[old]);
 // 原断言引用从未存在的「10000 帧草稿观测」文案与自动插入续接段的 UI；
 // 真实能力是记录列表展示完整帧数、停止提示已保存、续接段可在记录列表中手动打开。
 await expect(page.getByTestId('capture-count')).toHaveText('已采集 0 个定位点 · 10000 帧');
 h.records.set('full',{...old,state:'stopped'});h.records.set('continued',{...record('continued','collecting',[],[sample]),name:'续接段'});
 await expect(page.locator('.message')).toContainText('本次扫描已保存，路径和定位组已保留');
 await expect(page.locator('.message')).not.toContainText('定位恢复');
 await openRecords(page);
 await expect(page.locator('[data-record-id="full"]')).toContainText('10000 帧');
 await expect(page.locator('[data-record-id="full"]')).toContainText('已保存');
 await expect(page.locator('[data-record-id="continued"]')).toContainText('采集中');
 await page.getByRole('button',{name:'打开扫描 续接段'}).click();
 await expect(page.getByTestId('capture-count')).toHaveText('已采集 0 个定位点 · 1 帧');
 await expect(page.locator('.state-card>span')).toHaveText('正在记录');expect(h.errors).toEqual([]);
});
