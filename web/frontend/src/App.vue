<script setup lang="ts">
import ExecutionErrors from './components/ExecutionErrors.vue';
import UserGuide from './components/UserGuide.vue';
import {computed,onMounted,onBeforeUnmount,ref,watch} from 'vue';
import {ScanLine,Navigation,Play,Pause,Square,CheckCircle2,AlertTriangle,Radio,MapPin,Settings2,FileText,Camera,Ruler,BookOpen,ArrowRight,Route,Layers,Activity,Hand,PenLine} from 'lucide-vue-next';
import Button from './components/ui/Button.vue';
import MapCanvas from './components/MapCanvas.vue';
import PdfGenerator from './components/PdfGenerator.vue';
import ScanRecords from './components/ScanRecords.vue';
import CameraPreview from './components/CameraPreview.vue';
import type {FieldMap,Point} from '../../shared/model';
import {distance,exitPoint} from '../../shared/model';
import {orthogonalRoute,routeCorners,snapRoutePoint,chainRouteGroups,routeGroupCenters,distanceToRoute,type SkippedRouteGroup} from '../../shared/route-design';
import {taskSchema,type Task} from '../../shared/task';
import type {Board} from '../../shared/boards';
import type {SurveySummary} from '../../shared/survey';
import type {Route as RouteEntity} from '../../shared/route';
type ConsolePage='scan'|'navigate'|'print'|'camera'|'guide';
const initialPage=new URLSearchParams(location.search).get('page');
const page=ref<ConsolePage>(initialPage==='camera'?'camera':initialPage==='guide'?'guide':'scan'),busy=ref(false),error=ref(''),message=ref(''),connected=ref(false);
const commandFeedback=ref<{id:string,state:'waiting'|'confirmed'|'rejected'|'unconfirmed',text:string}|null>(null);
let navigationAbort:AbortController|undefined;
const name=ref('办公室扫描'),settings=ref({tagSizeMm:80,rowWidth:.6,exitDistance:.8}),session=ref<any>(null),sessions=ref<SurveySummary[]>([]);
const field=ref<FieldMap|null>(null),version=ref(0),tasks=ref<Task[]>([]),routes=ref<RouteEntity[]>([]),selectedTask=ref(''),selectedMapId=ref(''),selectedRouteId=ref(''),routeNameDraft=ref(''),anchors=ref('[]');
const routeEditId=ref(''),routeEditUpdated=ref('');
const routeDetailsOpen=ref(false);
const mapApproval=ref<{kind:string|null,accepted:boolean,digestValid:boolean}|null>(null);
function selectMap(result:any){field.value=result.map;version.value=result.version;mapApproval.value=result.acceptance??null;}
const userConfirmedMap=computed(()=>mapApproval.value?.accepted===true&&mapApproval.value?.digestValid===true&&(mapApproval.value?.kind==='user_confirmation'||mapApproval.value?.kind==='office_test'));
const boards=ref<Board[]>([]);
const scanView=ref<'map'|'camera'>('map');
const robot=ref<any>({connected:false,state:'OFFLINE',running:false,paused:false,pose:null,chassis:{connected:false},conditions:[],sensors:{},events:[]});
const faultReason=computed(()=>{
 if(robot.value.state!=='FAULT')return '';
 const events:string[]=(robot.value.events??[]).filter((event:unknown):event is string=>typeof event==='string'&&!!event.trim());
 // Events are newest first; the reason is logged after the FAULT transition.
 const transition=events.findIndex(event=>/(?:^|[\s·])FAULT\s*$/.test(event));
 const current=transition<0?events:events.slice(0,transition);
 return current.find(event=>!/^(?:\d{2}:\d{2}:\d{2}\s+)?(?:.*·\s*)?[A-Z][A-Z0-9_]*$/.test(event.trim()))??'尚未收到具体故障原因';
});
const verification=ref({operator:'',measurements:[{id:0,x:'',y:''},{id:1,x:'',y:''},{id:2,x:'',y:''}]});
let socket:WebSocket|undefined,poll:ReturnType<typeof setInterval>|undefined,posePoll:ReturnType<typeof setInterval>|undefined,reconnect:ReturnType<typeof setTimeout>|undefined,closed=false,polling=false;
const poseClock=ref(performance.now()),robotReceivedClock=ref(performance.now());
let sessionEpoch=0;
const previewStatus=ref<any>(null),previewError=ref('');
const bridgeOnline=computed(()=>connected.value&&robot.value.connected);
const previewLabel=computed(()=>previewError.value||(!previewStatus.value?'正在查询预览服务':previewStatus.value.error?'预览异常：'+previewStatus.value.error:previewStatus.value.running?'在线（预览画面）':previewStatus.value.starting?'预览连接中':previewStatus.value.present?'预览未开启':'未发现预览相机'));
const detectorLabel=computed(()=>!bridgeOnline.value?'ROS桥离线 / 识别状态未知':robot.value.detector?.connected?deviceStatus('camera',robot.value.sensors?.camera??'识别服务在线'):robot.value.detector?.reason||'未收到定位识别服务心跳');
function recoveryReason(reason:string){const recovering=/需重启|需轮式横移标定并重新初始化/.test(reason);const text=reason.replace(/，需重启融合/g,'').replace(/，需轮式横移标定并重新初始化/g,'（横移尚未标定）').replace(/融合不可用 \/ 需重启/g,'定位中断 / 等待自动恢复，请保持静止');return recovering&&!text.includes('等待自动恢复')?text+'；等待自动恢复，请保持车辆静止':text;}
const scanWaitReasons=computed(()=>{
 if(!bridgeOnline.value)return ['ROS桥离线，等待连接恢复'];
 const reasons:string[]=[];
 if(!robot.value.detector?.connected)reasons.push(robot.value.detector?.reason||'定位识别服务离线，等待服务恢复');
 else if(!robot.value.detector.positionReady)reasons.push(robot.value.detector.reason||'尚未识别到可定位的定位组，请检查定位板可见性和相机标定');
 const imu=String(robot.value.sensors?.imu??'');if(imu&&!imu.startsWith('在线'))reasons.push(imu);
 if(!robot.value.mapping?.ready){const cause=recoveryReason(robot.value.mapping?.reason||robot.value.sensors?.localization||'等待采集位姿');reasons.push(cause.includes('等待自动恢复')||!cause.includes('定位中断')?cause:cause+'；等待自动恢复，请保持车辆静止');}
 if(originChanged.value&&session.value?.state==='collecting')reasons.push('定位原点已变化，保留当前记录并停止采集');
 if(!reasons.length&&session.value?.state==='collecting'&&!session.value.samples?.length)reasons.push('等待首帧定位观测写入');
 return [...new Set(reasons)];
});
const originChanged=computed(()=>session.value?.samples?.[0]?.localEpoch&&robot.value.mapping?.localEpoch&&session.value.samples[0].localEpoch!==robot.value.mapping.localEpoch);
const label=(id:number)=>'Q'+String(id).padStart(3,'0');
function deviceStatus(key:string,status:string){if(key==='camera'&&status==='最后接入')return '等待定位识别观测';if(key==='odom'&&status==='原底盘反馈在线，横移标定待确认')return '在线 / 待标定';if(key==='imu'&&status==='未接入')return '未收到IMU数据，等待恢复';return recoveryReason(status);}
function selectSession(value:any){sessionEpoch++;session.value=value;name.value=value?.name??'温室示教扫描';anchors.value=JSON.stringify(value?.anchors??[]);}
async function refreshPreview(){try{previewStatus.value=await api('/camera/status');previewError.value='';}catch{previewStatus.value=null;previewError.value='预览服务状态查询失败';}}
async function api(path:string,body?:unknown,method=body===undefined?'GET':'POST',signal?:AbortSignal){const response=await fetch('/api'+path,{method,signal,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const json=await response.json();if(!response.ok)throw new Error(json.error??'请求失败');return json;}
async function act(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';message.value='';try{await fn();}catch(e){error.value=e instanceof Error?e.message:String(e);}finally{busy.value=false;}}
async function refresh(){sessions.value=await api('/surveys');tasks.value=(await api('/tasks')).filter((t:Task)=>t.id.startsWith('task-scan-')||t.routeId);routes.value=await api('/routes');boards.value=await api('/boards');}
async function generated(){await act(async()=>{boards.value=await api('/boards');message.value='定位组已保存';});}
function groupName(id:number){const board=(session.value?.boards??boards.value).find((b:Board)=>b.referenceId===id);return board?.id??label(id);}
async function refreshSurveys(){await act(async()=>{sessions.value=await api('/surveys');});}
async function loadSession(id:string){if(!id)return;await act(async()=>{if(session.value?.state==='collecting')throw new Error('请先停止当前扫描');sessionEpoch++;selectSession(await api('/surveys/'+id));});}
async function removeSession(id:string){await act(async()=>{sessionEpoch++;const result=await api('/surveys/'+id,undefined,'DELETE');if(session.value?.id===id){selectSession(null);}sessions.value=sessions.value.filter(s=>s.id!==id);message.value='已删除扫描：'+result.name;sessions.value=await api('/surveys');});}
async function start(){await act(async()=>{if(!boards.value.length)throw new Error('请先生成多码定位组');selectSession(await api('/survey/start',{name:name.value}));scanView.value='camera';await refresh();message.value=scanWaitReasons.value.length?'扫描已开始，正在等待：'+scanWaitReasons.value.join('；'):'草稿扫描已开始';});}
async function stopSelectedSession(){
 if(!session.value)throw new Error('请先开始扫描');
 const id=session.value.id;
 if(session.value.state==='collecting')await api('/survey/stop',{sessionId:id});
 sessionEpoch++;session.value=await api('/surveys/'+id);
 return session.value;
}
async function savePoints(){await act(async()=>{
 const selected=await stopSelectedSession();
 await api('/survey/draft',{sessionId:selected.id,tagSizeMm:settings.value.tagSizeMm});
 await refresh();message.value='地图点位草稿已保存，原始路径记录已保留';
});}
async function resume(){await act(async()=>{selectSession(await api('/survey/resume',{sessionId:session.value.id}));scanView.value='camera';await refresh();message.value='已继续扫描';});}
async function finish(){await act(async()=>{
 const selected=await stopSelectedSession();
 await api('/survey/draft',{sessionId:selected.id,tagSizeMm:settings.value.tagSizeMm});
 message.value='地图点位草稿已保存';
 await refresh();
 try{
  if(selected.samples.length<3)throw new Error('扫描观测不足3帧');
  const validation=selected.motionValidation;
  if(!validation?.ready)throw new Error([...(validation?.reasons??[]),...(validation?.segments??[]).flatMap((s:any)=>s.reasons)].join('；')||'自动路线缺少有效区间，请检查定位组及档位记录');
  selectSession(await api('/survey/optimize',{sessionId:selected.id,anchors:JSON.parse(anchors.value)}));
  const result=await api('/workflow/finalize',{sessionId:selected.id,name:selected.name+'地图',...settings.value});
  selectMap(result);selectedTask.value=result.task.id;await refresh();page.value='navigate';message.value='地图和任务已保存';
 }catch(e){error.value='地图点位草稿已保存；自动路线未生成：'+(e instanceof Error?e.message:String(e));}
 });}
async function loadTask(){await act(async()=>{const task=tasks.value.find(t=>t.id===selectedTask.value);if(!task){field.value=null;mapApproval.value=null;return;}selectedMapId.value=task.mapId;selectedRouteId.value=task.routeId??routes.value.find(route=>route.mapId===task.mapId&&route.mapVersion===task.mapVersion&&route.routeId.startsWith('legacy-'))?.routeId??'';const result=task.routeId?await api('/routes/'+task.routeId):await api('/maps/'+task.mapId);selectMap(result);const route=routes.value.find(item=>item.routeId===selectedRouteId.value);routeNameDraft.value=route?.name??field.value?.rows[0]?.name??field.value?.name??'';});}
const availableMaps=computed(()=>[...new Map(tasks.value.map(task=>[task.mapId,{id:task.mapId,name:field.value?.id===task.mapId?field.value.name:task.mapId}])).values()]);
const availableRoutes=computed(()=>routes.value.filter(route=>!selectedMapId.value||route.mapId===selectedMapId.value));
function taskForRoute(route:RouteEntity){return tasks.value.find(item=>item.routeId===route.routeId)??(route.routeId.startsWith('legacy-')?tasks.value.find(item=>!item.routeId&&item.mapId===route.mapId&&item.mapVersion===route.mapVersion):undefined);}
function chooseMap(){const route=availableRoutes.value[0];const task=route?taskForRoute(route):tasks.value.find(item=>item.mapId===selectedMapId.value);selectedRouteId.value=route?.routeId??'';selectedTask.value=task?.id??'';if(task)void loadTask();}
function chooseRoute(){const route=routes.value.find(item=>item.routeId===selectedRouteId.value);const task=route?taskForRoute(route):tasks.value.find(item=>item.mapId===selectedMapId.value);selectedTask.value=task?.id??'';routeNameDraft.value=route?.name??'';if(task)void loadTask();}

async function accept(){await act(async()=>{
 if(!field.value)throw new Error('请先选择扫描地图');
 if(verification.value.measurements.some(m=>m.x.trim()===''||m.y.trim()===''))throw new Error('请填写实际测量坐标');
 const result=await api('/maps/accept',{mapId:field.value.id,version:version.value,operator:verification.value.operator,measurements:verification.value.measurements.map(m=>({id:Number(m.id),x:Number(m.x),y:Number(m.y)}))});
 selectMap(await api('/maps/'+field.value.id));
 const task=tasks.value.find(t=>t.id===selectedTask.value);if(task)await api('/tasks',{...task,mapVersion:version.value});await refresh();message.value='坐标已确认';
 });}
const speedSettings=ref({forwardSpeed:8,reverseSpeed:6,lateralSpeed:5});
const selectedNavigationTask=computed(()=>tasks.value.find(t=>t.id===selectedTask.value));
const speedFields=[{key:'forwardSpeed',label:'前进',max:20},{key:'reverseSpeed',label:'倒车',max:15},{key:'lateralSpeed',label:'平移',max:10}] as const;
watch(selectedNavigationTask,(task,previous)=>{if(task&&previous&&task.id===previous.id&&speedFields.every(({key})=>task[key]===previous[key]))return;if(task)speedSettings.value={forwardSpeed:Math.round(task.forwardSpeed*10000)/100,reverseSpeed:Math.round(task.reverseSpeed*10000)/100,lateralSpeed:Math.round(task.lateralSpeed*10000)/100};},{immediate:true});
const speedDirty=computed(()=>!!selectedNavigationTask.value&&speedFields.some(({key})=>Math.abs(Number(speedSettings.value[key])/100-selectedNavigationTask.value![key])>1e-8||!Number.isFinite(Number(speedSettings.value[key]))));
async function saveSpeeds(){await act(async()=>{
 const task=selectedNavigationTask.value;if(!task)throw new Error('请先选择导航地图');
 if(robot.value.running||commandFeedback.value?.state==='waiting')throw new Error('请在停止导航后调整速度');
 const values=Object.fromEntries(speedFields.map(({key})=>[key,Number(speedSettings.value[key])/100]));
 const checked=taskSchema.pick({forwardSpeed:true,reverseSpeed:true,lateralSpeed:true}).safeParse(values);
 if(!checked.success)throw new Error('速度范围：前进 2–20、倒车 2–15、平移 2–10 厘米/秒');
 await api('/tasks/'+encodeURIComponent(task.id)+'/speeds',checked.data);await refresh();
 message.value='速度已保存，下次启动导航生效';
});}
const returnToStart=computed(()=>tasks.value.find(t=>t.id===selectedTask.value)?.returnToStart===true);
async function toggleReturnToStart(){await act(async()=>{
 const task=tasks.value.find(t=>t.id===selectedTask.value);if(!task)throw new Error('请先选择导航地图');
 if(robot.value.running)throw new Error('请在任务结束后设置返回方式');
 await api('/tasks',{...task,returnToStart:!returnToStart.value});await refresh();
 message.value=returnToStart.value?'已开启：导航完成后原路倒车返回起点':'已关闭：导航到终点停车';
});}
async function navigation(command:string){
 if(command==='start'&&(busy.value||commandFeedback.value?.state==='waiting'))return;
 navigationAbort?.abort();
 const controller=new AbortController();navigationAbort=controller;
 error.value='';message.value='';
 commandFeedback.value={id:'',state:'waiting',text:'正在提交指令，等待机器人回执…'};
 const timeout=setTimeout(()=>controller.abort(),6000);let commandId='';
 try{
  const result=await api('/navigation/'+command,command==='start'?{taskId:selectedTask.value}:{},'POST',controller.signal);
  if(navigationAbort!==controller||closed)return;
  if(controller.signal.aborted)throw new Error('指令请求超时');
  if(result.accepted!==true||typeof result.commandId!=='string'||!result.commandId)throw new Error(result.state||'未返回命令编号，指令未确认');
  commandId=result.commandId;
  commandFeedback.value={id:commandId,state:'waiting',text:'指令已提交，等待机器人回执…'};
  while(!controller.signal.aborted){
   try{
    const receipt=await api('/robot/commands/'+encodeURIComponent(commandId),undefined,'GET',controller.signal);
    if(!controller.signal.aborted&&receipt.id===commandId&&typeof receipt.ok==='boolean'){
     commandFeedback.value={id:commandId,state:receipt.ok?'confirmed':'rejected',text:receipt.ok?'机器人已确认接收'+(receipt.message?'：'+receipt.message:''):'指令被拒绝（REJECTED）：'+(receipt.message||'机器人未提供原因')};
     return;
    }
   }catch{/* Only result lookups may retry; never resubmit a navigation command. */}
   if(!controller.signal.aborted)await new Promise<void>(resolve=>{
    const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);resolve();};
    const timer=setTimeout(finish,200);controller.signal.addEventListener('abort',finish,{once:true});
   });
  }
  if(navigationAbort===controller&&!closed)commandFeedback.value={id:commandId,state:'unconfirmed',text:'指令未确认：6 秒内未收到机器人回执，请检查车辆状态。'};
 }catch(e){
  if(navigationAbort!==controller||closed)return;
  if(controller.signal.aborted)commandFeedback.value={id:commandId,state:'unconfirmed',text:'指令未确认：6 秒内未收到机器人回执，请检查车辆状态。'};
  else{commandFeedback.value=null;error.value=e instanceof Error?e.message:String(e);}
 }finally{clearTimeout(timeout);if(navigationAbort===controller)navigationAbort=undefined;}
}
const scanPreview=computed<FieldMap|null>(()=>{
 if(!session.value?.samples?.length)return null;
 const optimized=session.value.result;
 const estimates=new Map<number,{x:number,y:number,angle:number,count:number}>();
 for(const sample of session.value.samples){const c=Math.cos(sample.pose.yaw),s=Math.sin(sample.pose.yaw);for(const tag of sample.tags){const x=sample.pose.x+c*tag.x-s*tag.y,y=sample.pose.y+s*tag.x+c*tag.y,angle=(sample.pose.yaw+tag.angle)*180/Math.PI;const prev=estimates.get(tag.id);if(prev){prev.x+=x;prev.y+=y;prev.count++;}else estimates.set(tag.id,{x,y,angle,count:1});}}
 const layouts:Board[]=session.value.boards??[];const tagProperties=(id:number)=>{const b=layouts.find(g=>g.referenceId===id);return b?{groupId:b.id,size:b.sizeMm/1000}:{size:settings.value.tagSizeMm/1000};};
 const tags=optimized?optimized.tags.map((t:any)=>({...t,...tagProperties(t.id),rowId:'',kind:'waypoint',rules:[]})):[...estimates.entries()].map(([id,t])=>({id,x:t.x/t.count,y:t.y/t.count,angle:t.angle,...tagProperties(id),rowId:'',kind:'waypoint',rules:[]}));
 return {schemaVersion:1,id:session.value.id,name:session.value.name,frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',rows:[],tags,groups:layouts,order:[],zone:[],vehicle:{width:.4,length:.8,margin:.05},notes:'扫描观测预览，坐标仍待校准。'} as FieldMap;
});
const trail=computed<Point[]>(()=>session.value?.result?.poses?session.value.result.poses.map((p:number[])=>({x:p[0],y:p[1]})):session.value?.samples?.map((s:any)=>({x:s.pose.x,y:s.pose.y}))??[]);
const map=computed(()=>page.value==='scan'?scanPreview.value:field.value);
function matchingMapPose(status:any,mapId:string,nowMs:number,receivedMs=nowMs){
 const pose=status.pose,localization=status.localization;
 if(!status.connected||!mapId||!pose||!localization||localization.mapId!==mapId||localization.poseAvailable!==true||localization.absoluteHeading!==true)return null;
 // The server and ROS share a clock; the browser may have a different wall clock.
 // Preserve the 250 ms observation limit and expire stalled browser updates locally.
 const serverNowMs=status.serverTimeMs??nowMs;
 const ageMs=serverNowMs-localization.stamp*1000+(nowMs-receivedMs);
 if(![pose.x,pose.y,pose.yaw,localization.stamp,serverNowMs,nowMs,receivedMs].every(v=>typeof v==='number'&&Number.isFinite(v))||!(0<=ageMs&&ageMs<=250))return null;
 const isStatic=localization.state==='STATIC_ANCHORED'&&localization.source==='stationary_qr'&&localization.stationary===true&&localization.navigationReady===false&&localization.captureTimestampVerified===false;
 const isFormal=localization.state==='FORMAL'&&localization.source==='synchronized_qr';
 const isSynchronizedPreview=localization.state==='LOCAL_ONLY'&&localization.source==='synchronized_qr'&&localization.captureTimestampVerified===true;
 if(!isStatic&&!isFormal&&!isSynchronizedPreview)return null;
 return {...pose,headingDeg:((pose.yaw*180/Math.PI+180)%360+360)%360-180,isStatic,sourceLabel:isStatic?'静止二维码定位':isFormal?(localization.approvalBasis==='user_confirmation'?'同步二维码融合定位':'正式二维码融合定位'):'同步二维码位姿'};
}
const displayedPose=computed(()=>page.value==='navigate'&&bridgeOnline.value?matchingMapPose(robot.value,field.value?.id??'',poseClock.value,robotReceivedClock.value):null);
const measuring=ref(false),measureFrom=ref<number|''>(''),measureTo=ref<number|''>('');
const measurementIds=computed(()=>[measureFrom.value,measureTo.value].filter((id):id is number=>typeof id==='number'));
const centerDistance=computed(()=>{
 if(measureFrom.value===''||measureTo.value===''||measureFrom.value===measureTo.value)return null;
 const a=map.value?.tags.find(t=>t.id===measureFrom.value),b=map.value?.tags.find(t=>t.id===measureTo.value);
 return a&&b?Math.hypot(b.x-a.x,b.y-a.y):null;
});
function measureLabel(tag:FieldMap['tags'][number]){return tag.groupId??'Q'+String(tag.id).padStart(3,'0');}
function clearMeasurement(){measureFrom.value='';measureTo.value='';}
function toggleMeasurement(){measuring.value=!measuring.value;clearMeasurement();if(measuring.value&&page.value==='scan')scanView.value='map';}
function measureSelect(id:number){
 if(!measuring.value)return;
 if(measureFrom.value===''||measureTo.value!==''){measureFrom.value=id;measureTo.value='';}
 else if(id!==measureFrom.value)measureTo.value=id;
}
watch([()=>page.value,()=>map.value?.id],()=>{measuring.value=false;clearMeasurement();});
watch(()=>map.value?.tags.map(t=>t.id),ids=>{
 if(measureFrom.value!==''&&!ids?.includes(measureFrom.value))measureFrom.value='';
 if(measureTo.value!==''&&!ids?.includes(measureTo.value))measureTo.value='';
});
const editingRoute=ref(false),routeAnchors=ref<Point[]>([]),routeSelected=ref(-1),bodyYawDeg=ref(0),routeTool=ref<'draw'|'pan'>('draw');
const routeHistory=ref<Point[][]>([]),routeSkippedHold=ref<SkippedRouteGroup[]>([]);
const routeDrawing=computed(()=>orthogonalRoute(routeAnchors.value));
const routeChain=computed(()=>chainRouteGroups(routeDrawing.value,field.value?routeGroupCenters(field.value):[]));
const routeGroupIds=computed(()=>[...new Set(routeChain.value.nodes.map(node=>node.id))]);
const routeSkipped=computed(()=>{
 const byId=new Map([...routeSkippedHold.value,...routeChain.value.skipped].map(tag=>[tag.id,tag]));
 return [...byId.values()].filter(tag=>!routeGroupIds.value.includes(tag.id)).map(tag=>({...tag,distanceM:distanceToRoute(tag,routeDrawing.value)}));
});
const routeLength=computed(()=>routeDrawing.value.slice(1).reduce((sum,p,i)=>sum+distance(routeDrawing.value[i]!,p),0));
const routeLocked=computed(()=>busy.value||robot.value.running||commandFeedback.value?.state==='waiting');
function rememberRoute(){routeSkippedHold.value=[];routeHistory.value=[...routeHistory.value.slice(-99),routeAnchors.value.map(p=>({...p}))];}
function beginRoute(){
 if(!field.value||routeLocked.value)return;
 routeDetailsOpen.value=false;
 routeTool.value='draw';measuring.value=false;clearMeasurement();routeSelected.value=-1;routeHistory.value=[];routeSkippedHold.value=[];
 const selectedRoute=routes.value.find(route=>route.routeId===selectedRouteId.value);routeEditId.value=selectedRoute?.routeId??'';routeEditUpdated.value=selectedRoute?.updated??'';const row=field.value.rows[0],points=selectedRoute?.points??(row?[exitPoint(row),...row.points]:[]);routeNameDraft.value=selectedRoute?.name??row?.name??field.value.name;
 const orthogonal=points.every((p,i)=>!i||Math.abs(p.x-points[i-1]!.x)<1e-8||Math.abs(p.y-points[i-1]!.y)<1e-8);
 routeAnchors.value=orthogonal?routeCorners(points):[];
 bodyYawDeg.value=Math.round((field.value.motionSegments?.[0]?.bodyYaw??0)*180/Math.PI*100)/100;
 editingRoute.value=true;error.value='';message.value=orthogonal?'可拖动路点调整路径，或单击地图追加路点':'单击地图设计新路径；原示教路线保留至保存成功';
}
function beginNewRoute(){
 if(!field.value||routeLocked.value)return;
 routeDetailsOpen.value=false;
 routeTool.value='draw';measuring.value=false;clearMeasurement();routeSelected.value=-1;routeHistory.value=[];routeSkippedHold.value=[];routeEditId.value='';routeEditUpdated.value='';routeAnchors.value=[];bodyYawDeg.value=0;routeNameDraft.value=field.value.name+'新路径';editingRoute.value=true;error.value='';message.value='新建路径：点击地图追加路点，完成后保存';
}
function autoChainRoute(){
 if(!editingRoute.value||routeLocked.value)return;
 const chain=routeChain.value;
 if(chain.problem){error.value=chain.problem;return;}
 if(new Set(chain.nodes.map(node=>node.id)).size<2){error.value='可用定位组不足两个，请沿码连线绘制路径';return;}
 if(chain.points.length>501){error.value='自动串码后的控制点超过501个，请拆分路线';return;}
 const skipped=routeSkipped.value;rememberRoute();routeAnchors.value=chain.points.map(point=>({...point}));routeSkippedHold.value=skipped;routeSelected.value=-1;error.value='';
 message.value=`已自动串起 ${new Set(chain.nodes.map(node=>node.id)).size} 个定位组 · 每到下一码纠正一次 · 跳过 ${routeSkipped.value.length} 个偏离码`;
}
function appendRoute(point:Point){
 if(!editingRoute.value||!field.value||routeLocked.value)return;
 const p=snapRoutePoint(point,field.value.tags);
 if(routeAnchors.value.length&&distance(routeAnchors.value.at(-1)!,p)<.001)return;
 if(routeDrawing.value.length>=499){error.value='路径控制点过多，请先删除部分路点';return;}
 rememberRoute();routeAnchors.value=[...routeAnchors.value,p];routeSelected.value=routeAnchors.value.length-1;
}
function moveRoute(index:number,point:Point){
 if(!editingRoute.value||routeLocked.value||!field.value)return;
 const p=snapRoutePoint(point,field.value.tags);
 if(!routeAnchors.value[index]||distance(routeAnchors.value[index]!,p)<1e-8)return;
 rememberRoute();routeAnchors.value=routeAnchors.value.map((old,i)=>i===index?p:old);routeSelected.value=index;
}
function deleteRoute(){if(routeLocked.value||routeSelected.value<0)return;rememberRoute();routeAnchors.value=routeAnchors.value.filter((_,i)=>i!==routeSelected.value);routeSelected.value=-1;}
function undoRoute(){if(routeLocked.value)return;routeSkippedHold.value=[];const previous=routeHistory.value.at(-1);if(!previous)return;routeAnchors.value=previous;routeHistory.value=routeHistory.value.slice(0,-1);routeSelected.value=-1;}
function clearRoute(){if(routeLocked.value||!routeAnchors.value.length)return;rememberRoute();routeAnchors.value=[];routeSelected.value=-1;}
function blockNumericWheel(event:WheelEvent){if(event.target instanceof HTMLInputElement&&event.target.type==='number')event.preventDefault();}
function routeKey(event:KeyboardEvent){
 if(!editingRoute.value||routeLocked.value||event.target instanceof HTMLElement&&(event.target.matches('input,textarea,select')||event.target.isContentEditable))return;
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();undoRoute();}
 else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();deleteRoute();}
}
async function deleteNamedRoute(){const route=routes.value.find(item=>item.routeId===selectedRouteId.value);if(!route||!window.confirm(`确认删除路径“${route.name}”？`))return;await act(async()=>{await api('/routes/'+encodeURIComponent(route.routeId),undefined,'DELETE');await refresh();selectedRouteId.value=routes.value.find(item=>item.mapId===selectedMapId.value)?.routeId??'';chooseRoute();message.value='路径已删除';});}
async function saveRoute(saveAs=false){await act(async()=>{
 if(!field.value||!editingRoute.value)return;
 const skippedCount=routeSkipped.value.length;const payload:any={mapId:field.value.id,baseVersion:version.value,points:routeDrawing.value,bodyYawDeg:bodyYawDeg.value,routeName:routeNameDraft.value.trim()||field.value.name};if(routeEditId.value){payload.routeId=routeEditId.value;payload.routeUpdated=routeEditUpdated.value;}if(saveAs)payload.saveAs=true;
 const result=await api('/route/design',payload);selectMap(result);await refresh();selectedRouteId.value=result.route?.routeId??'';selectedTask.value=result.task?.id??selectedTask.value;selectedMapId.value=field.value.id;editingRoute.value=false;
 const trim=result.trimmed.startM+result.trimmed.endM;message.value=`路径已保存 · 经过 ${new Set(result.map.motionSegments.flatMap((s:any)=>[s.fromId,s.toId])).size} 个定位组 · 每到下一码纠正一次 · 跳过 ${Math.max(skippedCount,result.routeGroups?.skipped.length??0)} 个偏离码`+(trim>.001?` · 已截去定位组外 ${trim.toFixed(2)} m`:'');
 });}

