import {mapSchema, validate, distance, type FieldMap, type Point, type Tag} from './model';
import {boardSchema} from './boards';
import {tagPositionLabel} from './map-tag-position';

/**
 * Map-QR spacing tools: "single-point distance" (move one point to an exact
 * centre-to-centre distance from a fixed neighbour) and "batch equal spacing"
 * (re-lay a straight run of points on an exact pitch).
 *
 * Both previews are pure. They never mutate the caller's map, never add or
 * remove a point, never renumber an ID and never touch `map.groups`: a group
 * centre is translated rigidly and its printed member layout stays expressed
 * relative to that centre. The candidate is re-parsed with `mapSchema` and put
 * through the same `validate()` gate navigation uses, and its coordinateStatus
 * is forced to `draft` because a hand-adjusted spacing is not a field survey.
 */

export type TagAxis = 'horizontal' | 'vertical';

export interface TagDistanceIssue {code: string; message: string; tagIds: number[]}
/** One distance expressed in metres, centimetres and millimetres. */
export interface MetreTriple {m: number; cm: number; mm: number}

/** Default collinearity tolerance: 2 cm, i.e. roughly one printed board radius. */
export const LINE_TOLERANCE_M = 0.02;
/** Hard minimum centre-to-centre pitch: 8 cm. */
export const MIN_TAG_DISTANCE_M = 0.08;
export const TAG_DISTANCE_DISCLAIMER = '二维码间距调整为人工修正，不代表外部实测精度已验收。';

const micro = (value: number) => Math.round(value * 1e6) / 1e6;
const metres = (m: number): MetreTriple => ({m, cm: micro(m * 100), mm: micro(m * 1000)});
const pad = (id: number) => 'Q' + String(id).padStart(3, '0');
const unitOf = (axis: TagAxis): Point => (axis === 'horizontal' ? {x: 1, y: 0} : {x: 0, y: 1});
const along = (axis: TagAxis, point: Point) => (axis === 'horizontal' ? point.x : point.y);
const perpendicularGap = (axis: TagAxis, a: Point, b: Point) =>
  axis === 'horizontal' ? Math.abs(b.y - a.y) : Math.abs(b.x - a.x);
/**
 * A row guard on top of the geometric tolerance: two *named* rows never share
 * one line. `map-only` maps forbid `rowId` (mapSchema rejects a定位码地图 with
 * 导航路径字段), so on the maps this tool accepts the guard is inert and the
 * perpendicular tolerance is what keeps a neighbouring row out.
 */
const sameRow = (a: Tag, b: Tag) => !(a.rowId && b.rowId && a.rowId !== b.rowId);
const cloneTags = (map: FieldMap) => map.tags.map(tag => ({...tag}));
const plainPoint = (point: Point): Point => ({x: point.x, y: point.y});
/** `+ 0` folds -0 into 0 so a rounded coordinate never lands as "-0" in a saved map. */
const signedZero = (value: number) => value + 0;
const issueIds = (message: string) => [...new Set([...message.matchAll(/Q(\d{1,3})/g)].map(match => Number(match[1])))].sort((a, b) => a - b);

// --- collinearity -----------------------------------------------------------

export interface TagLinePoint {
  id: number; label: string; x: number; y: number;
  /** Signed offset from the anchor along the axis, metres. */
  offsetM: number;
  /** Absolute perpendicular deviation from the anchor's line, metres. */
  deviationM: number;
  groupId: string | null;
}
export interface TagLine {
  axis: TagAxis;
  /** Unit vector along the increasing axis direction. */
  unit: Point;
  anchorId: number;
  /** Ordered by offset, anchor included; ids stay unique. */
  memberIds: number[];
  points: TagLinePoint[];
  offsetsM: number[];
  spanM: number;
  maxDeviationM: number;
  toleranceM: number;
}
export interface TagLineNeighborhood {
  anchorId: number;
  toleranceM: number;
  /** Points sharing the anchor's horizontal line (null when the anchor is alone). */
  horizontal: TagLine | null;
  vertical: TagLine | null;
  /** Longest line; ties resolve to horizontal so the result is deterministic. */
  primary: TagLine | null;
  /** True when the anchor has neighbours on both axes, i.e. it sits on an L corner. */
  corner: boolean;
}

