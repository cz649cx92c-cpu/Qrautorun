import {z} from 'zod';
import {distance,mapSchema,pointSchema,validate,type FieldMap,type Point} from '../../shared/model';
import {routeCorners} from '../../shared/route-design';
import trial from '../../../src/greenhouse_navigation/greenhouse_navigation/recorded_trial_limits.json' with {type:'json'};

export const routeDesignSchema=z.object({
 mapId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),baseVersion:z.number().int().positive(),
 points:z.array(pointSchema).min(2).max(501),bodyYawDeg:z.number().finite().min(-180).max(180)
}).strict();
const wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a));
const ENDPOINT_TOLERANCE=.03;
const EPS=1e-8;
type Hit={id:number,progress:number,point:Point,error:number};

export function compileDesignedRoute(source:FieldMap,input:Point[],bodyYawDeg:number){
 if(!Number.isFinite(bodyYawDeg)||Math.abs(bodyYawDeg)>180)throw new Error('车头朝向必须为 -180 到 180 度');
 if(input.length<2||input.length>501)throw new Error('路径需要 2–501 个控制点');
 const raw=input.map(p=>pointSchema.parse(p));
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
 const centers=source.groups?.length?source.tags.filter(t=>source.groups!.some(g=>g.referenceId===t.id)):source.tags;
 const hits:Hit[]=[];
 for(let i=1;i<corners.length;i++){
  const a=corners[i-1]!,b=corners[i]!,length=distance(a,b),dx=(b.x-a.x)/length,dy=(b.y-a.y)/length;
  for(const tag of centers){
   let along=Math.max(0,Math.min(length,(tag.x-a.x)*dx+(tag.y-a.y)*dy));
   // A group within endpoint tolerance belongs to the actual corner, not to two
   // tiny intervals on either side of it. Keep the polyline strictly orthogonal.
   if(distance(tag,a)<=ENDPOINT_TOLERANCE)along=0;
   else if(distance(tag,b)<=ENDPOINT_TOLERANCE)along=length;
   const point={x:a.x+dx*along,y:a.y+dy*along},error=distance(tag,point);
   if(error<=ENDPOINT_TOLERANCE)hits.push({id:tag.id,progress:progress[i-1]!+along,point,error});
  }
 }
 hits.sort((a,b)=>a.progress-b.progress||a.error-b.error||a.id-b.id);
 const boundaries:Hit[]=[];
 for(const hit of hits){const previous=boundaries.at(-1);
  if(previous&&Math.abs(previous.progress-hit.progress)<.001){
   if(previous.id!==hit.id)throw new Error('同一路点匹配多个定位组，请检查组中心坐标');
   continue;
  }boundaries.push(hit);
 }
 if(boundaries.length<2)throw new Error('路径须经过至少两个定位组中心（允许误差3厘米）；请将起终点吸附到定位组');
 if(boundaries.length>101)throw new Error('定位组区间不能超过100段，请拆分任务');
 const bodyYaw=wrap(bodyYawDeg*Math.PI/180),segments:NonNullable<FieldMap['motionSegments']>=[],route:Point[]=[];
 for(let i=1;i<boundaries.length;i++){
  const a=boundaries[i-1]!,b=boundaries[i]!;
  if(distance(a.point,b.point)<.08)throw new Error('相邻定位组区间端点距离不足8厘米，请调整路径');
  const interior=corners.filter((_,j)=>progress[j]!>a.progress+EPS&&progress[j]!<b.progress-EPS);
  const line=routeCorners([a.point,...interior,b.point]);
  if(line.length!==2)throw new Error(`Q${a.id} → Q${b.id} 的拐弯或折返处缺少定位组；请在定位组中心换向`);
  const tangent=Math.atan2(b.point.y-a.point.y,b.point.x-a.point.x),angle=Math.abs(wrap(tangent-bodyYaw));
  const direction=angle<=Math.PI/4+EPS?'forward':angle>=3*Math.PI/4-EPS?'reverse':'lateral';
  if(direction!=='lateral'&&Math.abs(wrap(tangent-bodyYaw-(direction==='reverse'?Math.PI:0)))>.10)
   throw new Error('前进/倒车区间与车头朝向偏差超过5.7度；请调整车头朝向，使其沿水平或垂直轴');
  let wheelAngle=direction==='lateral'?wrap(tangent-bodyYaw)*180/Math.PI:0;
  if(wheelAngle>90)wheelAngle-=180;if(wheelAngle< -90)wheelAngle+=180;
  const n=Math.min(999,Math.max(2,Math.ceil(distance(a.point,b.point)/.05)));
  if(route.length+n+(route.length?0:1)>1001)throw new Error('加密路线超过1001点，请缩短路径或拆分任务');
  const points=Array.from({length:n+1},(_,j)=>({x:a.point.x+(b.point.x-a.point.x)*j/n,y:a.point.y+(b.point.y-a.point.y)*j/n}));
  segments.push({id:'design-interval-'+i,fromId:a.id,toId:b.id,mode:direction==='lateral'?'crab':'4t4d',direction,
   executionProfile:trial.profile as 'recorded_slow_trial',bodyYaw,endYaw:bodyYaw,wheelAngle,points});
  route.push(...(route.length?points.slice(1):points));
 }
 const rowId=source.rows[0]?.id??'scan-route-1';
 const row={id:rowId,name:'自定义正交路径',width:source.rows[0]?.width??.6,exitDistance:source.rows[0]?.exitDistance??.8,start:route[0]!,points:route.slice(1)};
 const map=mapSchema.parse({...source,routeMode:'waypoints',rows:[row],motionSegments:segments,order:[rowId],
  tags:source.tags.map(t=>({...t,rowId})),notes:source.notes});
 const validation=validate(map);if(validation.errors.length)throw new Error('路径校验失败：'+validation.errors.join('；'));
 return {map,validation,trimmed:{startM:boundaries[0]!.progress,endM:progress.at(-1)!-boundaries.at(-1)!.progress},lengthM:boundaries.at(-1)!.progress-boundaries[0]!.progress};
}
