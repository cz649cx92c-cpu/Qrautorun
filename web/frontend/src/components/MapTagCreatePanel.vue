<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import type {FieldMap} from '../../../shared/model';
import {
 createTag,createTagGrid,createTagLine,
 DEFAULT_TAG_SIZE_M,MAX_GRID_POINTS,MIN_CREATION_DISTANCE_M,TAG_CREATION_DISCLAIMER,
 type TagCreatePreview,type TagCreationIssue,type TagGridPreview,type TagLinePreview,
} from '../../../shared/map-tag-creation';
import {tagPositionLabel} from '../../../shared/map-tag-position';
import Button from './ui/Button.vue';
import {AlertTriangle,ArrowLeftRight,CheckCircle2,Plus,Save,X} from 'lucide-vue-next';

const props=defineProps<{map:FieldMap;version:number;disabled?:boolean;selectedTagId?:number|null}>();
const emit=defineEmits<{
 'preview-map':[map:FieldMap|null];
 'draft-map':[map:FieldMap|null];
 editing:[active:boolean];
 applied:[result:any];
 'update:selectedTagId':[id:number|null];
}>();

type Mode='single'|'grid'|'line';
type GridOrder='row-major'|'col-major';
const MODES:[{key:Mode;label:string},{key:Mode;label:string},{key:Mode;label:string}]=[
 {key:'single',label:'单点'},
 {key:'grid',label:'阵列'},
 {key:'line',label:'直线'},
];

const active=ref(false),busy=ref(false),error=ref(''),message=ref('');
// 用户手动拖/删过的草稿点位：为 null 时跟随参数重算，非 null 时以用户编辑为准。
type DraftTag={id:number;x:number;y:number;angle:number;size:number};
const draftOverride=ref<DraftTag[]|null>(null);
const confirmDeleteId=ref<number|null>(null);
const mode=ref<Mode>('grid');
const single=ref({x:0,y:0,angleDeg:0,sizeM:DEFAULT_TAG_SIZE_M});
const grid=ref({originX:0,originY:0,columns:4,rows:3,pitchXM:0.2,pitchYM:0.2,angleDeg:0,sizeM:DEFAULT_TAG_SIZE_M,startId:null as number|null,order:'row-major' as GridOrder});
const line=ref({fromTagId:null as number|null,startX:0,startY:0,count:5,spacingM:0.2,axis:'horizontal' as 'horizontal'|'vertical',direction:1 as 1|-1,angleDeg:0,sizeM:DEFAULT_TAG_SIZE_M});

const pad=(id:number)=>'Q'+String(id).padStart(3,'0');
const cm=(m:number)=>`${(m*100).toFixed(1)} cm`;
const numberOf=(event:Event)=>(event.target as HTMLInputElement).valueAsNumber;
/** 行/列/数量必须保持整数：输入框被清空时保留上一个有效值，避免把 0 或 NaN 送进引擎。 */
const intOf=(event:Event,fallback:number)=>{const value=numberOf(event);return Number.isFinite(value)&&value>=1?Math.round(value):fallback;};
const minimumGapText=`${(MIN_CREATION_DISTANCE_M*100).toFixed(0)} cm`;

/** 只接受有限数值：NaN（清空输入框）时按“还不能预览”处理，不把 NaN 送进引擎。 */
const finite=(...values:number[])=>values.every(value=>Number.isFinite(value));

