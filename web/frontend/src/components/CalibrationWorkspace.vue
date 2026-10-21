<script setup lang="ts">
/**
 * 融合标定工作区（只读采集 + 标注）。
 *
 * 硬约束：
 * 1. 页面绝不发送运动指令：这里只调用 /api/calibration/*，不触碰 /api/navigation/*、cmd_vel 或解锁接口。
 * 2. 所有样本时间戳由 ROS 桥接节点提供；页面只展示，不生成、不替换。
 * 3. “外部基线”是两块二维码板中心的真实距离，只用于比例校核，不代表车辆实际行程。
 * 4. 应用参数按钮带二次确认；后端本轮只做 dry-run，页面必须显示“未应用”和 proposed/current 差异。
 */
import {computed,nextTick,onActivated,onBeforeUnmount,onDeactivated,ref,watch} from 'vue';
import {Activity,AlertTriangle,CheckCircle2,Download,FlaskConical,MapPin,RefreshCw,Save,Square,SlidersHorizontal,Trash2,XCircle} from 'lucide-vue-next';
import Button from './ui/Button.vue';
import type {CalibrationSession,CalibrationTrial,SessionAnalysis,Stats,TrialAnalysis,TrialStatus,TrialType} from '../../../shared/calibration';

interface MapSummary {id:string;name:string;version:number;created?:string}
interface CalibrationMapTag {id:number;groupId?:string}
interface CalibrationMapDetail {map:{id:string;name:string;tags:CalibrationMapTag[]};version:number}
interface RecorderCapability {supported:boolean;recording:boolean;lastSampleAt:string|null;lastSampleKind:string|null;error:string}
interface Capabilities {nodeRecorder:RecorderCapability;applyEnabled:boolean;applyReason:string}
interface SessionSummary {id:string;mapId:string;mapVersion:number;mapName:string;tagA:number;tagB:number;baselineM:number;note:string;created:string;trialCount:number;analysisSaved:boolean;applied:boolean}
interface SessionDetail {session:CalibrationSession&{mapName?:string};trials:CalibrationTrial[];sampleCounts:{observation:number;feedback:number;imu:number;fusion:number};recording:{trialId:string|null}|null;capabilities?:unknown}
interface ApplyResult {applied:boolean;reason:string;proposed:{forwardScale:number|null;lateralScale:number|null;imuYawScale:number|null;visualImuDelayS?:number|null};current:{forwardScale?:number|null;lateralScale?:number|null;imuYawScale?:number|null;wheelVelocitySigmaMps?:number|null;lateralConstraintSigmaMps?:number|null;captureDelayS?:number|null};analysisSaved:boolean}

const props=defineProps<{maps:MapSummary[]}>();
const busy=ref(false),error=ref(''),message=ref('');

const capabilities=ref<Capabilities|null>(null),capabilityError=ref('');
const sessions=ref<SessionSummary[]>([]),current=ref<SessionDetail|null>(null),sessionLoading=ref(false);
const selectedMapId=ref(''),mapDetail=ref<CalibrationMapDetail|null>(null),mapError=ref('');
const form=ref<{tagA:number|'';tagB:number|'';baselineM:number|'';note:string}>({tagA:'',tagB:'',baselineM:'',note:''});
const trialForm=ref<{type:TrialType;preset:'90'|'180'|'custom';customAngle:number|'';rotationTagId:number|'';note:string}>({type:'left',preset:'90',customAngle:'',rotationTagId:'',note:''});
const analysis=ref<SessionAnalysis|null>(null),analysisSaved=ref(false);
const applyConfirm=ref(false),applyResult=ref<ApplyResult|null>(null);
// 清空试验的二次确认状态：只有用户点“确认清空”才发 DELETE，取消不发任何请求。
const clearConfirm=ref(false);

const typeLabel:Record<TrialType,string>={forward:'前进',reverse:'后退',left:'左转',right:'右转'};
// 物理旋向：内部 yaw 逆时针为正，左转 = 逆时针，右转 = 顺时针。
// 页面只在这里把符号翻译成人能读的旋向，避免把「右转 -90°」读成方向错误。
const senseLabel:Record<'left'|'right',string>={left:'逆时针',right:'顺时针'};
const statusLabel:Record<TrialStatus,string>={recording:'录制中',saved:'已保存',aborted:'已中止',interrupted:'中断'};
const mapTags=computed<CalibrationMapTag[]>(()=>mapDetail.value?.map.tags??[]);
const isTurn=computed(()=>trialForm.value.type==='left'||trialForm.value.type==='right');
const trialAngle=computed<number|null>(()=>{
 if(!isTurn.value)return null;
 const magnitude=trialForm.value.preset==='90'?90:trialForm.value.preset==='180'?180:Number(trialForm.value.customAngle);
 if(!Number.isFinite(magnitude)||magnitude<5||magnitude>180)return null;
 return trialForm.value.type==='left'?magnitude:-magnitude;
});
// 表单提示只给人看「右转 90°（顺时针）」；内部 signed angle 照旧（左正右负），不直接暴露给用户。
const trialAngleText=computed(()=>{
 if(trialAngle.value===null)return '—';
 const direction=trialForm.value.type==='right'?'right':'left';
 return `${typeLabel[direction]} ${Math.abs(trialAngle.value)}°（${senseLabel[direction]}）`;
});
const trials=computed<CalibrationTrial[]>(()=>current.value?.trials??[]);
const recordingTrial=computed<CalibrationTrial|null>(()=>{
 const id=current.value?.recording?.trialId;
 return id?trials.value.find(trial=>trial.id===id)??null:null;
});
const capabilitiesUnknown=computed(()=>!capabilities.value&&!capabilityError.value);
const recorderWarning=computed(()=>{
 if(capabilityError.value)return `标定能力查询失败：${capabilityError.value}。若 ROS 桥接节点未加载标定录音支持，请检查桥接服务并重启后再试。`;
 const recorder=capabilities.value?.nodeRecorder;
 if(recorder&&(!recorder.supported||recorder.error))return `采集节点尚未加载标定录音支持${recorder.error?'：'+recorder.error:''}。请检查桥接服务是否已加载被动录音支持。`;
 return '';
});
const applyRows=[{key:'forwardScale',label:'前进比例'},{key:'lateralScale',label:'横向比例'},{key:'imuYawScale',label:'IMU 转角比例'}] as const;
// 后端实际读取的运行参数（与候选比例不同量纲），有值时单独展示，避免把“当前值”误读成比例候选。
const applyCurrentRows=computed(()=>{
 const current=applyResult.value?.current;
 if(!current)return [] as {label:string;value:number|null|undefined}[];
 return [
  {label:'轮速速度 σ / m·s⁻¹',value:current.wheelVelocitySigmaMps},
  {label:'横向约束 σ / m·s⁻¹',value:current.lateralConstraintSigmaMps},
 ].filter(row=>row.value!==undefined);
});
const outlierRows=computed(()=>{
 const outliers=analysis.value?.aggregate.outliers;
 if(!outliers)return [];
 return [
  {label:'前进/后退比例',values:outliers.forwardScale??[]},
  {label:'IMU 转角比例',values:outliers.imuYawScale??[]},
  {label:'转角误差 / °',values:outliers.turnErrorDeg??[]},
 ].filter(row=>row.values.length>0);
});
// 库里可能存着 schemaVersion 1/2 的旧分析结果（没有 excluded / validTrials / rotationTags）。
// 这些字段一律按「空 / 总数」降级显示，绝不让模板因为 undefined.length 抛错把整页打白。
const excludedRows=computed(()=>analysis.value?.aggregate.excluded??[]);
// 已保存的旧口径分析：缺新字段时只提示，不自动重算、不写库；用户点「分析」后才用新口径更新。
const legacyAnalysisHint=computed(()=>{
 const current=analysis.value;
 if(!current)return '';
 const aggregate=current.aggregate as unknown as Record<string,unknown>|undefined;
 const missing:string[]=[];
 if(!aggregate||aggregate.excluded===undefined)missing.push('excluded');
 if(!aggregate||aggregate.validTrials===undefined)missing.push('validTrials');
 if(!aggregate||aggregate.outliers===undefined)missing.push('outliers');
 if(!Array.isArray(current.limitations))missing.push('limitations');
 if(!Array.isArray(current.trials))missing.push('trials');
 const aggregateMismatchMissing=!aggregate||aggregate.turnTrialsDirectionMismatch===undefined;
 const trialMismatchMissing=Array.isArray(current.trials)&&current.trials.length>0
   &&(current.trials as unknown as Record<string,unknown>[]).every(trial=>trial.directionMismatch===undefined);
 if(aggregateMismatchMissing&&trialMismatchMissing)missing.push('方向相反标记');
 const version=typeof current.schemaVersion==='number'?current.schemaVersion:null;
 if(!missing.length&&!(version!==null&&version<3))return '';
 const versionText=version===null?'缺少版本号':`schemaVersion ${version}`;
 return `当前显示的是已保存的旧口径分析结果（${versionText}${missing.length?`；缺少 ${missing.join(' / ')}`:''}）。点「分析」可按新口径重算，不会自动改写已保存结果。`;
});
const validTrialsLabel=computed(()=>{
 const agg=analysis.value?.aggregate;
 if(!agg)return '—';
 const total=analysis.value?.trials.length??0;
 return `${agg.validTrials??total} / ${total}`;
});
// 汇总里的旋转位置：按二维码聚合，缺数据的转向试验单独计数，不做任何推断。
const rotationTagsLabel=computed(()=>{
 const agg=analysis.value?.aggregate;
 if(!agg)return '—';
 const rows=agg.rotationTags??[];
 const missing=agg.turnTrialsMissingRotationTag??0;
 if(!rows.length)return missing?`缺数据（${missing} 次转向未指定二维码）`:'—';
 const text=rows.map(row=>`${row.label} × ${row.trials}${row.validTrials<row.trials?`（有效 ${row.validTrials}）`:''}`).join('、');
 return missing?`${text}（另有 ${missing} 次缺数据）`:text;
});
// 方向相反的转向试验：新分析读 aggregate 计数，旧分析（没有该字段）从每次试验的 directionMismatch 兜底统计。
const mismatchLabel=computed(()=>{
 const agg=analysis.value?.aggregate;
 if(!agg)return '—';
 const trials=analysis.value?.trials??[];
 // 旧分析（本轮之前保存的 schemaVersion 3）没有方向标记字段：不能显示“无”，否则等于谎称没有转反的试验。
 const hasMismatchField=agg.turnTrialsDirectionMismatch!==undefined||trials.some(trial=>trial.directionMismatch!==undefined);
 if(!hasMismatchField)return '旧分析未标记（点「分析」按新口径重算）';
 const count=agg.turnTrialsDirectionMismatch??trials.filter(trial=>trial.directionMismatch).length;
 return count?`${count} 次（turn_direction_mismatch，已排除）`:'无';
});
// 试验列表的滚动容器：新试验追加在末尾，列表限高 420px，不自动滚的话最新一条会被藏到窗口外。
const trialListRef=ref<HTMLElement|null>(null);