watch([()=>page.value,()=>field.value?.id],()=>{editingRoute.value=false;routeSelected.value=-1;});
onMounted(()=>{window.addEventListener('keydown',routeKey);window.addEventListener('wheel',blockNumericWheel,{passive:false});});
onBeforeUnmount(()=>{window.removeEventListener('keydown',routeKey);window.removeEventListener('wheel',blockNumericWheel);});
const canNavigate=computed(()=>{if(editingRoute.value||speedDirty.value)return false;const task=tasks.value.find(t=>t.id===selectedTask.value);return !!task&&task.mapId===field.value?.id&&task.mapVersion===version.value&&mapApproval.value?.accepted===true&&mapApproval.value?.digestValid===true&&field.value?.coordinateStatus==='reviewed'&&(field.value?.captureQuality!=='draft'||userConfirmedMap.value)&&robot.value.connected&&(field.value?.routeMode!=='waypoints'||(robot.value.localization?.mapId===field.value.id&&robot.value.localization?.mapVersion===version.value))&&!robot.value.running&&robot.value.conditions.length>0&&robot.value.conditions.every((c:any)=>c.ready);});
watch([()=>field.value?.id,()=>version.value,()=>mapApproval.value?.accepted,()=>robot.value.connected],()=>{
 if(!field.value||!mapApproval.value?.accepted||!robot.value.connected||robot.value.running)return;
 void api('/localization/map',{mapId:field.value.id,version:version.value}).catch(error=>{message.value=String(error.message??error);});
});
const pendingConditions=computed(()=>robot.value.conditions.filter((condition:any)=>!condition.ready));
const diagnosticsSummary=computed(()=>!robot.value.connected?'设备离线':!robot.value.conditions.length?'等待设备状态':pendingConditions.value.length?`${pendingConditions.value.length} 项待恢复`:'设备正常');
const navigationBlockReason=computed(()=>{
 if(robot.value.running||canNavigate.value)return '';
 if(editingRoute.value)return '请保存路径或退出编辑后再开始导航';
 const task=tasks.value.find(t=>t.id===selectedTask.value);
 if(!task)return '请选择导航地图';
 if(speedDirty.value)return '请先保存速度设置';
 if(task.mapId!==field.value?.id||task.mapVersion!==version.value)return '所选任务与当前地图不一致，请重新选择';
 if(field.value?.coordinateStatus!=='reviewed'||mapApproval.value?.accepted!==true||mapApproval.value?.digestValid!==true)return '请先确认导航地图与组中心坐标';
 if(field.value?.captureQuality==='draft'&&!userConfirmedMap.value)return '请先生成并确认导航地图';
 if(!robot.value.connected)return '等待导航服务连接';
 if(field.value?.routeMode==='waypoints'&&(robot.value.localization?.mapId!==field.value.id||robot.value.localization?.mapVersion!==version.value))return '正在同步所选办公室定位地图';
 if(!robot.value.conditions.length)return '等待设备状态';
 const labels=pendingConditions.value.map((condition:any)=>String(condition.label));
 return labels.length?`等待${labels.slice(0,2).join('、')}${labels.length>2?`等 ${labels.length} 项恢复`:''}`:'';
});
function connect(){if(closed)return;socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);socket.onopen=()=>connected.value=true;socket.onmessage=e=>{const data=JSON.parse(e.data);if(data.type==='robot'){robotReceivedClock.value=performance.now();poseClock.value=robotReceivedClock.value;robot.value=data.status;}};socket.onclose=()=>{connected.value=false;if(!closed)reconnect=setTimeout(connect,2000);};}
async function pollSession(){
 if(polling||busy.value||!session.value||page.value!=='scan')return;
 polling=true;const id=session.value.id,epoch=sessionEpoch,wasCollecting=session.value.state==='collecting';
 const stillSelected=()=>!closed&&!busy.value&&sessionEpoch===epoch&&session.value?.id===id&&page.value==='scan';
 try{
  const result=await api('/surveys/'+id);if(!stillSelected())return;
  if(wasCollecting&&result.state==='stopped'){
   const records:SurveySummary[]=await api('/surveys');if(!stillSelected())return;
   sessions.value=records;
   if(result.stop_reason)error.value=result.stop_reason;
   else message.value='本次扫描已保存，路径和定位组已保留';
  }
  session.value=result;
 }catch{/* Leave a collecting selection intact so a failed continuation lookup can retry. */}
 finally{polling=false;}
}
const pageContent:Record<ConsolePage,{title:string;description:string}>={
 scan:{title:'扫描建图',description:'采集定位组与示教轨迹，建立现场导航地图。'},
 navigate:{title:'导航监控',description:'设计路径、确认任务，掌握每一次作业进度。'},
 print:{title:'二维码 PDF',description:'生成尺寸准确的定位板，为现场铺设做好准备。'},
 camera:{title:'摄像头预览',description:'检查定位画面，管理相机标定与安装参数。'},
 guide:{title:'使用指南',description:'从定位板铺设到自主导航，按步骤完成首次作业。'}
};
const workflowStep=computed(()=>page.value==='scan'?(session.value?3:boards.value.length?2:1):editingRoute.value||!field.value||!mapApproval.value?.accepted?4:5);
const robotStateLabels:Record<string,string>={OFFLINE:'未连接',IDLE:'待命',INITIALIZING:'准备中',SEGMENT_ALIGN:'档位与轮角确认',FORWARD:'前进中',REVERSE:'倒车中',LATERAL_SHIFT:'平移中',ROW_END:'到点停车',ROW_EXIT:'退出区间',SWITCH_TO_LATERAL:'切换平移',SWITCH_TO_ACKERMANN:'恢复行驶模式',NEXT_ROW:'准备下一段',FINISHED:'任务完成',FAULT:'故障待处理'};
const robotStateLabel=computed(()=>!bridgeOnline.value?'未连接':robot.value.paused?'已暂停':robotStateLabels[robot.value.state]??'状态更新中');
const currentStepLabel=computed(()=>['打印二维码','铺设','扫描建图','编辑路径','开始导航'][workflowStep.value-1]);
const overviewGroupCount=computed(()=>page.value==='scan'?(scanPreview.value?.tags.length??Object.keys(session.value?.counts??{}).length):(field.value?.tags.length??0));
const overviewLength=computed(()=>{
 const points=page.value==='scan'?trail.value:editingRoute.value?routeDrawing.value:field.value?.rows.flatMap(row=>[exitPoint(row),...row.points])??[];
 return points.slice(1).reduce((sum,p,i)=>sum+distance(points[i]!,p),0);
});
const overviewVersion=computed(()=>page.value==='navigate'&&field.value?`v${version.value}`:page.value==='scan'&&session.value?.mapId&&session.value.mapId===field.value?.id?`v${version.value}`:'—');
function openConsolePage(next:ConsolePage){page.value=next;}
onMounted(()=>{connect();void refreshPreview();void act(async()=>{await refresh();const current=sessions.value.find(s=>s.state==='collecting');if(current){selectSession(await api('/surveys/'+current.id));scanView.value='camera';}else if(sessions.value[0]){selectSession(await api('/surveys/'+sessions.value[0].id));}if(tasks.value.length){const first=tasks.value[0]!;selectedTask.value=first.id;selectedMapId.value=first.mapId;selectedRouteId.value=first.routeId??'';const result=first.routeId?await api('/routes/'+first.routeId):await api('/maps/'+first.mapId);selectMap(result);routeNameDraft.value=first.routeId?(routes.value.find(route=>route.routeId===first.routeId)?.name??''):field.value?.rows[0]?.name??field.value?.name??'';}});poll=setInterval(()=>{void refreshPreview();void pollSession();},2000);});
onMounted(()=>{posePoll=setInterval(()=>poseClock.value=performance.now(),100);});
onBeforeUnmount(()=>{closed=true;navigationAbort?.abort();clearInterval(poll);clearInterval(posePoll);clearTimeout(reconnect);socket?.close();});
</script>
<template>
 <div :class="['app-shell',{'is-route-editing':editingRoute}]">
  <aside class="sidebar"><div class="brand"><span class="brand-icon" aria-hidden="true"><i/><i/><i/><i/></span><div><strong>QR 导航控制台</strong><small>v1.0.0</small></div></div>
   <nav aria-label="主导航"><span class="nav-group-label">作业</span><button :class="['nav-item',{active:page==='scan'}]" :aria-current="page==='scan'?'page':undefined" title="扫描建图" @click="page='scan'"><ScanLine :size="19"/>扫描建图</button><button :class="['nav-item',{active:page==='navigate'}]" :aria-current="page==='navigate'?'page':undefined" title="开始导航" @click="page='navigate'"><Navigation :size="19"/>开始导航</button><span class="nav-group-label">资源</span><button :class="['nav-item',{active:page==='print'}]" :aria-current="page==='print'?'page':undefined" title="二维码 PDF" @click="page='print'"><FileText :size="19"/>二维码 PDF</button><button :class="['nav-item',{active:page==='camera'}]" :aria-current="page==='camera'?'page':undefined" title="摄像头预览" @click="page='camera'"><Camera :size="19"/>摄像头预览</button><button :class="['nav-item',{active:page==='guide'}]" :aria-current="page==='guide'?'page':undefined" title="使用指南" @click="page='guide'"><BookOpen :size="19"/>使用指南</button></nav>
   <div class="sidebar-bottom"><span :class="['connection-dot',{online:connected}]"/><div>{{connected?'网页服务在线':'服务正在重连'}}<small>QR Navigation · v1.0.0</small></div></div>
  </aside>
  <main class="workspace">
   <header class="topbar"><div class="page-heading"><h1>{{pageContent[page].title}}<span v-if="page==='scan'||page==='navigate'" class="badge">{{page==='scan'?(session?.state==='collecting'?'扫描中':'待扫描'):field?.coordinateStatus==='reviewed'?'已确认':'待确认'}}</span></h1><p>{{pageContent[page].description}}</p></div><div class="global-status" data-testid="global-status" aria-label="全局状态"><span :class="['status-badge',connected?'success':'warning']"><i/>网页服务 · {{connected?'在线':'重连中'}}</span><span :class="['status-badge',bridgeOnline?'success':'neutral']"><i/>机器人 · {{bridgeOnline?'已连接':'未连接'}}</span><span class="global-task" :title="selectedNavigationTask?.name??'未选择任务'">{{selectedNavigationTask?.name??'未选择任务'}}</span></div></header>
   <div v-if="error&&page!=='print'&&!editingRoute" class="scan-alert" role="alert"><AlertTriangle :size="20"/>{{error}}</div><div v-if="message&&page!=='print'&&!editingRoute" class="message" role="status"><CheckCircle2 :size="20"/>{{message}}</div>
   <div v-if="commandFeedback&&page==='navigate'" :class="commandFeedback.state==='confirmed'?'message':commandFeedback.state==='waiting'?'scan-detector-status':'scan-alert'" :role="commandFeedback.state==='rejected'||commandFeedback.state==='unconfirmed'?'alert':'status'" data-testid="command-feedback" :data-command-id="commandFeedback.id" :data-state="commandFeedback.state"><CheckCircle2 v-if="commandFeedback.state==='confirmed'" :size="20"/><Radio v-else-if="commandFeedback.state==='waiting'" :size="20"/><AlertTriangle v-else :size="20"/>{{commandFeedback.text}}</div>
   <div v-if="(page==='scan'||page==='navigate')&&!editingRoute" class="overview-stats" data-testid="overview-stats"><div class="stat-card"><span class="stat-icon"><Layers :size="19"/></span><div><span>定位组数</span><strong>{{overviewGroupCount}} <small>组</small></strong></div><small class="stat-note">{{page==='scan'?'本次采集':'当前地图'}}</small></div><div class="stat-card"><span class="stat-icon"><Route :size="19"/></span><div><span>{{page==='scan'?'采集轨迹长度':'路线长度'}}</span><strong>{{overviewLength.toFixed(2)}} <small>m</small></strong></div><small class="stat-note">{{editingRoute?'编辑预览':page==='scan'?'已记录轨迹':'规划路径'}}</small></div></div>
   <UserGuide v-if="page==='guide'" @navigate="openConsolePage"/>
   <CameraPreview v-else-if="page==='camera'"/>
   <PdfGenerator v-else-if="page==='print'" @generated="generated"/>
   <div v-else class="editor-body">
    <section class="left-panel" v-if="page==='scan'">
     <div class="panel-title"><ScanLine :size="18"/>扫描控制</div>
     <label>扫描名称<input v-model="name" :disabled="busy||session?.state==='collecting'"/></label>
     <Button class="w-full mt-4" :disabled="busy||session?.state==='collecting'" @click="start"><ScanLine :size="20"/>开始扫描</Button>
     <Button class="w-full mt-2" variant="outline" :disabled="busy||!session" @click="finish"><CheckCircle2 :size="18"/>{{busy?'正在处理…':session?.state==='collecting'?'完成扫描并生成地图':'整理记录并生成地图'}}</Button>
     <Button class="w-full mt-2" variant="outline" :disabled="busy||!session?.samples?.length" @click="savePoints">保存点位草稿</Button>
     <Button v-if="session?.state==='stopped'" class="w-full mt-2" variant="outline" :disabled="busy||originChanged" @click="resume">继续补扫此记录</Button>
     <div class="state-card"><span>{{session?.state==='collecting'?(scanWaitReasons.length?'等待扫描数据':'正在扫描'):session?'扫描已保存':'未开始'}}</span><strong>{{session?.state==='collecting'?'正在记录':session?'采集已保存':'准备开始'}}</strong><small>{{session?.samples?.length??0}} 帧{{session?.captureQuality==='draft'?'草稿':'同步'}}观测</small><small v-if="session?.state==='collecting'&&scanWaitReasons.length" class="scan-wait" role="status">等待：{{scanWaitReasons.join('；')}}。条件恢复后将自动采集。</small></div>
     <ScanRecords :records="sessions" :selected-id="session?.id" :busy="busy" :selection-disabled="session?.state==='collecting'" :error="error" @select="loadSession" @delete="removeSession" @refresh="refreshSurveys"/>
     <details class="scan-details"><summary><Settings2 :size="18"/>参数设置</summary><div class="section-label">已注册定位组 · {{boards.length}}</div><div v-for="b in boards" :key="b.id" class="readiness-line">{{b.id}} · {{b.gridSize}}×{{b.gridSize}} · {{b.sizeMm}} mm</div><label>通道净宽 / m<input v-model.number="settings.rowWidth" type="number" min="0.41" step="0.01"/></label><label>入口距离 / m<input v-model.number="settings.exitDistance" type="number" min="0.5" step="0.1"/></label><label>组中心基准点 JSON<textarea v-model="anchors" placeholder='[{"id":0,"x":0,"y":0},{"id":4,"x":2,"y":0}]'/></label></details>
     
    </section>
    <section v-else-if="page==='navigate'&&!editingRoute" class="left-panel navigation-panel"><div class="navigation-settings"><div class="panel-title"><Navigation :size="18"/>导航控制</div><label>导航地图<select v-model="selectedMapId" :disabled="busy||robot.running||editingRoute" data-testid="map-select" @change="chooseMap"><option value="">选择扫描地图</option><option v-for="mapOption in availableMaps" :key="mapOption.id" :value="mapOption.id">{{mapOption.name}}</option></select></label><label>执行路径<select v-model="selectedRouteId" :disabled="busy||robot.running||editingRoute" data-testid="route-select" @change="chooseRoute"><option value="">选择路径</option><option v-for="route in availableRoutes" :key="route.routeId" :value="route.routeId">{{route.name}}</option></select></label>
     <Button size="sm" variant="outline" data-testid="new-route" :disabled="routeLocked||!field" @click="beginNewRoute"><PenLine :size="15"/>新建路径</Button>
     <div class="state-card"><span>车辆状态</span><strong>{{robotStateLabel}}</strong><small>{{robot.rowId||'等待任务'}}</small></div>
     <div v-if="robot.state==='FAULT'" class="scan-alert fault-reason" role="alert" data-testid="robot-fault-reason"><AlertTriangle :size="20"/><span>故障原因：{{faultReason}}</span></div>
     <div class="map-pose-card" data-testid="map-pose-status" role="status"><template v-if="displayedPose"><b>{{displayedPose.sourceLabel}}</b><span>X {{displayedPose.x.toFixed(3)}} m · Y {{displayedPose.y.toFixed(3)}} m</span><span>朝向 {{displayedPose.headingDeg.toFixed(1)}}°</span><small v-if="displayedPose.isStatic">静止已定位 · 运动同步待接入</small></template><template v-else><b>当前地图定位</b><small>{{robot.localization?.mapId&&robot.localization.mapId!==field?.id?'当前定位属于其他地图':'等待当前地图的有效位置与朝向'}}</small></template><small v-if="robot.localization?.reason">{{robot.localization.reason}}</small></div>
     <div v-if="navigationBlockReason" class="navigation-block-reason" role="status" data-testid="navigation-block-reason"><AlertTriangle :size="17"/><span>{{navigationBlockReason}}</span></div>
     <fieldset class="navigation-speeds" :disabled="busy||robot.running||!selectedTask||commandFeedback?.state==='waiting'">
      <legend>目标速度 · 厘米/秒</legend>
      <div class="speed-grid"><label v-for="item in speedFields" :key="item.key" :for="'navigation-speed-'+item.key">{{item.label}}<input :id="'navigation-speed-'+item.key" v-model.number="speedSettings[item.key]" type="number" min="2" :max="item.max" step="1" :aria-label="item.label+'速度（厘米/秒）'"/></label></div>
      <small>前进 2–20 · 倒车 2–15 · 平移 2–10；转弯自动减速。</small>
      <Button class="w-full mt-2" variant="outline" :disabled="busy||robot.running||!selectedTask||!speedDirty||commandFeedback?.state==='waiting'" @click="saveSpeeds">{{speedDirty?'保存速度':'速度已保存'}}</Button>
      <small>{{robot.running?'请停止导航后调整，下次启动生效。':'按当前地图保存，下次启动导航生效。'}}</small>
     </fieldset>
     <Button class="w-full mt-3" :variant="returnToStart?'default':'outline'" :aria-pressed="returnToStart" :disabled="busy||robot.running||!selectedTask||commandFeedback?.state==='waiting'" data-testid="return-to-start-toggle" @click="toggleReturnToStart">完成后原路倒车：{{returnToStart?'开启':'关闭'}}</Button>
     <small v-if="returnToStart" class="muted">前进到终点并停稳后，沿原路线倒车回起点。</small>
     <details v-if="field" class="scan-details" :open="field.coordinateStatus!=='reviewed'"><summary><MapPin :size="18"/>组中心坐标</summary><label>测量人员<input v-model="verification.operator"/></label><div v-for="(m,i) in verification.measurements" :key="i" class="measurement-grid"><input v-model.number="m.id" aria-label="组中心ID" type="number" min="0" max="586"/><input v-model="m.x" aria-label="实测X" placeholder="X / m" type="number" step="0.001"/><input v-model="m.y" aria-label="实测Y" placeholder="Y / m" type="number" step="0.001"/></div><Button variant="outline" class="w-full mt-3" :disabled="busy" @click="accept">确认扫描坐标</Button></details>
     
     </div><div class="navigation-actions"><Button class="w-full mt-3" :disabled="busy||commandFeedback?.state==='waiting'||!canNavigate" @click="navigation('start')"><Play :size="20"/>开始导航</Button><div class="export-grid mt-2"><Button variant="outline" :disabled="!robot.running" @click="navigation(robot.paused?'resume':'pause')"><Pause :size="18"/>{{robot.paused?'继续':'暂停'}}</Button><Button variant="destructive" @click="navigation('stop')"><Square :size="18"/>停止</Button></div></div>
    </section>
    <div class="canvas-section"><div class="canvas-toolbar"><template v-if="page==='scan'"><Button size="sm" :variant="scanView==='map'?'default':'ghost'" :aria-pressed="scanView==='map'" @click="scanView='map'">地图</Button><Button size="sm" :variant="scanView==='camera'?'default':'ghost'" :aria-pressed="scanView==='camera'" @click="scanView='camera'"><Camera :size="18"/>实时画面</Button></template><span v-else class="canvas-label">导航地图</span><Button v-if="map" size="sm" :disabled="editingRoute||map.tags.length<2" :variant="measuring?'default':'outline'" :aria-pressed="measuring" @click="toggleMeasurement"><Ruler :size="18"/>中心测距</Button><Button v-if="page==='navigate'&&field&&!editingRoute" size="sm" variant="outline" :disabled="routeLocked" data-testid="edit-route" @click="beginRoute">编辑路径</Button><span v-if="map" class="ml-auto badge">{{map.tags.length}} 个定位组 · {{map.rows.length}} 条{{map.routeMode==='waypoints'?'路线':'作物行'}}</span></div>
     <div v-if="editingRoute" class="route-editor" data-testid="route-editor">
      <div class="route-editor-actions">
       <Button size="sm" variant="outline" data-testid="route-draw-tool" title="绘制路径：点击地图加点，拖动路点调整" :aria-pressed="routeTool==='draw'" @click="routeTool='draw'"><PenLine :size="15"/>绘制路径</Button>
       <Button size="sm" variant="outline" data-testid="route-pan-tool" title="移动地图：左键拖图，不增加或移动路点" :aria-pressed="routeTool==='pan'" @click="routeTool='pan'"><Hand :size="15"/>移动地图</Button>
       <Button size="sm" variant="outline" :disabled="routeLocked||!routeHistory.length" @click="undoRoute">撤销</Button>
       <Button size="sm" :disabled="routeLocked||routeDrawing.length<2" @click="saveRoute(false)">保存路径</Button>
       <Button size="sm" variant="ghost" :disabled="routeLocked" @click="editingRoute=false;message=''">退出</Button>
       <Button size="sm" variant="outline" data-testid="route-properties-toggle" :aria-expanded="routeDetailsOpen" aria-controls="route-properties" @click="routeDetailsOpen=!routeDetailsOpen">属性</Button>
       <span class="route-metric">{{routeAnchors.length}} 点 · {{routeLength.toFixed(2)}} m</span>
      </div>
      <div v-show="routeDetailsOpen" id="route-properties" class="route-details-scroll">
       <div class="route-properties-heading"><strong>路径属性</strong><Button size="sm" variant="ghost" aria-label="关闭路径属性" @click="routeDetailsOpen=false">关闭</Button></div>
       <span class="badge route-group-badge" data-testid="route-group-badge" title="每到下一定位码纠正一次">经过 {{routeGroupIds.length}} · 跳过 {{routeSkipped.length}}</span>
       <div class="route-property-actions"><Button size="sm" variant="outline" :disabled="routeLocked||routeDrawing.length<2" data-testid="auto-chain-route" @click="autoChainRoute">自动串码</Button><Button v-if="routeSelected>=0" size="sm" variant="outline" :disabled="routeLocked" @click="deleteRoute">删除路点</Button></div>
       <details class="route-more" data-testid="route-more"><summary>更多 / 属性</summary><div class="route-more-content"><label>路径名称<input v-model="routeNameDraft" aria-label="路径名称" :disabled="routeLocked"/></label><label>车头朝向 / °<input v-model.number="bodyYawDeg" type="number" min="-180" max="180" step="90" aria-label="路径车头朝向" :disabled="routeLocked"/></label><div class="route-more-actions"><Button size="sm" variant="outline" :disabled="routeLocked||!routeDrawing.length" @click="clearRoute">清空</Button><Button size="sm" variant="outline" :disabled="routeLocked||routeDrawing.length<2" @click="saveRoute(true)">另存为新路径</Button><Button size="sm" variant="outline" :disabled="routeLocked||!selectedRouteId" @click="deleteNamedRoute">删除路径</Button></div></div></details>
      <div v-if="routeSkipped.length" class="route-skipped-groups" data-testid="route-skipped-groups" role="status"><p v-for="tag in routeSkipped" :key="tag.id">Q{{String(tag.id).padStart(3,'0')}} · 偏离路线 {{(tag.distanceM*100).toFixed(1)}} cm，未串联：建议把路线画过此码或调整铺码</p></div>
      <div v-if="routeAnchors.length" class="route-waypoints" aria-label="路径路点"><button v-for="(p,i) in routeAnchors" :key="i" :class="{active:i===routeSelected}" :disabled="routeLocked" @click="routeSelected=i">{{i+1}} · {{p.x.toFixed(2)}}, {{p.y.toFixed(2)}}</button></div>
      </div>
     </div>
     <div v-if="editingRoute&&(error||message)" class="route-toast" :class="{'route-toast-error':error}" :role="error?'alert':'status'" :title="error||message">{{error||message}}</div>
     <div v-if="measuring&&map&&(page!=='scan'||scanView==='map')" class="distance-panel">
      <div class="distance-fields"><label>起点<select v-model.number="measureFrom" aria-label="测距起点"><option value="">请选择定位组</option><option v-for="tag in map.tags" :key="tag.id" :value="tag.id">{{measureLabel(tag)}}</option></select></label><span class="distance-arrow">↔</span><label>终点<select v-model.number="measureTo" aria-label="测距终点"><option value="">请选择定位组</option><option v-for="tag in map.tags" :key="tag.id" :value="tag.id">{{measureLabel(tag)}}</option></select></label><Button size="sm" variant="ghost" @click="clearMeasurement">清除测距</Button></div>
      <div class="distance-result" data-testid="center-distance-result" role="status"><strong v-if="centerDistance!==null">中心距离 {{centerDistance.toFixed(3)}} m <span>（{{(centerDistance*100).toFixed(1)}} cm）</span></strong><span v-else>{{measureFrom!==''&&measureTo===measureFrom?'请选择两个不同的定位组':measureFrom!==''?'请点击第二个定位组，或选择测距终点':'点击地图上的两个定位组，或选择起点和终点'}}</span><small>两块二维码板中心的平面直线距离 · 地图计算值{{page==='navigate'&&userConfirmedMap?'，已按用户确认接纳':map.coordinateStatus!=='reviewed'||map.captureQuality==='draft'?'，尚未实测验收':''}}</small></div>
     </div>
     <CameraPreview v-if="page==='scan'&&scanView==='camera'" compact/>
     <MapCanvas v-else-if="map" :map="map" :selected="measuring?measurementIds:[]" :measurement="measuring?measurementIds:[]" row-id="" :tool="editingRoute?'route-design':measuring?'measure':'pan'" @select="measureSelect" :editable="editingRoute&&!routeLocked&&routeTool==='draw'" :drawing="editingRoute?routeDrawing:[]" :pan-enabled="editingRoute&&routeTool==='pan'" :route-group-ids="routeGroupIds" :route-skipped-groups="routeSkipped" :route-anchors="routeAnchors" :route-selected="routeSelected" @blank="appendRoute" @design-select="routeSelected=$event" @design-move="moveRoute" :vehicle="displayedPose??undefined" :trail="page==='scan'?trail:[]"/>
     <div v-else class="scan-empty"><div class="empty-illustration"><ScanLine v-if="page==='scan'" :size="32"/><Route v-else :size="32"/></div><strong>{{page==='scan'?'暂无扫描数据':'请选择地图'}}</strong><div class="getting-started" data-testid="getting-started"><span class="eyebrow">从这里开始</span><h2>{{page==='scan'?'为你的第一条路线做好准备':'让现场地图成为可执行路线'}}</h2><p>{{page==='scan'?'打印并铺设定位板，检查相机后开始扫描。已有扫描记录？可从左侧打开继续整理。':'先完成扫描并生成地图，再选择任务。你可以编辑路线、设置速度，并查看导航准备状态。'}}</p><div><Button size="sm" @click="page=page==='scan'?'print':'scan'">{{page==='scan'?'打印定位板':'前往扫描建图'}}<ArrowRight :size="15"/></Button><Button size="sm" variant="outline" @click="page='guide'">查看使用指南</Button></div></div></div>
     <div class="legend"><span><i class="tag-dot"/>定位组</span><span><i class="line-green"/>作物行</span></div>
    </div>
    <section v-if="!editingRoute" class="right-panel"><div class="panel-title"><Activity :size="18"/>作业概览</div><div class="next-step-card"><span class="eyebrow">当前阶段 · 0{{workflowStep}}</span><h2>{{currentStepLabel}}</h2><p>{{page==='scan'?(session?.state==='collecting'?'沿计划路径经过定位组，系统会持续记录轨迹与档位。':'完成定位板铺设与相机检查后，即可采集现场地图。'):editingRoute?'通过路点与定位组规划正交路线，预览确认后保存。':'选择地图与任务，核对路径、车头朝向及目标速度。'}}</p></div>
     <div v-if="page==='scan'" class="scan-detector-status" role="status">{{scanWaitReasons.length?scanWaitReasons.join('；'):(robot.mapping?.lateralSupported?'扫描就绪':'草稿扫描就绪 · 横移待验证')}}</div>
     <div v-else class="task-overview"><span>当前任务</span><strong>{{selectedNavigationTask?.name??'等待选择任务'}}</strong><small>{{field?.name??'尚未加载地图'}}</small><div class="task-progress-label"><span>作业状态</span><b>{{robot.running?(robot.paused?'已暂停':'执行中'):editingRoute?'路径编辑中':'待启动'}}</b></div></div>
     <div class="context-help"><BookOpen :size="18"/><div><strong>{{page==='scan'?'首次建图？':'路线怎么设计？'}}</strong><p>查看铺设、路径规则与常见问题。</p><button class="text-action" @click="page='guide'">打开使用指南<ArrowRight :size="14"/></button></div></div>
     <details class="advanced-diagnostics" data-testid="advanced-diagnostics"><summary><Settings2 :size="16"/><span>高级诊断</span><small>{{diagnosticsSummary}}</small></summary><div class="diagnostics-content">
