import {test,expect,type Page} from '@playwright/test';

/**
 * 融合标定前端流程（全部 API 由 page.route mock，不连接真实 ROS/数据库）。
 * 断言重点：导航入口、三块区域、创建会话请求体、试验开始/结束 API、分析/保存/应用语义、
 * 导出链接，以及地图页删除“测量人员”后确认坐标仍可点且不再强制 operator。
 */

const MAP_ID='map-office';
const SESSION_ID='cal-1';
const MAP_NAME='办公室标定图';
const STARTED_AT=['2026-10-21T03:20:00.000Z','2026-10-21T03:21:30.000Z'];

const tags=[
 {id:12,groupId:'B000',rowId:'',x:0,y:0,angle:0,size:0.08,kind:'waypoint',rules:[]},
 {id:34,groupId:'B001',rowId:'',x:2.4,y:0,angle:0,size:0.08,kind:'waypoint',rules:[]},
];

type Captured={method:string;path:string;body:any};
interface Ctx {requests:Captured[];errors:string[];sessions:any[];trials:any[];recordingId:string|null;mapVersion:number;analysis:any;savedAnalysis:boolean;applyBody:any}

const robotStatus={connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},conditions:[],events:[],sensors:{},detector:{connected:false},mapping:{ready:false},localization:{},capabilities:{turnInPlace:false}};

