<script setup lang="ts">
import Konva from 'konva';
import {computed,onMounted,onBeforeUnmount,ref,watch} from 'vue';
import type {FieldMap,Point} from '../../../shared/model';
import {exitPoint,heading,distance,orderedTagsById,vehicleFootprintM} from '../../../shared/model';
import {orthogonalRoute,snapRoutePoint,chainRouteGroups,routeGroupCenters} from '../../../shared/route-design';
import {orderMotionSegmentsByChain} from '../../../shared/route';
import {minCenterGapM,MIN_TAG_DISTANCE_M} from '../../../shared/map-tag-distance';
import {planStrategies,choicesFromSegments,degrees,type SegmentPlan} from '../../../shared/segment-strategy';
import {normalizeRect,pointsInRect,applyBoxSelection,type SelectionPoint} from '../composables/useCanvasSelection';
import {IDLE_LINK,beginLink,previewLink,cancelLink,resolveLink,previewSegment,type LinkState} from '../composables/useCanvasLinks';
import {computeFitBounds,fitTransform,planLabels,estimateLabelWidth,DEFAULT_PADDING_RATIO,type FitMode,type LabelCandidate,type LabelPlan,type PlacedLabel} from '../composables/useCanvasFit';
import {Plus,Minus,Scan} from 'lucide-vue-next';
import Button from './ui/Button.vue';
const props=defineProps<{map:FieldMap,selected:number[],rowId:string,tool:string,editable:boolean,drawing:Point[],panEnabled?:boolean,measurement?:number[],vehicle?:{x:number,y:number,yaw:number},trail?:Point[],routeAnchors?:Point[],routeSelected?:number,routeGroupIds?:number[],routeSkippedGroups?:{id:number,distanceM:number}[],routeName?:string,segmentPlans?:SegmentPlan[],selectedSegment?:string,initialHeading?:number,drawMode?:boolean,spacingMode?:boolean,spacingLine?:number[],spacingGaps?:{fromId:number;toId:number;m:number}[],ghostTags?:{x:number;y:number;id?:number}[],tagEditing?:boolean,panMode?:'pan'|'select',modeLabel?:string,tagAliases?:Map<number,string>,fitMode?:'tags-and-route'|'whole-map',fitRequest?:number}>();
const emit=defineEmits<{select:[id:number,multi:boolean],inspect:[id:number],segmentSelect:[key:string],row:[id:string],blank:[point:Point],move:[ids:number[],dx:number,dy:number],point:[rowId:string,index:number,point:Point],zone:[index:number,point:Point],designSelect:[index:number],designMove:[index:number,point:Point],heading:[value:number],ghostMove:[index:number,point:Point],tagDetail:[id:number],gapEdit:[payload:{fromId:number;toId:number;m:number;x:number;y:number}],gapHover:[payload:{fromId:number;toId:number}|null],boxSelect:[ids:number[]],connect:[payload:{fromId:number;toId:number}],linkRejected:[payload:{code:string;message:string}],'snap-blocked':[payload:{message:string}]}>();
const container=ref<HTMLDivElement>();let stage:Konva.Stage;let layer:Konva.Layer;let overlayLayer:Konva.Layer;let observer:ResizeObserver;let isMounted=false;const coordinate=ref('X 0.00 · Y 0.00 m'),zoom=ref(100);
// Live telemetry (vehicle/trail) lives on a persistent overlay layer. The static layer below it
// owns every interactive node (QR groups, waypoint/handle/heading knobs) and is only rebuilt for
// real map/editing changes, so continuous pose updates can never cancel a click or a drag.
let vehicleGroup:Konva.Group|undefined,vehicleBody:Konva.Rect|undefined,vehicleArrow:Konva.Arrow|undefined,trailLine:Konva.Line|undefined;
let staticBuilds=0,overlayUpdates=0;
const px=(p:Point)=>[p.x*100,-p.y*100];
/** 板组编号相对板中心的固定纵向间距（屏幕像素）。 */
const LABEL_GAP_PX=14;
// 段动作标签（步骤·4T4D 前进/倒车/平移）不再按缩放阈值常驻显示：
// 常态只保留路线/方向箭头/定位组/机器人，详情通过选中或悬停该段按需查看。
// B 编号在极低缩放下不再强制显示：路线经过的板被标为 priority=3（永不隐藏），
// 但 12 段路线会同时强制十几块板，0.45 以下屏幕上必然互压。
// 低于该阈值时让板编号退回「能放下才显示」（选中项仍强制），与段标签同一分层规则。
const BOARD_LABEL_FORCE_MIN_SCALE=0.45;
/**
 * 只读调试出口：把 Konva stage 挂到 window，供标签/实体对齐的专项测试读取
 * 真实 transform（scale/stage.x/stage.y）。仅暴露引用，不参与渲染与交互。
 */
/** 只读调试出口：tagId → {groupId}，供板组标签对齐测试计算板中心。 */
function exposeTagMetaForTests(tags: readonly {id:number;groupId?:string}[]){
  if(typeof window==='undefined')return;
  const meta:Record<number,{groupId?:string}>={};
  for(const t of tags)meta[t.id]={groupId:t.groupId};
  (window as unknown as {__tagMeta?:unknown}).__tagMeta=meta;
}
/** 只读调试出口：candidate / placed / hidden 三段规划快照，供一次性取证。 */
function exposeLabelPlanForTests(payload:any){if(typeof window!=='undefined')(window as any).__labelPlan=payload;}
function exposeStageForTests(s: unknown){
  if(typeof window==='undefined')return;
  (window as unknown as {__stage?:unknown}).__stage=s;
}

let hoverMarker:Konva.Circle|undefined;
let suppressDesignClick=false,spaceHeld=false,middleHeld=false;
// 二维码单击/双击判别用的挂起定时器
// 定位码单击/双击判别：按 "同一个码 + 230ms 窗口" 判定，避免连点不同码被误判为双击
type PendingClick={x:number,y:number,tagId:number,timer:number};
let pendingClick:PendingClick|null=null;
function flushPendingClick(){if(!pendingClick)return;const {x,y,timer}=pendingClick;pendingClick=null;clearTimeout(timer);emit('blank',{x,y});}
// ===== 画布交互模式：选择 / 平移 / 测距 =====
// 本次修复的语义（务必与 App.vue 的 tool 传值保持一致）：
// 1. 只有「显式的平移意图」才可能平移：tool==='pan'、tool==='measure'、空格、中键，
//    以及路径编辑里的「平移」工具（App 只把 editable 置 false，tool 仍是 route-design）。
// 2. props.panEnabled 不再等于「常驻平移开关」。它只是「允许用 pan 手势」的附加权限：
//    空格/中键平移要求 panEnabled===true；普通左键在选择/加点/选择态下一律不平移。
// 3. 即使处在 pan 模式，也必须按住左键并移动超过 PAN_THRESHOLD_PX 才真正平移；
//    单击（位移 ≤ 阈值）永远不平移，也永远不会进入 pan 状态。
// 4. 平移由这里手工 translate stage 完成（stage.draggable 恒为 false），
//    避免 Konva 在 mousedown 就进入拖拽、把后续 click 吃掉。
type CanvasMode='select'|'pan'|'measure';
const canvasMode=ref<CanvasMode>('select');
// ===== 框选与连线 =====
// 两者都只在「选择态」下生效：平移态拖动必须继续平移画布，
// 加点态拖动必须继续被当成一次干净的单击，不能顺手画出选择框。
// 框选矩形一律用**地图坐标（米）**记录，不能用 stage 的绝对屏幕像素：
// 命中判定拿的是二维码中心（米），两者混用会让框选永远命中 0 个。
let boxOrigin:{x:number;y:number}|null=null,boxCurrent:{x:number;y:number}|null=null,boxActive=false;
// 本次指针手势是否始于「画布空白处按下」的框选候选。stage 收不到 mouseup 时（在画布外松手、
// 窗口失焦、系统手势取消），靠它让 window/document 级兜底知道「现在有一个框选手势没收尾」。
let boxGestureOpen=false;
// null = 还没框选过（区别于「框了但没命中」，后者是 0）。
const boxCount=ref<number|null>(null);
// 当前悬停的码：只用于标签优先级（悬停的编号必须清晰可见），不参与命中判定。
const hoveredTagId=ref<number|null>(null);
const linkState=ref<LinkState>({...IDLE_LINK});
const linkPointer=ref<{x:number;y:number}|null>(null);
function tagCenters(){const centers=new Map<number,{x:number;y:number}>();for(const tag of props.map.tags)centers.set(tag.id,{x:tag.x,y:tag.y});return centers;}
function selectionPoints():SelectionPoint[]{return props.map.tags.map(tag=>({id:tag.id,x:tag.x,y:tag.y}));}
function clearBox(){
 boxOrigin=null;boxCurrent=null;boxActive=false;boxGestureOpen=false;
 // 用 find 而不是 findOne：拖动过程中若图层被重建过一次，画布上可能不止一份残留矩形。
 // 无论框选手势从哪条路径收尾，这里都保证节点被销毁、状态被复位。
 if(!stage)return;
 for(const node of stage.find<Konva.Rect>('#box-select-rect'))node.destroy();
 layer?.batchDraw();
}
/**
 * 结束一次框选手势。commit=true 才按当前矩形提交选中（只有真的拖出了矩形才 emit，
 * 与旧实现语义一致）；无论走哪条分支都会执行 clearBox，矩形不会留在画布上。
 */
function endBoxDrag(commit:boolean){
 if(commit&&boxActive&&boxOrigin&&boxCurrent){
  const rect=normalizeRect(boxOrigin,boxCurrent);
  const hit=pointsInRect(selectionPoints(),rect);
  boxCount.value=hit.length;
  if(container.value)container.value.dataset.canvasBoxSelectCount=String(hit.length);
  emit('boxSelect',applyBoxSelection(props.selected,hit,false));
  swallowNextClick=true;
 }
 clearBox();
}
function boxGesturePending(){return boxGestureOpen||boxOrigin!==null||boxCurrent!==null||boxActive||!!stage?.findOne('#box-select-rect');}
/** 兜底收尾：只清理视觉框，不提交选中（「哪些 id 被发出」的语义保持完全不变）。 */
function endBoxGestureQuietly(){if(boxGesturePending())endBoxDrag(false);}
function drawBox(){
 if(!boxOrigin||!boxCurrent||!stage)return;
 const rect=normalizeRect(boxOrigin,boxCurrent);
 const scale=stage.scaleX()||1;
 const existing=stage.findOne('#box-select-rect') as Konva.Rect|undefined;
 const node=existing??new Konva.Rect({id:'box-select-rect',listening:false,fill:'rgba(37,99,166,0.12)',stroke:'#2563a6',strokeWidth:1/scale,dash:[4/scale,3/scale]});
 // Konva 的 y 轴朝下，地图 y 轴朝上：矩形的 y 取上边（即两个角里较大的地图 y）。
 node.setAttrs({x:rect.x*100,y:-(rect.y+rect.height)*100,width:rect.width*100,height:rect.height*100});
 if(!existing)layer.add(node);
 layer.batchDraw();
}
/** 连线预览：从起点码心画到指针（或候选终点码心）。 */
function drawLinkPreview(){
 if(!stage)return;
 const existing=stage.findOne('#link-preview') as Konva.Line|undefined;
 const segment=previewSegment(linkState.value,tagCenters(),linkPointer.value);
 if(!segment){existing?.destroy();layer?.batchDraw();return;}
 const scale=stage.scaleX()||1;
 const node=existing??new Konva.Line({id:'link-preview',listening:false,stroke:'#d97706',strokeWidth:2/scale,dash:[7/scale,5/scale],pointerLength:0});
 node.points([segment.from.x*100,-segment.from.y*100,segment.to.x*100,-segment.to.y*100]);
 if(!existing)layer.add(node);
 layer.batchDraw();
}
function syncLinkDataset(){
 if(!container.value)return;
 container.value.dataset.canvasLinkState=linkState.value.phase;
 container.value.dataset.canvasLinkFrom=linkState.value.fromId===null?'':String(linkState.value.fromId);
}
/**
 * 连线工具的单击处理（点码）。状态机全部走 useCanvasLinks 的纯函数，
 * 这里只负责把结果变成 emit / 视觉。
 */
