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
  if(path==='/api/boards')return route.fulfill({json:[{id:'B000',referenceId:0}]});
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
  return route.fulfill({status:404,json:{error:'Unexpected mocked API: '+path}});
 });
 await page.goto('/');await page.getByTestId('advanced-diagnostics').locator('summary').first().click();await expect(page.locator('[data-sensor="preview"]')).toContainText('在线（预览画面）');
 if(initial.some(r=>r.state==='collecting'))await expect(page.locator('.state-card>span')).toHaveText(/正在扫描|等待扫描数据/);
 else if(initial.length)await expect(page.locator('.state-card>span')).toHaveText('扫描已保存');
 else await expect(page.getByRole('button',{name:'开始扫描',exact:true})).toBeEnabled();
 return {records,calls,errors,robot:(r:any)=>{telemetry=r;send(r);},failNextList:()=>{failLists++;},block:(fn:((id:string)=>Promise<void>)|undefined)=>{blockDetail=fn;}};
}
async function anchors(page:Page){await page.getByText('参数设置',{exact:true}).click();return page.locator('.scan-details textarea');}

test('预览在线与识别离线分开显示，提前启动后明确等待原因',async({page})=>{
 const robot=status();robot.detector.connected=false;robot.detector.reason='定位识别服务心跳超时';robot.mapping.ready=false;robot.mapping.reason='传感器观测中断，需重启融合';robot.sensors.imu='IMU数据超时 / 等待恢复';robot.sensors.localization='融合不可用 / 需重启';
 const h=await mock(page,[],robot);
 await expect(page.locator('[data-sensor="detector"]')).toContainText('定位识别服务心跳超时');
 await expect(page.locator('[data-sensor="imu"]')).toContainText('IMU数据超时');
 await expect(page.locator('[data-sensor="localization"]')).toContainText('等待自动恢复');
 await page.getByRole('button',{name:'开始扫描',exact:true}).click();
 await expect(page.locator('.state-card')).toContainText('等待扫描数据');
 await expect(page.locator('.scan-wait')).toContainText('识别服务心跳超时');
 await expect(page.locator('.scan-wait')).toContainText('保持车辆静止');
 await expect(page.locator('.right-panel')).not.toContainText('需重启');
 expect(h.calls).toContain('/api/survey/start');expect(h.errors).toEqual([]);
});

test('定位恢复后自动切换新采集，加载新基准点并保留旧记录',async({page})=>{
 const old=record('old','collecting',[{id:0,x:1,y:2}],[sample]);const h=await mock(page,[old]);
 const input=await anchors(page);await expect(input).toHaveValue(JSON.stringify(old.anchors));
 h.records.set('old',{...old,state:'stopped'});const next=record('new','collecting',[],[{...sample,localEpoch:'new-origin'}]);h.records.set('new',next);
 h.robot({...status(),mapping:{...status().mapping,localEpoch:'new-origin'}});
 await expect(page.locator('.message')).toContainText('旧扫描已保存，已继续新一段扫描');
 await expect(input).toHaveValue('[]');
 await page.getByRole('button',{name:'管理扫描记录'}).click();
 await expect(page.locator('[data-record-id="new"]')).toHaveClass(/selected/);
 await expect(page.locator('[data-record-id="old"]')).toContainText('已保存');expect(h.errors).toEqual([]);
});

test('打开历史时加载该记录的基准点，存在新collecting也不抢选择',async({page})=>{
 const old=record('history','stopped',[{id:1,x:3,y:4}]);const h=await mock(page,[old]);
 const input=await anchors(page);await expect(input).toHaveValue(JSON.stringify(old.anchors));
 h.records.set('new',record('new','collecting'));
 await expect.poll(()=>h.calls.filter(p=>p==='/api/surveys/history').length).toBeGreaterThan(1);
 await expect(input).toHaveValue(JSON.stringify(old.anchors));await expect(page.locator('.message')).toHaveCount(0);
 await page.getByRole('button',{name:'管理扫描记录'}).click();
 await expect(page.locator('[data-record-id="history"]')).toHaveClass(/selected/);
 expect(h.errors).toEqual([]);
});

