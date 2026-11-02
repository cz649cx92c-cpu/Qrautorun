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

const props=defineProps<{map:FieldMap;version:number;disabled?:boolean}>();
const emit=defineEmits<{
 'preview-map':[map:FieldMap|null];
 editing:[active:boolean];
 applied:[result:any];
}>();

type Mode='single'|'grid'|'line';
type GridOrder='row-major'|'col-major';
const MODES:[{key:Mode;label:string},{key:Mode;label:string},{key:Mode;label:string}]=[
 {key:'single',label:'单点'},
 {key:'grid',label:'矩形阵列'},
 {key:'line',label:'直线等距'},
];

const active=ref(false),busy=ref(false),error=ref(''),message=ref('');
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
const gridPreview=computed<TagGridPreview|null>(()=>mode.value==='grid'?(preview.value as TagGridPreview|null):null);
const linePreview=computed<TagLinePreview|null>(()=>mode.value==='line'?(preview.value as TagLinePreview|null):null);
const singlePreview=computed<TagCreatePreview|null>(()=>mode.value==='single'?(preview.value as TagCreatePreview|null):null);
const skipped=computed(()=>gridPreview.value?.skipped??[]);
const existingTags=computed(()=>[...props.map.tags].sort((a,b)=>a.id-b.id));