function mapBody(version:number){
 return {schemaVersion:1,id:MAP_ID,name:MAP_NAME,frame:'map',family:'tag36h11',source:'survey',coordinateStatus:version>3?'reviewed':'draft',captureQuality:'draft',routeMode:'map-only',rows:[],tags,groups:[],order:[],zone:[{x:-1,y:-1},{x:3,y:-1},{x:3,y:1},{x:-1,y:1}],vehicle:{width:.4,length:.8,margin:.05},notes:''};
}
function stats(mean:number,std:number,n:number){
 return {n,mean,std,min:mean-std,max:mean+std,median:mean,mad:std};
}
function buildAnalysis(ctx:Ctx){
 const trials=ctx.trials.map(trial=>{
  const turning=trial.type==='left'||trial.type==='right';
  const rotationTagId=trial.rotationTagId??null;
  return {
   trialId:trial.id,type:trial.type,repetition:trial.repetition,angleDeg:trial.angleDeg,status:trial.status,
   rotationTagId,rotationTagLabel:trial.rotationTagLabel??null,rotationTagPose:trial.rotationTagPose??null,
   rotationDirection:turning?trial.type:null,
   targetAngleDeg:turning&&trial.angleDeg!==null?Math.abs(trial.angleDeg):null,
   measuredAngleDeg:turning?88.6:null,
   measuredAngleSource:turning?'imu_bias_corrected':null,
   window:{startedAt:trial.startedAt,endedAt:trial.endedAt,durationS:41.2},
   sampleCounts:{observation:12,feedback:60,imu:48,fusion:0},
   stampRange:{first:1000,last:1041},
   stopPoint:{
    counts:turning?{total:12,seeA:8,seeB:0,both:0,neither:4}:{total:12,seeA:6,seeB:6,both:0,neither:0},
    pairing:turning?{startTagId:rotationTagId,endTagId:rotationTagId,kind:'same_tag'}:{startTagId:12,endTagId:34,kind:'a_to_b'},
    start:{tagId:turning?rotationTagId:12,candidates:4,qualified:3,selected:3,stamps:[1000.2,1000.3,1000.4],pose:{x:0,y:0,yaw:0},spreadM:0.004,spreadDeg:0.3,window:{from:1000,to:1001.1},valid:true,invalidReason:null,rejected:{lowVisibility:0,highSigma:0,highReprojection:0,outliers:1}},
    end:{tagId:turning?rotationTagId:34,candidates:4,qualified:3,selected:3,stamps:[1040.6,1040.7,1040.8],pose:{x:0,y:0,yaw:0},spreadM:0.005,spreadDeg:0.4,window:{from:1040.5,to:1041},valid:true,invalidReason:null,rejected:{lowVisibility:0,highSigma:0,highReprojection:0,outliers:1}},
    mapTags:{tagA:{x:0,y:0,yaw:0},tagB:{x:2.4,y:0,yaw:0},start:{x:0,y:0,yaw:0},end:{x:2.4,y:0,yaw:0}},
    startPoseMap:{x:0,y:0,yaw:0},endPoseMap:{x:2.4,y:0,yaw:0},
    visualRelativePose:turning?{x:0.01,y:0.002,yaw:1.58}:{x:2.398,y:0.004,yaw:0.003},
    visualNetDistance:turning?0.01:2.398,visualForwardM:turning?0.01:2.398,visualLateralM:0.002,
    visualYawDeg:turning?90.5:0.2,
    baselineResidualM:turning?null:-0.002,baselineRatio:turning?null:0.9992,
    motion:{startStamp:1001,endStamp:1040,stillnessSource:'feedback_velocity'},
    valid:true,invalidReason:null,
   },
   visualRelativePose:turning?{x:0.01,y:0.002,yaw:1.58}:{x:2.398,y:0.004,yaw:0.003},
   visualNetDistance:turning?0.01:2.398,
   baselineResidual:turning?null:-0.002,
   wheelNetDistance:turning?0.01:2.51,
   wheelPathDistance:turning?1.9:2.51,
   imuYawRaw:turning?90.5:0.6,
   imuYawBiasCorrected:turning?88.6:0,
   timeOffsetCandidate:turning?{delayS:0.035,correlation:0.82,pairs:40,method:'single_tag_bearing_vs_imu'}:null,
   timeOffsetUnavailableReason:turning?null:'insufficient_visual_rates',
   imuBias:{bias:[0,0,0.01135],up:[0,0,1],source:'logs/imu-calibration-latest.json',capturedAt:null},
   wheelYawStatus:{available:false,reason:'wz_all_zero'},
   fusionStatus:{state:'not_integrated',samples:0,message:'本次未接入融合输出样本（fusion=0），不能当作有效融合结果'},
   valid:true,invalidReason:null,excludedFromAggregate:false,excludedReason:null,
   visual:{pairs:12,baselineM:stats(2.398,0.004,12),bearingDeg:stats(0.2,0.1,12),meanPose:{x:2.398,y:0.004,yaw:0}},
   visualVsBaseline:{ratio:0.9992,deltaM:-0.002},
   wheel:{startStamp:1000,endStamp:1041,durationS:41.2,forwardM:turning?0:2.51,lateralM:0.01,travelM:2.51,yawChangeRad:turning?1.62:0,yawChangeDeg:turning?92.8:0,samples:60,gaps:0,maxGapS:0.05},
   imu:{startStamp:1000,endStamp:1041,durationS:41.2,yawChangeRad:turning?1.58:0,yawChangeDeg:turning?90.5:0,rateRadS:[],projected:true,samples:48,gaps:0},
   delay:turning?{delayS:0.035,correlation:0.82,pairs:40}:null,
   candidates:{forwardScale:turning?null:1.046,lateralScale:null,wheelVsBaselineRatio:turning?null:1.0458,imuYawScale:turning?1.0056:null,wheelYawScale:turning?null:null,turnErrorDeg:turning?{wheelVsObserved:null,imuVsObserved:0.5,imuVsWheel:null}:null},
   computable:turning?['原地转向视觉配对（在 Q012 处，起点 3 帧 / 终点 3 帧）','轮速/底盘反馈积分（vx, vy, wz）','转角误差（相对观测角、轮速与 IMU 互差）']:['端点停稳配对视觉位移（起点 A=3 帧 / 终点 B=3 帧）','轮速/底盘反馈积分（vx, vy, wz）','前进/后退比例候选 = 轮速净位移 ÷ 视觉净位移（端点停稳配对）'],
   assumptions:turning?['转向试验的端点配对两端都用旋转二维码 Q012；外部基线（A↔B 2.4 m）对转向不适用，因此不给基线残差','观测角由试验员输入或量角器读数；分析不声称它是绝对真值']:['视觉净位移由端点停稳配对给出；外部基线只用于残差校核，不参与比例计算'],
   missing:turning?['轮速偏航不可用：底盘反馈 wz 恒为 0，wheelYaw unavailable']:['本次未接入融合输出样本（fusion=0），不能当作有效融合结果'],
   faults:[],
  };
 });
 return {
  schemaVersion:3,sessionId:SESSION_ID,mapId:MAP_ID,mapVersion:3,mapDigest:'digest',tagA:12,tagB:34,baselineM:2.4,baselineSource:'external_baseline',
  createdAt:'2026-10-21T03:20:00.000Z',analyzedAt:'2026-10-21T03:22:00.000Z',
  sampleCounts:{observation:24,feedback:120,imu:96,fusion:0},stampRange:{first:1000,last:1041},
  imuBias:{bias:[0,0,0.01135],up:[0,0,1],source:'logs/imu-calibration-latest.json',capturedAt:null},
  trials,
  aggregate:{
   validTrials:2,excluded:[],linearTrials:1,turnTrials:1,turnTrialsMissingRotationTag:0,
   rotationTags:[{tagId:12,label:'Q012',trials:1,validTrials:1}],
   forwardScale:stats(1.046,0.001,1),lateralScale:null,imuYawScale:stats(1.0056,0,1),wheelYawScale:null,
   delayS:stats(0.035,0,1),turnErrorDeg:stats(0.5,0.1,1),
   targetAngleDeg:stats(90,0,1),measuredAngleDeg:stats(88.6,0,1),
   visualBaselineM:stats(2.398,0.004,2),visualBaselineRatio:stats(0.9992,0.0003,2),
   visualNetDistance:stats(2.398,0.004,2),baselineResidualM:stats(-0.002,0.001,2),
   outliers:{forwardScale:[],imuYawScale:[],turnErrorDeg:[]},
  },
  limitations:['外部基线只用于独立校核（baselineResidual），不当作车辆真实行程','视觉位移采用端点停稳配对，不要求同帧同时看到 A 与 B','转向试验必须指定“在哪个二维码处转向”；起点与终点都取该二维码，位移类统计不纳入转向试验'],
  formulas:['端点停稳配对：T_map_base(start)=T_map_startTag·inv(T_base_startTag)，T_map_base(end)=T_map_endTag·inv(T_base_endTag)，相对位姿=inv(T_map_base(start))·T_map_base(end)','前进/后退：startTag=A、endTag=B，给位移；转向：startTag=endTag=旋转二维码，给原地转角，此时不给基线残差'],
 };
}

