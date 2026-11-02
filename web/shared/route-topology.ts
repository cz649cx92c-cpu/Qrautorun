import {z} from 'zod';
import {distance,pointSchema,type Point} from './model';
import {routeCorners} from './route-design';
import {micro} from './route-geometry';
import {orderMotionSegmentsByChain} from './route';
import {strategyModeSchema,strategyOptions,type SegmentChoice} from './segment-strategy';

/**
 * Route topology: a directed route expressed with the **QR codes as vertices**.
 *
 * A stored `Route` keeps two parallel descriptions: `points` (a copied polyline)
 * and `motionSegments` (fromId → toId intervals). Neither is a graph: a repeated
 * pass over the same pair of codes is only distinguishable by array order, and a
 * point can drift away from the QR centre it was meant to bind to. This module
 * adds the missing layer:
 *
 *   - `RouteTopology` is the source of truth: nodes are real tag IDs, edges are
 *     directed QR→QR passes with an explicit `occurrence` (the 1-based "how many
 *     times this pair has been driven" counter), plus the driver's intent
 *     (`mode` / `direction` / `strategy`) and optional editable waypoints.
 *   - `topologyToPoints` renders that graph into the orthogonal polyline that the
 *     **existing** `compileDesignedRoute` already consumes. Geometry is a render
 *     result: map tag centres are never written, moved or snapped here, and the
 *     compiler's own limits (orthogonality, 8 cm leg, 50 m, 501 points, 100
 *     intervals, 1001 densified points) are neither bypassed nor relaxed.
 *
 * Every function is pure: arguments are never mutated, coordinates are rounded to
 * micron resolution (`1e-6 m`), and a rejected edit returns the input topology
 * unchanged together with a Chinese `issues` entry the UI can show verbatim.
 */

export interface TopologyNode {
 /** Real AprilTag ID. A topology may only reference codes that exist in the map. */
 tagId:number;
}

export interface TopologyEdge {
 fromId:number;
 toId:number;
 /** 1-based, contiguous per (fromId,toId) in route order: "the Nth pass over this pair". */
 occurrence:number;
 mode:'4t4d'|'crab';
 direction:'forward'|'reverse'|'lateral';
 /** Editable intermediate points of this interval. Never tag coordinates. */
 waypoints?:Point[];
 /** Planner strategy intent; re-planned by the compiler and reported back on drift. */
 strategy?:string;
}

export interface RouteTopology {
 nodes:TopologyNode[];
 edges:TopologyEdge[];
}

export interface TopologyTagCenter {
 id:number;
 x:number;
 y:number;
}

export interface TopologyIssue {
 severity:'error'|'warning';
 code:string;
 message:string;
 edgeIndex?:number;
 tagIds?:number[];
 occurrence?:number;
}

export interface TopologyReport {
 errors:TopologyIssue[];
 warnings:TopologyIssue[];
}

/** A stored motion interval, as much of it as the topology needs to restore it. */
export interface StoredSegmentLike {
 fromId:number;
 toId:number;
 mode:'4t4d'|'crab';
 direction:'forward'|'reverse'|'lateral';
 strategy?:string;
 points?:Point[];
}

export interface TopologyConversion {
 topology:RouteTopology;
 issues:TopologyIssue[];
}

export interface TopologyPoints {
 points:Point[];
 issues:TopologyIssue[];
}

/** An edge being added; `occurrence` may be omitted and is then taken from the route order. */
export type TopologyEdgeDraft = Omit<TopologyEdge,'occurrence'> & {occurrence?:number};

/** Floating-point tolerance for "the same coordinate / the same axis" (matches the compiler). */
const AXIS_EPS=1e-6;
/** Measurement-noise tolerance for "these two codes are meant to share a row/column". */
const COLLINEAR_EPS=2e-3;

const issue=(severity:'error'|'warning',code:string,message:string,extra:Partial<TopologyIssue>={}):TopologyIssue=>({...extra,severity,code,message});

const directionLabel:Record<TopologyEdge['direction'],string>={forward:'前进',reverse:'倒车',lateral:'横移'};
const strategyLabels:Map<string,string>=new Map(strategyOptions.map(option=>[option.value,option.label]));

