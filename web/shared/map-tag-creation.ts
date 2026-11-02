import {mapSchema,validate,distance,inside,type FieldMap,type Point,type Tag} from './model';
import {normalizeTagAngle,tagPositionLabel} from './map-tag-position';
import {MIN_TAG_DISTANCE_M,type TagAxis} from './map-tag-distance';

/**
 * 建图阶段直接新建二维码（纯函数引擎）。
 *
 * 与 map-tag-position / map-tag-distance 同一套口径：入参绝不修改，任何候选地图都
 * 重新过 mapSchema.parse + validate()，坐标状态强制回 draft（人工新建不是实测验收），
 * 所有校验结果进 reasons / notes 而不是抛异常——只有非法参数才抛。
 *
 * 硬约束（来自 web/shared/model.ts，本文件一条都不放宽）：
 * - tagSchema：id 为 0–586 的整数、size 0.02–0.18 m、x/y 在 ±10000 m、rowId 必填
 *   字符串、rules 必填数组。
 * - map-only：rows / order 必须为空、不得有 motionSegments、
 *   tag.rowId 必须为空串、tag.rules 必须为空数组。当前 mapSchema 允许 0 点位的
 *   定位码草稿（"先在图上铺码再编辑路径"），validate() 只给 warning 不报错，
 *   因此本模块可以在空地图上新建第一个码。
 * - validate()：ID 不得重复；任意两点中心距必须 ≥
 *   ((a.groupId?1:1.25)*a.size+(b.groupId?1:1.25)*b.size)/2，否则判为物理压盖；
 *   组中心（tag.groupId 非空）的 id/size 必须与 groups 里的 referenceId / sizeMm 相等。
 */

/** tagSchema 的编号上限。 */
export const MAX_TAG_ID=586;
/** mapSchema 允许的点位总数上限。 */
export const MAX_TAG_COUNT=587;
export const DEFAULT_TAG_SIZE_M=0.06;
export const MIN_TAG_SIZE_M=0.02;
export const MAX_TAG_SIZE_M=0.18;
/** 单次矩形阵列的点数上限，避免误填把地图灌满。 */
export const MAX_GRID_POINTS=200;
/** 新建点位的最小中心间距：与间距编辑器同一道 8 cm 硬门限。 */
export const MIN_CREATION_DISTANCE_M=MIN_TAG_DISTANCE_M;
export const TAG_CREATION_DISCLAIMER='新建点位为人工录入坐标，未经实测验收；保存后仍需现场复核中心与朝向。';
export const TAG_ALIGN_MODES=['left','right','top','bottom','hcenter','vcenter','equalSpacing'] as const;
export type TagAlignMode=typeof TAG_ALIGN_MODES[number];
export type TagCreationAxis=TagAxis;
/** 阵列遇到冲突时：整批拒绝（默认）或跳过冲突格。 */
export type TagConflictPolicy='reject'|'skip';
/** 删除定位组中心时：拒绝（默认）或连同组定义一起移除。 */
export type TagOrphanGroupPolicy='reject'|'prune';

export interface TagCreationIssue {code:string;message:string;tagIds:number[]}
export interface MetreTriple {m:number;cm:number;mm:number}

const micro=(value:number)=>Math.round(value*1e6)/1e6;
/** `+ 0` 把 -0 折成 0，避免取整后的坐标以 "-0" 落库。 */
const signedZero=(value:number)=>value+0;
const metres=(m:number):MetreTriple=>({m,cm:micro(m*100),mm:micro(m*1000)});
const pad=(id:number)=>'Q'+String(id).padStart(3,'0');
const cloneTags=(map:FieldMap):Tag[]=>map.tags.map(tag=>({...tag}));
const pointOf=(p:Point):Point=>({x:p.x,y:p.y});
/** validate() 用的物理压盖门限，逐字复刻，不另立口径。 */
const requiredGapM=(a:{groupId?:string;size:number},b:{groupId?:string;size:number})=>
  ((a.groupId?1:1.25)*a.size+(b.groupId?1:1.25)*b.size)/2;
