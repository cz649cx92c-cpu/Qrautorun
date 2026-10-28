<script setup lang="ts">
import ExecutionErrors from './components/ExecutionErrors.vue';
import CalibrationWorkspace from './components/CalibrationWorkspace.vue';
import {computed,nextTick,onMounted,onBeforeUnmount,ref,watch} from 'vue';
import {ScanLine,Navigation,Play,Pause,Square,CheckCircle2,AlertTriangle,Radio,Settings2,FileText,Camera,Ruler,ArrowRight,Route,Layers,Hand,PenLine,Trash2,Crosshair,Link2,Move,RotateCcw} from 'lucide-vue-next';
import Button from './components/ui/Button.vue';
import MapCanvas from './components/MapCanvas.vue';
import PdfGenerator from './components/PdfGenerator.vue';
import TagInspector from './components/TagInspector.vue';
import SegmentStrategyEditor from './components/SegmentStrategyEditor.vue';
import OrthogonalCorrectionPanel from './components/OrthogonalCorrectionPanel.vue';
import MapDeleteConfirm from './components/MapDeleteConfirm.vue';
import {planStrategies,choicesFromSegments,segmentExecutionBlockers,strategyOptions,type SegmentChoice,type SegmentPlan,type StrategyMode} from '../../shared/segment-strategy';
import ScanRecords from './components/ScanRecords.vue';
import CameraPreview from './components/CameraPreview.vue';
import type {FieldMap,Point} from '../../shared/model';
import {distance,exitPoint,orderedTagsById} from '../../shared/model';
import {orthogonalRoute,routeCorners,snapRoutePoint,chainRouteGroups,routeGroupCenters,distanceToRoute,ROUTE_GRID,type SkippedRouteGroup} from '../../shared/route-design';
import {taskSchema,type Task} from '../../shared/task';
import type {Board} from '../../shared/boards';
import type {SurveySummary} from '../../shared/survey';
import type {Route as RouteEntity} from '../../shared/route';
type ConsolePage='scan'|'navigate'|'print'|'camera'|'calibration';
const initialPage=new URLSearchParams(location.search).get('page');
const page=ref<ConsolePage>(initialPage==='camera'?'camera':initialPage==='calibration'?'calibration':'scan'),busy=ref(false),error=ref(''),message=ref(''),connected=ref(false);
const commandFeedback=ref<{id:string,state:'waiting'|'confirmed'|'rejected'|'unconfirmed',text:string}|null>(null);
let navigationAbort:AbortController|undefined;
// 自用版：不再让用户填写扫描名称，开始时按时间自动生成一个可读默认名。
function autoSurveyName(){const d=new Date(),p=(n:number)=>String(n).padStart(2,'0');return `扫描-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;}
const name=ref(''),settings=ref({tagSizeMm:80,rowWidth:.6,exitDistance:.8}),session=ref<any>(null),sessions=ref<SurveySummary[]>([]);
const field=ref<FieldMap|null>(null),version=ref(0),tasks=ref<Task[]>([]),routes=ref<RouteEntity[]>([]),selectedTask=ref(''),selectedMapId=ref(''),selectedRouteId=ref(''),routeNameDraft=ref(''),anchors=ref('[]');
const routeEditId=ref(''),routeEditUpdated=ref('');
const maps=ref<{id:string;name:string;version:number;created:string}[]>([]),showCaptureTrail=ref(false);
const routeDetailsOpen=ref(false);
const orthogonalPreviewMap=ref<FieldMap|null>(null);
// A pending orthogonal-correction preview is a read-only view of a candidate map:
// path drawing, path saving and navigation must stay blocked until it is applied or discarded.
const orthogonalPreviewActive=computed(()=>orthogonalPreviewMap.value!==null);
const mapApproval=ref<{kind:string|null,accepted:boolean,digestValid:boolean}|null>(null);
function selectMap(result:any){field.value=result.map;version.value=result.version;mapApproval.value=result.acceptance??null;}
function setOrthogonalPreview(value:FieldMap|null){orthogonalPreviewMap.value=value;}
async function onOrthogonalApplied(result:any){selectMap(result);orthogonalPreviewMap.value=null;selectedRouteId.value='';selectedTask.value='';await refresh();message.value='正交校正已保存 · 地图版本 v'+result.version+'；旧路线保持原版本';}
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
// 组中心坐标只读展示扫描结果，不再提供手工实测输入。

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
function selectSession(value:any){sessionEpoch++;session.value=value;name.value=value?.name??'';anchors.value=JSON.stringify(value?.anchors??[]);}
async function refreshPreview(){try{previewStatus.value=await api('/camera/status');previewError.value='';}catch{previewStatus.value=null;previewError.value='预览服务状态查询失败';}}
async function api(path:string,body?:unknown,method=body===undefined?'GET':'POST',signal?:AbortSignal){const response=await fetch('/api'+path,{method,signal,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const json=await response.json();if(!response.ok)throw Object.assign(new Error(json.error??'请求失败'),{status:response.status});return json;}
async function act(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';message.value='';try{await fn();}catch(e){error.value=e instanceof Error?e.message:String(e);}finally{busy.value=false;}}
async function refresh(){sessions.value=await api('/surveys');tasks.value=(await api('/tasks')).filter((t:Task)=>t.id.startsWith('task-scan-')||t.routeId);routes.value=await api('/routes');maps.value=await api('/maps');boards.value=await api('/boards');}
async function generated(){await act(async()=>{boards.value=await api('/boards');message.value='定位组已保存';});}
function groupName(id:number){const board=(session.value?.boards??boards.value).find((b:Board)=>b.referenceId===id);return board?.id??label(id);}
async function refreshSurveys(){await act(async()=>{sessions.value=await api('/surveys');});}
async function loadSession(id:string){if(!id)return;await act(async()=>{if(session.value?.state==='collecting')throw new Error('请先停止当前扫描');sessionEpoch++;selectSession(await api('/surveys/'+id));});}
async function removeSession(id:string){await act(async()=>{sessionEpoch++;const target=sessions.value.find(item=>item.id===id);const result=await api('/surveys/'+id,undefined,'DELETE');if(session.value?.id===id){selectSession(null);}if(target?.mapId){if(field.value?.id===target.mapId){field.value=null;mapApproval.value=null;version.value=0;}if(selectedMapId.value===target.mapId)selectedMapId.value='';if(scanMap.value?.id===target.mapId){scanMap.value=null;scanMapVersion.value=0;}}orthogonalPreviewMap.value=null;if(mapDeletion.value&&mapDeletion.value.mapId===target?.mapId)mapDeletion.value=null;sessions.value=sessions.value.filter(s=>s.id!==id);const cascade=result.deletedMaps?` · 同时删除 ${result.deletedMaps} 张地图、${result.deletedRoutes} 条路径、${result.deletedTasks} 个任务绑定`:'';message.value='已删除扫描：'+result.name+cascade;sessions.value=await api('/surveys');await refresh();});}
// Map deletion is always two steps: a read-only cascade preview, then an explicit confirm.
const mapDeletion=ref<any>(null);
async function askDeleteMap(mapId:string,fallbackName=''){
 await act(async()=>{
  if(!mapId)throw new Error('请先选择要删除的地图');
  if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再删除地图');
  if(robot.value.running)throw new Error('请先停止导航再删除地图');
  const info=await api('/maps/'+encodeURIComponent(mapId)+'/deletion');
  mapDeletion.value={...info,name:info.name||fallbackName||mapId};
 });
}
async function confirmDeleteMap(){
 await act(async()=>{
  const info=mapDeletion.value;if(!info)return;
  const result=await api('/maps/'+encodeURIComponent(info.mapId),undefined,'DELETE');
  mapDeletion.value=null;orthogonalPreviewMap.value=null;
  if(field.value?.id===result.mapId){field.value=null;mapApproval.value=null;version.value=0;}
  if(selectedMapId.value===result.mapId)selectedMapId.value='';
  if(scanMap.value?.id===result.mapId){scanMap.value=null;scanMapVersion.value=0;}
  selectedRouteId.value='';selectedTask.value='';routeNameDraft.value='';
  await refresh();
  message.value=`已删除地图「${result.name}」 · 同时删除 ${result.deletedVersions} 个版本、${result.deletedRoutes} 条路径、${result.deletedTasks} 个任务绑定`;
 });
}
// Route deletion also previews task bindings; detachTasks is only sent after the operator confirms.
const routeDeletion=ref<{routeId:string,name:string,mapId:string,tasks:{id:string,name:string}[]}|null>(null);
function pickRoute(routeId:string){selectedRouteId.value=routeId;chooseRoute();}
async function askDeleteRoute(route:RouteEntity){
 await act(async()=>{
  if(robot.value.running)throw new Error('请先停止导航再删除路径');
  const usage=await api('/routes/'+encodeURIComponent(route.routeId)+'/usage');
  routeDeletion.value={routeId:route.routeId,name:route.name,mapId:route.mapId,tasks:usage.tasks??[]};
 });
}
async function confirmDeleteRoute(){
 await act(async()=>{
  const info=routeDeletion.value;if(!info)return;
  await api('/routes/'+encodeURIComponent(info.routeId)+(info.tasks.length?'?detachTasks=1':''),undefined,'DELETE');
  routeDeletion.value=null;
  // 删除成功后必须把“正在显示的路线快照”一起清掉：selected route/task snapshot、编辑态、
  // 正交预览和残留的 motionSegments/rows 都不能继续留在画布上。
  routeEditId.value='';routeEditUpdated.value='';
  routeModes.value=[];routePolicyHistory.value=[];routePolicyHistory.value=[];selectedSegmentKey.value='';
  selectedRouteId.value='';selectedTask.value='';routeNameDraft.value='';orthogonalPreviewMap.value=null;
  if(editingRoute.value)editingRoute.value=false;
  await refresh();
  // 重新 GET 当前地图（不改变版本），确保画布只显示剩余路径/无路径状态。
  if(field.value&&field.value.id===info.mapId){selectMap(await api('/maps/'+info.mapId));}
  message.value=`已删除路径「${info.name}」`+(info.tasks.length?`，并移除 ${info.tasks.length} 个任务绑定`:'');
 });
}
async function start(){await act(async()=>{if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再开始扫描');if(!boards.value.length)throw new Error('请先生成多码定位组');const surveyName=name.value.trim()||autoSurveyName();name.value=surveyName;selectSession(await api('/survey/start',{name:surveyName}));scanView.value='camera';await refresh();message.value='扫描已开始 · '+surveyName;});}
async function stopSelectedSession(){
 if(!session.value)throw new Error('请先开始扫描');
 const id=session.value.id;
 if(session.value.state==='collecting')await api('/survey/stop',{sessionId:id});
 sessionEpoch++;session.value=await api('/surveys/'+id);
 return session.value;
}
async function savePositionMap(){
 if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再保存地图');
 const selected=await stopSelectedSession();
 const mapId='scan-'+selected.id.replace(/-/g,'');let baseVersion=0;
 try{baseVersion=(await api('/maps/'+mapId)).version;}catch(e){if((e as {status?:number}).status!==404)throw e;}
 const result=await api('/survey/map',{sessionId:selected.id,baseVersion,name:selected.name+'地图',tagSizeMm:settings.value.tagSizeMm});
 selectMap(result);orthogonalPreviewMap.value=null;selectedMapId.value=result.map.id;selectedRouteId.value='';selectedTask.value='';routeNameDraft.value='';
 await refresh();page.value='navigate';message.value='地图已保存 · '+result.map.tags.length+' 个定位组 · 未创建路径';
}
async function savePoints(){await act(savePositionMap);}
const selectedMapSurvey=computed(()=>selectedMapId.value?sessions.value.find(item=>'scan-'+item.id.replace(/-/g,'')===selectedMapId.value):undefined);
async function rebuildSelectedMap(){await act(async()=>{
 if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再重建地图');
 if(!field.value||field.value.routeMode!=='map-only')throw new Error('当前地图不是可重建的定位码地图');
 const source=selectedMapSurvey.value;if(!source)throw new Error('找不到该地图对应的已停止原始扫描记录');
 const latest=await api('/maps/'+encodeURIComponent(field.value.id));
 const result=await api('/survey/map',{sessionId:source.id,baseVersion:latest.version,rebuild:true,name:source.name+'地图',tagSizeMm:settings.value.tagSizeMm});
 selectMap(result);orthogonalPreviewMap.value=null;selectedRouteId.value='';selectedTask.value='';
 await refresh();message.value='已从原始扫描重建地图新版本 v'+result.version+' · 旧版本和路线保持不变';
});}
async function resume(){await act(async()=>{if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再继续补扫');selectSession(await api('/survey/resume',{sessionId:session.value.id}));scanView.value='camera';await refresh();message.value='已继续扫描';});}
async function finish(){await act(savePositionMap);}
async function loadTask(){await act(async()=>{const task=tasks.value.find(t=>t.id===selectedTask.value);if(!task){field.value=null;mapApproval.value=null;return;}selectedMapId.value=task.mapId;selectedRouteId.value=task.routeId??routes.value.find(route=>route.mapId===task.mapId&&route.mapVersion===task.mapVersion&&route.routeId.startsWith('legacy-'))?.routeId??'';const result=task.routeId?await api('/routes/'+task.routeId):await api('/maps/'+task.mapId);selectMap(result);const route=routes.value.find(item=>item.routeId===selectedRouteId.value);routeNameDraft.value=route?.name??field.value?.rows[0]?.name??field.value?.name??'';});}
const availableMaps=computed(()=>maps.value);
const availableRoutes=computed(()=>routes.value.filter(route=>!selectedMapId.value||route.mapId===selectedMapId.value));
function taskForRoute(route:RouteEntity){return tasks.value.find(item=>item.routeId===route.routeId)??(route.routeId.startsWith('legacy-')?tasks.value.find(item=>!item.routeId&&item.mapId===route.mapId&&item.mapVersion===route.mapVersion):undefined);}
async function chooseMap(){await act(async()=>{
 selectedRouteId.value='';selectedTask.value='';routeNameDraft.value='';orthogonalPreviewMap.value=null;
 if(!selectedMapId.value){field.value=null;mapApproval.value=null;return;}
 selectMap(await api('/maps/'+selectedMapId.value));
});}
function chooseRoute(){const route=routes.value.find(item=>item.routeId===selectedRouteId.value);if(route&&(route.mapId!==field.value?.id||route.mapVersion!==version.value)){message.value='该路径不属于当前地图 v'+version.value+'，已忽略';selectedRouteId.value='';selectedTask.value='';routeNameDraft.value='';return;}const task=route?taskForRoute(route):undefined;selectedTask.value=task?.id??'';routeNameDraft.value=route?.name??'';if(task)void loadTask();}

// 自用版：坐标直接读取扫描结果，界面上不再有「启用此地图 / 确认启用地图」动作。
// 选中哪张地图，它就是当前导航地图与定位目标（见 syncLocalizationScope 的切图重锚）。
// 旧 POST /api/maps/confirm 与 /api/maps/accept 保留兼容，但前端不再调用、不再要求点击；
// 开始导航仍由定位/相机/IMU/底盘条件与地图+路径版本一致性共同把关。
// 现场所有板子同方向铺设：扫描估计的逐码朝向角只允许几度噪声，统一目标取中位数。
// 预览只读；只有点击应用才保存新版本，绝不自动修改。
const unifyAnglesInfo=computed(()=>{
 const tags=field.value?.tags??[];if(tags.length<2)return null;
 const sorted=tags.map(t=>t.angle).sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
 const target=sorted.length%2?sorted[middle]!:(sorted[middle-1]!+sorted[middle]!)/2;
 return {list:tags.map(t=>({id:t.id,angleDeg:t.angle})),targetDeg:target,spreadDeg:sorted[sorted.length-1]!-sorted[0]!};
});
async function unifyAngles(){await act(async()=>{
 if(!field.value||!unifyAnglesInfo.value)throw new Error('请先选择扫描地图');
 const result=await api('/maps/unify-angles',{mapId:field.value.id,version:version.value,confirm:true,updateTasks:true});
 selectMap(await api('/maps/'+field.value.id));
 await refresh();message.value=`已统一 ${result.before.length} 个定位码朝向到 ${Number(result.unifiedAngleDeg).toFixed(2)}°，路径与任务已同步到 v${result.version}`;
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
 if(command==='start'&&orthogonalPreviewActive.value){error.value='正交校正预览中，请先应用或撤销预览再开始导航';return;}
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
const captureSampleCount=computed(()=>session.value?.samples?.length??0);
const capturePointCount=computed(()=>{
 const observed=new Set<string>();const layouts:Board[]=session.value?.boards??boards.value;
 const groupKey=(id:number,groupId?:string)=>groupId??layouts.find(board=>board.members.some(member=>member.id===id))?.id??String(id);
 for(const sample of session.value?.samples??[])for(const tag of sample.tags??[])observed.add(groupKey(tag.id,tag.groupId));
 if(!observed.size)for(const [id,count] of Object.entries(session.value?.counts??{}))if(Number(count)>0)observed.add(groupKey(Number(id)));
 return observed.size;
});
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
// Scan page keeps its own copy of the selected record's saved map so the rebuild
// button and orthogonal panel are reachable without leaving the scan workflow.
const scanMapId=computed(()=>session.value?.id?'scan-'+session.value.id.replace(/-/g,''):'');
const scanMap=ref<FieldMap|null>(null),scanMapVersion=ref(0),scanMapLoaded=ref(false);
async function loadScanMap(){
 const id=scanMapId.value;
 if(!id){scanMap.value=null;scanMapVersion.value=0;scanMapLoaded.value=false;return;}
 try{
  const result=await api('/maps/'+encodeURIComponent(id));
  scanMap.value=result.map;scanMapVersion.value=result.version;scanMapLoaded.value=true;
 }catch(e){
  scanMap.value=null;scanMapVersion.value=0;scanMapLoaded.value=(e as {status?:number}).status!==404;
 }
}
async function rebuildScanMap(){await act(async()=>{
 if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再重建地图');
 const current=session.value;
 if(!current)throw new Error('请先在「已保存扫描」中选择一条记录');
 if(current.state==='collecting')throw new Error('请先停止扫描再重建地图');
 const id='scan-'+current.id.replace(/-/g,'');
 const latest=await api('/maps/'+encodeURIComponent(id));
 if(latest.map?.routeMode!=='map-only')throw new Error('当前地图不是可重建的定位码地图');
 const result=await api('/survey/map',{sessionId:current.id,baseVersion:latest.version,rebuild:true,name:current.name+'地图',tagSizeMm:settings.value.tagSizeMm});
 await refresh();await loadScanMap();
 message.value='已从原始扫描重建地图新版本 v'+result.version+' · 旧版本和路线保持不变';
});}
async function onScanMapApplied(result:any){orthogonalPreviewMap.value=null;await refresh();await loadScanMap();message.value='正交校正已保存 · 地图版本 v'+result.version+'；旧路线保持原版本';}
watch([scanMapId,()=>session.value?.state],()=>{orthogonalPreviewMap.value=null;if(page.value==='scan')void loadScanMap();},{immediate:true});
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
// Shared empty identities: a render caused by telemetry must not hand MapCanvas a brand-new
// array prop, otherwise its deep watcher would rebuild every QR/handle even though nothing changed.
const EMPTY_TAG_IDS:number[]=[],EMPTY_POINTS:Point[]=[];
// Single source of truth for the live vehicle overlay. Scanning/building and route editing never
// paint the real pose, no matter how much telemetry arrives; only the navigation monitor does.
const mapVehicle=computed(()=>page.value==='navigate'&&!editingRoute.value&&bridgeOnline.value?matchingMapPose(robot.value,field.value?.id??'',poseClock.value,robotReceivedClock.value):null);
// The pose card and the map read the same gated value, so they can never disagree.
const displayedPose=mapVehicle;
// Static/interactive props are derived once per real state change instead of being allocated
// inline in the template (where every telemetry render produced new arrays and forced a redraw).
const mapSelected=computed<number[]>(()=>measuring.value?measurementIds.value:inspectedTagId.value===null?EMPTY_TAG_IDS:[inspectedTagId.value]);
const mapMeasurement=computed<number[]>(()=>measuring.value?measurementIds.value:EMPTY_TAG_IDS);
const mapDrawing=computed<Point[]>(()=>editingRoute.value?routeDrawing.value:EMPTY_POINTS);
// Capture trail is a diagnostic overlay available on the scan page only while its explicit
// toggle is checked; editing and navigation never receive those points.
const mapTrail=computed<Point[]>(()=>page.value==='scan'&&!editingRoute.value&&showCaptureTrail.value?trail.value:EMPTY_POINTS);
// Stored map versions can still carry an old row/motionSegments (示教/旧路线). The canvas must
// never render those unless they belong to the route the operator selected right now:
// - scan page: the map itself (map-only maps carry no route);
// - navigation monitor: only the selected route snapshot;
// - route editing: the orthogonal drawing preview is authoritative, so stored routes are hidden.
const canvasMap=computed<FieldMap|null>(()=>{
 const base=orthogonalPreviewMap.value??map.value;if(!base)return null;
 if(page.value==='scan')return base;
 const route=editingRoute.value?undefined:routes.value.find(item=>item.routeId===selectedRouteId.value);
 return {...base,rows:[],motionSegments:route?.motionSegments};
});
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
// 折叠状态：左侧导航栏、路径工具/参数卡片、右侧节点属性面板。
const sidebarCollapsed=ref(false),toolsOpen=ref(true),paramsOpen=ref(false);
const editingRoute=ref(false),routeAnchors=ref<Point[]>([]),routeSelected=ref(-1),bodyYawDeg=ref(0),initialHeadingManual=ref(false),routeTool=ref<'select'|'draw'|'pan'>('draw');
const tagInspectorVisible=ref(false);
// 双击地图上的二维码 → 就地弹出基本信息（不再显示子码/原图）
const tagDetailId=ref<number|null>(null);
const tagDetail=computed(()=>{
 const id=tagDetailId.value;if(id===null||!field.value)return null;
 const tag=field.value.tags.find(item=>item.id===id);if(!tag)return null;
 const groups=(field.value.groups??[]) as Array<{referenceId:number,gridSize:number,sizeMm:number}>;
 const board=groups.find(group=>group.referenceId===tag.id);
 return {id,label:tag.groupId??'Q'+String(tag.id).padStart(3,'0'),family:field.value.family,
  sizeMm:Math.round(tag.size*1000),rowId:tag.rowId??'—',
  kind:tag.groupId?'整组定位板':'独立单码',grid:board?board.gridSize:null};
});
function openTagDetail(id:number){tagDetailId.value=id;}

const inspectedTagId=ref<number|null>(null),selectedSegmentKey=ref(''),routeModes=ref<SegmentChoice[]>([]),routePolicyHistory=ref<SegmentChoice[][]>([]);
const routeHistory=ref<Point[][]>([]),routeSkippedHold=ref<SkippedRouteGroup[]>([]);
const routeDrawing=computed(()=>orthogonalRoute(routeAnchors.value));
const routeChain=computed(()=>chainRouteGroups(routeDrawing.value,field.value?routeGroupCenters(field.value):[]));
const routeGroupIds=computed(()=>[...new Set(routeChain.value.nodes.map(node=>node.id))]);
// Keep the reactive dependency on a stable primitive: reading robot.value inside routePlans would
// re-create the segment-plan array on every telemetry frame and re-trigger MapCanvas redraw.
const turnInPlaceCapability=computed(()=>robot.value.capabilities?.turnInPlace===true);
const routePlans=computed(()=>planStrategies(routeChain.value.nodes,bodyYawDeg.value*Math.PI/180,routeModes.value,{turnInPlace:turnInPlaceCapability.value}));
const savedStrategyBlockers=computed(()=>segmentExecutionBlockers(field.value?.motionSegments,{turnInPlace:turnInPlaceCapability.value}));
// The starting body heading belongs to the route, not to the recording. Until the
// operator sets it explicitly it follows the first leg's travel direction.
const norm360=(deg:number)=>((deg%360)+360)%360;
const wrapDeg180=(deg:number)=>norm360(deg+180)-180;
function firstLegHeadingDeg(points:Point[]=routeAnchors.value){
 // Prefer the first planned leg (snapped group centres), which is exactly what the
 // strategy planner uses as its first travel direction.
 const nodes=routeChain.value.nodes;
 const a=nodes.length>=2?nodes[0]!:points[0],b=nodes.length>=2?nodes[1]!:points[1];
 if(!a||!b)return 0;
 if(Math.hypot(b.x-a.x,b.y-a.y)<1e-6)return 0;
 return Math.round(norm360(Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI)*100)/100;
}
function setInitialHeading(deg:number){if(!Number.isFinite(deg))return;bodyYawDeg.value=Math.round(norm360(deg)*100)/100;initialHeadingManual.value=true;}
function setInitialHeadingRad(rad:number){if(!Number.isFinite(rad))return;setInitialHeading(rad*180/Math.PI);}
function nudgeInitialHeading(delta:number){setInitialHeading(bodyYawDeg.value+delta);}
function adoptFirstLegHeading(){setInitialHeading(firstLegHeadingDeg());}
function resetInitialHeading(){initialHeadingManual.value=false;bodyYawDeg.value=firstLegHeadingDeg();}
watch(routeAnchors,()=>{if(editingRoute.value&&!initialHeadingManual.value)bodyYawDeg.value=firstLegHeadingDeg();},{deep:true});
const lateralStrategyBlocked=computed(()=>field.value?.motionSegments?.some(segment=>segment.strategy==='left'||segment.strategy==='right')&&robot.value.mapping?.lateralSupported!==true);
function inspectTag(id:number){if(editingRoute.value){inspectedTagId.value=id;tagInspectorVisible.value=false;}}
function openTagInspector(){if(!field.value?.tags.length)return;inspectedTagId.value??=orderedTagsById(field.value.tags)[0]!.id;tagInspectorVisible.value=true;if(editingRoute.value)routeDetailsOpen.value=true;}
function changeSegmentMode(plan:SegmentPlan,mode:StrategyMode){if(routeLocked.value)return;rememberRoute();routeModes.value=[...routeModes.value.filter(choice=>!(choice.fromId===plan.fromId&&choice.toId===plan.toId&&choice.occurrence===plan.occurrence)),{fromId:plan.fromId,toId:plan.toId,occurrence:plan.occurrence,mode}];selectedSegmentKey.value=plan.key;}
function selectSegment(key:string){selectedSegmentKey.value=key;routeDetailsOpen.value=true;}
const routeSkipped=computed(()=>{
 const byId=new Map([...routeSkippedHold.value,...routeChain.value.skipped].map(tag=>[tag.id,tag]));
 return [...byId.values()].filter(tag=>!routeGroupIds.value.includes(tag.id)).map(tag=>({...tag,distanceM:distanceToRoute(tag,routeDrawing.value)}));
});
const routeLength=computed(()=>routeDrawing.value.slice(1).reduce((sum,p,i)=>sum+distance(routeDrawing.value[i]!,p),0));
const routeLocked=computed(()=>busy.value||robot.value.running||commandFeedback.value?.state==='waiting'||orthogonalPreviewActive.value);
function rememberRoute(){routeSkippedHold.value=[];routeHistory.value=[...routeHistory.value.slice(-99),routeAnchors.value.map(p=>({...p}))];routePolicyHistory.value=[...routePolicyHistory.value.slice(-99),routeModes.value.map(choice=>({...choice}))];}
function beginRoute(){
 if(!field.value||routeLocked.value)return;
 orthogonalPreviewMap.value=null;
 routeDetailsOpen.value=false;tagInspectorVisible.value=false;
 routeModes.value=choicesFromSegments(routes.value.find(route=>route.routeId===selectedRouteId.value)?.motionSegments??field.value.motionSegments??[]);routePolicyHistory.value=[];inspectedTagId.value=null;selectedSegmentKey.value='';
 routeTool.value='draw';measuring.value=false;clearMeasurement();routeSelected.value=-1;routeHistory.value=[];routeSkippedHold.value=[];
 const selectedRoute=routes.value.find(route=>route.routeId===selectedRouteId.value);routeEditId.value=selectedRoute?.routeId??'';routeEditUpdated.value=selectedRoute?.updated??'';const row=field.value.rows[0],points=selectedRoute?.points??(row?[exitPoint(row),...row.points]:[]);routeNameDraft.value=selectedRoute?.name??row?.name??field.value.name;
 const orthogonal=points.every((p,i)=>!i||Math.abs(p.x-points[i-1]!.x)<1e-8||Math.abs(p.y-points[i-1]!.y)<1e-8);
 routeAnchors.value=orthogonal?routeCorners(points):[];
 const storedHeading=selectedRoute?.initialHeadingRad;
 initialHeadingManual.value=typeof storedHeading==='number'&&Number.isFinite(storedHeading);
 bodyYawDeg.value=initialHeadingManual.value?Math.round(norm360(storedHeading!*180/Math.PI)*100)/100:firstLegHeadingDeg(routeAnchors.value);
 editingRoute.value=true;error.value='';message.value=orthogonal?'可拖动路点调整路径，或单击地图追加路点':'单击地图设计新路径；原示教路线保留至保存成功';
}
function uniqueRouteName(base:string){
 const mapId=field.value?.id??'';
 const names=new Set(routes.value.filter(route=>route.mapId===mapId).map(route=>route.name));
 if(!names.has(base))return base;
 let index=2;while(names.has(`${base} ${index}`))index+=1;
 return `${base} ${index}`;
}
function beginNewRoute(){
 if(!field.value||routeLocked.value)return;
 orthogonalPreviewMap.value=null;
 routeModes.value=[];routePolicyHistory.value=[];inspectedTagId.value=null;tagInspectorVisible.value=false;selectedSegmentKey.value='';
 routeDetailsOpen.value=false;
 routeTool.value='draw';measuring.value=false;clearMeasurement();routeSelected.value=-1;routeHistory.value=[];routeSkippedHold.value=[];routeEditId.value='';routeEditUpdated.value='';routeAnchors.value=[];initialHeadingManual.value=false;bodyYawDeg.value=0;routeNameDraft.value=uniqueRouteName(field.value.name+'新路径');editingRoute.value=true;error.value='';message.value='新建路径：点击地图追加路点，完成后保存';
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
 // 只有「添加路径点」模式才在空白处追加路点；「选择」模式只用于拖动和点选。
 if(routeTool.value!=='draw')return;
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
function undoRoute(){if(routeLocked.value)return;routeSkippedHold.value=[];const previous=routeHistory.value.at(-1);if(!previous)return;routeAnchors.value=previous;routeHistory.value=routeHistory.value.slice(0,-1);routeModes.value=routePolicyHistory.value.at(-1)??[];routePolicyHistory.value=routePolicyHistory.value.slice(0,-1);routeSelected.value=-1;}
function clearRoute(){if(routeLocked.value||!routeAnchors.value.length)return;rememberRoute();routeAnchors.value=[];routeSelected.value=-1;}
function blockNumericWheel(event:WheelEvent){if(event.target instanceof HTMLInputElement&&event.target.type==='number')event.preventDefault();}
function routeKey(event:KeyboardEvent){
 if(!editingRoute.value||routeLocked.value||event.target instanceof HTMLElement&&(event.target.matches('input,textarea,select')||event.target.isContentEditable))return;
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();undoRoute();}
 else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();deleteRoute();}
}
async function deleteNamedRoute(){const route=routes.value.find(item=>item.routeId===(routeEditId.value||selectedRouteId.value));if(!route){error.value='请先选择要删除的路径';return;}await askDeleteRoute(route);}
async function saveRoute(saveAs=false){await act(async()=>{
 if(!field.value||!editingRoute.value)return;
 if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再保存路径');
 if(routeAnchors.value.length>=2&&!Number.isFinite(bodyYawDeg.value))throw new Error('请先设置有效的初始车头朝向（0–359°）');
 const invalid=routePlans.value.find(plan=>plan.problem);if(invalid)throw new Error(invalid.problem);
 const orthogonalPoints=routeDrawing.value;
 for(let i=1;i<orthogonalPoints.length;i++){const a=orthogonalPoints[i-1]!,b=orthogonalPoints[i]!;
  if(Math.abs(a.x-b.x)>1e-6&&Math.abs(a.y-b.y)>1e-6)throw new Error('路径必须由水平/垂直直线段组成；斜线段请先在画布上正交拆分（拖动路点会自动正交）');
 }
 const skippedCount=routeSkipped.value.length;const initialHeadingDeg=wrapDeg180(bodyYawDeg.value);const payload:any={mapId:field.value.id,baseVersion:version.value,points:orthogonalPoints,bodyYawDeg:initialHeadingDeg,initialHeadingRad:initialHeadingManual.value?initialHeadingDeg*Math.PI/180:null,routeName:routeNameDraft.value.trim()||uniqueRouteName(field.value.name+'新路径'),segmentModes:routePlans.value.filter(plan=>plan.mode!=='auto').map(({fromId,toId,occurrence,mode})=>({fromId,toId,occurrence,mode}))};if(routeEditId.value){payload.routeId=routeEditId.value;payload.routeUpdated=routeEditUpdated.value;}if(saveAs||!routeEditId.value)payload.saveAs=true;
 const result=await api('/route/design',payload);selectMap(result);await refresh();selectedRouteId.value=result.route?.routeId??'';selectedTask.value=result.task?.id??selectedTask.value;selectedMapId.value=field.value.id;
 if(result.route){routeEditId.value=result.route.routeId;routeEditUpdated.value=result.route.updated;routeNameDraft.value=result.route.name;routeModes.value=result.route.motionSegments?choicesFromSegments(result.route.motionSegments):[];}
 editingRoute.value=false;
 const trim=result.trimmed.startM+result.trimmed.endM;message.value=`路径已保存 · 经过 ${new Set(result.map.motionSegments.flatMap((s:any)=>[s.fromId,s.toId])).size} 个定位组 · 每到下一码纠正一次 · 跳过 ${Math.max(skippedCount,result.routeGroups?.skipped.length??0)} 个偏离码`+(trim>.001?` · 已截去定位组外 ${trim.toFixed(2)} m`:'');
 if(savedStrategyBlockers.value.length)message.value='路径规划已保存 · '+savedStrategyBlockers.value[0];
 });}

watch([()=>page.value,()=>field.value?.id],()=>{editingRoute.value=false;routeSelected.value=-1;inspectedTagId.value=null;tagInspectorVisible.value=false;orthogonalPreviewMap.value=null;});
onMounted(()=>{window.addEventListener('keydown',routeKey);window.addEventListener('wheel',blockNumericWheel,{passive:false});});
onBeforeUnmount(()=>{window.removeEventListener('keydown',routeKey);window.removeEventListener('wheel',blockNumericWheel);});
const canNavigate=computed(()=>{if(editingRoute.value||orthogonalPreviewActive.value||speedDirty.value||savedStrategyBlockers.value.length||lateralStrategyBlocked.value)return false;const task=tasks.value.find(t=>t.id===selectedTask.value);return !!task&&task.mapId===field.value?.id&&task.mapVersion===version.value&&field.value?.captureQuality!=='draft'&&robot.value.connected&&robot.value.localization?.mapId===field.value?.id&&robot.value.localization?.mapVersion===version.value&&robot.value.localization?.poseAvailable===true&&!robot.value.running&&robot.value.conditions.length>0&&robot.value.conditions.every((c:any)=>c.ready);});
// 多张地图共用同一批物理二维码时，定位作用域必须跟着"当前选中的地图"走，否则切换后
// 定位仍锚在旧图上，界面只能显示"当前定位属于其他地图"并永久卡住。这里不依赖任务/验收：
// 选图即切换定位，切完等待该地图的二维码重新锚定；能否开始导航仍由 canNavigate 与后端门禁把关。
type ScopePhase='idle'|'switching'|'waiting'|'anchored'|'blocked';
const localizationScope=ref<{phase:ScopePhase;mapId:string;version:number;message:string}>({phase:'idle',mapId:'',version:0,message:''});
let scopeSeq=0;
async function waitScopeAnchored(mapId:string,version:number,seq:number){
 for(let attempt=0;attempt<40;attempt++){
  await new Promise(resolve=>setTimeout(resolve,500));
  if(seq!==scopeSeq)return;
  try{
   const state:any=await api('/localization/scope?mapId='+encodeURIComponent(mapId)+'&version='+version);
   if(seq!==scopeSeq)return;
   if(state.phase==='anchored'){localizationScope.value={phase:'anchored',mapId,version,message:'定位已锚定到当前地图 v'+version};return;}
   if(state.phase==='waiting-anchor'){localizationScope.value={phase:'waiting',mapId,version,message:'已切换到当前地图 v'+version+'，等待二维码重新锚定'};continue;}
   localizationScope.value={phase:'switching',mapId,version,message:'正在切换定位到当前地图 v'+version};
  }catch{/* 轮询失败保持上一状态，绝不把未锚定显示成已锚定 */}
 }
}
async function syncLocalizationScope(){
 const map=field.value;if(!map||!robot.value.connected||robot.value.running)return;
 const mapId=map.id,mapVersion=version.value;
 if(localizationScope.value.mapId===mapId&&localizationScope.value.version===mapVersion&&localizationScope.value.phase==='anchored')return;
 const seq=++scopeSeq;
 try{
  await api('/localization/map',{mapId,version:mapVersion});
  if(seq!==scopeSeq)return;
  localizationScope.value={phase:'switching',mapId,version:mapVersion,message:'正在切换定位到当前地图 v'+mapVersion};
  void waitScopeAnchored(mapId,mapVersion,seq);
 }catch(error){
  if(seq!==scopeSeq)return;
  localizationScope.value={phase:'blocked',mapId,version:mapVersion,message:String((error as Error)?.message??error)};
 }
}
watch([()=>field.value?.id,()=>version.value,()=>robot.value.connected],()=>{void syncLocalizationScope();});
const pendingConditions=computed(()=>robot.value.conditions.filter((condition:any)=>!condition.ready));
const diagnosticsSummary=computed(()=>!robot.value.connected?'设备离线':!robot.value.conditions.length?'等待设备状态':pendingConditions.value.length?`${pendingConditions.value.length} 项待恢复`:'设备正常');
const navigationBlockReason=computed(()=>{
 if(robot.value.running||canNavigate.value)return '';
 if(orthogonalPreviewActive.value)return '正交校正预览中，请应用或撤销预览后再继续';
 if(editingRoute.value)return '请保存路径或退出编辑后再开始导航';
 const task=tasks.value.find(t=>t.id===selectedTask.value);
 if(!task)return field.value?(availableRoutes.value.length?'请选择执行路径':'地图已保存，尚未创建路径；请先新建路径'):'请选择导航地图';
 if(speedDirty.value)return '请先保存速度设置';
 if(savedStrategyBlockers.value.length)return savedStrategyBlockers.value[0];
 if(lateralStrategyBlocked.value)return '横移能力尚未由当前导航节点确认，禁止执行显式平移策略';
 if(task.mapId!==field.value?.id||task.mapVersion!==version.value)return '所选任务与当前地图不一致，请重新选择';
 if(field.value?.captureQuality==='draft')return '该地图是临时采集草稿，请完成正式扫描后再导航';
 if(!robot.value.connected)return '等待导航服务连接';
 const scope=robot.value.localization;
 if(!scope||scope.mapId!==field.value.id||scope.mapVersion!==version.value)return localizationScope.value.message||'正在切换定位到当前地图，等待定位锚定';
 if(scope.poseAvailable!==true)return '已切换到当前地图，等待二维码重新锚定';
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
 scan:{title:'扫描建图',description:'采集二维码位置并保存地图。'},
 navigate:{title:'导航监控',description:'选择地图与路径，开始 / 暂停 / 停止。'},
 print:{title:'二维码 PDF',description:'生成尺寸准确的定位板。'},
 camera:{title:'摄像头预览',description:'检查定位画面与相机参数。'},
 calibration:{title:'融合标定',description:'被动采集二维码、轮速与 IMU 样本，校核比例与转角，不发送运动指令。'}
};
// 路径编辑控制台：所有数值都从 routeAnchors / routePlans / 当前任务派生，
// 不新增地图写入、不新增运动接口，也不伪造后端没有的字段。
const headingTitle=computed(()=>editingRoute.value?'二维码导航路径编辑':pageContent[page.value].title);
const headingDescription=computed(()=>editingRoute.value?'选择路径点、连接二维码点并生成导航任务；右侧编辑节点属性，底部核对路径指令列表。':pageContent[page.value].description);
const groupLabel=(id:number)=>'Q'+String(id).padStart(3,'0');
const nearestGroupId=(point:Point)=>{
 if(!field.value)return null;
 let best:{id:number,d:number}|undefined;
 for(const center of routeGroupCenters(field.value)){const d=distance(point,center);if(!best||d<best.d)best={id:center.id,d};}
 return best&&best.d<=ROUTE_GRID?best.id:null;
};
// 一段的"动作类型"取自真实分段规划：找到终点落在该路点上的那段。
const planArriving=(point:Point)=>routePlans.value.find(plan=>distance(plan.end,point)<=ROUTE_GRID);
const nodeName=(index:number)=>{
 const point=routeAnchors.value[index];if(!point)return '';
 const groupId=nearestGroupId(point);
 return groupId===null?'P'+String(index+1).padStart(2,'0'):groupLabel(groupId);
};
const modeShortLabels:Record<string,string>={auto:'自动',forward:'前进',reverse:'倒车',left:'左平移',right:'右平移',turn_forward:'转向前进'};
// 节点属性里的下拉用短标签：左侧「初始车头朝向」定的是车头角度，这里是这一段怎么走，两回事。
const nodeModeOptions=[{value:'auto',label:'自动'},{value:'forward',label:'前进'},{value:'reverse',label:'倒车'},{value:'left',label:'左平移'},{value:'right',label:'右平移'},{value:'turn_forward',label:'转向前进'}] as const;
// 速度/停留都是任务级真实字段：速度按动作类型取对应分量，停留取终点等待时间。
const taskSpeedsMps=computed(()=>({
 forward:Number(speedSettings.value.forwardSpeed)/100,
 reverse:Number(speedSettings.value.reverseSpeed)/100,
 lateral:Number(speedSettings.value.lateralSpeed)/100
}));
const taskDwellS=computed(()=>selectedNavigationTask.value?.endWaitSeconds??0);
function speedForMode(mode?:string){
 return mode==='reverse'?taskSpeedsMps.value.reverse:(mode==='left'||mode==='right')?taskSpeedsMps.value.lateral:taskSpeedsMps.value.forward;
}
// 作业速度以 m/s 编辑，内部仍写回模型规定的 cm/s 字段并复用既有保存接口。
const workSpeedMps=computed({
 get:()=>Number(speedSettings.value.forwardSpeed)/100,
 set:(value:number)=>{if(Number.isFinite(value))speedSettings.value.forwardSpeed=Math.round(value*100);}
});
// 路径指令列表：一行一个路点（步骤），可直接上移 / 下移 / 删除，全部作用于真实路点数组。
const stepRows=computed(()=>routeAnchors.value.map((point,index)=>{
 const previous=index>0?routeAnchors.value[index-1]:null;
 const plan=index>0?planArriving(point):undefined;
 const groupId=nearestGroupId(point);
 return{
  key:index,
  index:index+1,
  name:(previous?nodeName(index-1)+' → ':'')+nodeName(index),
  type:plan?(modeShortLabels[plan.effective]??plan.effective):index===0?'起点':'途经点',
  mode:plan?.mode??'auto',
  coord:point?`${point.x.toFixed(2)}, ${point.y.toFixed(2)}`:'',
  qrLabel:groupId===null?'—':groupLabel(groupId),
  speedMps:speedForMode(plan?.effective),
  lengthM:previous?distance(previous,point):0,
  headingDeg:plan?Math.round(plan.arrivalYaw*180/Math.PI*100)/100:null,
  dwellS:index===routeAnchors.value.length-1?taskDwellS.value:0,
  blocked:!!(plan?.problem||plan?.blocked)
 };
}));
const stepBlockedCount=computed(()=>stepRows.value.filter(row=>row.blocked).length);
function reorderAnchors(from:number,to:number){
 if(routeLocked.value||from===to||from<0||to<0||from>=routeAnchors.value.length||to>=routeAnchors.value.length)return false;
 rememberRoute();
 const next=[...routeAnchors.value];
 const [moved]=next.splice(from,1);
 next.splice(to,0,moved!);
 routeAnchors.value=next;
 routeSelected.value=to;
 return true;
}
function moveStepUp(index:number){return reorderAnchors(index,index-1);}
function moveStepDown(index:number){return reorderAnchors(index,index+1);}
// 点选底部某一步：同时选中路点与它对应的那一段，画布上会整段标红。
function selectStep(index:number){
 routeSelected.value=index;
 const point=routeAnchors.value[index];
 const plan=point?planArriving(point):undefined;
 selectedSegmentKey.value=plan?.key??'';
}
function deleteStep(index:number){
 if(routeLocked.value||index<0||index>=routeAnchors.value.length)return;
 rememberRoute();
 routeAnchors.value=routeAnchors.value.filter((_,i)=>i!==index);
 routeSelected.value=-1;
}
// 节点属性里的"动作类型"：直接改真实分段策略，与右侧码间运动策略是同一份数据。
function setStepMode(index:number,mode:StrategyMode){
 const point=routeAnchors.value[index];if(!point)return;
 const plan=planArriving(point);if(!plan)return;
 changeSegmentMode(plan,mode);
}
// 自动生成航行路径：按地图里已有的真实路线（rows）生成一串可编辑路点。
// 注意：加载已有路径时接口返回的 map 不带 rows，此时回退到基础上图的 rows。
const sourceRows=computed(()=>{
 const fieldRows=field.value?.rows??[];
 if(fieldRows.length)return fieldRows;
 return map.value?.rows??[];
});
function generateRouteFromRows(){
 if(!field.value||routeLocked.value)return;
 const rows=sourceRows.value;
 let raw:Point[]=[];
 if(rows.length){
  raw=rows.flatMap(row=>[exitPoint(row),...row.points]);
 }else{
  // 没有行数据时（加载已有路径的接口会去掉 rows），按地图里真实的定位码分行蛇形生成。
  const centers=routeGroupCenters(field.value);
  if(centers.length<2){error.value='当前地图可用的定位码不足两个，无法自动生成路径';return;}
  const rowOf=(centerId:number)=>field.value!.tags.find(tag=>tag.id===centerId)?.rowId??'';
  const rowIds=field.value.order?.length?field.value.order:[...new Set(centers.map(center=>rowOf(center.id)))];
  const buckets=rowIds.map(id=>centers.filter(center=>rowOf(center.id)===id)).filter(list=>list.length);
  const leftovers=centers.filter(center=>!buckets.some(list=>list.some(item=>item.id===center.id)));
  if(leftovers.length)buckets.push(leftovers);
  const ordered:Point[]=[];
  buckets.forEach((list,index)=>{
   const sorted=[...list];
   const xs=sorted.map(item=>item.x),ys=sorted.map(item=>item.y);
   const horizontal=(Math.max(...xs)-Math.min(...xs))>=(Math.max(...ys)-Math.min(...ys));
   sorted.sort((a,b)=>horizontal?a.x-b.x:a.y-b.y);
   if(index%2===1)sorted.reverse();
   ordered.push(...sorted.map(({x,y})=>({x,y})));
  });
  raw=ordered;
 }
 if(raw.length<2){error.value='当前地图没有可用的路线数据，请用「添加路径点」在画布上绘制';return;}
 rememberRoute();
 routeAnchors.value=routeCorners(raw);
 routeSelected.value=routeAnchors.value.length?0:-1;
 error.value='';
 message.value=rows.length?'已按地图现有行路线生成航行路径，可继续拖动或用「连接路径」串码':'已按定位码分行生成蛇形航行路径，可继续拖动或用「连接路径」串码';
}
function enterRouteEditing(){
 if(editingRoute.value||!field.value||routeLocked.value)return;
 page.value='navigate';
 void nextTick(()=>{if(!editingRoute.value&&field.value)(selectedRouteId.value||field.value.rows.length)?beginRoute():beginNewRoute();});
}
const robotStateLabels:Record<string,string>={OFFLINE:'未连接',IDLE:'待命',INITIALIZING:'准备中',SEGMENT_ALIGN:'档位与轮角确认',FORWARD:'前进中',REVERSE:'倒车中',LATERAL_SHIFT:'平移中',ROW_END:'到点停车',ROW_EXIT:'退出区间',SWITCH_TO_LATERAL:'切换平移',SWITCH_TO_ACKERMANN:'恢复行驶模式',NEXT_ROW:'准备下一段',FINISHED:'任务完成',FAULT:'故障待处理'};
const robotStateLabel=computed(()=>!bridgeOnline.value?'未连接':robot.value.paused?'已暂停':robotStateLabels[robot.value.state]??'状态更新中');
onMounted(()=>{connect();void refreshPreview();void act(async()=>{await refresh();const current=sessions.value.find(s=>s.state==='collecting');if(current){selectSession(await api('/surveys/'+current.id));scanView.value='camera';}else if(sessions.value[0]){selectSession(await api('/surveys/'+sessions.value[0].id));}if(maps.value.length){selectedMapId.value=maps.value[0]!.id;selectMap(await api('/maps/'+selectedMapId.value));}});poll=setInterval(()=>{void refreshPreview();void pollSession();},2000);});
onMounted(()=>{posePoll=setInterval(()=>poseClock.value=performance.now(),100);});
onBeforeUnmount(()=>{closed=true;navigationAbort?.abort();clearInterval(poll);clearInterval(posePoll);clearTimeout(reconnect);socket?.close();});
</script>
<template>
 <div :class="['app-shell',{'is-route-editing':editingRoute,'is-sidebar-collapsed':sidebarCollapsed}]">
  <aside class="sidebar"><div class="brand"><span class="brand-icon" aria-hidden="true"><i/><i/><i/><i/></span><div><strong>QR 导航控制台</strong><small>v1.0.0</small></div></div><button type="button" class="sidebar-toggle" data-testid="sidebar-toggle" :aria-label="sidebarCollapsed?'展开左侧导航':'收起左侧导航'" :aria-expanded="!sidebarCollapsed" @click="sidebarCollapsed=!sidebarCollapsed">{{sidebarCollapsed?'»':'«'}}</button>
   <nav aria-label="主导航"><span class="nav-group-label">作业</span><button :class="['nav-item',{active:page==='scan'}]" :aria-current="page==='scan'?'page':undefined" title="扫描建图" @click="editingRoute=false;page='scan'"><ScanLine :size="19"/>扫描建图</button><button :class="['nav-item',{active:page==='navigate'&&!editingRoute}]" :aria-current="page==='navigate'&&!editingRoute?'page':undefined" title="开始导航" @click="editingRoute=false;page='navigate'"><Navigation :size="19"/>开始导航</button><button :class="['nav-item',{active:editingRoute}]" :aria-current="editingRoute?'page':undefined" title="路径编辑" data-testid="nav-route-edit" @click="enterRouteEditing"><PenLine :size="19"/>路径编辑</button><span class="nav-group-label">标定</span><button :class="['nav-item',{active:page==='calibration'}]" :aria-current="page==='calibration'?'page':undefined" title="融合标定" data-testid="nav-calibration" @click="editingRoute=false;page='calibration'"><Crosshair :size="19"/>融合标定</button><span class="nav-group-label">资源</span><button :class="['nav-item',{active:page==='print'}]" :aria-current="page==='print'?'page':undefined" title="二维码 PDF" @click="editingRoute=false;page='print'"><FileText :size="19"/>二维码 PDF</button><button :class="['nav-item',{active:page==='camera'}]" :aria-current="page==='camera'?'page':undefined" title="摄像头预览" @click="editingRoute=false;page='camera'"><Camera :size="19"/>摄像头预览</button></nav>
   <div class="sidebar-bottom"><span :class="['connection-dot',{online:connected}]"/><div>{{connected?'网页服务在线':'服务正在重连'}}<small>QR Navigation · v1.0.0</small></div></div>
  </aside>
  <main class="workspace">
   <header class="topbar"><div class="page-heading"><h1>{{headingTitle}}<span v-if="page==='scan'||page==='navigate'" class="badge">{{editingRoute?'路径编辑中':page==='scan'?(session?.state==='collecting'?'扫描中':'待扫描'):field?.coordinateStatus==='reviewed'?'已验收坐标':'扫描坐标'}}</span></h1><p>{{headingDescription}}</p></div><div class="global-status" data-testid="global-status" aria-label="全局状态"><span :class="['status-badge',connected?'success':'warning']"><i/>网页服务 · {{connected?'在线':'重连中'}}</span><span :class="['status-badge',bridgeOnline?'success':'neutral']"><i/>机器人 · {{bridgeOnline?'已连接':'未连接'}}</span><span :class="['status-badge',robot.running?(robot.paused?'warning':'success'):'neutral']" data-testid="robot-run-status"><i/>{{robot.running?(robot.paused?'任务已暂停':'任务执行中'):'任务待启动'}}</span><span class="global-task" :title="selectedNavigationTask?.name??'未选择任务'">{{selectedNavigationTask?.name??'未选择任务'}}</span></div></header>
   <div v-if="error&&page!=='print'&&!editingRoute" class="scan-alert" role="alert"><AlertTriangle :size="20"/>{{error}}</div><div v-if="message&&page!=='print'&&!editingRoute" class="message" role="status"><CheckCircle2 :size="20"/>{{message}}</div>
   <div v-if="commandFeedback&&page==='navigate'" :class="commandFeedback.state==='confirmed'?'message':commandFeedback.state==='waiting'?'scan-detector-status':'scan-alert'" :role="commandFeedback.state==='rejected'||commandFeedback.state==='unconfirmed'?'alert':'status'" data-testid="command-feedback" :data-command-id="commandFeedback.id" :data-state="commandFeedback.state"><CheckCircle2 v-if="commandFeedback.state==='confirmed'" :size="20"/><Radio v-else-if="commandFeedback.state==='waiting'" :size="20"/><AlertTriangle v-else :size="20"/>{{commandFeedback.text}}</div>
   <!-- 自用版：顶部商业化“作业概览”统计卡已移除，信息保留在右侧诊断面板。 -->
   <!--
    融合标定：KeepAlive 必须常驻在 v-if/v-else-if 链之外。
    以前把 KeepAlive 直接写成 v-else-if="page==='calibration'" 的一个分支，切页时 KeepAlive 自己也被卸载，
    缓存随之销毁 → CalibrationWorkspace 真的 unmount，onDeactivated 不触发，
    地图/会话/tagA/tagB/baselineM/试验表单全部回到默认值。把条件移到内部子节点即可真正缓存。
   -->
   <KeepAlive>
    <CalibrationWorkspace v-if="page==='calibration'" :maps="maps"/>
   </KeepAlive>
   <CameraPreview v-if="page==='camera'"/>
   <PdfGenerator v-else-if="page==='print'" @generated="generated"/>
   <div v-else-if="page!=='calibration'" class="editor-body">
    <aside v-if="editingRoute" class="route-tools-panel" data-testid="route-tools-panel" aria-label="路径工具与参数">
     <div class="route-tool-card">
      <button type="button" class="panel-title panel-toggle" :aria-expanded="toolsOpen" @click="toolsOpen=!toolsOpen"><PenLine :size="18"/>路径工具<span class="panel-caret">{{toolsOpen?'▾':'▸'}}</span></button>
      <div v-show="toolsOpen">
      <div class="route-tool-list">
       <Button size="sm" :variant="routeTool==='select'?'default':'outline'" class="route-tool-mode" data-testid="route-select-tool" title="选择：单击选中路点，拖动方块移动，不会新增路点" :aria-pressed="routeTool==='select'" @click="routeTool='select'"><Hand :size="15"/>选择（拖动点位）<span v-if="routeTool==='select'" class="route-tool-now">当前</span></Button>
       <Button size="sm" :variant="routeTool==='draw'?'default':'outline'" class="route-tool-mode" data-testid="route-draw-tool" title="添加路径点：单击地图追加路点" :aria-pressed="routeTool==='draw'" @click="routeTool='draw'"><PenLine :size="15"/>添加路径点<span v-if="routeTool==='draw'" class="route-tool-now">当前</span></Button>
       <Button size="sm" :variant="routeTool==='pan'?'default':'outline'" class="route-tool-mode" data-testid="route-pan-tool" title="移动地图：左键拖图，不增加或移动路点" :aria-pressed="routeTool==='pan'" @click="routeTool='pan'"><Move :size="15"/>移动地图<span v-if="routeTool==='pan'" class="route-tool-now">当前</span></Button>
       <Button size="sm" variant="outline" :disabled="routeLocked||routeDrawing.length<2" data-testid="auto-chain-route" title="连接路径：沿绘制方向自动串起途经的定位码" @click="autoChainRoute"><Link2 :size="15"/>连接路径</Button>
       <Button size="sm" variant="outline" :disabled="routeLocked||!field" data-testid="generate-route-from-rows" title="自动生成航行路径：优先按地图行路线，没有行数据时按定位码分行生成" @click="generateRouteFromRows"><Route :size="15"/>自动生成航行路径</Button>
       <Button size="sm" variant="outline" class="route-tool-danger" :disabled="routeLocked||routeSelected<0" @click="deleteRoute"><Trash2 :size="15"/>删除选中</Button>
       <Button size="sm" variant="outline" :disabled="routeLocked||!routeHistory.length" @click="undoRoute"><RotateCcw :size="15"/>撤销</Button>
      </div>
      <div class="route-tool-hint" role="status"><span :class="['route-tool-dot','is-'+routeTool]"/>{{routeTool==='select'?'选择模式：单击选中路点、拖动方块调整；不会新增路点':routeTool==='draw'?'添加模式：单击地图追加路点，拖动方块调整':'移动模式：左键拖动画布，不改变路点'}}</div>
       <div class="route-tool-extra">
        <Button size="sm" variant="outline" :disabled="routeLocked||!routeDrawing.length" @click="clearRoute">清空</Button>
        <Button size="sm" variant="outline" :disabled="routeLocked||routeDrawing.length<2" @click="saveRoute(true)">另存为</Button>
        <Button size="sm" variant="outline" :disabled="routeLocked||!selectedRouteId" @click="deleteNamedRoute">删除路径</Button>
        <Button size="sm" variant="outline" :disabled="routeLocked||routeSelected<0" @click="deleteRoute">删除路点</Button>
       </div>
       <div v-if="routeSkipped.length" class="route-skipped-groups" data-testid="route-skipped-groups" role="status"><p v-for="tag in routeSkipped" :key="tag.id">Q{{String(tag.id).padStart(3,'0')}} · 偏离路线 {{(tag.distanceM*100).toFixed(1)}} cm，未串联：建议把路线画过此码或调整铺码</p></div>
      </div>
     </div>
     <div class="route-tool-card">
      <button type="button" class="panel-title panel-toggle" :aria-expanded="paramsOpen" @click="paramsOpen=!paramsOpen"><Settings2 :size="18"/>路径参数设置<span class="panel-caret">{{paramsOpen?'▾':'▸'}}</span></button>
      <div v-show="paramsOpen">
      <div class="route-param-row"><span>路径名称</span><span class="route-name-field route-name-auto" data-testid="route-name-field" :title="routeNameDraft">{{routeNameDraft||'保存时自动命名'}}</span></div>
      <div class="route-param-row"><span>路点 / 长度</span><b class="route-metric">{{routeAnchors.length}} 点 · {{routeLength.toFixed(2)}} m</b></div>
      <div class="route-param-row"><span>经过 / 跳过</span><span class="badge route-group-badge" data-testid="route-group-badge" title="每到下一定位码纠正一次">经过 {{routeGroupIds.length}} · 跳过 {{routeSkipped.length}}</span></div>
      <div class="route-param-row"><span>作业速度 (m/s)</span><span class="route-speed-box"><input v-model.number="workSpeedMps" type="number" min="0.02" max="0.2" step="0.01" aria-label="作业速度（米每秒）" :disabled="routeLocked||robot.running||!selectedTask"/><Button v-if="speedDirty" size="sm" variant="outline" :disabled="routeLocked||robot.running||!selectedTask" @click="saveSpeeds">保存</Button><small v-else class="route-speed-saved">{{selectedTask?'已保存':'先选任务'}}</small></span></div>
      <div class="route-heading-panel" data-testid="route-initial-heading">
       <div class="route-heading-summary"><strong>初始车头朝向</strong><b>{{bodyYawDeg.toFixed(1)}}°</b><span :class="['route-heading-tag',initialHeadingManual?'is-manual':'is-auto']">{{initialHeadingManual?'手动':'默认'}}</span></div>
       <div class="route-heading-controls">
        <Button size="sm" variant="outline" :disabled="routeLocked" aria-label="初始朝向减15度" @click="nudgeInitialHeading(-15)">−15°</Button>
        <input class="route-heading-input" type="number" min="0" max="359" step="15" :value="bodyYawDeg" :disabled="routeLocked" aria-label="路径初始车头朝向（0-359度）" @input="setInitialHeading(($event.target as HTMLInputElement).valueAsNumber)"/>
        <Button size="sm" variant="outline" :disabled="routeLocked" aria-label="初始朝向加15度" @click="nudgeInitialHeading(15)">+15°</Button>
       </div>
       <div class="route-heading-controls">
        <Button size="sm" variant="ghost" :disabled="routeLocked" data-testid="adopt-first-leg-heading" @click="adoptFirstLegHeading">采用第一段方向</Button>
        <Button size="sm" variant="ghost" :disabled="routeLocked||!initialHeadingManual" data-testid="reset-initial-heading" @click="resetInitialHeading">恢复默认</Button>
       </div>
      </div>
      </div>
     </div>
    </aside>
    <section class="left-panel" v-if="page==='scan'">
     <div class="panel-title"><ScanLine :size="18"/>扫描控制</div>
     <div class="auto-name" data-testid="scan-auto-name"><span>记录名</span><b>{{name||'开始扫描时自动生成'}}</b><small>自动生成</small></div>
     <Button class="w-full mt-4" :disabled="busy||session?.state==='collecting'||orthogonalPreviewActive" @click="start"><ScanLine :size="20"/>开始扫描</Button>
     <Button class="w-full mt-2" variant="outline" :disabled="busy||!session||orthogonalPreviewActive" @click="finish"><CheckCircle2 :size="18"/>{{busy?'正在处理…':session?.state==='collecting'?'完成扫描并保存地图':'整理记录并保存地图'}}</Button>
     <Button v-if="session?.state==='stopped'" class="w-full mt-2" variant="outline" :disabled="busy||originChanged||orthogonalPreviewActive" @click="resume">继续补扫此记录</Button>
     <div class="state-card" data-testid="capture-state"><span>{{session?.state==='collecting'?'正在记录':session?'已保存':'未开始'}}</span><strong data-testid="capture-count">已采集 {{capturePointCount}} 个定位点 · {{captureSampleCount}} 帧</strong><small>{{session?.captureQuality==='draft'?'草稿':'同步'}}观测 · 定位点按独立二维码 / 定位板去重</small><details v-if="session?.state==='collecting'&&scanWaitReasons.length" class="capture-diagnostics"><summary>采集诊断</summary><small class="scan-wait" role="status">等待：{{scanWaitReasons.join('；')}}。条件恢复后将继续采集；已采集记录保留。</small></details></div>
     <ScanRecords :records="sessions" :selected-id="session?.id" :busy="busy" :selection-disabled="session?.state==='collecting'" :error="error" @select="loadSession" @delete="removeSession" @refresh="refreshSurveys"/>
     <div class="scan-map-maintenance" data-testid="scan-map-maintenance">
      <template v-if="scanMap">
       <template v-if="scanMap.routeMode==='map-only'">
        <div class="map-rebuild-actions"><Button class="w-full" variant="outline" data-testid="rebuild-map-from-survey" :disabled="busy||robot.running||orthogonalPreviewActive||session?.state==='collecting'" @click="rebuildScanMap">从原始扫描重建新版本</Button></div>
        <OrthogonalCorrectionPanel :map="scanMap" :version="scanMapVersion" :disabled="busy||robot.running||session?.state==='collecting'" @preview-map="setOrthogonalPreview" @applied="onScanMapApplied"/>
       </template>
       <p v-else class="scan-map-maintenance-hint">该地图已包含路径，重建与正交校正只对未建路径的定位码地图开放；如需清理可直接删除。</p>
       <div class="map-delete-actions" data-testid="scan-map-delete"><Button class="w-full" variant="destructive" data-testid="delete-scan-map" :disabled="busy||robot.running||orthogonalPreviewActive||session?.state==='collecting'" @click="askDeleteMap(scanMap.id,scanMap.name)"><Trash2 :size="16"/>删除此地图</Button></div>
       <MapDeleteConfirm :info="mapDeletion" :busy="busy" @confirm="confirmDeleteMap" @cancel="mapDeletion=null"/>
      </template>
      <p v-else class="scan-map-maintenance-hint">{{!session?'先在上方「已保存扫描」中选择一条记录。':session.state==='collecting'?'该扫描正在采集，停止后才能重建或校正地图。':'该扫描尚未保存地图；点击「完成扫描并保存地图」后此处会出现重建与校正入口。'}}</p>
     </div>
     
    </section>
    <section v-else-if="page==='navigate'&&!editingRoute" class="left-panel navigation-panel"><div class="navigation-settings"><div class="panel-title"><Navigation :size="18"/>导航控制</div><label>导航地图<select v-model="selectedMapId" :disabled="busy||robot.running||editingRoute" data-testid="map-select" @change="chooseMap"><option value="">选择扫描地图</option><option v-for="mapOption in availableMaps" :key="mapOption.id" :value="mapOption.id">{{mapOption.name}}</option></select></label><label>执行路径<select v-model="selectedRouteId" :disabled="busy||robot.running||editingRoute" data-testid="route-select" @change="chooseRoute"><option value="">选择路径</option><option v-for="route in availableRoutes" :key="route.routeId" :value="route.routeId">{{route.name}}</option></select></label>
     <div class="map-delete-actions" data-testid="navigation-map-delete"><Button class="w-full" variant="outline" size="sm" data-testid="delete-selected-map" :disabled="busy||robot.running||!selectedMapId" @click="askDeleteMap(selectedMapId,field?.name??'')"><Trash2 :size="16"/>删除当前地图</Button><small>先列出将一并删除的版本、路径与任务绑定，再确认。</small></div>
     <MapDeleteConfirm :info="mapDeletion" :busy="busy" @confirm="confirmDeleteMap" @cancel="mapDeletion=null"/>
     <div v-if="availableRoutes.length" class="route-manage-list" data-testid="route-manage-list">
      <div class="route-manage-title">本图路径 · {{availableRoutes.length}}</div>
      <div v-for="route in availableRoutes" :key="route.routeId" :class="['route-manage-row',{active:route.routeId===selectedRouteId}]">
       <button type="button" class="route-manage-name" :disabled="busy||robot.running" @click="pickRoute(route.routeId)">{{route.name}}<small>{{route.points.length}} 点 · 地图 v{{route.mapVersion}}</small></button>
       <Button size="sm" variant="ghost" class="route-manage-delete" :disabled="busy||robot.running" :aria-label="'删除路径 '+route.name" data-testid="delete-route" @click="askDeleteRoute(route)"><Trash2 :size="16"/></Button>
      </div>
      <div v-if="routeDeletion" class="route-delete-confirm" role="alertdialog" data-testid="route-delete-confirm"><span>删除路径「{{routeDeletion.name}}」？<template v-if="routeDeletion.tasks.length">该路径被 {{routeDeletion.tasks.length}} 个导航任务引用（{{routeDeletion.tasks.map(task=>task.name).join('、')}}），确认后将同时移除这些任务绑定。</template><template v-else>此操作不可撤销。</template></span><div><Button variant="outline" size="sm" :disabled="busy" @click="routeDeletion=null">取消</Button><Button variant="destructive" size="sm" :disabled="busy" data-testid="confirm-delete-route" @click="confirmDeleteRoute">确认删除</Button></div></div>
     </div>
     <div class="state-card"><span>车辆状态</span><strong>{{robotStateLabel}}</strong><small>{{robot.rowId||'等待任务'}}</small></div>
     <div v-if="robot.state==='FAULT'" class="scan-alert fault-reason" role="alert" data-testid="robot-fault-reason"><AlertTriangle :size="20"/><span>故障原因：{{faultReason}}</span></div>
     <div class="map-pose-card" data-testid="map-pose-status" role="status"><template v-if="displayedPose"><b>{{displayedPose.sourceLabel}}</b><span>X {{displayedPose.x.toFixed(3)}} m · Y {{displayedPose.y.toFixed(3)}} m</span><span>朝向 {{displayedPose.headingDeg.toFixed(1)}}°</span><small v-if="displayedPose.isStatic">静止已定位 · 运动同步待接入</small></template><template v-else><b>当前地图定位</b><small>{{localizationScope.phase==='anchored'?'等待当前地图的有效位置与朝向':(localizationScope.message||'等待当前地图的有效位置与朝向')}}</small></template><small v-if="robot.localization?.reason">{{robot.localization.reason}}</small></div>
     <div v-if="navigationBlockReason" class="navigation-block-reason" role="status" data-testid="navigation-block-reason"><AlertTriangle :size="17"/><span>{{navigationBlockReason}}</span></div>
     <fieldset class="navigation-speeds" :disabled="busy||robot.running||!selectedTask||commandFeedback?.state==='waiting'">
      <legend>目标速度 · 厘米/秒</legend>
      <div class="speed-grid"><label v-for="item in speedFields" :key="item.key" :for="'navigation-speed-'+item.key">{{item.label}}<input :id="'navigation-speed-'+item.key" v-model.number="speedSettings[item.key]" type="number" min="2" :max="item.max" step="1" :aria-label="item.label+'速度（厘米/秒）'"/></label></div>
      <small>前进 2–20 · 倒车 2–15 · 平移 2–10；转弯自动减速。</small>
      <Button class="w-full mt-2" variant="outline" :disabled="busy||robot.running||!selectedTask||!speedDirty||commandFeedback?.state==='waiting'" @click="saveSpeeds">{{speedDirty?'保存速度':'速度已保存'}}</Button>
      
     </fieldset>
     <Button class="w-full mt-3" :variant="returnToStart?'default':'outline'" :aria-pressed="returnToStart" :disabled="busy||robot.running||!selectedTask||commandFeedback?.state==='waiting'" data-testid="return-to-start-toggle" @click="toggleReturnToStart">完成后原路倒车：{{returnToStart?'开启':'关闭'}}</Button>
     <small v-if="returnToStart" class="muted">前进到终点并停稳后，沿原路线倒车回起点。</small>
     
     <details v-if="field&&unifyAnglesInfo" class="scan-details" data-testid="unify-angles"><summary><Ruler :size="18"/>统一所有码朝向</summary><small class="block">现场所有板子同方向铺设，同一张图里各定位码的朝向角应当一致（仅允许几度噪声）。当前散布 {{unifyAnglesInfo.spreadDeg.toFixed(2)}}°，统一目标（中位数）{{unifyAnglesInfo.targetDeg.toFixed(2)}}°。</small><div class="unify-angle-list"><div v-for="a in unifyAnglesInfo.list" :key="a.id" class="unify-angle-row"><span>Q{{String(a.id).padStart(3,'0')}}</span><span>{{a.angleDeg.toFixed(2)}}°</span><span class="muted">→ {{unifyAnglesInfo.targetDeg.toFixed(2)}}°</span></div></div><Button class="w-full mt-2" :disabled="busy||unifyAnglesInfo.spreadDeg<0.5" @click="unifyAngles">统一朝向并保存新版本</Button><small class="block mt-1">预览只读；只有点击后才会把全部码朝向改为中位数并保存新版本，绝不自动修改。散布小于 0.5° 时无需统一。</small></details>
     <div v-if="field?.routeMode==='map-only'" class="map-rebuild-actions"><Button class="w-full" variant="outline" data-testid="rebuild-map-from-survey" :disabled="busy||robot.running||!selectedMapSurvey||orthogonalPreviewActive" @click="rebuildSelectedMap">从原始扫描重建新版本</Button></div><OrthogonalCorrectionPanel v-if="field?.routeMode==='map-only'" :map="field" :version="version" :disabled="busy||robot.running" @preview-map="setOrthogonalPreview" @applied="onOrthogonalApplied"/>
     
     </div><div class="navigation-actions"><Button class="w-full mt-3" :disabled="busy||commandFeedback?.state==='waiting'||!canNavigate" @click="navigation('start')"><Play :size="20"/>开始导航</Button><div class="export-grid mt-2"><Button variant="outline" :disabled="!robot.running" @click="navigation(robot.paused?'resume':'pause')"><Pause :size="18"/>{{robot.paused?'继续':'暂停'}}</Button><Button variant="destructive" @click="navigation('stop')"><Square :size="18"/>停止</Button></div></div>
    </section>
    <div class="canvas-section"><div class="canvas-toolbar">
     <template v-if="page==='scan'"><Button size="sm" :variant="scanView==='map'?'default':'ghost'" :aria-pressed="scanView==='map'" @click="scanView='map'">地图</Button><Button size="sm" :variant="scanView==='camera'?'default':'ghost'" :aria-pressed="scanView==='camera'" @click="scanView='camera'"><Camera :size="18"/>实时画面</Button></template><span v-else class="canvas-label">导航地图</span>
     <label v-if="page==='scan'&&map" class="capture-trail-toggle"><input v-model="showCaptureTrail" type="checkbox" data-testid="capture-trail-toggle"/>采集轨迹（诊断）</label>
     <Button v-if="map&&page!=='scan'" size="sm" :disabled="editingRoute||map.tags.length<2" :variant="measuring?'default':'outline'" :aria-pressed="measuring" @click="toggleMeasurement"><Ruler :size="18"/>中心测距</Button>
     <template v-if="page==='navigate'&&field&&!editingRoute">
      <Button size="sm" variant="outline" data-testid="new-route" :disabled="routeLocked" @click="beginNewRoute"><PenLine :size="15"/>新建路径</Button>
      <Button v-if="selectedRouteId||field.rows.length" size="sm" variant="outline" :disabled="routeLocked" data-testid="edit-route" @click="beginRoute">编辑路径</Button>
      <Button size="sm" variant="outline" :disabled="!field.tags.length" data-testid="view-tag-reprint" @click="openTagInspector">查看二维码/补打</Button>
     </template>
     <span v-if="map" class="ml-auto badge">{{map.tags.length}} 个定位组 · {{map.routeMode==='map-only'?(!selectedRouteId?'未创建路径':'路径已选（routeMode 仍为 map-only）'):map.rows.length+' 条路线'}}</span>
    </div>
     <div v-if="page==='navigate'&&!editingRoute&&tagInspectorVisible&&field" class="route-details-scroll tag-reprint-popover">
      <div class="route-properties-heading"><strong>查看二维码/补打</strong><Button size="sm" variant="ghost" aria-label="关闭二维码预览" @click="tagInspectorVisible=false">关闭</Button></div>
      <label>地图二维码<select v-model="inspectedTagId" aria-label="查看地图二维码"><option v-for="tag in orderedTagsById(field.tags)" :key="tag.id" :value="tag.id">{{tag.groupId??label(tag.id)}}{{tag.groupId?' · 码组中心':' · 单码'}}</option></select></label>
      <TagInspector v-if="inspectedTagId!==null" :map="field" :version="version" :tag-id="inspectedTagId"/>
     </div>
     <div v-if="editingRoute&&(error||message)" class="route-toast" :class="{'route-toast-error':error}" :role="error?'alert':'status'" :title="error||message">{{error||message}}</div>
     <div v-if="measuring&&map&&(page!=='scan'||scanView==='map')" class="distance-panel">
      <div class="distance-fields"><label>起点<select v-model.number="measureFrom" aria-label="测距起点"><option value="">请选择定位组</option><option v-for="tag in orderedTagsById(map.tags)" :key="tag.id" :value="tag.id">{{measureLabel(tag)}}</option></select></label><span class="distance-arrow">↔</span><label>终点<select v-model.number="measureTo" aria-label="测距终点"><option value="">请选择定位组</option><option v-for="tag in orderedTagsById(map.tags)" :key="tag.id" :value="tag.id">{{measureLabel(tag)}}</option></select></label><Button size="sm" variant="ghost" @click="clearMeasurement">清除测距</Button></div>
      <div class="distance-result" data-testid="center-distance-result" role="status"><strong v-if="centerDistance!==null">中心距离 {{centerDistance.toFixed(3)}} m <span>（{{(centerDistance*100).toFixed(1)}} cm）</span></strong><span v-else>{{measureFrom!==''&&measureTo===measureFrom?'请选择两个不同的定位组':measureFrom!==''?'请点击第二个定位组，或选择测距终点':'点击地图上的两个定位组，或选择起点和终点'}}</span><small>两块二维码板中心的平面直线距离 · 地图计算值{{map.captureQuality==='draft'?'，临时采集草稿':''}}</small></div>
     </div>
     <CameraPreview v-if="page==='scan'&&scanView==='camera'" compact/>
     <MapCanvas v-else-if="canvasMap" :map="canvasMap" :selected="mapSelected" :measurement="mapMeasurement" row-id="" :tool="measuring?'measure':editingRoute?'route-design':'pan'" @select="measureSelect" @inspect="inspectTag" @tag-detail="openTagDetail" :segment-plans="editingRoute?routePlans:undefined" :selected-segment="selectedSegmentKey" @segment-select="selectSegment" :editable="editingRoute&&!routeLocked&&routeTool!=='pan'" :drawing="mapDrawing" :pan-enabled="editingRoute&&routeTool==='pan'" :route-group-ids="routeGroupIds" :route-skipped-groups="routeSkipped" :route-anchors="routeAnchors" :route-selected="routeSelected" :initial-heading="editingRoute?bodyYawDeg*Math.PI/180:undefined" @heading="setInitialHeadingRad" @blank="appendRoute" @design-select="routeSelected=$event" @design-move="moveRoute" :vehicle="mapVehicle??undefined" :trail="mapTrail"/>
     <div v-else class="scan-empty"><div class="empty-illustration"><ScanLine v-if="page==='scan'" :size="32"/><Route v-else :size="32"/></div><strong>{{page==='scan'?'暂无扫描数据':'请选择地图'}}</strong><div class="getting-started" data-testid="getting-started"><h2>{{page==='scan'?'打印并铺设定位板后开始扫描':'选择地图与路径后开始导航'}}</h2><p>{{page==='scan'?'检查相机，点「开始扫描」即可。已有记录可从左侧打开继续整理。':'先选择地图，再选择或新建路径。'}}</p><div><Button size="sm" @click="page=page==='scan'?'print':'scan'">{{page==='scan'?'打印定位板':'前往扫描建图'}}<ArrowRight :size="15"/></Button></div></div></div>
     <div class="legend"><span><i class="tag-dot"/>定位组</span><span><i class="line-green"/>作物行</span></div>
     <div v-if="editingRoute&&tagDetail" class="tag-detail-card" data-testid="tag-detail-card" role="status">
      <div class="tag-detail-head"><strong>{{tagDetail.label}}</strong><button type="button" aria-label="关闭二维码信息" @click="tagDetailId=null">✕</button></div>
      <TagInspector v-if="field&&tagDetail" :map="field" :version="version" :tag-id="tagDetail.id"/>
     </div>
    </div>
    <div v-if="editingRoute" class="route-editor" data-testid="route-editor">
     <div class="route-editor-actions">
      <Button size="sm" :disabled="routeLocked||routeDrawing.length<2" @click="saveRoute(false)">保存路径</Button>
      <Button size="sm" :disabled="!field||field.tags.length<2" :variant="measuring?'default':'outline'" :aria-pressed="measuring" data-testid="edit-center-measure" @click="toggleMeasurement"><Ruler :size="15"/>中心测距</Button>
      <Button size="sm" variant="ghost" :disabled="routeLocked" @click="editingRoute=false;message=''">退出</Button>
      <Button v-if="routeEditId" size="sm" variant="ghost" class="route-editor-delete" data-testid="delete-editing-route" :disabled="routeLocked" @click="deleteNamedRoute"><Trash2 :size="15"/>删除此路径</Button>
     </div>
    </div>
    <section v-if="editingRoute" class="route-commands-panel" data-testid="route-commands-panel" aria-label="路径指令列表">
     <div class="route-commands-head">
      <strong>路径指令列表</strong>
      <span class="badge">{{stepRows.length}} 条</span>
      <span :class="['status-badge',stepBlockedCount?'warning':'success']" data-testid="route-commands-status"><i/>{{stepBlockedCount?stepBlockedCount+' 条需处理':'全部可执行'}}</span>
      <span class="route-commands-ops">
       <Button size="sm" variant="outline" :disabled="routeLocked||routeSelected<=0" @click="moveStepUp(routeSelected)">上移</Button>
       <Button size="sm" variant="outline" :disabled="routeLocked||routeSelected<0||routeSelected>=stepRows.length-1" @click="moveStepDown(routeSelected)">下移</Button>
       <Button size="sm" variant="outline" class="route-tool-danger" :disabled="routeLocked||routeSelected<0" @click="deleteStep(routeSelected)"><Trash2 :size="14"/>删除选中</Button>
      </span>
     </div>
     <div class="route-commands-scroll">
      <table class="route-commands-table">
       <thead><tr><th scope="col">#</th><th scope="col">步骤名称</th><th scope="col">类型</th><th scope="col">关联二维码</th><th scope="col">坐标 (m)</th><th scope="col">速度 / m·s⁻¹</th><th scope="col">距离 / m</th><th scope="col">停留 / s</th><th scope="col">操作</th></tr></thead>
       <tbody>
        <tr v-for="row in stepRows" :key="row.key" :class="{blocked:row.blocked,active:row.key===routeSelected}" @click="selectStep(row.key)">
         <td>{{row.index}}</td><td>{{row.name}}</td>
         <td>
          <select v-if="row.key>0" class="route-type-select" :class="{blocked:row.blocked}" :value="row.mode" :disabled="routeLocked" :aria-label="'第'+row.index+'步本段动作'" @click.stop @change.stop="setStepMode(row.key,($event.target as HTMLSelectElement).value as StrategyMode)">
           <option v-for="option in nodeModeOptions" :key="option.value" :value="option.value">{{option.label}}</option>
          </select>
          <span v-else class="route-command-state is-ok">{{row.type}}</span>
         </td>
         <td>{{row.qrLabel}}</td><td>{{row.coord}}</td><td>{{row.speedMps.toFixed(2)}}</td><td>{{row.lengthM.toFixed(2)}}</td><td>{{row.dwellS.toFixed(1)}}</td>
         <td class="route-command-ops">
          <button type="button" aria-label="上移该步骤" :disabled="routeLocked||row.key===0" @click.stop="moveStepUp(row.key)">↑</button>
          <button type="button" aria-label="下移该步骤" :disabled="routeLocked||row.key>=stepRows.length-1" @click.stop="moveStepDown(row.key)">↓</button>
          <button type="button" class="route-command-remove" aria-label="删除该步骤" :disabled="routeLocked" @click.stop="deleteStep(row.key)">✕</button>
         </td>
        </tr>
       </tbody>
      </table>
       <div v-if="!stepRows.length" class="route-commands-empty">先添加路径点或用「自动生成航行路径」，这里会列出每一步指令。</div>
     </div>
    </section>
    <section v-if="!editingRoute" class="right-panel">
     <div v-if="page==='scan'" class="scan-detector-status" role="status">{{session?.state==='collecting'?'正在记录':session?'采集记录已保存':'等待开始采集'}} · {{capturePointCount}} 个定位点 · {{captureSampleCount}} 帧</div>
     <div v-else class="task-overview"><span>当前任务</span><strong>{{selectedNavigationTask?.name??'等待选择任务'}}</strong><small>{{field?.name??'尚未加载地图'}}</small><div class="task-progress-label"><span>作业状态</span><b>{{robot.running?(robot.paused?'已暂停':'执行中'):editingRoute?'路径编辑中':'待启动'}}</b></div></div>
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
.auto-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 4px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:12px;color:var(--muted)}
.auto-name b{font-weight:500;color:var(--ink);overflow-wrap:anywhere}
.auto-name small{margin-left:auto;font-size:11px;color:#94a3b8}

.route-name-auto{display:inline-flex;align-items:center;gap:6px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--background);font-size:12px;color:var(--muted)}
.route-name-auto small{font-size:10px;color:#94a3b8}
.capture-trail-toggle{display:flex;align-items:center;gap:5px;font-size:12px;margin:0}.capture-trail-toggle input{width:14px;height:14px}.capture-diagnostics{margin-top:8px;font-size:12px}.capture-diagnostics summary{cursor:pointer}.state-card [data-testid="capture-count"]{font-size:15px;line-height:1.5}.tag-reprint-popover{position:absolute;right:8px;top:60px;bottom:32px;width:260px;max-width:calc(100% - 16px);overflow:auto;background:white;border:1px solid var(--line);border-radius:8px;box-shadow:var(--dialog-shadow);padding:12px;z-index:25}.tag-reprint-shortcut{position:absolute;right:12px;top:12px;z-index:5}
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
.unify-angle-list{margin-top:8px;max-height:160px;overflow:auto;border:1px solid var(--panel);border-radius:6px}
.unify-angle-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:4px 8px;border-top:1px solid var(--panel);font-family:var(--mono);font-size:11px}
.unify-angle-row:first-child{border-top:0}
.sensor-line{gap:12px}.sensor-line>span:first-child{flex-shrink:0}.sensor-line .muted-pill{white-space:normal;text-align:right;overflow-wrap:anywhere}.scan-wait{line-height:1.65;overflow-wrap:anywhere}
.sensor-line b{font-size:14px;color:var(--ink);font-weight:500}
.scan-map-maintenance{margin-top:16px;border-top:1px solid var(--panel);padding-top:16px}
.scan-map-maintenance .panel-title{margin-bottom:10px}
.scan-map-maintenance-hint{margin:0;color:var(--muted);font-size:12px;line-height:1.6}
.map-delete-actions{margin-top:14px;display:flex;flex-direction:column;gap:6px}
.map-delete-actions small{color:var(--muted);font-size:12px;line-height:1.6}
.route-heading-panel{margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--background)}
.route-heading-summary{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:13px}
.route-heading-summary strong{font-weight:600;color:var(--ink)}
.route-heading-summary b{font:13px monospace;color:#b45309}
.route-heading-tag{padding:1px 7px;border-radius:999px;font-size:11px;line-height:1.7}
.route-heading-tag.is-auto{background:#fffbeb;color:#b45309}
.route-heading-tag.is-manual{background:#eef2ff;color:#3730a3}
.route-heading-controls{display:flex;align-items:center;gap:6px;margin-top:8px}
.route-heading-controls .route-heading-input{width:86px;min-width:86px;height:32px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;font:13px monospace;text-align:center;background:white;color:var(--ink)}
.route-heading-hint{display:block;margin-top:8px;color:var(--muted);font-size:11px;line-height:1.6}
.route-manage-list{margin-top:12px;border:1px solid var(--panel);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px}
.route-manage-title{font-size:12px;color:var(--muted);letter-spacing:.5px}
.route-manage-row{display:flex;align-items:center;gap:8px;border-radius:8px;padding:2px 4px}
.route-manage-row.active{background:var(--panel)}
.route-manage-name{flex:1;min-width:0;text-align:left;border:0;background:none;color:var(--ink);font-size:13px;padding:6px 4px;display:flex;flex-direction:column;gap:2px}
.route-manage-name small{color:var(--muted);font-size:11px}
.route-manage-name:disabled{opacity:.6}
.route-manage-delete,.route-editor-delete{color:var(--accent)}
.route-delete-confirm{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);margin-top:4px;padding-top:8px;font-size:12px;line-height:1.7;color:var(--accent)}
.route-delete-confirm>div{display:flex;gap:8px;justify-content:flex-end}
@media(max-width:760px){.scan-empty{min-height:350px}}

/* ---------- 折叠：左侧导航 / 卡片标题 / 右侧节点属性面板 ---------- */
.sidebar{position:relative}
.sidebar-toggle{position:absolute;top:20px;right:8px;width:22px;height:22px;border:1px solid var(--line);border-radius:6px;background:white;color:#64748b;font-size:12px;line-height:1;display:grid;place-items:center;z-index:3}
.sidebar-toggle:hover{background:var(--panel);color:var(--accent)}
.app-shell.is-sidebar-collapsed .sidebar{width:64px;padding:16px 8px}
.app-shell.is-sidebar-collapsed .brand{justify-content:center;margin-bottom:20px}
.app-shell.is-sidebar-collapsed .brand>div{display:none}
.app-shell.is-sidebar-collapsed .brand-icon{width:28px;height:28px;padding:6px}
.app-shell.is-sidebar-collapsed .sidebar-toggle{position:static;margin:0 auto 12px;display:grid}
.app-shell.is-sidebar-collapsed .nav-group-label{display:none}
.app-shell.is-sidebar-collapsed .nav-item{justify-content:center;font-size:0;gap:0;padding:10px 0}
.app-shell.is-sidebar-collapsed .nav-item svg{width:20px;height:20px}
.app-shell.is-sidebar-collapsed .sidebar-bottom{justify-content:center;margin:auto 0 0}
.app-shell.is-sidebar-collapsed .sidebar-bottom>div{display:none}

.panel-toggle{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;padding:0;margin:0 0 10px;cursor:pointer;text-align:left;font-size:14px;font-weight:600;color:#1e293b}
.panel-toggle:hover{color:var(--accent)}
.panel-caret{margin-left:auto;color:#94a3b8;font-size:11px}

.app-shell.is-route-editing .route-editor{position:relative}
/* 路径属性：现在放在左侧卡片里，内联滚动，不再浮在画布上 */
.app-shell.is-route-editing .route-details-scroll{position:static;width:auto;max-width:none;max-height:320px;overflow:auto;background:transparent;border:0;box-shadow:none;padding:0;margin-top:0}
.route-props-card{gap:0}
.tag-detail-card .tag-inspector{padding-top:8px}
.tag-detail-card{position:absolute;z-index:35;left:12px;bottom:44px;width:232px;max-height:min(76%,620px);overflow:auto;background:white;border:1px solid var(--line);border-radius:8px;box-shadow:var(--dialog-shadow);padding:10px 12px}
.tag-detail-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.tag-detail-head strong{font-size:13px}
.tag-detail-head button{border:0;background:none;color:#94a3b8;cursor:pointer;font-size:12px;line-height:1}
.tag-detail-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;font-size:12px;color:var(--muted)}
.tag-detail-row b{font:12px var(--mono);color:#334155;white-space:nowrap}

/* ---------- 路径编辑控制台：左侧工具/参数、中间画布、右侧节点属性、底部指令列表 ---------- */
.route-tools-panel{width:272px;flex-shrink:0;display:flex;flex-direction:column;gap:12px;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.route-tool-card{background:white;border:1px solid var(--line);border-radius:8px;box-shadow:var(--card-shadow);padding:14px}
.route-tool-card .panel-title{margin-bottom:10px}
.route-tool-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.route-tool-grid button{width:100%;justify-content:center;min-height:34px}
.route-tool-extra{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
.route-tool-extra button{min-height:30px;height:30px;font-size:12px;padding:0 8px}
.route-tool-list{display:flex;flex-direction:column;gap:5px}
.route-tool-list button{width:100%;justify-content:flex-start;min-height:30px;height:30px;padding:0 10px;font-size:12px;gap:8px}
.route-tool-mode{position:relative}
.route-tool-now{margin-left:auto;font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.22);line-height:1.6}
.route-tool-danger{color:var(--danger)!important;border-color:#fecaca!important;background:#fef2f2!important}
.route-tool-danger:hover:not(:disabled){background:#fee2e2!important}
.route-param-field{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 0;font-size:12px;color:var(--muted)}
.route-param-field input{width:96px;height:32px;font-family:var(--mono);text-align:right}
.route-param-actions{flex-wrap:wrap;gap:6px}
.route-param-actions small{flex:1 1 100%;font-size:10px;color:#94a3b8;line-height:1.5}
.route-commands-ops{display:inline-flex;gap:6px;margin-left:auto}
.route-commands-ops button{min-height:30px;padding:0 10px}
.route-commands-table tbody tr{cursor:pointer}
.route-commands-table tbody tr.active,.route-commands-table tbody tr.active:hover{background:#dbeafe;box-shadow:inset 4px 0 0 var(--accent);font-weight:600}
.route-type-select{width:auto;min-width:96px;height:28px;padding:2px 6px;font-size:12px;border-radius:6px;background:white}
.route-type-select.blocked{border-color:#fde68a;color:#b45309}
.route-commands-table tbody tr.active td{color:#1e3a8a}
.route-command-ops{display:flex;gap:4px}
.route-command-ops button{width:26px;height:26px;padding:0;border:1px solid var(--line);border-radius:6px;background:white;color:#475569;font-size:12px;line-height:1}
.route-command-ops button:disabled{opacity:.4}
.route-command-ops button:not(:disabled):hover{background:var(--panel);border-color:#93c5fd;color:var(--accent)}
.route-command-remove:not(:disabled):hover{background:#fef2f2!important;border-color:#fecaca!important;color:var(--danger)!important}
.node-prop-field{display:flex;flex-direction:column;align-items:stretch;gap:5px;margin:8px 0;font-size:12px;color:var(--muted)}
.node-prop-field select{width:100%;height:32px;font-size:12px;padding:4px 6px}
.route-tool-hint{display:flex;align-items:flex-start;gap:7px;margin-top:10px;padding:8px 9px;border:1px solid #dbeafe;border-radius:6px;background:#f8fbff;color:#1e40af;font-size:11px;line-height:1.6}
.route-tool-dot{flex:0 0 7px;width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--accent)}
.route-tool-dot.is-pan{background:#0f766e}
.route-tool-dot.is-select{background:var(--accent)}
.route-tool-dot.is-draw{background:#b45309}
.route-param-row{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:var(--muted)}
.route-param-row:last-of-type{border-bottom:0}
.route-param-row>span:first-child{white-space:nowrap}
.route-param-row>b{font:12px var(--mono);color:#334155;text-align:right;white-space:nowrap}
.route-param-row>.badge,.route-param-row>.route-name-auto{justify-self:end}
.route-speed-box{display:flex;align-items:center;gap:6px;justify-self:end;min-width:0}
.route-speed-box input{width:78px;height:30px;padding:2px 8px;text-align:right;font-family:var(--mono)}
.route-speed-saved{font-size:11px;color:#94a3b8;white-space:nowrap}
.route-param-row .route-name-auto{max-width:158px}
.route-node-nav{display:inline-flex;gap:4px}
.route-node-nav button{min-height:26px;padding:0 8px;font-size:11px}

.route-commands-panel{flex:0 0 auto;margin-top:12px;background:white;border:1px solid var(--line);border-radius:8px;box-shadow:var(--card-shadow);display:flex;flex-direction:column;overflow:hidden;max-height:min(240px,32dvh)}
.route-commands-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);flex-shrink:0}
.route-commands-head strong{font-size:13px;font-weight:600;color:#1e293b}
.route-commands-head .badge{background:var(--panel);border-color:var(--line);color:var(--muted)}
.route-commands-head .status-badge{margin-left:auto}
.route-commands-scroll{flex:1;min-height:0;overflow:auto}
.route-commands-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.route-commands-table th{position:sticky;top:0;z-index:1;background:var(--panel);color:var(--muted);font-weight:600;font-size:11px;text-align:left;padding:7px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
.route-commands-table td{padding:7px 12px;border-bottom:1px solid #f1f5f9;color:#334155;white-space:nowrap}
.route-commands-table tbody tr:hover{background:#f8fbff}
.route-commands-table tbody tr.blocked{background:#fffbeb}
.route-commands-table tbody tr.blocked td{color:#b45309}
.route-command-state{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;line-height:1.7}
.route-command-state.is-ok{background:#f0fdf4;color:#15803d}
.route-command-state.is-blocked{background:#fef3c7;color:#b45309}
.route-commands-empty{text-align:center;color:var(--muted);padding:18px 12px!important;white-space:normal!important}

.node-prop-card{flex:0 0 auto;margin-top:10px;padding:10px 0 0;border-top:1px solid var(--line)}
.node-prop-card .route-properties-heading small{font-size:11px;color:var(--muted);font-family:var(--mono)}
.node-prop-list{display:flex;flex-direction:column;margin-top:10px}
.node-prop-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:var(--muted)}
.node-prop-row:last-child{border-bottom:0}
.node-prop-row>b{font:12px var(--mono);color:#334155;overflow-wrap:anywhere;text-align:right}
.node-prop-empty{margin:8px 0 0;padding:10px;border:1px dashed var(--line);border-radius:6px;background:var(--panel);color:var(--muted);font-size:11px;line-height:1.7}

.app-shell.is-route-editing .editor-body{position:relative;display:grid;grid-template-columns:272px minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;gap:12px;align-content:stretch}
.app-shell.is-route-editing .route-tools-panel{grid-column:1;grid-row:1/3;min-height:0}
.app-shell.is-route-editing .canvas-section{grid-column:2;grid-row:1;min-height:0}
.app-shell.is-route-editing .route-commands-panel{grid-column:2;grid-row:2;margin-top:0}
.app-shell.is-route-editing .route-editor{position:absolute;z-index:40;top:12px;right:12px;height:auto!important;min-height:0;max-height:none!important;display:flex;flex-direction:row;align-items:center;gap:6px;overflow:visible;background:white;border:1px solid var(--line);border-radius:8px;box-shadow:var(--dialog-shadow);padding:6px}
.app-shell.is-route-editing .route-editor-actions{flex:0 0 auto;flex-wrap:wrap;gap:6px;height:auto}
.app-shell.is-route-editing .route-details-scroll{position:static;flex:1;min-height:0;overflow-y:auto;width:auto;max-width:none;border:0;border-radius:0;box-shadow:none;padding:10px 0 0;margin-top:8px;border-top:1px solid var(--line)}
@media(max-width:1500px){.app-shell.is-route-editing .editor-body{grid-template-columns:248px minmax(0,1fr)}.route-tools-panel{width:248px}}
@media(max-width:1200px){.app-shell.is-route-editing .editor-body{grid-template-columns:236px minmax(0,1fr)}}
@media(max-width:760px){
 .app-shell.is-route-editing .editor-body{display:flex;flex-direction:column;flex-wrap:nowrap;overflow-y:auto;padding:0 12px 12px}
 .app-shell.is-route-editing .canvas-section{order:1;flex:none;height:60dvh;min-height:449px}
 .app-shell.is-route-editing .route-editor{position:static;order:2;flex:none;max-height:none;height:auto;margin-top:8px}
 .app-shell.is-route-editing .route-details-scroll{position:static;width:auto;max-width:none;max-height:none;margin-top:8px}
 .tag-detail-card{position:static;width:auto;margin-top:8px}
 .route-tools-panel{width:100%;overflow:visible;flex:none;order:3}
 .app-shell.is-route-editing .route-commands-panel{order:4;max-height:260px}
 .route-tool-grid{grid-template-columns:1fr 1fr}
 .route-commands-table th,.route-commands-table td{padding:6px 8px}
 /* 移动端父容器高度是 auto，flex:1 + overflow:hidden 会把操作行压成 0 高，必须放开 */
 .app-shell.is-route-editing .route-editor-body{flex:none;min-height:0;overflow:visible}
 .route-rail{flex-direction:row;justify-content:center;margin-top:8px}
}
</style>
