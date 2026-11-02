import {distance,type Point,type FieldMap} from './model';

export const ROUTE_GRID=.05;
export const GROUP_SNAP=.04;
// Prefer a measured group center to the regular drawing grid.
export function snapRoutePoint(point:Point,centers:Point[],grid=ROUTE_GRID):Point {
 const nearest=centers.reduce<Point|undefined>((best,p)=>distance(point,p)<=GROUP_SNAP+1e-9&&(!best||distance(point,p)<distance(point,best))?p:best,undefined);
 return nearest?{x:nearest.x,y:nearest.y}:{x:Math.round(point.x/grid)*grid,y:Math.round(point.y/grid)*grid};
}
// 1mm：亚毫米级的坐标差（例如两块码的中心差 0.3mm）不应被当成一次拐弯，
// 否则会插入一个几乎重合的拐角点，使后续按拐角串联定位组时失败。
const ALIGN_EPS=.001;
/** 坐标写入精度：所有输出按 1e-6 m 取整，消除浮点尾差。 */
const COORD_MICRO=1e6;
const micro=(value:number)=>Math.round(value*COORD_MICRO)/COORD_MICRO;

/**
 * 把锚点串成正交折线。
 *
 * 关键点：**输出必须真正正交**，不能只是"看起来直"。
 * 之前这里对 ≤ALIGN_EPS 的偏移既不补拐点、也不清零，于是会产出
 * dx=0.0004 / dy=1.2 这种"近竖直"的斜段；后端按 1e-6 判定就报
 * 「第 N 段不是正交线段」。所以这里改成：
 *   1) 小偏差直接吸附到上一段的轴上（清零，而不是保留）；
 *   2) 输出坐标按 1e-6 取整，保证前后端口径一致。
 */
export function orthogonalRoute(anchors:Point[]):Point[] {
 const points:Point[]=[];
 const push=(p:Point)=>{
  const snapped={x:micro(p.x),y:micro(p.y)};
  const last=points.at(-1);
  if(!last||distance(last,snapped)>ALIGN_EPS)points.push(snapped);
 };
 for(const raw of anchors){
  const point={x:micro(raw.x),y:micro(raw.y)};
  const previous=points.at(-1);
  if(!previous){push(point);continue;}
  const dx=Math.abs(point.x-previous.x),dy=Math.abs(point.y-previous.y);
  // 落在同一轴附近：吸附到该轴，保证严格水平/垂直（不产生亚毫米斜段）。
  if(dx<=ALIGN_EPS&&dy<=ALIGN_EPS)continue;
  if(dy<=ALIGN_EPS){push({x:point.x,y:previous.y});continue;}
  if(dx<=ALIGN_EPS){push({x:previous.x,y:point.y});continue;}
  // 真正的斜向移动：按主轴补一个拐角，两段都是严格正交。
  push(dx>=dy?{x:point.x,y:previous.y}:{x:previous.x,y:point.y});
  push(point);
 }
 return points;
}

/**
 * 断言并修正一条已经是"逐点折线"的路径，使其每段严格正交。
 * 用于保存前的最后一道自检：任何 |dx| 与 |dy| 同时 > 1e-6 的段都会被
 * 补上拐点，而不是被后端拒绝。返回修正后的点集与被修正的段数。
 */
export function enforceOrthogonal(points:Point[]):{points:Point[];repaired:number} {
 const out:Point[]=[];
 let repaired=0;
 for(const raw of points){
  const point={x:micro(raw.x),y:micro(raw.y)};
  const previous=out.at(-1);
  if(!previous){out.push(point);continue;}
  const dx=Math.abs(point.x-previous.x),dy=Math.abs(point.y-previous.y);
  if(dx<=ALIGN_EPS&&dy<=ALIGN_EPS)continue;
  if(dy<=ALIGN_EPS){out.push({x:point.x,y:previous.y});continue;}
  if(dx<=ALIGN_EPS){out.push({x:previous.x,y:point.y});continue;}
  repaired++;
  out.push(dx>=dy?{x:point.x,y:previous.y}:{x:previous.x,y:point.y});
  out.push(point);
 }
 return {points:out,repaired};
}
// Promote visible automatic corners to editable waypoints when loading a route.
export function routeCorners(points:Point[]):Point[] {
 const result:Point[]=[];
 for(const p of points){if(result.length&&distance(result.at(-1)!,p)<1e-8)continue;
  while(result.length>=2){const a=result.at(-2)!,b=result.at(-1)!;
   if(Math.abs((b.x-a.x)*(p.y-b.y)-(b.y-a.y)*(p.x-b.x))>1e-8||(b.x-a.x)*(p.x-b.x)+(b.y-a.y)*(p.y-b.y)<=0)break;
   result.pop();
  }result.push({...p});
 }return result;
}

