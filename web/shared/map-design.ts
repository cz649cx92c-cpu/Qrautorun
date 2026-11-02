import {mapSchema, validate, type FieldMap, type Point} from './model';

/**
 * 新建空白地图（手动铺码的起点）。
 *
 * 现场需要"先建一张空地图，再在图上批量铺码"：扫描建图只能拿到已经摆好的码，
 * 而铺码往往要按打印结果先规划范围。这里只产出**一张合法的空底图**——没有点位、
 * 没有作物行、没有导航路径，坐标状态固定为 draft（人工新建不是实测验收），
 * 后续点位由 map-tag-creation 的 createTag / createTagGrid / createTagLine 添加。
 *
 * 硬约束全部复用 web/shared/model.ts，本文件一条都不放宽：
 * - mapSchema：id 匹配 /^[a-zA-Z0-9_-]{1,80}$/，name 1–100，zone 恰好 4 点，
 *   vehicle width 0.1–1 / length 0.2–3 / margin 0.01–0.1，notes ≤ 2000。
 * - routeMode:'map-only' 时 rows / order 必须为空、不得有 motionSegments，
 *   点位的 rowId 必须为空串、rules 必须为空数组（空图天然满足）。
 * - validate()：空 tags 只是 warning（"请先在地图上新建二维码"），
 *   zone 退化为零面积才是 error。因此空图可以保存，但导航会被
 *   /api/navigation/start 以 423 拦下（map-only 必须先编辑路径）。
 *
 * 与 map-tag-position / map-tag-distance / map-tag-creation 同构：入参绝不修改，
 * 结果里的 reasons / notes 说明每一条不放行的原因，只有调用方传了非对象这种
 * 编程错误才可能抛异常；任何非法输入都只让 ready=false，不抛。
 */

/** 空白地图的人工新建免责声明：随保存结果一起返回，供 UI 原样展示。 */
export const BLANK_MAP_DISCLAIMER='空白地图为人工新建的定位码底图，范围与车辆参数均未经实测验收；铺码完成后仍需现场复核中心与朝向。';
/** 未填 notes 时写入地图的默认说明，避免库里出现一张"来路不明"的空图。 */
export const BLANK_MAP_NOTES='空白定位码底图：先建图再在图上批量铺码；范围、车辆包络与坐标均未实测验收，正式导航前请现场复核。';
/** mapSchema 对 id 的硬约束，导出给 UI 做输入提示。 */
export const BLANK_MAP_ID_PATTERN=/^[a-zA-Z0-9_-]{1,80}$/;
/** 地图名称上限（与 mapSchema 一致）。 */
export const BLANK_MAP_NAME_MAX=100;
/** notes 上限（与 mapSchema 一致）。 */
export const BLANK_MAP_NOTES_MAX=2000;
/** 与 validate() 完全一致的退化面积门限：|面积| < 1e-8 即零面积。 */
const MIN_ZONE_AREA=1e-8;

export interface BlankMapVehicle {width:number;length:number;margin:number}
export interface BlankMapIssue {code:string;message:string}

export interface BlankMapInput {
  /** 可选固定编号；缺省自动生成 `design-<8位小写hex>`。必须匹配 BLANK_MAP_ID_PATTERN。 */
  id?:string;
  name:string;
  /** 地图显示范围，必须 4 点且非零面积；缺省为以原点为中心的 ±10 m 矩形。 */
  zone?:readonly Point[];
  /** 车辆包络（参与 validate() 的行宽/退出距离校验）；缺省见 blankMapDefaults.vehicle。 */
  vehicle?:Partial<BlankMapVehicle>;
  /** 后续铺第一个码时的边长（毫米）。空图没有点位可写，所以不进 FieldMap，只在结果里回传。 */
  tagSizeMm?:number;
  notes?:string;
}

export interface BlankMapResult {
  /** 只有 mapSchema.parse 通过且 validate() 无 error 才为 true。 */
  ready:boolean;
  /** 合法候选地图；ready 为 false 时恒为 null，调用方拿不到"看起来能存"的半成品。 */
  map:FieldMap|null;
  /** 这张图实际使用的编号（自动生成或显式传入），失败时也回传，便于给用户看冲突对象。 */
  id:string|null;
  /** 实际采用的铺码边长（毫米），供 UI 显示下一次 createTag 的默认值。 */
  tagSizeMm:number;
  reasons:BlankMapIssue[];
  /** 仅提示，不阻塞保存（例如"尚无二维码点位""现场坐标未验收"）。 */
  notes:BlankMapIssue[];
  validation:{errors:string[];warnings:string[]};
  disclaimer:string;
}

