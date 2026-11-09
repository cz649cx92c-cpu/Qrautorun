<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import type {Point} from '../../../shared/model';
import {
 diagnoseRouteBindings,equalizeLegs,insertAnchorAt,mirrorRoute,moveAnchorKeepingOrthogonal,
 removeAnchor,rotateRoute,snapToGrid,translateRoute,validateRouteGeometry,
 type RouteBindingReport,type RouteEditBase,type RouteEndpointBinding,type RouteGeometryReport,
} from '../../../shared/route-geometry';
import Button from './ui/Button.vue';
import {
 AlertTriangle,CheckCircle2,FlipHorizontal2,FlipVertical2,Grid3x3,Move,Plus,RotateCw,RotateCcw,Ruler,
 Save,ShieldCheck,Stethoscope,Trash2,X,
} from 'lucide-vue-next';

/**
 * 路径几何操作面板。
 *
 * 只做三件事：
 *  1. 诊断：把 `diagnoseRouteBindings` 的解释翻译成"哪些段是码到码、哪些端点吸附/未绑定、
 *     哪些码只是沿途经过、哪些码根本没用上"；
 *  2. 校验：把 `validateRouteGeometry` 的 errors/warnings 原样列出（正交、最小段长、总长、
 *     点数、重复点、自交），编译仍由后端 `compileDesiredRoute` 判定；
 *  3. 编辑：每个操作都先用 shared 纯函数在本地算候选点集，`emit('preview-points', 新点集)`
 *     给画布预览，确认后才 POST `/api/routes/:id/geometry` 写回。
 *
 * 本组件不修改任何 props、不改地图二维码坐标，也不碰 App.vue 之外的接线。
 */

const props=defineProps<{
 routeId:string;
 mapId:string;
 version:number;
 routeUpdated:string;
 points:Point[];
 tags:{id:number;x:number;y:number}[];
 disabled?:boolean;
}>();
const emit=defineEmits<{'preview-points':[points:Point[]|null];applied:[result:any]}>();

type Operation='insert'|'remove'|'move'|'equalize'|'translate'|'rotate'|'mirror';
interface Draft{
 operation:Operation;
 label:string;
 params:Record<string,unknown>;
 points:Point[];
 ready:boolean;
 issues:string[];
 notes:string[];
 /** 草稿候选点集的键：父组件若把 preview-points 回显成 points，靠它识别成"回显"而不是"外部改动"。 */
 candidateKey:string;
}

const LEGACY_EPS=1e-9;
const KIND_LABELS:Record<string,string>={'tag-to-tag':'码到码','tag-to-free':'码→自由点','free-to-tag':'自由点→码','free-to-free':'自由点→自由点'};

// --- state ------------------------------------------------------------------

/** `<input type="number">` 上的 v-model 会被 Vue 自动转成 number，所以数值输入一律按 string|number 收。 */
type Numeric=string|number;

const busy=ref(false),error=ref(''),message=ref('');
const draft=ref<Draft|null>(null);
type OperationPanel='grid'|Operation;
// Pure data state: default 'move' open, others closed. Nothing here listens to DOM
// events, so opening another group can never feed back into this ref.
const operationOpen=ref<Record<OperationPanel,boolean>>({grid:false,insert:false,remove:false,move:true,equalize:false,translate:false,rotate:false,mirror:false});
function toggleOperation(operation:OperationPanel):void{operationOpen.value={...operationOpen.value,[operation]:!operationOpen.value[operation]};}
function isOperationOpen(operation:OperationPanel):boolean{return operationOpen.value[operation];}
const gridSnap=ref(true),gridSize=ref<Numeric>('0.05');
const insertIndex=ref<Numeric>(1),insertX=ref<Numeric>('0'),insertY=ref<Numeric>('0');
const removeIndex=ref<Numeric>(0);
const moveIndex=ref<Numeric>(0),moveDx=ref<Numeric>('0'),moveDy=ref<Numeric>('0');
const equalizeFrom=ref<Numeric>(0),equalizeTo=ref<Numeric>(1),equalizeTarget=ref<Numeric>('0.5');
const translateDx=ref<Numeric>('0'),translateDy=ref<Numeric>('0');
const rotatePivotX=ref<Numeric>('0'),rotatePivotY=ref<Numeric>('0');
const mirrorAxis=ref('horizontal'),mirrorAt=ref<Numeric>('0');

const safePoints=computed<Point[]>(()=>Array.isArray(props.points)?props.points:[]);
const basePoints=computed<Point[]>(()=>safePoints.value.map(point=>({x:point.x,y:point.y})));
const keyOf=(points:Point[])=>points.map(point=>`${point.x.toFixed(6)},${point.y.toFixed(6)}`).join(';');
const pointsKey=computed(()=>keyOf(safePoints.value));
const isDisabled=computed(()=>Boolean(props.disabled)||busy.value);

// --- read-only diagnostics --------------------------------------------------

const binding=computed<RouteBindingReport>(()=>diagnoseRouteBindings(basePoints.value,props.tags));
const validation=computed<RouteGeometryReport>(()=>validateRouteGeometry(basePoints.value));