interface Outcome{preview:TagCreatePreview|TagGridPreview|TagLinePreview|null;error:string}
const outcome=computed<Outcome>(()=>{
 if(!active.value)return {preview:null,error:''};
 try{
  if(mode.value==='single'){
   const form=single.value;
   if(!finite(form.x,form.y))return {preview:null,error:'请填写有效的中心坐标 X / Y（米）'};
   if(!finite(form.angleDeg))return {preview:null,error:'请填写有效的朝向（度）'};
   if(!finite(form.sizeM))return {preview:null,error:'请填写有效的边长（米）'};
   return {preview:createTag(props.map,{x:form.x,y:form.y,angleDeg:form.angleDeg,sizeM:form.sizeM}),error:''};
  }
  if(mode.value==='grid'){
   const form=grid.value;
   if(!finite(form.originX,form.originY))return {preview:null,error:'请填写有效的阵列原点 X / Y（米）'};
   if(!finite(form.columns)||!finite(form.rows)||form.columns<1||form.rows<1)return {preview:null,error:'列数与行数都必须是 ≥ 1 的整数'};
   if(!finite(form.pitchXM,form.pitchYM)||form.pitchXM<=0||form.pitchYM<=0)return {preview:null,error:'列距与行距都必须是正的有限数值（米）'};
   if(!finite(form.angleDeg,form.sizeM))return {preview:null,error:'请填写有效的朝向与边长'};
   return {preview:createTagGrid(props.map,{originX:form.originX,originY:form.originY,columns:Math.round(form.columns),rows:Math.round(form.rows),spacingXM:form.pitchXM,spacingYM:form.pitchYM,angleDeg:form.angleDeg,sizeM:form.sizeM,onConflict:'reject'}),error:''};
  }
  const form=line.value;
  if(!finite(form.count)||form.count<1)return {preview:null,error:'数量必须是 ≥ 1 的整数'};
  if(!finite(form.spacingM)||form.spacingM<=0)return {preview:null,error:'间距必须是正的有限数值（米）'};
  if(!finite(form.angleDeg,form.sizeM))return {preview:null,error:'请填写有效的朝向与边长'};
  if(form.fromTagId===null){
   if(!finite(form.startX,form.startY))return {preview:null,error:'请填写有效的起点坐标 X / Y（米），或从已有点位开始'};
   return {preview:createTagLine(props.map,{startX:form.startX,startY:form.startY,count:Math.round(form.count),spacingM:form.spacingM,axis:form.axis,direction:form.direction,angleDeg:form.angleDeg,sizeM:form.sizeM}),error:''};
  }
  return {preview:createTagLine(props.map,{fromTagId:form.fromTagId,count:Math.round(form.count),spacingM:form.spacingM,axis:form.axis,direction:form.direction,angleDeg:form.angleDeg,sizeM:form.sizeM}),error:''};
 }catch(reason){
  return {preview:null,error:reason instanceof Error?reason.message:String(reason)};
 }
});
const preview=computed(()=>outcome.value.preview);
const ready=computed(()=>!!preview.value?.ready);
const reasons=computed<TagCreationIssue[]>(()=>preview.value?.reasons??[]);
const notes=computed<TagCreationIssue[]>(()=>preview.value?.notes??[]);
const safetyNotes=computed(()=>notes.value.filter(note=>/禁止|安全|未验收|冲突|风险/.test(note.message)));
const optionalNotes=computed(()=>notes.value.filter(note=>!safetyNotes.value.includes(note)));
const gridPreview=computed<TagGridPreview|null>(()=>mode.value==='grid'?(preview.value as TagGridPreview|null):null);
const linePreview=computed<TagLinePreview|null>(()=>mode.value==='line'?(preview.value as TagLinePreview|null):null);
const singlePreview=computed<TagCreatePreview|null>(()=>mode.value==='single'?(preview.value as TagCreatePreview|null):null);
const skipped=computed(()=>gridPreview.value?.skipped??[]);
const existingTags=computed(()=>[...props.map.tags].sort((a,b)=>a.id-b.id));

/** 预览里“将新建多少个码”。 */
const countText=computed(()=>{
 const current=preview.value;
 if(!current)return '—';
 return `${mode.value==='single'?1:('created' in current?current.created:0)} 个`;
});
const blockingMessage=computed(()=>error.value||outcome.value.error||reasons.value[0]?.message||(!ready.value?'请补全参数':''));
/** X/Y 跨度。 */
const spanText=computed(()=>{
 const current=preview.value;
 if(!current)return '—';
 if(mode.value==='grid'){const value=current as TagGridPreview;return value.created?`X ${cm(value.spanXM)} · Y ${cm(value.spanYM)}`:'—';}
 if(mode.value==='line'){const value=current as TagLinePreview;return value.created?`${value.axis==='horizontal'?'沿 X':'沿 Y'} ${cm(value.spanM)}`:'—';}
 return '单点无跨度';
});
const gridStartHint=computed(()=>{
 const current=gridPreview.value,form=grid.value;
 if(!current||!current.tags.length||form.startId===null||!finite(form.startId))return '';
 const wanted=Math.round(form.startId),actual=current.tags[0]!.id;
 return actual===wanted?`本批首号正好是 ${pad(actual)}`:`本批首号是 ${pad(actual)}，与期望的 ${pad(wanted)} 不一致（编号由后端按最小可用编号分配）`;
});
/** 编号顺序只影响预览列表的排序（引擎固定行优先分配）。 */
const gridPoints=computed(()=>{
 const current=gridPreview.value;
 if(!current)return [];
 const form=grid.value;
 const safe=finite(form.pitchXM,form.pitchYM)&&form.pitchXM>0&&form.pitchYM>0;
 const points=current.tags.map(tag=>{
  const column=safe?Math.round((tag.x-form.originX)/form.pitchXM):0;
  const row=safe?Math.round((tag.y-form.originY)/form.pitchYM):0;
  return {id:tag.id,column,row,x:tag.x,y:tag.y};
 });
 return form.order==='col-major'
  ?[...points].sort((a,b)=>a.column-b.column||a.row-b.row)
  :[...points].sort((a,b)=>a.row-b.row||a.column-b.column);
});
const linePoints=computed(()=>linePreview.value?.points??[]);
/** 草稿点位：参数变化后重算，用户拖/删后以 override 为准。 */
const draftTags=computed<DraftTag[]>(()=>{
 if(draftOverride.value)return draftOverride.value;
 const candidate=preview.value;
 const map=candidate?.ready?candidate.map:null;
 if(!map)return [];
 const baseIds=new Set(props.map.tags.map(t=>t.id));
 return map.tags.filter(t=>!baseIds.has(t.id)).map(t=>({id:t.id,x:t.x,y:t.y,angle:t.angle,size:t.size}));
});
/** 草稿地图：真实二维码节点，画布可立即选中/拖动/删除。 */
const draftMap=computed<FieldMap|null>(()=>{
 if(!active.value)return null;
 const tags=draftTags.value;
 const ids=new Set(tags.map(t=>t.id));
 return {...props.map,tags:[...props.map.tags.filter(t=>!ids.has(t.id)),...tags.map(t=>({...t,rowId:'',kind:'waypoint' as const,rules:[]}))]};
});
function materializeDraft():DraftTag[]{if(!draftOverride.value)draftOverride.value=[...draftTags.value];return draftOverride.value;}
/** 画布拖动：只移动草稿里的新点，不动已存在的生产点。 */
function moveDraft(ids:number[],dx:number,dy:number):void{
 if(!active.value||props.disabled)return;
 const next=materializeDraft().map(tag=>ids.includes(tag.id)?{...tag,x:tag.x+dx,y:tag.y+dy}:tag);
 draftOverride.value=next;emit('draft-map',draftMap.value);
}
function requestDeleteDraft(id:number|null):void{if(id===null||props.disabled)return;confirmDeleteId.value=id;}
function confirmDeleteDraft():void{
 const id=confirmDeleteId.value;confirmDeleteId.value=null;
 if(id===null)return;
 draftOverride.value=materializeDraft().filter(tag=>tag.id!==id);
 if(props.selectedTagId===id)emit('update:selectedTagId',draftOverride.value[0]?.id??null);
 emit('draft-map',draftMap.value);
 message.value=`已从草稿移除 ${pad(id)}`;
}
watch(draftMap,map=>{if(active.value)emit('draft-map',map);},{flush:'post'});
/** 参数调整后草稿跟随重算（用户没有手动编辑过时）。 */
watch([mode,preview],()=>{draftOverride.value=null;confirmDeleteId.value=null;});