const centersOf=(tagCenters:readonly TopologyTagCenter[])=>{
 const centers=new Map<number,TopologyTagCenter>();
 for(const center of tagCenters??[]){
  if(!center||!Number.isFinite(center.id)||!Number.isFinite(center.x)||!Number.isFinite(center.y))continue;
  if(!centers.has(center.id))centers.set(center.id,{id:center.id,x:center.x,y:center.y});
 }
 return centers;
};

const cloneTopology=(topology:RouteTopology):RouteTopology=>({
 nodes:(topology?.nodes??[]).map(node=>({tagId:node.tagId})),
 edges:(topology?.edges??[]).map(edge=>({
  fromId:edge.fromId,toId:edge.toId,occurrence:edge.occurrence,mode:edge.mode,direction:edge.direction,
  ...(edge.strategy!==undefined?{strategy:edge.strategy}:{}),
  ...(edge.waypoints?{waypoints:edge.waypoints.map(point=>({x:point.x,y:point.y}))}:{}),
 })),
});

const pairKey=(fromId:number,toId:number)=>fromId+'>'+toId;
const edgeKey=(edge:TopologyEdge)=>pairKey(edge.fromId,edge.toId)+'#'+edge.occurrence;

// --- wire format ------------------------------------------------------------

/**
 * Strict request/response shape for the topology endpoints. `.strict()` on every
 * object: an unknown field is a client bug and must not be silently dropped.
 */
/**
 * 保存拓扑 ≠ 允许实车执行。
 * 这里写死这条文案，是因为「画完图就能跑」是最危险的一种误解：拓扑只描述
 * 码与码之间的有向通过关系，能不能执行仍由导航编译安全门、定位锚定与设备
 * 就绪条件共同决定。
 */
export const TOPOLOGY_DISCLAIMER = '拓扑只描述码与码之间的有向经过关系；保存拓扑不会解锁实车执行，能否导航仍由路径编译安全门、定位锚定与设备就绪条件决定。';

export const topologyNodeSchema=z.object({tagId:z.number().int().min(0).max(586)}).strict();
export const topologyEdgeSchema=z.object({
 fromId:z.number().int().min(0).max(586),
 toId:z.number().int().min(0).max(586),
 occurrence:z.number().int().min(1).max(100),
 mode:z.enum(['4t4d','crab']),
 direction:z.enum(['forward','reverse','lateral']),
 waypoints:z.array(pointSchema).max(500).optional(),
 strategy:z.string().max(40).optional(),
}).strict();
export const routeTopologySchema=z.object({
 nodes:z.array(topologyNodeSchema).min(1).max(587),
 edges:z.array(topologyEdgeSchema).min(1).max(100),
}).strict();

// --- restore a topology from stored intervals -------------------------------

/**
 * Restore `{topology, issues}` from `route.motionSegments`.
 *
 * Intervals are ordered by the stable fromId→toId chain (`orderMotionSegmentsByChain`),
 * never by array index, so a route whose stored array was shuffled still yields the
 * same topology. A broken or cyclic chain is reported as an issue and **every**
 * interval is kept (best effort), because silently dropping a pass would change
 * what the robot drives.
 */