<div class="sensor-line"><span>连接</span><b>{{bridgeOnline?'在线':'离线'}}</b></div><div class="sensor-line"><span>底盘反馈</span><b>{{bridgeOnline&&robot.chassis?.connected?'在线':'离线'}}</b></div><div class="sensor-line" data-sensor="preview"><span>相机预览</span><span class="muted-pill">{{previewLabel}}</span></div><div class="sensor-line" data-sensor="detector"><span>定位识别</span><span class="muted-pill">{{detectorLabel}}</span></div><div v-for="key in ['odom','imu','localization']" :key="key" class="sensor-line" :data-sensor="key"><span>{{{odom:'轮式里程计',imu:'IMU',localization:'定位'}[key]}}</span><span class="muted-pill">{{bridgeOnline?deviceStatus(key,String(robot.sensors?.[key]??'等待状态反馈')):'ROS桥离线 / 状态未知'}}</span></div>
     <template v-if="page==='scan'"><div v-if="originChanged&&session?.state!=='collecting'" class="scan-detector-status" role="status">此历史记录使用旧定位原点，请开始新的扫描。</div><div v-if="bridgeOnline&&robot.detector?.groups?.length" class="section-label">当前画面</div><div v-for="g in bridgeOnline?robot.detector?.groups??[]:[]" :key="g.id" class="metric-row"><span>{{g.id}}</span><b>{{g.visible}} / {{g.total}} 码</b></div><div class="section-label">组识别统计</div><div class="log-list"><div v-for="(count,id) in session?.counts??{}" :key="id">{{groupName(Number(id))}} · {{count}} 次</div><div v-for="(v,id) in session?.visibility??{}" :key="'v'+id">{{id}} · 可见 {{v.visible}} / {{v.total}} 码</div></div><div v-if="session" class="section-label">区间运动模式（档位＋轨迹）</div><div v-if="session" class="metric-row"><span>连续档位记录</span><b>{{session.motionValidation?.recordCount??0}} 条</b></div><div v-for="(segment,index) in session?.motionValidation?.segments??[]" :key="'motion-'+index" class="log-list"><div>{{segment.from}} → {{segment.to}} · {{segment.mode==='crab'?'平移':segment.mode==='4t4d'?'4T4D':'待确认'}} · {{segment.status==='confirmed'?'聚合反馈与轨迹一致':'校验未通过'}}</div><div v-for="reason in segment.reasons" :key="reason">{{reason}}</div></div><div v-if="session?.result" class="metric-row"><span>扫描残差</span><b>{{(session.result.rmsM*100).toFixed(2)}} cm</b></div></template>
     <template v-else><div class="metric-row"><span>当前定位组</span><b>{{robot.group?.id??'—'}}</b></div><div v-if="robot.group" class="metric-row"><span>可见子码</span><b>{{robot.group.visible}} / {{robot.group.total}}</b></div><div v-if="robot.group" class="metric-row"><span>定位质量</span><b>{{robot.group.degraded?'部分可见':'完整'}}</b></div><details class="scan-details navigation-diagnostics" data-testid="navigation-diagnostics"><summary><Settings2 :size="18"/><span>设备诊断</span><small>{{diagnosticsSummary}}</small></summary><div v-for="c in robot.conditions" :key="c.id" class="readiness-line"><CheckCircle2 v-if="c.ready" :size="18"/><AlertTriangle v-else :size="18"/><span>{{c.label}}<template v-if="!c.ready&&c.id==='execution'"><br/><small>当前为只读模式，实体执行尚未开启</small></template><template v-else-if="!c.ready&&c.id==='pose'"><br/><small>{{robot.localization?.reason||'等待新鲜定位/误差达标'}}</small></template></span></div></details><div class="log-list"><div v-for="(event,i) in robot.events" :key="i">{{event}}</div></div></template>
     <ExecutionErrors v-if="page==='navigate'&&!editingRoute" :status="robot" :map-id="field?.id??''" :version="version" :task-id="selectedTask" :now-ms="poseClock" :received-ms="robotReceivedClock" :online="bridgeOnline"/>