async function setup(page:Page):Promise<Ctx>{
 const ctx:Ctx={requests:[],errors:[],sessions:[],trials:[],recordingId:null,mapVersion:3,analysis:null,savedAnalysis:false,applyBody:null};
 page.on('pageerror',reason=>ctx.errors.push(reason.message));
 await page.routeWebSocket('**/ws',socket=>socket.send(JSON.stringify({type:'robot',status:robotStatus})));
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  let body:any=null;try{body=request.postDataJSON();}catch{/* GET 无 body */}
  ctx.requests.push({method,path:path+url.search,body});
  const send=(data:any,status=200)=>route.fulfill({status,json:data});
  const capabilities={nodeRecorder:{supported:true,recording:!!ctx.recordingId,lastSampleAt:'2026-10-21T03:20:11.123Z',lastSampleKind:'observation',error:''},applyEnabled:false,applyReason:'本轮仅 dry-run'};
  const summary=(session:any)=>({id:session.id,mapId:session.mapId,mapVersion:session.mapVersion,mapName:MAP_NAME,tagA:session.tagA,tagB:session.tagB,baselineM:session.baselineM,note:session.note,created:session.created,trialCount:ctx.trials.length,analysisSaved:ctx.savedAnalysis,applied:false});
  const detail=()=>{
   const session=ctx.sessions[0];
   return {session:{...session,trials:ctx.trials,analysis:ctx.savedAnalysis?ctx.analysis:null},trials:ctx.trials,sampleCounts:{observation:24,feedback:120,imu:96,fusion:48},recording:{trialId:ctx.recordingId},capabilities};
  };

  if(path==='/api/surveys')return send([]);
  if(path==='/api/tasks')return send([]);
  if(path==='/api/routes')return send([]);
  if(path==='/api/boards')return send([]);
  if(path==='/api/camera/status')return send({running:false,present:false});
  if(path==='/api/maps'&&method==='GET')return send([{id:MAP_ID,name:MAP_NAME,version:ctx.mapVersion,created:'2026-10-20T09:00:00.000Z'}]);
  if(path==='/api/maps/'+MAP_ID&&method==='GET')return send({map:mapBody(ctx.mapVersion),version:ctx.mapVersion,acceptance:{accepted:ctx.mapVersion>3,digestValid:ctx.mapVersion>3,kind:ctx.mapVersion>3?'user_confirmation':null}});
  if(path==='/api/maps/confirm'&&method==='POST'){ctx.mapVersion+=1;return send({map:mapBody(ctx.mapVersion),version:ctx.mapVersion});}
  if(path==='/api/maps/accept'&&method==='POST')return send({map:mapBody(ctx.mapVersion),version:ctx.mapVersion});
  if(path==='/api/calibration/capabilities')return send(capabilities);
  if(path==='/api/calibration/sessions'&&method==='GET')return send({sessions:ctx.sessions.map(summary)});
  if(path==='/api/calibration/sessions'&&method==='POST'){
   const session={id:SESSION_ID,mapId:body.mapId,mapVersion:body.mapVersion,mapDigest:'digest',tagA:body.tagA,tagB:body.tagB,baselineM:body.baselineM,baselineSource:'external_baseline',note:body.note??'',created:'2026-10-21T03:20:00.000Z',trials:[],analysis:null,applied:false};
   ctx.sessions.push(session);
   return send({session});
  }
  if(path==='/api/calibration/sessions/'+SESSION_ID&&method==='GET')return send(detail());
  if(path==='/api/calibration/sessions/'+SESSION_ID+'/trials'&&method==='POST'){
   const index=ctx.trials.length;
   const repetition=ctx.trials.filter(item=>item.type===body.type).length+1;
   const rotationTagId=body.rotationTagId??null;
   const trial={id:'trial-'+(index+1),sessionId:SESSION_ID,type:body.type,angleDeg:body.angleDeg??null,
    rotationTagId,rotationTagLabel:rotationTagId===null?null:'Q'+String(rotationTagId).padStart(3,'0'),
    rotationTagPose:rotationTagId===null?null:{x:0,y:0,yaw:0},
    repetition,note:body.note??'',status:'recording',startedAt:STARTED_AT[index]??STARTED_AT[0],endedAt:null,startedStamp:1000+index*10,endedStamp:null};
   ctx.trials.push(trial);ctx.recordingId=trial.id;
   return send({trial,recording:{trialId:trial.id}});
  }
  const stop=path.match(new RegExp('^/api/calibration/trials/([^/]+)/(stop|abort)$'));
  if(stop&&method==='POST'){
   const trial=ctx.trials.find(item=>item.id===stop[1]);
   if(!trial)return send({error:'试验不存在'},404);
   trial.status=stop[2]==='stop'?'saved':'aborted';trial.endedAt='2026-10-21T03:21:00.000Z';ctx.recordingId=null;
   return send({trial});
  }
  if(path==='/api/calibration/sessions/'+SESSION_ID+'/analyze'&&method==='POST'){ctx.analysis=buildAnalysis(ctx);return send({analysis:ctx.analysis});}
  if(path==='/api/calibration/sessions/'+SESSION_ID+'/analysis'&&method==='POST'){ctx.analysis=ctx.analysis??buildAnalysis(ctx);ctx.savedAnalysis=true;return send({saved:true,analysis:ctx.analysis});}
  if(path==='/api/calibration/sessions/'+SESSION_ID+'/apply'&&method==='POST'){
   ctx.applyBody=body;
   return send({applied:false,reason:'本轮 dry-run：未写入运行参数',proposed:{forwardScale:1.0234,lateralScale:null,imuYawScale:0.9876,visualImuDelayS:0.035},current:{forwardScale:1,lateralScale:null,imuYawScale:1,wheelVelocitySigmaMps:0.12,lateralConstraintSigmaMps:0.08,captureDelayS:0.031},analysisSaved:true});
  }
  if(path==='/api/calibration/sessions/'+SESSION_ID+'/export')return route.fulfill({status:200,headers:{'Content-Type':'text/plain; charset=utf-8'},body:'export'});
  if(path.startsWith('/api/calibration/'))return send({error:`未 mock 的标定接口 ${method} ${path}`},404);
  return send({error:`未 mock 的接口 ${method} ${path}`},404);
 });
 await page.goto('/');
 await expect(page.getByTestId('global-status')).toBeVisible();
 return ctx;
}