export function topologyFromSegments(segments:readonly StoredSegmentLike[]):TopologyConversion{
 const issues:TopologyIssue[]=[];
 if(!Array.isArray(segments)||!segments.length){
  issues.push(issue('error','empty-segments','路径没有任何区间，无法还原路线拓扑'));
  return {topology:{nodes:[],edges:[]},issues};
 }
 const valid:StoredSegmentLike[]=[];
 for(const [index,segment] of segments.entries()){
  if(!segment||!Number.isInteger(segment.fromId)||!Number.isInteger(segment.toId)){
   issues.push(issue('error','bad-segment',`第 ${index+1} 段缺少合法的 fromId/toId`));
   continue;
  }
  valid.push(segment);
 }
 if(!valid.length)return {topology:{nodes:[],edges:[]},issues};

 const ordered=orderMotionSegmentsByChain(valid);
 const toIds=new Set(valid.map(segment=>segment.toId));
 for(let index=1;index<ordered.length;index++){
  if(ordered[index]!.fromId===ordered[index-1]!.toId)continue;
  issues.push(issue('warning','broken-chain',
   `区间链在 Q${ordered[index-1]!.toId} → Q${ordered[index]!.fromId} 处断开，已保留全部区间（未丢弃任何一段）`,
   {edgeIndex:index,tagIds:[ordered[index-1]!.toId,ordered[index]!.fromId]}));
 }
 if(valid.length>1&&valid.every(segment=>toIds.has(segment.fromId))){
  issues.push(issue('warning','cyclic-chain',`${valid.length} 段区间首尾相接成环；已保留全部区间，但起点不唯一`));
 }

 const nodes:TopologyNode[]=[],edges:TopologyEdge[]=[];
 const seenNodes=new Set<number>(),seenPairs=new Map<string,number>();
 for(const segment of ordered){
  for(const id of [segment.fromId,segment.toId])if(!seenNodes.has(id)){seenNodes.add(id);nodes.push({tagId:id});}
  if(segment.fromId===segment.toId){
   issues.push(issue('error','self-loop',`区间 Q${segment.fromId}→Q${segment.toId} 起点与终点是同一个二维码`,{tagIds:[segment.fromId]}));
  }
  const key=pairKey(segment.fromId,segment.toId);
  const occurrence=(seenPairs.get(key)??0)+1;
  seenPairs.set(key,occurrence);
  const edge:TopologyEdge={fromId:segment.fromId,toId:segment.toId,occurrence,mode:segment.mode,direction:segment.direction};
  if(segment.strategy!==undefined)edge.strategy=segment.strategy;
  const waypoints=segment.points&&segment.points.length>=2
   ?routeCorners(segment.points).slice(1,-1).map(point=>({x:micro(point.x),y:micro(point.y)}))
   :[];
  if(waypoints.length)edge.waypoints=waypoints;
  edges.push(edge);
 }
 return {topology:{nodes,edges},issues};
}

// --- render a topology into compiler input ----------------------------------

/**
 * Flatten the topology into the orthogonal polyline `compileDesignedRoute` eats.
 *
 * Each edge starts at its `fromId` centre, runs through its waypoints and ends at
 * its `toId` centre. Every endpoint must exist in `tagCenters`: a topology may
 * never reference a code the map does not have, so a missing centre is an error
 * (`missing-tag`) and the point is not invented. Duplicate consecutive points are
 * collapsed, coordinates rounded to 1e-6 m; no corner is fabricated, because the
 * compiler decides interval boundaries from the real tag centres.
 */
export function topologyToPoints(topology:RouteTopology,tagCenters:readonly TopologyTagCenter[]):TopologyPoints{
 const points:Point[]=[],issues:TopologyIssue[]=[];
 if(!topology||!Array.isArray(topology.edges)){
  issues.push(issue('error','bad-topology','路线拓扑必须是 {nodes,edges} 结构'));
  return {points,issues};
 }
 const centers=centersOf(tagCenters);
 const push=(raw:Point)=>{
  const point={x:micro(raw.x),y:micro(raw.y)};
  const last=points.at(-1);
  if(last&&Math.abs(last.x-point.x)<=AXIS_EPS&&Math.abs(last.y-point.y)<=AXIS_EPS)return;
  points.push(point);
 };
 for(const [index,edge] of topology.edges.entries()){
  const label=`第 ${index+1} 段（Q${edge.fromId}→Q${edge.toId}）`;
  const from=centers.get(edge.fromId),to=centers.get(edge.toId);
  if(!from)issues.push(issue('error','missing-tag',`${label} 的起点 Q${edge.fromId} 在地图上不存在`,{edgeIndex:index,tagIds:[edge.fromId]}));
  if(!to)issues.push(issue('error','missing-tag',`${label} 的终点 Q${edge.toId} 在地图上不存在`,{edgeIndex:index,tagIds:[edge.toId]}));
  if(from)push(from);
  for(const waypoint of edge.waypoints??[])push(waypoint);
  if(to)push(to);
 }
 if(points.length<2)issues.push(issue('error','too-few-points','展平后的路线不足两个控制点，无法编译'));
 return {points,issues};
}

// --- validation -------------------------------------------------------------

/**
 * Structural + geometric validation of a topology against the map's tag centres.
 *
 * `errors` block a save; `warnings` are advisory. Invariants enforced here:
 *   - every node / edge endpoint is a real tag that exists in the map;
 *   - no self loop, and `mode==='crab'` must pair with `direction==='lateral'`;
 *   - edges form one continuous chain (each edge starts where the previous ended);
 *   - for one (fromId,toId) pair the occurrences are unique and run 1..N in route
 *     order — that is the only correct way to express "driven twice";
 *   - each edge's two centres share a row or a column (the compiler can only emit
 *     straight, axis-aligned intervals), and waypoint legs stay horizontal/vertical.
 */