const tagLabel=(id:number)=>`Q${String(id).padStart(3,'0')}`;
const m3=(value:number)=>Number.isFinite(value)?value.toFixed(3):'—';
const cm=(value:number)=>Number.isFinite(value)?`${(value*100).toFixed(1)} cm`:'超出捕捉半径';
/** 归一化为数值：number 直接用，字符串空值＝NaN（而不是被 Number('') 变成 0）。 */
const num=(value:Numeric|undefined|null):number=>{
 if(typeof value==='number') return Number.isFinite(value)?value:Number.NaN;
 if(typeof value==='string') return value.trim()===''?Number.NaN:Number(value);
 return Number.NaN;
};
const int=(value:Numeric|undefined|null):number=>{
 const parsed=num(value);
 return Number.isFinite(parsed)?Math.round(parsed):Number.NaN;
};
/** 插入位置 index 的合法区间是 0..points.length（两端都算），越界时夹到边界。 */
const clampIndex=(value:number,total:number):number=>{
 if(!Number.isFinite(value)) return 0;
 return Math.max(0,Math.min(value,total));
};
const round3=(value:number)=>Math.round(value*1000)/1000;

const legListText=(indexes:number[])=>indexes.length?indexes.map(index=>`第 ${index+1} 段`).join('、'):'无';
const endpointText=(item:RouteEndpointBinding)=>`第 ${item.pointIndex+1} 点${item.tagId===null?'':' → '+tagLabel(item.tagId)}（${cm(item.distanceM)}）`;
const endpointListText=(list:RouteEndpointBinding[])=>list.length?list.map(endpointText).join('、'):'无';

const exactLegsText=computed(()=>legListText(binding.value.exactTagToTagLegs));
const snappedLegsText=computed(()=>legListText(binding.value.snappedTagToTagLegs));
const snappedText=computed(()=>endpointListText(binding.value.snappedEndpoints));
const unboundText=computed(()=>endpointListText(binding.value.unboundEndpoints));
const passedText=computed(()=>binding.value.passedTags.length
 ?binding.value.passedTags.map(tag=>`${tagLabel(tag.id)}（距路径 ${cm(tag.distanceM)}）`).join('、')
 :'无');
const unusedText=computed(()=>binding.value.unusedTagIds.length
 ?binding.value.unusedTagIds.map(tagLabel).join('、')
 :'无');
const bindingWarnings=computed(()=>binding.value.warnings);

const diagnoseBlocked=computed<string[]>(()=>{
 const report=binding.value;
 const reasons:string[]=[];
 if(!Array.isArray(props.tags)||!props.tags.length) reasons.push('地图上还没有定位码，路径无法与二维码绑定，无法编译');
 if(report.unboundEndpoints.length) reasons.push(`${report.unboundEndpoints.length} 个路径端点不在任何定位码 ${cm(report.toleranceM)} 范围内，编译时会被截去或导致串码失败`);
 if(report.pointCount>=2&&!report.legs.some(leg=>leg.kind==='tag-to-tag')) reasons.push('没有任何一段是码到码，路径无法编译成执行区间');
 return reasons;
});

const endpointLabel=(item:RouteEndpointBinding|null|undefined)=>{
 if(!item)return '—';
 if(item.status==='unbound')return '自由点';
 return `${item.tagId===null?'?':tagLabel(item.tagId)}${item.status==='snapped'?'（吸附）':''}`;
};
const legRows=computed(()=>binding.value.legs.map(leg=>({
 index:leg.index,
 from:endpointLabel(binding.value.endpoints[leg.index]),
 to:endpointLabel(binding.value.endpoints[leg.index+1]),
 length:cm(leg.lengthM),
 kind:KIND_LABELS[leg.kind]??leg.kind,
})));

const summary=computed(()=>`${safePoints.value.length} 点 · ${Math.max(0,safePoints.value.length-1)} 段 · ${m3(validation.value.lengthM)} m · ${validation.value.errors.length} 错误`);

// --- option lists -----------------------------------------------------------

const insertOptions=computed<{value:number;label:string}[]>(()=>{
 const count=safePoints.value.length;
 // 插入位置 index 是"新点在新列表中的下标"：0＝起点之前，i＝第 i 个点之后（落在第 i 段内），n＝终点之后。
 if(count<1) return [{value:0,label:'路径起点之前'}];
 const options:{value:number;label:string}[]=[{value:0,label:'路径起点之前'}];
 for(let point=1;point<count;point++) options.push({value:point,label:`第 ${point} 个点之后（第 ${point} 段内）`});
 options.push({value:count,label:'路径终点之后'});
 return options;
});

const removeOptions=computed<{index:number;label:string}[]>(()=>{
 const points=safePoints.value;
 return points.map((point,index)=>{
  const previous=points[index-1],next=points[index+1];
  let role='端点';
  if(index===0) role='起点';
  else if(index===points.length-1) role='终点';
  else if(previous&&next){
   role=Math.abs(previous.x-next.x)<=LEGACY_EPS||Math.abs(previous.y-next.y)<=LEGACY_EPS?'直线中间点':'拐点（删除会被拒绝）';
   if(Math.hypot(previous.x-next.x,previous.y-next.y)<=LEGACY_EPS) role='折返顶点（删除会被拒绝）';
  }
  return {index,label:`第 ${index+1} 点 (${m3(point.x)}, ${m3(point.y)}) · ${role}`};
 });
});