/** 预览里“将新建多少个码”。 */
const countText=computed(()=>{
 const current=preview.value;
 if(!current)return '—';
 // 单点预览没有 created 字段（只有 tag / id），必须单独判。
 if(mode.value==='single')return current.ready?'1 个':'1 个（见下方原因）';
 const suffix=current.ready?'':'（整批拒绝，见下方原因）';
 // 窄化顺序很重要：网格/直线预览的 created 在这里才安全可用。
 if(mode.value==='grid'){
  const value=current as TagGridPreview;
  if(!value.created)return '0 个（没有一个阵列位置能放下，见下方原因）';
  return `${value.created} 个${suffix}（${value.columns}×${value.rows} 阵列，单次上限 ${MAX_GRID_POINTS}）`;
 }
 const lineValue=current as TagLinePreview;
 if(!lineValue.created)return '0 个（没有一个位置能放下，见下方原因）';
 return `${lineValue.created} 个${suffix}`;
});
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
/** 画布 ghost 预览：预览地图里尚不存在的新点（父组件可选用 ghostTags prop 接线）。 */
const ghostTags=computed<{x:number;y:number;id?:number}[]>(()=>{
 if(!active.value)return [];
 const existing=new Set(props.map.tags.map(tag=>tag.id));
 if(mode.value==='single'){
  const tag=singlePreview.value?.tag;
  return tag?[{x:tag.x,y:tag.y,id:tag.id}]:[];
 }
 const created=(mode.value==='grid'?gridPreview.value?.tags:linePreview.value?.tags)??[];
 return created.filter(tag=>!existing.has(tag.id)).map(tag=>({x:tag.x,y:tag.y,id:tag.id}));
});
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
 active.value=true;emit('editing',true);emit('preview-map',null);
}
function deactivate(){
 if(!active.value)return;
 active.value=false;error.value='';busy.value=false;
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
defineExpose({ghostTags,preview,deactivate,beginWith,switchMode,moveGhost,isActive:()=>active.value});
</script>

<template>
 <div v-if="map.routeMode==='map-only'" class="tag-create" data-testid="map-tag-create" :data-map-version="version" :data-mode="mode" :data-active="active?'1':'0'">
  <div class="tag-create-head">
   <strong><Plus :size="15"/> 批量新建 / 铺码</strong>
   <span v-if="active" class="tag-create-version">基准 v{{version}}</span>
   <Button v-if="!active" size="sm" variant="outline" :disabled="disabled||busy" data-testid="map-tag-create-start" @click.prevent="start">开始铺码</Button>
   <Button v-else size="sm" variant="ghost" :disabled="busy" data-testid="map-tag-create-exit" @click.prevent="deactivate"><X :size="14"/>退出</Button>
  </div>

  <p v-if="!active" class="tag-create-hint">在尚未创建路径的定位码地图上直接录入二维码：单个补点、矩形阵列整片铺，或沿直线等距铺一排。</p>
  <template v-else>
   <div class="tag-create-modes" role="group" aria-label="铺码模式">
    <Button v-for="item in MODES" :key="item.key" size="sm" :variant="mode===item.key?'default':'outline'" :disabled="busy" :data-testid="'map-tag-create-mode-'+item.key" @click.prevent="switchMode(item.key)">{{item.label}}</Button>
   </div>

   <div class="tag-create-distance" data-testid="map-tag-create-min-distance">
    <ArrowLeftRight :size="13"/>
    <span>最小中心距 {{minimumGapText}}（约 10 cm）：与重叠判定同源（MIN_CREATION_DISTANCE_M），更近的二维码会互相压盖。</span>
   </div>

   <section v-if="mode==='single'" class="tag-create-form" data-testid="map-tag-create-single-form">
    <div class="tag-create-grid">
     <label>中心 X / m<input type="number" step="0.001" :value="single.x" :disabled="busy" data-testid="map-tag-create-single-x" @input="single.x=numberOf($event)"/></label>
     <label>中心 Y / m<input type="number" step="0.001" :value="single.y" :disabled="busy" data-testid="map-tag-create-single-y" @input="single.y=numberOf($event)"/></label>
     <label>朝向 / °<input type="number" step="0.1" :value="single.angleDeg" :disabled="busy" data-testid="map-tag-create-single-angle" @input="single.angleDeg=numberOf($event)"/></label>
     <label>边长 / m<input type="number" step="0.01" min="0.02" max="0.18" :value="single.sizeM" :disabled="busy" data-testid="map-tag-create-single-size" @input="single.sizeM=numberOf($event)"/></label>
    </div>
    <p class="tag-create-note">编号自动取最小可用值；定位组整板中心请走「调整二维码位置」或打印布局，不在这里新建。</p>
   </section>

   <section v-else-if="mode==='grid'" class="tag-create-form" data-testid="map-tag-create-grid-form">
    <div class="tag-create-grid">
     <label>原点 X / m<input type="number" step="0.001" :value="grid.originX" :disabled="busy" data-testid="map-tag-create-grid-origin-x" @input="grid.originX=numberOf($event)"/></label>
     <label>原点 Y / m<input type="number" step="0.001" :value="grid.originY" :disabled="busy" data-testid="map-tag-create-grid-origin-y" @input="grid.originY=numberOf($event)"/></label>
     <label>列数<input type="number" step="1" min="1" :value="grid.columns" :disabled="busy" data-testid="map-tag-create-grid-cols" @input="grid.columns=intOf($event,grid.columns)"/></label>
     <label>行数<input type="number" step="1" min="1" :value="grid.rows" :disabled="busy" data-testid="map-tag-create-grid-rows" @input="grid.rows=intOf($event,grid.rows)"/></label>
     <label>列距 pitchXM / m<input type="number" step="0.01" :value="grid.pitchXM" :disabled="busy" data-testid="map-tag-create-grid-pitch-x" @input="grid.pitchXM=numberOf($event)"/></label>
     <label>行距 pitchYM / m<input type="number" step="0.01" :value="grid.pitchYM" :disabled="busy" data-testid="map-tag-create-grid-pitch-y" @input="grid.pitchYM=numberOf($event)"/></label>
     <label>统一朝向 / °<input type="number" step="0.1" :value="grid.angleDeg" :disabled="busy" data-testid="map-tag-create-grid-angle" @input="grid.angleDeg=numberOf($event)"/></label>
     <label>边长 / m<input type="number" step="0.01" min="0.02" max="0.18" :value="grid.sizeM" :disabled="busy" data-testid="map-tag-create-grid-size" @input="grid.sizeM=numberOf($event)"/></label>
     <label>起始 ID<input type="number" step="1" min="0" placeholder="自动" :value="grid.startId===null?'':grid.startId" :disabled="busy" data-testid="map-tag-create-grid-start-id" @input="grid.startId=Number.isFinite(numberOf($event))?Math.round(numberOf($event)):null"/></label>
     <label>编号顺序<select :value="grid.order" :disabled="busy" data-testid="map-tag-create-grid-order" @change="grid.order=($event.target as HTMLSelectElement).value==='col-major'?'col-major':'row-major'"><option value="row-major">行优先 row-major</option><option value="col-major">列优先 col-major</option></select></label>
    </div>
    <p class="tag-create-note" data-testid="map-tag-create-grid-numbering">原点＝第 1 行第 1 列，列向 +X、行向 +Y。起始 ID 与编号顺序只影响下面预览的排序：保存后由后端从最小可用编号起按行优先分配。<span v-if="gridStartHint" class="tag-create-hint-inline" data-testid="map-tag-create-grid-start-id-hint">{{gridStartHint}}</span></p>
   </section>

   <section v-else class="tag-create-form" data-testid="map-tag-create-line-form">
    <div class="tag-create-grid">
     <label class="tag-create-wide">起点<select :value="line.fromTagId===null?'':line.fromTagId" :disabled="busy" data-testid="map-tag-create-line-from" @change="line.fromTagId=($event.target as HTMLSelectElement).value===''?null:Number(($event.target as HTMLSelectElement).value)"><option value="">用下面的起点坐标</option><option v-for="tag in existingTags" :key="'line'+tag.id" :value="tag.id">从已有点位 {{tagPositionLabel(tag)}} 继续</option></select></label>
     <label>起点 X / m<input type="number" step="0.001" :value="line.startX" :disabled="busy||line.fromTagId!==null" data-testid="map-tag-create-line-x" @input="line.startX=numberOf($event)"/></label>
     <label>起点 Y / m<input type="number" step="0.001" :value="line.startY" :disabled="busy||line.fromTagId!==null" data-testid="map-tag-create-line-y" @input="line.startY=numberOf($event)"/></label>
     <label>数量<input type="number" step="1" min="1" :value="line.count" :disabled="busy" data-testid="map-tag-create-line-count" @input="line.count=intOf($event,line.count)"/></label>
     <label>间距 pitchM / m<input type="number" step="0.01" :value="line.spacingM" :disabled="busy" data-testid="map-tag-create-line-pitch" @input="line.spacingM=numberOf($event)"/></label>
     <label>方向<select :value="line.axis" :disabled="busy" data-testid="map-tag-create-line-axis" @change="line.axis=($event.target as HTMLSelectElement).value==='vertical'?'vertical':'horizontal'"><option value="horizontal">horizontal 水平</option><option value="vertical">vertical 垂直</option></select></label>
     <label>走向<select :value="line.direction" :disabled="busy" data-testid="map-tag-create-line-direction" @change="line.direction=Number(($event.target as HTMLSelectElement).value)===1?1:-1"><option :value="1">+1 正向</option><option :value="-1">-1 反向</option></select></label>
     <label>统一朝向 / °<input type="number" step="0.1" :value="line.angleDeg" :disabled="busy" data-testid="map-tag-create-line-angle" @input="line.angleDeg=numberOf($event)"/></label>
     <label>边长 / m<input type="number" step="0.01" min="0.02" max="0.18" :value="line.sizeM" :disabled="busy" data-testid="map-tag-create-line-size" @input="line.sizeM=numberOf($event)"/></label>
    </div>
    <p class="tag-create-note">从已有点位开始时，新点从它前方一个间距起铺，已有点位本身不动、不会重复创建；任一点压盖或越界整批拒绝。</p>
   </section>

   <div class="tag-create-preview" data-testid="map-tag-create-preview">
    <div v-if="outcome.error" class="tag-create-blocked" data-testid="map-tag-create-form-error">{{outcome.error}}</div>
    <template v-else-if="preview">
     <div :class="['tag-create-status',ready?'ready':'blocked']" data-testid="map-tag-create-preview-status">
      <CheckCircle2 v-if="ready" :size="14"/><AlertTriangle v-else :size="14"/>
      <strong>{{ready?'可以保存':'暂不能保存'}}</strong>
      <span>{{ready?'预览已同步到画布（半透明点为本批新码）':(reasons.length?'请先处理下方阻止原因':'请补全参数')}}</span>
     </div>
     <dl class="tag-create-metrics">
      <div><dt>将新建</dt><dd data-testid="map-tag-create-preview-count">{{countText}}</dd></div>
      <div><dt>跨度</dt><dd data-testid="map-tag-create-preview-span">{{spanText}}</dd></div>
      <div v-if="mode==='grid'"><dt>间距</dt><dd>{{cm(grid.pitchXM)}} × {{cm(grid.pitchYM)}}</dd></div>
      <div v-if="mode==='line'"><dt>节距</dt><dd>{{cm(line.spacingM)}}</dd></div>
      <div v-if="mode==='single'"><dt>编号</dt><dd data-testid="map-tag-create-preview-id">{{singlePreview?.id!==null&&singlePreview?.id!==undefined?pad(singlePreview.id):'—'}}</dd></div>
     </dl>
     <div v-if="reasons.length" class="tag-create-list" data-testid="map-tag-create-reasons">
      <b>阻止原因</b>
      <p v-for="(reason,index) in reasons" :key="'r'+reason.code+index" :data-testid="'map-tag-create-reason-'+index">{{reason.message}}</p>
     </div>
     <div v-if="skipped.length" class="tag-create-list warn" data-testid="map-tag-create-skipped">
      <b>逐格明细（{{skipped.length}} 个位置放不下）</b>
      <p v-for="(item,index) in skipped.slice(0,6)" :key="'s'+index">第 {{item.row+1}} 行第 {{item.column+1}} 列（{{item.x}}, {{item.y}}）：{{item.message}}</p>
      <small v-if="skipped.length>6">仅列出前 6 个。</small>
     </div>
     <div v-if="notes.length" class="tag-create-list notes" data-testid="map-tag-create-notes">
      <b>说明</b>
      <p v-for="(note,index) in notes" :key="'n'+note.code+index">{{note.message}}</p>
     </div>
     <div v-if="mode==='grid'&&gridPoints.length" class="tag-create-points" data-testid="map-tag-create-preview-points">
      <b>编号预览（{{gridPoints.length}} 个，按{{grid.order==='col-major'?'列优先':'行优先'}}）</b>
      <div class="tag-create-point-list">
       <span v-for="item in gridPoints.slice(0,24)" :key="'gp'+item.id">{{pad(item.id)}} · 第{{item.row+1}}行第{{item.column+1}}列</span>
      </div>
      <small v-if="gridPoints.length>24">仅列出前 24 个。</small>
     </div>
     <div v-if="mode==='line'&&linePoints.length" class="tag-create-points" data-testid="map-tag-create-line-points">
      <b>铺码顺序（{{linePoints.length}} 个）</b>
      <div class="tag-create-point-list">
       <span v-for="item in linePoints.slice(0,12)" :key="'lp'+item.id">{{item.label}} · 偏移 {{cm(item.offsetM)}}</span>
      </div>
     </div>
    </template>
    <div v-else class="tag-create-empty">填写参数后这里会实时显示预览。</div>
   </div>

   <div class="tag-create-actions">
    <Button size="sm" :disabled="!canSave" data-testid="map-tag-create-save" @click.prevent="save"><Save :size="14"/>{{busy?'正在保存…':'保存到当前地图 v'+version}}</Button>
    <span class="tag-create-footnote">原地写入当前版本，不新建版本、不改路径；保存后旧路线与任务绑定保持不变。</span>
   </div>

   <div v-if="error" class="tag-create-alert error" role="alert" data-testid="map-tag-create-error"><AlertTriangle :size="15"/>{{error}}</div>
  </template>
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
</style>