export function validateTopology(topology:RouteTopology,tagCenters:readonly TopologyTagCenter[]):TopologyReport{
 const errors:TopologyIssue[]=[],warnings:TopologyIssue[]=[];
 const fail=(code:string,message:string,extra:Partial<TopologyIssue>={})=>errors.push(issue('error',code,message,extra));
 const warn=(code:string,message:string,extra:Partial<TopologyIssue>={})=>warnings.push(issue('warning',code,message,extra));
 if(!topology||!Array.isArray(topology.nodes)||!Array.isArray(topology.edges)){
  fail('bad-topology','路线拓扑必须是 {nodes,edges} 结构');
  return {errors,warnings};
 }
 const centers=centersOf(tagCenters);
 const nodeIds=new Set<number>();
 for(const [index,node] of topology.nodes.entries()){
  const id=node?.tagId;
  if(!Number.isInteger(id)||id<0||id>586){fail('bad-node',`第 ${index+1} 个顶点不是有效的二维码编号`);continue;}
  if(nodeIds.has(id))fail('duplicate-node',`顶点 Q${id} 被重复列出`,{tagIds:[id]});
  nodeIds.add(id);
  if(!centers.has(id))fail('unknown-tag',`路线顶点 Q${id} 在地图上不存在`,{tagIds:[id]});
 }
 if(!topology.edges.length)fail('empty-topology','路线拓扑至少需要一个二维码区间');

 const usedTags=new Set<number>();
 const pairOccurrences=new Map<string,{occurrence:number;edgeIndex:number}[]>();
 for(const [index,edge] of topology.edges.entries()){
  const label=`第 ${index+1} 段（Q${edge.fromId}→Q${edge.toId}）`;
  if(!Number.isInteger(edge.occurrence)||edge.occurrence<1)fail('bad-occurrence',`${label} 的 occurrence 必须是正整数`,{edgeIndex:index,occurrence:edge.occurrence});
  if(edge.fromId===edge.toId)fail('self-loop',`${label} 起点与终点是同一个二维码，不允许自环`,{edgeIndex:index,tagIds:[edge.fromId]});
  if((edge.mode==='crab')!==(edge.direction==='lateral'))fail('mode-direction',`${label} 的模式与方向不一致：crab 只能对应 lateral`,{edgeIndex:index,tagIds:[edge.fromId,edge.toId]});
  for(const id of [edge.fromId,edge.toId]){
   usedTags.add(id);
   if(!nodeIds.has(id))fail('unknown-node',`${label} 的端点 Q${id} 不在 nodes 顶点表里`,{edgeIndex:index,tagIds:[id]});
   if(!centers.has(id))fail('unknown-tag',`${label} 的端点 Q${id} 在地图上不存在`,{edgeIndex:index,tagIds:[id]});
  }
  const a=centers.get(edge.fromId),b=centers.get(edge.toId);
  if(a&&b&&(a.x!==b.x||a.y!==b.y)){
   const dx=Math.abs(a.x-b.x),dy=Math.abs(a.y-b.y);
   if(dx>COLLINEAR_EPS&&dy>COLLINEAR_EPS)fail('diagonal-edge',
    `${label} 的两个二维码既不同行也不同列，无法编译成直线区间；请在拐角处补一个二维码并拆成两段`,
    {edgeIndex:index,tagIds:[a.id,b.id]});
   else if(dx>AXIS_EPS&&dy>AXIS_EPS)warn('near-aligned',
    `${label} 的两个二维码近似同行/同列，但仍有 ${(Math.min(dx,dy)*100).toFixed(2)} cm 抖动；编译器可能拒绝该段，请先校正地图点位`,
    {edgeIndex:index,tagIds:[a.id,b.id]});
  }
  const chain=[a??null,...(edge.waypoints??[]),b??null];
  for(let leg=1;leg<chain.length;leg++){
   const from=chain[leg-1],to=chain[leg];
   if(!from||!to)continue;
   if(Math.abs(to.x-from.x)>AXIS_EPS&&Math.abs(to.y-from.y)>AXIS_EPS)
    fail('diagonal-waypoint',`${label} 的第 ${leg} 个中间点与前一点不是水平/垂直连接`,{edgeIndex:index,tagIds:[edge.fromId,edge.toId]});
  }
  const key=pairKey(edge.fromId,edge.toId);
  const list=pairOccurrences.get(key)??[];
  list.push({occurrence:edge.occurrence,edgeIndex:index});
  pairOccurrences.set(key,list);
 }

 for(let index=1;index<topology.edges.length;index++){
  const previous=topology.edges[index-1]!,current=topology.edges[index]!;
  if(previous.toId===current.fromId)continue;
  fail('broken-chain',`第 ${index} 段结束于 Q${previous.toId}，第 ${index+1} 段却从 Q${current.fromId} 开始，路线不连续`,
   {edgeIndex:index,tagIds:[previous.toId,current.fromId]});
 }

 for(const [key,list] of pairOccurrences){
  const [from,to]=key.split('>');
  const seen=new Set<number>();
  let duplicated=false;
  for(const item of list){
   if(seen.has(item.occurrence)){
    duplicated=true;
    fail('duplicate-occurrence',`Q${from}→Q${to} 的第 ${item.occurrence} 次经过重复；同一对码多次经过必须显式给不同 occurrence`,
     {edgeIndex:item.edgeIndex,occurrence:item.occurrence,tagIds:[Number(from),Number(to)]});
   }
   seen.add(item.occurrence);
  }
  if(duplicated)continue;
  const order=list.map(item=>item.occurrence);
  if(order.some((value,position)=>value!==position+1)){
   fail('occurrence-order',
    `Q${from}→Q${to} 的 ${order.length} 次经过必须按 1..${order.length} 连续递增排列，当前为 ${order.join('、')}；请用 moveOccurrence 调整或补齐`,
    {tagIds:[Number(from),Number(to)]});
  }
 }

 for(const id of nodeIds)if(!usedTags.has(id))warn('orphan-node',`顶点 Q${id} 没有参与任何区间`,{tagIds:[id]});
 return {errors,warnings};
}