/** 供 UI 显示的默认值：与 model.ts / map-tag-creation.ts 的默认口径保持一致。 */
export const blankMapDefaults={
  /** 缺省名称前缀由 UI 自行拼接，这里给一个可直接用的占位名。 */
  name:'新建定位码地图',
  /** 缺省范围是原点左右的半边长（米）。 */
  zoneHalfSizeM:10,
  /** 缺省范围边长（米）= 2 × zoneHalfSizeM。 */
  zoneEdgeM:20,
  /** 车辆包络：与 model.ts 的设计占位值一致（width 0.4 / length 0.8 / margin 0.05）。 */
  vehicle:{width:.4,length:.8,margin:.05},
  /** 铺第一个码的默认边长：与 map-tag-creation.DEFAULT_TAG_SIZE_M（6 cm）一致。 */
  tagSizeMm:60,
  /** tagSchema 允许的边长范围（20–180 mm）。 */
  minTagSizeMm:20,
  maxTagSizeMm:180,
} as const;

/** 以原点为中心的矩形显示范围（逆时针 4 点），默认 ±10 m。 */
export function blankZone(halfSizeM:number=blankMapDefaults.zoneHalfSizeM):Point[]{
  const h=Math.abs(halfSizeM);
  return [{x:-h,y:-h},{x:h,y:-h},{x:h,y:h},{x:-h,y:h}];
}

/** 鞋带公式两倍面积，与 validate() 的算法逐字一致。 */
function polygonArea(zone:readonly Point[]):number{
  return zone.reduce((sum,point,index)=>{
    const next=zone[(index+1)%zone.length]!;
    return sum+point.x*next.y-next.x*point.y;
  },0)/2;
}

/** 4 字节随机数转 8 位小写 hex；优先 WebCrypto（浏览器/Node 都可用），退化为 Math.random。 */
function randomHex8():string{
  const bytes=new Uint8Array(4);
  if(typeof globalThis.crypto?.getRandomValues==='function')globalThis.crypto.getRandomValues(bytes);
  else for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256);
  return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}

/** 坐标必须是真正的 number（不接受数字字符串），非法值以 NaN 交给有限性检查。 */
function asPoint(value:unknown):Point{
  const point=value as {x?:unknown;y?:unknown}|null|undefined;
  return {x:typeof point?.x==='number'?point.x:Number.NaN,y:typeof point?.y==='number'?point.y:Number.NaN};
}

/**
 * 生成一张合法的空白定位码地图。
 *
 * 缺省：zone = ±10 m 矩形、vehicle = 0.4×0.8 m / margin 0.05 m、tagSizeMm = 60、
 * id = `design-<8位hex>`、routeMode='map-only'、source='design'、
 * coordinateStatus='draft'、tags/groups/rows/order 全为空。
 * 任何一项不合法都只进 reasons（ready=false），不抛异常。
 */