// Editing acquisition and runtime endpoint tolerances are separate. Only exact
// centers on a continuous orthogonal QR-to-QR chain become execution endpoints.
export const ROUTE_GROUP_CAPTURE=.10;
// 两个容差必须分开，不能混用：
// 1) AXIS_EPS：纯数值比较容差（进度区间开闭、端点是否重合），保持极小。
const AXIS_EPS=1e-8;
// 2) COLLINEAR_EPS：判定"两个定位码是否落在同一水平/竖直轴线上"。
//    这是**测量噪声容差**，不是安全门：现场实测同一标称列内的 x 抖动
//    可达 5.4e-5 m（浮点与扫描尾差），用 1e-8 会把本该直线串联的相邻码
//    判成不共线，导致「可直线串联的定位组不足两个」。取 2 mm，比噪声大
//    一个量级以上，又远小于任何真实斜线偏移（厘米级）。
//    端点捕获半径 ROUTE_GROUP_CAPTURE=0.10 m 保持不变，那是安全门。
const COLLINEAR_EPS=2e-3;
export type RouteGroup=Point&{id:number};
export type RouteVisit=RouteGroup&{progress:number,error:number};
export type SkippedRouteGroup=RouteGroup&{distanceM:number};
export function routeGroupCenters(map:Pick<FieldMap,'tags'|'groups'>):RouteGroup[]{
 const references=map.groups?.length?new Set(map.groups.map(g=>g.referenceId)):null;
 return map.tags.filter(t=>!references||references.has(t.id)).map(({id,x,y})=>({id,x,y}));
}
export function distanceToRoute(point:Point,points:Point[]):number{
 if(points.length<2)return points[0]?distance(point,points[0]):Infinity;
 return points.slice(1).reduce((best,b,i)=>{const a=points[i]!,dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
  const t=den?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/den)):0;
  return Math.min(best,distance(point,{x:a.x+dx*t,y:a.y+dy*t}));},Infinity);
}
export function chainRouteGroups(input:Point[],centers:RouteGroup[]){
 const corners=routeCorners(input),progress=[0];
 for(let i=1;i<corners.length;i++)progress.push(progress[i-1]!+distance(corners[i-1]!,corners[i]!));
 const total=progress.at(-1)??0;
 const empty={nodes:[] as RouteVisit[],points:[] as Point[],skipped:[] as SkippedRouteGroup[],trimmed:{startM:0,endM:0},lengthM:0,problem:''};
 if(corners.length<2||!centers.length)return empty;
 type Hit=RouteVisit&{leg:number,projected:Point};
 const projection=(tag:RouteGroup,index:number):Hit=>{
  const a=corners[index]!,b=corners[index+1]!,length=distance(a,b),dx=(b.x-a.x)/length,dy=(b.y-a.y)/length;
  const along=Math.max(0,Math.min(length,(tag.x-a.x)*dx+(tag.y-a.y)*dy));
  const projected={x:a.x+dx*along,y:a.y+dy*along};
  return {...tag,progress:progress[index]!+along,error:distance(tag,projected),leg:index,projected};
 };
 const nearest=(point:Point)=>centers.reduce((best,tag)=>distance(point,tag)<distance(point,best)-AXIS_EPS||Math.abs(distance(point,tag)-distance(point,best))<=AXIS_EPS&&tag.id<best.id?tag:best);
 const start=projection(nearest(corners[0]!),0),end=projection(nearest(corners.at(-1)!),corners.length-2);
 const hits:Hit[]=[];
 for(const tag of centers){
  const visits:Hit[]=[];
  for(let i=0;i<corners.length-1;i++){
   const hit=projection(tag,i);if(hit.error>ROUTE_GROUP_CAPTURE+AXIS_EPS)continue;
   const previous=visits.at(-1);
   // Two projections around one corner are one visit; later return passes are
   // retained so the same physical QR can correct both outbound and return legs.
   if(previous&&hit.progress-previous.progress<=2*ROUTE_GROUP_CAPTURE+AXIS_EPS){
    if(hit.error<previous.error-AXIS_EPS)visits[visits.length-1]=hit;
   }else visits.push(hit);
  }
  hits.push(...visits.filter(hit=>hit.progress>=start.progress-ROUTE_GROUP_CAPTURE-AXIS_EPS&&hit.progress<=end.progress+ROUTE_GROUP_CAPTURE+AXIS_EPS));
 }
 hits.push(start,end);hits.sort((a,b)=>a.progress-b.progress||a.error-b.error||a.id-b.id);
 const candidates:Hit[]=[],lastProgress=new Map<number,number>();
 for(const hit of hits){if(Math.abs((lastProgress.get(hit.id)??-Infinity)-hit.progress)<AXIS_EPS)continue;candidates.push(hit);lastProgress.set(hit.id,hit.progress);if(candidates.length>2001)break;}
 if(candidates.length>2001)return {...empty,problem:'路径候选定位组过多，请拆分路线'};
 const straight=(a:Hit,b:Hit)=>{
  const dx=b.x-a.x,dy=b.y-a.y;
  if(a.id===b.id||b.progress-a.progress<AXIS_EPS||Math.hypot(dx,dy)<.001)return false;
  const horizontal=Math.abs(dy)<=COLLINEAR_EPS,vertical=Math.abs(dx)<=COLLINEAR_EPS;
  if(!horizontal&&!vertical)return false;
  if(b.progress-a.progress>distance(a,b)+4*ROUTE_GROUP_CAPTURE+AXIS_EPS)return false;
  const drawnDelta=horizontal?b.projected.x-a.projected.x:b.projected.y-a.projected.y;
  if(Math.sign(drawnDelta)!==Math.sign(horizontal?dx:dy))return false;
  // A shifted turn can snap onto a nearby QR; a genuine turn/return cannot be
  // shortcut or moved between two codes, where the executor cannot change mode.
  for(let k=a.leg+1;k<=b.leg;k++){
   if(progress[k]!<=a.progress+AXIS_EPS||progress[k]!>=b.progress-AXIS_EPS)continue;
   if(Math.min(distance(corners[k]!,a),distance(corners[k]!,b))>ROUTE_GROUP_CAPTURE+AXIS_EPS)return false;
  }
  return true;
 };
 const counts=candidates.map(()=>0),previous=candidates.map(()=>-1),startCost=candidates.map(()=>Infinity);
 for(let j=0;j<candidates.length;j++){
  const b=candidates[j]!;
  // Prefer the nearest feasible endpoint. A nearby non-collinear outlier may
  // be skipped in favor of the real grid node, instead of blocking the editor.
  if(b.progress<=start.progress+ROUTE_GROUP_CAPTURE+AXIS_EPS&&distance(b,start)<=ROUTE_GROUP_CAPTURE+AXIS_EPS){counts[j]=1;startCost[j]=distance(corners[0]!,b);}
  for(let i=0;i<j;i++){
   if(!counts[i]||!straight(candidates[i]!,b))continue;
   const count=counts[i]!+1;
   if(count>counts[j]!||count===counts[j]&&startCost[i]!<startCost[j]!){counts[j]=count;previous[j]=i;startCost[j]=startCost[i]!;}
  }
 }
 let best=-1,bestCost=Infinity;
 for(let j=0;j<candidates.length;j++){
  const node=candidates[j]!,cost=startCost[j]!+distance(corners.at(-1)!,node);
  if(counts[j]!<2||node.progress<end.progress-ROUTE_GROUP_CAPTURE-AXIS_EPS||distance(node,end)>ROUTE_GROUP_CAPTURE+AXIS_EPS)continue;
  if(best<0||counts[j]!>counts[best]!||counts[j]===counts[best]&&cost<bestCost){best=j;bestCost=cost;}
 }
 const nodes:RouteVisit[]=[];
 for(let i=best;i>=0;i=previous[i]!) {const {id,x,y,progress,error}=candidates[i]!;nodes.push({id,x,y,progress,error});}
 nodes.reverse();
 // Endpoint snapping may move a whole straight onto a grid row. Capture every
 // exact center on that final straight as well, so no QR is driven over without
 // becoming its own correction boundary.
 const expanded:RouteVisit[]=[];
 for(let i=1;i<nodes.length;i++){
  const a=nodes[i-1]!,b=nodes[i]!,horizontal=Math.abs(a.y-b.y)<=COLLINEAR_EPS;
  if(!expanded.length)expanded.push(a);
  const delta=horizontal?b.x-a.x:b.y-a.y;
  const middle=centers.map(tag=>({tag,fraction:((horizontal?tag.x:tag.y)-(horizontal?a.x:a.y))/delta}))
   .filter(({tag,fraction})=>fraction>AXIS_EPS&&fraction<1-AXIS_EPS&&Math.abs(horizontal?tag.y-a.y:tag.x-a.x)<=COLLINEAR_EPS)
   .sort((p,q)=>p.fraction-q.fraction||p.tag.id-q.tag.id);
  for(const {tag,fraction} of middle)expanded.push({...tag,progress:a.progress+(b.progress-a.progress)*fraction,error:0});
  expanded.push(b);
 }
 if(expanded.length>2001)return {...empty,problem:'路径候选定位组过多，请拆分路线'};
 nodes.splice(0,nodes.length,...expanded);
 const used=new Set(nodes.map(node=>node.id)),skippedById=new Map<number,SkippedRouteGroup>();
 for(const hit of candidates){
  if(used.has(hit.id)||hit.error>ROUTE_GROUP_CAPTURE+AXIS_EPS||best<0&&hit.error<=AXIS_EPS)continue;
  const existing=skippedById.get(hit.id);
  if(!existing||hit.error<existing.distanceM)skippedById.set(hit.id,{id:hit.id,x:hit.x,y:hit.y,distanceM:hit.error});
 }
 const points=nodes.map(({x,y})=>({x,y}));
 const lengthM=points.slice(1).reduce((sum,point,i)=>sum+distance(points[i]!,point),0);
 return {nodes,points,skipped:[...skippedById.values()],trimmed:{startM:nodes[0]?.progress??0,endM:Math.max(0,total-(nodes.at(-1)?.progress??total))},lengthM,
  problem:best<0?'可直线串联的定位组不足两个；拐弯或折返处缺少定位组时，请把路线画过组中心或调整铺码':''};
}