// --- human readable summary -------------------------------------------------

/**
 * Segment list for the UI, one Chinese line per edge, in route order. Rendered
 * from the topology (real tag IDs), so it never depends on stored array order.
 */
export function topologySummary(topology:RouteTopology,tagCenters:readonly TopologyTagCenter[]):string[]{
 if(!topology||!Array.isArray(topology.edges))return [];
 const centers=centersOf(tagCenters);
 return topology.edges.map((edge,index)=>{
  const parts=[`第 ${index+1} 段：Q${edge.fromId} → Q${edge.toId}`];
  const missing=[edge.fromId,edge.toId].filter(id=>!centers.has(id));
  if(missing.length){
   parts.push('地图缺少 '+missing.map(id=>'Q'+id).join('、'));
   return parts.join(' · ');
  }
  const from=centers.get(edge.fromId)!,to=centers.get(edge.toId)!;
  parts.push(directionLabel[edge.direction]);
  parts.push(edge.mode==='crab'?'Crab':'4T4D');
  parts.push(distance(from,to).toFixed(2)+' m');
  if(edge.occurrence>1)parts.push(`第 ${edge.occurrence} 次经过`);
  if(edge.waypoints?.length)parts.push(`中间点 ${edge.waypoints.length} 个`);
  if(edge.strategy&&edge.strategy!=='auto')parts.push('策略：'+(strategyLabels.get(edge.strategy)??edge.strategy));
  return parts.join(' · ');
 });
}

/**
 * Explain where the compiled route differs from what was declared. Compilation is
 * authoritative (a straight leg passing over a third code is split into two
 * intervals), so the drift is reported rather than silently reworded: the UI shows
 * the actual segmentation.
 */