const moveOptions=computed(()=>safePoints.value.map((point,index)=>({index,label:`第 ${index+1} 点 (${m3(point.x)}, ${m3(point.y)})`})));
const equalizeOptions=computed(()=>safePoints.value.map((point,index)=>({index,label:`第 ${index+1} 点 (${m3(point.x)}, ${m3(point.y)})`})));

// --- seeding ----------------------------------------------------------------

function boundsOf(points:Point[]){
 if(!points.length) return {minX:0,minY:0,maxX:0,maxY:0};
 return {
  minX:Math.min(...points.map(point=>point.x)),maxX:Math.max(...points.map(point=>point.x)),
  minY:Math.min(...points.map(point=>point.y)),maxY:Math.max(...points.map(point=>point.y)),
 };
}
function insertSeedPoint(){
 const points=safePoints.value;
 if(!points.length) return;
 const index=Math.max(0,Math.min(num(insertIndex.value),points.length));
 const anchor=index>=1&&index<points.length
  ?{x:(points[index-1]!.x+points[index]!.x)/2,y:(points[index-1]!.y+points[index]!.y)/2}
  :{...points[Math.min(index,points.length-1)]!};
 insertX.value=String(round3(anchor.x));
 insertY.value=String(round3(anchor.y));
}
function seedMirrorAt(){
 const bounds=boundsOf(safePoints.value);
 mirrorAt.value=String(round3(mirrorAxis.value==='horizontal'?(bounds.minY+bounds.maxY)/2:(bounds.minX+bounds.maxX)/2));
}
function seedPivotCenter(){
 const bounds=boundsOf(safePoints.value);
 rotatePivotX.value=String(round3((bounds.minX+bounds.maxX)/2));
 rotatePivotY.value=String(round3((bounds.minY+bounds.maxY)/2));
}
function seedFromPoints(){
 const points=safePoints.value,count=points.length;
 insertIndex.value=count>=2?1:0;
 removeIndex.value=0;
 moveIndex.value=0;
 equalizeFrom.value=0;
 equalizeTo.value=count>=2?1:0;
 const first=points[0],second=points[1];
 equalizeTarget.value=first&&second
  ?String(Math.max(0.08,Math.round(Math.hypot(second.x-first.x,second.y-first.y)*100)/100))
  :'0.5';
 moveDx.value='0';moveDy.value='0';
 translateDx.value='0';translateDy.value='0';
 seedPivotCenter();
 seedMirrorAt();
 insertSeedPoint();
}

// --- draft plumbing ---------------------------------------------------------

function clearDraft(){
 if(!draft.value) return;
 draft.value=null;
 emit('preview-points',null);
}
function pushDraft(operation:Operation,label:string,params:Record<string,unknown>,result:RouteEditBase){
 const candidate=result.points.map(point=>({x:point.x,y:point.y}));
 const ready=Boolean(result.ready);
 draft.value={
  operation,label,params,points:candidate,ready,issues:result.issues.map(issue=>issue.message),notes:[...result.notes],
  candidateKey:ready?keyOf(candidate):pointsKey.value,
 };
 error.value='';
 message.value='';
 emit('preview-points',ready?candidate.map(point=>({x:point.x,y:point.y})):null);
}
function readyToPreview():boolean{
 if(props.disabled||busy.value) return false;
 if(safePoints.value.length<2){error.value='路径不足两个控制点，请先补点再做几何编辑';return false;}
 return true;
}
function snapPoint(point:Point):Point{
 if(!gridSnap.value) return {x:point.x,y:point.y};
 const size=num(gridSize.value);
 try{return snapToGrid(point,size);}catch{return {x:point.x,y:point.y};}
}
const gridNote=()=>gridSnap.value?` · 网格吸附 ${num(gridSize.value)} m`:'';

// --- per-operation previews -------------------------------------------------

function previewInsert(){
 if(!readyToPreview()) return;
 const points=basePoints.value;
 const index=clampIndex(int(insertIndex.value),points.length);
 const x=num(insertX.value),y=num(insertY.value);
 if(!Number.isFinite(x)||!Number.isFinite(y)){error.value='插入点 x/y 必须是有效数值';return;}
 const point=snapPoint({x,y});
 const where=index===0
  ?'在路径起点之前插入路点'
  :index>=points.length
   ?'在路径终点之后插入路点'
   :`在第 ${index} 与第 ${index+1} 个点之间插入路点`;
 pushDraft('insert',`${where}${gridNote()}`,{index,point},insertAnchorAt(points,index,point));
}

function previewRemove(){
 if(!readyToPreview()) return;
 const points=basePoints.value;
 const index=int(removeIndex.value);
 if(!Number.isInteger(index)||index<0||index>=points.length){error.value='删除索引超出路径点数范围';return;}
 pushDraft('remove',`删除第 ${index+1} 个路点`,{index},removeAnchor(points,index));
}

