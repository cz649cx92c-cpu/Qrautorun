<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,ref,watch} from 'vue';
import type {FieldMap,Point} from '../../../shared/model';
import {neighborsOnLine,previewTagDistance,previewEqualSpacing,TAG_DISTANCE_DISCLAIMER,MIN_TAG_DISTANCE_M,type TagLine} from '../../../shared/map-tag-distance';
import {tagPositionLabel} from '../../../shared/map-tag-position';
import Button from './ui/Button.vue';
import {AlertTriangle,ArrowLeftRight,CheckCircle2,Columns3,Rows3,Save,X} from 'lucide-vue-next';

const props=defineProps<{map:FieldMap;version:number;selection:number[];disabled?:boolean}>();
const emit=defineEmits<{
 'preview-map':[map:FieldMap|null];
 editing:[active:boolean];
 'update:selection':[ids:number[]];
 applied:[result:any];
}>();

const active=ref(false),busy=ref(false),error=ref(''),message=ref('');
const base=ref<FieldMap|null>(null);
// 目标间距以**厘米**录入（与画布上的就地输入框同一单位），
// 内部一律换算成米交给预览与接口。用字符串草稿而不是数字双向绑定：
// 数字输入框每次重渲染都会把用户刚敲的字符改写成别的值。
const targetText=ref<string>('');
// 只接受字符串草稿：`v-model` 绑在 type="number" 上会被 Vue 自动转成数字，
// 任何字符串操作都会抛错，进而把整个预览 computed 弄挂、保存按钮静默失效。
function onTargetInput(event:Event){targetText.value=(event.target as HTMLInputElement).value;}
const targetM=computed<number|null>({
 get(){
  const raw=targetText.value.trim();
  if(raw==='')return null;
  const cm=Number(raw);
  if(!Number.isFinite(cm)||cm<=0)return null;
  return Number((cm/100).toFixed(4));
 },
 set(value){
  targetText.value=value===null||value===undefined?'':String(Number((value*100).toFixed(1)));
 }
});
const mode=ref<'auto'|'pair'|'spacing'>('auto');

// 基准永远跟随父组件最新地图：保存升版本后必须立即反映新坐标。
const source=computed(()=>props.map);
const selection=computed(()=>props.selection.filter(id=>source.value.tags.some(tag=>tag.id===id)));
const selectedTags=computed(()=>selection.value.map(id=>source.value.tags.find(tag=>tag.id===id)!).filter(Boolean));
const tagsById=computed(()=>new Map(source.value.tags.map(tag=>[tag.id,tag])));

/** The straight line that the current selection lives on, if any. */
const line=computed<TagLine|null>(()=>{
 const first=selection.value[0];
 if(first===undefined)return null;
 const hood=neighborsOnLine(source.value,first);
 for(const candidate of [hood.horizontal,hood.vertical]){
  if(!candidate)continue;
  const members=new Set(candidate.points.map(point=>point.id));
  if(selection.value.every(id=>members.has(id)))return candidate;
 }
 return null;
});
const onOneLine=computed(()=>selection.value.length>=2&&line.value!==null);
const orderedSelection=computed(()=>{
 const current=line.value;
 if(!current)return selection.value;
 const order=new Map(current.points.map((point,index)=>[point.id,index]));
 return [...selection.value].sort((a,b)=>(order.get(a)??0)-(order.get(b)??0));
});

const gaps=computed(()=>{
 const ids=orderedSelection.value;
 // 预览就绪时用预览地图，让列表与画布一致（所见即所得）。
 const map=(preview.value as any)?.map??source.value;
 const byId=new Map<number,{id:number;x:number;y:number}>(map.tags.map((t:any)=>[t.id as number,t as {id:number;x:number;y:number}]));
 const result:{from:number;to:number;m:number}[]=[];
 for(let i=1;i<ids.length;i++){
  const a=byId.get(ids[i-1]!),b=byId.get(ids[i]!);
  if(a&&b)result.push({from:a.id,to:b.id,m:Math.hypot(b.x-a.x,b.y-a.y)});
 }
 return result;
});
const uniformGap=computed(()=>{
 if(!gaps.value.length)return null;
 const first=gaps.value[0]!.m;
 return gaps.value.every(gap=>Math.abs(gap.m-first)<0.005)?first:null;
});
const effectiveMode=computed<'pair'|'spacing'>(()=>{
 if(mode.value!=='auto')return mode.value;
 return selection.value.length===2?'pair':'spacing';
});