function handleConnectClick(id:number,at:{x:number;y:number}){
 if(linkState.value.phase==='idle'){
  linkState.value=beginLink(id);
  linkPointer.value={...at};
  drawLinkPreview();syncLinkDataset();
  return;
 }
 const result=resolveLink(linkState.value,id,[]);
 if(!result.ok){
  // 被拒时保留起点：用户可以直接改点另一个终点，不用从头再点一次。
  emit('linkRejected',result.rejection);
  linkState.value=result.next;
  drawLinkPreview();syncLinkDataset();
  return;
 }
 linkState.value=result.next;
 linkPointer.value=null;
 drawLinkPreview();syncLinkDataset();
 emit('connect',result.candidate);
}
function resolveMode():CanvasMode{
 // 显式的量测模式永远优先：它的语义就是「点两个码」。
 if(props.tool==='measure')return 'measure';
 // 空格 / 中键是显式平移意图，但仍要 panEnabled 给权限。
 if((spaceHeld||middleHeld)&&props.panEnabled===true)return 'pan';
 // 单一真相：由 App 用 MODE_SPECS 算出的 panMode 决定「左键拖动是否平移画布」。
 // 用字符串三态而不是布尔：Vue 会把「未传的布尔 prop」强制成 false，
 // 那样就分不清「App 明确说不要平移」和「调用方根本没传」。
 if(props.panMode==='pan'||props.panMode==='select')return props.panMode;
 // 兼容旧调用方（canvas-modes 夹具直接挂本组件、不传 panMode）：保留原推断。
 if(props.tool==='pan')return 'pan';
 if(props.tool==='route-design'&&props.panEnabled===true&&!props.editable)return 'pan';
 return 'select';
}
function refreshMode(){
 canvasMode.value=resolveMode();
 if(stage)stage.draggable(false);
 if(container.value)container.value.dataset.canvasMode=canvasMode.value;
}
// 空格 = 显式平移意图，但仍要求 panEnabled 给权限（见 resolveMode）。
function onKeyDown(e:KeyboardEvent){
 if(e.key!==' '&&e.code!=='Space')return;
 const el=e.target as HTMLElement|null;
 if(el&&(el.matches('input,textarea,select')||el.isContentEditable))return;
 if(!props.panEnabled)return;
 if(!spaceHeld){spaceHeld=true;refreshMode();}
 e.preventDefault();
}
function onKeyUp(e:KeyboardEvent){
 if(e.key!==' '&&e.code!=='Space')return;
 if(spaceHeld){spaceHeld=false;refreshMode();}
}
// Distance (CSS px) the pointer must travel before a press turns into a map pan.
const PAN_THRESHOLD_PX=4;
let pressOrigin:{x:number,y:number}|null=null; // 任意按下：用于区分「点击」与「拖动」
let panOrigin:{x:number,y:number}|null=null;   // 被允许的平移按下：超过阈值后开始平移
let panActive=false;                            // 本次手势已越过阈值并在平移
let panMoved=false;                             // 本次手势确实移动过画布
let pressMoved=false;                           // 本次按下移动过（含非平移拖动）
// 平移/拖动结束后浏览器仍会补发一次 click：用它把这次 click 吞掉；
// 下一次按下时会复位，所以松手后立刻点选不会受影响。
let swallowNextClick=false;
function consumeClickGuard(){const guard=swallowNextClick;swallowNextClick=false;return guard;}
// Konva 只把 mouseup/pointerup 绑在 stage 的 canvas 元素上：在画布外松手、切到别的应用、
// 系统手势取消时 stage 收不到事件，框选矩形就会一直留在画布上（本次修的缺陷）。
// 下面这些 window/document 级监听是兜底：它们只做「收尾清理」，绝不提交选中，
// 因此「哪些 id 被 emit」的语义与旧实现完全一致（旧实现同样不会在画布外松手时选中）。
// 注册在冒泡阶段（capture:false）：画布内的正常松手仍由 stage 的 mouseup 先提交，
// 走到这里时状态已清空，是幂等的 no-op。
// 窗口级释放只作为兜底：Konva 的 stage mouseup 需要先拿到这次释放去提交框选，
// 所以延后到本轮事件派发结束再清理；stage 已处理过就不会再有遗留状态。
let releaseFallbackTimer:ReturnType<typeof setTimeout>|undefined;
function onWindowRelease(){
 if(releaseFallbackTimer)clearTimeout(releaseFallbackTimer);
 releaseFallbackTimer=setTimeout(()=>{
  releaseFallbackTimer=undefined;
  // 只有 stage 确实没收到释放（框还开着）时才兜底清理。
  if(boxGesturePending())endBoxGestureQuietly();
 },0);
}
function onWindowPointerCancel(){if(boxGesturePending())endBoxGestureQuietly();}
function onWindowMouseOut(e:MouseEvent){if(!e.relatedTarget&&boxGesturePending())endBoxGestureQuietly();}
function onDocumentVisibility(){if(document.visibilityState==='hidden')endBoxGestureQuietly();}
function bindBoxReleaseFallbacks(){
 window.addEventListener('mouseup',onWindowRelease);
 window.addEventListener('pointerup',onWindowRelease);
 window.addEventListener('touchend',onWindowRelease);
 window.addEventListener('pointercancel',onWindowPointerCancel);
 window.addEventListener('mouseout',onWindowMouseOut);
 document.addEventListener('visibilitychange',onDocumentVisibility);
}
function unbindBoxReleaseFallbacks(){
 window.removeEventListener('mouseup',onWindowRelease);
 window.removeEventListener('pointerup',onWindowRelease);
 window.removeEventListener('touchend',onWindowRelease);
 window.removeEventListener('pointercancel',onWindowPointerCancel);
 window.removeEventListener('mouseout',onWindowMouseOut);
 document.removeEventListener('visibilitychange',onDocumentVisibility);
}
function resetPointerState(){spaceHeld=false;middleHeld=false;suppressDesignClick=false;pressOrigin=null;panOrigin=null;panActive=false;panMoved=false;pressMoved=false;swallowNextClick=false;container.value?.classList.remove('is-dragging');container.value?.removeAttribute('data-canvas-panning');clearAlignGuides();snapBlockedThisGesture=false;container.value?.setAttribute('data-canvas-snap','');container.value?.setAttribute('data-canvas-snap-blocked','');endBoxGestureQuietly();refreshMode();}
// ===== 多选拖动：虚线对齐参考 + 自动吸附 =====
// 拖动中实时画出与邻近点的 X/Y 对齐虚线，并在容差内吸附，落点精确共线。
type MapTag=FieldMap['tags'][number];
type AlignGuide={axis:'x'|'y';x1:number;y1:number;x2:number;y2:number};
type SnapResult={dxPx:number;dyPx:number;guides:AlignGuide[];snappedX:boolean;snappedY:boolean;blocked:boolean;reason:string|null;message:string};
let alignNodes:Konva.Line[]=[];let dragOrigin:{x:number;y:number}|null=null;let dragSelection:number[]=[];
// 一次拖动手势最多上报一条 snap-blocked（在 dragstart 复位）。
let snapBlockedThisGesture=false;
function clearAlignGuides(){
 for(const node of alignNodes){node.destroy();}
 alignNodes=[];
 overlayLayer?.batchDraw();
}
/** 对齐参考线：画在 overlayLayer（该层同样跟随 stage 的缩放/平移，坐标用世界像素）。
 *  X 吸附 → 竖线（x 固定）；Y 吸附 → 横线（y 固定）。±40 屏幕 px 换算成世界像素。 */
function drawAlignGuides(guides:AlignGuide[]):void{
 if(!stage||!overlayLayer)return;
 const scale=stage.scaleX()||1;
 const wanted=new Map<'x'|'y',AlignGuide>();
 for(const guide of guides)wanted.set(guide.axis,guide);
 alignNodes=alignNodes.filter(node=>{
  const axis=node.getAttr('align-axis') as 'x'|'y'|undefined;
  if(axis&&wanted.has(axis))return true;
  node.destroy();
  return false;
 });
 for(const [axis,guide] of wanted){
  let node=alignNodes.find(item=>item.getAttr('align-axis')===axis);
  if(!node){
   node=new Konva.Line({name:axis==='x'?'align-guide-x':'align-guide-y',listening:false,stroke:'#2563a6',strokeWidth:1/scale,dash:[6/scale,4/scale],perfectDrawEnabled:false});
   node.setAttr('align-axis',axis);
   overlayLayer.add(node);
   alignNodes.push(node);
  }
  node.setAttrs({strokeWidth:1/scale,dash:[6/scale,4/scale]});
  node.points([guide.x1,guide.y1,guide.x2,guide.y2]);
 }
 overlayLayer.batchDraw();
}
/** 计算吸附后的增量：以**实际被拖动的那个节点**的绝对 px 位置为准，
 *  与其余未参与本次拖动的点比较 X/Y，容差内取最近的共线位置。
 *  容差用屏幕像素（随缩放放大），保证缩得越小越容易吸附。
 *  A2：吸附后的中心距若小于 minCenterGapM()+0.01，就拒绝吸附（绝不移动其他码）。 */