/** 已打印定位板的编号（整板中心 + 全部成员）保留给打印布局。 */
function reservedIds(map:FieldMap){
  const reserved=new Set<number>();
  for(const group of map.groups??[]){reserved.add(group.referenceId);for(const member of group.members)reserved.add(member.id);}
  return reserved;
}
function makeTag(id:number,x:number,y:number,angleDeg:number,size:number,groupId?:string):Tag{
  return {id,...(groupId?{groupId}:{}),rowId:'',x:signedZero(micro(x)),y:signedZero(micro(y)),angle:signedZero(micro(normalizeTagAngle(angleDeg))),size,kind:'waypoint',rules:[]};
}
function collisionsWith(tag:Tag,others:readonly Tag[]){
  return others.filter(other=>distance(other,tag)<requiredGapM(other,tag)-1e-9);
}
/** 自动分配"最小的未占用合法编号"，跳过已有点位与定位板保留编号。 */
function assignIds(map:FieldMap,wanted:number){
  const used=new Set(map.tags.map(tag=>tag.id)),reserved=reservedIds(map),ids:number[]=[];
  let reservedHits=0;
  for(let id=0;id<=MAX_TAG_ID&&ids.length<wanted;id++){
    if(used.has(id))continue;
    if(reserved.has(id)){reservedHits++;continue;}
    ids.push(id);
  }
  return {ids,reservedHits};
}
type Issue=(code:string,message:string,tagIds?:readonly number[])=>void;
/** reasons / notes 收集器，与既有预览函数同构（编号去重排序）。 */
function logger(log:{reasons:TagCreationIssue[];notes:TagCreationIssue[]}){
  const make=(target:TagCreationIssue[]):Issue=>(code,message,tagIds=[])=>{
    target.push({code,message,tagIds:[...new Set<number>(tagIds)].filter(id=>Number.isInteger(id)).sort((a,b)=>a-b)});
  };
  return {reason:make(log.reasons),note:make(log.notes)};
}
/** 只接受尚未创建路径的定位码地图；其余进 reasons，不抛异常。 */
function sourceOf(source:FieldMap,reason:Issue,action:string){
  const parsed=mapSchema.safeParse(source);
  if(!parsed.success){reason('invalid-source',parsed.error.issues.map(issue=>issue.message).join('；'));return null;}
  const base=parsed.data;
  if(base.routeMode!=='map-only'){reason('unsupported-route-mode',`${action}仅适用于尚未创建路径的定位码地图；已包含路径的地图请保留旧版本并新建扫描`);return null;}
  return base;
}
/** 候选地图必须再走一遍 mapSchema.parse + validate()，错误只进 reasons。 */
function recheck(candidate:FieldMap,reason:Issue,note:Issue){
  const parsed=mapSchema.safeParse(candidate);
  if(!parsed.success){
    reason('invalid-map',parsed.error.issues.map(issue=>issue.path.length?`${issue.path.join('.')}：${issue.message}`:issue.message).join('；'));
    return null;
  }
  const validation=validate(parsed.data);
  for(const message of validation.errors)reason('invalid-geometry',message);
  for(const message of validation.warnings)note('warning',message);
  return parsed.data;
}
/** 只替换 tags / groups，并强制把坐标状态打回 draft。 */
const nextMap=(base:FieldMap,tags:Tag[],groups?:FieldMap['groups']):FieldMap=>({
  ...base,
  ...(groups===undefined?{}:{groups}),
  coordinateStatus:'draft',
  tags,
});

// --- 单个点位 ---------------------------------------------------------------

export interface TagCreateRequest {x:number;y:number;sizeM?:number;angleDeg?:number;groupId?:string}
export interface TagCreatePreview {
  ready:boolean;
  /** 诊断用候选地图；ready 为 false 时也可能非空，但绝不能直接保存。 */
  map:FieldMap|null;
  tag:Tag|null;
  /** 自动分配到的编号（未生成时为 null）。 */
  id:number|null;
  reasons:TagCreationIssue[];
  notes:TagCreationIssue[];
  disclaimer:string;
}

/**
 * 在指定绝对坐标新建一个点位。
 *
 * - 自由点位：自动取最小未占用编号，边长默认 6 cm，朝向归一化到 (-180,180]。
 * - 定位组中心：给了 `groupId` 时编号与边长由板上打印布局决定（= referenceId /
 *   sizeMm），不接受自由指定，避免破坏 groups 一致性。
 * - 不覆盖已有点、坐标必须在 ±10000 m 内、与已有点的物理间距必须满足 validate()。
 */