function errText(reason:unknown){return reason instanceof Error?reason.message:String(reason);}
async function request<T>(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{
 const response=await fetch('/api'+path,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 let json:any=null;
 try{json=await response.json();}catch{/* 非 JSON 错误也按 HTTP 状态处理 */}
 if(!response.ok)throw Object.assign(new Error(json?.error??`请求失败（HTTP ${response.status}）`),{status:response.status});
 return json as T;
}
async function act(fn:()=>Promise<void>){
 if(busy.value)return;
 busy.value=true;error.value='';message.value='';
 try{await fn();}catch(reason){error.value=errText(reason);}finally{busy.value=false;}
}
function tagText(id:number){return `Q${String(id).padStart(3,'0')}`;}
function tagLabel(tag:CalibrationMapTag){return tag.groupId?`${tagText(tag.id)} · ${tag.groupId}`:tagText(tag.id);}
function fmt(value:number|null|undefined,digits=3){return value===null||value===undefined||!Number.isFinite(value)?'—':value.toFixed(digits);}
// 带符号角度：正数显式补「+」，负数保留「-」，缺数据不补造。左右转并列时用同一格式。
function signedAngleText(value:number|null|undefined,digits=2){
 if(value===null||value===undefined||!Number.isFinite(value))return '缺数据';
 return `${value>0?'+':''}${value.toFixed(digits)}`;
}
function statsLabel(value:Stats|null|undefined,digits=3){return value?`${fmt(value.mean,digits)} ± ${fmt(value.std,digits)}（n=${value.n}）`:'—';}
function numberOrNull(value:number|''){return value===''||!Number.isFinite(Number(value))?null:Number(value);}
function timeLabel(value:string|null|undefined){
 if(!value)return '—';
 const date=new Date(value);
 return Number.isNaN(date.getTime())?value:date.toLocaleString('zh-CN',{hour12:false});
}
function delayLabel(trial:TrialAnalysis){
 if(trial.timeOffsetCandidate)return `${trial.timeOffsetCandidate.delayS.toFixed(3)} s（r=${trial.timeOffsetCandidate.correlation.toFixed(2)}，${trial.timeOffsetCandidate.pairs} 对）`;
 const reason=trial.timeOffsetUnavailableReason;
 return reason?`缺数据（${reason}）`:'—';
}
function endpointLabel(pick:{candidates:number;qualified:number;selected:number;stamps:number[];invalidReason:string|null}|null|undefined){
 if(!pick)return '—';
 const base=`候选 ${pick.candidates} / 合格 ${pick.qualified} / 选中 ${pick.selected}`;
 return pick.invalidReason?`${base}（${pick.invalidReason}）`:base;
}
function stampsLabel(pick:{stamps:number[]}|null|undefined){
 if(!pick||!pick.stamps.length)return '—';
 return pick.stamps.map(value=>value.toFixed(3)).join('、');
}
function poseLabel(pose:{x:number;y:number;yaw:number}|null|undefined){
 if(!pose)return '缺数据';
 return `x ${fmt(pose.x,4)} m · y ${fmt(pose.y,4)} m · ${fmt(pose.yaw*180/Math.PI,2)}°`;
}
function stopPointLabel(trial:TrialAnalysis){
 const sp=trial.stopPoint;
 if(!sp)return '缺数据';
 return sp.valid?'有效（端点停稳配对）':`无效（${sp.invalidReason??'unknown'}）`;
}
function fusionLabel(trial:TrialAnalysis){
 const status=trial.fusionStatus;
 if(!status)return '—';
 return status.state==='present'?status.message:`未接入 / 无样本（${status.message}）`;
}
function wheelYawLabel(trial:TrialAnalysis){
 const status=trial.wheelYawStatus;
 if(!status)return '—';
 return status.available?'可用':`不可用（${status.reason??'wz_all_zero'}）`;
}
const isTurnType=(type:TrialType)=>type==='left'||type==='right';
const measuredSourceLabel:Record<string,string>={imu_bias_corrected:'IMU 零偏校正',wheel_wz:'底盘 wz',visual_same_tag:'视觉同码配对',imu_raw:'IMU 原始（无零偏）'};
// 目标角显示：转向给「90°（顺时针）」，前进/后退不适用。绝不把带符号的内部值直接甩给用户。
function targetAngleText(item:{type:TrialType;angleDeg:number|null}){
 if(!isTurnType(item.type))return '角度 —';
 if(item.angleDeg===null)return '角度 —';
 return `${Math.abs(item.angleDeg)}°（${senseLabel[item.type==='right'?'right':'left']}）`;
}
// 「目标 / 实测」并列：目标走「右转 90°（顺时针）」，实测保留原始带符号值。
// 两者方向相反时由 directionMismatch 标出，不再靠正负号让人自己猜。
function turnAnglePairLabel(trial:TrialAnalysis){
 const target=trial.targetAngleDeg??trial.angleDeg??null;
 if(!isTurnType(trial.type))return `角度 ${target===null?'—':`${Math.abs(target).toFixed(1)}°`} / 实测 ${signedAngleText(trial.measuredAngleDeg)}°`;
 const phrase=trial.targetAnglePhrase??`${typeLabel[trial.type]} ${target===null?'—':Math.abs(target)}°（${senseLabel[trial.type==='right'?'right':'left']}）`;
 return `${phrase} / 实测 ${signedAngleText(trial.measuredAngleDeg)}°`;
}
// 旋转位置统一文案：在 Q113 处左转 90°（逆时针）/ 缺数据 / 不适用。
// 兼容旧分析结果（schemaVersion 2/3 存下来的 JSON 没有这些字段），缺字段一律显示缺数据，不补造。
function rotationPhrase(item:{type:TrialType;rotationTagId?:number|null;rotationTagLabel?:string|null;angleDeg:number|null}){
 if(!isTurnType(item.type))return '不适用（前进/后退不要求）';
 const tagId=item.rotationTagId;
 if(tagId===null||tagId===undefined)return '缺数据（未指定旋转二维码）';
 const label=item.rotationTagLabel??tagText(tagId);
 const magnitude=item.angleDeg===null||item.angleDeg===undefined?'—':Math.abs(item.angleDeg);
 return `在 ${label} 处${typeLabel[item.type]} ${magnitude}°（${senseLabel[item.type==='right'?'right':'left']}）`;
}
function pairingLabel(trial:TrialAnalysis){
 const pairing=trial.stopPoint?.pairing;
 if(!pairing)return '缺数据（旧分析结果）';
 return `${tagText(pairing.startTagId)} → ${tagText(pairing.endTagId)}${pairing.kind==='same_tag'?'（同一块码，原地转向）':''}`;
}
function turnErrorLabel(trial:TrialAnalysis){
 const value=trial.candidates.turnErrorDeg;
 if(!value)return '—';
 return `轮速−观测 ${fmt(value.wheelVsObserved,2)}° · IMU−观测 ${fmt(value.imuVsObserved,2)}° · IMU−轮速 ${fmt(value.imuVsWheel,2)}°`;
}
function exportUrl(format:'json'|'csv'|'report'){
 const id=current.value?.session.id;
 return id?`/api/calibration/sessions/${encodeURIComponent(id)}/export?format=${format}`:'#';
}
function setAnglePreset(preset:'90'|'180'|'custom'){trialForm.value.preset=preset;if(preset!=='custom')trialForm.value.customAngle='';}

async function loadCapabilities(){
 try{capabilities.value=await request<Capabilities>('/calibration/capabilities');capabilityError.value='';}
 catch(reason){capabilities.value=null;capabilityError.value=errText(reason);}
}
async function loadSessions(){
 try{sessions.value=(await request<{sessions:SessionSummary[]}>('/calibration/sessions')).sessions??[];}
 catch(reason){error.value=errText(reason);}
}
async function loadMapDetail(id:string){
 mapError.value='';mapDetail.value=null;
 if(!id)return;
 try{mapDetail.value=await request<CalibrationMapDetail>(`/maps/${encodeURIComponent(id)}`);}
 catch(reason){mapError.value=errText(reason);}
}
async function reloadCurrent(preserveLocal=false){
 const id=current.value?.session.id;
 if(!id)return;
 const next=await request<SessionDetail>(`/calibration/sessions/${encodeURIComponent(id)}`);
 current.value=next;
 if(preserveLocal)return;
 analysis.value=next.session.analysis??null;
 analysisSaved.value=!!next.session.analysis;
 applyResult.value=null;
 applyConfirm.value=false;
}
async function refreshAll(){await act(async()=>{await loadCapabilities();await loadSessions();await reloadCurrent();});}

async function openSession(id:string){
 if(!id||sessionLoading.value)return;
 sessionLoading.value=true;error.value='';message.value='';
 try{
  current.value=await request<SessionDetail>(`/calibration/sessions/${encodeURIComponent(id)}`);
  analysis.value=current.value.session.analysis??null;
  analysisSaved.value=!!current.value.session.analysis;
  applyResult.value=null;applyConfirm.value=false;
  if(selectedMapId.value!==current.value.session.mapId)selectedMapId.value=current.value.session.mapId;
 }catch(reason){error.value=errText(reason);}
 finally{sessionLoading.value=false;}
}

async function createSession(){
 const mapId=selectedMapId.value;
 if(!mapId){error.value='请先选择地图';return;}
 const tagA=numberOrNull(form.value.tagA),tagB=numberOrNull(form.value.tagB),baselineM=numberOrNull(form.value.baselineM);
 if(tagA===null||tagB===null){error.value='请填写二维码 A 与 B 的 ID';return;}
 if(!Number.isInteger(tagA)||!Number.isInteger(tagB)||tagA<0||tagA>586||tagB<0||tagB>586){error.value='二维码 ID 必须是 0–586 的整数';return;}
 if(tagA===tagB){error.value='二维码 A 与 B 不能相同';return;}
 if(baselineM===null||baselineM<0.05||baselineM>20){error.value='两码真实中心距离必须在 0.05–20 m 之间';return;}
 await act(async()=>{
  // 创建前重新读取地图，确保使用当前最新版本与最新二维码列表。
  const latest=await request<CalibrationMapDetail>(`/maps/${encodeURIComponent(mapId)}`);
  if(!latest.map.tags.some(tag=>tag.id===tagA)||!latest.map.tags.some(tag=>tag.id===tagB))throw new Error('所选二维码不在该地图的最新版本中，请重新选择');
  mapDetail.value=latest;
  const result=await request<{session:CalibrationSession}>('/calibration/sessions',{mapId,mapVersion:latest.version,tagA,tagB,baselineM,note:form.value.note.trim()});
  await loadSessions();
  await openSession(result.session.id);
  message.value='标定会话已创建 · 使用地图版本 v'+latest.version;
 });
}

async function startTrial(){
 if(!current.value){error.value='请先创建或打开标定会话';return;}
 if(recordingTrial.value){error.value='已有试验正在录制，请先结束或中止';return;}
 if(isTurn.value&&trialAngle.value===null){error.value='转向试验必须填写 5–180° 的角度（填大小即可，方向由左转/右转决定）';return;}
 // 转向必须明确“在哪块二维码处转”，缺失就当场拦住，不让它进库变成无效数据。
 if(isTurn.value&&trialForm.value.rotationTagId===''){error.value='转向试验必须选择旋转发生处的二维码（取自当前地图）';return;}
 if(isTurn.value&&!mapTags.value.some(tag=>tag.id===Number(trialForm.value.rotationTagId))){
  error.value='所选旋转二维码不在当前地图中，请重新选择';return;
 }
 await act(async()=>{
  const body={
   type:trialForm.value.type,
   angleDeg:isTurn.value?trialAngle.value:null,
   rotationTagId:isTurn.value?Number(trialForm.value.rotationTagId):null,
   note:trialForm.value.note.trim(),
  };
  const created=await request<{trial:CalibrationTrial}>(`/calibration/sessions/${encodeURIComponent(current.value!.session.id)}/trials`,body);
  trialForm.value.note='';
  await reloadCurrent();
  const what=isTurnType(created.trial.type)?rotationPhrase(created.trial):typeLabel[created.trial.type];
  message.value=`已开始记录：${what}。请现场手动驾驶，页面不会发送运动指令。`;
 });
}
async function stopTrial(trial:CalibrationTrial){
 await act(async()=>{
  await request(`/calibration/trials/${encodeURIComponent(trial.id)}/stop`,{});
  await reloadCurrent();await loadSessions();
  message.value='试验已结束并保存；建议确认车辆已停稳后再开始下一次。';
 });
}
async function abortTrial(trial:CalibrationTrial){
 await act(async()=>{
  await request(`/calibration/trials/${encodeURIComponent(trial.id)}/abort`,{});
  await reloadCurrent();await loadSessions();
  message.value='试验已中止，样本保留但结果仅供参考。';
 });
}
async function analyze(){
 if(!current.value)return;
 await act(async()=>{
  const result=await request<{analysis:SessionAnalysis}>(`/calibration/sessions/${encodeURIComponent(current.value!.session.id)}/analyze`,{});
  analysis.value=result.analysis;analysisSaved.value=false;applyResult.value=null;applyConfirm.value=false;
  message.value='分析完成（仅计算，尚未保存）。';
 });
}
async function saveAnalysis(){
 if(!current.value)return;
 await act(async()=>{
  const result=await request<{saved:boolean;analysis:SessionAnalysis}>(`/calibration/sessions/${encodeURIComponent(current.value!.session.id)}/analysis`,{});
  analysis.value=result.analysis??analysis.value;analysisSaved.value=true;
  await loadSessions();
  message.value='分析结果已保存到该标定会话。';
 });
}
function askApply(){if(!current.value)return;applyConfirm.value=true;applyResult.value=null;}
// 清空当前会话试验：破坏性操作，先弹二次确认；取消只关弹层，不发任何请求。
function askClear(){if(!current.value||!trials.value.length)return;applyConfirm.value=false;clearConfirm.value=true;}
async function clearTrials(){
 if(!current.value)return;
 await act(async()=>{
  const sessionId=current.value!.session.id;
  // 后端要求显式 confirm=clear-trials，缺参数直接 400；这里始终带上。
  const result=await request<{deletedTrials:number;deletedSamples:number}>(`/calibration/sessions/${encodeURIComponent(sessionId)}/trials?confirm=clear-trials`,undefined,'DELETE');
  clearConfirm.value=false;
  analysis.value=null;analysisSaved.value=false;applyResult.value=null;applyConfirm.value=false;
  await reloadCurrent();await loadSessions();
  message.value=`已清空本会话试验：删除 ${result.deletedTrials} 次试验、${result.deletedSamples} 条样本；会话配置、地图绑定与外部基线保留。`;
 });
}
async function applyParameters(){
 if(!current.value)return;
 await act(async()=>{
  const result=await request<ApplyResult>(`/calibration/sessions/${encodeURIComponent(current.value!.session.id)}/apply`,{confirm:true});
  applyConfirm.value=false;
  applyResult.value=result;
  await loadSessions();
  message.value=result.applied?'候选参数已应用。':'未应用：'+result.reason;
 });
}

watch(()=>props.maps,list=>{
 if(!list.length){selectedMapId.value='';return;}
 if(!selectedMapId.value||!list.some(map=>map.id===selectedMapId.value))selectedMapId.value=list[0]!.id;
},{immediate:true});
watch(selectedMapId,id=>{void loadMapDetail(id);},{immediate:true});
watch(()=>trialForm.value.type,type=>{if(type==='forward'||type==='reverse'){trialForm.value.preset='90';trialForm.value.customAngle='';trialForm.value.rotationTagId='';}});
// 试验列表自动滚到最新一条：新增试验/开始录制后，当前记录行必须立刻可见，
// 不能让人先滚页面再滚列表才找到「结束记录 / 中止」。历史试验仍可手动向上滚查看。
watch(()=>[trials.value.length,recordingTrial.value?.id??''] as const,async()=>{
 await nextTick();
 const list=trialListRef.value;
 if(list)list.scrollTop=list.scrollHeight;
},{flush:'post'});

let poll:ReturnType<typeof setInterval>|undefined;
function startPolling(){stopPolling();poll=setInterval(()=>{void loadCapabilities();},5000);}
function stopPolling(){if(poll){clearInterval(poll);poll=undefined;}}
onActivated(()=>{void loadCapabilities();void loadSessions();if(current.value)void reloadCurrent(true);startPolling();});
onDeactivated(stopPolling);
onBeforeUnmount(stopPolling);
</script>

<template>
 <div class="calibration-page" data-testid="calibration-page">
  <div class="cw-page-head">
   <div>
    <span class="eyebrow">被动采集 · 不发送运动指令</span>
    <h2>融合标定</h2>
    <p>选择地图与两块二维码，记录现场手动驾驶的试验，分析视觉、轮速与 IMU 的一致性。所有采样由 ROS 桥接节点提供，页面只读展示。</p>
   </div>
   <Button size="sm" variant="outline" :disabled="busy" data-testid="calibration-refresh" @click="refreshAll"><RefreshCw :size="15"/>刷新状态</Button>
  </div>

  <div class="cw-capabilities" data-testid="calibration-capabilities" role="status">
   <span :class="['cw-pill',capabilities?.nodeRecorder.supported?'is-ok':'is-warn']">采集节点 · {{capabilities?capabilities.nodeRecorder.supported?'已加载':'未加载':capabilitiesUnknown?'状态未知':'不可用'}}</span>
   <span :class="['cw-pill',capabilities?.nodeRecorder.recording?'is-rec':'is-idle']">录制 · {{capabilities?capabilities.nodeRecorder.recording?'录制中':'未录制':'状态未知'}}</span>
   <span class="cw-pill">最后样本 · {{capabilities?.nodeRecorder.lastSampleAt??'—'}}<template v-if="capabilities?.nodeRecorder.lastSampleKind">（{{capabilities?.nodeRecorder.lastSampleKind}}）</template></span>
   <span class="cw-pill">应用开关 · {{capabilities?.applyEnabled?'已开启':'关闭'}}<template v-if="capabilities?.applyReason">（{{capabilities?.applyReason}}）</template></span>
  </div>
  <div v-if="recorderWarning" class="cw-alert is-warning" role="alert" data-testid="recorder-warning"><AlertTriangle :size="16"/><span>{{recorderWarning}}</span></div>
  <div v-if="error" class="cw-alert is-error" role="alert"><AlertTriangle :size="16"/><span>{{error}}</span></div>
  <div v-if="message" class="cw-alert is-success" role="status"><CheckCircle2 :size="16"/><span>{{message}}</span></div>

  <div class="cw-grid">
   <section class="cw-card" data-testid="calibration-config">
    <div class="cw-card-title"><MapPin :size="18"/>配置<span class="cw-step">01</span></div>
    <label>地图<select v-model="selectedMapId" :disabled="busy" data-testid="calibration-map-select"><option value="">选择地图</option><option v-for="map in maps" :key="map.id" :value="map.id">{{map.name}} · v{{map.version}}</option></select></label>
    <p class="cw-hint" v-if="selectedMapId">
     <template v-if="mapDetail">当前最新版本 v{{mapDetail.version}} · {{mapDetail.map.tags.length}} 个二维码</template>
     <template v-else-if="mapError">{{mapError}}</template>
     <template v-else>正在读取地图二维码…</template>
    </p>
    <p class="cw-hint" v-else-if="!maps.length">暂无地图；请先在「扫描建图」中保存定位码地图。</p>
    <div class="cw-two">
     <label>二维码 A<input v-model.number="form.tagA" type="number" min="0" max="586" step="1" list="calibration-tags" placeholder="0–586" data-testid="calibration-tag-a"/></label>
     <label>二维码 B<input v-model.number="form.tagB" type="number" min="0" max="586" step="1" list="calibration-tags" placeholder="0–586" data-testid="calibration-tag-b"/></label>
    </div>
    <datalist id="calibration-tags"><option v-for="tag in mapTags" :key="tag.id" :value="tag.id">{{tagLabel(tag)}}</option></datalist>
    <label>两码真实中心距离 / m<input v-model.number="form.baselineM" type="number" min="0.05" max="20" step="0.001" placeholder="0.05–20" data-testid="calibration-baseline"/></label>
    <p class="cw-note">外部基线，用于比例校核；不当作车辆实际行程。</p>
    <label>备注（可选）<input v-model="form.note" maxlength="500" placeholder="例如：A 板放在通道口，B 板放在第三排" data-testid="calibration-note"/></label>
    <Button class="w-full" :disabled="busy||!selectedMapId||!mapDetail" data-testid="create-session" @click="createSession">创建标定会话</Button>
    <details class="cw-sessions" :open="!current">
     <summary>已有会话 · {{sessions.length}}</summary>
     <div v-if="!sessions.length" class="cw-hint">还没有标定会话。</div>
     <button v-for="item in sessions" :key="item.id" type="button" class="cw-session-row" :class="{active:current?.session.id===item.id}" data-testid="calibration-session-row" @click="openSession(item.id)">
      <span class="cw-session-main"><b>{{item.mapName}} · v{{item.mapVersion}}</b><small>{{tagText(item.tagA)}} → {{tagText(item.tagB)}} · 外部基线 {{item.baselineM}} m · {{item.trialCount}} 次试验</small></span>
      <span class="cw-session-flags">{{item.analysisSaved?'已存分析':'未存分析'}} · {{item.applied?'已应用':'未应用'}}</span>
     </button>
    </details>
   </section>

   <section class="cw-card" data-testid="calibration-trials">
    <div class="cw-card-title"><SlidersHorizontal :size="18"/>试验<span class="cw-step">02</span><span v-if="trials.length" class="cw-title-actions"><Button size="sm" variant="destructive" :disabled="busy||!!recordingTrial" data-testid="clear-trials" @click="askClear"><Trash2 :size="14"/>清空当前会话试验</Button></span></div>
    <div v-if="current" class="cw-current" data-testid="calibration-current-session">
     <div><span>当前会话</span><b>{{current.session.mapName??current.session.mapId}} · v{{current.session.mapVersion}}</b></div>
     <div><span>二维码</span><b>{{tagText(current.session.tagA)}} → {{tagText(current.session.tagB)}}</b></div>
     <div><span>外部基线</span><b>{{current.session.baselineM.toFixed(3)}} m</b></div>
     <div><span>采样</span><b>观测 {{current.sampleCounts.observation}} · 反馈 {{current.sampleCounts.feedback}} · IMU {{current.sampleCounts.imu}} · 融合 {{current.sampleCounts.fusion}}</b></div>
     <small v-if="current.session.note">{{current.session.note}}</small>
    </div>
    <div v-else class="cw-empty">先创建或打开一个标定会话，再开始记录试验。</div>
    <div v-if="recordingTrial" class="cw-recording" role="status" data-testid="recording-banner">
     <span class="cw-dot"/>
     <span class="cw-recording-text">正在录制：{{isTurnType(recordingTrial.type)?rotationPhrase(recordingTrial):typeLabel[recordingTrial.type]}}（第 {{recordingTrial.repetition}} 次）</span>
     <span class="cw-recording-actions">
      <Button size="sm" variant="outline" :disabled="busy" data-testid="recording-stop" @click="stopTrial(recordingTrial)"><Square :size="14"/>结束记录</Button>
      <Button size="sm" variant="destructive" :disabled="busy" data-testid="recording-abort" @click="abortTrial(recordingTrial)"><XCircle :size="14"/>中止</Button>
     </span>
    </div>
    <fieldset class="cw-trial-form" :disabled="!current||busy||!!recordingTrial">
     <legend>新增试验 · 开始记录</legend>
     <div class="cw-two">
      <label>类型<select v-model="trialForm.type" data-testid="trial-type"><option value="forward">前进</option><option value="reverse">后退</option><option value="left">左转</option><option value="right">右转</option></select></label>
      <label v-if="isTurn">角度 / °<input v-model.number="trialForm.customAngle" type="number" min="5" max="180" step="1" :disabled="trialForm.preset!=='custom'" placeholder="填大小 5–180" data-testid="trial-angle-custom"/></label>
      <label v-else>角度<input value="不适用（前进/后退）" disabled/></label>
     </div>
     <div v-if="isTurn" class="cw-angle-presets">
      <button type="button" :class="{active:trialForm.preset==='90'}" data-testid="trial-angle-90" @click="setAnglePreset('90')">90°</button>
      <button type="button" :class="{active:trialForm.preset==='180'}" data-testid="trial-angle-180" @click="setAnglePreset('180')">180°</button>
      <button type="button" :class="{active:trialForm.preset==='custom'}" data-testid="trial-angle-custom-button" @click="setAnglePreset('custom')">自定义</button>
      <span class="cw-hint">左转 = 逆时针（内部为正）、右转 = 顺时针（内部为负）；当前记录 {{trialAngleText}}。</span>
     </div>
     <label v-if="isTurn">旋转处二维码（取自当前地图）<select v-model.number="trialForm.rotationTagId" data-testid="trial-rotation-tag"><option value="">选择二维码</option><option v-for="tag in mapTags" :key="tag.id" :value="tag.id">{{tagLabel(tag)}}</option></select></label>
     <p v-if="isTurn" class="cw-hint" data-testid="trial-rotation-hint">本次将记录为「{{trialForm.rotationTagId===''?'未选择二维码':`在 ${tagText(Number(trialForm.rotationTagId))} 处${trialAngleText}`}}」。分析时两端都取该二维码；会话绑定的地图版本若无此码会标 rotation_tag_not_in_map。</p>
     <label>备注（可选）<input v-model="trialForm.note" maxlength="500" placeholder="例如：手动开 90°，已停稳" data-testid="trial-note"/></label>
     <Button class="w-full" :disabled="!current||busy||!!recordingTrial" data-testid="start-trial" @click="startTrial">{{recordingTrial?'已有试验在录制…':'开始记录'}}</Button>
     <p class="cw-hint">开始/结束只调用标定 API；车辆由现场人员手动驾驶，页面绝不发送运动指令。</p>
    </fieldset>
    <div ref="trialListRef" class="cw-trial-list" data-testid="calibration-trial-list">
     <div v-if="!trials.length" class="cw-empty">还没有试验记录。</div>
     <article v-for="trial in trials" :key="trial.id" :class="['cw-trial-row','is-'+trial.status]" :data-testid="'trial-row-'+trial.id">
      <div class="cw-trial-line">
       <span class="cw-rep">第 {{trial.repetition}} 次</span>
       <b>{{typeLabel[trial.type]}}</b>
       <span>{{targetAngleText(trial)}}</span>
       <span :class="['cw-status','is-'+trial.status]">{{statusLabel[trial.status]}}</span>
      </div>
      <div v-if="isTurnType(trial.type)" class="cw-trial-meta" :data-testid="'trial-rotation-'+trial.id"><span>旋转位置：{{rotationPhrase(trial)}}</span></div>
      <div class="cw-trial-meta"><span>开始 {{timeLabel(trial.startedAt)}}</span><span>结束 {{timeLabel(trial.endedAt)}}</span></div>
      <div v-if="trial.note" class="cw-trial-note">{{trial.note}}</div>
      <div class="cw-trial-actions">
       <Button size="sm" variant="outline" :disabled="busy||trial.status!=='recording'" data-testid="stop-trial" @click="stopTrial(trial)"><Square :size="14"/>结束记录</Button>
       <Button size="sm" variant="destructive" :disabled="busy||trial.status!=='recording'" data-testid="abort-trial" @click="abortTrial(trial)"><XCircle :size="14"/>中止</Button>
      </div>
     </article>
    </div>
    <div v-if="clearConfirm" class="cw-confirm is-danger" role="alertdialog" data-testid="clear-trials-confirm">
     <p><b>确认清空当前会话的全部试验？</b></p>
     <p>将删除本会话全部试验和样本，不删除地图、不删除其他会话，不能撤销。</p>
     <div><Button size="sm" variant="ghost" data-testid="clear-trials-cancel" @click="clearConfirm=false">取消</Button><Button size="sm" variant="destructive" data-testid="clear-trials-confirm-yes" :disabled="busy" @click="clearTrials">确认清空</Button></div>
    </div>
   </section>

   <section class="cw-card cw-results" data-testid="calibration-results">
    <div class="cw-card-title"><Activity :size="18"/>结果<span class="cw-step">03</span></div>
    <div class="cw-toolbar">
     <Button size="sm" :disabled="!current||busy" data-testid="analyze" @click="analyze"><FlaskConical :size="16"/>分析</Button>
     <Button size="sm" variant="outline" :disabled="!current||busy" data-testid="save-analysis" @click="saveAnalysis"><Save :size="15"/>仅保存分析结果</Button>
     <Button size="sm" variant="outline" :disabled="!current||busy" data-testid="apply-analysis" @click="askApply"><SlidersHorizontal :size="15"/>应用到运行参数</Button>
     <div class="cw-export">
      <span>导出：</span>
      <a :href="exportUrl('json')" :class="{disabled:!current}" target="_blank" rel="noopener" data-testid="calibration-export-json"><Download :size="13"/>JSON</a>
      <a :href="exportUrl('csv')" :class="{disabled:!current}" target="_blank" rel="noopener" data-testid="calibration-export-csv"><Download :size="13"/>CSV</a>
      <a :href="exportUrl('report')" :class="{disabled:!current}" target="_blank" rel="noopener" data-testid="calibration-export-report"><Download :size="13"/>报告</a>
     </div>
    </div>
    <div v-if="applyConfirm" class="cw-confirm" role="alertdialog" data-testid="apply-confirm">
     <p>确认尝试把候选参数应用到运行参数？后端当前只做 dry-run（不会写入导航/IMU 配置），返回后页面会显示 proposed/current 差异。</p>
     <div><Button size="sm" variant="ghost" @click="applyConfirm=false">取消</Button><Button size="sm" data-testid="apply-confirm-yes" :disabled="busy" @click="applyParameters">确认</Button></div>
    </div>
    <div v-if="applyResult" class="cw-apply-result" data-testid="apply-result">
     <div class="cw-apply-head"><strong :class="applyResult.applied?'is-ok':'is-off'">{{applyResult.applied?'已应用':'未应用'}}</strong><span>{{applyResult.reason}}</span></div>
     <table class="cw-table"><thead><tr><th>参数</th><th>候选值 proposed</th><th>当前值 current</th></tr></thead><tbody><tr v-for="row in applyRows" :key="row.key"><td>{{row.label}}</td><td>{{fmt(applyResult.proposed[row.key],4)}}</td><td>{{fmt(applyResult.current[row.key],4)}}</td></tr><tr v-if="applyResult.proposed.visualImuDelayS!==undefined"><td>视觉-IMU 延迟 / s</td><td>{{fmt(applyResult.proposed.visualImuDelayS,4)}}</td><td>{{fmt(applyResult.current.captureDelayS,4)}}</td></tr></tbody></table>
     <dl v-if="applyCurrentRows.length" class="cw-current-params"><div v-for="row in applyCurrentRows" :key="row.label"><dt>{{row.label}}（后端读取）</dt><dd>{{fmt(row.value,5)}}</dd></div></dl>
     <small v-if="applyResult.analysisSaved">分析结果已随本次请求保存。</small>
    </div>
    <div v-if="analysis" class="cw-analysis">
     <div v-if="legacyAnalysisHint" class="cw-alert is-warning" role="status" data-testid="analysis-legacy"><AlertTriangle :size="16"/><span>{{legacyAnalysisHint}}</span></div>
     <div class="cw-aggregate" data-testid="analysis-aggregate">
      <div class="cw-aggregate-title">多次汇总 <span>均值 / σ / 离群</span></div>
       <dl class="cw-metrics">
        <div><dt>有效试验</dt><dd :data-testid="'aggregate-valid'">{{validTrialsLabel}}<small v-if="excludedRows.length">（排除 {{excludedRows.length}}）</small></dd></div>
        <div><dt>旋转位置（转向试验）</dt><dd :data-testid="'aggregate-rotation'">{{rotationTagsLabel}}</dd></div>
        <div><dt>方向相反（已排除）</dt><dd :data-testid="'aggregate-mismatch'">{{mismatchLabel}}</dd></div>
        <div><dt>目标转角 / °（绝对值）</dt><dd>{{statsLabel(analysis.aggregate.targetAngleDeg,2)}}</dd></div>
        <div><dt>实测转角 / °（带符号，右负左正）</dt><dd>{{statsLabel(analysis.aggregate.measuredAngleDeg,2)}}</dd></div>
        <div><dt>实测转角幅值 / °（|实测|）</dt><dd>{{statsLabel(analysis.aggregate.measuredAngleMagnitudeDeg,2)}}</dd></div>
        <div><dt>前进比例候选（轮速÷视觉）</dt><dd>{{statsLabel(analysis.aggregate.forwardScale,4)}}</dd></div>
        <div><dt>视觉净位移 / m</dt><dd>{{statsLabel(analysis.aggregate.visualNetDistance,4)}}</dd></div>
        <div><dt>基线残差 / m</dt><dd>{{statsLabel(analysis.aggregate.baselineResidualM,4)}}</dd></div>
        <div><dt>横向比例候选</dt><dd>{{fmt(analysis.aggregate.lateralScale,4)}}</dd></div>
        <div><dt>IMU 转角比例候选</dt><dd>{{statsLabel(analysis.aggregate.imuYawScale,4)}}</dd></div>
        <div><dt>轮速转角比例候选</dt><dd>{{statsLabel(analysis.aggregate.wheelYawScale,4)}}</dd></div>
        <div><dt>延迟候选 / s</dt><dd>{{statsLabel(analysis.aggregate.delayS,3)}}</dd></div>
        <div><dt>转角误差 / °</dt><dd>{{statsLabel(analysis.aggregate.turnErrorDeg,2)}}</dd></div>
        <div><dt>IMU 运行标定 bias</dt><dd>{{analysis.imuBias?`${analysis.imuBias.bias?.map(value=>fmt(value,5)).join(', ')}（${analysis.imuBias.source}）`:'缺数据'}}</dd></div>
        <div><dt>旧口径同帧视觉基线 / m</dt><dd>{{statsLabel(analysis.aggregate.visualBaselineM,4)}}</dd></div>
       </dl>
       <div v-if="excludedRows.length" class="cw-outlier" data-testid="aggregate-excluded"><b>已排除</b><span v-for="item in excludedRows" :key="item.trialId">{{item.trialId}}：{{item.reason}}</span></div>
      <div class="cw-outlier"><b>离群</b><span v-if="!outlierRows.length">无</span><span v-for="row in outlierRows" :key="row.label">{{row.label}}：{{row.values.map(value=>fmt(value,4)).join('、')}}</span></div>
     </div>
     <article v-for="trial in analysis.trials" :key="trial.trialId" class="cw-trial-result" :data-testid="'analysis-trial-'+trial.trialId">
      <header><b>{{typeLabel[trial.type]}} · 第 {{trial.repetition}} 次</b><span :class="['cw-status','is-'+trial.status]">{{statusLabel[trial.status]}}</span><span v-if="trial.directionMismatch" class="cw-status is-mismatch" :data-testid="'trial-mismatch-'+trial.trialId">方向相反</span><small>{{targetAngleText(trial)}} · 时长 {{fmt(trial.window.durationS,2)}} s</small></header>
       <dl class="cw-metrics">
        <div><dt>旋转位置</dt><dd :data-testid="'trial-rotation-'+trial.trialId" :class="isTurnType(trial.type)&&trial.rotationTagId===null?'is-bad':''">{{rotationPhrase(trial)}}</dd></div>
        <div><dt>目标角 / 实测角</dt><dd :data-testid="'trial-angles-'+trial.trialId" :class="trial.directionMismatch?'is-bad':''">{{turnAnglePairLabel(trial)}}<small v-if="trial.measuredAngleSource">（{{measuredSourceLabel[trial.measuredAngleSource]??trial.measuredAngleSource}}）</small></dd></div>
        <div><dt>停点配对状态</dt><dd :data-testid="'trial-stop-'+trial.trialId" :class="trial.stopPoint?.valid?'is-ok':'is-bad'">{{stopPointLabel(trial)}}</dd></div>
        <div><dt>端点配对（起→终）</dt><dd>{{pairingLabel(trial)}}</dd></div>
        <div><dt>端点观测（总/见A/见B/同帧双码）</dt><dd>{{trial.stopPoint?`${trial.stopPoint.counts.total} / ${trial.stopPoint.counts.seeA} / ${trial.stopPoint.counts.seeB} / ${trial.stopPoint.counts.both}`:'缺数据'}}</dd></div>
        <div><dt>起点选样</dt><dd>{{endpointLabel(trial.stopPoint?.start)}}</dd></div>
        <div><dt>起点选中 stamp</dt><dd class="cw-stamps">{{stampsLabel(trial.stopPoint?.start)}}</dd></div>
        <div><dt>终点选样</dt><dd>{{endpointLabel(trial.stopPoint?.end)}}</dd></div>
        <div><dt>终点选中 stamp</dt><dd class="cw-stamps">{{stampsLabel(trial.stopPoint?.end)}}</dd></div>
        <div><dt>视觉相对位姿（起点→终点）</dt><dd :data-testid="'trial-pose-'+trial.trialId">{{poseLabel(trial.visualRelativePose)}}</dd></div>
        <div><dt>视觉净位移 / 基线残差</dt><dd>{{fmt(trial.visualNetDistance,4)}} m / {{trial.baselineResidual==null?'不适用（转向或旧分析缺字段）':fmt(trial.baselineResidual,4)+' m'}}<small v-if="trial.stopPoint?.baselineRatio!==null&&trial.stopPoint?.baselineRatio!==undefined">（视觉÷基线 {{fmt(trial.stopPoint.baselineRatio,4)}}）</small></dd></div>
        <div><dt>轮速净位移 / 路径长</dt><dd>{{fmt(trial.wheelNetDistance,4)}} m / {{fmt(trial.wheelPathDistance,4)}} m</dd></div>
        <div><dt>轮速偏航</dt><dd>{{wheelYawLabel(trial)}}</dd></div>
        <div><dt>IMU 转角 原始 / 零偏校正</dt><dd>{{fmt(trial.imuYawRaw,2)}}° / {{fmt(trial.imuYawBiasCorrected,2)}}°</dd></div>
        <div><dt>IMU 零偏来源</dt><dd>{{trial.imuBias?`${trial.imuBias.bias?.map(value=>fmt(value,5)).join(', ')}（${trial.imuBias.source}）`:'缺数据'}}</dd></div>
        <div><dt>融合输出</dt><dd>{{fusionLabel(trial)}}</dd></div>
        <div><dt>延迟候选</dt><dd>{{delayLabel(trial)}}</dd></div>
        <div><dt>前进比例候选（轮速÷视觉）</dt><dd>{{fmt(trial.candidates.forwardScale,4)}}</dd></div>
        <div><dt>轮速÷外部基线（仅校核）</dt><dd>{{fmt(trial.candidates.wheelVsBaselineRatio,4)}}</dd></div>
        <div><dt>IMU / 轮速转角比例候选</dt><dd>{{fmt(trial.candidates.imuYawScale,4)}} / {{fmt(trial.candidates.wheelYawScale,4)}}</dd></div>
        <div><dt>转角误差</dt><dd>{{turnErrorLabel(trial)}}</dd></div>
        <div><dt>样本数</dt><dd>观测 {{trial.sampleCounts.observation}} · 反馈 {{trial.sampleCounts.feedback}} · IMU {{trial.sampleCounts.imu}} · 融合 {{trial.sampleCounts.fusion}}</dd></div>
       </dl>
      <div class="cw-groups">
       <div class="cw-group is-computable"><b>可计算</b><p v-for="item in trial.computable" :key="item">{{item}}</p><p v-if="!trial.computable.length" class="cw-none">无</p></div>
       <div class="cw-group is-assumption"><b>依赖假设</b><p v-for="item in trial.assumptions" :key="item">{{item}}</p><p v-if="!trial.assumptions.length" class="cw-none">无</p></div>
       <div class="cw-group is-missing"><b>缺数据</b><p v-for="item in trial.missing" :key="item">{{item}}</p><p v-if="!trial.missing.length" class="cw-none">无</p></div>
       <div v-if="trial.faults.length" class="cw-group is-fault"><b>异常</b><p v-for="item in trial.faults" :key="item">{{item}}</p></div>
      </div>
     </article>
     <div class="cw-analysis-note">
      <div v-if="analysis.limitations?.length" class="cw-mini-list"><b>限制</b><p v-for="item in analysis.limitations" :key="item">{{item}}</p></div>
      <details class="cw-mini-list"><summary>公式</summary><p v-for="item in analysis.formulas" :key="item">{{item}}</p></details>
      <small>分析时间 {{timeLabel(analysis.analyzedAt)}} · 仅计算/建议，不自动写运行配置。</small>
     </div>
    </div>
    <div v-else class="cw-empty">点击「分析」只计算不保存；分析完成后再决定是否保存或应用。</div>
   </section>
  </div>
 </div>
</template>

<style scoped>
.calibration-page{flex:1;min-height:0;overflow-y:auto;padding:0 24px 24px;display:flex;flex-direction:column;gap:14px;color:var(--ink)}
.cw-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 18px;border:1px solid #dbeafe;border-radius:8px;background:linear-gradient(140deg,#fff,#f5f9ff);box-shadow:var(--card-shadow)}
.cw-page-head h2{font-size:18px;font-weight:600;margin:6px 0 4px}
.cw-page-head p{margin:0;color:var(--muted);font-size:12px;line-height:1.7;max-width:860px}
.cw-capabilities{display:flex;flex-wrap:wrap;gap:8px}
.cw-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border:1px solid var(--line);border-radius:999px;background:white;color:var(--muted);font-size:11px;line-height:1.4;overflow-wrap:anywhere}
.cw-pill.is-ok{color:#15803d;background:#f0fdf4;border-color:#dcfce7}.cw-pill.is-warn{color:#b45309;background:#fffbeb;border-color:#fef3c7}.cw-pill.is-rec{color:#b91c1c;background:#fef2f2;border-color:#fee2e2}.cw-pill.is-idle{color:#475569}
.cw-alert{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.cw-alert svg{flex-shrink:0;margin-top:2px}.cw-alert.is-warning{color:#b45309;background:#fffbeb;border:1px solid #fef3c7}.cw-alert.is-error{color:#b91c1c;background:#fef2f2;border:1px solid #fee2e2}.cw-alert.is-success{color:#166534;background:#f0fdf4;border:1px solid #dcfce7}
.cw-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}
.cw-card{background:white;border:1px solid var(--line);border-radius:8px;box-shadow:var(--card-shadow);padding:16px;min-width:0}
.cw-results{grid-column:1 / -1}
.cw-card-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:#1e293b;margin-bottom:12px}.cw-card-title svg{color:var(--muted)}.cw-step{margin-left:auto;font:11px var(--mono);color:#94a3b8}
.cw-title-actions{display:flex;align-items:center;gap:8px;margin-left:8px}
.cw-card label{margin-top:12px}
.cw-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.cw-hint{margin:6px 0 0;color:var(--muted);font-size:11px;line-height:1.6;overflow-wrap:anywhere}
.cw-note{margin:6px 0 0;padding:7px 9px;border-radius:6px;background:#fffbeb;border:1px solid #fef3c7;color:#b45309;font-size:11px;line-height:1.6}
.cw-empty{margin-top:12px;padding:12px;border:1px dashed var(--line);border-radius:8px;color:var(--muted);font-size:12px;line-height:1.7}
.cw-sessions{margin-top:14px;border-top:1px solid var(--line);padding-top:10px}
.cw-sessions summary{cursor:pointer;color:#334155;font-size:12px}
.cw-session-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;width:100%;margin-top:6px;padding:8px;border:1px solid var(--line);border-radius:6px;background:white;text-align:left;font-size:12px;color:#334155}
.cw-session-row:hover{background:#f8fafc}.cw-session-row.active{border-color:var(--accent);background:var(--accent-soft)}
.cw-session-main{display:flex;flex-direction:column;gap:2px;min-width:0}.cw-session-main b{font-weight:600}.cw-session-main small{color:var(--muted);font-size:11px}
.cw-session-flags{flex-shrink:0;color:var(--muted);font-size:10px;text-align:right;line-height:1.6}
.cw-current{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;padding:10px;border-radius:8px;background:var(--panel);border:1px solid var(--line);font-size:11px}
.cw-current>div{display:flex;flex-direction:column;gap:2px;min-width:0}.cw-current span{color:var(--muted)}.cw-current b{font-weight:500;overflow-wrap:anywhere}.cw-current small{grid-column:1 / -1;color:var(--muted)}
/* 录制横幅：吸顶显示并自带「结束记录 / 中止」，录制中不必再滚页面或滚列表去找按钮。 */
.cw-recording{display:flex;align-items:center;flex-wrap:wrap;gap:7px 10px;margin-top:10px;padding:8px 10px;border-radius:6px;background:#fef2f2;border:1px solid #fee2e2;color:#b91c1c;font-size:12px;position:sticky;top:0;z-index:3;box-shadow:0 2px 6px rgba(15,23,42,.06)}
.cw-recording-text{flex:1 1 220px;min-width:0;overflow-wrap:anywhere}
.cw-recording-actions{display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:auto}
.cw-dot{width:7px;height:7px;border-radius:50%;background:#dc2626;animation:cw-pulse 1.2s infinite}
@keyframes cw-pulse{50%{opacity:.35}}
.cw-trial-form{margin:12px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#f8fafc;min-width:0}
.cw-trial-form legend{padding:0 6px;color:#334155;font-size:12px;font-weight:600}
.cw-angle-presets{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:8px}
.cw-angle-presets button{padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:white;color:#334155;font-size:12px}
.cw-angle-presets button.active{border-color:var(--accent);background:var(--accent-soft);color:var(--accent);font-weight:600}
.cw-trial-list{margin-top:12px;display:flex;flex-direction:column;gap:8px;max-height:420px;overflow-y:auto}
.cw-trial-row{padding:10px;border:1px solid var(--line);border-radius:8px;background:white;font-size:12px}
.cw-trial-row.is-recording{border-color:#fca5a5;background:#fff7f7}
.cw-trial-row.is-aborted,.cw-trial-row.is-interrupted{opacity:.85}
.cw-trial-line{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.cw-trial-line b{font-weight:600}
.cw-rep{font:11px var(--mono);color:#64748b}
.cw-status{padding:1px 7px;border-radius:999px;font-size:10px;line-height:1.8;background:#f1f5f9;color:#64748b}.cw-status.is-recording{background:#fef2f2;color:#b91c1c}.cw-status.is-saved{background:#f0fdf4;color:#15803d}.cw-status.is-aborted{background:#fffbeb;color:#b45309}.cw-status.is-interrupted{background:#fef2f2;color:#b91c1c}.cw-status.is-mismatch{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;font-weight:600}
.cw-trial-meta{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:5px;color:var(--muted);font-size:11px}
.cw-trial-note{margin-top:4px;color:#475569;font-size:11px;line-height:1.6;overflow-wrap:anywhere}
.cw-trial-actions{display:flex;gap:6px;margin-top:8px}
.cw-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding-bottom:10px;border-bottom:1px solid var(--line)}
.cw-export{display:flex;align-items:center;gap:8px;margin-left:auto;font-size:12px;color:var(--muted);flex-wrap:wrap}
.cw-export a{display:inline-flex;align-items:center;gap:3px;color:var(--accent);text-decoration:none;font-weight:500}.cw-export a:hover{text-decoration:underline}.cw-export a.disabled{pointer-events:none;opacity:.45}
.cw-confirm{margin-top:10px;padding:10px 12px;border:1px solid #fde68a;border-radius:8px;background:#fffbeb;color:#92400e;font-size:12px;line-height:1.7}
.cw-confirm p{margin:0 0 8px}.cw-confirm>div{display:flex;justify-content:flex-end;gap:8px}
.cw-confirm.is-danger{border-color:#fecaca;background:#fff7f7;color:#991b1b}
.cw-apply-result{margin-top:10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:12px;color:#334155}
.cw-apply-head{display:flex;align-items:flex-start;gap:8px;line-height:1.6}.cw-apply-head strong{flex-shrink:0;padding:1px 8px;border-radius:999px;font-size:11px}.cw-apply-head .is-off{background:#fef2f2;color:#b91c1c}.cw-apply-head .is-ok{background:#f0fdf4;color:#15803d}
.cw-apply-result small{display:block;margin-top:6px;color:var(--muted)}
.cw-analysis{margin-top:12px;display:flex;flex-direction:column;gap:10px}
.cw-aggregate{padding:12px;border:1px solid #dbeafe;border-radius:8px;background:#f8fbff}
.cw-aggregate-title{display:flex;align-items:baseline;gap:8px;font-size:13px;font-weight:600;color:#1e293b;margin-bottom:8px}.cw-aggregate-title span{font-weight:400;color:var(--muted);font-size:11px}
.cw-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:0}
.cw-metrics>div{padding:7px 8px;border:1px solid var(--line);border-radius:6px;background:white;min-width:0}.cw-metrics dt{color:var(--muted);font-size:10px;line-height:1.4}.cw-metrics dd{margin:3px 0 0;font:600 12px var(--mono);color:#334155;overflow-wrap:anywhere}.cw-metrics dd small{font:400 10px var(--muted);color:var(--muted);margin-left:4px}
.cw-outlier{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px;font-size:11px;color:#92400e}.cw-outlier b{color:#b45309}
.cw-metrics dd.is-ok{color:#166534}.cw-metrics dd.is-bad{color:#b91c1c}.cw-metrics dd.cw-stamps{font-size:10px;font-weight:400;color:#475569}
.cw-trial-result{border:1px solid var(--line);border-radius:8px;padding:12px;background:white}
.cw-trial-result header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;font-size:13px}.cw-trial-result header small{color:var(--muted);font-size:11px;margin-left:auto}
.cw-groups{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}
.cw-group{padding:8px 9px;border-radius:6px;font-size:11px;line-height:1.6;border:1px solid;min-width:0}.cw-group p{margin:3px 0;overflow-wrap:anywhere}.cw-group b{font-size:11px}
.cw-group.is-computable{background:#f0fdf4;border-color:#dcfce7;color:#166534}.cw-group.is-assumption{background:#fffbeb;border-color:#fef3c7;color:#92400e}.cw-group.is-missing{background:#fef2f2;border-color:#fee2e2;color:#b91c1c}.cw-group.is-fault{grid-column:1 / -1;background:#fff7ed;border-color:#fed7aa;color:#9a3412}
.cw-none{opacity:.65}
.cw-analysis-note{margin-top:4px;padding:10px 12px;border:1px dashed var(--line);border-radius:8px;font-size:11px;color:var(--muted);line-height:1.7}
.cw-mini-list b{color:#475569}.cw-mini-list p{margin:3px 0;overflow-wrap:anywhere}.cw-mini-list summary{cursor:pointer;color:#475569;font-size:11px}
.cw-analysis-note>small{display:block;margin-top:8px}
.cw-table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px}.cw-table th,.cw-table td{padding:5px 6px;border-top:1px solid var(--line);text-align:left}.cw-table th{color:var(--muted);font-weight:500}.cw-table td{font-family:var(--mono)}
.cw-current-params{display:flex;flex-wrap:wrap;gap:4px 16px;margin:8px 0 0;font-size:11px;color:var(--muted)}.cw-current-params div{display:flex;gap:6px}.cw-current-params dt{margin:0}.cw-current-params dd{margin:0;font-family:var(--mono);color:#334155}
@media(max-width:1100px){.cw-grid{grid-template-columns:minmax(0,1fr)}.cw-results{grid-column:auto}}
@media(max-width:760px){.cw-page-head{flex-direction:column}.cw-two,.cw-current,.cw-metrics,.cw-groups{grid-template-columns:minmax(0,1fr)}.cw-group.is-fault{grid-column:auto}}
</style>