export function topologyDrift(declared:RouteTopology,actual:RouteTopology):TopologyIssue[]{
 const issues:TopologyIssue[]=[];
 const actualByKey=new Map((actual?.edges??[]).map(edge=>[edgeKey(edge),edge]));
 const declaredKeys=new Set((declared?.edges??[]).map(edgeKey));
 for(const [index,edge] of (declared?.edges??[]).entries()){
  const found=actualByKey.get(edgeKey(edge));
  if(!found){
   issues.push(issue('warning','edge-not-compiled',
    `声明的第 ${index+1} 段 Q${edge.fromId}→Q${edge.toId}（第 ${edge.occurrence} 次）没有出现在编译结果里，通常是该直线中途经过其他二维码被拆成了多段`,
    {edgeIndex:index,tagIds:[edge.fromId,edge.toId],occurrence:edge.occurrence}));
   continue;
  }
  if(found.direction!==edge.direction)
   issues.push(issue('warning','direction-drift',
    `Q${edge.fromId}→Q${edge.toId} 声明为${directionLabel[edge.direction]}，实际编译为${directionLabel[found.direction]}`,
    {edgeIndex:index,tagIds:[edge.fromId,edge.toId]}));
  if(found.mode!==edge.mode)
   issues.push(issue('warning','mode-drift',
    `Q${edge.fromId}→Q${edge.toId} 声明为 ${edge.mode==='crab'?'Crab':'4T4D'}，实际编译为 ${found.mode==='crab'?'Crab':'4T4D'}`,
    {edgeIndex:index,tagIds:[edge.fromId,edge.toId]}));
 }
 for(const [index,edge] of (actual?.edges??[]).entries()){
  if(declaredKeys.has(edgeKey(edge)))continue;
  issues.push(issue('warning','edge-split',
   `编译结果多出第 ${index+1} 段 Q${edge.fromId}→Q${edge.toId}（第 ${edge.occurrence} 次），声明里没有这一段`,
   {edgeIndex:index,tagIds:[edge.fromId,edge.toId],occurrence:edge.occurrence}));
 }
 return issues;
}

/** Planner choices (`segmentChoiceSchema`, 0-based occurrence) implied by `edge.strategy`. */
export function topologyStrategyChoices(topology:RouteTopology):{choices:SegmentChoice[];issues:TopologyIssue[]}{
 const choices:SegmentChoice[]=[],issues:TopologyIssue[]=[];
 for(const [index,edge] of (topology?.edges??[]).entries()){
  if(edge.strategy===undefined||edge.strategy==='auto')continue;
  const parsed=strategyModeSchema.safeParse(edge.strategy);
  if(!parsed.success){
   issues.push(issue('warning','unknown-strategy',
    `第 ${index+1} 段 Q${edge.fromId}→Q${edge.toId} 的策略「${edge.strategy}」不是已知策略，已按自动处理`,
    {edgeIndex:index,tagIds:[edge.fromId,edge.toId]}));
   continue;
  }
  choices.push({fromId:edge.fromId,toId:edge.toId,occurrence:edge.occurrence-1,mode:parsed.data});
 }
 return {choices,issues};
}

// --- graph editing ----------------------------------------------------------

/** The next free occurrence for this pair (1 when it has never been driven). */
export function nextOccurrence(topology:RouteTopology,fromId:number,toId:number):number{
 return (topology?.edges??[]).filter(edge=>edge.fromId===fromId&&edge.toId===toId).length+1;
}

/** Renumber one pair's occurrences to 1..N in array order; returns the relabelled passes. */
function renumberPair(edges:TopologyEdge[],fromId:number,toId:number){
 const changes:{from:number;to:number;edgeIndex:number}[]=[];
 let occurrence=1;
 for(const [index,edge] of edges.entries()){
  if(edge.fromId!==fromId||edge.toId!==toId)continue;
  if(edge.occurrence!==occurrence)changes.push({from:edge.occurrence,to:occurrence,edgeIndex:index});
  edge.occurrence=occurrence++;
 }
 return changes;
}

/** Renumber every pair (used after an edit that moved an edge to a new pair). */
function renumberAll(edges:TopologyEdge[]){
 const pairs=new Set(edges.map(edge=>pairKey(edge.fromId,edge.toId)));
 for(const key of pairs){
  const [from,to]=key.split('>');
  renumberPair(edges,Number(from),Number(to));
 }
}

/**
 * Append one directed pass. `occurrence` may be omitted (then it is the next free
 * one). Unknown tag IDs are registered as vertices — `validateTopology` is what
 * refuses a code the map does not have, so an edit never hides that mistake.
 */