export function createTag(source:FieldMap,request:TagCreateRequest):TagCreatePreview {
  const result:TagCreatePreview={ready:false,map:null,tag:null,id:null,reasons:[],notes:[],disclaimer:TAG_CREATION_DISCLAIMER};
  const {reason,note}=logger(result);
  if(!Number.isFinite(request.x)||!Number.isFinite(request.y))throw new Error('新建二维码的坐标必须是有限数值');
  const angleDeg=request.angleDeg??0;
  if(!Number.isFinite(angleDeg))throw new Error('新建二维码的朝向必须是有限数值');
  const size=request.sizeM===undefined?DEFAULT_TAG_SIZE_M:request.sizeM;
  if(!Number.isFinite(size))throw new Error('新建二维码的边长必须是有限数值');
  const base=sourceOf(source,reason,'新建地图二维码点位');
  if(!base)return result;
  const existing=cloneTags(base);
  const group=request.groupId===undefined?undefined:(base.groups??[]).find(item=>item.id===request.groupId);
  if(request.groupId!==undefined&&!group){reason('missing-group',`地图缺少定位组 ${request.groupId} 的定义，不能按整组中心新建`);return result;}
  let id:number,tagSize=size;
  if(group){
    // 组中心与整板绑定：编号 / 边长只能取板定义里的值。
    id=group.referenceId;
    const groupSize=group.sizeMm/1000;
    if(request.sizeM!==undefined&&Math.abs(size-groupSize)>1e-9){
      reason('group-size-mismatch',`定位组 ${group.id} 的整组边长为 ${(groupSize*100).toFixed(1)} cm，与新建边长 ${(size*100).toFixed(1)} cm 不一致`,[id]);
      return result;
    }
    tagSize=groupSize;
    if(existing.some(item=>item.id===id)){reason('id-in-use',`定位组 ${group.id} 的中心 ${pad(id)} 已在这张地图中`,[id]);return result;}
  }else{
    if(size<MIN_TAG_SIZE_M||size>MAX_TAG_SIZE_M){
      reason('invalid-size',`新建边长 ${(size*100).toFixed(1)} cm 超出允许的 ${(MIN_TAG_SIZE_M*100).toFixed(0)}–${(MAX_TAG_SIZE_M*100).toFixed(0)} cm`);
      return result;
    }
    if(existing.length>=MAX_TAG_COUNT){reason('tag-capacity',`地图点位已达 ${MAX_TAG_COUNT} 个上限，不能再新建`);return result;}
    const assigned=assignIds(base,1);
    if(!assigned.ids.length){reason('no-free-id',`AprilTag 编号 0–${MAX_TAG_ID} 已全部占用或保留给定位板，没有可自动分配的编号`);return result;}
    id=assigned.ids[0]!;
    if(assigned.reservedHits)note('reserved-ids',`自动分配跳过 ${assigned.reservedHits} 个已登记定位板的编号（整板成员编号保留给打印布局）`,[id]);
  }
  if(request.x<-10000||request.x>10000||request.y<-10000||request.y>10000){
    reason('coordinate-out-of-range',`新坐标 (${request.x}, ${request.y}) 超出地图允许的 ±10000 m 范围`,[id]);
    return result;
  }
  const tag=makeTag(id,request.x,request.y,angleDeg,tagSize,group?.id);
  const collisions=collisionsWith(tag,existing);
  if(collisions.length){
    const gap=requiredGapM(collisions[0]!,tag);
    reason('overlap',`新建点位与 ${collisions.map(other=>pad(other.id)).join('、')} 的中心距小于物理标记间距（需 ≥ ${(gap*100).toFixed(1)} cm），会互相压盖`,[...collisions.map(other=>other.id),id]);
  }
  note('created',`新建 ${tagPositionLabel(tag)} 于 (${tag.x}, ${tag.y})，朝向 ${tag.angle}°，边长 ${(tag.size*100).toFixed(1)} cm`,[id]);
  if(!inside(tag,base.zone))note('outside-zone','新点位落在地图显示范围之外：校验不拦截，但导航前请确认换行区覆盖该点',[id]);
  const candidate=recheck(nextMap(base,[...existing,tag]),reason,note);
  result.tag=tag;
  result.id=tag.id;
  result.ready=result.reasons.length===0&&candidate!==null;
  // 有 reasons 就不交回候选地图：调用方拿不到一个"看起来能存"的半成品。
  result.map=result.ready?candidate:null;
  return result;
}

// --- 矩形阵列 ---------------------------------------------------------------

export interface TagGridRequest {
  originX:number;originY:number;columns:number;rows:number;spacingXM:number;spacingYM:number;
  angleDeg?:number;sizeM?:number;
  /** 与已有点或本批点位冲突时：reject 整批拒绝（默认），skip 只跳过冲突格。 */
  onConflict?:TagConflictPolicy;
}
export interface TagGridSkip {column:number;row:number;x:number;y:number;code:string;message:string}
export interface TagGridPreview {
  ready:boolean;
  map:FieldMap|null;
  created:number;
  tags:Tag[];
  spanXM:number;
  spanYM:number;
  columns:number;
  rows:number;
  spacingXM:number;
  spacingYM:number;
  /** 被跳过的阵列位置及原因（越界、压盖、编号耗尽）。 */
  skipped:TagGridSkip[];
  reasons:TagCreationIssue[];
  notes:TagCreationIssue[];
  disclaimer:string;
}

/**
 * 矩形阵列新建：原地为第 1 行第 1 列点位，列向 +x、行向 +y 按给定间距展开。
 *
 * 阵列本身不随 `angleDeg` 旋转——`angleDeg` 只是每个点自己的朝向（现场摆板通常
 * 同向）。与已有点或本批已接受点位压盖的位置默认整批拒绝（onConflict:'skip' 时只
 * 跳过并记入 skipped）。单批上限 200 点，点位总数受 587 硬约束。
 */