const pairPreview=computed(()=>{
 if(!base.value||effectiveMode.value!=='pair'||selection.value.length!==2||targetM.value===null)return null;
 const [fromId,toId]=orderedSelection.value;
 try{return previewTagDistance(base.value,{fromId:fromId!,toId:toId!,targetM:targetM.value});}
 catch(reason){return {ready:false,reasons:[{message:reason instanceof Error?reason.message:String(reason)}]} as any;}
});
const spacingPreview=computed(()=>{
 if(!base.value||effectiveMode.value!=='spacing'||selection.value.length<2||targetM.value===null)return null;
 try{return previewEqualSpacing(base.value,{ids:orderedSelection.value,targetM:targetM.value});}
 catch(reason){return {ready:false,reasons:[{message:reason instanceof Error?reason.message:String(reason)}]} as any;}
});
const preview=computed(()=>effectiveMode.value==='pair'?pairPreview.value:spacingPreview.value);
// 预览候选地图同步给画布：输入目标值后图上标注立刻变成新距离，避免"看着还是 53.2"。
watch(preview,value=>{
 if(!active.value)return;
 if(value?.ready&&value.map)emit('preview-map',value.map as any);
 else emit('preview-map',base.value??props.map);
},{flush:'post'});
const blocking=computed(()=>((preview.value?.reasons??[]) as any[]).map(reason=>reason.message));
const ready=computed(()=>!!preview.value?.ready);
// 按钮可点的条件：有选择 + 填了目标 + 没有阻塞原因。
// 与当前值相同不再让按钮变灰，点下去会明确提示"与当前相同"。
const canSave=computed(()=>selection.value.length>=2&&targetM.value!==null&&blocking.value.filter(m=>!/没有可保存|已经按目标间距/.test(m)).length===0);

const triple=(m:number)=>`${m.toFixed(3)} m（${(m*100).toFixed(1)} cm / ${(m*1000).toFixed(0)} mm）`;
const shortTriple=(m:number)=>`${(m*100).toFixed(1)} cm`;

