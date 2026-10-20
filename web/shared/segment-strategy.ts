import {z} from 'zod';
export const strategyModeSchema=z.enum(['auto','forward','reverse','left','right','turn_forward']);
export type StrategyMode=z.infer<typeof strategyModeSchema>;
export const segmentChoiceSchema=z.object({fromId:z.number().int().min(0).max(586),toId:z.number().int().min(0).max(586),occurrence:z.number().int().min(0).max(100),mode:strategyModeSchema}).strict();
export type SegmentChoice=z.infer<typeof segmentChoiceSchema>;
export type StrategyNode={id:number,x:number,y:number};
// Reported by the ROS node at runtime; never assumed by the bridge or the UI.
export type SegmentCapabilities={turnInPlace?:boolean};
export const strategyOptions=[{value:'auto',label:'自动 / 旧路线'},{value:'forward',label:'保持朝向前进'},{value:'reverse',label:'保持朝向倒车'},{value:'left',label:'保持朝向左平移'},{value:'right',label:'保持朝向右平移'},{value:'turn_forward',label:'转向后前进（到码原地转向）'}] as const;
export const wrapYaw=(angle:number)=>Math.atan2(Math.sin(angle),Math.cos(angle));
export const degrees=(angle:number)=>Math.round(angle*180/Math.PI*100)/100;
export function planStrategies(nodes:StrategyNode[],initialYaw:number,choices:SegmentChoice[]=[],capabilities:SegmentCapabilities={}){
 const seen=new Map<string,number>();let yaw=wrapYaw(initialYaw);
 return nodes.slice(1).map((b,i)=>{
  const a=nodes[i]!,pair=a.id+'>'+b.id,occurrence=seen.get(pair)??0;seen.set(pair,occurrence+1);
  const key=pair+'#'+occurrence,choice=choices.find(c=>c.fromId===a.id&&c.toId===b.id&&c.occurrence===occurrence),mode=choice?.mode??'auto';
  const startYaw=yaw,travelYaw=Math.atan2(b.y-a.y,b.x-a.x),relative=wrapYaw(travelYaw-yaw);
  const automatic=Math.abs(relative)<=Math.PI/4?'forward':Math.abs(relative)>=3*Math.PI/4?'reverse':relative>0?'left':'right';
  const effective=mode==='auto'?automatic:mode,turn=effective==='turn_forward'?wrapYaw(travelYaw-yaw):0;
  const bodyYaw=effective==='turn_forward'?travelYaw:yaw;let problem='';
  if(mode==='forward'&&Math.abs(relative)>.10)problem='前进方向与起始车头不一致，请选择倒车、平移或转向后前进';
  if(mode==='reverse'&&Math.abs(wrapYaw(relative-Math.PI))>.10)problem='倒车方向必须位于车头后方';
  if(mode==='left'&&Math.abs(wrapYaw(relative-Math.PI/2))>.10)problem='左平移方向必须位于车头左侧';
  if(mode==='right'&&Math.abs(wrapYaw(relative+Math.PI/2))>.10)problem='右平移方向必须位于车头右侧';
  const blocked=effective==='turn_forward'&&Math.abs(turn)>.001&&capabilities.turnInPlace!==true?'到码转向执行能力未由当前导航节点确认；此段仅规划，禁止执行':'';
  yaw=bodyYaw;
  return {key,fromId:a.id,toId:b.id,occurrence,mode,effective,start:a,end:b,startYaw,bodyYaw,travelYaw,arrivalYaw:bodyYaw,turn,problem,blocked};
 });
}
export type SegmentPlan=ReturnType<typeof planStrategies>[number];
type StoredSegment={fromId:number,toId:number,bodyYaw:number,strategy?:StrategyMode,points:{x:number,y:number}[]};
export function choicesFromSegments(segments:StoredSegment[]):SegmentChoice[]{
 const seen=new Map<string,number>();return segments.map(segment=>{const pair=segment.fromId+'>'+segment.toId,occurrence=seen.get(pair)??0;seen.set(pair,occurrence+1);return {fromId:segment.fromId,toId:segment.toId,occurrence,mode:segment.strategy??'auto'};});
}
export function segmentExecutionBlockers(segments:StoredSegment[]=[],capabilities:SegmentCapabilities={}){
 if(!segments.length||!segments.some(segment=>segment.strategy&&segment.strategy!=='auto'))return [];
 const nodes=[{id:segments[0]!.fromId,...segments[0]!.points[0]!},...segments.map(s=>({id:s.toId,...s.points.at(-1)!}))];
 const plans=planStrategies(nodes,segments[0]!.bodyYaw,choicesFromSegments(segments),capabilities);
 return plans.flatMap(plan=>[plan.problem,plan.blocked].filter(Boolean).map(reason=>'Q'+String(plan.fromId).padStart(3,'0')+' → Q'+String(plan.toId).padStart(3,'0')+'：'+reason));
}