export function createTagGrid(source:FieldMap,request:TagGridRequest):TagGridPreview {
  const result:TagGridPreview={ready:false,map:null,created:0,tags:[],spanXM:0,spanYM:0,columns:request.columns,rows:request.rows,spacingXM:request.spacingXM,spacingYM:request.spacingYM,skipped:[],reasons:[],notes:[],disclaimer:TAG_CREATION_DISCLAIMER};
  const {reason,note}=logger(result);
  if(!Number.isInteger(request.columns)||request.columns<1)throw new Error('阵列列数必须是正整数');
  if(!Number.isInteger(request.rows)||request.rows<1)throw new Error('阵列行数必须是正整数');
  if(!Number.isFinite(request.spacingXM)||request.spacingXM<=0)throw new Error('阵列横向间距必须是正的有限数值');
  if(!Number.isFinite(request.spacingYM)||request.spacingYM<=0)throw new Error('阵列纵向间距必须是正的有限数值');
  if(!Number.isFinite(request.originX)||!Number.isFinite(request.originY))throw new Error('阵列原点必须是有限数值');
  const angleDeg=request.angleDeg??0;
  if(!Number.isFinite(angleDeg))throw new Error('新建二维码的朝向必须是有限数值');
  const size=request.sizeM===undefined?DEFAULT_TAG_SIZE_M:request.sizeM;
  if(!Number.isFinite(size))throw new Error('新建二维码的边长必须是有限数值');
  const onConflict=request.onConflict??'reject';
  if(onConflict!=='reject'&&onConflict!=='skip')throw new Error('阵列冲突策略只能是 reject 或 skip');
  const base=sourceOf(source,reason,'新建地图二维码阵列');
  if(!base)return result;
  const cells=request.columns*request.rows;
  if(cells>MAX_GRID_POINTS){reason('grid-too-large',`阵列 ${request.columns}×${request.rows}=${cells} 点超过单次上限 ${MAX_GRID_POINTS} 点`);return result;}
  if(size<MIN_TAG_SIZE_M||size>MAX_TAG_SIZE_M){
    reason('invalid-size',`新建边长 ${(size*100).toFixed(1)} cm 超出允许的 ${(MIN_TAG_SIZE_M*100).toFixed(0)}–${(MAX_TAG_SIZE_M*100).toFixed(0)} cm`);
    return result;
  }
  const gap=Math.max(MIN_CREATION_DISTANCE_M,requiredGapM({size},{size}));
  if(request.spacingXM<gap-1e-9||request.spacingYM<gap-1e-9){
    reason('distance-too-small',`阵列间距 ${(Math.min(request.spacingXM,request.spacingYM)*100).toFixed(1)} cm 小于最小允许值 ${(gap*100).toFixed(1)} cm：二维码会互相压盖`);
    return result;
  }
  const existing=cloneTags(base);
  const assigned=assignIds(base,Math.max(0,Math.min(cells,MAX_TAG_COUNT-existing.length)));
  const pool=[...assigned.ids];
  const accepted:Tag[]=[],skipped:TagGridSkip[]=[];
  for(let row=0;row<request.rows;row++)for(let column=0;column<request.columns;column++){
    const x=signedZero(micro(request.originX+column*request.spacingXM)),y=signedZero(micro(request.originY+row*request.spacingYM));
    const skip=(code:string,message:string)=>skipped.push({column,row,x,y,code,message});
    if(x<-10000||x>10000||y<-10000||y>10000){skip('coordinate-out-of-range',`第 ${row+1} 行第 ${column+1} 列 (${x}, ${y}) 超出地图允许的 ±10000 m`);continue;}
    const probe=makeTag(0,x,y,angleDeg,size);
    const collisions=collisionsWith(probe,[...existing,...accepted]);
    if(collisions.length){skip('overlap',`第 ${row+1} 行第 ${column+1} 列与 ${collisions.map(other=>pad(other.id)).join('、')} 压盖`);continue;}
    const id=pool.shift();
    if(id===undefined){skip('tag-capacity',`第 ${row+1} 行第 ${column+1} 列没有可分配编号：点位总数上限 ${MAX_TAG_COUNT}`);continue;}
    accepted.push(makeTag(id,x,y,angleDeg,size));
  }
  result.skipped=skipped;
  result.tags=accepted;
  result.created=accepted.length;
  result.spanXM=signedZero(micro((request.columns-1)*request.spacingXM));
  result.spanYM=signedZero(micro((request.rows-1)*request.spacingYM));
  if(skipped.length){
    // reject 是默认策略：任何一个格子放不下就整批拒绝，绝不让调用方拿着"缺了几格"
    // 的阵列去保存。skip 模式只提示，由调用方自己确认跳过清单。
    const codes=[...new Set(skipped.map(item=>item.code))];
    const detail=[...new Set(skipped.map(item=>item.message))].slice(0,3).join('；');
    if(onConflict==='skip')note('grid-skipped',`${skipped.length} 个阵列位置被跳过：${detail}`);
    else for(const code of codes)reason(code,`${skipped.length} 个阵列位置放不下（整批拒绝）：${detail}`);
  }
  if(!accepted.length){reason('nothing-created','阵列没有生成任何点位，请检查原点、间距与已有点位');return result;}
  note('grid',`${request.columns}×${request.rows} 阵列生成 ${result.created} 个点位，跨度 ${metres(result.spanXM).cm}×${metres(result.spanYM).cm} cm、间距 ${metres(request.spacingXM).cm}×${metres(request.spacingYM).cm} cm`);
  if(assigned.reservedHits)note('reserved-ids',`自动分配跳过 ${assigned.reservedHits} 个已登记定位板的编号`,[...accepted.map(tag=>tag.id)]);
  const candidate=recheck(nextMap(base,[...existing,...accepted]),reason,note);
  result.ready=result.reasons.length===0&&candidate!==null;
  result.map=result.ready?candidate:null;
  return result;
}

