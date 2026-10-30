import {z} from 'zod';
import {distance,mapSchema,pointSchema,validate,type FieldMap,type Point} from '../../shared/model';
import {routeCorners,chainRouteGroups,routeGroupCenters} from '../../shared/route-design';
import {segmentChoiceSchema,planStrategies,type SegmentChoice} from '../../shared/segment-strategy';
import trial from '../../../src/greenhouse_navigation/greenhouse_navigation/recorded_trial_limits.json' with {type:'json'};

export const routeDesignSchema=z.object({
 mapId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),baseVersion:z.number().int().positive(),
 points:z.array(pointSchema).min(2).max(501),bodyYawDeg:z.number().finite().min(-180).max(180),initialHeadingRad:z.number().finite().min(-Math.PI).max(Math.PI).nullable().optional(),routeId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),routeName:z.string().trim().min(1).max(100).optional(),saveAs:z.boolean().default(false),routeUpdated:z.string().datetime().optional(),distanceModel:z.literal('center-euclidean').default('center-euclidean'),spacingOverrides:z.array(z.object({fromId:z.number().int().min(0).max(586),toId:z.number().int().min(0).max(586),occurrence:z.number().int().positive().default(1),targetM:z.number().finite().min(.08).max(50)})).max(100).optional()
}).extend({segmentModes:z.array(segmentChoiceSchema).max(100).optional()}).strict();
const wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a));
const EPS=1e-8;

export function validateSpacingOverrides(source:FieldMap, overrides:any[]){ const ids=new Set(source.tags.map(t=>t.id)); const seen=new Set<string>(); for(const o of overrides??[]){ if(!ids.has(o.fromId)||!ids.has(o.toId)||o.fromId===o.toId)throw new Error('间距二维码必须存在且不同'); const k=`${o.fromId}>${o.toId}#${o.occurrence??1}`; if(seen.has(k))throw new Error('重复间距覆盖必须指定不同 occurrence'); seen.add(k); const d=Math.hypot((source.tags.find(t=>t.id===o.toId)!.x-source.tags.find(t=>t.id===o.fromId)!.x),(source.tags.find(t=>t.id===o.toId)!.y-source.tags.find(t=>t.id===o.fromId)!.y)); if(d<.08||o.targetM<.08)throw new Error('二维码物理间距不得小于8厘米'); } return true; }