export function createBlankMap(input:BlankMapInput):BlankMapResult{
  const reasons:BlankMapIssue[]=[];const notes:BlankMapIssue[]=[];
  const reason=(code:string,message:string)=>{if(!reasons.some(item=>item.code===code&&item.message===message))reasons.push({code,message});};
  const note=(code:string,message:string)=>{if(!notes.some(item=>item.code===code&&item.message===message))notes.push({code,message});};
  const result:BlankMapResult={
    ready:false,map:null,id:null,tagSizeMm:blankMapDefaults.tagSizeMm,
    reasons,notes,validation:{errors:[],warnings:[]},disclaimer:BLANK_MAP_DISCLAIMER,
  };

  // --- 名称 ---------------------------------------------------------------
  const rawName=input?.name;
  const name=typeof rawName==='string'?rawName.trim():'';
  if(typeof rawName!=='string')reason('invalid-name','地图名称必须是文本');
  else if(!name)reason('invalid-name','地图名称不能为空');
  else if(name.length>BLANK_MAP_NAME_MAX)reason('invalid-name',`地图名称最多 ${BLANK_MAP_NAME_MAX} 个字符，当前 ${name.length} 个`);

  // --- 编号 ---------------------------------------------------------------
  // 只有 undefined 才自动生成：显式传 null / 数字都必须被当成非法输入，
  // 否则 String(null) === 'null' 会悄悄产出一张编号叫 "null" 的地图。
  const rawId=input?.id;
  const id=rawId===undefined?`design-${randomHex8()}`:typeof rawId==='string'?rawId:String(rawId);
  result.id=id;
  if(typeof rawId!=='string'&&rawId!==undefined)reason('invalid-id','地图编号必须是文本');
  else if(!BLANK_MAP_ID_PATTERN.test(id))reason('invalid-id',`地图编号「${id}」不合法：只能由 1–80 位字母、数字、下划线或连字符组成`);

  // --- 显示范围 -----------------------------------------------------------
  // 缺省矩形必须与合法输入走同一套检查：默认值本身也要能被 mapSchema + validate 接受。
  const zoneInput=input?.zone;
  let zone:Point[];
  if(zoneInput===undefined)zone=blankZone();
  else if(!Array.isArray(zoneInput)){zone=blankZone();reason('invalid-zone','地图显示范围必须是 4 个点组成的四边形');}
  else zone=zoneInput.map(asPoint);
  if(zone.length!==4)reason('invalid-zone',`地图显示范围必须是 4 个点组成的四边形，当前 ${zone.length} 个点`);
  else if(zone.some(point=>!Number.isFinite(point.x)||!Number.isFinite(point.y)))reason('invalid-zone','地图显示范围的坐标必须是有限数值');
  else if(zone.some(point=>Math.abs(point.x)>10000||Math.abs(point.y)>10000))reason('invalid-zone','地图显示范围的坐标必须在 ±10000 m 内');
  else if(Math.abs(polygonArea(zone))<MIN_ZONE_AREA)reason('degenerate-zone','地图显示范围退化为零面积：四个点必须围成一块真实区域');

  // --- 车辆包络 -----------------------------------------------------------
  const vehicleInput=(input?.vehicle??{}) as Partial<BlankMapVehicle>;
  const range=(label:string,provided:unknown,fallback:number,min:number,max:number):number=>{
    if(provided===undefined)return fallback;
    if(typeof provided!=='number'||!Number.isFinite(provided)){reason('invalid-vehicle',`${label}必须是有限数值`);return fallback;}
    if(provided<min||provided>max){reason('invalid-vehicle',`${label} ${provided} 超出允许范围 ${min}–${max}`);return fallback;}
    return provided;
  };
  const vehicle:BlankMapVehicle={
    width:range('车辆宽度',vehicleInput.width,blankMapDefaults.vehicle.width,.1,1),
    length:range('车辆长度',vehicleInput.length,blankMapDefaults.vehicle.length,.2,3),
    margin:range('安全余量',vehicleInput.margin,blankMapDefaults.vehicle.margin,.01,.1),
  };

  // --- 铺码边长（不进 FieldMap，只在结果里回传） --------------------------
  let tagSizeMm:number=blankMapDefaults.tagSizeMm;
  if(input?.tagSizeMm!==undefined){
    const provided=input.tagSizeMm;
    if(typeof provided!=='number'||!Number.isFinite(provided))reason('invalid-tag-size','铺码边长必须是有限数值');
    else if(provided<blankMapDefaults.minTagSizeMm||provided>blankMapDefaults.maxTagSizeMm)reason('invalid-tag-size',`铺码边长 ${provided} mm 超出允许范围 ${blankMapDefaults.minTagSizeMm}–${blankMapDefaults.maxTagSizeMm} mm`);
    else tagSizeMm=provided;
  }
  result.tagSizeMm=tagSizeMm;

  // --- 说明 ---------------------------------------------------------------
  let mapNotes=BLANK_MAP_NOTES;
  if(input?.notes!==undefined){
    if(typeof input.notes!=='string')reason('invalid-notes','地图说明必须是文本');
    else if(input.notes.length>BLANK_MAP_NOTES_MAX)reason('invalid-notes',`地图说明最多 ${BLANK_MAP_NOTES_MAX} 个字符，当前 ${input.notes.length} 个`);
    else mapNotes=input.notes;
  }

  // --- 候选地图：schema 与导航校验都必须通过 ------------------------------
  const candidate:FieldMap={
    schemaVersion:1,
    id,
    name,
    frame:'map',
    family:'tag36h11',
    source:'design',
    coordinateStatus:'draft',
    routeMode:'map-only',
    tags:[],
    groups:[],
    rows:[],
    order:[],
    zone,
    vehicle,
    notes:mapNotes,
  };
  const parsed=mapSchema.safeParse(candidate);
  if(!parsed.success){
    // 走到这里说明前面的逐项检查漏了一种情况（例如 zone 的 4 点里混进了 -0/Infinity）。
    if(!reasons.length)reason('invalid-map',parsed.error.issues.map(issue=>issue.path.length?`${issue.path.join('.')}：${issue.message}`:issue.message).join('；'));
    else note('schema',parsed.error.issues.map(issue=>issue.path.length?`${issue.path.join('.')}：${issue.message}`:issue.message).join('；'));
    return result;
  }
  result.validation=validate(parsed.data);
  // 已经逐项点名过的输入错误不再由 validate() 复述一遍：同一条"零面积"既不该
  // 在 reasons 里出现两次，也不该让调用方以为有两个独立问题。
  const degenerate=reasons.some(item=>item.code==='degenerate-zone');
  for(const message of result.validation.errors){
    if(degenerate&&message.includes('零面积'))continue;
    reason('invalid-geometry',message);
  }
  for(const message of result.validation.warnings)note('warning',message);
  result.id=parsed.data.id;
  result.ready=reasons.length===0;
  // 有 reasons 就不交回候选地图：调用方拿不到一个"看起来能存"的半成品。
  result.map=result.ready?parsed.data:null;
  if(result.ready){
    note('version-semantics','新建为空地图 v1；后续铺码可原地覆盖该版本（baseVersion = 1），不会自动产生新版本');
    note('coordinate-status','坐标状态为 draft：地图可以保存与铺码，但 /api/navigation/start 会以 423 拒绝，直到手动编辑路径');
    note('tag-size',`铺第一个码的默认为 ${tagSizeMm} mm；空图不含点位，所以该值只在本结果中回传`);
  }
  return result;
}