function previewMove(){
 if(!readyToPreview()) return;
 const points=basePoints.value;
 const index=int(moveIndex.value);
 if(!Number.isInteger(index)||index<0||index>=points.length){error.value='移动索引超出路径点数范围';return;}
 const rawDx=num(moveDx.value),rawDy=num(moveDy.value);
 if(!Number.isFinite(rawDx)||!Number.isFinite(rawDy)){error.value='位移 dx/dy 必须是有效数值';return;}
 const origin=points[index]!;
 let dx=rawDx,dy=rawDy;
 if(gridSnap.value){
  const target=snapPoint({x:origin.x+dx,y:origin.y+dy});
  dx=target.x-origin.x;
  dy=target.y-origin.y;
 }
 pushDraft('move',`移动第 ${index+1} 个路点 (${m3(dx)}, ${m3(dy)}) m${gridNote()}`,{index,delta:{x:dx,y:dy}},moveAnchorKeepingOrthogonal(points,index,{x:dx,y:dy}));
}

function previewEqualize(){
 if(!readyToPreview()) return;
 const points=basePoints.value;
 const from=int(equalizeFrom.value),to=int(equalizeTo.value);
 const targetM=num(equalizeTarget.value);
 if(!Number.isInteger(from)||from<0||from>=points.length){error.value='等间距起点超出路径范围';return;}
 if(!Number.isInteger(to)||to<=from||to>=points.length){error.value='等间距终点必须在起点之后且位于路径内';return;}
 if(!Number.isFinite(targetM)){error.value='目标间距必须是有效数值';return;}
 pushDraft('equalize',`第 ${from+1}–${to+1} 点之间按 ${m3(targetM)} m 等间距`,{fromIndex:from,toIndex:to,targetM},equalizeLegs(points,from,to,targetM));
}

function previewTranslate(){
 if(!readyToPreview()) return;
 const dx=num(translateDx.value),dy=num(translateDy.value);
 if(!Number.isFinite(dx)||!Number.isFinite(dy)){error.value='平移 dx/dy 必须是有效数值';return;}
 pushDraft('translate',`整体平移 (${m3(dx)}, ${m3(dy)}) m`,{dx,dy},translateRoute(basePoints.value,dx,dy));
}

function previewRotate(degrees:number){
 if(!readyToPreview()) return;
 const pivotX=num(rotatePivotX.value),pivotY=num(rotatePivotY.value);
 if(!Number.isFinite(pivotX)||!Number.isFinite(pivotY)){error.value='旋转中心必须是有效数值';return;}
 const pivot={x:pivotX,y:pivotY};
 const direction=degrees>0?'逆时针':'顺时针';
 pushDraft('rotate',`绕 (${m3(pivotX)}, ${m3(pivotY)}) ${direction} ${Math.abs(degrees)}°`,{pivot,degrees},rotateRoute(basePoints.value,pivot,degrees));
}

function previewMirror(){
 if(!readyToPreview()) return;
 const axis=mirrorAxis.value==='vertical'?'vertical' as const:'horizontal' as const;
 const at=num(mirrorAt.value);
 if(!Number.isFinite(at)){error.value='镜像轴位置必须是有效数值';return;}
 const label=axis==='horizontal'?`按水平线 y=${m3(at)} 镜像（上下翻转）`:`按竖直线 x=${m3(at)} 镜像（左右翻转）`;
 pushDraft('mirror',label,{axis,at},mirrorRoute(basePoints.value,axis,at));
}

// --- apply ------------------------------------------------------------------

async function applyDraft(){
 const current=draft.value;
 if(!current||!current.ready||props.disabled||busy.value) return;
 busy.value=true;
 error.value='';
 message.value='';
 try{
  const body:Record<string,unknown>={
   mapId:props.mapId,baseVersion:props.version,points:basePoints.value,
   operation:current.operation,params:current.params,
  };
  if(props.routeUpdated) body.routeUpdated=props.routeUpdated;
  const response=await fetch(`/api/routes/${encodeURIComponent(props.routeId)}/geometry`,{
   method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  });
  const result=await response.json();
  if(!response.ok) throw Object.assign(new Error(result.error??'保存路径几何失败'),{status:response.status});
  const notes:string[]=Array.isArray(result.notes)?result.notes:[];
  const pointCount=Array.isArray(result.points)?result.points.length:current.points.length;
  const lengthM=Number(result.lengthM);
  message.value=`已保存：${pointCount} 点 · ${Number.isFinite(lengthM)?lengthM.toFixed(2)+' m':'—'}${notes.length?'；'+notes.join('；'):''}`;
  draft.value=null;
  emit('preview-points',null);
  emit('applied',result);
 }catch(reason){
  const status=Number((reason as {status?:number}).status);
  error.value=status===409
   ?'路径或地图已被其他页面修改，未保存任何改动；请重新加载后再编辑'
   :reason instanceof Error?reason.message:String(reason);
 }finally{busy.value=false;}
}

const draftReport=computed<RouteGeometryReport|null>(()=>draft.value?validateRouteGeometry(draft.value.points):null);

// --- lifecycle --------------------------------------------------------------