function lineFor(map: FieldMap, anchor: Tag, axis: TagAxis, toleranceM: number): TagLine | null {
  // Only one axis is ever collected, so an L corner can never mix two arms: the
  // perpendicular arm is always more than `toleranceM` away on this axis.
  const members = map.tags.filter(tag =>
    tag.id === anchor.id || (sameRow(anchor, tag) && perpendicularGap(axis, anchor, tag) <= toleranceM));
  if (members.length < 2) return null;
  const ordered = [...members].sort((a, b) =>
    along(axis, a) - along(axis, b) || a.id - b.id);
  const points: TagLinePoint[] = ordered.map(tag => ({
    id: tag.id,
    label: tagPositionLabel(tag),
    x: tag.x,
    y: tag.y,
    offsetM: micro(along(axis, tag) - along(axis, anchor)),
    deviationM: perpendicularGap(axis, anchor, tag),
    groupId: tag.groupId ?? null,
  }));
  const offsetsM = points.map(point => point.offsetM);
  return {
    axis,
    unit: unitOf(axis),
    anchorId: anchor.id,
    memberIds: points.map(point => point.id),
    points,
    offsetsM,
    spanM: micro(Math.max(...offsetsM) - Math.min(...offsetsM)),
    maxDeviationM: points.reduce((max, point) => Math.max(max, point.deviationM), 0),
    toleranceM,
  };
}

/**
 * Points sharing a horizontal or vertical line with `tagId`.
 *
 * Only points within `toleranceM` perpendicular deviation are members, and two
 * differently named rows are never merged, so a neighbouring row stays out. The
 * horizontal and vertical results are reported separately: when the anchor sits
 * on a corner both arms are returned, but they are never concatenated into one
 * run — a preview can therefore not fold around the corner.
 */
export function neighborsOnLine(map: FieldMap, tagId: number, toleranceM = LINE_TOLERANCE_M): TagLineNeighborhood {
  if (!Number.isFinite(toleranceM) || toleranceM <= 0) throw new Error('共线容差必须是正的有限数值');
  const anchor = map.tags.find(tag => tag.id === tagId);
  if (!anchor) throw new Error(`${pad(tagId)} 不在这张地图中`);
  const horizontal = lineFor(map, anchor, 'horizontal', toleranceM);
  const vertical = lineFor(map, anchor, 'vertical', toleranceM);
  const primary = !horizontal ? vertical
    : !vertical ? horizontal
      : (horizontal.memberIds.length >= vertical.memberIds.length ? horizontal : vertical);
  return {anchorId: tagId, toleranceM, horizontal, vertical, primary, corner: !!horizontal && !!vertical};
}

// --- single-point distance --------------------------------------------------

export interface TagDistanceRequest {fromId: number; toId: number; targetM: number; toleranceM?: number}
export interface TagDistancePoint {
  id: number; label: string; groupId: string | null;
  before: Point; after: Point;
  displacementM: number;
  /** Signed offset from the fixed anchor along the line, before and after. */
  offsetBeforeM: number; offsetAfterM: number;
  rigidMemberCount: number;
}
export interface TagDistancePreview {
  ready: boolean;
  map: FieldMap | null;
  fromId: number; toId: number;
  axis: TagAxis | null;
  direction: Point | null;
  /** Current centre-to-centre distance (the value the operator reads first). */
  beforeM: number;
  /** Distance the saved version will have, computed from the rounded coordinates. */
  afterM: number;
  before: MetreTriple; after: MetreTriple;
  targetM: number;
  /** How far the moved point travels, metres. */
  displacementM: number;
  /** Signed change along the line (positive = away from the anchor). */
  deltaM: number;
  /** The anchor point; it never moves. */
  from: Point | null;
  /** Points whose stored centre changes; only the `toId` point does. */
  points: TagDistancePoint[];
  changedIds: number[];
  affectedIds: number[];
  rigidMemberCount: number;
  maxDisplacementM: number;
  /** The straight run the pair belongs to (for the preview overlay). */
  line: {axis: TagAxis; memberIds: number[]; spanM: number; maxDeviationM: number} | null;
  reasons: TagDistanceIssue[];
  notes: TagDistanceIssue[];
  disclaimer: string;
}