</div></details>
    </section>
   </div>
  </main>
 </div>
</template>
<style scoped>
.route-skipped-groups{padding:8px 10px;margin-top:8px;border:1px solid #fde68a;border-radius:6px;background:#fffbeb;color:#b45309;font-size:12px;line-height:1.6;max-height:100px;overflow:auto}.route-skipped-groups p{margin:0}.route-group-badge{white-space:normal}

.route-editor{flex-shrink:0;padding:12px 16px;background:var(--panel);border-bottom:1px solid var(--accent);color:var(--ink)}.route-editor-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.route-editor-actions strong{font-size:14px;letter-spacing:1px}.route-editor-actions label{display:flex;align-items:center;gap:6px;margin:0;font-size:13px}.route-editor-actions input{width:78px;height:34px;padding:5px;border:1px solid #94a3b8;border-radius:8px;background:white}.route-editor p{margin:8px 0 0;font-size:12px;line-height:1.7;color:var(--muted)}.route-metric{font:12px monospace;color:var(--muted);margin-right:auto}.route-waypoints{display:flex;gap:6px;overflow:auto;max-height:72px;margin-top:8px}.route-waypoints button{white-space:nowrap;padding:4px 8px;border:1px solid var(--line);background:var(--background);border-radius:8px;font:12px monospace}.route-waypoints button.active{border-color:var(--accent);background:var(--panel)}.route-waypoints button:disabled{opacity:.5}

.navigation-speeds{min-width:0;margin:16px 0 0;padding:12px 0;border:0;border-top:1px solid var(--line)}.navigation-speeds legend{padding:0 8px 0 0;color:var(--ink);font-size:14px}.speed-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.speed-grid label{min-width:0;margin:0;font-size:14px}.speed-grid input{width:100%;min-width:0;height:42px;margin-top:6px;padding:8px}.navigation-speeds small{display:block;margin-top:8px;color:var(--muted);font-size:12px;line-height:1.6}.navigation-speeds:disabled input{opacity:.55}

.navigation-block-reason{display:flex;align-items:flex-start;gap:8px;margin-top:12px;color:var(--accent);font-size:14px;line-height:1.6;overflow-wrap:anywhere}.navigation-block-reason svg{flex-shrink:0;margin-top:3px}
.navigation-diagnostics summary small{margin-left:auto;font-size:13px;font-weight:400;color:var(--muted)}.navigation-diagnostics summary::after{content:'⌄';font-size:14px;transition:transform .15s}.navigation-diagnostics[open] summary::after{transform:rotate(180deg)}
.fault-reason{margin-top:12px;padding:12px 14px;border-radius:8px;align-items:flex-start;overflow-wrap:anywhere}
.map-pose-card{display:flex;flex-direction:column;gap:7px;margin-top:12px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font-size:14px;overflow-wrap:anywhere}.map-pose-card b{font-weight:500}.map-pose-card small{color:var(--muted);line-height:1.6}
.distance-panel{padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel);flex-shrink:0}
.distance-fields{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.distance-fields label{display:flex;align-items:center;gap:8px;font-size:14px;margin:0;flex:1;min-width:145px}.distance-fields select{width:100%;min-width:0;max-width:220px;height:40px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:white;color:var(--ink)}.distance-arrow{color:var(--muted)}.distance-result{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 16px;margin-top:10px;color:var(--ink);font-size:14px}.distance-result strong{font-size:14px;font-weight:600}.distance-result strong span{font-size:14px;font-weight:400}.distance-result small{display:block;font-size:13px;color:var(--muted)}.canvas-toolbar{flex-wrap:wrap}
@media(max-width:760px){.canvas-section{height:auto;min-height:430px}.distance-panel{padding:10px 12px}.distance-fields{gap:6px}.distance-fields label{min-width:120px}.distance-fields .distance-arrow{display:none}.distance-result strong{font-size:14px}}

.scan-detector-status{margin-top:12px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font-size:14px;line-height:1.65;overflow-wrap:anywhere}
.scan-empty{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;background:var(--background);color:var(--muted);min-height:320px}
.scan-empty strong{font-size:18px;font-weight:500;color:var(--muted)}
.scan-alert{display:flex;align-items:center;gap:8px;color:#b91c1c;background:#fef2f2;padding:10px 14px;font-size:13px;line-height:1.6}
.scan-alert svg{flex-shrink:0}
.scan-details{margin-top:14px;border-top:1px solid var(--panel);padding-top:20px}
.scan-details summary{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:500;color:var(--ink);cursor:pointer;min-height:40px}
.sensor-line{gap:12px}.sensor-line>span:first-child{flex-shrink:0}.sensor-line .muted-pill{white-space:normal;text-align:right;overflow-wrap:anywhere}.scan-wait{line-height:1.65;overflow-wrap:anywhere}
.sensor-line b{font-size:14px;color:var(--ink);font-weight:500}
@media(max-width:760px){.scan-empty{min-height:350px}}
</style>