// --- 直线批量铺码 -----------------------------------------------------------

export interface TagLineRequest {
  /** 以已有点位为起点：新点从它前方一个间距开始，不会覆盖它。 */
  fromTagId?:number;
  /** 或以绝对坐标作为第一个新点位（需同时给 startX / startY）。 */
  startX?:number;startY?:number;
  count:number;
  spacingM:number;
  axis:TagCreationAxis;
  angleDeg?:number;
  sizeM?:number;
  /** 铺码方向：+1 沿 +x/+y，-1 反向。默认 +1。 */
  direction?:1|-1;
}
export interface TagLinePoint {id:number;label:string;x:number;y:number;offsetM:number}
export interface TagLinePreview {
  ready:boolean;
  map:FieldMap|null;
  created:number;
  tags:Tag[];
  /** 明细，按铺码顺序排列（offsetM 相对起点）。 */
  points:TagLinePoint[];
  axis:TagCreationAxis;
  direction:1|-1;
  /** 起点（已有点位或给定坐标）。 */
  start:Point|null;
  unit:Point|null;
  spacingM:number;
  /** 首末新点之间的跨度。 */
  spanM:number;
  reasons:TagCreationIssue[];
  notes:TagCreationIssue[];
  disclaimer:string;
}

/**
 * 沿一条直线等间距批量新建点位（现场最常见的铺码方式）。
 *
 * `fromTagId`：起点是已有点位，新点从 `起点 + direction*spacing` 开始，共 `count`
 * 个，已有点位本身不动也不重复创建。`startX/startY`：起点就是第一个新点位。
 * 间距必须 ≥ max(8 cm, 物理压盖门限)；任一点越界或与已有点压盖则整批拒绝——
 * 铺码要求节距严格，静默跳点会让现场对不上。
 */