function snapDrag(nodeX:number,nodeY:number,originX:number,originY:number,selfIds:number[],draggedId:number):SnapResult{
 const scale=stage.scaleX()||1;
 // 节点坐标是世界像素（米×100），不随缩放变化；容差要先把屏幕像素换算成世界像素。
 const tolPx=Math.min(Math.max(10/scale,8),30); // 10 屏幕 px 起步、8 cm 下限，最多 30 cm 防缩得很小时过黏
 const pxPerM=100;
 const others=props.map.tags.filter(t=>!selfIds.includes(t.id));
 const dragged=props.map.tags.find(t=>t.id===draggedId);
 const tagSize=(tag:MapTag)=>Number.isFinite(tag.size)&&tag.size>0?tag.size:MIN_TAG_DISTANCE_M;
 const sizeA=dragged?tagSize(dragged):MIN_TAG_DISTANCE_M;
 const groupA=!!dragged?.groupId;
 let bestX:number|null=null,bestY:number|null=null,bestXTag:MapTag|null=null,bestYTag:MapTag|null=null;
 for(const t of others){
  const otherPx={x:t.x*pxPerM,y:-t.y*pxPerM};
  const dx=Math.abs(otherPx.x-nodeX),dy=Math.abs(otherPx.y-nodeY);
  if(dx<=tolPx&&(bestX===null||dx<Math.abs(bestX-nodeX))){bestX=otherPx.x;bestXTag=t;}
  if(dy<=tolPx&&(bestY===null||dy<Math.abs(bestY-nodeY))){bestY=otherPx.y;bestYTag=t;}
 }
 // 最小中心距守卫：先把候选落点换算回米，再和吸附目标 / 其余码逐一比较。
 const overlapAt=(worldX:number,worldY:number)=>{
  const point={x:worldX/pxPerM,y:-worldY/pxPerM};
  const ordered:MapTag[]=[];
  if(bestXTag)ordered.push(bestXTag);
  if(bestYTag&&bestYTag!==bestXTag)ordered.push(bestYTag);
  for(const tag of others)if(!ordered.includes(tag))ordered.push(tag);
  for(const tag of ordered){
   const minGap=minCenterGapM(sizeA,tagSize(tag),groupA,!!tag.groupId);
   if(Math.hypot(tag.x-point.x,tag.y-point.y)<minGap+0.01)return {tag,minGap};
  }
  return null;
 };
 let blocked=false,blockTag:MapTag|null=null,blockMinGap=0;
 if(bestX!==null||bestY!==null){
  const overlap=overlapAt(bestX??nodeX,bestY??nodeY);
  if(overlap){
   blocked=true;blockTag=overlap.tag;blockMinGap=overlap.minGap;
   if(bestX!==null&&bestY!==null){
    // 两轴同时吸附：拒绝修正量更小的那一轴，另一轴保留。
    if(Math.abs(bestX-nodeX)<=Math.abs(bestY-nodeY)){bestX=null;bestXTag=null;}
    else{bestY=null;bestYTag=null;}
   }else if(bestX!==null){bestX=null;bestXTag=null;}
   else{bestY=null;bestYTag=null;}
  }
 }
 const finalX=bestX??nodeX,finalY=bestY??nodeY;
 const guides:AlignGuide[]=[];
 // X 吸附：竖线，跨两个节点的 y ± 40 屏幕 px；Y 吸附：横线，跨两个节点的 x ± 40 屏幕 px。
 if(bestX!==null&&bestXTag){
  const targetY=-bestXTag.y*pxPerM;
  guides.push({axis:'x',x1:bestX,y1:Math.min(finalY,targetY)-40/scale,x2:bestX,y2:Math.max(finalY,targetY)+40/scale});
 }
 if(bestY!==null&&bestYTag){
  const targetX=bestYTag.x*pxPerM;
  guides.push({axis:'y',x1:Math.min(finalX,targetX)-40/scale,y1:bestY,x2:Math.max(finalX,targetX)+40/scale,y2:bestY});
 }
 return {
  dxPx:finalX-originX,dyPx:finalY-originY,guides,
  snappedX:bestX!==null,snappedY:bestY!==null,
  blocked,reason:blocked?'min-center-gap':null,
  message:blocked&&blockTag?`吸附会与 Q${String(blockTag.id).padStart(3,'0')} 重合（最小中心距 ${blockMinGap.toFixed(2)} m），已拒绝吸附`:'',
 };
}
function redraw() {
 // Font readiness and queued resize callbacks can run after Konva destroys its stage.
 if(!isMounted||!layer||layer.getStage()!==stage)return;layer.destroyChildren();
 // 图层重建时不允许残留上一手势的对齐参考线（dragend 之外的兜底）。
 clearAlignGuides();
 const bounds=stage.getRelativePointerPosition();void bounds;
 const scale=stage.scaleX(),minX=-stage.x()/scale/100,maxX=(stage.width()-stage.x())/scale/100,minY=-(stage.height()-stage.y())/scale/100,maxY=stage.y()/scale/100;
 // 标记尺寸阻尼跟随缩放：屏幕目标 = base * scale^0.4，并夹在 [minPx, base*1.5]。
 // 放大时只略微变大（不会顶满画布），缩小时仍会变小，保证密集区不糊、极小也不丢点。
 const ms=(size:number,minPx:number,maxPx:number=size*1.5)=>{
  const target=Math.min(maxPx,Math.max(minPx,size*Math.pow(scale,.4)));
  return target/scale;
 };
 if(container.value){container.value.dataset.konvaSelectedSegment=props.selectedSegment??'';container.value.dataset.konvaMarkerPx=String(Math.round(ms(12,7)*scale));container.value.dataset.konvaScale=String(scale);container.value.dataset.konvaX=String(stage.x());container.value.dataset.konvaY=String(stage.y());container.value.dataset.konvaStaticBuilds=String(++staticBuilds);}
 const step=props.tool==='route-design'&&scale>=.65?.05:scale<0.3?2:scale<0.65?1:0.5;
 for(let x=Math.floor(minX/step)*step;x<=maxX;x+=step)layer.add(new Konva.Line({points:[x*100,-minY*100,x*100,-maxY*100],stroke:Math.abs(x)<0.01?'#c9d0d7':'#eef1f4',strokeWidth:1/scale,listening:false}));
 for(let y=Math.floor(minY/step)*step;y<=maxY;y+=step)layer.add(new Konva.Line({points:[minX*100,-y*100,maxX*100,-y*100],stroke:Math.abs(y)<0.01?'#c9d0d7':'#eef1f4',strokeWidth:1/scale,listening:false}));
 props.map.zone.forEach((p,i)=>{if(props.editable&&props.tool==='zone'){const [x,y]=px(p);const handle=new Konva.Circle({x,y,radius:6/scale,fill:'#2563a6',stroke:'white',strokeWidth:2/scale,draggable:true});handle.on('dragend',()=>emit('zone',i,{x:handle.x()/100,y:-handle.y()/100}));layer.add(handle);}});
 for(const row of props.map.rows) {
  const office=props.map.routeMode==='waypoints',route=office?[exitPoint(row),...row.points]:row.points;
  const line=new Konva.Line({points:route.flatMap(px),stroke:row.id===props.rowId?'#c9d0d7':'#eef1f4',strokeWidth:office?8/scale:row.width*100,lineCap:'butt',hitStrokeWidth:row.width*100});line.on('click tap',()=>{if(props.tool==='select')emit('row',row.id);});layer.add(line);
  layer.add(new Konva.Line({points:route.flatMap(px),stroke:row.id===props.rowId?'#2563a6':'#727d88',strokeWidth:1.8/scale,dash:[6/scale,4/scale],listening:false}));
  const e=exitPoint(row);if(!office)layer.add(new Konva.Line({points:[...px(e),...px(row.points[0]!)],stroke:'#2563a6',strokeWidth:2/scale,dash:[5/scale,4/scale],listening:false}));
  const mid=row.points[Math.floor(row.points.length/2)]!;layer.add(new Konva.Text({fontFamily:"QR Sans, QR CJK, sans-serif",x:mid.x*100+12/scale,y:-mid.y*100-26/scale,text:row.name,fontSize:16/scale,fill:'#56616d',listening:false}));
  if(props.editable&&props.tool!=='measure'&&props.rowId===row.id)row.points.forEach((p,i)=>{const [x,y]=px(p),handle=new Konva.Circle({x,y,radius:5/scale,fill:'#f7f8f9',stroke:'#2563a6',strokeWidth:2/scale,draggable:true});handle.on('dragend',()=>emit('point',row.id,i,{x:handle.x()/100,y:-handle.y()/100}));layer.add(handle);});
 }
 const stored=orderMotionSegmentsByChain(props.map.motionSegments??[]);
 // 段动作标签不在本循环里画：它的屏幕位置要参与和 B 编号同一套避让规划，
 // 而避让所需的 labelCandidates 在本循环之后才构造。这里只记中点，标签稍后统一添加。
 const segmentMidpoint=new Map<string,{x:number;y:number;index:number;key:string}>();
 // 同一对 fromId>toId 可能重复经过（如 B080→B016→B080），occurrence 区分第几次。
 const segmentOccurrence=new Map<string,number>();
 for(const [i,segment] of stored.entries()){
  if(!segment.points?.length)continue;
  const color=segment.mode==='crab'?'#2563a6':'#2563a6',p=segment.points[Math.floor(segment.points.length/2)]!;
  const pair=segment.fromId+'>'+segment.toId;
  const occurrence=segmentOccurrence.get(pair)??0;
  segmentOccurrence.set(pair,occurrence+1);
  // 与 App.vue selectedSegmentKey 完全一致的执行键：fromId>toId#occurrence。
  segmentMidpoint.set(segment.id,{x:p.x,y:p.y,index:i,key:pair+'#'+occurrence});
  // 导航视图：段线可点，点击即「选中该段」——这是低缩放下让被隐藏的段动作标签
  // 按需出现的唯一入口（右侧步骤表只在编辑态存在）。hitStrokeWidth 给细线一个
  // 可点宽度，否则 3/scale 的线几乎点不中。
  // 编辑视图保持不可点：那里画的是正交绘制预览，段线只作背景参考。
  const segLine=new Konva.Line({name:`segment-${segment.id}`,points:segment.points.flatMap(px),stroke:color,strokeWidth:3/scale,listening:props.tool!=='route-design',hitStrokeWidth:props.tool==='route-design'?0:16/scale});
  if(props.tool!=='route-design'){
   segLine.on('click tap',e=>{e.cancelBubble=true;emit('segmentSelect',pair+'#'+occurrence);});
   segLine.on('mouseenter',()=>{if(container.value)container.value.style.cursor='pointer';});
   segLine.on('mouseleave',()=>{if(container.value)container.value.style.cursor='';});
  }
  layer.add(segLine);
  // 层级规则（label 分层，不移动任何点位/路线）：
  //   1) B 组编号：常态可见（板中心，见上方 groupAnchor）。
  //   2) 段动作/方向标签：常态隐藏，仅选中/悬停该段时显示（按需查看详情）。
  //   3) 路点序号、箭头/车图标：始终绘制，但受各自尺寸/缩放约束。
 }
 // The live trail is drawn on the overlay layer by drawOverlay(), never rebuilt with the map.
 const plans=props.segmentPlans??(stored.length&&stored.every(s=>s.points?.length)?planStrategies([{id:stored[0]!.fromId,...stored[0]!.points[0]!},...stored.map(s=>({id:s.toId,...s.points.at(-1)!}))],stored[0]!.bodyYaw,choicesFromSegments(stored)):[]);
 if(container.value)container.value.dataset.segmentPlans=JSON.stringify(plans.map(p=>({key:p.key,mode:p.mode,effective:p.effective,startYaw:p.startYaw,travelYaw:p.travelYaw,arrivalYaw:p.arrivalYaw,turn:p.turn,blocked:p.blocked,problem:p.problem})));
 // The route stays blue; only the selected segment is painted red along its whole length.
 const orderedPlans=[...plans].filter(plan=>plan.key!==props.selectedSegment).concat(plans.filter(plan=>plan.key===props.selectedSegment));
 for(const plan of orderedPlans){
  const x=(plan.start.x+plan.end.x)*50,y=-(plan.start.y+plan.end.y)*50,length=24/scale,active=props.selectedSegment===plan.key;
  const color=active?'#ffffff':plan.blocked||plan.problem?'#b45309':'#2563eb';
  const arrowPoints=[x-Math.cos(plan.travelYaw)*length/2,y+Math.sin(plan.travelYaw)*length/2,x+Math.cos(plan.travelYaw)*length/2,y-Math.sin(plan.travelYaw)*length/2];
  if(active){
   // Only the selected leg is red, and it is red along its whole length: a white halo
   // under a thick red line, then a white direction chevron, a dashed ring and a label.
   // The leg follows the real polyline between the two group centres, so a bent leg
   // is never drawn as a straight chord.
   const near=(p:Point,q:Point)=>Math.hypot(p.x-q.x,p.y-q.y)<1e-4;
   let from=-1,to=-1;
   for(let i=0;i<props.drawing.length;i++){const p=props.drawing[i]!;if(near(p,plan.start))from=i;if(near(p,plan.end))to=i;}
   const legPoints=from>=0&&to>from?props.drawing.slice(from,to+1):[plan.start,plan.end];
   const leg=legPoints.flatMap(px);
   // 选中段只保留"一条红色箭头"：白色光晕打底，红箭头压在上面，不再叠蓝色行进箭头。
   layer.add(new Konva.Line({name:'selected-leg-halo',points:leg,stroke:'#ffffff',strokeWidth:13/scale,lineCap:'round',lineJoin:'round',listening:false}));
   layer.add(new Konva.Arrow({name:'selected-leg',points:leg,stroke:'#dc2626',fill:'#dc2626',strokeWidth:7/scale,lineCap:'round',lineJoin:'round',pointerLength:16/scale,pointerWidth:14/scale,listening:false}));
  }
  if(!active)layer.add(new Konva.Arrow({name:'travel-'+plan.key,points:arrowPoints,stroke:color,fill:color,strokeWidth:2/scale,pointerLength:6/scale,pointerWidth:6/scale,listening:false}));
  // 车头朝向箭头与转向文字只在当前选中段显示：每段都画会让密集路径糊成一片。
  if(active)layer.add(new Konva.Arrow({name:'heading-'+plan.key,points:[x,y,x+Math.cos(plan.arrivalYaw)*18/scale,y-Math.sin(plan.arrivalYaw)*18/scale],stroke:'#d97706',fill:'#d97706',strokeWidth:2/scale,pointerLength:5/scale,pointerWidth:5/scale,listening:false}));
  if(active&&Math.abs(plan.turn)>.001)layer.add(new Konva.Text({x:x+8/scale,y:y-22/scale,text:(plan.turn>0?'↶':'↷')+Math.abs(degrees(plan.turn))+'° · 仅规划',fontSize:11/scale,fill:'#b45309',listening:false}));
 }
 const measurementIds=props.tool==='measure'?(props.measurement??[]):[];
 const measurementTags=[...new Set(measurementIds)].slice(0,2).map(id=>props.map.tags.find(t=>t.id===id)).filter((t):t is FieldMap['tags'][number]=>!!t&&Number.isFinite(t.x)&&Number.isFinite(t.y));
 const measurementPair=measurementIds.length===2&&measurementIds[0]!==measurementIds[1]&&measurementTags.length===2?measurementTags:[];
 if(measurementPair.length===2){const points=measurementPair.flatMap(px);
  layer.add(new Konva.Line({points,stroke:'#f7f8f9',strokeWidth:6/scale,listening:false}));
  layer.add(new Konva.Line({points,stroke:'#2563a6',strokeWidth:3/scale,dash:[8/scale,8/scale],listening:false}));
  layer.add(new Konva.Line({points,stroke:'#2563a6',strokeWidth:3/scale,dash:[8/scale,8/scale],dashOffset:8/scale,listening:false}));
 }
 // ===== 标签避让（屏幕空间）=====
 // 缩放很小时所有编号会挤成一团：旧实现把字号除以 scale，缩得越小字号反而越大，
 // 于是 14% 时满屏 B1xx 互相盖住。这里改成：
 // 1) 标签尺寸固定为屏幕像素（不随缩放放大），
 // 2) 在屏幕空间按碰撞排布，压不下就错开 y，仍压不下才隐藏**次要**标签，
 // 3) 选中/悬停的标签 priority>0，永远不被隐藏。
 // 注意：这里**不**把 hoveredTagId 算进 priority，否则鼠标一移就要重建图层。
 // 悬停的标签通过「节点已存在、只切 visible / moveToTop」来保证可见。
 // 一个定位板只产生一个标签：取该组所有成员的中心作为锚点。
 // 这样同一 B 编号不会被画 16 次，也不会因成员各自避让而逐排漂移。
 // 组内成员仍全部保留实体、热区与 aria-label（只是不再重复画同一编号）。
 const groupAnchor=new Map<string,{x:number;y:number;count:number}>();
 for(const t of props.map.tags){
  const gid=t.groupId;
  if(!gid)continue;
  const cur=groupAnchor.get(gid);
  if(cur){cur.x+=t.x;cur.y+=t.y;cur.count+=1;}
  else groupAnchor.set(gid,{x:t.x,y:t.y,count:1});
 }
 for(const a of groupAnchor.values()){a.x/=a.count;a.y/=a.count;}
 /** 该 tag 是否作为其定位板的「标签代表」（组内离中心最近的成员）。 */
 const labelOwner=new Set<number>();
 for(const [gid,a] of groupAnchor){
  let best=-1,bestD=Infinity;
  for(const t of props.map.tags){
   if(t.groupId!==gid)continue;
   const d=Math.hypot(t.x-a.x,t.y-a.y);
   if(d<bestD){bestD=d;best=t.id;}
  }
  if(best>=0)labelOwner.add(best);
 }
 const labelCandidates:LabelCandidate[]=(()=>{
  const out:LabelCandidate[]=[];
  // 板组：锚点用**板中心**（成员均值），保证标签落在板中央而不是某个成员上。
  for(const [gid,a] of groupAnchor){
   const owner=[...labelOwner].find(id=>props.map.tags.find(t=>t.id===id)?.groupId===gid);
   if(owner===undefined)continue;
   // 只有**真正被选中**的板才强制显示（priority>0 ⇒ planLabels 永不隐藏）。
   // 旧实现把「路线经过的所有板」也算作强制，12 段路线会一次强制十几块板，
   // 在正确宽度下必然互压 —— 这才是编辑态 13 处重叠的根因。
   // 路线相关但未选中的板仍保持可读（不透明度已由样式保证），放不下就让位给真正重要的标签。
   const selectedBoard=props.selected.includes(owner);
   const sel=selectedBoard;
   // 极低缩放：连选中项也不强制，交给密度算法决定。
   const forceBoard=scale>=BOARD_LABEL_FORCE_MIN_SCALE;
   // 尺寸必须按**实际渲染文本**估算：屏幕上字号固定为 12/16px，
   // 而 'B128' 这类文本实际宽约 68px —— 旧实现一律按 52px 占位，宽度被低估，
   // 于是与相邻序号被判为不碰撞、实际却相压（375 视口实测 68.2px vs 规划 52px）。
   const ownerTag=props.map.tags.find(t=>t.id===owner);
   const ownerText=ownerTag?((props.tagAliases?.get(owner))??ownerTag.groupId??`Q${String(owner).padStart(3,'0')}`):'';
   const boardFs=props.tool==='route-design'?12:16;
   // 高度按真实行高（12px 字号 ≈ 19px 渲染），避免纵向漏判。
   out.push({id:owner,sx:a.x*100*scale+stage.x(),sy:-a.y*100*scale+stage.y(),priority:sel&&forceBoard?3:0,
     w:estimateLabelWidth(ownerText,boardFs,props.tool==='route-design'?52:64),
     h:props.tool==='route-design'?19:24});
  }
  // 无 groupId 的独立码：按自身坐标。
  for(const tag of props.map.tags){
   if(tag.groupId)continue;
   // 与板组同一规则：只有用户**实际选中**的码才优先显示。
   // routeGroupIds 是「路线经过的码」，17 个码不等于 17 个都必须强显——
   // 那会一次性绕过统一规划，把常态编号挤掉。
   const sel=props.selected.includes(tag.id);
   const soloText=props.tagAliases?.get(tag.id)??`Q${String(tag.id).padStart(3,'0')}`;
   const soloFs=props.tool==='route-design'?12:16;
   out.push({id:tag.id,sx:tag.x*100*scale+stage.x(),sy:-tag.y*100*scale+stage.y(),priority:sel&&scale>=BOARD_LABEL_FORCE_MIN_SCALE?3:0,
     w:estimateLabelWidth(soloText,soloFs,props.tool==='route-design'?52:64),
     h:props.tool==='route-design'?19:24});
  }
  return out;
 })();
 // 标签避让沿用既有设计（有限密度避让 + hover 查看），不做默认全隐藏。
 // 关键：B 编号与段动作标签必须进入**同一次**规划。旧实现两类标签各自定位，
 // 在真实 12 段重复经过的密集路线上必然互压（collisions 恒非 0 的根因）。
 const segCandidates:LabelCandidate[]=[];
 const segLabelWidth=props.tool==='route-design'?52:96,segLabelHeight=props.tool==='route-design'?14:16;
 for(const [i,segment] of stored.entries()){
  const mid=segmentMidpoint.get(segment.id);
  if(!mid)continue;
  segCandidates.push({id:-(i+1),sx:mid.x*100*scale+stage.x(),sy:-mid.y*100*scale+stage.y(),priority:props.selectedSegment===mid.key?3:1,w:segLabelWidth,h:segLabelHeight});
 }
 // 路点序号（1/2/3…）同样参与避让：它们画在路点右上/右下，12 段折返路线上
 // 与 B 编号、段动作标签同处一片区域，旧实现完全不避让，必然互压。
 // 优先级 2：高于普通 B 编号、低于选中项 —— 步骤序号是执行顺序，不能被编号挤掉。
 const ordinalCandidates:LabelCandidate[]=[];
 if(props.tool==='route-design'){
  const anchorsAll=props.routeAnchors??[];
  anchorsAll.forEach((pt,i)=>{
   const revisit=anchorsAll.slice(0,i).some(q=>Math.hypot(q.x-pt.x,q.y-pt.y)<0.01);
   // 占位框按真实渲染尺寸给足（monospace 12px 两位数 ≈ 17x14），
   // 否则相邻序号会被判为不碰撞而实际相压。
   // 序号是 monospace 12px；按真实数字文本估算宽度（两位数约 15px），不再固定 20px。
   const ordText=String(i+1);
   ordinalCandidates.push({id:-(1000+i),sx:pt.x*100*scale+stage.x()+(revisit?10:9),sy:-pt.y*100*scale+stage.y()+(revisit?16:-18),priority:i===props.routeSelected?3:2,
     w:Math.max(9,Math.ceil(ordText.length*7.3)+2),h:15});
  });
 }
 // 序号的纵向档位比默认更细（8px）：它们是小字号短文本，
 // 默认 15px 档位在密集区一步就跨过可用空档，导致相邻序号被判为「无位可放」而强制叠放。
 const labelPlan:LabelPlan=planLabels([...labelCandidates,...segCandidates,...ordinalCandidates],{labelWidth:props.tool==='route-design'?52:96,labelHeight:props.tool==='route-design'?19:24,verticalOffsets:[0,8,-8,16,-16,24,-24,32,-32,40,-40,48,-48]});
 const segLabelPlacement=new Map<number,PlacedLabel>();
 const ordinalPlacement=new Map<number,PlacedLabel>();
 for(const item of labelPlan.placed){
  if(item.id<=-1000)ordinalPlacement.set(-(item.id+1000),item);
  else if(item.id<0)segLabelPlacement.set(item.id,item);
 }
 // 段动作标签：与 B 编号共用同一套屏幕空间避让。
 // 优先级 1：低于选中项、高于普通编号，保证执行信息不被普通编号挤掉；
 // 放不下就隐藏（低缩放时本来也该隐藏），绝不与 B 编号互压。
 {
  for(const [i,segment] of stored.entries()){
   const mid=segmentMidpoint.get(segment.id);
   if(!mid)continue;
   const placed=segLabelPlacement.get(-(i+1));
   // 常态不显示段动作标签（步骤编号/4T4D 前进/倒车/平移）：地图只保留
   // 路线、方向箭头、定位二维码/组与机器人。详情按需查看——选中该段
   // （重建时置 visible）或悬停该段线（mouseenter 动态点亮，见 segLine）。
   const wantVisible=props.selectedSegment===mid.key;
   const text=(i+1)+' · '+(segment.mode==='crab'?'平移':segment.direction==='reverse'?'4T4D 倒车':'4T4D 前进');
   // 框中心 → 左边界：减去半个标签宽度（屏幕 px 换算回 world px）。
   const nodeX=placed?((placed.sx-stage.x())/scale-(segLabelWidth/2)/scale):(mid.x*100+8/scale);
   const nodeY=placed?((placed.sy-stage.y())/scale):(-mid.y*100+8/scale);
   layer.add(new Konva.Text({name:`segment-label-${segment.id}`,fontFamily:'QR Sans, QR CJK, sans-serif',x:nodeX,y:nodeY,width:segLabelWidth/scale,height:segLabelHeight/scale,align:'center',verticalAlign:'top',visible:wantVisible&&!!placed,text,fontSize:13/scale,fill:'#2563a6',listening:false}));
  }
 }
 exposeTagMetaForTests(props.map.tags);
 exposeLabelPlanForTests({
  tool:props.tool,scale,
  candidates:labelCandidates.map(c=>({id:c.id,sx:+c.sx.toFixed(1),sy:+c.sy.toFixed(1),priority:c.priority,w:c.w??null,h:c.h??null})),
  placed:labelPlan.placed.map(p=>({id:p.id,sx:+p.sx.toFixed(1),sy:+p.sy.toFixed(1),forced:p.forced})),
  hidden:[...labelPlan.hidden],
 });
 const labelPlacement=new Map(labelPlan.placed.filter(item=>item.id>=0).map(item=>[item.id,item]));
 if(container.value){container.value.dataset.canvasVisibleLabels=String(labelPlan.visibleCount);container.value.dataset.canvasHiddenLabels=String(labelPlan.hidden.length);container.value.dataset.canvasLabelPriority=String(labelCandidates.filter(c=>c.priority>0).length);}
 for(const t of orderedTagsById(props.map.tags)){const selected=props.selected.includes(t.id)||(props.tool==='route-design'&&!!props.routeGroupIds?.includes(t.id)),[x,y]=px(t);// 二维码是否可拖动只由 tagEditing（或点选式间距模式）决定：
// 以前写成 editable && tool==='select'，点位表格阶段两者都不成立，
// 于是拖码完全没有反应，看起来就像「位置改不了」。
// 「加点」态（drawMode）下 tag 绝不拖动：拖动会置 pressMoved/swallowNextClick，
// 把 click 吞掉 → 同一个码点第二次加不进路点（A→B→A 只能到 A→B）。
// 这与提示条「方块可拖动」并不冲突：要拖动请用「选择」/「调整点位」。
// 平移工具（panMode/tool==='pan' 或 canvasMode==='pan'）下点必须不可拖动：
// 否则按住点会挪点而不是平移画布。
// 路径编辑（route-design）里也可以拖动二维码：手绘/补码地图经常边画路径边调点位。
// drawMode（加点）仍然禁止拖动，否则会吞掉点击、导致同一个码第二次加不进路点。
const tagDraggable=props.editable&&!props.drawMode&&props.tool!=='pan'
 &&(!!(props.tagEditing||props.spacingMode||props.tool==='select')||props.tool==='route-design');
  const group=new Konva.Group({id:'tag-node-'+t.id,name:'tag-'+t.id,x,y,draggable:tagDraggable,listening:true,perfectDrawEnabled:false});
  const skipped=props.tool==='route-design'&&props.routeSkippedGroups?.some(tag=>tag.id===t.id);
  const size=ms(t.size*100,5);group.add(new Konva.Rect({name:'tag-body-'+t.id,x:-size/2,y:-size/2,width:size,height:size,cornerRadius:ms(2,1.2),fill:skipped?'#d97706':selected?'#2563a6':t.kind==='end'?'#2563a6':'#39444f',stroke:selected?'#c9d0d7':'white',strokeWidth:ms(2,1)}));
   // 热区：任何工具下都至少 32px 等效点击面积（缩得越小热区越大），点选不会因为码画得小而点不中。
   {const hit=Math.max(size,32/scale);group.add(new Konva.Rect({name:'tag-hit-'+t.id,x:-hit/2,y:-hit/2,width:hit,height:hit,fill:'rgba(0,0,0,0.001)',strokeWidth:0,listening:true,perfectDrawEnabled:false}));}
   if(props.tool==='route-design'){group.setAttr('aria-label',`二维码 Q${String(t.id).padStart(3,'0')}${t.groupId?`，定位组 ${t.groupId}`:''}${props.tagAliases?.get(t.id)?`，现场名称 ${props.tagAliases.get(t.id)}`:''}`);}
  // 编辑路径时只标注与路线相关的码（途经/偏离/选中），其余码不写名字：
  // 码密时满屏 B1xx 会盖住路径本身。扫描/导航页仍全部标注。
  // 路径编辑时同样标注全部定位组（淡色小字），否则满屏方块无法分辨该连哪一个点；
  // 被选中/偏离的点仍用醒目颜色，路径本身画在最上层不会被遮挡。
  // 有现场别名时显示「名称」，编号仍在 tooltip/aria 里保留；没有别名时与旧标签完全一致。
  const aliasName=props.tagAliases?.get(t.id);
  // 标签用**屏幕像素**尺寸再除回 scale，视觉大小不随缩放变化：
  // 缩小时不再变成满屏大字，放大时也不会细到看不清。
  // 屏幕像素尺寸：碰撞判定与实际渲染必须用同一组数值，否则密集时误判为全冲突。
  // 与 planLabels 的占位尺寸**必须完全一致**，否则碰撞判定与实际渲染会脱节。
  // 实测：'B016' 在 12px 字号下渲染宽 62.3px，而旧固定值 52px 只覆盖了 83%，
  // 规划框比真实框窄 → 明明相压却判为不碰撞。这里用同一估算函数得出宽度。
  const labelTextForSize=aliasName??t.groupId??`Q${String(t.id).padStart(3,'0')}`;
  const boardFontPx=props.tool==='route-design'?12:16;
  const labelWpx=estimateLabelWidth(labelTextForSize,boardFontPx,props.tool==='route-design'?52:64);
  const labelHpx=props.tool==='route-design'?16:18;
  // **每个**码都建标签节点，只把放不下的那份 visible(false)：
  // 这样 hover 时只要 visible(true)+moveToTop 就能让编号清晰可见，无需重建图层
  // （重建会销毁用户正按着的节点，点选/拖动会间歇性失效）。
  const placement=labelPlacement.get(t.id);
  // 组内非代表成员不重复画同一 B 编号（实体/热区/aria 仍在）。
  const skipLabel=!!t.groupId&&!labelOwner.has(t.id);
  // 标签是 tag group 的子节点，group 原点在码心（world px），group 本身已被 stage 变换。
  // planLabels 返回的 sy 是**屏幕**坐标（含 stage.x()/stage.y() 与 scale），
  // 而 group 的 y 是 world px。要得到「相对码心的局部偏移」，必须先把
  // 屏幕坐标换算回 world px：
  //   worldY = (sy - stage.y()) / scale
  //   局部偏移 = worldY - groupY
  // 旧实现写成 `placement.sy - (y! + stage.y())`，多减了一次 stage.y() 且没除 scale，
  // 于是标签相对实体的纵向偏移随平移量与缩放变化 —— 这正是导航页 4x4 组标签
  // 逐排漂移、与方点压在一起的原因。
  // planLabels 的 sy 已是屏幕坐标（= 实体屏幕 y + 屏幕避让偏移）。
  // 实体屏幕 y 就是 (stage.y() + groupY*scale)，所以：
  //   屏幕避让偏移 = placement.sy - (stage.y() + y!*scale)
  //   局部偏移(px) = 屏幕避让偏移 / scale
  // 旧实现用 (sy - stage.y())/scale - y!，等价于把「屏幕偏移 / scale」再乘 scale 之外的
  // 误差项放大，且避让档位按屏幕设计却按 world 应用，于是同一组内逐排漂移。
  // 板组标签：锚点 = 板中心，且纵向固定为「板中心正上方 LABEL_GAP_PX」，
  // 不参与成员级避让档位（否则同组会出现 -3..11 的抖动）。
  // 独立码（无 groupId）：沿用既有避让结果。
  const isBoardLabel=!!t.groupId;
  let offsetX:number,offsetY:number;
  if(isBoardLabel){
   const g=groupAnchor.get(t.groupId!);
   offsetX=g?((g.x*100)-(x!)):0;
   // 板标签也采用 planLabels 的纵向档位：placement.sy 已是「板中心屏幕 y + 档位」，
   // 换算回相对码心的局部偏移。旧实现无条件 -LABEL_GAP_PX/scale，等于丢弃避让结论，
   // 密集路线上 B 编号仍会与相邻段标签互压。
   const anchorY = placement ? placement.sy : (-(g?.y??0)*100*scale + stage.y());
   offsetY = (anchorY - (stage.y() + y! * scale)) / scale;
  }else{
   const anchorX = placement ? placement.sx : (x! + stage.x());
   const anchorY = placement ? placement.sy : (y! + stage.y());
   offsetX = (anchorX - (stage.x() + x! * scale)) / scale;
   offsetY = (anchorY - (stage.y() + y! * scale)) / scale;
  }
  const labelNode=new Konva.Text({fontFamily:"QR Sans, QR CJK, sans-serif",name:'tag-label-'+t.id,x:offsetX-labelWpx/2/scale,y:offsetY+4/scale,width:labelWpx/scale,height:labelHpx/scale,align:'center',verticalAlign:'top',text:aliasName??t.groupId??`Q${String(t.id).padStart(3,'0')}`,fontSize:(props.tool==='route-design'?12:16)/scale,fill:skipped?'#d97706':selected?'#2563a6':(props.tool==='route-design'?'#9aa6b2':'#56616d'),listening:false,opacity:props.tool==='route-design'&&!selected&&!skipped?.55:1,visible:!!placement});
  if(!skipLabel)group.add(labelNode);
  group.on('click tap',e=>{
   e.cancelBubble=true;
   // 平移/拖动后的尾随 click、或处于平移模式时，二维码既不被选中也不追加路点。
   if(consumeClickGuard())return;
   // 平移态（空格/中键/平移工具）下单击二维码不选中、也不追加路点。
   if(canvasMode.value==='pan')return;
   // 连线工具：码的点击必须在这里接住。tag 组自己 cancelBubble，
   // 放到 stage 的 click 里处理永远收不到（这就是「点码没反应」的原因）。
   if(props.tool==='connect'){
    handleConnectClick(t.id,{x:t.x,y:t.y});
    return;
   }
   if(props.tool!=='route-design'){emit('select',t.id,!!e.evt.shiftKey);return;}
   // 路径编辑：只有「加点」态才追加路点（允许同一码重复经过，如 B064→B080→B016→B080）。
   if(props.drawMode&&props.editable){
    // 点中码只切换选中，不能再发 blank（那会被父组件当成空点击，立刻清掉刚选中的）。
    flushPendingClick();emit('inspect',t.id);return;
   }
   // 只读查看：同一码第二次点击视为双击，显示该码详情。
   if(!props.editable&&pendingClick&&pendingClick.tagId===t.id){
    clearTimeout(pendingClick.timer);pendingClick=null;emit('tagDetail',t.id);return;
   }
   // 「选择/调整」态（含路径编辑的选择工具）：单击 = 选中该码，绝不平移、绝不追加路点。
   flushPendingClick();
   emit('inspect',t.id);
  });
  // 悬停只把该码的标签显示出来并提到最前（不重建图层、不改选中状态）。
  group.on('mouseenter',()=>{
   if(hoveredTagId.value===t.id)return;
   hoveredTagId.value=t.id;
   labelNode.visible(true);labelNode.moveToTop();labelNode.opacity(1);layer.batchDraw();
  });
  group.on('mouseleave',()=>{
   if(hoveredTagId.value!==t.id)return;
   hoveredTagId.value=null;
   labelNode.visible(!!placement);labelNode.opacity(props.tool==='route-design'&&!selected&&!skipped?.55:1);layer.batchDraw();
  });
  let dragKind:'multi'|'single'='single';
  group.on('dragstart',()=>{
   suppressDesignClick=true;pressMoved=true;
   container.value?.setAttribute('data-tag-dragging','1');
   // A3：新手势复位吸附遥测；上一手势的对齐参考线绝不留到这一次拖动。
   snapBlockedThisGesture=false;
   container.value?.setAttribute('data-canvas-snap','');
   container.value?.setAttribute('data-canvas-snap-blocked','');
   clearAlignGuides();
   dragKind=selected&&props.selected.length>1?'multi':'single';
   // 多选：整批一起挪，先记下起点，由 dragmove 统一平移所有选中节点。
   dragSelection=dragKind==='multi'?[...props.selected]:[t.id];
   dragOrigin={x:group.x(),y:group.y()};
   if(dragKind==='multi'){
    for(const id of dragSelection){
     if(id===t.id)continue;
     const node=layer.findOne('#tag-node-'+id) as Konva.Group|undefined;
     node?.setAttr('dragStartX',node.x());node?.setAttr('dragStartY',node.y());
    }
   }
  });
  group.on('dragmove',()=>{
   if(!dragOrigin)return;
   const snapped=snapDrag(group.x(),group.y(),dragOrigin.x,dragOrigin.y,dragSelection,t.id);
   // 吸附：把被拖动节点钉到共线位置，其余选中节点跟随同样的增量。
   group.x(dragOrigin.x+snapped.dxPx);
   group.y(dragOrigin.y+snapped.dyPx);
   if(dragKind==='multi'){
    for(const id of dragSelection){
     if(id===t.id)continue;
     const node=layer.findOne('#tag-node-'+id) as Konva.Group|undefined;
     if(!node)continue;
     node.x((node.getAttr('dragStartX')??node.x())+snapped.dxPx);
     node.y((node.getAttr('dragStartY')??node.y())+snapped.dyPx);
    }
   }
   drawAlignGuides(snapped.guides);
   // A3：当前吸附轴实时写回容器属性（被拒绝的轴不计入）。
   container.value?.setAttribute('data-canvas-snap',snapped.snappedX&&snapped.snappedY?'xy':snapped.snappedX?'x':snapped.snappedY?'y':'');
   // 每次手势只上报第一条拒绝（dragstart 已复位），绝不逐帧 emit。
   if(snapped.blocked&&!snapBlockedThisGesture){
    snapBlockedThisGesture=true;
    container.value?.setAttribute('data-canvas-snap-blocked','1');
    emit('snap-blocked',{message:snapped.message});
   }
  });
  group.on('dragend',()=>{pressMoved=true;container.value?.removeAttribute('data-tag-dragging');
   clearAlignGuides();
   snapBlockedThisGesture=false;
   container.value?.setAttribute('data-canvas-snap','');
   container.value?.setAttribute('data-canvas-snap-blocked','');
   // 提交前的最小中心距硬门：拖动结束时若落点与任何未参与本次拖动的码重叠，
   // 把整批沿“对方 → 本点”方向推到安全距离之外。吸附本身已经被拒绝过，
   // 这里兜住“用户直接把点拖到另一个点上”的情况，绝不让两个码落成同一点。
   let pushedOut=false;
   for(let pass=0;pass<3;pass++){
    const selfTag=props.map.tags.find(item=>item.id===t.id);
    const selfSize=selfTag&&Number.isFinite(selfTag.size)&&selfTag.size>0?selfTag.size:MIN_TAG_DISTANCE_M;
    let hit:MapTag|null=null;let need=0;
    let gx=group.x()/100,gy=-group.y()/100;
    for(const other of props.map.tags){
     if(dragSelection.includes(other.id))continue;
     const otherSize=Number.isFinite(other.size)&&other.size>0?other.size:MIN_TAG_DISTANCE_M;
     const minGap=Math.max(minCenterGapM(selfSize,otherSize,!!selfTag?.groupId,!!other.groupId),MIN_TAG_DISTANCE_M)+0.005;
     if(Math.hypot(other.x-gx,other.y-gy)<minGap){hit=other;need=minGap;break;}
    }
    if(!hit)break;
    gx=group.x()/100;gy=-group.y()/100;
    let ux=gx-hit.x,uy=gy-hit.y;
    let len=Math.hypot(ux,uy);
    if(len<1e-9){ux=1;uy=0;len=1;}
    const tx=hit.x+(ux/len)*need,ty=hit.y+(uy/len)*need;
    const ddx=(tx-gx)*100,ddy=-(ty-gy)*100;
    group.x(group.x()+ddx);group.y(group.y()+ddy);
    if(dragKind==='multi'){
     for(const id of dragSelection){
      if(id===t.id)continue;
      const node=layer.findOne('#tag-node-'+id) as Konva.Group|undefined;
      if(node){node.x(node.x()+ddx);node.y(node.y()+ddy);}
     }
    }
    pushedOut=true;
   }
   if(pushedOut){
    container.value?.setAttribute('data-canvas-snap-blocked','1');
    emit('snap-blocked',{message:'落点会与相邻二维码重合，已按最小中心距自动让开'});
   }
   const dx=(group.x()-x!)/100,dy=-(group.y()-y!)/100;
   dragOrigin=null;
   // 位移为 0 说明只是点了一下：不要制造一条空的撤销记录。
   if(Math.abs(dx)<1e-9&&Math.abs(dy)<1e-9){pressMoved=false;return;}
   emit('move',dragKind==='multi'?dragSelection:[t.id],dx,dy);
   // 松手后的尾随 click 允许选中这个被移动的点（不再吞掉下一次点击）。
   pressMoved=false;});layer.add(group);
 }
 // ===== 段点击热区（导航视图专用）=====
 // 段线本身在 tag group 之前绘制，tag 的 32/scale 热区会盖住它；
 // 这里在所有 tag 之后补一层透明粗线热区，保证「点段 → 选中该段」在任意缩放下可命中。
 // 编辑视图不加：那里画的是正交预览，段线仅作背景参考。
 if(props.tool!=='route-design'){
  for(const [i,segment] of stored.entries()){
   if(!segment.points?.length)continue;
   const mid=segmentMidpoint.get(segment.id);
   if(!mid)continue;
   const pair=segment.fromId+'>'+segment.toId;
   const occurrence=stored.slice(0,i).filter(x=>x.fromId===segment.fromId&&x.toId===segment.toId).length;
   const hitLine=new Konva.Line({name:'segment-hit-'+segment.id,points:segment.points.flatMap(px),stroke:'transparent',strokeWidth:0,hitStrokeWidth:22/scale,listening:true});
   hitLine.on('click tap',e=>{e.cancelBubble=true;emit('segmentSelect',pair+'#'+occurrence);});
   // 悬停查看详情：段动作标签常态隐藏，悬停该段热区时临时点亮对应标签，
   // 移开即熄灭（选中的段除外——它的标签由重建时的 visible 语义负责）。
   // 热区层画在 tag 之后，是真正接到指针的一层；段线本身在 tag 之下接不到。
   hitLine.on('mouseenter',()=>{if(container.value)container.value.style.cursor='pointer';const label=layer.findOne(`.segment-label-${segment.id}`);if(label&&!label.visible())label.visible(true);layer.batchDraw();});
   hitLine.on('mouseleave',()=>{if(container.value)container.value.style.cursor='';const label=layer.findOne(`.segment-label-${segment.id}`);if(label&&props.selectedSegment!==pair+'#'+occurrence&&label.visible())label.visible(false);layer.batchDraw();});
   layer.add(hitLine);
   hitLine.moveToBottom();
  }
 }
 if(props.tool==='route-design'){
  const color='#2563eb';
  const preview=new Konva.Line({name:'designed-route',points:props.drawing.flatMap(px),stroke:color,strokeWidth:3/scale,dash:[9/scale,5/scale],listening:false});layer.add(preview);
  const decorations=new Konva.Group({listening:false});layer.add(decorations);
  const updatePreview=(points:Point[])=>{
   preview.points(points.flatMap(px));decorations.destroyChildren();
   for(let i=1;i<points.length;i++){
    const a=points[i-1]!,b=points[i]!,length=distance(a,b);if(length<.001)continue;
    const ux=(b.x-a.x)/length,uy=(b.y-a.y)/length,half=Math.min(length*50,12/scale),cx=(a.x+b.x)*50,cy=-(a.y+b.y)*50;
    decorations.add(new Konva.Arrow({points:[cx-ux*half,cy+uy*half,cx+ux*half,cy-uy*half],stroke:color,fill:color,strokeWidth:2/scale,pointerLength:7/scale,pointerWidth:7/scale,listening:false}));
   }
   for(const p of points){const [x,y]=px(p);const dot=ms(6,4);decorations.add(new Konva.Rect({x:x!-dot/2,y:y!-dot/2,width:dot,height:dot,fill:color,listening:false}));}
    // 途经/偏离的定位码不再画圆环：高倍缩放下会叠成一片，详情见右侧「跳过」面板。
  };
  updatePreview(props.drawing);
  hoverMarker=new Konva.Circle({radius:ms(17,8),stroke:'#2563a6',strokeWidth:ms(2,1),dash:[4/scale,3/scale],visible:false,listening:false});layer.add(hoverMarker);
  (props.routeAnchors??[]).forEach((p,i)=>{const [x,y]=px(p),selected=i===props.routeSelected;
   // 折返点：本点与更早的某个路点重合（例如 B080→…→B080）。序号错开并换色，避免与原点重叠看不出。
   const anchorsAll=props.routeAnchors??[];
   const revisit=anchorsAll.slice(0,i).some(q=>distance(q,p)<0.01);
   const stepColor=revisit?'#d97706':color;
   const handleSize=ms(selected?16:12,selected?9:7);
   const handle=new Konva.Rect({name:'route-waypoint-'+i,x,y,offsetX:handleSize/2,offsetY:handleSize/2,width:handleSize,height:handleSize,fill:selected?'#ffffff':'#39444f',stroke:stepColor,strokeWidth:selected?ms(3,1.6):ms(2,1),draggable:props.editable&&!props.drawMode,listening:!props.drawMode});
   handle.on('click tap',e=>{e.cancelBubble=true;if(props.editable)emit('designSelect',i);});
   handle.on('dragmove',()=>{const snapped=snapRoutePoint({x:handle.x()/100,y:-handle.y()/100},props.map.tags);handle.position({x:snapped.x*100,y:-snapped.y*100});const anchors=(props.routeAnchors??[]).map((a,j)=>j===i?snapped:a);updatePreview(orthogonalRoute(anchors));layer.batchDraw();});
   // 拖动一开始就把它设为选中：用户按下某个路点开始拖，天然期望「我正在动这个点」，
   // 拖完选中丢失会让右侧属性/步骤高亮对不上刚操作的对象。
   // 命中层：必须盖住同位置二维码的 32/scale 热区，否则点路点会被 tag 抢走。
   const hitSize=Math.max(handleSize,32/scale);
   // 加点态（drawMode）下热区不参与命中：否则已在路径上的点会盖住同位置的二维码，
   // 让「重复经过同一个码」永远点不到（A→B→A 只能加到 A→B）。
   // 选择/拖动路点时（非加点态）热区照常工作，保证仍能点选与拖动。
   const hitArea=new Konva.Rect({name:'route-waypoint-hit-'+i,x,y,offsetX:hitSize/2,offsetY:hitSize/2,width:hitSize,height:hitSize,fill:'transparent',listening:!props.drawMode});
   hitArea.on('click tap',e=>{e.cancelBubble=true;if(props.editable)emit('designSelect',i);});
   hitArea.on('mouseenter',()=>{if(!stage)return;container.value&&(container.value.style.cursor='grab');});
   hitArea.on('mouseleave',()=>{if(!stage)return;container.value&&(container.value.style.cursor='');});
   layer.add(hitArea);
   handle.on('dragstart',()=>{if(props.editable)emit('designSelect',i);});
   handle.on('dragend',()=>{suppressDesignClick=true;setTimeout(()=>{suppressDesignClick=false;},0);emit('designSelect',i);emit('designMove',i,{x:handle.x()/100,y:-handle.y()/100});redraw();});layer.add(handle);
   // 序号位置来自统一避让（ordinalPlacement），换算回 world px；
   // 未被放置说明该缩放下放不下，隐藏而不是硬叠上去。
   const ordPlaced=ordinalPlacement.get(i);
   const ordX=ordPlaced?((ordPlaced.sx-stage.x())/scale-8/scale):(x!+(revisit?10:9)/scale);
   const ordY=ordPlaced?((ordPlaced.sy-stage.y())/scale):(y!+(revisit?16:-18)/scale);
   layer.add(new Konva.Text({name:'route-ordinal-'+i,x:ordX,y:ordY,text:String(i+1),fontSize:12/scale,fontFamily:'monospace',fontStyle:selected?'bold':'normal',fill:revisit?stepColor:(selected?color:'#39444f'),listening:false,visible:!!ordPlaced}));
  });
  // 初始车头朝向不再在画布上画琥珀色箭头/拖拽点（已在左侧参数卡里用数值设置）。
 }else if(props.drawing.length) {layer.add(new Konva.Line({points:props.drawing.flatMap(px),stroke:'#2563a6',strokeWidth:2/scale,listening:false}));for(const p of props.drawing){const [x,y]=px(p);layer.add(new Konva.Circle({x,y,radius:4/scale,fill:'#2563a6',listening:false}));}}
 // The live vehicle is a persistent overlay node updated by drawOverlay().
 measurementTags.forEach((t,i)=>{const [x,y]=px(t),radius=Math.max(t.size*100,9/scale)/2+5/scale;
  layer.add(new Konva.Circle({x,y,radius,stroke:'#f7f8f9',strokeWidth:5/scale,listening:false}));
  layer.add(new Konva.Circle({x,y,radius,stroke:i===0?'#2563a6':'#2563a6',strokeWidth:3/scale,listening:false}));
 });
 // 新建二维码的 ghost 预览：只画画布提示（半透明圆 + 小号编号），绝不参与选择/拖动/测距。
 // ghostTags 为空时整段跳过，既有交互语义完全不变。
 if(props.ghostTags?.length){
  // 主锚点（索引 0）可拖动：旧实现整组 listening:false，且没有 dragend 回写，
  // 于是「单点」铺码只能靠左边输入框改坐标，画布上完全拖不动。
  // 现在只让第一个 ghost 可拖（阵列/直线的锚点），其余仍是只读预览，
  // 拖动结束后把新中心回写给面板（App 再改对应输入框），保持单一数据源。
  const ghost=new Konva.Group({name:'ghost-tags'});
  for(const [index,item] of props.ghostTags.entries()){
   if(!Number.isFinite(item.x)||!Number.isFinite(item.y))continue;
   const [gx,gy]=px({x:item.x,y:item.y});
   const radius=ms(14,7);
   const isAnchor=index===0;
   const dot=new Konva.Circle({name:'ghost-tag-'+index,x:gx,y:gy,radius,fill:'rgba(37,99,166,.14)',stroke:'#2563a6',strokeWidth:ms(2,1),dash:[4/scale,3/scale],listening:isAnchor,draggable:isAnchor});
   if(isAnchor){
    // 热区放大，低缩放下也点得中
    dot.hitStrokeWidth(Math.max(6, 18/scale));
    dot.on('mouseenter',()=>{if(container.value)container.value.style.cursor='move';});
    dot.on('mouseleave',()=>{if(container.value)container.value.style.cursor='';});
    dot.on('dragstart',()=>{suppressDesignClick=true;pressMoved=true;});
    dot.on('dragend',()=>{
     swallowNextClick=true;pressMoved=true;
     if(container.value)container.value.style.cursor='';
     // 吸附到已有二维码中心：与「加点」一致的手感，避免落在两码之间导致重叠判定失败
     const snapped=snapRoutePoint({x:dot.x()/100,y:-dot.y()/100},props.map.tags);
     const moved=distance({x:item.x,y:item.y},snapped)>1e-9;
     if(moved)emit('ghostMove',index,snapped);
     redraw();
    });
   }
   ghost.add(dot);
   if(item.id!==undefined&&Number.isFinite(item.id))ghost.add(new Konva.Text({name:'ghost-tag-label-'+index,x:gx-radius,y:gy-radius-11/scale,width:radius*2,align:'center',text:'Q'+String(item.id).padStart(3,'0'),fontSize:10/scale,fontFamily:'monospace',fill:'#2563a6',opacity:.85,listening:false}));
  }
  ghost.setAttr('ghost-count',props.ghostTags.length);
  layer.add(ghost);
  if(container.value)container.value.dataset.konvaGhostTags=String(props.ghostTags.length);
 }else if(container.value)container.value.dataset.konvaGhostTags='0';
 if(measurementPair.length===2){const a=measurementPair[0]!,b=measurementPair[1]!;
  const label=new Konva.Group({name:'measurement-label',x:(a.x+b.x)*50,y:-(a.y+b.y)*50,scaleX:1/scale,scaleY:1/scale,listening:false});
  const text=new Konva.Text({fontFamily:"QR Sans, QR CJK, sans-serif",text:`中心距 ${Math.hypot(b.x-a.x,b.y-a.y).toFixed(3)} m`,fontSize:14,fontStyle:'bold',fill:'#2563a6',padding:8,listening:false});
  label.add(new Konva.Rect({x:-text.width()/2,y:-text.height()/2,width:text.width(),height:text.height(),fill:'#f7f8f9',stroke:'#2563a6',strokeWidth:1,cornerRadius:6,listening:false}));
  text.position({x:-text.width()/2,y:-text.height()/2});label.add(text);layer.add(label);
 }
 layer.draw();
 // Konva 画在 canvas 上，DOM 读不到文字；把「画布实际使用的别名」暴露出来，
 // 让只读核验能证明画布确实用了名称而不是编号。
 if(container.value){
  const aliasPairs:Record<string,string>={};
  for(const tag of props.map.tags){const name=props.tagAliases?.get(tag.id);if(name)aliasPairs[String(tag.id)]=name;}
  container.value.dataset.konvaAliases=JSON.stringify(aliasPairs);
 }
 if(container.value){container.value.dataset.konvaTags=String(props.map.tags.length);container.value.dataset.konvaRouteWaypoints=String(props.tool==='route-design'?(props.routeAnchors??[]).length:0);container.value.dataset.konvaRouteSegments=String((props.map.motionSegments??[]).length);container.value.dataset.konvaRows=String(props.map.rows.length);}
 drawOverlay();
 zoom.value=Math.round(scale*100);

 // ===== 间距标注（必须最后画，才不会被路径图层盖住）=====
 if(props.spacingMode&&props.spacingGaps?.length){
  const byId=new Map(props.map.tags.map(tag=>[tag.id,tag]));
  const active=new Set(props.spacingLine??[]);
  const gapPoints:{fromId:number;toId:number;m:number;x:number;y:number}[]=[];
  for(const gap of props.spacingGaps){
   const a=byId.get(gap.fromId),b=byId.get(gap.toId);
   if(!a||!b)continue;
   if(active.size&&!(active.has(a.id)&&active.has(b.id)))continue;
   const [ax,ay]=px(a),[bx,by]=px(b);
   const mx=(ax+bx)/2,my=(ay+by)/2;
   const label=`${(gap.m*100).toFixed(1)} cm`;
   layer.add(new Konva.Line({points:[ax,ay,bx,by],stroke:'#93c5fd',strokeWidth:1.5/scale,dash:[5/scale,4/scale],listening:false}));
   const g=new Konva.Group({name:`gap-label-${gap.fromId}-${gap.toId}`,x:mx,y:my});
   const text=new Konva.Text({text:label,fontFamily:'QR Sans, QR CJK, sans-serif',fontSize:12/scale,fill:'#1d4ed8',padding:3/scale});
   const w=text.width(),h=text.height();
   g.add(new Konva.Rect({x:-w/2,y:-h/2,width:w,height:h,cornerRadius:4/scale,fill:'#ffffff',stroke:'#93c5fd',strokeWidth:1/scale}));
   text.x(-w/2);text.y(-h/2);g.add(text);
   g.on('mouseenter',()=>{stage.container().style.cursor='text';});
   g.on('mouseleave',()=>{stage.container().style.cursor='';});
   g.on('click tap',e=>{
    e.cancelBubble=true;
    if(consumeClickGuard()||pressMoved)return;
    // getAbsolutePosition 返回的是 stage 内部坐标；就地输入框要用容器像素，
    // 否则会被摆到画布之外（历史缺陷：“很多都到界面外面了”）。
    const abs=g.getAbsolutePosition();
    emit('gapEdit',{fromId:gap.fromId,toId:gap.toId,m:gap.m,
     x:Math.round(abs.x*stage.scaleX()+stage.x()),y:Math.round(abs.y*stage.scaleY()+stage.y())});
   });
   // getAbsolutePosition 返回的是 stage 内部坐标（未乘 stage 的 scale/position），
   // 必须再乘上 stage 变换才是容器内像素坐标，否则点不到。
   const abs=g.getAbsolutePosition();
   const sx=stage.scaleX(),px0=stage.x(),sy=stage.scaleY(),py0=stage.y();
   gapPoints.push({fromId:gap.fromId,toId:gap.toId,m:gap.m,x:Math.round(abs.x*sx+px0),y:Math.round(abs.y*sy+py0)});
   layer.add(g);
  }
  if(container.value)container.value.dataset.gapLabels=JSON.stringify(gapPoints);
 }

}
// Overlay updates never touch the static layer: they only move the persistent vehicle group,
// replace the trail points and batch-draw. Editing therefore keeps its stage view and node identity.
function drawOverlay(){
 if(!isMounted||!overlayLayer||overlayLayer.getStage()!==stage)return;
 const scale=stage.scaleX();
 if(props.trail?.length){
  if(!trailLine){trailLine=new Konva.Line({name:'live-trail',stroke:'#727d88',listening:false});overlayLayer.add(trailLine);}
  trailLine.points(props.trail.flatMap(px));trailLine.strokeWidth(2/scale);
 }else if(trailLine){trailLine.destroy();trailLine=undefined;}
 if(props.vehicle){
  if(!vehicleGroup){
   vehicleGroup=new Konva.Group({name:'live-vehicle',listening:false});
   vehicleBody=new Konva.Rect({name:'live-vehicle-body',listening:false});
   vehicleArrow=new Konva.Arrow({name:'live-vehicle-heading',points:[0,0,0,0],listening:false});
   vehicleGroup.add(vehicleBody,vehicleArrow);overlayLayer.add(vehicleGroup);
  }
  // The live body is drawn at the real vehicle footprint in world metres (0.46 m x 0.36 m) and
  // inherits the stage scale, so zooming in grows it together with the map and zooming out shrinks
  // it. There is no pixel floor and no fixed inflation: the icon can never be painted larger than
  // the vehicle really is. map.vehicle stays the planning/safety envelope and is deliberately not
  // used here, and the length below is a body outline, not a wheelbase or track width.
  const bodyLength=vehicleFootprintM.length*100,bodyWidth=vehicleFootprintM.width*100;
  vehicleGroup.position({x:props.vehicle.x*100,y:-props.vehicle.y*100});
  vehicleGroup.rotation(-props.vehicle.yaw*180/Math.PI);
  // base_link anchor: the outline is centred on the group origin and its long side runs along
  // local +x, i.e. the vehicle's forward axis once the yaw rotation above is applied.
  vehicleBody!.setAttrs({x:-bodyLength/2,y:-bodyWidth/2,width:bodyLength,height:bodyWidth,cornerRadius:bodyWidth*.16,fill:'#2563a6',stroke:'white',strokeWidth:1.5/scale});
  // The heading tick ends inside the outline so the stroke can never inflate the footprint.
  vehicleArrow!.points([0,0,bodyLength*.38,0]);
  vehicleArrow!.setAttrs({stroke:'white',fill:'white',strokeWidth:1.5/scale,pointerWidth:bodyWidth*.18,pointerLength:bodyWidth*.22});
 }else if(vehicleGroup){vehicleGroup.destroy();vehicleGroup=undefined;vehicleBody=undefined;vehicleArrow=undefined;}
 overlayLayer.batchDraw();
 if(container.value){container.value.dataset.konvaVehicle=vehicleGroup?'1':'0';container.value.dataset.konvaVehicleSizeM=vehicleGroup?`${vehicleFootprintM.length}x${vehicleFootprintM.width}`:'';container.value.dataset.konvaTrailPoints=String(props.trail?.length??0);container.value.dataset.konvaOverlayUpdates=String(++overlayUpdates);}
}
// 上一次容器尺寸与视口 scale：resize 判定与 fit 之后都要更新它。
let lastWidth=0,lastHeight=0,lastScale=1;
function syncPanState(){container.value?.setAttribute('data-stage-pos',`${Math.round(stage.x())},${Math.round(stage.y())}`);}
function pointer():Point{const p=stage.getRelativePointerPosition()!;return {x:p.x/100,y:-p.y/100};}
// fit 的三种触发源与「不允许触发」的场景：
// 1. 首次挂载、切换地图(props.map.id)、显式 props.fitRequest 变化；
// 2. 手动点「适应地图」按钮（走 fitView('tags-and-route')）。
// 平移/缩放/选中/消息变化/路径锚点增删都**不**复位视角——
// 旧实现把 watch(props.map.id) 之外的任何变化都不 fit，但 fit() 本身把 zone 也算进去，
// 于是 zone 很大的手动地图被压到 14%。现在包围盒只取真实点位（见 useCanvasFit）。
function fitView(mode:FitMode=props.fitMode??'tags-and-route'){
 if(!isMounted||!stage)return null;
 syncPanState();
 const anchors=props.routeAnchors??(props.tool==='route-design'?props.drawing:[]);
 const result=computeFitBounds({
  tags:props.map.tags.map(tag=>({x:tag.x,y:tag.y})),
  anchors:anchors.map(p=>({x:p.x,y:p.y})),
  zone:props.map.zone.map(p=>({x:p.x,y:p.y})),
  mode,
  paddingRatio:DEFAULT_PADDING_RATIO,
 });
 if(!result){
  // 有效点不足 2 个：保持当前视角，绝不算出 0 尺寸的视口。
  if(container.value){container.value.dataset.canvasFitMode=mode;container.value.dataset.canvasFitScale=String(stage.scaleX());}
  return null;
 }
 const transform=fitTransform(result.bounds,{width:stage.width(),height:stage.height()});
 stage.scale({x:transform.scale,y:transform.scale});
 stage.position({x:transform.x,y:transform.y});
 if(container.value){
  container.value.dataset.canvasFitMode=result.mode;
  container.value.dataset.canvasFitScale=String(Number(transform.scale.toFixed(6)));
  container.value.dataset.canvasFitPoints=String(result.usedPoints);
  container.value.dataset.canvasFitOutliers=String(result.excludedOutliers);
  container.value.dataset.canvasFitDegenerate=result.degenerate?'1':'0';
 }
 redraw();
 lastScale=stage.scaleX()||1;
 return result;
}
// 兼容既有 defineExpose({fit}) 与模板里「适应地图」按钮：默认走 tags-and-route。
function fit(){fitView(props.fitMode??'tags-and-route');}
function scaleBy(factor:number,center?:Point){if(!isMounted||!stage)return;center??={x:stage.width()/2,y:stage.height()/2};const old=stage.scaleX(),next=Math.max(0.08,Math.min(8,old*factor));const point={x:(center.x-stage.x())/old,y:(center.y-stage.y())/old};stage.scale({x:next,y:next});stage.position({x:center.x-point.x*next,y:center.y-point.y*next});syncPanState();redraw();}
onMounted(()=>{
 stage=new Konva.Stage({container:container.value!,width:container.value!.clientWidth,height:container.value!.clientHeight,draggable:false});
 exposeStageForTests(stage);
 layer=new Konva.Layer();overlayLayer=new Konva.Layer();stage.add(layer);stage.add(overlayLayer);isMounted=true;refreshMode();
 // A3：吸附遥测属性一开始就存在（空值），回归脚本无需等待第一次拖动。
 container.value?.setAttribute('data-canvas-snap','');
 container.value?.setAttribute('data-canvas-snap-blocked','');
 (window as any).__mapCanvasApi={screenOfTag,worldToClient,clientToWorld,tagStyle};
 stage.on('wheel',e=>{e.evt.preventDefault();e.evt.stopPropagation();if(e.evt.ctrlKey||e.evt.metaKey)scaleBy(e.evt.deltaY>0?0.9:1.1,stage.getPointerPosition()!);});
 // 平移绝不抢在指针真正移动之前发生：单击任何时候都不翻译 stage，也不进入 pan 状态。
 // 只有 canvasMode==='pan'|'measure'（tool==='pan' / 空格 / 中键 / measure / 路径编辑的平移工具）
 // 才会登记一个「候选平移」，并且必须越过 PAN_THRESHOLD_PX 才真正开始平移。
 // 平移本身用手工 translate stage 完成（stage.draggable 恒为 false），
 // 因此 Konva 不会在 mousedown 就进入拖拽并吃掉后续 click。
 // 注意：props.panEnabled 只在 resolveMode()/空格处理器里给「空格、中键」这种显式手势发许可，
 // 它本身永远不会让普通左键变成平移。
 stage.on('mousedown touchstart',e=>{
  const evt=e.evt as MouseEvent;const touch=evt.type==='touchstart';
  const middle=!touch&&(evt.button===1||evt.buttons===4);
  const left=touch||evt.button===0||evt.buttons===1;
  // 新手势开始：清掉上一手势遗留的点击守卫（上一手势的尾随 click 已派发完毕）。
  pressMoved=false;panMoved=false;panActive=false;pressOrigin=null;panOrigin=null;swallowNextClick=false;
  if(middle&&props.panEnabled===true)middleHeld=true;
  refreshMode();
  if(!left&&!middle){refreshMode();return;}
  const mode=canvasMode.value;
  // 决策（写死，二选一已选定「严格版」）：只有 canvasMode==='pan'|'measure' 才允许平移，
  // 也就是 tool==='pan'、measure、空格、中键、以及路径编辑里点了「平移」工具
  // （App 用 editable=false + tool='route-design' 表达）。props.panEnabled 不单独触发平移，
  // 它只是空格/中键与「平移工具」的必要许可位。因此任何选择/加点态的左键都不会平移。
  // 任何模式都要记录按下点：否则「加点态拖动」会被当成一次干净的单击而误加路点。
  // 这里只负责区分点击/拖动，真正是否平移仍由 mode 决定（见下面 panOrigin）。
  const pointerAtPress=stage.getPointerPosition();
  if(pointerAtPress)pressOrigin={x:pointerAtPress.x,y:pointerAtPress.y};
  // 连线进行中：任何按下都只服务于连线，不进入框选/平移。
  if(linkState.value.phase!=='idle')return;
  // 选择态 + 空白处按下 → 候选框选。真正的框要等移动超过阈值才画，
  // 否则每次单击都会闪一个零尺寸矩形。
  // 框选是编辑动作：非编辑态（例如「开始导航」只读查看）不允许拖出选择框。
 if(mode==='select'&&props.editable&&e.target===(stage as unknown as Konva.Node)&&left&&pointerAtPress){
   boxOrigin=pointer();
   boxCurrent={...boxOrigin};
   boxActive=false;
   boxGestureOpen=true;
   return;
  }
  if(mode!=='pan'&&mode!=='measure')return;
  // 可拖动节点（二维码/路点）自己处理拖拽，不能同时平移画布。
  const target=e.target as unknown as {draggable?:()=>boolean};
  // 平移态：即使按在二维码上也应该平移画布，不能因为它是可拖动节点就提前返回。
  if(mode!=='pan'&&e.target!==(stage as unknown as Konva.Node)&&target.draggable?.())return;
  if(middle)evt.preventDefault?.();
  const p=stage.getPointerPosition()!;
  panOrigin={x:p.x,y:p.y};
 });
 stage.on('mousemove touchmove',()=>{
  const p0=stage.getPointerPosition();
  if(pressOrigin&&p0&&Math.hypot(p0.x-pressOrigin.x,p0.y-pressOrigin.y)>PAN_THRESHOLD_PX)pressMoved=true;
  if(panOrigin&&p0){
   const dx=p0.x-panOrigin.x,dy=p0.y-panOrigin.y;
   if(!panActive&&Math.hypot(dx,dy)>PAN_THRESHOLD_PX){
    panActive=true;panMoved=true;pressMoved=true;
    container.value?.classList.add('is-dragging');
    container.value?.setAttribute('data-canvas-panning','1');
   }
   if(panActive){stage.position({x:stage.x()+dx,y:stage.y()+dy});panOrigin={x:p0.x,y:p0.y};syncPanState();redraw();}
  }
  const p=pointer();coordinate.value=`X ${p.x.toFixed(2)} · Y ${p.y.toFixed(2)} m`;
  // 框选：屏幕坐标算矩形，地图坐标算命中，两者都用同一个 scale/offset 换算。
  if(boxOrigin){
   const current=pointer();
   // 阈值 3 屏幕像素换算成米，避免不同缩放下「轻轻一抖就变成框选」。
   const threshold=3/Math.max(stage.scaleX()||1,1e-6)/100;
   if(!boxActive&&Math.hypot(current.x-boxOrigin.x,current.y-boxOrigin.y)>threshold)boxActive=true;
   if(boxActive){boxCurrent=current;drawBox();}
  }
  if(linkState.value.phase!=='idle'){
   linkPointer.value={x:p.x,y:p.y};
   const nearest=props.map.tags.filter(tag=>distance(tag,p)<=.04).sort((a,b)=>distance(a,p)-distance(b,p))[0];
   linkState.value=previewLink(linkState.value,nearest?nearest.id:null);
   drawLinkPreview();
   syncLinkDataset();
  }
  if(props.tool==='route-design'&&hoverMarker){const nearest=props.map.tags.filter(t=>distance(t,p)<=.04).sort((a,b)=>distance(a,p)-distance(b,p))[0];hoverMarker.visible(!!nearest);if(nearest)hoverMarker.position({x:nearest.x*100,y:-nearest.y*100});layer.batchDraw();}
 });
 stage.on('mouseup touchend touchcancel',()=>{
  if(panActive){panMoved=true;swallowNextClick=true;}
  // 提交框选：只在真的拖出了矩形时 emit。旧实现把「清状态」和「销毁矩形」分在两条分支里，
  // boxActive 为 false 而矩形节点已存在时会漏掉 destroy，矩形就留在画布上。
  // 现在两条路径都走同一个收尾函数，矩形一定会被销毁。
  endBoxDrag(boxActive&&boxOrigin!==null&&boxCurrent!==null);
  pressOrigin=null;panOrigin=null;panActive=false;middleHeld=false;
  container.value?.classList.remove('is-dragging');
  container.value?.removeAttribute('data-canvas-panning');
  refreshMode();
  // Konva 里 stage 的 mouseup 先于 click 派发。这里用 0ms 宏任务复位拖动标记：
  // 既保证本次手势的尾随 click 一定被吞掉（不新增路点/不误选），
  // 又保证松手后立刻点选立即恢复正常。
  setTimeout(()=>{pressMoved=false;panMoved=false;swallowNextClick=false;pressOrigin=null;},0);
 });
 stage.on('click tap',e=>{
  const guarded=consumeClickGuard(),moved=panMoved||pressMoved;
  panMoved=false;pressMoved=false;pressOrigin=null;
  if(guarded||moved)return;
  // 连线：空白处单击取消当前连线（与图形编辑器一致）。
  // 点码的路径在 tag 组自己的处理器里（见 handleConnectClick）。
  if(props.tool==='connect'){
   if(linkState.value.phase!=='idle'){linkState.value=cancelLink();linkPointer.value=null;drawLinkPreview();syncLinkDataset();}
   return;
  }
  // 只有「加点」态（route-design + drawMode）或旧的 row 绘制工具才把空白单击当成新增路点；
  // 选择/调整/平移态的空白单击既不平移、也不产生路点。
  const addsOnBlank=props.tool==='route-design'?!!props.drawMode:props.tool==='row';
  // 点击空白永远通知父组件：加点模式用于追加路点，选择模式用于取消选中。
  if(e.target===stage&&props.editable&&!suppressDesignClick){
   flushPendingClick();
   if(addsOnBlank)emit('blank',pointer());
   else emit('blank',pointer());
  }
 });
 // 双击兜底：即使子节点在两次点击之间被重绘销毁，也能在 stage 上命中最近的定位码
 stage.on('dblclick dbltap',()=>{
  if(pendingClick){clearTimeout(pendingClick.timer);pendingClick=null;}
  const pt=pointer();
  const nearest=props.map.tags.filter(tag=>distance(tag,pt)<=.08).sort((a,b)=>distance(a,pt)-distance(b,pt))[0];
  if(nearest)emit('tagDetail',nearest.id);
 });
 window.addEventListener('blur',resetPointerState);
 bindBoxReleaseFallbacks();
 // 空格 = 显式平移意图（还需 props.panEnabled 给权限）；只改交互模式，不重绘图层。
 window.addEventListener('keydown',onKeyDown);
 window.addEventListener('keyup',onKeyUp);
 // 记录上一次容器尺寸与视口，用于判断「是刚进入编辑（宽高比剧变）还是普通拖分隔条」。
 observer=new ResizeObserver(()=>{
  if(!isMounted||!container.value)return;
  const width=container.value.clientWidth,height=container.value.clientHeight;
  if(!width||!height)return;
  const previousWidth=lastWidth||stage.width(),previousHeight=lastHeight||stage.height();
  const previousScale=lastScale||stage.scaleX()||1;
  lastWidth=width;lastHeight=height;
  stage.size({width,height});
  // 尺寸变化很小时（拖入点位、提示条出现、面板微调）绝不重算 stage.position：
  // 重算会按「内容中心不动」把整个画布平移几像素到几十像素，
  // 用户看到的就是「拖进去的点不在松手的位置」。只更新尺寸、保持视角。
  const shrink=Math.abs(width-previousWidth)<=16&&Math.abs(height-previousHeight)<=16;
  if(shrink){
   lastScale=stage.scaleX()||1;
   redraw();
   syncPanState();
   return;
  }
  // 内容中心（世界坐标）在尺寸变化前后保持不动：否则会「视角自己跑偏」。
  const worldCenterX=(previousWidth/2-stage.x())/previousScale;
  const worldCenterY=(previousHeight/2-stage.y())/previousScale;
  stage.position({x:width/2-worldCenterX*previousScale,y:height/2-worldCenterY*previousScale});
  lastScale=stage.scaleX()||1;
  redraw();
  // 宽高比变化超过 25% 视为「布局模式切换」（进入/退出路径编辑、面板折叠），
  // 这时按新的可视区重新取景；普通拖拽分隔条（比例变化很小）不动视角。
  const previousRatio=previousWidth/Math.max(previousHeight,1);
  const ratio=width/Math.max(height,1);
  if(Math.abs(ratio-previousRatio)/Math.max(previousRatio,1e-6)>0.25)fit();
  syncPanState();
 });
 observer.observe(container.value!);fit();void document.fonts.ready.then(redraw);
});
// 注意：框选/多选只改变 props.selected，几何没变。
// 旧实现把它也当重建信号，于是「拖走一个点后再框选整组」会用父组件尚未回写的
// 旧坐标重建节点，被拖走的点看起来弹回原位。选中态只刷新高亮，不重建几何。
watch(()=>[props.map,props.rowId,props.drawing,props.measurement,props.routeAnchors,props.routeSelected,props.routeGroupIds,props.routeSkippedGroups,props.initialHeading,props.editable,props.segmentPlans,props.selectedSegment,props.spacingMode,props.spacingLine,props.spacingGaps,props.ghostTags,props.tagEditing,props.tagAliases],redraw,{deep:true});
/** 选中高亮只改现有节点的样式，不重建几何。
 *  重建会用父组件里尚未回写的旧坐标覆盖刚拖动的节点（看起来像「弹回原位」），
 *  所以 props.selected 不在 redraw watcher 里；但只 batchDraw() 又不会重新计算
 *  fill/stroke，结果就是「选中了却没有高亮」。这里按当前选中集合原地重刷样式。 */
