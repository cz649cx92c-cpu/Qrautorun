import {mapSchema,validate,distance,type FieldMap,type Point} from './model';
const rad=Math.PI/180;
const wrapDeg=(a:number)=>((a+180)%360+360)%360-180;
const axis=(a:number)=>((a+45)%90+90)%90-45;
const wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a));
const median=(a:number[])=>{const s=[...a].sort((x,y)=>x-y),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
export type AxisEstimate={ready:boolean;rotationDeg:number|null;axisDeg:number|null;confidence:number;reason:string;inlierCount:number;pairCount:number};
// Neighbor consensus modulo 90 degrees: diagonals and remote centers are not presumed axial.
export function estimateMapAlignment(map:{tags:Point[]}):AxisEstimate{
 const unique=new Map<string,Point>();for(const p of map.tags)if(Number.isFinite(p.x)&&Number.isFinite(p.y))unique.set(p.x+','+p.y,p);
 const points=[...unique.values()],pairs=new Map<string,{a:number;b:number;angle:number;weight:number;length:number}>(),nearest:number[]=[];
 const unavailable=(reason:string,confidence=0,inlierCount=0):AxisEstimate=>({ready:false,rotationDeg:null,axisDeg:null,confidence,reason,inlierCount,pairCount:pairs.size});
 if(points.length<3)return unavailable('至少需要三个不同的可靠码中心；可手动输入角度');
 points.forEach((p,i)=>{const neighbors=points.map((q,j)=>({j,d:distance(p,q)})).filter(q=>q.d>=.08).sort((a,b)=>a.d-b.d);if(neighbors.length)nearest.push(neighbors[0].d);for(const n of neighbors.slice(0,2)){const a=Math.min(i,n.j),b=Math.max(i,n.j),p=points[a],q=points[b];pairs.set(a+':'+b,{a,b,angle:axis(Math.atan2(q.y-p.y,q.x-p.x)/rad),weight:1/n.d,length:n.d});}});
 if(nearest.length===0)return unavailable('定位点基线不足');
 const cutoff=median(nearest)*3,candidates=[...pairs.values()].filter(p=>p.length<=cutoff);pairs.clear();for(const p of candidates)pairs.set(p.a+':'+p.b,p);
 if(candidates.length<2)return unavailable('可靠连线不足');
 const score=(angle:number)=>candidates.filter(p=>Math.abs(axis(p.angle-angle))<=6);
 let best=score(candidates[0].angle);for(const p of candidates){const group=score(p.angle);if(group.reduce((s,p)=>s+p.weight,0)>best.reduce((s,p)=>s+p.weight,0))best=group;}
 const weight=best.reduce((s,p)=>s+p.weight,0),total=candidates.reduce((s,p)=>s+p.weight,0),confidence=weight/total,ids=new Set(best.flatMap(p=>[p.a,p.b]));
 if(confidence<.6||best.length<2||ids.size<3)return unavailable('主轴一致性不足；请检查预览或手动输入角度',confidence,best.length);
 const angle=axis(Math.atan2(best.reduce((s,p)=>s+Math.sin(p.angle*4*rad)*p.weight,0),best.reduce((s,p)=>s+Math.cos(p.angle*4*rad)*p.weight,0))/(4*rad));
 return {ready:true,rotationDeg:-angle,axisDeg:angle,confidence,reason:'近邻连线主轴估计；仅调整坐标方向，不代表精度提升',inlierCount:best.length,pairCount:candidates.length};
}
export type DiagnosticPoint=Point&{yaw?:number;angle?:number};
export function applyMapAlignment<T extends DiagnosticPoint>(source:FieldMap,rotationDeg:number,diagnosticTrail:T[]=[]){
 if(Number.isFinite(rotationDeg)===false)throw new Error('旋转角度必须为有限数');
 const map=mapSchema.parse(source);if(map.tags.length===0)throw new Error('地图没有有效定位点');
 const angle=wrapDeg(rotationDeg),a=angle*rad,c=Math.cos(a),s=Math.sin(a),origin={x:map.tags.reduce((n,p)=>n+p.x,0)/map.tags.length,y:map.tags.reduce((n,p)=>n+p.y,0)/map.tags.length};
 const rotate=<P extends Point>(p:P):P=>{if(Number.isFinite(p.x)===false||Number.isFinite(p.y)===false)throw new Error('轨迹坐标必须为有限数');return angle===0?{...p}:{...p,x:origin.x+c*(p.x-origin.x)-s*(p.y-origin.y),y:origin.y+s*(p.x-origin.x)+c*(p.y-origin.y)};};
 const result=mapSchema.parse({...map,coordinateStatus:'draft',tags:map.tags.map(t=>({...rotate(t),angle:wrapDeg(t.angle+angle)})),zone:map.zone.map(rotate),rows:map.rows.map(r=>({...r,...(r.start?{start:rotate(r.start)}:{}),points:r.points.map(rotate)})),...(map.motionSegments?{motionSegments:map.motionSegments.map(segment=>({...segment,bodyYaw:wrap(segment.bodyYaw+a),endYaw:wrap(segment.endYaw+a),points:segment.points.map(rotate)}))}:{})});
 const trail=diagnosticTrail.map(p=>{if(p.yaw===undefined?false:Number.isFinite(p.yaw)===false)throw new Error('轨迹朝向必须为有限数');return {...rotate(p),...(p.yaw===undefined?{}:{yaw:wrap(p.yaw+a)}),...(p.angle===undefined?{}:{angle:wrapDeg(p.angle+angle)})};});
 return {map:result,diagnosticTrail:trail,transform:{rotationDeg:angle,origin}};
}
export interface OrthogonalFitOptions {rotationDeg?:number;toleranceM?:number;maxFitDisplacementM?:number;}
export interface FittedPoint {id:number;before:Point;aligned:Point;after:Point;displacementM:number;fitDisplacementM:number;outlier:boolean;}
export interface OrthogonalFit {ready:boolean;map:FieldMap|null;reason:string;points:FittedPoint[];outlierIds:number[];maxDisplacementM:number;maxFitDisplacementM:number;maxDistanceChangeM:number;distanceChanges:{fromId:number;toId:number;beforeM:number;afterM:number;changeM:number}[];rotationDeg:number|null;}
// Optional nonrigid preview only. Existing navigation geometry must be redesigned separately.
export function fitOrthogonalMap(source:FieldMap,options:OrthogonalFitOptions={}):OrthogonalFit{
 const result:OrthogonalFit={ready:false,map:null,reason:'',points:[],outlierIds:[],maxDisplacementM:0,maxFitDisplacementM:0,maxDistanceChangeM:0,distanceChanges:[],rotationDeg:null};
 const map=mapSchema.parse(source),tolerance=options.toleranceM??.05,limit=options.maxFitDisplacementM??.05;
 if(Number.isFinite(tolerance)===false||tolerance<=0||tolerance>.25||Number.isFinite(limit)===false||limit<=0||limit>.25)throw new Error('拟合容差和位移上限必须在0到0.25米之间');
 if((map.routeMode==='map-only')===false){result.reason='非刚体拟合仅适用于没有导航路径的定位码地图';return result;}
 const estimated=estimateMapAlignment(map),rotation=options.rotationDeg??estimated.rotationDeg;
 if(rotation===null){result.reason=estimated.reason;return result;}
 const aligned=applyMapAlignment(map,rotation).map;result.rotationDeg=rotation;
 const cluster=(coordinate:'x'|'y')=>{const sorted=[...aligned.tags].sort((a,b)=>a[coordinate]-b[coordinate]),groups:typeof sorted[]=[],targets=new Map<number,number>();for(const tag of sorted){const g=groups[groups.length-1];if(g&&tag[coordinate]-g[0][coordinate]<=2*tolerance&&Math.abs(tag[coordinate]-median(g.map(p=>p[coordinate])))<=tolerance)g.push(tag);else groups.push([tag]);}for(const g of groups)if(g.length>=2){const target=median(g.map(p=>p[coordinate]));for(const p of g)targets.set(p.id,target);}return targets;};
 const columns=cluster('x'),rows=cluster('y');
 const tags=aligned.tags.map((tag,i)=>{const before=map.tags[i],after={...tag,x:columns.get(tag.id)??tag.x,y:rows.get(tag.id)??tag.y},outlier=columns.has(tag.id)===false&&rows.has(tag.id)===false,displacementM=distance(before,after),fitDisplacementM=distance(tag,after);result.points.push({id:tag.id,before:{x:before.x,y:before.y},aligned:{x:tag.x,y:tag.y},after:{x:after.x,y:after.y},displacementM,fitDisplacementM,outlier});if(outlier)result.outlierIds.push(tag.id);result.maxDisplacementM=Math.max(result.maxDisplacementM,displacementM);result.maxFitDisplacementM=Math.max(result.maxFitDisplacementM,fitDisplacementM);return after;});
 for(let i=0;i<tags.length;i++)for(let j=i+1;j<tags.length;j++){const beforeM=distance(map.tags[i],map.tags[j]),afterM=distance(tags[i],tags[j]),changeM=afterM-beforeM;result.maxDistanceChangeM=Math.max(result.maxDistanceChangeM,Math.abs(changeM));result.distanceChanges.push({fromId:tags[i].id,toId:tags[j].id,beforeM,afterM,changeM});}
 if(columns.size===0&&rows.size===0){result.reason='没有足够的同排同列支持点';return result;}
 if(result.maxFitDisplacementM>limit){result.reason='拟合位移超过显式上限';return result;}
 const fitted=mapSchema.parse({...aligned,tags}),validation=validate(fitted);if(validation.errors.length){result.reason=validation.errors.join('；');return result;}
 result.ready=true;result.map=fitted;result.reason='同排同列中位数拟合预览；距离可能改变，不代表实测精度提升，须显式保存新版本';return result;
}