let seeded=safePoints.value.length>=2;
seedFromPoints();
watch(insertIndex,insertSeedPoint);
watch(mirrorAxis,seedMirrorAt);
watch(pointsKey,()=>{
 // 父组件可能把 preview-points 原样回显到 points 上；那种回显不该作废用户刚算好的草稿。
 // 只有当 points 变成既不是基准、也不是本草稿候选的"第三个点集"时，才说明外部改了几何。
 if(draft.value&&pointsKey.value!==draft.value.candidateKey) clearDraft();
 if(!seeded&&safePoints.value.length>=2){seeded=true;seedFromPoints();}
});
watch(()=>props.routeId,()=>{
 clearDraft();
 error.value='';
 message.value='';
 seeded=safePoints.value.length>=2;
 seedFromPoints();
});
watch(()=>props.version,()=>{if(draft.value) clearDraft();});
onBeforeUnmount(()=>{if(draft.value) emit('preview-points',null);});
</script>

<template>
 <div class="rg" data-testid="route-geometry-panel" :data-route-id="routeId" :data-map-version="version">
  <div v-if="points.length<2" class="rg-alert warn" data-testid="route-geometry-empty"><AlertTriangle :size="14"/><span>当前路径不足两个控制点，无法做几何编辑。</span></div>

  <!-- 3. 网格吸附 -->
  <section class="rg-sec rg-fold" data-testid="route-geometry-grid" :data-open="isOperationOpen('grid')?'1':'0'">
   <button type="button" class="rg-fold__head" data-testid="route-geometry-grid-toggle" :aria-expanded="isOperationOpen('grid')" @click="toggleOperation('grid')"><Grid3x3 :size="13"/> 网格吸附</button>
   <div v-show="isOperationOpen('grid')" class="rg-fold__body">
   <div class="rg-line">
    <label class="rg-check"><input v-model="gridSnap" type="checkbox" :disabled="disabled" data-testid="route-geometry-grid-snap"/> 插入 / 移动时按网格取整</label>
    <label class="rg-field">网格 / 米
     <select v-model="gridSize" :disabled="disabled" data-testid="route-geometry-grid-size">
      <option value="0.05">0.05</option>
      <option value="0.1">0.1</option>
      <option value="0.5">0.5</option>
     </select>
    </label>
   </div>
   </div>
  </section>

  <!-- 4. 操作 -->
  <section class="rg-op rg-fold" data-testid="route-geometry-insert" :data-open="isOperationOpen('insert')?'1':'0'">
   <button type="button" class="rg-fold__head" data-testid="route-geometry-insert-toggle" :aria-expanded="isOperationOpen('insert')" @click="toggleOperation('insert')"><Plus :size="12"/> 插入路点</button>
   <div v-show="isOperationOpen('insert')" class="rg-fold__body">
   <div class="rg-line">
    <label class="rg-field">位置
     <select v-model="insertIndex" :disabled="isDisabled" data-testid="route-geometry-insert-index">
      <option v-for="option in insertOptions" :key="'ins'+option.value" :value="option.value">{{option.label}}</option>
     </select>
    </label>
    <label class="rg-field">x（米）<input v-model="insertX" type="number" step="0.05" :disabled="isDisabled" data-testid="route-geometry-insert-x"/></label>
    <label class="rg-field">y（米）<input v-model="insertY" type="number" step="0.05" :disabled="isDisabled" data-testid="route-geometry-insert-y"/></label>
   </div>
   <div class="rg-line">
    <Button size="sm" variant="outline" :disabled="isDisabled" data-testid="route-geometry-insert-seed" @click.prevent="insertSeedPoint">填入该段中点</Button>
    <Button size="sm" :disabled="isDisabled||points.length<2" data-testid="route-geometry-insert-preview" @click.prevent="previewInsert">预览</Button>
    <span class="rg-tip">{{gridSnap?'预览坐标按 '+gridSize+' m 取整':'未开启网格吸附'}}</span>
   </div>
   </div>
  </section>

  <section class="rg-op rg-fold" data-testid="route-geometry-remove" :data-open="isOperationOpen('remove')?'1':'0'">
   <button type="button" class="rg-fold__head" data-testid="route-geometry-remove-toggle" :aria-expanded="isOperationOpen('remove')" @click="toggleOperation('remove')"><Trash2 :size="12"/> 删除路点</button>
   <div v-show="isOperationOpen('remove')" class="rg-fold__body">
   <div class="rg-line">
    <label class="rg-field rg-grow">索引
     <select v-model="removeIndex" :disabled="isDisabled" data-testid="route-geometry-remove-index">
      <option v-for="option in removeOptions" :key="'rm'+option.index" :value="option.index">{{option.label}}</option>
     </select>
    </label>
    <Button size="sm" :disabled="isDisabled||points.length<2" data-testid="route-geometry-remove-preview" @click.prevent="previewRemove">预览</Button>
   </div>
   </div>
  </section>

  <section class="rg-op rg-fold" data-testid="route-geometry-move" :data-open="isOperationOpen('move')?'1':'0'">
   <button type="button" class="rg-fold__head" data-testid="route-geometry-move-toggle" :aria-expanded="isOperationOpen('move')" @click="toggleOperation('move')"><Move :size="12"/> 移动路点（保持正交）</button>
   <div v-show="isOperationOpen('move')" class="rg-fold__body">
   <div class="rg-line">
    <label class="rg-field rg-grow">索引
     <select v-model="moveIndex" :disabled="isDisabled" data-testid="route-geometry-move-index">
      <option v-for="option in moveOptions" :key="'mv'+option.index" :value="option.index">{{option.label}}</option>
     </select>
    </label>
    <label class="rg-field">dx（米）<input v-model="moveDx" type="number" step="0.05" :disabled="isDisabled" data-testid="route-geometry-move-dx"/></label>
    <label class="rg-field">dy（米）<input v-model="moveDy" type="number" step="0.05" :disabled="isDisabled" data-testid="route-geometry-move-dy"/></label>
   </div>
   <div class="rg-line">
    <Button size="sm" :disabled="isDisabled||points.length<2" data-testid="route-geometry-move-preview" @click.prevent="previewMove">预览</Button>
    <span class="rg-tip">偏移会让相邻段变斜时自动补拐点</span>
   </div>
   </div>
  </section>

  <section class="rg-op rg-fold" data-testid="route-geometry-equalize" :data-open="isOperationOpen('equalize')?'1':'0'">
   <button type="button" class="rg-fold__head" data-testid="route-geometry-equalize-toggle" :aria-expanded="isOperationOpen('equalize')" @click="toggleOperation('equalize')"><Grid3x3 :size="12"/> 整段等间距</button>
   <div v-show="isOperationOpen('equalize')" class="rg-fold__body">
   <div class="rg-line">
    <label class="rg-field rg-grow">起点
     <select v-model="equalizeFrom" :disabled="isDisabled" data-testid="route-geometry-equalize-from">
      <option v-for="option in equalizeOptions" :key="'ef'+option.index" :value="option.index">{{option.label}}</option>
     </select>
    </label>
    <label class="rg-field rg-grow">终点
     <select v-model="equalizeTo" :disabled="isDisabled" data-testid="route-geometry-equalize-to">
      <option v-for="option in equalizeOptions" :key="'et'+option.index" :value="option.index">{{option.label}}</option>
     </select>
    </label>
    <label class="rg-field">目标间距（米）<input v-model="equalizeTarget" type="number" step="0.01" min="0.08" :disabled="isDisabled" data-testid="route-geometry-equalize-target"/></label>
   </div>
   <div class="rg-line">
    <Button size="sm" :disabled="isDisabled||points.length<2" data-testid="route-geometry-equalize-preview" @click.prevent="previewEqualize">预览</Button>
    <span class="rg-tip">只适用于一条同向直线段；含拐角或折返会被拒绝</span>
   </div>
   </div>
  </section>

  <section class="rg-op rg-fold" data-testid="route-geometry-translate" :data-open="isOperationOpen('translate')?'1':'0'">
   <button type="button" class="rg-fold__head" data-testid="route-geometry-translate-toggle" :aria-expanded="isOperationOpen('translate')" @click="toggleOperation('translate')"><Move :size="12"/> 整体平移</button>
   <div v-show="isOperationOpen('translate')" class="rg-fold__body">
   <div class="rg-line">
    <label class="rg-field">dx（米）<input v-model="translateDx" type="number" step="0.05" :disabled="isDisabled" data-testid="route-geometry-translate-dx"/></label>
    <label class="rg-field">dy（米）<input v-model="translateDy" type="number" step="0.05" :disabled="isDisabled" data-testid="route-geometry-translate-dy"/></label>
    <Button size="sm" :disabled="isDisabled||points.length<2" data-testid="route-geometry-translate-preview" @click.prevent="previewTranslate">预览</Button>
   </div>
   </div>
  </section>

  <section class="rg-op rg-fold" data-testid="route-geometry-rotate" :data-open="isOperationOpen('rotate')?'1':'0'">
   <button type="button" class="rg-fold__head" data-testid="route-geometry-rotate-toggle" :aria-expanded="isOperationOpen('rotate')" @click="toggleOperation('rotate')"><RotateCw :size="12"/> 90° 旋转</button>
   <div v-show="isOperationOpen('rotate')" class="rg-fold__body">
   <div class="rg-line">
    <label class="rg-field">中心 x（米）<input v-model="rotatePivotX" type="number" step="0.05" :disabled="isDisabled" data-testid="route-geometry-rotate-pivot-x"/></label>
    <label class="rg-field">中心 y（米）<input v-model="rotatePivotY" type="number" step="0.05" :disabled="isDisabled" data-testid="route-geometry-rotate-pivot-y"/></label>
    <Button size="sm" variant="outline" :disabled="isDisabled" data-testid="route-geometry-rotate-pivot-center" @click.prevent="seedPivotCenter">用路径中心</Button>
   </div>
   <div class="rg-line">
    <Button size="sm" :disabled="isDisabled||points.length<2" data-testid="route-geometry-rotate-cw" @click.prevent="previewRotate(-90)"><RotateCcw :size="13"/> 顺时针 90°</Button>
    <Button size="sm" :disabled="isDisabled||points.length<2" data-testid="route-geometry-rotate-ccw" @click.prevent="previewRotate(90)"><RotateCw :size="13"/> 逆时针 90°</Button>
    <span class="rg-tip">只允许 90° 整数倍；地图二维码坐标不变</span>
   </div>
   </div>
  </section>

  <section class="rg-op rg-fold" data-testid="route-geometry-mirror" :data-open="isOperationOpen('mirror')?'1':'0'">
   <button type="button" class="rg-fold__head" data-testid="route-geometry-mirror-toggle" :aria-expanded="isOperationOpen('mirror')" @click="toggleOperation('mirror')"><FlipHorizontal2 :size="12"/> 镜像</button>
   <div v-show="isOperationOpen('mirror')" class="rg-fold__body">
   <div class="rg-line">
    <label class="rg-field">轴
     <select v-model="mirrorAxis" :disabled="isDisabled" data-testid="route-geometry-mirror-axis">
      <option value="horizontal">水平线（上下翻转）</option>
      <option value="vertical">竖直线（左右翻转）</option>
     </select>
    </label>
    <label class="rg-field">轴位置（米）<input v-model="mirrorAt" type="number" step="0.05" :disabled="isDisabled" data-testid="route-geometry-mirror-at"/></label>
    <Button size="sm" :disabled="isDisabled||points.length<2" data-testid="route-geometry-mirror-preview" @click.prevent="previewMirror">
     <FlipVertical2 :size="13"/> 预览
    </Button>
   </div>
   </div>
  </section>

  <!-- 5. 预览草稿 -->
  <div v-if="draft" class="rg-draft" data-testid="route-geometry-draft">
   <div class="rg-draft-head">
    <b>{{draft.label}}</b>
    <span :class="['rg-badge',draft.ready?'ok':'bad']" data-testid="route-geometry-draft-state">{{draft.ready?'可应用':'不可应用'}}</span>
   </div>
   <div v-if="!draft.ready" class="rg-list bad" role="alert" data-testid="route-geometry-draft-issues">
    <p v-for="(issue,index) in draft.issues" :key="'di'+index">{{issue}}</p>
   </div>
   <template v-else>
    <div class="rg-draft-metrics" data-testid="route-geometry-draft-metrics">
     <span>{{draft.points.length}} 点</span>
     <span v-if="draftReport">总长 {{m3(draftReport.lengthM)}} m</span>
     <span v-if="draftReport">拐点 {{draftReport.corners}}</span>
     <span v-if="draftReport" :class="{bad:draftReport.errors.length}">草稿校验 {{draftReport.errors.length?'未通过（'+draftReport.errors.length+'）':'通过'}}</span>
    </div>
    <div v-if="draft.notes.length" class="rg-notes" data-testid="route-geometry-draft-notes">
     <p v-for="(note,index) in draft.notes" :key="'dn'+index">{{note}}</p>
    </div>
    <div v-if="draftReport&&draftReport.errors.length" class="rg-alert warn" data-testid="route-geometry-draft-warnings">
     <AlertTriangle :size="14"/>
     <div><b>草稿未通过几何校验（服务端编译仍是最终判据）</b><p v-for="(issue,index) in draftReport.errors" :key="'de'+index">{{issue.message}}</p></div>
    </div>
    <div class="rg-actions">
     <Button size="sm" :disabled="isDisabled||!draft.ready" data-testid="route-geometry-apply" @click.prevent="applyDraft"><Save :size="14"/> {{busy?'正在保存…':'应用到路径'}}</Button>
     <Button size="sm" variant="ghost" :disabled="busy" data-testid="route-geometry-discard" @click.prevent="clearDraft"><X :size="13"/> 撤销预览</Button>
    </div>
   </template>
  </div>

  <div v-if="error" class="rg-alert error" role="alert" data-testid="route-geometry-error"><AlertTriangle :size="14"/><span>{{error}}</span></div>
  <div v-if="message" class="rg-alert success" role="status" data-testid="route-geometry-message"><CheckCircle2 :size="14"/><span>{{message}}</span></div>
 </div>