/** 画布 ghost 预览：预览地图里尚不存在的新点（父组件可选用 ghostTags prop 接线）。 */
/** ghost 已停用：新点直接按真实二维码进入草稿，避免不可编辑的半透明预览。 */
const ghostTags=computed<{x:number;y:number;id?:number}[]>(()=>[]);
/** 画布拖动 ghost 主锚点后回写表单：保持单一数据源（预览仍由表单推导）。 */
function moveGhost(index:number,point:{x:number;y:number}):void{
 if(!active.value||props.disabled)return;
 if(!Number.isFinite(point.x)||!Number.isFinite(point.y))return;
 if(mode.value==='single'){
  single.value={...single.value,x:point.x,y:point.y};
  return;
 }
 if(mode.value==='grid'){
  grid.value={...grid.value,originX:point.x,originY:point.y};
  return;
 }
 // 直线等距：拖动第一点即改起点
 line.value={...line.value,startX:point.x,startY:point.y};
}
const canSave=computed(()=>active.value&&ready.value&&!busy.value&&!props.disabled);

// 预览地图同步给画布：ready 时才给整张候选地图，否则回到无预览。
watch([preview,active],()=>{
 if(!active.value)return;
 const current=preview.value;
 emit('preview-map',current?.ready&&current.map?current.map:null);
},{flush:'post'});

/** 换地图才重新播种默认坐标：同一张图上重复进出不应覆盖用户改过的值。 */
let seededFor='';
function seedFromZone(){
 if(seededFor===props.map.id)return;
 seededFor=props.map.id;
 const zone=props.map.zone;
 if(!zone.length)return;
 const round=(value:number)=>Math.round(value*1000)/1000;
 const cx=round(zone.reduce((sum,point)=>sum+point.x,0)/zone.length);
 const cy=round(zone.reduce((sum,point)=>sum+point.y,0)/zone.length);
 single.value={...single.value,x:cx,y:cy};
 grid.value={...grid.value,originX:cx,originY:cy};
 line.value={...line.value,startX:cx,startY:cy};
}