export function previewTagDistance(source: FieldMap, request: TagDistanceRequest): TagDistancePreview {
  const {fromId, toId} = request;
  const targetM = request.targetM;
  const toleranceM = request.toleranceM ?? LINE_TOLERANCE_M;
  const result: TagDistancePreview = {
    ready: false, map: null, fromId, toId, axis: null, direction: null,
    beforeM: 0, afterM: 0, before: metres(0), after: metres(0), targetM,
    displacementM: 0, deltaM: 0, from: null, points: [], changedIds: [], affectedIds: [],
    rigidMemberCount: 0, maxDisplacementM: 0, line: null,
    reasons: [], notes: [], disclaimer: TAG_DISTANCE_DISCLAIMER,
  };
  const addReason = (code: string, message: string, tagIds: number[] = []) => {
    result.reasons.push({code, message, tagIds: [...new Set(tagIds)].sort((a, b) => a - b)});
  };
  const addNote = (code: string, message: string, tagIds: number[] = []) => {
    result.notes.push({code, message, tagIds: [...new Set(tagIds)].sort((a, b) => a - b)});
  };
  const parsedSource = mapSchema.safeParse(source);
  if (!parsedSource.success) {
    addReason('invalid-source', parsedSource.error.issues.map(issue => issue.message).join('；'));
    return result;
  }
  const base = parsedSource.data;
  if (base.routeMode !== 'map-only') {
    addReason('unsupported-route-mode', '二维码间距调整仅适用于尚未创建路径的定位码地图；已包含路径的地图请保留旧版本并新建扫描');
    return result;
  }
  const fromTag = base.tags.find(tag => tag.id === fromId);
  const toTag = base.tags.find(tag => tag.id === toId);
  if (fromId === toId) addReason('same-tag', '起点与终点不能是同一个二维码', [fromId]);
  if (!fromTag) addReason('unknown-tag', `${pad(fromId)} 不在这张地图中`, [fromId]);
  if (!toTag) addReason('unknown-tag', `${pad(toId)} 不在这张地图中`, [toId]);
  if (result.reasons.length || !fromTag || !toTag) return result;
  const fromLabel = tagPositionLabel(fromTag), toLabel = tagPositionLabel(toTag);
  if (!Number.isFinite(targetM) || targetM <= 0) {
    addReason('invalid-target', '目标中心间距必须是正的有限数值', [fromId, toId]);
    return result;
  }
  if (!Number.isFinite(toleranceM) || toleranceM <= 0) {
    addReason('invalid-tolerance', '共线容差必须是正的有限数值', [fromId, toId]);
    return result;
  }
  if (targetM < MIN_TAG_DISTANCE_M) {
    addReason('distance-too-small',
      `目标中心间距 ${(targetM * 100).toFixed(1)} cm 小于最小允许值 ${(MIN_TAG_DISTANCE_M * 100).toFixed(0)} cm：整组二维码会互相压盖`,
      [fromId, toId]);
    return result;
  }
  const deviationHorizontal = Math.abs(toTag.y - fromTag.y);
  const deviationVertical = Math.abs(toTag.x - fromTag.x);
  const horizontalOk = deviationHorizontal <= toleranceM;
  const verticalOk = deviationVertical <= toleranceM;
  if (!horizontalOk && !verticalOk) {
    addReason('non-collinear',
      `${fromLabel} 与 ${toLabel} 不在同一条水平或垂直直线上（横向偏差 ${(deviationVertical * 100).toFixed(1)} cm、纵向偏差 ${(deviationHorizontal * 100).toFixed(1)} cm），单点间距不能跨拐角`,
      [fromId, toId]);
    return result;
  }
  // Both axes can only qualify when the two centres nearly coincide; prefer the
  // axis that actually carries the larger separation so the direction is stable.
  const axis: TagAxis = horizontalOk && (!verticalOk || deviationHorizontal <= deviationVertical)
    ? 'horizontal' : 'vertical';
  const beforeM = distance(fromTag, toTag);
  if (beforeM <= 1e-9) {
    addReason('degenerate-line', `${fromLabel} 与 ${toLabel} 的中心完全重合，无法确定调整方向`, [fromId, toId]);
    return result;
  }
  const neighborhood = neighborsOnLine(base, fromId, toleranceM);
  const line = axis === 'horizontal' ? neighborhood.horizontal : neighborhood.vertical;
  if (!line || !line.memberIds.includes(toId)) {
    addReason('non-collinear', `${fromLabel} 与 ${toLabel} 不在同一条直线（同一作物行）上，不能按该方向移动`, [fromId, toId]);
    return result;
  }
  // Direction is the current A→B ray, so only the distance along the existing
  // line changes: no lateral snap is silently applied by a single-point edit.
  const direction = {x: (toTag.x - fromTag.x) / beforeM, y: (toTag.y - fromTag.y) / beforeM};
  const movedRaw = {x: fromTag.x + direction.x * targetM, y: fromTag.y + direction.y * targetM};
  const moved = {x: signedZero(micro(movedRaw.x)), y: signedZero(micro(movedRaw.y))};
  const candidate: FieldMap = {
    ...base,
    coordinateStatus: 'draft',
    tags: cloneTags(base).map(tag => (tag.id === toId ? {...tag, x: moved.x, y: moved.y} : tag)),
  };
  const afterM = distance(fromTag, moved);
  const deltaM = afterM - beforeM;
  result.axis = axis;
  result.direction = direction;
  result.from = plainPoint(fromTag);
  result.beforeM = beforeM;
  result.afterM = afterM;
  result.before = metres(beforeM);
  result.after = metres(afterM);
  result.deltaM = micro(deltaM);
  result.line = {axis, memberIds: line.memberIds, spanM: line.spanM, maxDeviationM: line.maxDeviationM};
  if (Math.abs(deltaM) <= 1e-6) {
    addReason('no-changes', '目标间距与当前间距相同，没有可保存的改动', [fromId, toId]);
  }
  // A group centre carries its printed members rigidly; its layout is stored
  // relative to the centre, so translating the centre is the whole edit.
  for (const [role, tag, label] of [['from', fromTag, fromLabel], ['to', toTag, toLabel]] as const) {
    if (!tag.groupId) continue;
    const group = base.groups?.find(item => item.id === tag.groupId);
    if (!group) {
      addReason('invalid-group', `${label}（${role === 'from' ? '固定端' : '移动端'}）缺少定位组定义`, [tag.id]);
      continue;
    }
    if (!boardSchema.safeParse(group).success) {
      addReason('group-geometry', `定位组 ${group.id} 成员几何不合法，不能只移动它的中心`, [tag.id]);
      continue;
    }
    if (role === 'to') {
      result.rigidMemberCount = group.members.length;
      addNote('rigid-group', `${label}：整组 ${group.members.length} 个成员随组中心刚性平移，成员相对布局未改变`, [tag.id]);
    }
  }
  // Moving the far point past a third point keeps the edit legal for
  // mapSchema/validate, but the operator must see that the run is no longer
  // monotonic — a note, never a silent pass.
  const offsetBefore = micro(along(axis, toTag) - along(axis, fromTag));
  const offsetAfter = micro(along(axis, moved) - along(axis, fromTag));
  const low = Math.min(offsetBefore, offsetAfter), high = Math.max(offsetBefore, offsetAfter);
  const crowded = line.points
    .filter(point => point.id !== fromId && point.id !== toId)
    .filter(point => point.offsetM > low && point.offsetM < high);
  if (crowded.length) {
    addNote('crosses-neighbour',
      `移动后 ${toLabel} 会越过 ${crowded.map(point => point.label).join('、')}，该直线上的间距将不再均匀`,
      crowded.map(point => point.id));
  }
  result.points = [{
    id: toTag.id,
    label: toLabel,
    groupId: toTag.groupId ?? null,
    before: plainPoint(toTag),
    after: plainPoint(moved),
    displacementM: distance(toTag, moved),
    offsetBeforeM: offsetBefore,
    offsetAfterM: offsetAfter,
    rigidMemberCount: result.rigidMemberCount,
  }];
  result.displacementM = result.points[0]!.displacementM;
  result.changedIds = result.points.filter(point => point.displacementM > 1e-6).map(point => point.id);
  result.affectedIds = [...result.changedIds];
  result.maxDisplacementM = result.points.reduce((max, point) => Math.max(max, point.displacementM), 0);
  if (JSON.stringify(candidate.groups ?? null) !== JSON.stringify(base.groups ?? null)) {
    addReason('groups-modified', '定位组定义不得在间距调整中改变');
  }
  const parsed = mapSchema.safeParse(candidate);
  if (!parsed.success) {
    addReason('invalid-map', parsed.error.issues.map(issue => issue.message).join('；'));
  } else {
    result.map = parsed.data;
    const validation = validate(parsed.data);
    for (const message of validation.errors) {
      addReason(message.includes('重叠') ? 'overlap' : 'invalid-geometry', message, issueIds(message));
    }
    for (const message of validation.warnings) addNote('warning', message);
    addNote('version-semantics', '保存将生成新的地图版本；旧版本、旧路线和旧任务的绑定保持不变');
    if (result.maxDisplacementM > .05) {
      addNote('large-displacement', `最大中心位移 ${(result.maxDisplacementM * 100).toFixed(1)} cm，请目视确认预览`, result.changedIds);
    }
  }
  result.ready = result.reasons.length === 0 && result.changedIds.length > 0 && result.map !== null;
  return result;
}

