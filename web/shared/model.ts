import { z } from 'zod';
import {boardSchema} from './boards';
import {strategyModeSchema} from './segment-strategy';
export const groupsSchema=z.array(boardSchema).max(587).superRefine((groups,ctx)=>{const names=new Set<string>(),children=new Set<number>();for(const group of groups){if(names.has(group.id))ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位组编号重复'});names.add(group.id);for(const child of group.members){if(children.has(child.id))ctx.addIssue({code:z.ZodIssueCode.custom,message:'子码同时属于多个定位组'});children.add(child.id);}}});
export const states = ['IDLE','INITIALIZING','SEGMENT_ALIGN','FORWARD','ROW_END','REVERSE','ROW_EXIT','SWITCH_TO_LATERAL','LATERAL_SHIFT','SWITCH_TO_ACKERMANN','NEXT_ROW','FINISHED','FAULT'] as const;
export const actions = ['LOCALIZE','CONTINUE','SLOW_DOWN','STOP','WAIT','END_REVERSE','EXIT_SHIFT','RESTORE_ACKERMANN','CUSTOM','ROW_COMPLETE','TASK_COMPLETE'] as const;
export const actionLabels: Record<typeof actions[number],string> = {LOCALIZE:'仅定位校正',CONTINUE:'继续前进',SLOW_DOWN:'降低速度',STOP:'减速停车',WAIT:'停车等待',END_REVERSE:'行尾停车并倒车',EXIT_SHIFT:'退出后横移换行',RESTORE_ACKERMANN:'恢复阿克曼',CUSTOM:'自定义作业任务',ROW_COMPLETE:'完成当前行',TASK_COMPLETE:'完成全部作业'};
export const uid=()=> globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=globalThis.crypto.getRandomValues(new Uint8Array(1))[0]!&15;return (c==='x'?r:(r&3)|8).toString(16);});
const number = z.number().finite().min(-10000).max(10000);
export const pointSchema = z.object({x:number,y:number});
export const ruleSchema = z.object({id:z.string().min(1).max(80),state:z.enum(states),direction:z.enum(['forward','reverse','lateral']),action:z.enum(actions),speed:z.number().min(0).max(0.3),waitSeconds:z.number().min(0).max(3600),radius:z.number().min(0.02).max(0.25),task:z.string().max(80).default('default'),customTask:z.string().max(80).default('')});
export const tagSchema = z.object({id:z.number().int().min(0).max(586),groupId:z.string().optional(),rowId:z.string().max(80),x:number,y:number,angle:number,size:z.number().min(0.02).max(0.18),kind:z.enum(['entry','end','waypoint','reference','exit']),rules:z.array(ruleSchema).max(30)});
export const rowSchema = z.object({id:z.string().min(1).max(80),name:z.string().min(1).max(80),width:z.number().min(0.41).max(5),start:pointSchema.optional(),points:z.array(pointSchema).min(2).max(1000),exitDistance:z.number().min(0.4).max(10)});
export const motionSegmentSchema=z.object({id:z.string().min(1).max(80),fromId:z.number().int().min(0).max(586),toId:z.number().int().min(0).max(586),mode:z.enum(['4t4d','crab']),direction:z.enum(['forward','reverse','lateral']),executionProfile:z.literal('recorded_slow_trial').optional(),strategy:strategyModeSchema.optional(),bodyYaw:number,endYaw:number,wheelAngle:z.number().finite().min(-90).max(90),points:z.array(pointSchema).min(2).max(1000)});
export const mapSchema = z.object({schemaVersion:z.literal(1),id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),name:z.string().min(1).max(100),frame:z.literal('map'),family:z.literal('tag36h11'),source:z.enum(['design','survey']),coordinateStatus:z.enum(['draft','reviewed']).default('draft'),captureQuality:z.enum(['verified','draft']).optional(),routeMode:z.enum(['rows','waypoints','map-only']).optional(),motionSegments:z.array(motionSegmentSchema).min(1).max(100).optional(),rows:z.array(rowSchema).max(100),tags:z.array(tagSchema).max(587),groups:groupsSchema.optional(),order:z.array(z.string()).max(100),zone:z.array(pointSchema).length(4),vehicle:z.object({width:z.number().min(0.1).max(1),length:z.number().min(0.2).max(3),margin:z.number().min(0.01).max(0.1)}),notes:z.string().max(2000).default('')}).superRefine((map,ctx)=>{
 if(map.routeMode==='map-only'&&(map.rows.length||map.order.length||map.motionSegments||map.tags.length===0||map.tags.some(t=>t.rowId||t.rules.length)))ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位码地图需要有效点位且不能包含导航路径或动作'});
 if(map.motionSegments){
  if(map.routeMode!=='waypoints'||map.rows.length!==1)ctx.addIssue({code:z.ZodIssueCode.custom,message:'区间路线必须是一条办公室路径'});
  const ids=new Set<string>();
  map.motionSegments.forEach((segment,i)=>{
   if(ids.has(segment.id))ctx.addIssue({code:z.ZodIssueCode.custom,message:'区间编号重复'});ids.add(segment.id);
   if((segment.mode==='crab')!==(segment.direction==='lateral'))ctx.addIssue({code:z.ZodIssueCode.custom,message:'区间模式与方向不一致'});
   for(const [id,p] of [[segment.fromId,segment.points[0]!],[segment.toId,segment.points.at(-1)!]] as const){const tag=map.tags.find(t=>t.id===id);if(!tag||Math.hypot(tag.x-p.x,tag.y-p.y)>.03)ctx.addIssue({code:z.ZodIssueCode.custom,message:'区间端点必须对应二维码中心'});}
   const prev=map.motionSegments?.[i-1];const turning=segment.strategy==='turn_forward';
   if(prev&&(prev.toId!==segment.fromId||Math.hypot(prev.points.at(-1)!.x-segment.points[0]!.x,prev.points.at(-1)!.y-segment.points[0]!.y)>.001||(!turning&&Math.abs(Math.atan2(Math.sin(prev.endYaw-segment.bodyYaw),Math.cos(prev.endYaw-segment.bodyYaw)))>.15)))ctx.addIssue({code:z.ZodIssueCode.custom,message:'相邻区间位置或车头方向不连续'});
  });
 }
 const groups=new Map((map.groups??[]).map(g=>[g.referenceId,g]));const childIds=new Set((map.groups??[]).flatMap(g=>g.members.map(m=>m.id)));
 for(const t of map.tags){const g=groups.get(t.id);if(g&&(t.groupId!==g.id||Math.abs(t.size-g.sizeMm/1000)>1e-9))ctx.addIssue({code:z.ZodIssueCode.custom,message:'地图组中心与打印布局不匹配'});if(t.groupId&&!g)ctx.addIssue({code:z.ZodIssueCode.custom,message:'地图缺少定位组定义'});if(childIds.has(t.id)&&!g)ctx.addIssue({code:z.ZodIssueCode.custom,message:'不能将组内子码重复保存为独立路点'});}
});
export type Point = z.infer<typeof pointSchema>;
export type Row = z.infer<typeof rowSchema>;
export type Tag = z.infer<typeof tagSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type FieldMap = z.infer<typeof mapSchema>;
export const generationSchema = z.object({count:z.number().int().min(1).max(100),length:z.number().min(1).max(200),spacing:z.number().min(0.61).max(20),width:z.number().min(0.41).max(2),tagSpacing:z.number().min(0.2).max(20),tagSize:z.number().min(0.02).max(0.15),x:number,y:number,angle:number,exitDistance:z.number().min(0.5).max(10),startId:z.number().int().min(0).max(586),startRow:z.number().int().min(1).max(100),orderMode:z.enum(['ascending','descending'])});
export type Generation = z.infer<typeof generationSchema>;
export const defaults:Generation = {count:5,length:8,spacing:1.2,width:0.6,tagSpacing:2,tagSize:0.08,x:0,y:0,angle:90,exitDistance:0.8,startId:0,startRow:1,orderMode:'ascending'};
export const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
export function heading(row:Row) { const a=row.points[0]!, b=row.points[1]!; return Math.atan2(b.y-a.y,b.x-a.x); }
export function exitPoint(row:Row):Point {if(row.start)return {...row.start};const a=heading(row); return {x:row.points[0]!.x-Math.cos(a)*row.exitDistance,y:row.points[0]!.y-Math.sin(a)*row.exitDistance};}
export function rule(action:Rule['action'],state:Rule['state'],direction:Rule['direction']):Rule {return {id:uid(),state,direction,action,speed:0.12,waitSeconds:action==='END_REVERSE'?2:0,radius:0.12,task:'default',customTask:''};}
export function generate(input:Generation):FieldMap {
 const p=generationSchema.parse(input); if(p.startRow>p.count) throw new Error('起始行超出作物行数');
 if(p.spacing<p.width) throw new Error('相邻行间距不能小于通道宽度');
 const a=p.angle*Math.PI/180, u={x:Math.cos(a),y:Math.sin(a)}, v={x:-Math.sin(a),y:Math.cos(a)};
 const at=(s:number,t:number):Point=>({x:p.x+s*u.x+t*v.x,y:p.y+s*u.y+t*v.y});
 const rows:Row[]=[],tags:Tag[]=[]; let id=p.startId;
 for(let i=0;i<p.count;i++) {
  const rowId=`row-${i+1}`; rows.push({id:rowId,name:`第 ${i+1} 行`,width:p.width,points:[at(0,i*p.spacing),at(p.length,i*p.spacing)],exitDistance:p.exitDistance});
  const steps=[0]; for(let s=p.tagSpacing;s<p.length-0.001;s+=p.tagSpacing) {steps.push(s);if(steps.length>587) throw new Error('标记超过 tag36h11 容量 587');} steps.push(p.length);
  for(const [n,s] of steps.entries()) {if(id>586) throw new Error('tag36h11 ID 范围为 0–586，请减少标记数量');
   const kind=n===0?'entry':n===steps.length-1?'end':'waypoint'; tags.push({id:id++,rowId,...at(s,i*p.spacing),angle:p.angle,size:p.tagSize,kind,rules:kind==='end'?[rule('END_REVERSE','FORWARD','forward')]:[rule('LOCALIZE','FORWARD','forward'),rule('LOCALIZE','REVERSE','reverse')]});
  }
  if(id>586) throw new Error('标记数量超出码本容量');
  tags.push({id:id++,rowId,...at(-p.exitDistance,i*p.spacing),angle:p.angle,size:p.tagSize,kind:'exit',rules:[rule('EXIT_SHIFT','REVERSE','reverse')]});
 }
 const order=rows.map(r=>r.id); if(p.orderMode==='descending') order.reverse(); const start=order.indexOf(`row-${p.startRow}`);
 return {schemaVersion:1,id:uid(),name:'温室作物行地图',frame:'map',family:'tag36h11',source:'design',coordinateStatus:'draft',rows,tags,order:order.slice(start),zone:[at(-p.exitDistance-0.55,-0.55),at(-0.25,-0.55),at(-0.25,(p.count-1)*p.spacing+0.55),at(-p.exitDistance-0.55,(p.count-1)*p.spacing+0.55)],vehicle:{width:0.4,length:0.8,margin:0.05},notes:'车辆长度 0.8m 为设计占位值，实测后修改。正式导航前需现场坐标验收。'};
}
export function inside(p:Point,poly:Point[]):boolean {
 let flag=false; for(let i=0,j=poly.length-1;i<poly.length;j=i++) {const a=poly[i]!,b=poly[j]!; if(((a.y>p.y)!==(b.y>p.y)) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) flag=!flag;} return flag;
}
export function envelopeInside(p:Point,yaw:number,map:FieldMap):boolean {
 const l=map.vehicle.length/2+map.vehicle.margin,w=map.vehicle.width/2+map.vehicle.margin;
 return [-l,l].every(x=>[-w,w].every(y=>inside({x:p.x+x*Math.cos(yaw)-y*Math.sin(yaw),y:p.y+x*Math.sin(yaw)+y*Math.cos(yaw)},map.zone)));
}
function segmentDistance(p:Point,a:Point,b:Point) {const d=distance(a,b)**2; const t=d?Math.max(0,Math.min(1,((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/d)):0;return distance(p,{x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)});}
export function validate(map:FieldMap):{errors:string[],warnings:string[]} {
 const errors:string[]=[],warnings:string[]=[]; const ids=new Set<number>(), rows=new Set<string>();
 if(map.routeMode==='map-only'){
  if(map.tags.length===0)errors.push('定位码地图没有有效点位');
  const area=map.zone.reduce((a,p,i)=>{const q=map.zone[(i+1)%map.zone.length]!;return a+p.x*q.y-q.x*p.y;},0);
  if(Math.abs(area)<1e-8)errors.push('地图显示范围不能退化为零面积');
 }else if(!map.rows.length) errors.push('地图至少需要一条作物行');
 for(const row of map.rows) {if(rows.has(row.id)) errors.push(`作物行ID重复：${row.id}`);rows.add(row.id);
  if(map.routeMode!=='waypoints'&&row.width<=map.vehicle.width+2*map.vehicle.margin) errors.push(`${row.name} 无足够横向安全余量`);
  if(map.routeMode!=='waypoints'&&row.exitDistance<map.vehicle.length/2+map.vehicle.margin) errors.push(`${row.name} 后退退出距离不足以让整车离开作物区`);
  if(row.points.some((p,i)=>i>0&&distance(p,row.points[i-1]!)<(map.routeMode==='waypoints'?.001:.1))) errors.push(`${row.name} 控制点过近`);
  if(map.routeMode!=='waypoints'&&!envelopeInside(exitPoint(row),heading(row),map)) errors.push(`${row.name} 退出点的整车包络超出换行区`);
  const end=row.points.at(-1)!;
  if(!map.tags.some(t=>t.rowId===row.id&&t.kind==='end'&&distance(t,end)<0.15)) warnings.push(`${row.name} 缺少匹配行尾标记`);
 }
 const ruleIds=new Set<string>();
 for(const t of map.tags) {if(ids.has(t.id)) errors.push(`AprilTag ID 重复：${t.id}`);ids.add(t.id);if(t.rowId&&!rows.has(t.rowId)) errors.push(`Q${t.id} 所属行不存在`);
  const row=map.rows.find(r=>r.id===t.rowId);if(row&&t.kind!=='exit'&&Math.min(...row.points.slice(1).map((p,i)=>segmentDistance(t,row.points[i]!,p)))>row.width/2) warnings.push(`Q${t.id} 偏离所属通道`);
  for(const r of t.rules) {if(ruleIds.has(r.id)) errors.push('动作规则ID重复');ruleIds.add(r.id);if(r.action==='CUSTOM'&&!r.customTask) errors.push(`Q${t.id} 自定义作业任务名为空`);
   if(r.action==='END_REVERSE'&&(r.state!=='FORWARD'||r.direction!=='forward'||t.kind!=='end')) errors.push(`Q${t.id} 行尾倒车动作的状态/方向/类型不匹配`);
   if(r.action==='EXIT_SHIFT'&&(r.state!=='REVERSE'||r.direction!=='reverse'||t.kind!=='exit')) errors.push(`Q${t.id} 换行动作必须在退出标记、倒车状态下触发`);
  }
 }
 for(let i=0;i<map.tags.length;i++) for(let j=i+1;j<map.tags.length;j++) if(distance(map.tags[i]!,map.tags[j]!)<((map.tags[i]!.groupId?1:1.25)*map.tags[i]!.size+(map.tags[j]!.groupId?1:1.25)*map.tags[j]!.size)/2) errors.push(`Q${map.tags[i]!.id} 与 Q${map.tags[j]!.id} 物理标记重叠`);
 if(map.routeMode!=='map-only'&&(!map.order.length || new Set(map.order).size!==map.order.length || map.order.some(id=>!rows.has(id)))) errors.push('作业顺序为空、重复或引用不存在的行');
 for(let i=1;i<map.order.length;i++) {const a=map.rows.find(r=>r.id===map.order[i-1])!,b=map.rows.find(r=>r.id===map.order[i])!;
  if(a&&b) {const yaw=heading(a),pa=exitPoint(a),pb=exitPoint(b);if(Math.abs(Math.atan2(Math.sin(heading(b)-yaw),Math.cos(heading(b)-yaw)))>0.02 || Math.abs((pb.x-pa.x)*Math.cos(yaw)+(pb.y-pa.y)*Math.sin(yaw))>0.05) errors.push(`${a.name} → ${b.name} 无法仅通过90°横移衔接`);
   for(let n=0;n<=20;n++) if(!envelopeInside({x:pa.x+(pb.x-pa.x)*n/20,y:pa.y+(pb.y-pa.y)*n/20},yaw,map)) {errors.push(`${a.name} → ${b.name} 横移包络超出换行区`);break;}
  }
 }
 if(map.coordinateStatus==='draft') warnings.push('现场坐标未验收，禁止实体导航');
 if(map.routeMode!=='waypoints'&&map.rows.some(r=>r.points.length>2)) warnings.push('自由路线需后续验证曲率与四轮转向扫掠范围');
 return {errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
}
export function paths(map:FieldMap) {
 return map.order.map((id,i)=>{const r=map.rows.find(r=>r.id===id)!;const next=map.rows.find(r=>r.id===map.order[i+1]);return {rowId:id,forward:[exitPoint(r),...r.points],reverse:[...r.points].reverse().concat([exitPoint(r)]),lateral:next?[exitPoint(r),exitPoint(next)]:[],bodyYaw:heading(r),reverseBodyYaw:heading(r)};});
}
