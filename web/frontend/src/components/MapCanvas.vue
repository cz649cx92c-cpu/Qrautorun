<script setup lang="ts">
import Konva from 'konva';
import {onMounted,onBeforeUnmount,ref,watch} from 'vue';
import type {FieldMap,Point} from '../../../shared/model';
import {exitPoint,heading,distance,orderedTagsById,vehicleFootprintM} from '../../../shared/model';
import {orthogonalRoute,snapRoutePoint,chainRouteGroups,routeGroupCenters} from '../../../shared/route-design';
import {orderMotionSegmentsByChain} from '../../../shared/route';
import {planStrategies,choicesFromSegments,degrees,type SegmentPlan} from '../../../shared/segment-strategy';
import {Plus,Minus,Scan,MousePointer2} from 'lucide-vue-next';
import Button from './ui/Button.vue';
const props=defineProps<{map:FieldMap,selected:number[],rowId:string,tool:string,editable:boolean,drawing:Point[],panEnabled?:boolean,measurement?:number[],vehicle?:{x:number,y:number,yaw:number},trail?:Point[],routeAnchors?:Point[],routeSelected?:number,routeGroupIds?:number[],routeSkippedGroups?:{id:number,distanceM:number}[],segmentPlans?:SegmentPlan[],selectedSegment?:string,initialHeading?:number}>();
const emit=defineEmits<{select:[id:number,multi:boolean],inspect:[id:number],segmentSelect:[key:string],row:[id:string],blank:[point:Point],move:[ids:number[],dx:number,dy:number],point:[rowId:string,index:number,point:Point],zone:[index:number,point:Point],designSelect:[index:number],designMove:[index:number,point:Point],heading:[value:number],tagDetail:[id:number]}>();
const container=ref<HTMLDivElement>();let stage:Konva.Stage;let layer:Konva.Layer;let overlayLayer:Konva.Layer;let observer:ResizeObserver;let isMounted=false;const coordinate=ref('X 0.00 · Y 0.00 m'),zoom=ref(100);
// Live telemetry (vehicle/trail) lives on a persistent overlay layer. The static layer below it
// owns every interactive node (QR groups, waypoint/handle/heading knobs) and is only rebuilt for
// real map/editing changes, so continuous pose updates can never cancel a click or a drag.
let vehicleGroup:Konva.Group|undefined,vehicleBody:Konva.Rect|undefined,vehicleArrow:Konva.Arrow|undefined,trailLine:Konva.Line|undefined;
let staticBuilds=0,overlayUpdates=0;
const px=(p:Point)=>[p.x*100,-p.y*100];
let hoverMarker:Konva.Circle|undefined;
let suppressDesignClick=false,stageMoved=false,panGesture=false,spaceHeld=false;
// 二维码单击/双击判别用的挂起定时器
// 定位码单击/双击判别：按 "同一个码 + 230ms 窗口" 判定，避免连点不同码被误判为双击
type PendingClick={x:number,y:number,tagId:number,timer:number};
let pendingClick:PendingClick|null=null;
function flushPendingClick(){if(!pendingClick)return;const {x,y,timer}=pendingClick;pendingClick=null;clearTimeout(timer);emit('blank',{x,y});}
function resetPointerState(){spaceHeld=false;panGesture=false;stageMoved=false;suppressDesignClick=false;container.value?.classList.remove('is-dragging');if(stage)stage.draggable(props.tool==='pan'||props.tool==='measure'||!!props.panEnabled);}
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
  // 编辑路径时只标注与路线相关的码（途经/偏离/选中），其余码不写名字：
  // 码密时满屏 B1xx 会盖住路径本身。扫描/导航页仍全部标注。
  if(props.tool!=='route-design'||selected||skipped)group.add(new Konva.Text({fontFamily:"QR Sans, QR CJK, sans-serif",x:-40/scale,y:14/scale,width:80/scale,align:'center',text:t.groupId??`Q${String(t.id).padStart(3,'0')}`,fontSize:16/scale,fill:skipped?'#d97706':selected?'#2563a6':'#56616d',listening:false}));
  group.on('click tap',e=>{
   e.cancelBubble=true;
   if(props.tool!=='route-design'){emit('select',t.id,!!e.evt.shiftKey);return;}
   if(stageMoved||panGesture||props.panEnabled)return;
   // 同一个码的第二次点击 = 双击：取消落点，改为显示这块码的信息
   if(pendingClick&&pendingClick.tagId===t.id){
    clearTimeout(pendingClick.timer);pendingClick=null;emit('tagDetail',t.id);return;
   }
   // 点到别的码：先把上一个待定点击立刻落点，避免丢点
   flushPendingClick();
   if(props.editable){
    const timer=window.setTimeout(()=>{const pc=pendingClick;pendingClick=null;if(pc){emit('inspect',t.id);emit('blank',{x:pc.x,y:pc.y});}},230);
    pendingClick={x:t.x,y:t.y,tagId:t.id,timer};
   }else emit('inspect',t.id);
  });
  group.on('dragend',()=>emit('move',selected?props.selected:[t.id],(group.x()-x!)/100,-(group.y()-y!)/100));layer.add(group);
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
   const handleSize=ms(selected?16:12,selected?9:7);
   const handle=new Konva.Rect({name:'route-waypoint-'+i,x,y,offsetX:handleSize/2,offsetY:handleSize/2,width:handleSize,height:handleSize,fill:selected?'#ffffff':'#39444f',stroke:color,strokeWidth:selected?ms(3,1.6):ms(2,1),draggable:props.editable});
   handle.on('click tap',e=>{e.cancelBubble=true;if(props.editable)emit('designSelect',i);});
   handle.on('dragmove',()=>{const snapped=snapRoutePoint({x:handle.x()/100,y:-handle.y()/100},props.map.tags);handle.position({x:snapped.x*100,y:-snapped.y*100});const anchors=(props.routeAnchors??[]).map((a,j)=>j===i?snapped:a);updatePreview(orthogonalRoute(anchors));layer.batchDraw();});
   handle.on('dragend',()=>{suppressDesignClick=true;setTimeout(()=>{suppressDesignClick=false;},0);emit('designMove',i,{x:handle.x()/100,y:-handle.y()/100});redraw();});layer.add(handle);
   layer.add(new Konva.Text({x:x!+9/scale,y:y!-18/scale,text:String(i+1),fontSize:12/scale,fontFamily:'monospace',fontStyle:selected?'bold':'normal',fill:selected?color:'#39444f',listening:false}));
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
function pointer():Point{const p=stage.getRelativePointerPosition()!;return {x:p.x/100,y:-p.y/100};}
function fit(){if(!isMounted||!stage)return;const ps=[...props.map.zone,...props.map.rows.flatMap(r=>r.points),...props.map.tags,...(props.tool==='route-design'?props.drawing:[])];if(!ps.length)return;const xs=ps.map(p=>p.x*100),ys=ps.map(p=>-p.y*100),minX=Math.min(...xs),minY=Math.min(...ys),width=Math.max(...xs)-minX,height=Math.max(...ys)-minY;const scale=Math.min((stage.width()-140)/Math.max(width,100),(stage.height()-120)/Math.max(height,100));stage.scale({x:scale,y:scale});stage.position({x:(stage.width()-width*scale)/2-minX*scale,y:(stage.height()-height*scale)/2-minY*scale});redraw();}
function scaleBy(factor:number,center?:Point){if(!isMounted||!stage)return;center??={x:stage.width()/2,y:stage.height()/2};const old=stage.scaleX(),next=Math.max(0.08,Math.min(8,old*factor));const point={x:(center.x-stage.x())/old,y:(center.y-stage.y())/old};stage.scale({x:next,y:next});stage.position({x:center.x-point.x*next,y:center.y-point.y*next});redraw();}
onMounted(()=>{
 stage=new Konva.Stage({container:container.value!,width:container.value!.clientWidth,height:container.value!.clientHeight,draggable:props.tool==='pan'||props.tool==='measure'||!!props.panEnabled});
 layer=new Konva.Layer();overlayLayer=new Konva.Layer();stage.add(layer);stage.add(overlayLayer);isMounted=true;
 stage.on('wheel',e=>{e.evt.preventDefault();e.evt.stopPropagation();if(e.evt.ctrlKey||e.evt.metaKey)scaleBy(e.evt.deltaY>0?0.9:1.1,stage.getPointerPosition()!);});
 stage.on('mousedown touchstart',e=>{
  const evt=e.evt as MouseEvent;const middle=evt.button===1||evt.buttons===4;
  const requested=props.tool==='pan'||props.tool==='measure'||!!props.panEnabled||spaceHeld||middle;
  if(!requested&&e.target!==stage)return;
  panGesture=requested;
  if(panGesture){evt.preventDefault();suppressDesignClick=true;stage.draggable(true);if(e.target!==stage)e.target.stopDrag?.();stage.startDrag();}
  else stage.draggable(false);
 });
 stage.on('dragstart',e=>{if(e.target===stage){stageMoved=false;container.value?.classList.add('is-dragging');}});
 stage.on('dragmove',e=>{if(e.target===stage)stageMoved=true;});
 stage.on('dragend',e=>{if(e.target===stage){stageMoved=true;container.value?.classList.remove('is-dragging');redraw();setTimeout(resetPointerState,0);}});
 stage.on('mouseup touchend',()=>container.value?.classList.remove('is-dragging'));
 stage.on('mousemove',()=>{
  const p=pointer();coordinate.value=`X ${p.x.toFixed(2)} · Y ${p.y.toFixed(2)} m`;
  if(props.tool==='route-design'&&hoverMarker){const nearest=props.map.tags.filter(t=>distance(t,p)<=.04).sort((a,b)=>distance(a,p)-distance(b,p))[0];hoverMarker.visible(!!nearest);if(nearest)hoverMarker.position({x:nearest.x*100,y:-nearest.y*100});layer.batchDraw();}
 });
 stage.on('click tap',e=>{if(stageMoved||panGesture){stageMoved=false;return;}if(e.target===stage&&props.editable&&!suppressDesignClick){flushPendingClick();emit('blank',pointer());}});
 // 双击兜底：即使子节点在两次点击之间被重绘销毁，也能在 stage 上命中最近的定位码
 stage.on('dblclick dbltap',()=>{
  if(pendingClick){clearTimeout(pendingClick.timer);pendingClick=null;}
  const pt=pointer();
  const nearest=props.map.tags.filter(tag=>distance(tag,pt)<=.08).sort((a,b)=>distance(a,pt)-distance(b,pt))[0];
  if(nearest)emit('tagDetail',nearest.id);
 });
 window.addEventListener('blur',resetPointerState);
 observer=new ResizeObserver(()=>{if(!isMounted||!container.value)return;stage.size({width:container.value.clientWidth,height:container.value.clientHeight});redraw();});
 observer.observe(container.value!);fit();void document.fonts.ready.then(redraw);
});
watch(()=>[props.map,props.selected,props.rowId,props.drawing,props.measurement,props.routeAnchors,props.routeSelected,props.routeGroupIds,props.routeSkippedGroups,props.initialHeading,props.editable,props.segmentPlans,props.selectedSegment],redraw,{deep:true});
// Telemetry-only props never rebuild the static/interactive layer; they only refresh the overlay.
watch(()=>[props.vehicle?.x,props.vehicle?.y,props.vehicle?.yaw],drawOverlay);
watch(()=>props.trail,drawOverlay,{deep:true});watch(()=>[props.tool,props.panEnabled],()=>{if(!isMounted)return;stage.draggable(props.tool==='pan'||props.tool==='measure'||!!props.panEnabled);if(props.tool==='route-design')redraw();else redraw();});watch(()=>props.map.id,fit);onBeforeUnmount(()=>{isMounted=false;window.removeEventListener('blur',resetPointerState);resetPointerState();observer?.disconnect();stage?.off();stage?.destroy();});defineExpose({fit});
</script>
<template><div :class="['canvas-wrap',{'pan-mode':panEnabled}]"><div ref="container" class="map-container" data-testid="map-canvas" :data-route-group-ids="tool==='route-design'?routeGroupIds?.join(','):undefined" :data-skipped-route-group-ids="tool==='route-design'?routeSkippedGroups?.map(tag=>tag.id).join(','):undefined"/><div class="canvas-caption"><span class="dot"></span> 单位 m</div><div class="canvas-controls"><Button variant="outline" size="icon" aria-label="放大地图" @click="scaleBy(1.2)"><Plus :size="16"/></Button><Button variant="outline" size="icon" aria-label="缩小地图" @click="scaleBy(0.8)"><Minus :size="16"/></Button><Button variant="outline" size="icon" aria-label="适应地图" @click="fit"><Scan :size="16"/></Button></div><div class="canvas-footer"><span>{{coordinate}}</span><span>{{zoom}}%</span></div><div v-if="tool==='route-design'" class="draw-hint"><MousePointer2 :size="14"/> 单击追加路点 · 方块可拖动 · 组中心自动吸附</div><div v-if="tool==='row'" class="draw-hint"><MousePointer2 :size="14"/> 点击画布添加路线控制点，再点击“完成绘制”</div></div></template>

<style scoped>
.draw-hint{position:absolute;left:14px;bottom:56px;max-width:calc(100% - 90px);display:flex;align-items:center;gap:6px;padding:5px 9px;background:rgba(248,250,252,.94);border:0;border-radius:8px;box-shadow:0 1px 3px rgba(15,23,42,.07);color:var(--muted);font-size:12px;line-height:1.5;pointer-events:none}.draw-hint svg{flex-shrink:0}
</style>