// --- batch equal spacing ----------------------------------------------------

export interface EqualSpacingRequest {ids: readonly number[]; targetM: number; toleranceM?: number}
export interface EqualSpacingPoint {
  index: number; id: number; label: string; groupId: string | null;
  before: Point; after: Point;
  /** Gap to the previous point in the run; 0 for the fixed first point. */
  beforeGapM: number; afterGapM: number;
  /** Signed offset from the fixed first point along the line. */
  beforeOffsetM: number; afterOffsetM: number;
  displacementM: number;
  rigidMemberCount: number;
}
export interface EqualSpacingPreview {
  ready: boolean;
  map: FieldMap | null;
  /** The accepted run order, first point first. */
  ids: number[];
  axis: TagAxis | null;
  direction: Point | null;
  /** The point kept fixed (always the first entry of `ids`). */
  fixedId: number | null;
  targetM: number;
  count: number;
  points: EqualSpacingPoint[];
  changedIds: number[];
  affectedIds: number[];
  rigidMemberCount: number;
  maxDisplacementM: number;
  spanBeforeM: number;
  spanAfterM: number;
  /** Largest lateral correction applied to keep the run exactly straight. */
  maxLateralM: number;
  /** The straight run the batch belongs to (for the preview overlay). */
  line: {axis: TagAxis; memberIds: number[]; spanM: number; maxDeviationM: number} | null;
  reasons: TagDistanceIssue[];
  notes: TagDistanceIssue[];
  disclaimer: string;
}