export function createTagLine(source:FieldMap,request:TagLineRequest):TagLinePreview {
  const result:TagLinePreview={ready:false,map:null,created:0,tags:[],points:[],axis:request.axis,direction:request.direction??1,start:null,unit:null,spacingM:request.spacingM,spanM:0,reasons:[],notes:[],disclaimer:TAG_CREATION_DISCLAIMER};
  const {reason,note}=logger(result);
  if(request.axis!=='horizontal'&&request.axis!=='vertical')throw new Error('铺码轴向只能是 horizontal 或 vertical');
  if(!Number.isInteger(request.count)||request.count<1)throw new Error('新建点位数量必须是正整数');
  if(!Number.isFinite(request.spacingM)||request.spacingM<=0)throw new Error('铺码间距必须是正的有限数值');
  const direction=request.direction??1;
  if(direction!==1&&direction!==-1)throw new Error('铺码方向只能是 +1 或 -1');
  result.direction=direction;
  const angleDeg=request.angleDeg??0;
  if(!Number.isFinite(angleDeg))throw new Error('新建二维码的朝向必须是有限数值');
  const size=request.sizeM===undefined?DEFAULT_TAG_SIZE_M:request.sizeM;
  if(!Number.isFinite(size))throw new Error('新建二维码的边长必须是有限数值');
  if(request.fromTagId===undefined&&request.startX===undefined&&request.startY===undefined)throw new Error('铺码必须提供 fromTagId 或 startX/startY');
  if(request.startX!==undefined&&!Number.isFinite(request.startX))throw new Error('铺码起点坐标必须是有限数值');
  if(request.startY!==undefined&&!Number.isFinite(request.startY))throw new Error('铺码起点坐标必须是有限数值');
  const base=sourceOf(source,reason,'直线铺码');
  if(!base)return result;
  if(size<MIN_TAG_SIZE_M||size>MAX_TAG_SIZE_M){
    reason('invalid-size',`新建边长 ${(size*100).toFixed(1)} cm 超出允许的 ${(MIN_TAG_SIZE_M*100).toFixed(0)}–${(MAX_TAG_SIZE_M*100).toFixed(0)} cm`);
    return result;
  }
  let start:Point,firstIndex=0;
  if(request.fromTagId!==undefined){
    if(!Number.isInteger(request.fromTagId))throw new Error('起点二维码编号必须是整数');
    const anchor=base.tags.find(tag=>tag.id===request.fromTagId);
    if(!anchor){reason('unknown-tag',`起点 ${pad(request.fromTagId)} 不在这张地图中`,[request.fromTagId]);return result;}
    start=pointOf(anchor);
    firstIndex=1;
  }else{
    if(request.startX===undefined||request.startY===undefined)throw new Error('铺码必须同时提供 startX 与 startY');
    start={x:request.startX,y:request.startY};
  }
  result.start=start;
  const unit:Point=request.axis==='horizontal'?{x:1,y:0}:{x:0,y:1};
  result.unit=unit;
  const gap=Math.max(MIN_CREATION_DISTANCE_M,requiredGapM({size},{size}));
  if(request.spacingM<gap-1e-9){
    reason('distance-too-small',`铺码间距 ${(request.spacingM*100).toFixed(1)} cm 小于最小允许值 ${(gap*100).toFixed(1)} cm：相邻二维码会互相压盖`);
    return result;
  }
  if(base.tags.length+request.count>MAX_TAG_COUNT){
    reason('tag-capacity',`本次将新建 ${request.count} 个点位，地图点位总数会超过上限 ${MAX_TAG_COUNT}`);
    return result;
  }
  const existing=cloneTags(base);
  const positions:Point[]=[];
  for(let index=0;index<request.count;index++){
    const step=(firstIndex+index)*request.spacingM*direction;
    const x=signedZero(micro(start.x+unit.x*step)),y=signedZero(micro(start.y+unit.y*step));
    if(x<-10000||x>10000||y<-10000||y>10000){
      reason('coordinate-out-of-range',`第 ${index+1} 个点位 (${x}, ${y}) 超出地图允许的 ±10000 m 范围`);
      return result;
    }
    const probe=makeTag(0,x,y,angleDeg,size);
    const collisions=collisionsWith(probe,[...existing,...positions.map(position=>makeTag(-1,position.x,position.y,angleDeg,size))]);
    if(collisions.length){
      reason('overlap',`第 ${index+1} 个点位与 ${collisions.map(other=>pad(other.id)).join('、')} 压盖，整批未创建；请调整起点或间距`,[...collisions.map(other=>other.id)]);
      return result;
    }
    positions.push({x,y});
  }
  const assigned=assignIds(base,request.count);
  if(assigned.ids.length<request.count){
    reason('tag-capacity',`只剩 ${assigned.ids.length} 个可分配编号，无法新建 ${request.count} 个点位`);
    return result;
  }
  const tags=positions.map((position,index)=>makeTag(assigned.ids[index]!,position.x,position.y,angleDeg,size));
  result.tags=tags;
  result.created=tags.length;
  result.points=tags.map((tag,index)=>({
    id:tag.id,
    label:tagPositionLabel(tag),
    x:tag.x,
    y:tag.y,
    offsetM:signedZero(micro((firstIndex+index)*request.spacingM*direction)),
  }));
  result.spanM=tags.length>1?signedZero(micro(distance(tags[0]!,tags[tags.length-1]!))):0;
  note('line',`沿${request.axis==='horizontal'?'水平':'垂直'}直线间距 ${metres(request.spacingM).cm} cm 新建 ${result.created} 个点位，跨度 ${metres(result.spanM).cm} cm`,tags.map(tag=>tag.id));
  if(assigned.reservedHits)note('reserved-ids',`自动分配跳过 ${assigned.reservedHits} 个已登记定位板的编号`,[...tags.map(tag=>tag.id)]);
  const candidate=recheck(nextMap(base,[...existing,...tags]),reason,note);
  result.ready=result.reasons.length===0&&candidate!==null;
  result.map=result.ready?candidate:null;
  return result;
}

// --- 删除点位 ---------------------------------------------------------------

export interface TagRemoveOptions {orphanGroups?:TagOrphanGroupPolicy}
export interface TagRemovePreview {
  ready:boolean;
  map:FieldMap|null;
  removed:number;
  /** 实际删除的编号（去重排序后）。 */
  ids:number[];
  tags:Tag[];
  /** 因整组移除而一并删除的定位组定义。 */
  prunedGroups:string[];
  reasons:TagCreationIssue[];
  notes:TagCreationIssue[];
  disclaimer:string;
}

/**
 * 删除指定点位（画错回退）。
 *
 * 默认拒绝删除定位组中心：组定义仍在 `map.groups` 里，删掉中心会让已打印的整板
 * 失去地图锚点。确实要整组下线时传 `{orphanGroups:'prune'}`，组定义会一起删除，
 * groups 一致性因此仍然成立。删掉全部点位同样被拒绝（定位码地图至少保留一个点）。
 */