test('融合标定完整流程：创建会话→两笔试验→分析→保存→dry-run→导出，地图页无测量人员',async({page})=>{
 const ctx=await setup(page);

 // 1. 导航入口 + 页面三块区域
 await page.getByTestId('nav-calibration').click();
 await expect(page.getByRole('heading',{name:'融合标定',level:2})).toBeVisible();
 await expect(page.getByTestId('calibration-page')).toBeVisible();
 await expect(page.getByTestId('calibration-config')).toBeVisible();
 await expect(page.getByTestId('calibration-trials')).toBeVisible();
 await expect(page.getByTestId('calibration-results')).toBeVisible();
 await expect(page.getByTestId('calibration-capabilities')).toContainText('采集节点 · 已加载');
 await expect(page.getByTestId('calibration-capabilities')).toContainText('最后样本');
 await expect(page.getByTestId('calibration-map-select')).toHaveValue(MAP_ID);
 await expect(page.getByText('当前最新版本 v3 · 2 个二维码')).toBeVisible();

 // 2. 配置：选 A/B + 外部基线 + 备注 → 创建会话（校验 POST body）
 await page.getByTestId('calibration-tag-a').fill('12');
 await page.getByTestId('calibration-tag-b').fill('34');
 await page.getByTestId('calibration-baseline').fill('2.4');
 await page.getByTestId('calibration-note').fill('A 板通道口，B 板第三排');
 await page.getByTestId('create-session').click();
 await expect(page.getByTestId('calibration-current-session')).toContainText('map-office · v3');
 await expect(page.getByTestId('calibration-current-session')).toContainText('Q012 → Q034');
 const create=ctx.requests.find(item=>item.method==='POST'&&item.path==='/api/calibration/sessions');
 expect(create?.body).toMatchObject({mapId:MAP_ID,mapVersion:3,tagA:12,tagB:34,baselineM:2.4,note:'A 板通道口，B 板第三排'});

 // 3. 左转 90°：必须选“在哪个二维码处转”，再开始→结束
 await page.getByTestId('trial-angle-90').click();
 await page.getByTestId('trial-rotation-tag').selectOption('12');
 await page.getByTestId('trial-note').fill('手动左转 90°');
 await expect(page.getByTestId('trial-rotation-hint')).toContainText('在 Q012 处左转 90°（逆时针）');
 await page.getByTestId('start-trial').click();
 await expect(page.getByTestId('recording-banner')).toContainText('正在录制：在 Q012 处左转 90°（逆时针）');
 await expect(page.getByTestId('trial-row-trial-1')).toContainText('第 1 次');
 await expect(page.getByTestId('trial-row-trial-1')).toContainText('左转');
 await expect(page.getByTestId('trial-row-trial-1')).toContainText('90°');
 await expect(page.getByTestId('trial-row-trial-1')).toContainText('在 Q012 处左转 90°（逆时针）');
 await expect(page.getByTestId('trial-row-trial-1')).toContainText('录制中');
 await page.getByTestId('trial-row-trial-1').getByTestId('stop-trial').click();
 await expect(page.getByTestId('trial-row-trial-1')).toContainText('已保存');
 await expect(page.getByTestId('trial-row-trial-1').getByTestId('stop-trial')).toBeDisabled();

 // 4. 前进：开始→结束
 await page.getByTestId('trial-type').selectOption('forward');
 await page.getByTestId('start-trial').click();
 await expect(page.getByTestId('recording-banner')).toContainText('正在录制：前进');
 await expect(page.getByTestId('trial-row-trial-2')).toContainText('第 1 次');
 await expect(page.getByTestId('trial-row-trial-2')).toContainText('前进');
 await page.getByTestId('trial-row-trial-2').getByTestId('stop-trial').click();
 await expect(page.getByTestId('trial-row-trial-2')).toContainText('已保存');
 const trialWrites=ctx.requests.filter(item=>item.method==='POST'&&item.path.endsWith('/trials'));
 expect(trialWrites.map(item=>item.body)).toEqual([{type:'left',angleDeg:90,rotationTagId:12,note:'手动左转 90°'},{type:'forward',angleDeg:null,rotationTagId:null,note:''}]);
 expect(ctx.requests.some(item=>item.method==='POST'&&item.path==='/api/calibration/trials/trial-1/stop')).toBe(true);
 expect(ctx.requests.some(item=>item.method==='POST'&&item.path==='/api/calibration/trials/trial-2/stop')).toBe(true);

 // 5. 分析：每次结果 + 三组文字 + 多次汇总
 await page.getByTestId('analyze').click();
 await expect(page.getByTestId('analysis-aggregate')).toBeVisible();
 await expect(page.getByTestId('analysis-aggregate')).toContainText('多次汇总');
 await expect(page.getByTestId('analysis-aggregate')).toContainText('1.0460');
 await expect(page.getByTestId('aggregate-rotation')).toContainText('Q012 × 1');
 await expect(page.getByTestId('analysis-trial-trial-1')).toContainText('在 Q012 处左转 90°（逆时针）');
 await expect(page.getByTestId('analysis-trial-trial-1')).toContainText('视觉相对位姿（起点→终点）');
 await expect(page.getByTestId('analysis-aggregate')).toContainText('2.3980 ± 0.0040');
 await expect(page.getByTestId('analysis-trial-trial-1')).toContainText('可计算');
 await expect(page.getByTestId('analysis-trial-trial-1')).toContainText('依赖假设');
 await expect(page.getByTestId('analysis-trial-trial-1')).toContainText('缺数据');
 await expect(page.getByTestId('analysis-trial-trial-1')).toContainText('0.035 s');

 // 6. 仅保存分析结果
 await page.getByTestId('save-analysis').click();
 await expect(page.locator('.cw-alert.is-success')).toContainText('分析结果已保存');
 expect(ctx.requests.some(item=>item.method==='POST'&&item.path.indexOf('/analysis')>0&&item.path.endsWith('/analysis'))).toBe(true);

 // 7. 应用到运行参数：二次确认 + 显示未应用与 proposed/current
 await page.getByTestId('apply-analysis').click();
 await expect(page.getByTestId('apply-confirm')).toBeVisible();
 await page.getByTestId('apply-confirm-yes').click();
 await expect(page.getByTestId('apply-result')).toContainText('未应用');
 await expect(page.getByTestId('apply-result')).toContainText('1.0234');
 await expect(page.getByTestId('apply-result')).toContainText('0.9876');
 await expect(page.getByTestId('apply-result')).toContainText('轮速速度 σ');
 await expect(page.getByTestId('apply-result')).toContainText('0.12000');
 await expect(page.getByTestId('apply-result')).toContainText('0.0310');
 expect(ctx.applyBody).toEqual({confirm:true});

 // 8. 导出链接
 await expect(page.getByTestId('calibration-export-json')).toHaveAttribute('href',`/api/calibration/sessions/${SESSION_ID}/export?format=json`);
 await expect(page.getByTestId('calibration-export-csv')).toHaveAttribute('href',`/api/calibration/sessions/${SESSION_ID}/export?format=csv`);
 await expect(page.getByTestId('calibration-export-report')).toHaveAttribute('href',`/api/calibration/sessions/${SESSION_ID}/export?format=report`);

 // 9. 地图页：无“测量人员”，确认坐标按钮可点且不再传 operator
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await expect(page.getByText('测量人员')).toHaveCount(0);
 const confirmButton=page.getByRole('button',{name:'用户确认坐标（无需实测）'});
 await expect(confirmButton).toBeEnabled();
 await confirmButton.click();
 await expect(page.locator('.message')).toContainText('已按用户确认接纳');
 const confirmRequest=ctx.requests.find(item=>item.method==='POST'&&item.path==='/api/maps/confirm');
 expect(confirmRequest?.body).toEqual({mapId:MAP_ID,version:3,confirm:true,updateTasks:true});
 expect(Object.prototype.hasOwnProperty.call(confirmRequest?.body??{},'operator')).toBe(false);

 expect(ctx.errors).toEqual([]);
});