function start(){
 if(active.value||props.disabled||busy.value)return;
 error.value='';message.value='';
 seedFromZone();
 active.value=true;draftOverride.value=null;confirmDeleteId.value=null;emit('editing',true);emit('preview-map',null);
}
function deactivate(){
 if(!active.value)return;
 active.value=false;error.value='';busy.value=false;draftOverride.value=null;confirmDeleteId.value=null;
 emit('preview-map',null);emit('editing',false);
}
function switchMode(next:Mode){
 if(busy.value||mode.value===next)return;
 mode.value=next;error.value='';message.value='';
}
function saveBody(){
 const form=grid.value,current=line.value,point=single.value;
 if(mode.value==='single')return {x:point.x,y:point.y,sizeM:point.sizeM,angleDeg:point.angleDeg};
 if(mode.value==='grid')return {originX:form.originX,originY:form.originY,columns:Math.round(form.columns),rows:Math.round(form.rows),spacingXM:form.pitchXM,spacingYM:form.pitchYM,angleDeg:form.angleDeg,sizeM:form.sizeM,onConflict:'reject'};
 const common={count:Math.round(current.count),spacingM:current.spacingM,axis:current.axis,direction:current.direction,angleDeg:current.angleDeg,sizeM:current.sizeM};
 return current.fromTagId===null?{startX:current.startX,startY:current.startY,...common}:{fromTagId:current.fromTagId,...common};
}
function savePath(){
 return mode.value==='single'?'tags/create':mode.value==='grid'?'tags/grid':'tags/line';
}
async function save(){
 if(!canSave.value)return;
 const current=preview.value;
 if(!current?.ready){
  error.value=reasons.value.map(reason=>reason.message).join('；')||outcome.value.error||'当前参数还不能保存';
  message.value='';
  return;
 }
 busy.value=true;error.value='';message.value='';
 try{
  const draft=draftMap.value;
  if(draft){
   // 草稿即真值：保存这次编辑产生的确切点位，而不是按参数重算一遍。
   const response=await fetch('/api/maps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({map:draft,baseVersion:props.version})});
   const saved=await response.json() as {map?:FieldMap;version?:number;error?:string};
   if(!response.ok)throw Object.assign(new Error(saved.error??'保存失败'),{status:response.status});
   message.value=`已保存到地图 v${saved.version??props.version}，草稿内 ${draft.tags.length-props.map.tags.length} 个新二维码`;
   emit('applied',{...saved,created:draft.tags.length-props.map.tags.length});
   deactivate();
   return;
  }
  const body={baseVersion:props.version,...saveBody()};
  const response=await fetch(`/api/maps/${encodeURIComponent(props.map.id)}/${savePath()}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json() as {version?:number;created?:number;error?:string};
  if(!response.ok)throw Object.assign(new Error(result.error??'保存失败'),{status:response.status});
  message.value=`已保存到地图 v${result.version??props.version}，新建 ${result.created??0} 个二维码`;
  emit('applied',result);
  // 保存成功后立刻退出：父组件会用新版本地图刷新画布，继续留在预览态会拿旧基准再算一遍
  // 刚刚落库的点，反而显示"压盖"。表单值保留，重新进入时还能接着改。
  deactivate();
 }catch(reason){
  const status=Number((reason as {status?:number}).status);
  // 409 保留表单：现场改了一半的参数比重新填更贵。
  error.value=status===409?'地图已更新，本次没有保存任何改动；请重新加载最新地图后再铺码（表单已保留）':reason instanceof Error?reason.message:String(reason);
 }finally{busy.value=false;}
}
watch(()=>props.map.id,()=>{if(active.value)deactivate();});
watch(()=>props.disabled,disabled=>{if(disabled&&active.value)deactivate();});
onBeforeUnmount(()=>{if(active.value){active.value=false;emit('preview-map',null);emit('editing',false);}});

// 父组件可选：把 ghostTags 接到 MapCanvas 的 ghostTags prop 上做半透明预览。
/** 外部紧凑按钮直接进入铺码：先按需切模式，再 start（与点「开始铺码」同一条路径）。 */
function beginWith(next?:Mode){
 if(next&&mode.value!==next)mode.value=next;
 if(!active.value)start();
}
/** 左侧工具拖入画布后落点：直接把参数种到该点并进入草稿，无需再点保存/预览。 */
function placeAt(next:Mode,point:{x:number;y:number},origin?:{x:number;y:number}):void{
 if(props.disabled||busy.value)return;
 if(!Number.isFinite(point.x)||!Number.isFinite(point.y))return;
 mode.value=next;
 if(next==='single'){
  single.value={...single.value,x:point.x,y:point.y};
 }else if(next==='grid'){
  // 阵列以落点为原点；若从工具拖出方向，用拖拽起点微调原点，其余行列参数保持表单值。
  const ox=origin&&Number.isFinite(origin.x)?origin.x:point.x;
  const oy=origin&&Number.isFinite(origin.y)?origin.y:point.y;
  grid.value={...grid.value,originX:ox,originY:oy};
 }else{
  const ox=origin&&Number.isFinite(origin.x)?origin.x:point.x;
  const oy=origin&&Number.isFinite(origin.y)?origin.y:point.y;
  line.value={...line.value,fromTagId:null,startX:ox,startY:oy};
 }
 draftOverride.value=null;
 confirmDeleteId.value=null;
 if(!active.value){
  active.value=true;emit('editing',true);
 }
 emit('preview-map',null);
}
/** 直线工具拖出一条线：起点=按下处，终点=松开处；方向/轴由拖拽向量决定，数量与间距沿用表单。 */
function placeLine(from:{x:number;y:number},to:{x:number;y:number}):void{
 if(props.disabled||busy.value)return;
 if(![from.x,from.y,to.x,to.y].every(Number.isFinite))return;
 const dx=to.x-from.x,dy=to.y-from.y;
 const horizontal=Math.abs(dx)>=Math.abs(dy);
 const span=horizontal?Math.abs(dx):Math.abs(dy);
 mode.value='line';
 // 轴与方向跟随实际拖拽；数量保持用户设定，间距按拖出的长度均分，避免生成的点跑出拖拽范围。
 const count=Math.max(1,Math.round(line.value.count));
 const spacing=span>0.01&&count>1?Math.round(span/(count-1)*1000)/1000:line.value.spacingM;
 line.value={...line.value,fromTagId:null,startX:from.x,startY:from.y,
  axis:horizontal?'horizontal':'vertical',
  direction:(horizontal?dx:dy)>=0?1:-1,
  spacingM:spacing};
 draftOverride.value=null;
 confirmDeleteId.value=null;
 if(!active.value){active.value=true;emit('editing',true);}
 emit('preview-map',null);
}
/** 供父组件读取一次纯数据快照（避免跨组件读 ref 的形态差异）。 */
function snapshot(){
 const m=mode.value;
 const form:any=m==='grid'?grid.value:m==='line'?line.value:single.value;
 return {
  map:draftMap.value,
  params:{
   columns:Math.max(1,Math.round(Number((grid.value as any).columns)||1)),
   rows:Math.max(1,Math.round(Number((grid.value as any).rows)||1)),
   pitchXM:Number((grid.value as any).pitchXM)||0.2,
   pitchYM:Number((grid.value as any).pitchYM)||0.2,
   count:Math.max(1,Math.round(Number((line.value as any).count)||1)),
   spacingM:Number((line.value as any).spacingM)||0.2,
   axis:(line.value as any).axis==='vertical'?'vertical':'horizontal',
   direction:Number((line.value as any).direction)===-1?-1:1,
   angleDeg:Number(form?.angleDeg)||0,
   sizeM:Number(form?.sizeM)||0.06,
  },
 };
}
defineExpose({ghostTags,draftMap,draftTags,moveDraft,snapshot,placeAt,placeLine,requestDeleteDraft,preview,deactivate,beginWith,switchMode,moveGhost,isActive:()=>active.value});
</script>

<template>
 <div v-if="map.routeMode==='map-only'" class="tag-create" data-testid="map-tag-create" :data-map-version="version" :data-mode="mode" :data-active="active?'1':'0'" :data-draft-count="draftTags.length">
  <div class="tag-create-head">
   <strong><Plus :size="15"/> 新建铺码</strong>

   <Button v-if="!active" size="sm" variant="outline" :disabled="disabled||busy" data-testid="map-tag-create-start" @click.prevent="start">开始铺码</Button>
   <Button v-else size="sm" variant="ghost" :disabled="busy" data-testid="map-tag-create-exit" @click.prevent="deactivate"><X :size="14"/>退出</Button>
  </div>

  <p v-if="!active" class="tag-create-hint">选模式后在画布拖出点位，立即加入草稿并可编辑。</p>
  <template v-else>
   <div class="tag-create-modes" role="group" aria-label="铺码模式">
    <Button v-for="item in MODES" :key="item.key" size="sm" :variant="mode===item.key?'default':'outline'" :disabled="busy" :data-testid="'map-tag-create-mode-'+item.key" @click.prevent="switchMode(item.key)">{{item.label}}</Button>
   </div>

   <div class="tag-create-distance" data-testid="map-tag-create-min-distance" title="与已有二维码或本批二维码距离不足时整批拒绝；边长也参与重叠校验。">
    <ArrowLeftRight :size="13"/>
    <span>最小中心距 {{minimumGapText}}</span>
   </div>

   <section v-if="mode==='single'" class="tag-create-form" data-testid="map-tag-create-single-form">
    <div class="tag-create-grid">
     <label>X / m<input type="number" step="0.001" :value="single.x" :disabled="busy" data-testid="map-tag-create-single-x" @input="single.x=numberOf($event)"/></label>
     <label>Y / m<input type="number" step="0.001" :value="single.y" :disabled="busy" data-testid="map-tag-create-single-y" @input="single.y=numberOf($event)"/></label>
     <label>朝向 / °<input type="number" step="0.1" :value="single.angleDeg" :disabled="busy" data-testid="map-tag-create-single-angle" @input="single.angleDeg=numberOf($event)"/></label>
     <label>边长 / m<input type="number" step="0.01" min="0.02" max="0.18" :value="single.sizeM" :disabled="busy" data-testid="map-tag-create-single-size" @input="single.sizeM=numberOf($event)"/></label>
    </div>
    <p class="tag-create-note" title="编号取最小可用值；定位组整板中心请使用点位调整或打印布局。">编号自动分配</p>
   </section>

   <section v-else-if="mode==='grid'" class="tag-create-form" data-testid="map-tag-create-grid-form">
    <div class="tag-create-grid">
     <label>原点 X / m<input type="number" step="0.001" :value="grid.originX" :disabled="busy" data-testid="map-tag-create-grid-origin-x" @input="grid.originX=numberOf($event)"/></label>
     <label>原点 Y / m<input type="number" step="0.001" :value="grid.originY" :disabled="busy" data-testid="map-tag-create-grid-origin-y" @input="grid.originY=numberOf($event)"/></label>
     <label>列数<input type="number" step="1" min="1" :value="grid.columns" :disabled="busy" data-testid="map-tag-create-grid-cols" @input="grid.columns=intOf($event,grid.columns)"/></label>
     <label>行数<input type="number" step="1" min="1" :value="grid.rows" :disabled="busy" data-testid="map-tag-create-grid-rows" @input="grid.rows=intOf($event,grid.rows)"/></label>
     <label>列距 / m<input type="number" step="0.01" :value="grid.pitchXM" :disabled="busy" data-testid="map-tag-create-grid-pitch-x" @input="grid.pitchXM=numberOf($event)"/></label>
     <label>行距 / m<input type="number" step="0.01" :value="grid.pitchYM" :disabled="busy" data-testid="map-tag-create-grid-pitch-y" @input="grid.pitchYM=numberOf($event)"/></label>
     <label>朝向 / °<input type="number" step="0.1" :value="grid.angleDeg" :disabled="busy" data-testid="map-tag-create-grid-angle" @input="grid.angleDeg=numberOf($event)"/></label>
     <label>边长 / m<input type="number" step="0.01" min="0.02" max="0.18" :value="grid.sizeM" :disabled="busy" data-testid="map-tag-create-grid-size" @input="grid.sizeM=numberOf($event)"/></label>
     <label>起始 ID<input type="number" step="1" min="0" placeholder="自动" :value="grid.startId===null?'':grid.startId" :disabled="busy" data-testid="map-tag-create-grid-start-id" @input="grid.startId=Number.isFinite(numberOf($event))?Math.round(numberOf($event)):null"/></label>
     <label>编号顺序<select :value="grid.order" :disabled="busy" data-testid="map-tag-create-grid-order" @change="grid.order=($event.target as HTMLSelectElement).value==='col-major'?'col-major':'row-major'"><option value="row-major">行优先</option><option value="col-major">列优先</option></select></label>
    </div>
         <p class="tag-create-note" data-testid="map-tag-create-grid-numbering" title="原点为第1行第1列，列向+X、行向+Y；起始ID与顺序仅影响预览，保存仍从最小可用编号按行优先分配。">编号自动分配 · ID / 顺序仅供预览<span v-if="gridStartHint" class="tag-create-hint-inline" data-testid="map-tag-create-grid-start-id-hint">{{gridStartHint}}</span></p>
   </section>

   <section v-else class="tag-create-form" data-testid="map-tag-create-line-form">
    <div class="tag-create-grid">
     <label class="tag-create-wide">起点<select :value="line.fromTagId===null?'':line.fromTagId" :disabled="busy" data-testid="map-tag-create-line-from" @change="line.fromTagId=($event.target as HTMLSelectElement).value===''?null:Number(($event.target as HTMLSelectElement).value)"><option value="">坐标起点</option><option v-for="tag in existingTags" :key="'line'+tag.id" :value="tag.id">{{tagPositionLabel(tag)}}</option></select></label>
     <label>起点 X / m<input type="number" step="0.001" :value="line.startX" :disabled="busy||line.fromTagId!==null" data-testid="map-tag-create-line-x" @input="line.startX=numberOf($event)"/></label>
     <label>起点 Y / m<input type="number" step="0.001" :value="line.startY" :disabled="busy||line.fromTagId!==null" data-testid="map-tag-create-line-y" @input="line.startY=numberOf($event)"/></label>
     <label>数量<input type="number" step="1" min="1" :value="line.count" :disabled="busy" data-testid="map-tag-create-line-count" @input="line.count=intOf($event,line.count)"/></label>
     <label>间距 / m<input type="number" step="0.01" :value="line.spacingM" :disabled="busy" data-testid="map-tag-create-line-pitch" @input="line.spacingM=numberOf($event)"/></label>
     <label>方向<select :value="line.axis" :disabled="busy" data-testid="map-tag-create-line-axis" @change="line.axis=($event.target as HTMLSelectElement).value==='vertical'?'vertical':'horizontal'"><option value="horizontal">水平</option><option value="vertical">垂直</option></select></label>
     <label>走向<select :value="line.direction" :disabled="busy" data-testid="map-tag-create-line-direction" @change="line.direction=Number(($event.target as HTMLSelectElement).value)===1?1:-1"><option :value="1">正向</option><option :value="-1">反向</option></select></label>
     <label>朝向 / °<input type="number" step="0.1" :value="line.angleDeg" :disabled="busy" data-testid="map-tag-create-line-angle" @input="line.angleDeg=numberOf($event)"/></label>
     <label>边长 / m<input type="number" step="0.01" min="0.02" max="0.18" :value="line.sizeM" :disabled="busy" data-testid="map-tag-create-line-size" @input="line.sizeM=numberOf($event)"/></label>
    </div>

   </section>

       <div class="tag-create-preview" data-testid="map-tag-create-preview">
     <template v-if="preview">
      <div class="tag-create-summary" data-testid="map-tag-create-preview-status">
       <span>预览 <b data-testid="map-tag-create-preview-count">{{countText}}</b></span>
       <span v-if="mode==='single'" data-testid="map-tag-create-preview-id">{{singlePreview?.id!==null&&singlePreview?.id!==undefined?pad(singlePreview.id):'—'}}</span>
       <span v-else data-testid="map-tag-create-preview-span">{{spanText}}</span>
      </div>
      <details v-if="skipped.length" class="tag-create-list warn" data-testid="map-tag-create-skipped">
       <summary>放不下的位置（{{skipped.length}}）</summary>
       <p v-for="(item,index) in skipped" :key="'s'+index">第 {{item.row+1}} 行第 {{item.column+1}} 列：{{item.message}}</p>
      </details>
      <div v-if="safetyNotes.length" class="tag-create-list warn" role="status" data-testid="map-tag-create-safety"><p v-for="(note,index) in safetyNotes" :key="'safe'+index">{{note.message}}</p></div>
      <details v-if="optionalNotes.length" class="tag-create-list notes" data-testid="map-tag-create-notes"><summary>提示（{{optionalNotes.length}}）</summary><p v-for="(note,index) in optionalNotes" :key="'n'+index">{{note.message}}</p></details>
      <details v-if="mode==='grid'&&gridPoints.length" class="tag-create-points" data-testid="map-tag-create-preview-points">
       <summary>编号预览（{{gridPoints.length}}）</summary><div class="tag-create-point-list"><span v-for="item in gridPoints.slice(0,24)" :key="item.id">{{pad(item.id)}} · {{item.row+1}}行{{item.column+1}}列</span></div>
      </details>
      <details v-if="mode==='line'&&linePoints.length" class="tag-create-points" data-testid="map-tag-create-line-points">
       <summary>铺码顺序（{{linePoints.length}}）</summary><div class="tag-create-point-list"><span v-for="item in linePoints.slice(0,12)" :key="item.id">{{item.label}} · {{cm(item.offsetM)}}</span></div>
      </details>
     </template>
     <div v-else class="tag-create-empty">拖出或改参数即生成</div>
    </div>

<div v-if="blockingMessage" class="tag-create-alert error" role="alert" data-testid="map-tag-create-error"><AlertTriangle :size="15"/><span>{{blockingMessage}}</span></div>
    <details v-if="reasons.length>1" class="tag-create-list" data-testid="map-tag-create-reasons"><summary>其他阻止原因（{{reasons.length-1}}）</summary><p v-for="(reason,index) in reasons.slice(1)" :key="reason.code+index">{{reason.message}}</p></details>
    <div v-if="draftTags.length" class="tag-create-draft-list" data-testid="map-tag-create-draft-list">
     <span>草稿点</span>
     <button v-for="tag in draftTags" :key="tag.id" type="button" :class="{active:selectedTagId===tag.id}" :data-testid="'map-tag-create-draft-'+tag.id" @click.prevent="emit('update:selectedTagId',tag.id)">{{pad(tag.id)}}</button>
    </div>
    <div class="tag-create-actions">
     <Button v-if="selectedTagId!==null&&selectedTagId!==undefined" size="sm" variant="outline" :disabled="busy||disabled" data-testid="map-tag-create-delete" @click.prevent="requestDeleteDraft(selectedTagId)">删除选中 {{pad(selectedTagId)}}</Button>
     <Button size="sm" :disabled="!canSave" data-testid="map-tag-create-save" :title="'写入当前地图 v'+version+'，保留版本与冲突校验'" @click.prevent="save"><Save :size="14"/>{{busy?'保存中…':'保存'}}</Button>
    </div>
</template>
  <div v-if="confirmDeleteId!==null" class="tag-create-alert warn" role="alertdialog" data-testid="map-tag-create-delete-confirm">
    <span>删除草稿点 {{pad(confirmDeleteId)}}？只删除这一个新点，其他点不受影响。</span>
    <Button size="sm" variant="outline" data-testid="map-tag-create-delete-cancel" @click.prevent="confirmDeleteId=null">取消</Button>
    <Button size="sm" variant="destructive" data-testid="map-tag-create-delete-confirm-ok" @click.prevent="confirmDeleteDraft">删除</Button>
   </div>
   <div v-if="message" class="tag-create-alert success" role="status" data-testid="map-tag-create-message"><CheckCircle2 :size="15"/>{{message}}</div>
  <p v-if="!active" class="tag-create-disclaimer" data-testid="map-tag-create-disclaimer">{{TAG_CREATION_DISCLAIMER}}</p>
 </div>
</template>

<style scoped>
.tag-create{display:flex;flex-direction:column;gap:7px;padding:10px;border:1px solid var(--line);border-radius:9px;background:white;color:var(--ink)}
.tag-create-head{display:flex;align-items:center;gap:6px;font-size:13px;flex-wrap:nowrap}
.tag-create-head strong{display:inline-flex;align-items:center;gap:5px;font-weight:650;white-space:nowrap;flex:0 0 auto}
.tag-create-head .btn,.tag-create-head button{flex:0 0 auto;white-space:nowrap}
.tag-create-version{margin-left:auto;color:var(--muted);font-family:var(--mono);font-size:11px;white-space:nowrap;flex:0 0 auto}
.tag-create-hint{margin:0;color:var(--muted);font-size:11.5px;line-height:1.55}
.tag-create-modes{display:flex;gap:5px;flex-wrap:wrap}
.tag-create-distance{display:flex;align-items:flex-start;gap:5px;padding:5px 7px;border-radius:6px;background:#fffbeb;border:1px solid #fef3c7;color:#92400e;font-size:10.5px;line-height:1.5}
.tag-create-distance svg{flex:0 0 auto;margin-top:1px}
.tag-create-form{display:flex;flex-direction:column;gap:6px}
.tag-create-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.tag-create-grid label{display:grid;gap:3px;font-size:10px;color:var(--muted)}
.tag-create-grid label.tag-create-wide{grid-column:1 / -1}
.tag-create-grid input,.tag-create-grid select{width:100%;padding:5px;border:1px solid var(--line);border-radius:5px;font-family:var(--mono);font-size:11px;color:var(--ink);background:white}
.tag-create-grid select{font-family:inherit}
.tag-create-note{margin:0;color:var(--muted);font-size:10px;line-height:1.5}
.tag-create-hint-inline{display:block;margin-top:2px;color:#92400e}
.tag-create-preview{padding:6px 8px;border-radius:6px;background:#f8fafc;font-size:11.5px;line-height:1.6;color:#334155}
.tag-create-blocked{color:#b91c1c}
.tag-create-status{display:flex;align-items:flex-start;gap:5px;flex-wrap:wrap;margin-bottom:5px}
.tag-create-status strong{font-size:11.5px}
.tag-create-status span{flex-basis:100%;padding-left:19px;font-size:10.5px;line-height:1.5}
.tag-create-status.ready{color:#166534}
.tag-create-status.blocked{color:#b91c1c}
.tag-create-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin:0 0 6px}
.tag-create-metrics div{padding:4px 6px;background:white;border-radius:5px;border:1px solid #eef2f7}
.tag-create-metrics dt{color:var(--muted);font-size:10px}
.tag-create-metrics dd{margin:1px 0 0;font-family:var(--mono);font-size:10.5px;font-weight:600}
.tag-create-list{margin:5px 0;color:#92400e;font-size:10.5px;line-height:1.5}
.tag-create-list b{display:block}
.tag-create-list p{margin:2px 0}
.tag-create-list.notes{color:#475569}
.tag-create-points{margin-top:5px;font-size:10.5px}
.tag-create-points b{display:block;margin-bottom:3px;color:#334155}
.tag-create-point-list{display:flex;flex-wrap:wrap;gap:3px;max-height:88px;overflow:auto}
.tag-create-point-list span{padding:1px 5px;border-radius:999px;background:#eff6ff;color:#1d4ed8;font-family:var(--mono);font-size:9.5px}
.tag-create-points small{display:block;margin-top:3px;color:var(--muted);font-size:9.5px}
.tag-create-empty{color:var(--muted);font-size:11px}
.tag-create-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tag-create-footnote{color:var(--muted);font-size:10.5px;line-height:1.45}
.tag-create-alert{display:flex;align-items:flex-start;gap:5px;padding:5px 8px;border-radius:6px;font-size:11px;line-height:1.5}
.tag-create-alert.error{background:#fef2f2;color:#b91c1c;border:1px solid #fee2e2}
.tag-create-alert.success{background:#f0fdf4;color:#166534;border:1px solid #dcfce7}
.tag-create-disclaimer{margin:0;color:#92400e;background:#fffbeb;border:1px solid #fef3c7;border-radius:6px;padding:6px 8px;font-size:10.5px;line-height:1.5}
/* Compact accessory form; do not clip labels to hide layout errors. */
.tag-create,.tag-create *{box-sizing:border-box;min-width:0}
.tag-create{padding:8px;gap:8px;max-width:100%}
.tag-create-head{justify-content:space-between;flex-wrap:wrap;gap:8px}
.tag-create-head strong{font-size:13px;white-space:normal;flex:1 1 auto}
.tag-create-head button{margin-left:auto}
.tag-create-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.tag-create-modes button{width:100%;padding:4px;min-height:32px;font-size:12px}
.tag-create-grid{gap:8px}
.tag-create-grid label{display:flex;flex:0 0 auto;flex-direction:column;align-items:stretch;gap:4px;margin:0;font-size:12px;line-height:18px;white-space:normal}
.tag-create-grid input,.tag-create-grid select{display:block;flex:0 0 auto;width:100%;max-width:100%;height:34px;min-height:34px;max-height:34px;margin:0;padding:6px;font-size:13px;line-height:20px}
.tag-create-distance{padding:4px 6px;font-size:12px}
.tag-create-preview{padding:6px;font-size:12px}
.tag-create-summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px}
.tag-create-note{font-size:12px;overflow-wrap:anywhere}
.tag-create-list,.tag-create-alert{font-size:12px;overflow-wrap:anywhere}
.tag-create-alert svg{flex:0 0 15px}
.tag-create-actions{gap:8px}
.tag-create-actions button{flex:1 1 0;min-height:34px}
.tag-create summary{cursor:pointer;font-size:12px;white-space:normal;overflow-wrap:anywhere}
.tag-create-draft-list{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:11px;color:#64748b}
.tag-create-draft-list button{height:22px;padding:0 6px;border:1px solid var(--line,#e2e8f0);border-radius:5px;background:#fff;font:11px monospace;color:#334155;cursor:pointer}
.tag-create-draft-list button.active{background:#dbeafe;border-color:#93c5fd;color:#1d4ed8;font-weight:600}
</style>
