import {mapSchema,validate,distance,type FieldMap,type Point,type Tag} from './model';
import {boardSchema} from './boards';

/**
 * 地图点位「统一编辑」：改编号、改坐标、改朝向、改尺寸、删除。
 *
 * 为什么单独做一个模块：建码/间距/对齐各有各的入口，但现场最常做的是
 * "把这个码改成 Q12"、"把它挪 10 cm"、"这个位置贴错了删掉"。这些都属于
 * 同一个操作面，放在一起才不会让人在 5 个面板之间来回找。
 *
 * 规则（沿用 previewTagPositions 的既有范式）：
 * - 永不修改入参；返回候选地图 + reasons/notes，不抛异常（非法参数除外）；
 * - 复用 mapSchema.parse + validate() 作为最终门禁，不另起第二套校验；
 * - coordinateStatus 强制回到 draft（人工改动不继承旧验收）；
 * - 组（board）定义原样保留：移动组中心 = 刚性平移，改编号时若该码是组中心
 *   则同步改组的 referenceId，否则整组会失去中心。
 */

export interface TagUpdateIssue {code:string;message:string;tagIds:number[]}

export interface TagUpdateEdit {
  /** 目标码的当前编号。 */
  id: number;
  /** 期望的新编号；省略或等于 id 表示不改号。 */
  nextId?: number;
  x?: number;
  y?: number;
  angle?: number;
  size?: number;
}

export interface TagUpdatePoint {
  id: number;
  nextId: number;
  label: string;
  before: Point;
  after: Point;
  angleBefore: number;
  angleAfter: number;
  sizeBefore: number;
  sizeAfter: number;
  displacementM: number;
  angleChangeDeg: number;
  rigidMemberCount: number;
}

export interface TagUpdatePreview {
  ready: boolean;
  map: FieldMap | null;
  points: TagUpdatePoint[];
  changedIds: number[];
  renumbered: {from:number;to:number}[];
  maxDisplacementM: number;
  maxAngleChangeDeg: number;
  reasons: TagUpdateIssue[];
  notes: TagUpdateIssue[];
  disclaimer: string;
}

export const TAG_UPDATE_DISCLAIMER='点位编号与坐标为人工修正，不代表外部实测精度已验收。';
export const TAG_UPDATE_ID_MIN=0;
export const TAG_UPDATE_ID_MAX=586;
export const TAG_UPDATE_MIN_SIZE=0.02;
export const TAG_UPDATE_MAX_SIZE=0.18;

const micro=(value:number)=>Math.round(value*1e6)/1e6;
const label=(id:number)=>'Q'+String(id).padStart(3,'0');
const angleWrap=(value:number)=>{const wrapped=((value+180)%360+360)%360-180;return wrapped;};