export function removeTags(source:FieldMap,ids:readonly number[],options:TagRemoveOptions={}):TagRemovePreview {
  const result:TagRemovePreview={ready:false,map:null,removed:0,ids:[],tags:[],prunedGroups:[],reasons:[],notes:[],disclaimer:TAG_CREATION_DISCLAIMER};
  const {reason,note}=logger(result);
  if(!Array.isArray(ids)||ids.some(id=>!Number.isInteger(id)))throw new Error('删除的二维码编号必须是整数数组');
  const policy=options.orphanGroups??'reject';
  if(policy!=='reject'&&policy!=='prune')throw new Error('定位组中心的删除策略只能是 reject 或 prune');
  const base=sourceOf(source,reason,'删除地图二维码点位');
  if(!base)return result;
  if(!ids.length){reason('no-ids','尚未选择要删除的二维码');return result;}
  const wanted=[...new Set(ids)].sort((a,b)=>a-b);
  if(wanted.length!==ids.length)note('duplicate-id','提交的编号有重复，已按去重后的列表删除',wanted);
  const missing=wanted.filter(id=>!base.tags.some(tag=>tag.id===id));
  if(missing.length){reason('unknown-tag',`${missing.map(pad).join('、')} 不在这张地图中`,[...missing]);return result;}
  const targets=base.tags.filter(tag=>wanted.includes(tag.id));
  const centers=targets.filter(tag=>tag.groupId);
  if(centers.length&&policy==='reject'){
    reason('group-center',`${centers.map(tag=>tagPositionLabel(tag)).join('、')} 是定位组中心，删除会破坏 groups 一致性；如确需整组下线请选择同时删除定位组定义`,[...centers.map(tag=>tag.id)]);
    return result;
  }
  const remaining=base.tags.filter(tag=>!wanted.includes(tag.id));
  if(!remaining.length){reason('empty-map','定位码地图至少需要保留一个点位；如需清空请删除整张地图');return result;}
  const prunedGroups=policy==='prune'?[...new Set(centers.map(tag=>tag.groupId!))]:[];
  const groups=base.groups?base.groups.filter(group=>!prunedGroups.includes(group.id)):undefined;
  for(const tag of centers)note('group-removed',`删除定位组 ${tag.groupId} 的中心 ${pad(tag.id)}，同时移除整组定义（板上其余子码不再是地图点位）`,[tag.id]);
  note('removed',`删除 ${targets.map(tag=>pad(tag.id)).join('、')} 共 ${targets.length} 个点位`,[...targets.map(tag=>tag.id)]);
  const candidate=recheck(nextMap(base,remaining,base.groups?groups:undefined),reason,note);
  result.ids=wanted;
  result.tags=targets;
  result.prunedGroups=prunedGroups;
  result.removed=targets.length;
  result.ready=result.reasons.length===0&&candidate!==null;
  result.map=result.ready?candidate:null;
  return result;
}

// --- 对齐 / 等间距 ----------------------------------------------------------

export interface TagAlignPoint {
  id:number;label:string;groupId:string|null;
  before:Point;after:Point;displacementM:number;
}
export interface TagAlignPreview {
  ready:boolean;
  map:FieldMap|null;
  mode:TagAlignMode;
  /** 参与处理的编号顺序（等间距时是按轴向排好的顺序）。 */
  order:number[];
  points:TagAlignPoint[];
  changedIds:number[];
  /** 等间距时保持不动的首末两点。 */
  fixedIds:number[];
  axis:TagCreationAxis|null;
  maxDisplacementM:number;
  reasons:TagCreationIssue[];
  notes:TagCreationIssue[];
  disclaimer:string;
}

/**
 * 对齐 / 等间距重排。
 *
 * - left/right：x 对齐到选择范围的最小/最大值；top/bottom：y 对齐到最大/最小值。
 * - hcenter：x 对齐到选择范围中点（形成一条竖直中线）；vcenter：y 对齐到中点。
 * - equalSpacing：沿主轴向排序后首末点保持不动，其余点按直线等分（同时消除横向
 *   累积偏差，保证严格共线）。
 *
 * 只改坐标，不增删点、不改编号/边长/朝向；定位组中心被移动时整板刚性平移。
 */