export function compileDesignedRoute(source:FieldMap,input:Point[],bodyYawDeg:number,segmentModes:SegmentChoice[]=[],spacingOverrides:any[]=[]){
 if(!Number.isFinite(bodyYawDeg)||Math.abs(bodyYawDeg)>180)throw new Error('车头朝向必须为 -180 到 180 度');
 if(input.length<2||input.length>501)throw new Error('路径需要 2–501 个控制点');
 const raw=input.map(p=>pointSchema.parse(p));
 validateSpacingOverrides(source,spacingOverrides);
 // Route-level distance overrides move only the selected endpoint along its existing
 // segment axis; map tag centres remain immutable.
 for(const ov of spacingOverrides??[]){ const idx=raw.findIndex(p=>p.x===source.tags.find(t=>t.id===ov.toId)?.x&&p.y===source.tags.find(t=>t.id===ov.toId)?.y); const from=source.tags.find(t=>t.id===ov.fromId),to=source.tags.find(t=>t.id===ov.toId); if(idx>=0&&from&&to){const d=Math.hypot(to.x-from.x,to.y-from.y);if(d<.08)throw new Error('相邻二维码物理间距不足8厘米'); const ux=(to.x-from.x)/d,uy=(to.y-from.y)/d;raw[idx]={x:from.x+ux*ov.targetM,y:from.y+uy*ov.targetM};}}

 for(let i=1;i<raw.length;i++){
  const a=raw[i-1]!,b=raw[i]!;
  if(distance(a,b)<.001)throw new Error('相邻路点距离不能小于1毫米');
  if(Math.abs(a.x-b.x)>EPS&&Math.abs(a.y-b.y)>EPS)throw new Error(`第 ${i} 段不是正交线段，请使用水平或垂直布线`);
  // Canonicalize only floating point noise, preserving measured group coordinates.
  if(Math.abs(a.x-b.x)<=EPS)b.x=a.x;else b.y=a.y;
 }
 const corners=routeCorners(raw),progress=[0];
 for(let i=1;i<corners.length;i++)progress.push(progress[i-1]!+distance(corners[i-1]!,corners[i]!));
 if(progress.at(-1)!>50+EPS)throw new Error('路径总长度不能超过50米，请拆分任务');
 const chain=chainRouteGroups(corners,routeGroupCenters(source));
 if(chain.problem)throw new Error(chain.problem);
 const boundaries=chain.nodes;
 const adjacentOccurrences=new Map<string,number>();
 for(let i=1;i<boundaries.length;i++){const key=boundaries[i-1]!.id+'>'+boundaries[i]!.id;adjacentOccurrences.set(key,(adjacentOccurrences.get(key)??0)+1);}
 for(const ov of spacingOverrides??[]){const key=ov.fromId+'>'+ov.toId;if((adjacentOccurrences.get(key)??0)<(ov.occurrence??1))throw new Error('间距覆盖必须对应路径上的相邻二维码及有效经过次数');}
 if(new Set(boundaries.map(node=>node.id)).size<2)throw new Error('可直线串联的定位组不足两个，请沿码连线绘制路径');
 if(boundaries.length>101)throw new Error('定位组区间不能超过100段，请拆分任务');
 if(chain.lengthM>50+EPS)throw new Error('吸附后路径总长度不能超过50米，请拆分任务');
 const bodyYaw=wrap(bodyYawDeg*Math.PI/180),segments:NonNullable<FieldMap['motionSegments']>=[],route:Point[]=[];
 const plans=planStrategies(boundaries,bodyYaw,segmentModes),keys=new Set<string>();
 for(const choice of segmentModes){const key=choice.fromId+'>'+choice.toId+'#'+choice.occurrence;if(keys.has(key)||!plans.some(plan=>plan.key===key))throw new Error('区间策略重复或与当前有向码间区间不匹配');keys.add(key);}
 const issue=plans.find(plan=>plan.problem);if(issue)throw new Error(issue.problem);
 // Body heading carried through the route: a turn_forward interval updates it at
 // the shared QR centre, so following intervals are compiled against the new axis.
 let yaw=bodyYaw;
 for(let i=1;i<boundaries.length;i++){
  const a=boundaries[i-1]!,b=boundaries[i]!;
  if(distance(a,b)<.08)throw new Error('相邻定位组区间端点距离不足8厘米，请调整路径');
  if(Math.abs(a.x-b.x)>EPS&&Math.abs(a.y-b.y)>EPS)throw new Error('串联节点无法直线连接，请沿正交网格布线');
  // turn_forward rotates the body at the shared QR centre, so the interval itself
  // is driven straight forward along the new heading instead of as a crab shift.
  const turning=plans[i-1]!.mode==='turn_forward';
  const tangent=Math.atan2(b.y-a.y,b.x-a.x),angle=Math.abs(wrap(tangent-yaw));
  const direction=turning?'forward':angle<=Math.PI/4+EPS?'forward':angle>=3*Math.PI/4-EPS?'reverse':'lateral';
  if(!turning&&direction!=='lateral'&&Math.abs(wrap(tangent-yaw-(direction==='reverse'?Math.PI:0)))>.10)
   throw new Error('前进/倒车区间与车头朝向偏差超过5.7度；请调整车头朝向，使其沿水平或垂直轴');
  let wheelAngle=direction==='lateral'?wrap(tangent-yaw)*180/Math.PI:0;
  if(wheelAngle>90)wheelAngle-=180;if(wheelAngle< -90)wheelAngle+=180;
  const segmentYaw=turning?tangent:yaw;
  const n=Math.min(999,Math.max(2,Math.ceil(distance(a,b)/.05)));
  if(route.length+n+(route.length?0:1)>1001)throw new Error('加密路线超过1001点，请缩短路径或拆分任务');
  const points=Array.from({length:n+1},(_,j)=>({x:a.x+(b.x-a.x)*j/n,y:a.y+(b.y-a.y)*j/n}));
  // The factory only drives straight legs: every generated point must stay on the same
  // horizontal or vertical line. This is the last gate before the segment can be stored.
  for(let j=1;j<points.length;j++){
   const p0=points[j-1]!,p1=points[j]!;
   if(Math.abs(p0.x-p1.x)>EPS&&Math.abs(p0.y-p1.y)>EPS)throw new Error('编译出的路径段必须是水平或垂直直线，禁止斜线或弧线');
  }
  segments.push({id:'design-interval-'+i,fromId:a.id,toId:b.id,mode:direction==='lateral'?'crab':'4t4d',direction,
   ...(plans[i-1]!.mode!=='auto'?{strategy:plans[i-1]!.mode}:{}),
   executionProfile:trial.profile as 'recorded_slow_trial',bodyYaw:segmentYaw,endYaw:segmentYaw,wheelAngle,points});
  route.push(...(route.length?points.slice(1):points));
  yaw=segmentYaw;
 }
 const rowId=source.rows[0]?.id??'scan-route-1';
 const row={id:rowId,name:'自定义正交路径',width:source.rows[0]?.width??.6,exitDistance:source.rows[0]?.exitDistance??.8,start:route[0]!,points:route.slice(1)};
 const map=mapSchema.parse({...source,routeMode:'waypoints',rows:[row],motionSegments:segments,order:[rowId],
  tags:source.tags.map(t=>({...t,rowId})),notes:source.notes});
 const validation=validate(map);if(validation.errors.length)throw new Error('路径校验失败：'+validation.errors.join('；'));
 return {map,validation,trimmed:chain.trimmed,lengthM:chain.lengthM,routeGroups:{usedIds:[...new Set(boundaries.map(node=>node.id))],skipped:chain.skipped}};
}
