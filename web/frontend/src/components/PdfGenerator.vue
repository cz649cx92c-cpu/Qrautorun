<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref,watch} from 'vue';
import {Download,FileText,AlertTriangle,CheckCircle2} from 'lucide-vue-next';
import Button from './ui/Button.vue';

type BoardMember={id:number;x:number;y:number;angle:number;size:number};
type Board={id:string;referenceId:number;gridSize:number;sizeMm:number;gapMm:number;members:BoardMember[]};
type Plan={groupCount:number;memberCount:number;pages:number;childSizeMm:number;minGroupSizeMm:number;maxGroupSizeMm:number;boards:Board[];filename:string;centerCrosshairAvailable?:boolean;centerCrosshairNote?:string;registration?:{available:boolean;message?:string;suggestedStartId?:number}};
type GridOption={gridSize:number;minGroupSizeMm:number;maxGroupSizeMm:number;minChildSizeMm:number};
const emit=defineEmits<{generated:[result:Plan]}>();
const gridOptions=ref<GridOption[]>([]),gridSize=ref(2),groupSizeMm=ref(140),groupCount=ref(3),startId=ref(0),centerCrosshair=ref(true);
const busy=ref(false),planning=ref(false),loadingOptions=ref(false),error=ref(''),message=ref(''),plan=ref<Plan|null>(null);
const gridOption=computed(()=>gridOptions.value.find(g=>g.gridSize===gridSize.value));
const minSizeMm=computed(()=>gridOption.value?.minGroupSizeMm??20);
const maxSizeMm=computed(()=>gridOption.value?.maxGroupSizeMm??180);
const memberCount=computed(()=>groupCount.value*gridSize.value*gridSize.value);
const maxGroups=computed(()=>Math.floor((587-startId.value)/(gridSize.value*gridSize.value)));
const endId=computed(()=>startId.value+memberCount.value-1);
const localError=computed(()=>{
 if(!gridOption.value)return '';
 if(!Number.isInteger(startId.value)||startId.value<0||startId.value>586)return '起始子码编号须为 0–586';
 if(!Number.isInteger(groupCount.value)||groupCount.value<1)return '生成组数须为正整数';
 if(groupCount.value>maxGroups.value)return maxGroups.value<1?'剩余子码不足一整组':'当前起始编号最多可生成 '+maxGroups.value+' 组';
 if(!Number.isFinite(groupSizeMm.value)||groupSizeMm.value<minSizeMm.value||groupSizeMm.value>maxSizeMm.value)return '当前规格整组尺寸须为 '+minSizeMm.value+'–'+maxSizeMm.value+' mm';
 return '';
});
const payload=()=>({gridSize:gridSize.value,groupSizeMm:groupSizeMm.value,groupCount:groupCount.value,startId:startId.value,centerCrosshair:centerCrosshair.value});
const label=(id:number)=>'Q'+String(id).padStart(3,'0');
const previewUrl=computed(()=>'/api/boards/preview.svg?'+new URLSearchParams({gridSize:String(gridSize.value),groupSizeMm:String(groupSizeMm.value),startId:String(startId.value),centerCrosshair:String(centerCrosshair.value)}).toString());
const firstBoard=computed(()=>plan.value?.boards[0]);
const centerCrosshairNote=computed(()=>!centerCrosshair.value?'已关闭中心十字，定位板尺寸和静区不变':plan.value?.centerCrosshairNote??(gridSize.value%2===0?'整组中心十字全长 8 mm、线宽 0.15 mm，沿中央白缝绘制':gridSize.value+'×'+gridSize.value+' 正中心是子码，没有安全白缝，无法画中心十字；请选择 2×2、4×4 或 6×6'));
const boardLabel=computed(()=>firstBoard.value?.id??'B'+String(startId.value).padStart(3,'0'));
const registrationConflict=computed(()=>plan.value?.registration?.available===false?plan.value.registration.message??'当前批次编号已被其他定位板占用':'');
function useAvailableStart(){const suggested=plan.value?.registration?.suggestedStartId;if(suggested!==undefined)startId.value=suggested;}
let timer:ReturnType<typeof setTimeout>|undefined,sequence=0,closed=false;
async function responseError(response:Response){try{return (await response.json()).error??'请求失败';}catch{return '请求失败';}}
async function requestPlan(){
 const revision=++sequence;
 if(localError.value||!gridOption.value||closed){plan.value=null;planning.value=false;return;}
 planning.value=true;
 try{
  const response=await fetch('/api/boards/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload())});
  if(!response.ok)throw new Error(await responseError(response));
  const result=await response.json() as Plan;
  if(revision===sequence&&!closed)plan.value=result;
 }catch(e){if(revision===sequence&&!closed)error.value=e instanceof Error?e.message:String(e);}
 finally{if(revision===sequence&&!closed)planning.value=false;}
}
watch(gridSize,()=>{if(gridOption.value&&groupSizeMm.value<minSizeMm.value)groupSizeMm.value=minSizeMm.value;});
watch([gridSize,groupSizeMm,groupCount,startId,centerCrosshair,gridOptions],()=>{
 sequence++;plan.value=null;error.value='';message.value='';planning.value=false;clearTimeout(timer);
 if(!localError.value&&gridOption.value&&!closed){planning.value=true;timer=setTimeout(()=>void requestPlan(),180);}
},{immediate:true});
async function loadOptions(){
 loadingOptions.value=true;error.value='';
 try{
  const response=await fetch('/api/boards/options');if(!response.ok)throw new Error(await responseError(response));
  const options=await response.json();if(!closed)gridOptions.value=options.grids;
 }catch(e){if(!closed)error.value=e instanceof Error?e.message:String(e);}
 finally{if(!closed)loadingOptions.value=false;}
}
async function download(){
 if(busy.value||localError.value||!gridOption.value)return;
 busy.value=true;error.value='';message.value='';
 const request=payload();
 try{
  const planResponse=await fetch('/api/boards/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
  if(!planResponse.ok)throw new Error(await responseError(planResponse));
  const confirmedPlan=await planResponse.json() as Plan;if(!closed)plan.value=confirmedPlan;
  if(confirmedPlan.registration?.available===false)throw new Error(confirmedPlan.registration.message??'当前批次编号已被其他定位板占用');
  const response=await fetch('/api/boards/pdf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
  if(!response.ok)throw new Error(await responseError(response));
  if(!response.headers.get('Content-Type')?.includes('application/pdf'))throw new Error('PDF 格式错误');
  const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');
  link.href=url;link.download=confirmedPlan.filename.endsWith('.pdf')?confirmedPlan.filename:confirmedPlan.filename+'.pdf';document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  if(!closed){message.value='PDF 已生成';emit('generated',confirmedPlan);}
 }catch(e){if(!closed)error.value=e instanceof Error?e.message:String(e);}
 finally{if(!closed)busy.value=false;}
}
onMounted(()=>void loadOptions());
onBeforeUnmount(()=>{closed=true;clearTimeout(timer);sequence++;});
</script>
<template>
 <section class="pdf-workspace">
  <div class="pdf-controls">
   <h2><FileText :size="24"/>生成设置</h2>
   <fieldset :disabled="busy||!gridOption">
    <legend>组内规格</legend>
    <div class="grid-options"><button v-for="option in gridOptions" :key="option.gridSize" type="button" :class="['grid-option',{selected:gridSize===option.gridSize}]" :aria-pressed="gridSize===option.gridSize" @click="gridSize=option.gridSize">{{option.gridSize}} × {{option.gridSize}}</button></div>
    <label>整组尺寸 / mm<input v-model.number="groupSizeMm" type="number" :min="minSizeMm" :max="maxSizeMm" step="0.1"/></label>
    <div class="size-status">{{gridOption?minSizeMm+'–'+maxSizeMm+' mm':'正在读取规格…'}}</div>
    <label>生成组数<input v-model.number="groupCount" type="number" min="1" :max="maxGroups" step="1"/></label>
    <label>起始子码编号<input v-model.number="startId" type="number" min="0" max="586" step="1"/></label>
   <label class="crosshair-option"><input v-model="centerCrosshair" type="checkbox"/>整组中心十字对位线</label><small class="crosshair-note" :class="{'crosshair-unavailable':centerCrosshair&&gridSize%2!==0}" data-testid="crosshair-note" role="status">{{centerCrosshairNote}}</small>
   </fieldset>
   <div class="pdf-summary"><div><span>子码总数</span><strong>{{plan?.memberCount??memberCount}} 个</strong></div><div><span>A4 页数</span><strong>{{plan?.pages??groupCount}} 页</strong></div><div v-if="plan"><span>子码黑边尺寸</span><strong>{{plan.childSizeMm.toFixed(2)}} mm</strong></div><div><span>子码编号</span><strong>{{label(startId)}} – {{label(endId)}}</strong></div></div>
   <div v-if="localError||error||registrationConflict" class="pdf-error" role="alert"><AlertTriangle :size="20"/>{{localError||error||registrationConflict}}</div>
   <Button v-if="registrationConflict&&plan?.registration?.suggestedStartId!==undefined" variant="outline" class="download-button" :disabled="busy||planning" @click="useAvailableStart">使用可用编号 {{label(plan?.registration?.suggestedStartId??0)}}</Button>
   <small v-if="registrationConflict" class="crosshair-note">已有定位板保持原编号和尺寸。新批次请确认使用空闲编号；重打请填写原起始编号、规格及尺寸。</small>
   <div v-if="message" class="pdf-success" role="status"><CheckCircle2 :size="20"/>{{message}}</div>
   <Button v-if="!gridOption&&!loadingOptions" class="download-button" variant="outline" @click="loadOptions">重新加载规格</Button>
   <Button class="download-button" :disabled="busy||planning||!!localError||!!registrationConflict||!plan" @click="download"><Download :size="20"/>{{busy?'正在生成…':'生成并下载 PDF'}}</Button>
  </div>
  <div class="pdf-preview">
   <div class="preview-toolbar"><strong>定位组预览 · {{boardLabel}}</strong><span>{{gridSize}} × {{gridSize}} · {{groupSizeMm}} mm</span></div>
   <div class="board-area"><div class="board-preview"><img v-if="!localError&&gridOption" :src="previewUrl" :alt="boardLabel+' 完整定位组'"/></div></div>
   <div v-if="plan" class="board-list"><div class="board-list-title">组编号与子码</div><div v-for="board in plan.boards" :key="board.id" class="board-row"><strong>{{board.id}}</strong><span>{{board.members.map(member=>label(member.id)).join(' · ')}}</span></div></div>
   <div class="preview-status">tag36h11 · A4 · 每页 1 组</div>
  </div>
 </section>
</template>
<style scoped>
.crosshair-note.crosshair-unavailable{color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:7px 9px}
.crosshair-option{display:flex;flex-direction:row;align-items:center;gap:8px}.crosshair-note{display:block;margin-top:7px;color:var(--muted);font-size:11px;line-height:1.6}.crosshair-option input{width:16px;height:16px;padding:0;accent-color:var(--accent)}

.pdf-workspace{display:flex;flex:1;min-height:0;overflow:hidden}
.pdf-controls{width:350px;flex-shrink:0;padding:14px;overflow-y:auto;background:var(--background);border-right:1px solid var(--panel)}
h2{display:flex;align-items:center;gap:10px;margin:0 0 20px;font-size:18px;font-weight:600;color:var(--ink)}
fieldset{margin:0;padding:0;border:0;min-width:0}
.pdf-controls label{margin-top:16px}
legend{font-size:14px;color:var(--muted);margin-bottom:12px}
.grid-options{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.grid-option{padding:13px 8px;min-height:46px;background:var(--background);border:1px solid var(--line);color:var(--muted);border-radius:8px;font-size:14px;font-weight:500}
.grid-option.selected{border-color:var(--accent);background:var(--panel);color:var(--accent);box-shadow:none}
.grid-option:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.size-status{font-size:14px;color:var(--muted);margin-top:8px}
.pdf-summary{display:grid;gap:15px;margin:20px 0;padding:16px;background:var(--panel);border:1px solid var(--panel);border-radius:8px}
.pdf-summary>div{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;line-height:1.5}
.pdf-summary span{color:var(--muted)}
.pdf-summary strong{font-weight:500;color:var(--accent);white-space:nowrap}
.pdf-error,.pdf-success{display:flex;align-items:flex-start;gap:10px;line-height:1.6;font-size:14px;padding:14px 0}
.pdf-error{color:var(--accent)}.pdf-success{color:var(--ink)}.pdf-error svg,.pdf-success svg{flex-shrink:0;margin-top:3px}
.download-button{width:100%;margin-top:10px}
.pdf-preview{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1;background:var(--background);overflow-y:auto}
.preview-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:var(--background);border-bottom:1px solid var(--panel);font-size:14px;flex-wrap:wrap}
.preview-toolbar strong{font-weight:500;color:var(--ink)}.preview-toolbar span{color:var(--muted)}
.board-area{padding:30px;display:flex;justify-content:center;align-items:center;min-height:340px;flex:1}
.board-preview{width:min(100%,460px);aspect-ratio:1;background:var(--background);box-shadow:none;flex-shrink:0}
.board-preview img{display:block;width:100%;height:100%;object-fit:contain}
.board-list{margin:0 26px 22px;background:var(--background);border:1px solid var(--panel);border-radius:8px;padding:10px 12px;max-height:240px;overflow-y:auto;flex-shrink:0}
.board-list-title{font-size:14px;font-weight:600;color:var(--ink);margin-bottom:10px}
.board-row{display:flex;align-items:flex-start;gap:14px;font-size:14px;line-height:1.7;padding:10px 0;border-top:1px solid var(--panel);color:var(--muted)}.board-row strong{color:var(--accent);font-weight:500;flex-shrink:0}.board-row span{overflow-wrap:anywhere}
.preview-status{border-top:1px solid var(--panel);background:var(--background);padding:16px 26px;font-size:14px;color:var(--muted);flex-shrink:0}
@media(max-width:1200px){.pdf-controls{width:320px;padding:14px}.board-area{padding:14px}}
@media(max-width:760px){.pdf-workspace{flex-direction:column;overflow:visible}.pdf-controls{width:100%;overflow:visible;border-right:0;border-bottom:1px solid var(--panel)}.pdf-preview{overflow:visible}.board-area{min-height:300px}.preview-toolbar{padding:18px 22px}.board-list{margin:0 22px 22px}}
</style>