export function alignTags(source:FieldMap,ids:readonly number[],mode:TagAlignMode):TagAlignPreview {
  const result:TagAlignPreview={ready:false,map:null,mode,order:[],points:[],changedIds:[],fixedIds:[],axis:null,maxDisplacementM:0,reasons:[],notes:[],disclaimer:TAG_CREATION_DISCLAIMER};
  const {reason,note}=logger(result);
  if(!(TAG_ALIGN_MODES as readonly string[]).includes(mode))throw new Error(`对齐方式必须是 ${TAG_ALIGN_MODES.join('/')}`);
  if(!Array.isArray(ids)||ids.some(id=>!Number.isInteger(id)))throw new Error('要对齐的二维码编号必须是整数数组');
  const base=sourceOf(source,reason,'二维码对齐');
  if(!base)return result;
  if(!ids.length){reason('no-ids','尚未选择要对齐的二维码');return result;}
  const seen=new Set<number>(),targets:Tag[]=[];
  for(const id of ids){
    if(seen.has(id))reason('duplicate-id',`${pad(id)} 被重复提交`,[id]);
    seen.add(id);
    const tag=base.tags.find(item=>item.id===id);
    if(!tag)reason('unknown-tag',`${pad(id)} 不在这张地图中`,[id]);else targets.push(tag);
  }
  if(result.reasons.length)return result;
  if(targets.length<2){reason('too-few-points','对齐至少需要两个二维码',targets.map(tag=>tag.id));return result;}
  const xs=targets.map(tag=>tag.x),ys=targets.map(tag=>tag.y);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const wanted=new Map<number,Point>();
  let order:number[];
  if(mode==='equalSpacing'){
    if(targets.length<3){reason('too-few-points','等间距至少需要三个二维码',targets.map(tag=>tag.id));return result;}
    if(maxX-minX<=1e-9&&maxY-minY<=1e-9){reason('degenerate-line','所选二维码中心全部重合，无法确定等间距方向',targets.map(tag=>tag.id));return result;}
    const axis:TagCreationAxis=maxX-minX>=maxY-minY?'horizontal':'vertical';
    result.axis=axis;
    const ordered=axis==='horizontal'?[...targets].sort((a,b)=>a.x-b.x||a.id-b.id):[...targets].sort((a,b)=>a.y-b.y||a.id-b.id);
    const first=ordered[0]!,last=ordered[ordered.length-1]!;
    const pitch=distance(first,last)/(ordered.length-1);
    let gap=MIN_CREATION_DISTANCE_M;
    for(const tag of ordered)gap=Math.max(gap,requiredGapM(tag,first));
    if(pitch<gap-1e-9){
      reason('distance-too-small',`首末两点跨距 ${(distance(first,last)*100).toFixed(1)} cm 均分到 ${ordered.length} 个点位后节距 ${(pitch*100).toFixed(1)} cm，小于最小允许值 ${(gap*100).toFixed(1)} cm`,[...ordered.map(tag=>tag.id)]);
      return result;
    }
    ordered.forEach((tag,index)=>{
      const ratio=index/(ordered.length-1);
      wanted.set(tag.id,{x:micro(first.x+(last.x-first.x)*ratio),y:micro(first.y+(last.y-first.y)*ratio)});
    });
    result.fixedIds=[first.id,last.id];
    order=ordered.map(tag=>tag.id);
    note('equal-spacing',`沿${axis==='horizontal'?'水平':'垂直'}方向等间距，节距 ${metres(pitch).cm} cm，首末两点 ${pad(first.id)}/${pad(last.id)} 保持不动`,[...order]);
  }else{
    const horizontal=mode==='left'||mode==='right'||mode==='hcenter';
    result.axis=horizontal?'horizontal':'vertical';
    const value=mode==='left'?minX
      :mode==='right'?maxX
        :mode==='hcenter'?micro((minX+maxX)/2)
          :mode==='bottom'?minY
            :mode==='top'?maxY
              :micro((minY+maxY)/2);
    for(const tag of targets)wanted.set(tag.id,horizontal?{x:value,y:tag.y}:{x:tag.x,y:value});
    order=[...targets].sort((a,b)=>a.id-b.id).map(tag=>tag.id);
    const label={left:'左对齐',right:'右对齐',top:'上对齐',bottom:'下对齐',hcenter:'水平居中',vcenter:'垂直居中'}[mode];
    note('align',`${label}：${targets.length} 个点位对齐到 ${horizontal?'x':'y'}=${value} m`,[...order]);
  }
  const nextTags=cloneTags(base);
  const pointsById=new Map<number,TagAlignPoint>();
  for(const tag of targets){
    const goal=wanted.get(tag.id)!;
    const next=nextTags.find(item=>item.id===tag.id)!;
    // 亚微米级差异不算改动：避免把"已经对齐"保存成一次修改。
    if(Math.abs(goal.x-tag.x)>1e-6)next.x=goal.x;
    if(Math.abs(goal.y-tag.y)>1e-6)next.y=goal.y;
    const point:TagAlignPoint={id:tag.id,label:tagPositionLabel(tag),groupId:tag.groupId??null,before:pointOf(tag),after:{x:next.x,y:next.y},displacementM:distance(tag,next)};
    pointsById.set(tag.id,point);
    if(tag.groupId&&point.displacementM>1e-6){
      const size=(base.groups??[]).find(group=>group.id===tag.groupId)?.members.length??0;
      note('rigid-group',`${tagPositionLabel(tag)} 是定位组中心，整组 ${size} 个成员随中心刚性平移`,[tag.id]);
    }
  }
  result.order=order;
  result.points=order.map(id=>pointsById.get(id)!);
  result.changedIds=result.points.filter(point=>point.displacementM>1e-6).map(point=>point.id);
  result.maxDisplacementM=result.points.reduce((max,point)=>Math.max(max,point.displacementM),0);
  if(!result.changedIds.length)reason('no-changes','所选二维码已经满足该对齐方式，没有可保存的改动',[...order]);
  const candidate=recheck(nextMap(base,nextTags),reason,note);
  result.ready=result.reasons.length===0&&candidate!==null;
  result.map=result.ready?candidate:null;
  return result;
}