/* ---------------------------------------------------------------------------
 * 追加回归（部署收尾）：
 * A. 旧口径分析（缺 excluded/validTrials/outliers/limitations、schemaVersion<3）
 *    必须可显示、不白屏；读取旧分析只有 GET，不写库；点「分析」后才用新口径。
 * B. 右转/左转统一文案：实测角显式带正负号；turn_direction_mismatch 标记并排除统计。
 * C. 录制时吸顶的结束/中止、列表自动滚到最新、切页保留标定设置。
 * ------------------------------------------------------------------------- */

type Scenario={trials:any[];savedAnalysis:any;afterAnalyze:any};
type MockCtx={requests:{method:string;path:string;body:any}[];errors:string[];trials:any[];analysis:any;savedAnalysis:boolean;recordingId:string|null};

function turnTrial(overrides:any){
 return {trialId:'trial-'+overrides.type+'-'+overrides.repetition,type:'right',angleDeg:-90,repetition:1,status:'saved',
  rotationTagId:12,rotationTagLabel:'Q012',rotationTagPose:null,rotationDirection:'right',
  targetAngleDeg:90,signedTargetAngleDeg:-90,targetAnglePhrase:null,
  measuredAngleDeg:-88.63,measuredAngleSource:'imu_bias_corrected',
  directionMismatch:false,excludedFromAggregate:false,excludedReason:null,valid:true,invalidReason:null,
  window:{startedAt:'2026-10-21T03:20:00.000Z',endedAt:'2026-10-21T03:21:00.000Z',durationS:40},
  sampleCounts:{observation:10,feedback:60,imu:50,fusion:0},stampRange:{first:1,last:2},
  stopPoint:null,fusionStatus:null,wheelYawStatus:null,imuBias:null,
  visual:null,visualVsBaseline:null,wheel:null,imu:null,delay:null,
  candidates:{forwardScale:null,lateralScale:null,imuYawScale:1,wheelYawScale:1,turnErrorDeg:{wheelVsObserved:0.2,imuVsObserved:0.2,imuVsWheel:0}},
  timeOffsetCandidate:null,timeOffsetUnavailableReason:'no_angular_excitation',
  computable:['转角误差'],assumptions:['观测角由试验员输入'],missing:[],faults:[],
  ...overrides};
}
function linearTrial(overrides:any){
 return {trialId:'trial-forward-1',type:'forward',angleDeg:null,repetition:1,status:'saved',
  rotationTagId:null,rotationTagLabel:null,rotationTagPose:null,rotationDirection:null,
  targetAngleDeg:null,signedTargetAngleDeg:null,targetAnglePhrase:null,measuredAngleDeg:null,measuredAngleSource:null,
  directionMismatch:false,excludedFromAggregate:false,excludedReason:null,valid:true,invalidReason:null,
  window:{startedAt:'2026-10-21T03:20:00.000Z',endedAt:'2026-10-21T03:21:00.000Z',durationS:40},
  sampleCounts:{observation:10,feedback:60,imu:50,fusion:0},stampRange:{first:1,last:2},
  stopPoint:null,fusionStatus:null,wheelYawStatus:null,imuBias:null,
  visual:null,visualVsBaseline:null,wheel:null,imu:null,delay:null,
  candidates:{forwardScale:1.0005,lateralScale:null,imuYawScale:null,wheelYawScale:null,turnErrorDeg:null},
  timeOffsetCandidate:null,timeOffsetUnavailableReason:'insufficient_visual_rates',
  computable:['前进比例候选'],assumptions:['视觉净位移由端点停稳配对给出'],missing:[],faults:[],
  ...overrides};
}
function v3Analysis(){
 const left=turnTrial({type:'left',repetition:1,angleDeg:90,rotationDirection:'left',signedTargetAngleDeg:90,measuredAngleDeg:88.63});
 const right=turnTrial({type:'right',repetition:1,measuredAngleDeg:-88.63});
 const bad=turnTrial({type:'right',repetition:2,measuredAngleDeg:95.66,directionMismatch:true,excludedFromAggregate:true,excludedReason:'turn_direction_mismatch',valid:false,invalidReason:'turn_direction_mismatch'});
 return {schemaVersion:3,sessionId:SESSION_ID,mapId:MAP_ID,mapVersion:3,mapDigest:'digest',tagA:12,tagB:34,baselineM:2.4,baselineSource:'external_baseline',
  createdAt:'2026-10-21T03:20:00.000Z',analyzedAt:'2026-10-21T03:22:00.000Z',
  sampleCounts:{observation:30,feedback:180,imu:150,fusion:0},stampRange:{first:1,last:2},
  trials:[left,right,bad],
  aggregate:{validTrials:2,excluded:[{trialId:bad.trialId,reason:'turn_direction_mismatch'}],linearTrials:0,turnTrials:3,turnTrialsMissingRotationTag:0,
   rotationTags:[{tagId:12,label:'Q012',trials:3,validTrials:2}],turnTrialsDirectionMismatch:1,
   forwardScale:null,lateralScale:null,imuYawScale:stats(1.0,0.002,2),wheelYawScale:stats(1.0,0.002,2),
   delayS:null,turnErrorDeg:stats(0.2,0.05,2),targetAngleDeg:stats(90,0,3),measuredAngleDeg:stats(88.63,0.01,2),measuredAngleMagnitudeDeg:stats(88.63,0.01,2),
   visualNetDistance:null,visualBaselineM:null,visualBaselineRatio:null,baselineResidualM:null,
   outliers:{forwardScale:[],imuYawScale:[],turnErrorDeg:[]}},
  limitations:['外部基线只用于独立校核','方向相反已排除出统计'],formulas:['示例公式']};
}
function legacyAnalysis(){
 const trial=linearTrial({});
 // 旧分析结果里没有方向标记字段：页面应说明“未标记”，不能谎称“无”。
 delete (trial as any).directionMismatch;
 return {schemaVersion:2,sessionId:SESSION_ID,mapId:MAP_ID,mapVersion:3,mapDigest:'digest',tagA:12,tagB:34,baselineM:2.4,baselineSource:'external_baseline',
  createdAt:'2026-10-21T03:20:00.000Z',analyzedAt:'2026-10-21T03:22:00.000Z',
  sampleCounts:{observation:10,feedback:60,imu:50,fusion:0},stampRange:{first:1,last:2},
  trials:[trial],aggregate:{forwardScale:stats(0.98,0.001,1),lateralScale:null,imuYawScale:null,wheelYawScale:null,delayS:null,turnErrorDeg:null,visualBaselineM:null,visualBaselineRatio:null},
  limitations:['旧口径限制'],formulas:['旧口径公式']};
}