function start(){
 if(active.value||props.disabled||busy.value)return;
 base.value=props.map;targetM.value=null;mode.value='auto';error.value='';message.value='';
 active.value=true;emit('editing',true);emit('preview-map',null);
}
function exit(){
 if(!active.value)return;
 active.value=false;base.value=null;targetM.value=null;error.value='';emit('preview-map',null);emit('editing',false);
}
// 以 0.1 cm 精度播种。以前四舍五入到整厘米，53.2 cm 会被写成 53 cm，
// 于是“用当前值”本身就先改掉了 2 mm，用户看到的就是数字自己变了。
const seedFrom=(m:number)=>Number((Math.round(m*1000)/1000).toFixed(3));
function seedIfEmpty(){
 if(targetM.value!==null&&targetM.value!==undefined)return;
 const uniform=uniformGap.value;
 const first=gaps.value[0]?.m;
 const base=uniform??first??null;
 if(base!==null)targetM.value=seedFrom(base);
}
function selectTag(id:number|null){
 if(!active.value)return;
 if(id===null){emit('update:selection',[]);return;}
 const next=props.selection.includes(id)?props.selection.filter(item=>item!==id):[...props.selection,id];
 emit('update:selection',next);
 void nextTick(seedIfEmpty);
}
function addFromList(raw:string){
 if(!raw)return;
 const id=Number(raw);
 if(!Number.isFinite(id)||selection.value.includes(id))return;
 emit('update:selection',[...props.selection,id]);
 void nextTick(seedIfEmpty);
}
function selectAllOnLine(){
 const current=line.value;
 if(!current)return;
 emit('update:selection',current.points.map(point=>point.id));
 void nextTick(seedIfEmpty);
}
function seedTarget(){
 const uniform=uniformGap.value;
 const base=uniform??gaps.value[0]?.m??null;
 targetM.value=base===null?null:seedFrom(base);
}
async function save(){
 if(!active.value||props.disabled||busy.value)return;
 if(!ready.value){
 const why=blocking.value.join('；');
 error.value = why || (targetM.value===null?'请填写目标间距（米）':'当前已按该间距排列，无需改动');
 return;
}
 busy.value=true;error.value='';message.value='';
 const endpoint=effectiveMode.value==='pair'?'tag-distance':'tag-equal-spacing';
 const body=effectiveMode.value==='pair'
  ?{baseVersion:props.version,fromId:orderedSelection.value[0],toId:orderedSelection.value[1],targetM:targetM.value}
  :{baseVersion:props.version,ids:orderedSelection.value,targetM:targetM.value};
 try{
  const response=await fetch(`/api/maps/${encodeURIComponent(props.map.id)}/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw Object.assign(new Error(result.error??'保存新地图版本失败'),{status:response.status});
  // 回读服务端真正落库的间距：如果与填写值不同，必须当场说出来，
  // 而不是复述输入值让现场以为改成功了。
  const achieved=typeof result.afterM==='number'?result.afterM
   :typeof result.targetM==='number'?result.targetM:null;
  const asked=targetM.value;
  const success=achieved!==null&&asked!==null&&Math.abs(achieved-asked)>0.001
   ? `已保存到地图 v${result.version}：实际间距 ${(achieved*100).toFixed(1)} cm（填写 ${(asked*100).toFixed(1)} cm）`
   : `已保存到地图 v${result.version}（原地更新，间距 ${achieved===null?'已写入':(achieved*100).toFixed(1)+' cm'}）`;
  // 不退出调整：现场要连续改多组，保存后立刻能看到新的间距。
  // 基准地图换成新版本，草稿清空，选区保留。
  // 接口回包里就是新版本地图；用它替换基准，gaps 立刻反映新间距。
  if(result.map)base.value=result.map as any;
  targetM.value=null;
  message.value=success;
  emit('preview-map',null);
  emit('applied',result);
  // 兜底：无论如何都让基准回到最新
  base.value=props.map;
 }catch(reason){
  const status=Number((reason as {status?:number}).status);
  error.value=status===409?'地图版本已变化，未保存任何改动；请重新加载最新版本后再调整':reason instanceof Error?reason.message:String(reason);
 }finally{busy.value=false;}
}
watch([()=>props.map.id],()=>{if(active.value)exit();});
// 版本变化（保存后升版本）不能退出调整，否则用户刚改完就被踢出面板。
watch(()=>props.version,(next,prev)=>{
 if(!active.value||next===prev)return;
 base.value=props.map;targetText.value='';emit('preview-map',null);
});
// 父组件换了地图（画布上就地改间距保存成功、或其它面板保存成功）时，
// 必须同时清空本面板的目标值：否则预览会按**旧目标**重算一遍并把结果
// 重新 emit 成画布草稿，把刚保存的新间距顶回旧值——这就是
// “我在这调整 55，应用自己又调回 53”的真实原因。
watch(()=>props.map,(map,previous)=>{
 if(!active.value)return;
 base.value=map;
 if(previous&&map!==previous){targetText.value='';emit('preview-map',null);}
},{deep:false});
watch(()=>props.disabled,disabled=>{if(disabled&&active.value)exit();});
onBeforeUnmount(()=>{if(active.value){active.value=false;emit('preview-map',null);emit('editing',false);}});
defineExpose({start,isActive:()=>active.value});
</script>

<template>
 <div class="map-spacing" data-testid="map-qr-spacing" :data-map-version="version">
  <div class="map-spacing-head">
   <strong><ArrowLeftRight :size="15"/> 二维码间距</strong>
   <span v-if="active" class="map-spacing-count" data-testid="map-spacing-count">已选 {{selection.length}} 个</span>
   <Button v-if="!active" size="sm" variant="outline" :disabled="disabled||busy" data-testid="map-spacing-start" @click.prevent="start">开始调整</Button>
   <Button v-else size="sm" variant="ghost" data-testid="map-spacing-exit" @click.prevent="exit"><X :size="14"/>退出</Button>
  </div>

  <p v-if="!active" class="map-spacing-hint">开始后在画布上直接<b>点选二维码</b>（可多选），再输入统一间距即可批量调整。</p>
  <p v-else class="map-spacing-hint">在画布上点选二维码：点一个＝改它与相邻码的距离；点一排＝整排统一等间距。</p>

  <template v-if="active">
   <label class="map-spacing-add">
    <select :value="''" :disabled="busy" data-testid="map-spacing-add" @change="addFromList(($event.target as HTMLSelectElement).value);($event.target as HTMLSelectElement).value=''">
     <option value="">＋ 从列表添加二维码</option>
     <option v-for="tag in source.tags" :key="'add'+tag.id" :value="tag.id" :disabled="selection.includes(tag.id)">{{tagPositionLabel(tag)}}{{selection.includes(tag.id)?'（已选）':''}}</option>
    </select>
   </label>
   <div class="map-spacing-chips" data-testid="map-spacing-chips">
    <button v-for="tag in selectedTags" :key="tag.id" type="button" class="map-spacing-chip" :title="'取消选择 '+tagPositionLabel(tag)" @click.prevent="selectTag(tag.id)">{{tagPositionLabel(tag)}}<span>×</span></button>
    <span v-if="!selectedTags.length" class="map-spacing-empty">尚未选择二维码</span>
   </div>

   <div v-if="selection.length>=2" class="map-spacing-modes">
    <span :class="['map-spacing-badge',onOneLine?'is-good':'is-bad']" data-testid="map-spacing-line">
     <template v-if="onOneLine">{{line?.axis==='horizontal'?'同一水平线':'同一竖直线'}} · {{selection.length}} 个</template>
     <template v-else>不在同一条直线上（不能批量等间距）</template>
    </span>
    <Button v-if="onOneLine&&selection.length>1" size="sm" variant="outline" data-testid="map-spacing-select-all" @click.prevent="selectAllOnLine">选中整排</Button>
   </div>

   <div v-if="gaps.length" class="map-spacing-gaps" data-testid="map-spacing-gaps">
    <div v-for="(gap,index) in gaps" :key="'g'+index" class="map-spacing-gap">
     <span>{{tagsById.get(gap.from) ? tagPositionLabel(tagsById.get(gap.from)!) : gap.from}} → {{tagsById.get(gap.to) ? tagPositionLabel(tagsById.get(gap.to)!) : gap.to}}</span>
     <b>{{shortTriple(gap.m)}}</b>
    </div>
    <div v-if="uniformGap!==null" class="map-spacing-uniform" data-testid="map-spacing-uniform">当前已等间距 {{shortTriple(uniformGap)}}</div>
   </div>

   <label v-if="selection.length>=2" class="map-spacing-field">
    {{effectiveMode==='pair'?'目标中心距离':'统一间距'}} / 厘米
    <input :value="targetText" type="number" min="8" step="0.1" :disabled="busy" data-testid="map-spacing-target" aria-label="目标中心间距（厘米）" @input="onTargetInput"/>
    <span class="map-spacing-unit" data-testid="map-spacing-target-m">{{targetM===null?'—':targetM.toFixed(3)+' m'}}</span>
    <Button size="sm" variant="outline" :disabled="busy" data-testid="map-spacing-seed" @click.prevent="seedTarget">用当前值</Button>
   </label>

   <div v-if="preview" class="map-spacing-preview" data-testid="map-spacing-preview">
    <div v-if="ready">
     <template v-if="effectiveMode==='pair'">调整后距离 {{triple(preview.afterM)}}；位移 {{(preview.displacementM*100).toFixed(1)}} cm</template>
     <template v-else>{{preview.count}} 个二维码统一等间距 {{triple(preview.targetM)}}；跨距 {{preview.spanBeforeM.toFixed(3)}}→{{preview.spanAfterM.toFixed(3)}} m；最大位移 {{(preview.maxDisplacementM*100).toFixed(1)}} cm</template>
    </div>
    <div v-else class="map-spacing-blocked">{{blocking.join('；')}}</div>
   </div>

   <div class="map-spacing-actions">
    <Button size="sm" :disabled="busy||disabled||!canSave" data-testid="map-spacing-save" @click.prevent="save"><Save :size="14"/>{{busy?'正在保存…':'保存到当前地图 v'+version}}</Button>
    <span class="map-spacing-note">直接改这张图的点位，不新建版本、不改路径</span>
   </div>

   <div v-if="error" class="map-spacing-alert error" role="alert" data-testid="map-spacing-error"><AlertTriangle :size="15"/>{{error}}</div>
   <div v-if="message" class="map-spacing-alert success" role="status"><CheckCircle2 :size="15"/>{{message}}</div>
  </template>
 </div>
</template>

<style scoped>
.map-spacing{display:flex;flex-direction:column;gap:7px;padding:10px;border:1px solid var(--line);border-radius:9px;background:white}
.map-spacing-head{display:flex;align-items:center;gap:6px;font-size:13px;color:#1e293b;flex-wrap:nowrap}
.map-spacing-head strong{display:inline-flex;align-items:center;gap:5px;font-weight:650;white-space:nowrap;flex:0 0 auto}
.map-spacing-head .btn,.map-spacing-head button{flex:0 0 auto;white-space:nowrap}
.map-spacing-count{margin-left:auto;color:var(--muted);font-size:11.5px;white-space:nowrap;flex:0 0 auto}
.map-spacing-hint{margin:0;color:var(--muted);font-size:11.5px;line-height:1.55}
.map-spacing-add select{width:100%;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;font:inherit;font-size:11.5px;color:#334155;background:white}
.map-spacing-chips{display:flex;flex-wrap:wrap;gap:4px;min-height:24px}
.map-spacing-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border:1px solid #bfdbfe;border-radius:999px;background:#eff6ff;color:#1d4ed8;font-size:11px;cursor:pointer}
.map-spacing-chip span{opacity:.6;font-size:13px;line-height:1}
.map-spacing-empty{color:var(--muted);font-size:11.5px}
.map-spacing-modes{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.map-spacing-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px}
.map-spacing-badge.is-good{background:#ecfdf5;color:#047857}
.map-spacing-badge.is-bad{background:#fef2f2;color:#b91c1c}
.map-spacing-gaps{display:flex;flex-direction:column;gap:2px;max-height:120px;overflow:auto;padding:5px 7px;border-radius:6px;background:var(--panel);font-size:11.5px}
.map-spacing-gap{display:flex;justify-content:space-between;gap:10px;color:#475569}
.map-spacing-uniform{margin-top:2px;color:#047857;font-size:11px}
.map-spacing-field{display:flex;align-items:center;gap:6px;font-size:12px;color:#334155}
.map-spacing-field input{width:82px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;font:inherit;text-align:right;font-variant-numeric:tabular-nums}
.map-spacing-unit{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.map-spacing-preview{padding:6px 8px;border-radius:6px;background:#f8fafc;font-size:11.5px;line-height:1.6;color:#334155}
.map-spacing-blocked{color:#b91c1c}
.map-spacing-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.map-spacing-note{color:var(--muted);font-size:10.5px}
.map-spacing-alert{display:flex;align-items:center;gap:5px;padding:5px 8px;border-radius:6px;font-size:11.5px}
.map-spacing-alert.error{background:#fef2f2;color:#b91c1c}
.map-spacing-alert.success{background:#ecfdf5;color:#047857}
</style>