export function previewEqualSpacing(source: FieldMap, request: EqualSpacingRequest): EqualSpacingPreview {
  const ids = [...request.ids];
  const targetM = request.targetM;
  const toleranceM = request.toleranceM ?? LINE_TOLERANCE_M;
  const result: EqualSpacingPreview = {
    ready: false, map: null, ids, axis: null, direction: null, fixedId: ids[0] ?? null,
    targetM, count: ids.length, points: [], changedIds: [], affectedIds: [], rigidMemberCount: 0,
    maxDisplacementM: 0, spanBeforeM: 0, spanAfterM: 0, maxLateralM: 0, line: null,
    reasons: [], notes: [], disclaimer: TAG_DISTANCE_DISCLAIMER,
  };
  const addReason = (code: string, message: string, tagIds: number[] = []) => {
    result.reasons.push({code, message, tagIds: [...new Set(tagIds)].sort((a, b) => a - b)});
  };
  const addNote = (code: string, message: string, tagIds: number[] = []) => {
    result.notes.push({code, message, tagIds: [...new Set(tagIds)].sort((a, b) => a - b)});
  };
  const parsedSource = mapSchema.safeParse(source);
  if (!parsedSource.success) {
    addReason('invalid-source', parsedSource.error.issues.map(issue => issue.message).join('；'));
    return result;
  }
  const base = parsedSource.data;
  if (base.routeMode !== 'map-only') {
    addReason('unsupported-route-mode', '二维码间距调整仅适用于尚未创建路径的定位码地图；已包含路径的地图请保留旧版本并新建扫描');
    return result;
  }
  if (ids.length < 2) {
    addReason('too-few-points', '批量等间距至少需要两个二维码');
    return result;
  }
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) addReason('duplicate-id', `${pad(id)} 被重复提交`, [id]);
    seen.add(id);
  }
  const tags: Tag[] = [];
  for (const id of ids) {
    const tag = base.tags.find(item => item.id === id);
    if (!tag) addReason('unknown-tag', `${pad(id)} 不在这张地图中`, [id]);
    else tags.push(tag);
  }
  if (result.reasons.length) return result;
  const labels = tags.map(tag => tagPositionLabel(tag));
  if (!Number.isFinite(targetM) || targetM <= 0) {
    addReason('invalid-target', '目标中心间距必须是正的有限数值', ids);
    return result;
  }
  if (targetM < MIN_TAG_DISTANCE_M) {
    addReason('distance-too-small',
      `目标中心间距 ${(targetM * 100).toFixed(1)} cm 小于最小允许值 ${(MIN_TAG_DISTANCE_M * 100).toFixed(0)} cm：整组二维码会互相压盖`,
      ids);
    return result;
  }
  if (!Number.isFinite(toleranceM) || toleranceM <= 0) {
    addReason('invalid-tolerance', '共线容差必须是正的有限数值', ids);
    return result;
  }
  const namedRows = new Set(tags.map(tag => tag.rowId).filter(Boolean));
  if (namedRows.size > 1) {
    addReason('non-collinear', `所选二维码分属 ${[...namedRows].join('、')} 等多条作物行，不能等距重排`, ids);
    return result;
  }
  // The run's axis is decided by its dominant extent, then every consecutive
  // pair must stay inside the perpendicular tolerance — a chain test, so slow
  // scan noise cannot accumulate into a false "straight" run.
  let sumAbsX = 0, sumAbsY = 0;
  for (let index = 1; index < tags.length; index++) {
    sumAbsX += Math.abs(tags[index]!.x - tags[index - 1]!.x);
    sumAbsY += Math.abs(tags[index]!.y - tags[index - 1]!.y);
  }
  if (sumAbsX <= 1e-9 && sumAbsY <= 1e-9) {
    addReason('degenerate-line', '所选二维码中心全部重合，无法确定等距方向', ids);
    return result;
  }
  const axis: TagAxis = sumAbsX >= sumAbsY ? 'horizontal' : 'vertical';
  for (let index = 1; index < tags.length; index++) {
    const gap = perpendicularGap(axis, tags[index - 1]!, tags[index]!);
    if (gap > toleranceM) {
      addReason('non-collinear',
        `${labels[index - 1]} → ${labels[index]} 偏离${axis === 'horizontal' ? '水平' : '垂直'}直线 ${(gap * 100).toFixed(1)} cm，超过共线容差 ${(toleranceM * 100).toFixed(0)} cm；等间距不能跨拐角或混入其他行`,
        [ids[index - 1]!, ids[index]!]);
      return result;
    }
  }
  const steps = tags.map(tag => along(axis, tag));
  const signs = steps.slice(1).map((value, index) => Math.sign(value - steps[index]!) || 0);
  if (signs.some(sign => sign === 0) || signs.some(sign => sign !== signs[0])) {
    addReason('order-not-monotonic',
      `提交顺序与几何顺序不一致：${labels.join(' → ')} 在${axis === 'horizontal' ? '横' : '纵'}坐标上不是单调排列，请按实际行内顺序选择`,
      ids);
    return result;
  }
  const sign = signs[0]!;
  // `+ 0` folds the -0 that `sign * 0` would otherwise produce on the idle axis.
  const direction = {x: signedZero(sign * unitOf(axis).x), y: signedZero(sign * unitOf(axis).y)};
  const first = tags[0]!;
  const fixedId = first.id;
  // The first point is the fixed reference and is copied byte-for-byte, so a
  // batch preview can never drift the point the operator did not select to move.
  const positions = tags.map((_tag, index) => (index === 0
    ? {x: first.x, y: first.y}
    : {
      // `+ 0` keeps a rounded zero from becoming -0 in the saved map body.
      x: signedZero(micro(first.x + direction.x * targetM * index)),
      y: signedZero(micro(first.y + direction.y * targetM * index)),
    }));
  const candidate: FieldMap = {
    ...base,
    coordinateStatus: 'draft',
    tags: cloneTags(base).map(tag => {
      const index = ids.indexOf(tag.id);
      return index < 0 ? tag : {...tag, x: positions[index]!.x, y: positions[index]!.y};
    }),
  };
  const neighborhood = neighborsOnLine(base, fixedId, toleranceM);
  const line = axis === 'horizontal' ? neighborhood.horizontal : neighborhood.vertical;
  const points: EqualSpacingPoint[] = [];
  for (const [index, tag] of tags.entries()) {
    const position = positions[index]!;
    const group = tag.groupId ? base.groups?.find(item => item.id === tag.groupId) : undefined;
    if (tag.groupId && !group) {
      addReason('invalid-group', `${tagPositionLabel(tag)} 缺少定位组定义`, [tag.id]);
    } else if (group) {
      if (!boardSchema.safeParse(group).success) {
        addReason('group-geometry', `定位组 ${group.id} 成员几何不合法，不能只移动它的中心`, [tag.id]);
      }
      result.rigidMemberCount += group.members.length;
    }
    const before = plainPoint(tag);
    const after = plainPoint(position);
    const noChange = distance(before, after) <= 1e-6;
    points.push({
      index,
      id: tag.id,
      label: tagPositionLabel(tag),
      groupId: tag.groupId ?? null,
      before,
      after: noChange ? before : after,
      beforeGapM: index === 0 ? 0 : distance(tags[index - 1]!, tag),
      afterGapM: index === 0 ? 0 : distance(position, positions[index - 1]!),
      beforeOffsetM: micro(along(axis, tag) - along(axis, first)),
      afterOffsetM: micro(along(axis, position) - along(axis, first)),
      displacementM: noChange ? 0 : distance(before, after),
      rigidMemberCount: group?.members.length ?? 0,
    });
  }
  result.points = points;
  result.ids = points.map(point => point.id);
  result.axis = axis;
  result.direction = direction;
  result.fixedId = fixedId;
  result.changedIds = points.filter(point => point.displacementM > 1e-6).map(point => point.id).sort((a, b) => a - b);
  result.affectedIds = [...result.changedIds];
  result.maxDisplacementM = points.reduce((max, point) => Math.max(max, point.displacementM), 0);
  result.maxLateralM = tags.reduce((max, tag, index) => Math.max(max, perpendicularGap(axis, first, positions[index]!)), 0);
  result.spanBeforeM = Math.abs(along(axis, tags.at(-1)!) - along(axis, first));
  result.spanAfterM = Math.abs(targetM * (tags.length - 1));
  result.line = line ? {axis: line.axis, memberIds: line.memberIds, spanM: line.spanM, maxDeviationM: line.maxDeviationM} : null;
  if (!result.changedIds.length) {
    addReason('no-changes', '所选二维码已经按目标间距等距排列，没有可保存的改动', ids);
  }
  for (const point of points) {
    if (point.rigidMemberCount) {
      addNote('rigid-group', `${point.label}：整组 ${point.rigidMemberCount} 个成员随组中心刚性平移，成员相对布局未改变`, [point.id]);
    }
  }
  if (result.maxLateralM > 1e-6) {
    addNote('lateral-snap', `为保持严格共线，最大横向修正 ${(result.maxLateralM * 100).toFixed(1)} cm`, ids);
  }
  addNote('order-preserved', `固定首点 ${tagPositionLabel(first)}，其余点位沿原直线方向按目标间距重排，顺序与朝向不变`, ids);
  if (JSON.stringify(candidate.groups ?? null) !== JSON.stringify(base.groups ?? null)) {
    addReason('groups-modified', '定位组定义不得在间距调整中改变');
  }
  const parsed = mapSchema.safeParse(candidate);
  if (!parsed.success) {
    addReason('invalid-map', parsed.error.issues.map(issue => issue.message).join('；'));
  } else {
    result.map = parsed.data;
    const validation = validate(parsed.data);
    for (const message of validation.errors) {
      addReason(message.includes('重叠') ? 'overlap' : 'invalid-geometry', message, issueIds(message));
    }
    for (const message of validation.warnings) addNote('warning', message);
    addNote('version-semantics', '保存将生成新的地图版本；旧版本、旧路线和旧任务的绑定保持不变');
    if (result.maxDisplacementM > .05) {
      addNote('large-displacement', `最大中心位移 ${(result.maxDisplacementM * 100).toFixed(1)} cm，请目视确认预览`, result.changedIds);
    }
  }
  result.ready = result.reasons.length === 0 && result.changedIds.length > 0 && result.map !== null;
  return result;
}