async function installScenario(page:Page,scenario:Scenario):Promise<MockCtx>{
 const ctx:MockCtx={requests:[],errors:[],trials:scenario.trials.map(trial=>({...trial})),analysis:null,savedAnalysis:true,recordingId:null};
 page.on('pageerror',reason=>ctx.errors.push(reason.message));
 await page.routeWebSocket('**/ws',socket=>socket.send(JSON.stringify({type:'robot',status:robotStatus})));
 const capabilities={nodeRecorder:{supported:true,recording:false,lastSampleAt:'2026-10-21T03:20:11.123Z',lastSampleKind:'observation',error:''},applyEnabled:false,applyReason:''};
 const session={id:SESSION_ID,mapId:MAP_ID,mapVersion:3,mapDigest:'digest',tagA:12,tagB:34,baselineM:2.4,baselineSource:'external_baseline',note:'',created:'2026-10-21T03:19:00.000Z',trials:[],analysis:null,applied:false};
 const stored=()=>ctx.analysis??(ctx.savedAnalysis?scenario.savedAnalysis:null);
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  let body:any=null;try{body=request.postDataJSON();}catch{/* GET */}
  ctx.requests.push({method,path:path+url.search,body});
  const send=(data:any,status=200)=>route.fulfill({status,json:data});
  if(path==='/api/surveys'||path==='/api/tasks'||path==='/api/routes'||path==='/api/boards')return send([]);
  if(path==='/api/camera/status')return send({running:false,present:false});
  if(path==='/api/maps'&&method==='GET')return send([{id:MAP_ID,name:MAP_NAME,version:3,created:'2026-10-20T09:00:00.000Z'}]);
  if(path==='/api/maps/'+MAP_ID&&method==='GET')return send({map:mapBody(3),version:3,acceptance:{accepted:true,digestValid:true,kind:'user_confirmation'}});
  if(path==='/api/calibration/capabilities')return send(capabilities);
  if(path==='/api/calibration/sessions'&&method==='GET')return send({sessions:[{id:SESSION_ID,mapId:MAP_ID,mapVersion:3,mapName:MAP_NAME,tagA:12,tagB:34,baselineM:2.4,note:'',created:session.created,trialCount:ctx.trials.length,analysisSaved:ctx.savedAnalysis||!!ctx.analysis,applied:false}]});
  if(path==='/api/calibration/sessions/'+SESSION_ID&&method==='GET')return send({session:{...session,trials:ctx.trials,analysis:stored()},trials:ctx.trials,sampleCounts:{observation:30,feedback:180,imu:150,fusion:0},recording:{trialId:ctx.recordingId},capabilities});
  if(path==='/api/calibration/sessions/'+SESSION_ID+'/trials'&&method==='POST'){
   const index=ctx.trials.length;
   const trial={id:'trial-new-'+index,sessionId:SESSION_ID,type:body.type,angleDeg:body.angleDeg??null,
    rotationTagId:body.rotationTagId??null,rotationTagLabel:body.rotationTagId?'Q'+String(body.rotationTagId).padStart(3,'0'):null,
    rotationTagPose:null,repetition:ctx.trials.filter(item=>item.type===body.type).length+1,note:body.note??'',
    status:'recording',startedAt:'2026-10-21T03:30:00.000Z',endedAt:null,startedStamp:1,endedStamp:null};
   ctx.trials.push(trial);ctx.recordingId=trial.id;
   return send({trial,recording:{trialId:trial.id}});
  }
  const stop=path.match(/^\/api\/calibration\/trials\/([^/]+)\/(stop|abort)$/);
  if(stop&&method==='POST'){
   const trial=ctx.trials.find(item=>item.id===stop[1]);
   if(!trial)return send({error:'试验不存在'},404);
   trial.status=stop[2]==='stop'?'saved':'aborted';trial.endedAt='2026-10-21T03:31:00.000Z';ctx.recordingId=null;
   return send({trial});
  }
  if(path==='/api/calibration/sessions/'+SESSION_ID+'/analyze'&&method==='POST'){ctx.analysis=scenario.afterAnalyze;ctx.savedAnalysis=false;return send({analysis:ctx.analysis});}
  if(path.startsWith('/api/calibration/'))return send({error:`未 mock 的标定接口 ${method} ${path}`},404);
  return send({error:`未 mock 的接口 ${method} ${path}`},404);
 });
 await page.goto('/');
 await expect(page.getByTestId('global-status')).toBeVisible();
 await page.getByTestId('nav-calibration').click();
 await expect(page.getByTestId('calibration-page')).toBeVisible();
 return ctx;
}

