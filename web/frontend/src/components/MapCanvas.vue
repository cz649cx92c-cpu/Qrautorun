<script setup lang="ts">
import Konva from 'konva';
import {computed,onMounted,onBeforeUnmount,ref,watch} from 'vue';
import type {FieldMap,Point} from '../../../shared/model';
import {exitPoint,heading,distance,orderedTagsById,vehicleFootprintM} from '../../../shared/model';
import {orthogonalRoute,snapRoutePoint,chainRouteGroups,routeGroupCenters} from '../../../shared/route-design';
import {orderMotionSegmentsByChain} from '../../../shared/route';
import {planStrategies,choicesFromSegments,degrees,type SegmentPlan} from '../../../shared/segment-strategy';
import {Plus,Minus,Scan,MousePointer2} from 'lucide-vue-next';
import Button from './ui/Button.vue';
const props=defineProps<{map:FieldMap,selected:number[],rowId:string,tool:string,editable:boolean,drawing:Point[],panEnabled?:boolean,measurement?:number[],vehicle?:{x:number,y:number,yaw:number},trail?:Point[],routeAnchors?:Point[],routeSelected?:number,routeGroupIds?:number[],routeSkippedGroups?:{id:number,distanceM:number}[],routeName?:string,segmentPlans?:SegmentPlan[],selectedSegment?:string,initialHeading?:number,drawMode?:boolean,spacingMode?:boolean,spacingLine?:number[],spacingGaps?:{fromId:number;toId:number;m:number}[]}>();
const emit=defineEmits<{select:[id:number,multi:boolean],inspect:[id:number],segmentSelect:[key:string],row:[id:string],blank:[point:Point],move:[ids:number[],dx:number,dy:number],point:[rowId:string,index:number,point:Point],zone:[index:number,point:Point],designSelect:[index:number],designMove:[index:number,point:Point],heading:[value:number],tagDetail:[id:number],gapEdit:[payload:{fromId:number;toId:number;m:number;x:number;y:number}],gapHover:[payload:{fromId:number;toId:number}|null]}>();
const container=ref<HTMLDivElement>();let stage:Konva.Stage;let layer:Konva.Layer;let overlayLayer:Konva.Layer;let observer:ResizeObserver;let isMounted=false;const coordinate=ref('X 0.00 · Y 0.00 m'),zoom=ref(100);
// Live telemetry (vehicle/trail) lives on a persistent overlay layer. The static layer below it
// owns every interactive node (QR groups, waypoint/handle/heading knobs) and is only rebuilt for
// real map/editing changes, so continuous pose updates can never cancel a click or a drag.
let vehicleGroup:Konva.Group|undefined,vehicleBody:Konva.Rect|undefined,vehicleArrow:Konva.Arrow|undefined,trailLine:Konva.Line|undefined;
let staticBuilds=0,overlayUpdates=0;
const px=(p:Point)=>[p.x*100,-p.y*100];
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
function resolveMode():CanvasMode{
 if(props.tool==='measure')return 'measure';
 if(props.tool==='pan')return 'pan';
 if((spaceHeld||middleHeld)&&props.panEnabled===true)return 'pan';
 // 兼容路径编辑的「平移」按钮：App 只把 editable 置 false，tool 仍是 route-design。
 if(props.tool==='route-design'&&props.panEnabled===true&&!props.editable)return 'pan';
 // 「选择/调整」态（含 route-design 的选择/加点态）恒为 select：左键永不平移。
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
function resetPointerState(){spaceHeld=false;middleHeld=false;suppressDesignClick=false;pressOrigin=null;panOrigin=null;panActive=false;panMoved=false;pressMoved=false;swallowNextClick=false;container.value?.classList.remove('is-dragging');refreshMode();}
function redraw() {
 // Font readiness and queued resize callbacks can run after Konva destroys its stage.
 if(!isMounted||!layer||layer.getStage()!==stage)return;layer.destroyChildren();
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
  const line=new Konva.Line({points:route.flatMap(px),stroke:row.id===props.rowId?'#c9d0d7':'#eef1f4',strokeWidth:office?8/scale:row.width*100,lineCap:'butt',hitStrokeWidth:row.width*100});line.on('click tap',()=>{if(props.tool==='select')emit('row',row.id);else if(props.editable&&props.tool!=='measure')emit('blank',pointer());});layer.add(line);
  layer.add(new Konva.Line({points:route.flatMap(px),stroke:row.id===props.rowId?'#2563a6':'#727d88',strokeWidth:1.8/scale,dash:[6/scale,4/scale],listening:false}));
  const e=exitPoint(row);if(!office)layer.add(new Konva.Line({points:[...px(e),...px(row.points[0]!)],stroke:'#2563a6',strokeWidth:2/scale,dash:[5/scale,4/scale],listening:false}));
  const mid=row.points[Math.floor(row.points.length/2)]!;layer.add(new Konva.Text({fontFamily:"QR Sans, QR CJK, sans-serif",x:mid.x*100+12/scale,y:-mid.y*100-26/scale,text:row.name,fontSize:16/scale,fill:'#56616d',listening:false}));
  if(props.editable&&props.tool!=='measure'&&props.rowId===row.id)row.points.forEach((p,i)=>{const [x,y]=px(p),handle=new Konva.Circle({x,y,radius:5/scale,fill:'#f7f8f9',stroke:'#2563a6',strokeWidth:2/scale,draggable:true});handle.on('dragend',()=>emit('point',row.id,i,{x:handle.x()/100,y:-handle.y()/100}));layer.add(handle);});
 }
 const stored=orderMotionSegmentsByChain(props.map.motionSegments??[]);
 for(const [i,segment] of stored.entries()){
  if(!segment.points?.length)continue;
  const color=segment.mode==='crab'?'#2563a6':'#2563a6',p=segment.points[Math.floor(segment.points.length/2)]!;
  layer.add(new Konva.Line({name:`segment-${segment.id}`,points:segment.points.flatMap(px),stroke:color,strokeWidth:3/scale,listening:false}));
  layer.add(new Konva.Text({name:`segment-label-${segment.id}`,fontFamily:'QR Sans, QR CJK, sans-serif',x:p.x*100+8/scale,y:-p.y*100+8/scale,text:(i+1)+' · '+(segment.mode==='crab'?'平移':segment.direction==='reverse'?'4T4D 倒车':'4T4D 前进'),fontSize:13/scale,fill:color,listening:false}));
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
 for(const t of orderedTagsById(props.map.tags)){const selected=props.selected.includes(t.id)||(props.tool==='route-design'&&!!props.routeGroupIds?.includes(t.id)),[x,y]=px(t);const group=new Konva.Group({name:'tag-'+t.id,x,y,draggable:props.editable&&props.tool==='select'});
  const skipped=props.tool==='route-design'&&props.routeSkippedGroups?.some(tag=>tag.id===t.id);
  const size=ms(t.size*100,5);group.add(new Konva.Rect({x:-size/2,y:-size/2,width:size,height:size,cornerRadius:ms(2,1.2),fill:skipped?'#d97706':selected?'#2563a6':t.kind==='end'?'#2563a6':'#39444f',stroke:selected?'#c9d0d7':'white',strokeWidth:ms(2,1)}));
   if(props.tool==='route-design'){const hit=Math.max(size,32/scale);group.add(new Konva.Rect({x:-hit/2,y:-hit/2,width:hit,height:hit,fill:'transparent',listening:true}));group.setAttr('aria-label',`二维码 Q${String(t.id).padStart(3,'0')}${t.groupId?`，定位组 ${t.groupId}`:''}`);}
  // 编辑路径时只标注与路线相关的码（途经/偏离/选中），其余码不写名字：
  // 码密时满屏 B1xx 会盖住路径本身。扫描/导航页仍全部标注。
  // 路径编辑时同样标注全部定位组（淡色小字），否则满屏方块无法分辨该连哪一个点；
  // 被选中/偏离的点仍用醒目颜色，路径本身画在最上层不会被遮挡。
  group.add(new Konva.Text({fontFamily:"QR Sans, QR CJK, sans-serif",x:-40/scale,y:(props.tool==='route-design'?12:14)/scale,width:80/scale,align:'center',text:t.groupId??`Q${String(t.id).padStart(3,'0')}`,fontSize:(props.tool==='route-design'?12:16)/scale,fill:skipped?'#d97706':selected?'#2563a6':(props.tool==='route-design'?'#9aa6b2':'#56616d'),listening:false,opacity:props.tool==='route-design'&&!selected&&!skipped?.55:1}));
  group.on('click tap',e=>{
   e.cancelBubble=true;
   // 平移/拖动后的尾随 click、或处于平移模式时，二维码既不被选中也不追加路点。
   if(consumeClickGuard()||pressMoved)return;
   // 平移态（空格/中键/平移工具）下单击二维码不选中、也不追加路点。
   if(canvasMode.value==='pan')return;
   if(props.tool!=='route-design'){emit('select',t.id,!!e.evt.shiftKey);return;}
   // 路径编辑：只有「加点」态才追加路点（允许同一码重复经过，如 B064→B080→B016→B080）。
   if(props.drawMode&&props.editable){
    flushPendingClick();emit('inspect',t.id);emit('blank',{x:t.x,y:t.y});return;
   }
   // 只读查看：同一码第二次点击视为双击，显示该码详情。
   if(!props.editable&&pendingClick&&pendingClick.tagId===t.id){
    clearTimeout(pendingClick.timer);pendingClick=null;emit('tagDetail',t.id);return;
   }
   // 「选择/调整」态（含路径编辑的选择工具）：单击 = 选中该码，绝不平移、绝不追加路点。
   flushPendingClick();
   emit('inspect',t.id);
  });
  group.on('dragstart',()=>{suppressDesignClick=true;pressMoved=true;});
  group.on('dragend',()=>{pressMoved=true;swallowNextClick=true;emit('move',selected?props.selected:[t.id],(group.x()-x!)/100,-(group.y()-y!)/100);});layer.add(group);
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
   handle.on('dragend',()=>{suppressDesignClick=true;setTimeout(()=>{suppressDesignClick=false;},0);emit('designMove',i,{x:handle.x()/100,y:-handle.y()/100});redraw();});layer.add(handle);
   layer.add(new Konva.Text({x:x!+(revisit?10:9)/scale,y:y!+(revisit?16:-18)/scale,text:String(i+1),fontSize:12/scale,fontFamily:'monospace',fontStyle:selected?'bold':'normal',fill:revisit?stepColor:(selected?color:'#39444f'),listening:false}));
  });
  // 初始车头朝向不再在画布上画琥珀色箭头/拖拽点（已在左侧参数卡里用数值设置）。
 }else if(props.drawing.length) {layer.add(new Konva.Line({points:props.drawing.flatMap(px),stroke:'#2563a6',strokeWidth:2/scale,listening:false}));for(const p of props.drawing){const [x,y]=px(p);layer.add(new Konva.Circle({x,y,radius:4/scale,fill:'#2563a6',listening:false}));}}
 // The live vehicle is a persistent overlay node updated by drawOverlay().
 measurementTags.forEach((t,i)=>{const [x,y]=px(t),radius=Math.max(t.size*100,9/scale)/2+5/scale;
  layer.add(new Konva.Circle({x,y,radius,stroke:'#f7f8f9',strokeWidth:5/scale,listening:false}));
  layer.add(new Konva.Circle({x,y,radius,stroke:i===0?'#2563a6':'#2563a6',strokeWidth:3/scale,listening:false}));
 });
 if(measurementPair.length===2){const a=measurementPair[0]!,b=measurementPair[1]!;
  const label=new Konva.Group({name:'measurement-label',x:(a.x+b.x)*50,y:-(a.y+b.y)*50,scaleX:1/scale,scaleY:1/scale,listening:false});
  const text=new Konva.Text({fontFamily:"QR Sans, QR CJK, sans-serif",text:`中心距 ${Math.hypot(b.x-a.x,b.y-a.y).toFixed(3)} m`,fontSize:14,fontStyle:'bold',fill:'#2563a6',padding:8,listening:false});
  label.add(new Konva.Rect({x:-text.width()/2,y:-text.height()/2,width:text.width(),height:text.height(),fill:'#f7f8f9',stroke:'#2563a6',strokeWidth:1,cornerRadius:6,listening:false}));
  text.position({x:-text.width()/2,y:-text.height()/2});label.add(text);layer.add(label);
 }
 layer.draw();
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
    const abs=g.getAbsolutePosition();
    emit('gapEdit',{fromId:gap.fromId,toId:gap.toId,m:gap.m,x:abs.x,y:abs.y});
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
function syncPanState(){container.value?.setAttribute('data-stage-pos',`${Math.round(stage.x())},${Math.round(stage.y())}`);}
function pointer():Point{const p=stage.getRelativePointerPosition()!;return {x:p.x/100,y:-p.y/100};}
function fit(){if(!isMounted||!stage)return;syncPanState();const ps=[...props.map.zone,...props.map.rows.flatMap(r=>r.points),...props.map.tags,...(props.tool==='route-design'?props.drawing:[])];if(!ps.length)return;const xs=ps.map(p=>p.x*100),ys=ps.map(p=>-p.y*100),minX=Math.min(...xs),minY=Math.min(...ys),width=Math.max(...xs)-minX,height=Math.max(...ys)-minY;const scale=Math.min((stage.width()-140)/Math.max(width,100),(stage.height()-120)/Math.max(height,100));stage.scale({x:scale,y:scale});stage.position({x:(stage.width()-width*scale)/2-minX*scale,y:(stage.height()-height*scale)/2-minY*scale});redraw();}
function scaleBy(factor:number,center?:Point){if(!isMounted||!stage)return;center??={x:stage.width()/2,y:stage.height()/2};const old=stage.scaleX(),next=Math.max(0.08,Math.min(8,old*factor));const point={x:(center.x-stage.x())/old,y:(center.y-stage.y())/old};stage.scale({x:next,y:next});stage.position({x:center.x-point.x*next,y:center.y-point.y*next});syncPanState();redraw();}
onMounted(()=>{
 stage=new Konva.Stage({container:container.value!,width:container.value!.clientWidth,height:container.value!.clientHeight,draggable:false});
 layer=new Konva.Layer();overlayLayer=new Konva.Layer();stage.add(layer);stage.add(overlayLayer);isMounted=true;refreshMode();
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
  if(mode!=='pan'&&mode!=='measure')return;
  // 可拖动节点（二维码/路点）自己处理拖拽，不能同时平移画布。
  const target=e.target as unknown as {draggable?:()=>boolean};
  if(e.target!==(stage as unknown as Konva.Node)&&target.draggable?.())return;
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
  if(props.tool==='route-design'&&hoverMarker){const nearest=props.map.tags.filter(t=>distance(t,p)<=.04).sort((a,b)=>distance(a,p)-distance(b,p))[0];hoverMarker.visible(!!nearest);if(nearest)hoverMarker.position({x:nearest.x*100,y:-nearest.y*100});layer.batchDraw();}
 });
 stage.on('mouseup touchend touchcancel',()=>{
  if(panActive){panMoved=true;swallowNextClick=true;}
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
  // 只有「加点」态（route-design + drawMode）或旧的 row 绘制工具才把空白单击当成新增路点；
  // 选择/调整/平移态的空白单击既不平移、也不产生路点。
  const addsOnBlank=props.tool==='route-design'?!!props.drawMode:props.tool==='row';
  if(e.target===stage&&props.editable&&addsOnBlank&&!suppressDesignClick){flushPendingClick();emit('blank',pointer());}
 });
 // 双击兜底：即使子节点在两次点击之间被重绘销毁，也能在 stage 上命中最近的定位码
 stage.on('dblclick dbltap',()=>{
  if(pendingClick){clearTimeout(pendingClick.timer);pendingClick=null;}
  const pt=pointer();
  const nearest=props.map.tags.filter(tag=>distance(tag,pt)<=.08).sort((a,b)=>distance(a,pt)-distance(b,pt))[0];
  if(nearest)emit('tagDetail',nearest.id);
 });
 window.addEventListener('blur',resetPointerState);
 // 空格 = 显式平移意图（还需 props.panEnabled 给权限）；只改交互模式，不重绘图层。
 window.addEventListener('keydown',onKeyDown);
 window.addEventListener('keyup',onKeyUp);
 observer=new ResizeObserver(()=>{if(!isMounted||!container.value)return;stage.size({width:container.value.clientWidth,height:container.value.clientHeight});redraw();});
 observer.observe(container.value!);fit();void document.fonts.ready.then(redraw);
});
watch(()=>[props.map,props.selected,props.rowId,props.drawing,props.measurement,props.routeAnchors,props.routeSelected,props.routeGroupIds,props.routeSkippedGroups,props.initialHeading,props.editable,props.segmentPlans,props.selectedSegment,props.spacingMode,props.spacingLine,props.spacingGaps],redraw,{deep:true});
// Telemetry-only props never rebuild the static/interactive layer; they only refresh the overlay.
watch(()=>[props.vehicle?.x,props.vehicle?.y,props.vehicle?.yaw],drawOverlay);
watch(()=>props.trail,drawOverlay,{deep:true});
// tool / panEnabled / editable / drawMode 只改交互模式，不重建图层（重建会打断拖拽）。
watch(()=>[props.tool,props.panEnabled,props.editable,props.drawMode],refreshMode);
// route-design 的图层内容依赖 tool，切换工具时要重绘一次（保持原有行为）。
watch(()=>props.tool,()=>{if(isMounted)redraw();});
watch(()=>props.map.id,fit);
onBeforeUnmount(()=>{isMounted=false;window.removeEventListener('blur',resetPointerState);window.removeEventListener('keydown',onKeyDown);window.removeEventListener('keyup',onKeyUp);document.removeEventListener('keydown',onKeyDown);document.removeEventListener('keyup',onKeyUp);resetPointerState();observer?.disconnect();stage?.off();stage?.destroy();});
defineExpose({fit});
</script>
<template><div :class="['canvas-wrap',{'pan-mode':canvasMode==='pan'}]"><div ref="container" class="map-container" data-testid="map-canvas" :data-canvas-mode="canvasMode" :data-canvas-tool="tool" :data-canvas-editable="editable?'1':'0'" :data-canvas-draw-mode="drawMode?'1':'0'" :data-canvas-pan-enabled="panEnabled?'1':'0'" :data-canvas-selected="selected.join(',')" :data-route-group-ids="tool==='route-design'?routeGroupIds?.join(','):undefined" :data-skipped-route-group-ids="tool==='route-design'?routeSkippedGroups?.map(tag=>tag.id).join(','):undefined"/><div class="canvas-caption"><span class="dot"></span> 单位 m</div><div class="canvas-controls"><Button variant="outline" size="icon" aria-label="放大地图" @click="scaleBy(1.2)"><Plus :size="16"/></Button><Button variant="outline" size="icon" aria-label="缩小地图" @click="scaleBy(0.8)"><Minus :size="16"/></Button><Button variant="outline" size="icon" aria-label="适应地图" @click="fit"><Scan :size="16"/></Button></div><div class="canvas-footer"><span>{{coordinate}}</span><span>{{zoom}}%</span></div><div v-if="tool==='route-design'&&canvasMode!=='pan'" class="draw-hint"><MousePointer2 :size="14"/> {{drawMode?'单击追加路点 · 方块可拖动 · 组中心自动吸附':'单击选中二维码/路点 · 拖动路点调整 · 空格或中键拖动画布'}}</div><div v-if="tool==='route-design'&&canvasMode==='pan'" class="draw-hint pan-hint"><MousePointer2 :size="14"/> 平移模式：按住左键拖动地图 · 单击不改变路径</div><div v-if="tool==='row'" class="draw-hint"><MousePointer2 :size="14"/> 点击画布添加路线控制点，再点击“完成绘制”</div></div></template>

<style scoped>
.draw-hint{position:absolute;left:14px;bottom:56px;max-width:calc(100% - 90px);display:flex;align-items:center;gap:6px;padding:5px 9px;background:rgba(248,250,252,.94);border:0;border-radius:8px;box-shadow:0 1px 3px rgba(15,23,42,.07);color:var(--muted);font-size:12px;line-height:1.5;pointer-events:none}.draw-hint svg{flex-shrink:0}
</style>
