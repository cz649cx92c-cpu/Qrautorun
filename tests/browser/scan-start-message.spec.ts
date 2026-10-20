import {test,expect} from '@playwright/test';
import {generateBoards} from '../../web/shared/boards';
import {writeFileSync} from 'node:fs';
const folder='/home/orangepi/ugv/QRautorun/qr_navigation_ws/logs/mapping-blocker-20261019';
for(const readyAtStart of [true,false])test('实际开始扫描与104帧轮询；启动'+(readyAtStart?'就绪':'待同步')+'文案不锁存',async({page})=>{
 const board=generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:113})[0]!;
 let record:any=null;
 let robot:any={connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},conditions:[],events:[],sensors:{camera:'定位识别服务在线',imu:'在线',odom:'底盘反馈已接入',localization:'局部已融合'},detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:readyAtStart,quality:'verified',localEpoch:'formal-origin',reason:readyAtStart?'':'等待新鲜的正式同步定位观测'}};
 let send:(status:any)=>void=()=>{};
 const calls:{path:string,method:string}[]=[],unexpected:string[]=[],errors:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.routeWebSocket('**/ws',socket=>{send=status=>socket.send(JSON.stringify({type:'robot',status}));send(robot);});
 // Deliberately deliver no video: its footer must remain independent of survey samples.
 await page.routeWebSocket('**/ws/camera',()=>{});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method();calls.push({path,method});
  if(path==='/api/boards')return route.fulfill({json:[board]});
  if(path==='/api/routes'||path==='/api/tasks'||path==='/api/maps')return route.fulfill({json:[]});
  if(path==='/api/surveys')return route.fulfill({json:record?[{...record,sampleCount:record.samples.length,groupCount:record.samples.length?1:0,mapId:null,deletable:false}]:[]});
  if(path==='/api/camera/status')return route.fulfill({json:{type:'camera',name:'HBVCAM',running:true,present:true,profiles:[],frameAgeMs:10,fps:30,error:''}});
  if(path==='/api/camera/calibration')return route.fulfill({json:{busy:false}});
  if(path==='/api/survey/start'&&method==='POST'){
   record={id:'mock-message-scan',name:'提示生命周期',created:'2026-10-19T10:00:00Z',state:'collecting',anchors:[],samples:[],boards:[board],counts:{},visibility:{},captureQuality:'verified',result:null,motionRecords:[],motionValidation:{recordCount:0,segments:[],reasons:[]}};
   return route.fulfill({json:record});
  }
  if(path==='/api/surveys/mock-message-scan')return route.fulfill({json:record});
  unexpected.push(path);return route.fulfill({status:404,json:{error:'Unmocked API '+path}});
 });
 await page.goto('/');await expect(page.getByRole('button',{name:'开始扫描',exact:true})).toBeEnabled();await page.getByRole('button',{name:'开始扫描',exact:true}).click();
 await expect(page.locator('.message')).toHaveText('扫描已开始');await page.locator('.capture-diagnostics summary').click();await expect(page.locator('.scan-wait')).toContainText(readyAtStart?'等待首帧定位观测写入':'等待新鲜的正式同步定位观测');
 await expect(page.locator('.preview-footer')).toContainText('等待首帧');
 record.samples=Array.from({length:104},(_,i)=>({stamp:100+i*.04,pose:{x:0,y:0,yaw:0},calibrated:true,synchronized:true,localEpoch:'formal-origin',tags:[{id:113,groupId:'B113',x:.1,y:0,angle:0,sigma:.01}]}));record.counts={'113':104};
 await expect(page.getByTestId('capture-count')).toHaveText('已采集 1 个定位点 · 104 帧');await expect(page.locator('.message')).toHaveText('扫描已开始');
 if(!readyAtStart)await expect(page.locator('.scan-wait')).toContainText('等待新鲜的正式同步定位观测');
 robot={...robot,mapping:{...robot.mapping,ready:true,reason:''}};send(robot);
 await expect(page.locator('.scan-wait')).toHaveCount(0);await expect(page.locator('.state-card>span')).toHaveText('正在记录');await expect(page.locator('.preview-footer')).toContainText('等待首帧');
 const name=readyAtStart?'first-frame':'sync';await page.screenshot({path:folder+'/ui-message-'+name+'-104.png',fullPage:true});
 record={...record,state:'stopped'};await expect(page.locator('.message')).toHaveText('本次扫描已保存，路径和定位组已保留');await expect(page.getByTestId('capture-count')).toHaveText('已采集 1 个定位点 · 104 帧');
 expect(calls.filter(call=>call.method!=='GET')).toEqual([{path:'/api/survey/start',method:'POST'}]);expect(unexpected).toEqual([]);expect(errors).toEqual([]);
 writeFileSync(folder+'/ui-message-'+name+'-browser.json',JSON.stringify({samples:record.samples.length,message:await page.locator('.message').innerText(),cameraFooter:await page.locator('.preview-footer').innerText(),calls,unexpected,errors},null,2));
});