test('旧口径分析可显示不白屏、读取只发 GET；点分析后用新口径显示方向相反与带符号实测角',async({page})=>{
 const ctx=await installScenario(page,{trials:[linearTrial({})],savedAnalysis:legacyAnalysis(),afterAnalyze:v3Analysis()});
 await page.getByTestId('calibration-session-row').first().click();
 await expect(page.getByTestId('analysis-legacy')).toBeVisible();
 await expect(page.getByTestId('analysis-legacy')).toContainText('旧口径');
 await expect(page.getByTestId('analysis-aggregate')).toBeVisible();
 await expect(page.getByTestId('analysis-aggregate')).toContainText('0.9800');
 // 旧分析没有方向标记字段时显示“未标记”，不能显示“无”
 await expect(page.getByTestId('aggregate-mismatch')).toContainText('旧分析未标记');
 // 读已保存的旧分析只有 GET，绝不写库（不触发 analyze/save）
 expect(ctx.requests.filter(item=>item.method!=='GET')).toEqual([]);
 expect(ctx.errors).toEqual([]);

 await page.getByTestId('analyze').click();
 await expect(page.getByTestId('analysis-legacy')).toHaveCount(0);
 await expect(page.getByTestId('aggregate-mismatch')).toContainText('turn_direction_mismatch');
 await expect(page.getByTestId('aggregate-excluded')).toContainText('turn_direction_mismatch');
 await expect(page.getByTestId('aggregate-valid')).toContainText('2 / 3');
 // 左转：目标「左转 90°（逆时针）」+ 实测显式带 + 号
 await expect(page.getByTestId('analysis-trial-trial-left-1')).toContainText('左转 90°（逆时针）');
 await expect(page.getByTestId('analysis-trial-trial-left-1')).toContainText('实测 +88.63°');
 // 右转：目标「右转 90°（顺时针）」+ 实测带负号
 await expect(page.getByTestId('analysis-trial-trial-right-1')).toContainText('右转 90°（顺时针）');
 await expect(page.getByTestId('analysis-trial-trial-right-1')).toContainText('实测 -88.63°');
 // 转反：标记方向相反，且原始数值仍显示
 await expect(page.getByTestId('analysis-trial-trial-right-2')).toContainText('实测 +95.66°');
 await expect(page.getByTestId('trial-mismatch-trial-right-2')).toContainText('方向相反');
 expect(ctx.errors).toEqual([]);
});