export function addEdge(topology:RouteTopology,edge:TopologyEdgeDraft):TopologyConversion{
 const base=cloneTopology(topology),issues:TopologyIssue[]=[];
 if(!edge||!Number.isInteger(edge.fromId)||!Number.isInteger(edge.toId)){
  issues.push(issue('error','bad-edge','新增区间必须给出整数 fromId/toId'));
  return {topology:base,issues};
 }
 if(edge.fromId===edge.toId){
  issues.push(issue('error','self-loop',`不允许自环：Q${edge.fromId}→Q${edge.fromId}`,{tagIds:[edge.fromId]}));
  return {topology:base,issues};
 }
 if((edge.mode==='crab')!==(edge.direction==='lateral')){
  issues.push(issue('error','mode-direction',`Q${edge.fromId}→Q${edge.toId} 的模式与方向不一致：crab 只能对应 lateral`,{tagIds:[edge.fromId,edge.toId]}));
  return {topology:base,issues};
 }
 const same=base.edges.filter(existing=>existing.fromId===edge.fromId&&existing.toId===edge.toId);
 const occurrence=edge.occurrence??same.length+1;
 if(!Number.isInteger(occurrence)||occurrence<1||same.some(existing=>existing.occurrence===occurrence)||occurrence!==same.length+1){
  issues.push(issue('error','duplicate-occurrence',
   `Q${edge.fromId}→Q${edge.toId} 的第 ${occurrence} 次经过已存在；同一对码按顺序连续编号，应使用第 ${same.length+1} 次`,
   {tagIds:[edge.fromId,edge.toId],occurrence}));
  return {topology:base,issues};
 }
 for(const id of [edge.fromId,edge.toId])if(!base.nodes.some(node=>node.tagId===id))base.nodes.push({tagId:id});
 const previous=base.edges.at(-1);
 base.edges.push({
  fromId:edge.fromId,toId:edge.toId,occurrence,mode:edge.mode,direction:edge.direction,
  ...(edge.strategy!==undefined&&edge.strategy!=='auto'?{strategy:edge.strategy}:{}),
  ...(edge.waypoints?.length?{waypoints:edge.waypoints.map(point=>({x:micro(point.x),y:micro(point.y)}))}:{}),
 });
 if(previous&&previous.toId!==edge.fromId){
  issues.push(issue('warning','broken-chain',
   `新增段从 Q${edge.fromId} 开始，但上一段结束于 Q${previous.toId}；路线出现断点，请补齐中间区间`,
   {tagIds:[previous.toId,edge.fromId]}));
 }
 return {topology:base,issues};
}

/**
 * Remove one pass. Removing an earlier pass of a repeated pair would leave a hole
 * in the 1..N numbering, so the remaining passes of that pair are renumbered and
 * the change is reported. Vertices are kept (they are still declared vertices);
 * `validateTopology` warns about any that became orphans.
 */
export function removeEdge(topology:RouteTopology,fromId:number,toId:number,occurrence:number):TopologyConversion{
 const base=cloneTopology(topology),issues:TopologyIssue[]=[];
 const index=base.edges.findIndex(edge=>edge.fromId===fromId&&edge.toId===toId&&edge.occurrence===occurrence);
 if(index<0){
  issues.push(issue('error','not-found',`路线拓扑里没有 Q${fromId}→Q${toId} 的第 ${occurrence} 次经过`,{tagIds:[fromId,toId],occurrence}));
  return {topology:base,issues};
 }
 base.edges.splice(index,1);
 for(const change of renumberPair(base.edges,fromId,toId)){
  issues.push(issue('warning','renumbered',`Q${fromId}→Q${toId} 的第 ${change.from} 次经过已重编号为第 ${change.to} 次`,{occurrence:change.to,tagIds:[fromId,toId]}));
 }
 // 删除后可能断开：只有前后两段都还在时才比较；删的是末段就没有「后一段」。
 const previous=index>0?base.edges[index-1]:undefined;
 const next=base.edges[index];
 if(previous&&next&&previous.toId!==next.fromId){
  issues.push(issue('warning','broken-chain',
   `删除后路线在 Q${previous.toId} → Q${next.fromId} 处断开`,{tagIds:[previous.toId,next.fromId]}));
 }
 return {topology:base,issues};
}

/**
 * Reverse one pass in place: `forward` ↔ `reverse`, `lateral` stays lateral.
 * The endpoints swap, so the chain usually needs the neighbours fixed too — that
 * is reported as a warning, never repaired behind the caller's back.
 */
