<script setup lang="ts">
import Konva from 'konva';
import {onMounted,onBeforeUnmount,ref,watch} from 'vue';
import type {FieldMap,Point} from '../../../shared/model';
import {exitPoint,heading,distance} from '../../../shared/model';
import {orthogonalRoute,snapRoutePoint,chainRouteGroups,routeGroupCenters} from '../../../shared/route-design';
import {planStrategies,choicesFromSegments,degrees,type SegmentPlan} from '../../../shared/segment-strategy';
import {Plus,Minus,Scan,MousePointer2} from 'lucide-vue-next';
import Button from './ui/Button.vue';
const props=defineProps<{map:FieldMap,selected:number[],rowId:string,tool:string,editable:boolean,drawing:Point[],panEnabled?:boolean,measurement?:number[],vehicle?:{x:number,y:number,yaw:number},trail?:Point[],routeAnchors?:Point[],routeSelected?:number,routeGroupIds?:number[],routeSkippedGroups?:{id:number,distanceM:number}[],segmentPlans?:SegmentPlan[],selectedSegment?:string,initialHeading?:number}>();
const emit=defineEmits<{select:[id:number,multi:boolean],inspect:[id:number],segmentSelect:[key:string],row:[id:string],blank:[point:Point],move:[ids:number[],dx:number,dy:number],point:[rowId:string,index:number,point:Point],zone:[index:number,point:Point],designSelect:[index:number],designMove:[index:number,point:Point],heading:[value:number]}>();
const container=ref<HTMLDivElement>();let stage:Konva.Stage;let layer:Konva.Layer;let overlayLayer:Konva.Layer;let observer:ResizeObserver;let isMounted=false;const coordinate=ref('X 0.00 · Y 0.00 m'),zoom=ref(100);
// Live telemetry (vehicle/trail) lives on a persistent overlay layer. The static layer below it
// owns every interactive node (QR groups, waypoint/handle/heading knobs) and is only rebuilt for
// real map/editing changes, so continuous pose updates can never cancel a click or a drag.
let vehicleGroup:Konva.Group|undefined,vehicleBody:Konva.Rect|undefined,vehicleArrow:Konva.Arrow|undefined,trailLine:Konva.Line|undefined;
let staticBuilds=0,overlayUpdates=0;
const px=(p:Point)=>[p.x*100,-p.y*100];
let hoverMarker:Konva.Circle|undefined;
let suppressDesignClick=false,stageMoved=false,panGesture=false,spaceHeld=false;
function resetPointerState(){spaceHeld=false;panGesture=false;stageMoved=false;suppressDesignClick=false;container.value?.classList.remove('is-dragging');if(stage)stage.draggable(props.tool==='pan'||props.tool==='measure'||!!props.panEnabled);}
function redraw() {
 // Font readiness and queued resize callbacks can run after Konva destroys its stage.
 if(!isMounted||!layer||layer.getStage()!==stage)return;layer.destroyChildren();
 const bounds=stage.getRelativePointerPosition();void bounds;
 const scale=stage.scaleX(),minX=-stage.x()/scale/100,maxX=(stage.width()-stage.x())/scale/100,minY=-(stage.height()-stage.y())/scale/100,maxY=stage.y()/scale/100;
 if(container.value){container.value.dataset.konvaScale=String(scale);container.value.dataset.konvaX=String(stage.x());container.value.dataset.konvaY=String(stage.y());container.value.dataset.konvaStaticBuilds=String(++staticBuilds);}
 const step=props.tool==='route-design'&&scale>=.65?.05:scale<0.3?2:scale<0.65?1:0.5;
 for(let x=Math.floor(minX/step)*step;x<=maxX;x+=step)layer.add(new Konva.Line({points:[x*100,-minY*100,x*100,-maxY*100],stroke:Math.abs(x)<0.01?'#c9d0d7':'#eef1f4',strokeWidth:1/scale,listening:false}));
 for(let y=Math.floor(minY/step)*step;y<=maxY;y+=step)layer.add(new Konva.Line({points:[minX*100,-y*100,maxX*100,-y*100],stroke:Math.abs(y)<0.01?'#c9d0d7':'#eef1f4',strokeWidth:1/scale,listening:false}));
 if(props.map.routeMode!=='waypoints')layer.add(new Konva.Line({points:props.map.zone.flatMap(px),closed:true,fill:'#eef1f4',opacity:0.7,stroke:'#56616d',strokeWidth:1.5/scale,dash:[6/scale,5/scale],listening:false}));
 props.map.zone.forEach((p,i)=>{if(props.editable&&props.tool==='zone'){const [x,y]=px(p);const handle=new Konva.Circle({x,y,radius:6/scale,fill:'#2563a6',stroke:'white',strokeWidth:2/scale,draggable:true});handle.on('dragend',()=>emit('zone',i,{x:handle.x()/100,y:-handle.y()/100}));layer.add(handle);}});
 for(const row of props.map.rows) {
  const office=props.map.routeMode==='waypoints',route=office?[exitPoint(row),...row.points]:row.points;
  const line=new Konva.Line({points:route.flatMap(px),stroke:row.id===props.rowId?'#c9d0d7':'#eef1f4',strokeWidth:office?8/scale:row.width*100,lineCap:'butt',hitStrokeWidth:row.width*100});line.on('click tap',()=>{if(props.tool==='select')emit('row',row.id);else if(props.editable&&props.tool!=='measure')emit('blank',pointer());});layer.add(line);
  layer.add(new Konva.Line({points:route.flatMap(px),stroke:row.id===props.rowId?'#2563a6':'#727d88',strokeWidth:1.8/scale,dash:[6/scale,4/scale],listening:false}));
  const e=exitPoint(row);if(!office)layer.add(new Konva.Line({points:[...px(e),...px(row.points[0]!)],stroke:'#2563a6',strokeWidth:2/scale,dash:[5/scale,4/scale],listening:false}));
  const mid=row.points[Math.floor(row.points.length/2)]!;layer.add(new Konva.Text({fontFamily:"QR Sans, QR CJK, sans-serif",x:mid.x*100+12/scale,y:-mid.y*100-26/scale,text:row.name,fontSize:16/scale,fill:'#56616d',listening:false}));
  if(props.editable&&props.tool!=='measure'&&props.rowId===row.id)row.points.forEach((p,i)=>{const [x,y]=px(p),handle=new Konva.Circle({x,y,radius:5/scale,fill:'#f7f8f9',stroke:'#2563a6',strokeWidth:2/scale,draggable:true});handle.on('dragend',()=>emit('point',row.id,i,{x:handle.x()/100,y:-handle.y()/100}));layer.add(handle);});
 }
 for(const [i,segment] of (props.map.motionSegments??[]).entries()){
  if(!segment.points?.length)continue;
  const color=segment.mode==='crab'?'#2563a6':'#2563a6',p=segment.points[Math.floor(segment.points.length/2)]!;
  layer.add(new Konva.Line({points:segment.points.flatMap(px),stroke:color,strokeWidth:3/scale,listening:false}));
  layer.add(new Konva.Text({fontFamily:'QR Sans, QR CJK, sans-serif',x:p.x*100+8/scale,y:-p.y*100+8/scale,text:(i+1)+' · '+(segment.mode==='crab'?'平移':segment.direction==='reverse'?'4T4D 倒车':'4T4D 前进'),fontSize:13/scale,fill:color,listening:false}));
 }
 // The live trail is drawn on the overlay layer by drawOverlay(), never rebuilt with the map.
 const stored=props.map.motionSegments??[];
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
   layer.add(new Konva.Line({name:'selected-leg-halo',points:leg,stroke:'#ffffff',strokeWidth:13/scale,lineCap:'round',lineJoin:'round',listening:false}));
   layer.add(new Konva.Line({name:'selected-leg',points:leg,stroke:'#dc2626',strokeWidth:7/scale,lineCap:'round',lineJoin:'round',listening:false}));
   layer.add(new Konva.Circle({x,y,radius:17/scale,stroke:'#dc2626',strokeWidth:1.5/scale,dash:[5/scale,3/scale],listening:false}));
  }
  layer.add(new Konva.Arrow({name:'travel-'+plan.key,points:arrowPoints,stroke:color,fill:color,strokeWidth:(active?3:2)/scale,pointerLength:(active?9:6)/scale,pointerWidth:(active?9:6)/scale,listening:false}));
  layer.add(new Konva.Arrow({name:'heading-'+plan.key,points:[x,y,x+Math.cos(plan.arrivalYaw)*18/scale,y-Math.sin(plan.arrivalYaw)*18/scale],stroke:'#d97706',fill:'#d97706',strokeWidth:2/scale,pointerLength:5/scale,pointerWidth:5/scale,listening:false}));
  if(Math.abs(plan.turn)>.001)layer.add(new Konva.Text({x:x+8/scale,y:y-22/scale,text:(plan.turn>0?'↶':'↷')+Math.abs(degrees(plan.turn))+'° · 仅规划',fontSize:11/scale,fill:'#b45309',listening:false}));
  if(active)layer.add(new Konva.Text({x:x+14/scale,y:y+16/scale,text:'当前段',fontFamily:'QR Sans, QR CJK, sans-serif',fontSize:12/scale,fontStyle:'bold',fill:'#dc2626',listening:false}));
 }
 const measurementIds=props.tool==='measure'?(props.measurement??[]):[];
 const measurementTags=[...new Set(measurementIds)].slice(0,2).map(id=>props.map.tags.find(t=>t.id===id)).filter((t):t is FieldMap['tags'][number]=>!!t&&Number.isFinite(t.x)&&Number.isFinite(t.y));
 const measurementPair=measurementIds.length===2&&measurementIds[0]!==measurementIds[1]&&measurementTags.length===2?measurementTags:[];
 if(measurementPair.length===2){const points=measurementPair.flatMap(px);
  layer.add(new Konva.Line({points,stroke:'#f7f8f9',strokeWidth:6/scale,listening:false}));
  layer.add(new Konva.Line({points,stroke:'#2563a6',strokeWidth:3/scale,dash:[8/scale,8/scale],listening:false}));
  layer.add(new Konva.Line({points,stroke:'#2563a6',strokeWidth:3/scale,dash:[8/scale,8/scale],dashOffset:8/scale,listening:false}));
 }
 for(const t of props.map.tags){const selected=props.selected.includes(t.id)||(props.tool==='route-design'&&!!props.routeGroupIds?.includes(t.id)),[x,y]=px(t);const group=new Konva.Group({name:'tag-'+t.id,x,y,draggable:props.editable&&props.tool==='select'});
  const skipped=props.tool==='route-design'&&props.routeSkippedGroups?.some(tag=>tag.id===t.id);
  const size=Math.max(t.size*100,9/scale);group.add(new Konva.Rect({x:-size/2,y:-size/2,width:size,height:size,cornerRadius:2/scale,fill:skipped?'#d97706':selected?'#2563a6':t.kind==='end'?'#2563a6':'#39444f',stroke:selected?'#c9d0d7':'white',strokeWidth:2/scale}));
  group.add(new Konva.Arrow({points:[0,0,Math.cos(t.angle*Math.PI/180)*16/scale,-Math.sin(t.angle*Math.PI/180)*16/scale],pointerLength:4/scale,pointerWidth:4/scale,stroke:'#2563a6',fill:'#2563a6',strokeWidth:1/scale,listening:false}));
  group.add(new Konva.Text({fontFamily:"QR Sans, QR CJK, sans-serif",x:-40/scale,y:14/scale,width:80/scale,align:'center',text:t.groupId??`Q${String(t.id).padStart(3,'0')}`,fontSize:16/scale,fill:skipped?'#d97706':selected?'#2563a6':'#56616d',listening:false}));
  group.on('click tap',e=>{e.cancelBubble=true;if(props.tool==='route-design'){if(stageMoved||panGesture||props.panEnabled)return;emit('inspect',t.id);if(props.editable)emit('blank',{x:t.x,y:t.y});}else emit('select',t.id,!!e.evt.shiftKey);});
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
   for(const p of points){const [x,y]=px(p);decorations.add(new Konva.Rect({x:x!-3/scale,y:y!-3/scale,width:6/scale,height:6/scale,fill:color,listening:false}));}
   const chain=chainRouteGroups(points,routeGroupCenters(props.map)),used=new Set(chain.nodes.map(node=>node.id)),skippedGroups=new Map([...(props.routeSkippedGroups??[]),...chain.skipped].map(tag=>[tag.id,tag]));
   for(const tag of props.map.tags){const skipped=used.has(tag.id)?undefined:skippedGroups.get(tag.id);if(!used.has(tag.id)&&!skipped)continue;const [x,y]=px(tag),markerColor=skipped?'#d97706':'#2563a6';
    decorations.add(new Konva.Circle({x,y,name:'route-group-'+tag.id,radius:13/scale,stroke:markerColor,strokeWidth:3/scale,listening:false}));
    decorations.add(new Konva.Text({x:x!+16/scale,y:y!-23/scale,text:skipped?'偏离 '+(skipped.distanceM*100).toFixed(1)+' cm · 未串联':'途经纠正',fontFamily:'QR Sans, QR CJK, sans-serif',fontSize:12/scale,fill:markerColor,listening:false}));
   }
  };
  updatePreview(props.drawing);
  hoverMarker=new Konva.Circle({radius:17/scale,stroke:'#2563a6',strokeWidth:2/scale,dash:[4/scale,3/scale],visible:false,listening:false});layer.add(hoverMarker);
  (props.routeAnchors??[]).forEach((p,i)=>{const [x,y]=px(p),selected=i===props.routeSelected;
   const handle=new Konva.Rect({name:'route-waypoint-'+i,x,y,offsetX:6/scale,offsetY:6/scale,width:12/scale,height:12/scale,fill:selected?'#eef1f4':'#39444f',stroke:color,strokeWidth:2/scale,draggable:props.editable});
   handle.on('click tap',e=>{e.cancelBubble=true;if(props.editable)emit('designSelect',i);});
   handle.on('dragmove',()=>{const snapped=snapRoutePoint({x:handle.x()/100,y:-handle.y()/100},props.map.tags);handle.position({x:snapped.x*100,y:-snapped.y*100});const anchors=(props.routeAnchors??[]).map((a,j)=>j===i?snapped:a);updatePreview(orthogonalRoute(anchors));layer.batchDraw();});
   handle.on('dragend',()=>{suppressDesignClick=true;setTimeout(()=>{suppressDesignClick=false;},0);emit('designMove',i,{x:handle.x()/100,y:-handle.y()/100});redraw();});layer.add(handle);
   layer.add(new Konva.Text({x:x!+9/scale,y:y!-18/scale,text:String(i+1),fontSize:12/scale,fontFamily:'monospace',fill:'#39444f',listening:false}));
  });
  // Amber arrow on the first waypoint: the route's starting body heading. Drag the
  // tip to set it; the value is emitted on dragend only so redraw cannot kill the drag.
  const headingRad=props.initialHeading;
  if((props.routeAnchors??[]).length&&typeof headingRad==='number'&&Number.isFinite(headingRad)){
   const [hx,hy]=px(props.routeAnchors![0]!);const arm=Math.max(52/scale,.42*100);
   const arrow=new Konva.Arrow({name:'initial-heading',points:[hx,hy,hx+Math.cos(headingRad)*arm,hy-Math.sin(headingRad)*arm],stroke:'#d97706',fill:'#d97706',strokeWidth:3/scale,pointerLength:11/scale,pointerWidth:10/scale,listening:false});
   layer.add(arrow);
   const knob=new Konva.Circle({name:'initial-heading-handle',x:hx+Math.cos(headingRad)*arm,y:hy-Math.sin(headingRad)*arm,radius:9/scale,fill:'#fffbeb',stroke:'#d97706',strokeWidth:2/scale,draggable:props.editable});
   let pending=headingRad;
   knob.on('dragstart',()=>{suppressDesignClick=true;});
   knob.on('dragmove',()=>{const dx=knob.x()-hx,dy=knob.y()-hy;if(Math.hypot(dx,dy)<arm*.45)return;pending=Math.atan2(-dy,dx);arrow.points([hx,hy,hx+Math.cos(pending)*arm,hy-Math.sin(pending)*arm]);layer.batchDraw();});
   knob.on('dragend',()=>{setTimeout(()=>{suppressDesignClick=false;},0);emit('heading',pending);emit('designSelect',0);});
   layer.add(knob);
   layer.add(new Konva.Text({name:'initial-heading-label',x:hx+Math.cos(headingRad)*arm+8/scale,y:hy-Math.sin(headingRad)*arm+8/scale,text:'初始 '+Math.round(((headingRad*180/Math.PI)%360+360)%360)+'°',fontFamily:'QR Sans, QR CJK, sans-serif',fontSize:11/scale,fontStyle:'bold',fill:'#b45309',listening:false}));
  }
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
  const {length,width}=props.map.vehicle;
  vehicleGroup.position({x:props.vehicle.x*100,y:-props.vehicle.y*100});
  vehicleGroup.rotation(-props.vehicle.yaw*180/Math.PI);
  vehicleBody!.setAttrs({x:-length*50,y:-width*50,width:length*100,height:width*100,cornerRadius:5,fill:'#2563a6',stroke:'white',strokeWidth:2/scale});
  vehicleArrow!.points([0,0,length*50,0]);
  vehicleArrow!.setAttrs({stroke:'white',fill:'white',strokeWidth:2/scale,pointerWidth:6/scale,pointerLength:6/scale});
 }else if(vehicleGroup){vehicleGroup.destroy();vehicleGroup=undefined;vehicleBody=undefined;vehicleArrow=undefined;}
 overlayLayer.batchDraw();
 if(container.value){container.value.dataset.konvaVehicle=vehicleGroup?'1':'0';container.value.dataset.konvaTrailPoints=String(props.trail?.length??0);container.value.dataset.konvaOverlayUpdates=String(++overlayUpdates);}
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
 stage.on('click tap',e=>{if(stageMoved||panGesture){stageMoved=false;return;}if(e.target===stage&&props.editable&&!suppressDesignClick)emit('blank',pointer());});
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
.draw-hint{position:absolute;left:14px;bottom:60px;max-width:calc(100% - 90px);display:flex;align-items:center;gap:6px;padding:6px 9px;background:var(--background)ed;border:1px solid var(--line);border-radius:8px;color:var(--muted);font-size:12px;line-height:1.5;pointer-events:none}.draw-hint svg{flex-shrink:0}
</style>