</template>

<style scoped>
.rg{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--line);border-radius:9px;background:white;font-size:12px;color:#1e293b}
.rg-head{display:flex;align-items:center;gap:6px;font-size:13px}
.rg-head strong{display:inline-flex;align-items:center;gap:5px;font-weight:650;white-space:nowrap}
.rg-summary{margin-left:auto;color:var(--muted);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.rg-hint{margin:0;color:var(--muted);font-size:11px;line-height:1.55}
.rg-sec{border-top:1px solid var(--line);padding-top:7px;display:flex;flex-direction:column;gap:6px}
.rg-sec h4,.rg-op h5{margin:0;display:flex;align-items:center;gap:5px;font-size:12px;font-weight:650;color:#334155}
.rg-badge{margin-left:auto;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:600}
.rg-badge.ok{background:#ecfdf5;color:#047857}
.rg-badge.bad{background:#fef2f2;color:#b91c1c}
.rg-rows{margin:0;display:flex;flex-direction:column;gap:3px;font-size:11px}
.rg-rows div{display:flex;gap:6px;line-height:1.5}
.rg-rows dt{flex:0 0 96px;color:var(--muted)}
.rg-rows dd{margin:0;flex:1 1 auto;min-width:0;color:#334155;overflow-wrap:anywhere}
.rg-rows dd.bad{color:#b91c1c;font-weight:600}
.rg-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin:0;font-size:10.5px}
.rg-metrics div{padding:4px 5px;background:#f8fafc;border-radius:5px}
.rg-metrics dt{color:var(--muted);white-space:nowrap}
.rg-metrics dd{margin:1px 0 0;font-family:var(--mono);font-weight:600;font-size:11px}
.rg-list{padding:5px 7px;border-radius:6px;font-size:11px;line-height:1.5}
.rg-list b{display:block;margin-bottom:1px}
.rg-list p{margin:2px 0}
.rg-list.bad{background:#fef2f2;color:#b91c1c}
.rg-list.warn{background:#fffbeb;color:#92400e}
.rg-ok{display:inline-flex;align-items:center;gap:5px;margin:0;padding:5px 7px;border-radius:6px;background:#ecfdf5;color:#047857;font-size:11px}
.rg-alert{display:flex;align-items:flex-start;gap:5px;padding:5px 8px;border-radius:6px;font-size:11px;line-height:1.5}
.rg-alert p{margin:2px 0}
.rg-alert.error{background:#fef2f2;color:#b91c1c;border:1px solid #fee2e2}
.rg-alert.warn{background:#fffbeb;color:#92400e;border:1px solid #fde68a}
.rg-alert.success{background:#ecfdf5;color:#047857}
.rg-details{font-size:11px}
.rg-details summary{cursor:pointer;color:#475569}
.rg-table{margin-top:5px;max-height:150px;overflow:auto;border:1px solid var(--line);border-radius:5px}
.rg-trow{display:grid;grid-template-columns:.55fr 1.5fr .7fr .9fr;gap:5px;padding:3px 6px;border-top:1px solid #eef2f7;font-family:var(--mono);font-size:10px;color:#475569}
.rg-trow:first-child{border-top:0}
.rg-trow.head{font-family:inherit;color:var(--muted);background:#f8fafc}
.rg-op{border-top:1px solid var(--line);padding-top:7px;display:flex;flex-direction:column;gap:5px}
.rg-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rg-field{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#334155;white-space:nowrap}
.rg-field.rg-grow{flex:1 1 220px;min-width:0}
.rg-field select,.rg-field input{min-width:0;padding:3px 6px;border:1px solid #cbd5e1;border-radius:6px;font:inherit;font-size:11px;color:#334155;background:white;font-variant-numeric:tabular-nums}
.rg-field.rg-grow select{flex:1 1 auto;width:100%}
.rg-field input{width:82px;text-align:right}
.rg-check{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#334155}
.rg-tip{color:var(--muted);font-size:10.5px}
.rg-draft{padding:7px 8px;border:1px solid #bfdbfe;border-radius:7px;background:#f8fbff;display:flex;flex-direction:column;gap:5px}
.rg-draft-head{display:flex;align-items:center;gap:6px;font-size:11.5px}
.rg-draft-head b{font-weight:650;color:#1d4ed8}
.rg-draft-metrics{display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:#475569;font-variant-numeric:tabular-nums}
.rg-draft-metrics .bad{color:#b91c1c;font-weight:600}
.rg-notes{font-size:11px;color:#475569}
.rg-notes p{margin:2px 0}
.rg-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}

.rg,.rg *{box-sizing:border-box;min-width:0}
.rg-line{gap:8px;align-items:flex-end}
.rg-field{display:flex;flex:1 1 90px;flex-direction:column;align-items:stretch;gap:4px;margin:0;font-size:12px;white-space:normal}
.rg-field.rg-grow{flex:1 1 140px}
.rg-field input,.rg-field select{flex:0 0 auto;width:100%;max-width:100%;height:34px;min-height:34px;max-height:34px;margin:0;padding:6px;font-size:13px}
.rg-check{display:flex;flex:0 1 auto;flex-direction:row;align-items:center;gap:6px;margin:0;font-size:12px;white-space:normal}
.rg-check input[type=checkbox]{flex:0 0 16px;width:16px;height:16px;min-height:16px;max-height:16px;margin:0;padding:0}
.rg-tip{font-size:12px;overflow-wrap:anywhere}

.rg-fold{margin:0;border-top:1px solid var(--line);padding-top:7px;display:block}.rg-fold__head{display:flex;align-items:center;gap:5px;width:100%;padding:0;border:0;background:transparent;cursor:pointer;text-align:left;font-size:12px;font-weight:650;color:#334155;min-height:24px}.rg-fold__head::before{content:'›';display:inline-block;width:12px;color:#64748b;font-size:16px;line-height:1;transform:rotate(0deg)}.rg-fold[data-open='1'] .rg-fold__head::before{transform:rotate(90deg)}.rg-fold[data-open='1'] .rg-fold__head{margin-bottom:6px}.rg-fold>.rg-line{margin-top:6px}.rg-fold>.rg-tip{display:inline-block}
</style>