export function reverseEdge(topology:RouteTopology,fromId:number,toId:number,occurrence:number):TopologyConversion{
 const base=cloneTopology(topology),issues:TopologyIssue[]=[];
 const index=base.edges.findIndex(edge=>edge.fromId===fromId&&edge.toId===toId&&edge.occurrence===occurrence);
 if(index<0){
  issues.push(issue('error','not-found',`路线拓扑里没有 Q${fromId}→Q${toId} 的第 ${occurrence} 次经过`,{tagIds:[fromId,toId],occurrence}));
  return {topology:base,issues};
 }
 const edge=base.edges[index]!;
 const direction:TopologyEdge['direction']=edge.direction==='forward'?'reverse':edge.direction==='reverse'?'forward':'lateral';
 const reversed:TopologyEdge={
  fromId:edge.toId,toId:edge.fromId,occurrence:edge.occurrence,
  mode:direction==='lateral'?'crab':'4t4d',direction,
  ...(edge.strategy!==undefined?{strategy:edge.strategy}:{}),
  ...(edge.waypoints?.length?{waypoints:[...edge.waypoints].reverse().map(point=>({x:micro(point.x),y:micro(point.y)}))}:{}),
 };
 base.edges[index]=reversed;
 renumberAll(base.edges);
 if(reversed.strategy==='left'||reversed.strategy==='right'){
  issues.push(issue('warning','strategy-recheck',`反向后的 Q${reversed.fromId}→Q${reversed.toId} 仍保留「${strategyLabels.get(reversed.strategy)??reversed.strategy}」策略，请确认左右方向`,
   {edgeIndex:index,tagIds:[reversed.fromId,reversed.toId]}));
 }
 const previous=base.edges[index-1],next=base.edges[index+1];
 if(previous&&previous.toId!==reversed.fromId){
  issues.push(issue('warning','broken-chain',`反向导致路线在 Q${previous.toId} → Q${reversed.fromId} 处断开`,{edgeIndex:index,tagIds:[previous.toId,reversed.fromId]}));
 }
 if(next&&reversed.toId!==next.fromId){
  issues.push(issue('warning','broken-chain',`反向导致路线在 Q${reversed.toId} → Q${next.fromId} 处断开`,{edgeIndex:index,tagIds:[reversed.toId,next.fromId]}));
 }
 return {topology:base,issues};
}

/**
 * Re-label which pass of a repeated pair this is: the edge keeps its place in the
 * route (the chain is untouched) and swaps its "Nth time" label with the pass that
 * currently holds `targetOccurrence`. Other passes of the pair are renumbered so
 * the 1..N invariant always holds.
 */
export function moveOccurrence(topology:RouteTopology,fromId:number,toId:number,occurrence:number,targetOccurrence:number):TopologyConversion{
 const base=cloneTopology(topology),issues:TopologyIssue[]=[];
 const slots=base.edges.map((edge,index)=>({edge,index})).filter(slot=>slot.edge.fromId===fromId&&slot.edge.toId===toId);
 const total=slots.length;
 if(!total||!Number.isInteger(occurrence)||!Number.isInteger(targetOccurrence)||occurrence<1||occurrence>total||targetOccurrence<1||targetOccurrence>total){
  issues.push(issue('error','not-found',
   `Q${fromId}→Q${toId} 共 ${total} 次经过，无法把第 ${occurrence} 次移动到第 ${targetOccurrence} 次`,
   {tagIds:[fromId,toId],occurrence}));
  return {topology:base,issues};
 }
 if(occurrence===targetOccurrence)return {topology:base,issues};
 // 「第几次经过」是**路线顺序**的函数：编号必须按实际先后连续递增，否则
 // validateTopology 会以 occurrence-order 拒绝。因此这里移动的是「这一段本身
 // 在该对码的经过序列里的位置」——方向、策略、中间点跟着这段走，因为它们描述
 // 的正是这一次通过；段在整条路线里的槽位不变，其余经过重新编号保持 1..N。
 const group=slots.map(slot=>slot.edge);
 const [moved]=group.splice(occurrence-1,1);
 group.splice(targetOccurrence-1,0,moved!);
 slots.forEach((slot,position)=>{base.edges[slot.index]=group[position]!;});
 renumberPair(base.edges,fromId,toId);
 issues.push(issue('warning','occurrence-moved',
  `Q${fromId}→Q${toId} 的第 ${occurrence} 次经过已与第 ${targetOccurrence} 次互换编号；路线顺序不变，只改「第几次经过」的语义`,
  {tagIds:[fromId,toId]}));
 return {topology:base,issues};
}