test('轮询本记录不覆盖用户编辑的基准点',async({page})=>{
 const h=await mock(page,[record('history')]);const input=await anchors(page);await input.fill('[{"id":2,"x":5,"y":6}]');
 await expect.poll(()=>h.calls.filter(p=>p==='/api/surveys/history').length).toBeGreaterThan(1);
 await expect(input).toHaveValue('[{"id":2,"x":5,"y":6}]');expect(h.errors).toEqual([]);
});

test('续接列表暂时失败时保留采集选择并重试',async({page})=>{
 const old=record('old','collecting',[],[sample]);const h=await mock(page,[old]);
 h.records.set('old',{...old,state:'stopped'});h.records.set('new',record('new','collecting'));h.failNextList();
 await expect(page.locator('.message')).toContainText('旧扫描已保存，已继续新一段扫描',{timeout:10000});
 expect(h.calls.filter(p=>p==='/api/surveys').length).toBeGreaterThanOrEqual(3);expect(h.errors).toEqual([]);
});

test('旧记录0帧仍collecting时继续等数据，无需切换记录',async({page})=>{
 const old=record('empty','collecting');const h=await mock(page,[old]);
 h.robot({...status(),mapping:{...status().mapping,localEpoch:'new-origin'}});
 h.records.set('empty',{...old,samples:[{...sample,localEpoch:'new-origin'}]});
 await expect(page.locator('.state-card')).toContainText('1 帧草稿观测');
 expect(h.calls.filter(p=>p==='/api/surveys')).toHaveLength(1);
 await expect(page.locator('.message')).toHaveCount(0);expect(h.errors).toEqual([]);
});

test('桥离线时不保留识别和IMU在线标签，预览独立在线',async({page})=>{
 const h=await mock(page,[]);h.robot({...status(),connected:false});
 await expect(page.locator('[data-sensor="detector"]')).toContainText('ROS桥离线');
 await expect(page.locator('[data-sensor="imu"]')).toContainText('状态未知');
 await expect(page.locator('[data-sensor="preview"]')).toContainText('在线（预览画面）');expect(h.errors).toEqual([]);
});

test('用户打开另一历史记录后，迟到轮询不会覆盖选择或基准点',async({page})=>{
 const first=record('first','stopped',[{id:0,x:1,y:1}]),second={...record('second','stopped',[{id:2,x:8,y:9}]),name:'另一段历史'};
 const h=await mock(page,[first,second]);const input=await anchors(page);
 let release:()=>void=()=>{},entered=false;const gate=new Promise<void>(resolve=>release=resolve);
 h.block(async id=>{if(id==='first'){entered=true;await gate;}});
 await expect.poll(()=>entered).toBe(true);
 await page.getByRole('button',{name:'管理扫描记录'}).click();
 await page.getByRole('button',{name:'打开扫描 另一段历史'}).click();
 await expect(input).toHaveValue(JSON.stringify(second.anchors));
 release();h.block(undefined);
 await expect.poll(()=>h.calls.filter(p=>p==='/api/surveys/second').length).toBeGreaterThan(1);
 await expect(input).toHaveValue(JSON.stringify(second.anchors));expect(h.errors).toEqual([]);
});

test('同原点10000帧容量分段也自动续接，提示不误称定位恢复',async({page})=>{
 const old=record('full','collecting',[],Array.from({length:10000},()=>sample));const h=await mock(page,[old]);
 await expect(page.locator('.state-card')).toContainText('10000 帧草稿观测');
 h.records.set('full',{...old,state:'stopped'});h.records.set('continued',record('continued','collecting',[],[sample]));
 await expect(page.locator('.message')).toHaveText('旧扫描已保存，已继续新一段扫描');
 await expect(page.locator('.state-card')).toContainText('1 帧草稿观测');
 await page.getByRole('button',{name:'管理扫描记录'}).click();
 await expect(page.locator('[data-record-id="continued"]')).toHaveClass(/selected/);
 await expect(page.locator('[data-record-id="full"]')).toContainText('10000 帧');expect(h.errors).toEqual([]);
});