test('录制时结束/中止吸顶按钮、列表自动滚到最新、切页后标定设置保留',async({page})=>{
 const existing=Array.from({length:12},(_,index)=>turnTrial({trialId:'trial-old-'+(index+1),type:index%2?'left':'right',repetition:index+1,status:'saved',measuredAngleDeg:index%2?88.6:-88.6}));
 const ctx=await installScenario(page,{trials:existing,savedAnalysis:null,afterAnalyze:v3Analysis()});
 await page.getByTestId('calibration-session-row').first().click();
 // 配置与试验表单都填写一遍，用来验证切页保留
 await page.getByTestId('calibration-tag-a').fill('12');
 await page.getByTestId('calibration-tag-b').fill('34');
 await page.getByTestId('calibration-baseline').fill('2.4');
 await page.getByTestId('trial-type').selectOption('right');
 await page.getByTestId('trial-angle-90').click();
 await page.getByTestId('trial-rotation-tag').selectOption('12');
 await page.getByTestId('trial-note').fill('保留测试');
 await expect(page.getByTestId('calibration-map-select')).toHaveValue(MAP_ID);

 // 切到导航页再回来：KeepAlive 必须保留地图/会话/表单
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.getByTestId('nav-calibration').click();
 await expect(page.getByTestId('calibration-map-select')).toHaveValue(MAP_ID);
 await expect(page.getByTestId('calibration-tag-a')).toHaveValue('12');
 await expect(page.getByTestId('calibration-tag-b')).toHaveValue('34');
 await expect(page.getByTestId('calibration-baseline')).toHaveValue('2.4');
 await expect(page.getByTestId('trial-type')).toHaveValue('right');
 await expect(page.getByTestId('trial-angle-90')).toHaveClass(/active/);
 await expect(page.getByTestId('trial-rotation-tag')).toHaveValue('12');
 await expect(page.getByTestId('trial-note')).toHaveValue('保留测试');
 await expect(page.getByTestId('calibration-current-session')).toContainText('Q012');

 // 开始录制：横幅吸顶显示结束/中止，按钮无需滚动
 await page.getByTestId('start-trial').click();
 await expect(page.getByTestId('recording-banner')).toBeVisible();
 const sticky=await page.getByTestId('recording-banner').evaluate(node=>{const style=getComputedStyle(node);return {position:style.position,top:style.top};});
 expect(sticky.position).toBe('sticky');
 expect(sticky.top).toBe('0px');
 await expect(page.getByTestId('recording-stop')).toBeVisible();
 await expect(page.getByTestId('recording-abort')).toBeVisible();
 expect(await page.getByTestId('recording-stop').evaluate(node=>{const box=node.getBoundingClientRect();return box.top>=0&&box.bottom<=window.innerHeight;})).toBe(true);

 // 列表自动滚到最新：新试验在末尾且可见，容器已滚动
 const listInfo=await page.getByTestId('calibration-trial-list').evaluate(node=>({top:node.scrollTop,client:node.clientHeight,scroll:node.scrollHeight}));
 expect(listInfo.scroll).toBeGreaterThan(listInfo.client);
 expect(listInfo.top).toBeGreaterThan(0);
 const lastRow=page.getByTestId('trial-row-trial-new-12');
 await expect(lastRow).toBeVisible();
 const listBox=await page.getByTestId('calibration-trial-list').boundingBox();
 const rowBox=await lastRow.boundingBox();
 expect(listBox&&rowBox&&rowBox.y>=listBox.y-1&&rowBox.y+rowBox.height<=listBox.y+listBox.height+1).toBe(true);

 await page.getByTestId('recording-stop').click();
 await expect(page.getByTestId('trial-row-trial-new-12')).toContainText('已保存');
 // 只允许试验相关的 POST，绝不出现运动/导航/解锁请求
 const writes=ctx.requests.filter(item=>item.method!=='GET').map(item=>item.path);
 expect(writes.every(path=>path.startsWith('/api/calibration/'))).toBe(true);
 expect(writes.some(path=>path.includes('/navigation/'))).toBe(false);
 expect(ctx.errors).toEqual([]);
});