function syncTagSelection(){
 if(!isMounted||!layer||layer.getStage()!==stage)return;
 for(const t of props.map.tags){
  const group=layer.findOne('#tag-node-'+t.id) as Konva.Group|null;
  if(!group)continue;
  const selected=props.selected.includes(t.id)||(props.tool==='route-design'&&!!props.routeGroupIds?.includes(t.id));
  const skipped=props.tool==='route-design'&&!!props.routeSkippedGroups?.some(tag=>tag.id===t.id);
  const body=group.findOne('.tag-body-'+t.id) as Konva.Rect|null;
  if(body){
   body.fill(skipped?'#d97706':selected?'#2563a6':t.kind==='end'?'#2563a6':'#39444f');
   body.stroke(selected?'#c9d0d7':'white');
  }
  const label=group.findOne('.tag-label-'+t.id) as Konva.Text|null;
  if(label){
   label.fill(skipped?'#d97706':selected?'#2563a6':(props.tool==='route-design'?'#9aa6b2':'#56616d'));
   label.opacity(props.tool==='route-design'&&!selected&&!skipped?0.55:1);
  }
 }
 layer.batchDraw();
}
watch(()=>props.selected,()=>{syncTagSelection();},{deep:true});
// Telemetry-only props never rebuild the static/interactive layer; they only refresh the overlay.
watch(()=>[props.vehicle?.x,props.vehicle?.y,props.vehicle?.yaw],drawOverlay);
watch(()=>props.trail,drawOverlay,{deep:true});
// tool / panEnabled / editable / tagEditing 只改交互模式，不重建图层（重建会打断拖拽）。
watch(()=>[props.tool,props.panEnabled,props.editable,props.tagEditing,props.panMode],refreshMode);
// route-design 的图层内容依赖 tool，切换工具时要重绘一次（保持原有行为）。
watch(()=>props.tool,()=>{
 if(isMounted)redraw();
 // 切走连接工具时必须清空连线状态：否则切回来会带着一条看不见的起点，
 // 用户点一下就被当成「连第二个码」。
 if(props.tool!=='connect'&&linkState.value.phase!=='idle'){
  linkState.value=cancelLink();linkPointer.value=null;syncLinkDataset();
 }
});
// drawMode 单独处理：它决定路点手柄建出来时是否 draggable，也决定空白单击是否加点。
// 只 refreshMode 不重建图层的话，从「加点」切回「选择」后手柄永远是拖不动的，
// 现场看到的就是“路点突然拖不动了、也没法改动作”。
watch(()=>props.drawMode,()=>{if(!isMounted)return;refreshMode();redraw();});
// 进入编辑 / 切换地图 / 显式 fitRequest：这三种情况才复位视角。
// 注意**不要**把 props.selected / selectedSegment / drawing / message 之类放进来：
// 用户平移、缩放、选中、消息变化都不得复位视角（旧实现就是这样把视角顶回去的）。
watch(()=>props.map.id,()=>fit());
watch(()=>props.fitRequest,value=>{if(value===undefined)return;fit();});
// fitMode 变化只影响下一次 fit 的目标，不立刻动视角（避免中途抖一下）。
watch(()=>props.fitMode,()=>{if(container.value)container.value.dataset.canvasFitMode=props.fitMode??'tags-and-route';});
// 进入路径编辑（tool 切到 route-design）时按标签+路径重新取景一次：这是用户「进入编辑」的时机。
watch(()=>props.tool,(tool,previous)=>{
 if(!isMounted)return;
 if(tool==='route-design'&&previous!==undefined&&previous!=='route-design')fit();
});
onBeforeUnmount(()=>{isMounted=false;delete (window as any).__mapCanvasApi;unbindBoxReleaseFallbacks();window.removeEventListener('blur',resetPointerState);window.removeEventListener('keydown',onKeyDown);window.removeEventListener('keyup',onKeyUp);document.removeEventListener('keydown',onKeyDown);document.removeEventListener('keyup',onKeyUp);resetPointerState();observer?.disconnect();stage?.off();stage?.destroy();});
/** 屏幕坐标 -> 地图米坐标：供「从左侧工具拖入画布」落点换算。 */
function clientToWorld(clientX:number,clientY:number):Point|null{
 if(!stage||!container.value)return null;
 const rect=container.value.getBoundingClientRect();
 if(!rect.width||!rect.height)return null;
 const scale=stage.scaleX()||1;
 const sx=clientX-rect.left,sy=clientY-rect.top;
 return {x:(sx-stage.x())/scale/100,y:-(sy-stage.y())/scale/100};
}
function worldToClient(point:Point){
 if(!stage)return null;
 const box=stage.container().getBoundingClientRect();
 const scaleX=stage.scaleX()||1,scaleY=stage.scaleY()||1;
 return {x:box.left+stage.x()+point.x*100*scaleX,y:box.top+stage.y()-point.y*100*scaleY};
}
/** 真实渲染节点的当前样式（高亮断言用；读的就是 Konva 节点本身）。 */
function tagStyle(id:number){
 if(!stage)return null;
 const group=layer?.findOne('#tag-node-'+id) as Konva.Group|null;
 if(!group)return null;
 const body=group.findOne('.tag-body-'+id) as Konva.Rect|null;
 const label=group.findOne('.tag-label-'+id) as Konva.Text|null;
 return {fill:body?String(body.fill()):null,stroke:body?String(body.stroke()):null,labelFill:label?String(label.fill()):null};
}
/** 真实渲染节点在页面里的中心点：测试与浮窗定位都用它，不允许估算。 */
function screenOfTag(id:number){
 if(!stage)return null;
 const node=layer?.findOne('#tag-node-'+id) as Konva.Group|null;
 if(!node)return null;
 const abs=node.getAbsolutePosition();
 const box=stage.container().getBoundingClientRect();
 return {x:box.left+abs.x,y:box.top+abs.y};
}
defineExpose({fit,fitView,clientToWorld,worldToClient,screenOfTag,tagStyle});
</script>
<template><div :class="['canvas-wrap',{'pan-mode':canvasMode==='pan'}]"><div ref="container" class="map-container" data-testid="map-canvas" data-drop-surface="1" :data-canvas-box-select-count="boxCount===null?undefined:String(boxCount)" :data-canvas-link-state="linkState.phase" :data-canvas-link-from="linkState.fromId??''" :data-canvas-fit-mode="fitMode??'tags-and-route'" :data-canvas-mode="canvasMode" :data-canvas-tool="tool" :data-canvas-editable="editable?'1':'0'" :data-canvas-draw-mode="drawMode?'1':'0'" :data-canvas-pan-enabled="panEnabled?'1':'0'" :data-canvas-tag-editing="tagEditing?'1':'0'" :data-canvas-pan-mode="panMode==='pan'?'1':panMode==='select'?'0':undefined" :data-canvas-mode-label="modeLabel" :data-canvas-selected="selected.join(',')" :data-route-selected="routeSelected??-1" :data-route-waypoints="(routeAnchors??[]).length" :data-route-group-ids="tool==='route-design'?routeGroupIds?.join(','):undefined" :data-skipped-route-group-ids="tool==='route-design'?routeSkippedGroups?.map(tag=>tag.id).join(','):undefined"/><slot/><div class="canvas-caption"><span class="dot"></span> 单位 m</div><div class="canvas-controls"><Button variant="outline" size="icon" aria-label="放大地图" @click="scaleBy(1.2)"><Plus :size="16"/></Button><Button variant="outline" size="icon" aria-label="缩小地图" @click="scaleBy(0.8)"><Minus :size="16"/></Button><Button variant="outline" size="icon" aria-label="适应地图" @click="fit"><Scan :size="16"/></Button></div><div class="canvas-footer"><span>{{coordinate}}</span><span>{{zoom}}%</span></div><div v-if="tool==='row'" class="draw-hint"><MousePointer2 :size="14"/> 点击画布添加路线控制点，再点击“完成绘制”</div></div></template>

<style scoped>
.draw-hint{position:absolute;left:14px;bottom:56px;max-width:calc(100% - 90px);display:flex;align-items:center;gap:6px;padding:5px 9px;background:rgba(248,250,252,.94);border:0;border-radius:8px;box-shadow:0 1px 3px rgba(15,23,42,.07);color:var(--muted);font-size:12px;line-height:1.5;pointer-events:none}.draw-hint svg{flex-shrink:0}
</style>