export function previewTagUpdates(source:FieldMap,edits:readonly TagUpdateEdit[]):TagUpdatePreview {
  const reasons:TagUpdateIssue[]=[];
  const notes:TagUpdateIssue[]=[];
  const add=(code:string,message:string,tagIds:number[]=[])=>{reasons.push({code,message,tagIds});};
  const note=(code:string,message:string,tagIds:number[]=[])=>{notes.push({code,message,tagIds});};

  const empty:TagUpdatePreview={
    ready:false,map:null,points:[],changedIds:[],renumbered:[],
    maxDisplacementM:0,maxAngleChangeDeg:0,reasons,notes,disclaimer:TAG_UPDATE_DISCLAIMER,
  };

  if(source.routeMode!=='map-only'){
    add('unsupported-route-mode','只有尚未创建路径的定位码地图可以直接改点位；已含路径的地图请先保留旧版本');
    return empty;
  }
  if(!Array.isArray(edits)||edits.length===0){
    add('no-changes','尚未提交任何点位修改');
    return empty;
  }

  const byId=new Map(source.tags.map(tag=>[tag.id,tag]));
  const seen=new Set<number>();
  for(const edit of edits){
    if(!Number.isInteger(edit.id)||!byId.has(edit.id)){
      add('unknown-tag',`地图上没有编号 ${edit.id} 的二维码`,[edit.id].filter(Number.isFinite));
      continue;
    }
    if(seen.has(edit.id)){add('duplicate-edit',`${label(edit.id)} 被重复提交`,[edit.id]);continue;}
    seen.add(edit.id);
  }
  if(reasons.length)return empty;

  // 校验目标编号：范围 + 全局唯一（既不能撞已有点，也不能两笔改动抢同一个号）
  const targetIds=new Map<number,number>(); // nextId -> 原 id
  for(const edit of edits){
    const nextId=edit.nextId??edit.id;
    if(!Number.isInteger(nextId)||nextId<TAG_UPDATE_ID_MIN||nextId>TAG_UPDATE_ID_MAX){
      add('invalid-id',`${label(edit.id)} 的新编号必须是 ${TAG_UPDATE_ID_MIN}–${TAG_UPDATE_ID_MAX} 的整数`,[edit.id]);
      continue;
    }
    if(nextId===edit.id)continue;
    const occupant=byId.get(nextId);
    if(occupant&&!seen.has(nextId)){
      add('id-taken',`编号 ${label(nextId)} 已被另一个二维码占用，请先给它换号或直接交换两者`,[edit.id,nextId]);
      continue;
    }
    const rival=targetIds.get(nextId);
    if(rival!==undefined&&rival!==edit.id){
      add('id-conflict',`${label(rival)} 与 ${label(edit.id)} 都要改成 ${label(nextId)}`,[rival,edit.id]);
      continue;
    }
    targetIds.set(nextId,edit.id);
  }

  for(const edit of edits){
    const tag=byId.get(edit.id)!;
    const x=edit.x??tag.x,y=edit.y??tag.y;
    if(!Number.isFinite(x)||!Number.isFinite(y)){add('invalid-point',`${label(edit.id)} 的坐标必须是有限数值`,[edit.id]);continue;}
    if(Math.abs(x)>10000||Math.abs(y)>10000){add('out-of-range',`${label(edit.id)} 的坐标超出 ±10000 m`,[edit.id]);continue;}
    const size=edit.size??tag.size;
    if(!Number.isFinite(size)||size<TAG_UPDATE_MIN_SIZE||size>TAG_UPDATE_MAX_SIZE){
      add('invalid-size',`${label(edit.id)} 的边长必须在 ${TAG_UPDATE_MIN_SIZE}–${TAG_UPDATE_MAX_SIZE} m`,[edit.id]);
    }
  }
  if(reasons.length)return empty;

  // 构造候选
  const points:TagUpdatePoint[]=[];const renumbered:{from:number;to:number}[]=[];
  const editById=new Map(edits.map(edit=>[edit.id,edit]));
  const nextTags:Tag[]=source.tags.map(tag=>{
    const edit=editById.get(tag.id);
    if(!edit){return {...tag,rules:tag.rules.map(rule=>({...rule}))};}
    const nextId=edit.nextId??tag.id;
    const after={x:micro(edit.x??tag.x),y:micro(edit.y??tag.y)};
    const angleAfter=edit.angle===undefined?tag.angle:micro(angleWrap(edit.angle));
    const sizeAfter=edit.size===undefined?tag.size:micro(edit.size);
    const displacementM=distance(tag,after);
    const angleChangeDeg=Math.abs(angleWrap(angleAfter-tag.angle));
    const group=tag.groupId?source.groups?.find(item=>item.id===tag.groupId):undefined;
    points.push({
      id:tag.id,nextId,label:label(nextId),
      before:{x:tag.x,y:tag.y},after,
      angleBefore:tag.angle,angleAfter,
      sizeBefore:tag.size,sizeAfter,
      displacementM:micro(displacementM),angleChangeDeg:micro(angleChangeDeg),
      rigidMemberCount:group?.members.length??0,
    });
    if(nextId!==tag.id)renumbered.push({from:tag.id,to:nextId});
    return {...tag,rules:tag.rules.map(rule=>({...rule})),id:nextId,x:after.x,y:after.y,angle:angleAfter,size:sizeAfter};
  });

  // 组中心改号时必须同步组的 referenceId，否则整组会找不到中心
  let nextGroups=source.groups;
  if(source.groups?.length&&renumbered.length){
    const mapping=new Map(renumbered.map(item=>[item.from,item.to]));
    nextGroups=source.groups.map(group=>{
      const nextReference=mapping.get(group.referenceId);
      return nextReference===undefined?group:{...group,referenceId:nextReference,members:group.members.map(member=>({...member}))};
    });
    for(const group of nextGroups){
      const parsed=boardSchema.safeParse(group);
      if(!parsed.success)add('invalid-group',`定位组 ${group.id} 的成员几何在改号后失效：${parsed.error.issues[0]?.message??''}`);
    }
  }

  const candidate:FieldMap={...source,tags:nextTags,groups:nextGroups,coordinateStatus:'draft'};
  const parsed=mapSchema.safeParse(candidate);
  if(!parsed.success){
    for(const issue of parsed.error.issues)add('invalid-map',issue.message);
    return empty;
  }
  const validation=validate(parsed.data);
  for(const message of validation.errors)add('invalid-geometry',message);
  for(const message of validation.warnings)note('warning',message);

  const changedIds=points.filter(point=>
    point.id!==point.nextId
    ||Math.abs(point.after.x-point.before.x)>1e-9
    ||Math.abs(point.after.y-point.before.y)>1e-9
    ||Math.abs(point.angleAfter-point.angleBefore)>1e-9
    ||Math.abs(point.sizeAfter-point.sizeBefore)>1e-9
  ).map(point=>point.id);

  const maxDisplacementM=points.reduce((max,point)=>Math.max(max,point.displacementM),0);
  const maxAngleChangeDeg=points.reduce((max,point)=>Math.max(max,point.angleChangeDeg),0);

  if(!changedIds.length)add('no-changes','新坐标/编号与当前完全一致，没有可保存的改动');
  if(renumbered.length)note('renumbered',`本次有 ${renumbered.length} 个点位改了编号；若它们属于定位板，板的中心编号已同步`);
  if(maxDisplacementM>0.05)note('large-displacement',`最大位移 ${(maxDisplacementM*100).toFixed(1)} cm，请目视确认`,changedIds);

  const result:TagUpdatePreview={
    ...empty,
    points:points.sort((a,b)=>a.id-b.id),
    changedIds,
    renumbered,
    reasons,
    notes,
    map:parsed.data,
    maxDisplacementM:micro(maxDisplacementM),
    maxAngleChangeDeg:micro(maxAngleChangeDeg),
  };
  result.ready=reasons.length===0&&changedIds.length>0;
  return result;
}
