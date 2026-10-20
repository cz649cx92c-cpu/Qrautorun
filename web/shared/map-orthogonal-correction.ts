import {mapSchema, validate, distance, type FieldMap, type Point} from './model';
import {applyMapAlignment, estimateMapAlignment, type FittedPoint} from './map-alignment';

export interface CorrectionAdjacency {fromId: number; toId: number}
export interface OrthogonalCorrectionOptions {
  rotationDeg?: number;
  /** Maximum transverse residual allowed inside one row/column cluster, in metres; default .08. */
  toleranceM?: number;
  /** Maximum nonrigid displacement of a single centre, in metres; default .08. */
  maxFitDisplacementM?: number;
  /** Maximum displacement including the rigid rotation, in metres; default 1.5. */
  maxDisplacementM?: number;
  /** Verified edges only. When supplied, those pairs are forced onto one row/column. */
  adjacency?: readonly CorrectionAdjacency[];
}
export interface CorrectionLine {
  id: string;
  /** In the SE2-aligned frame: row has constant y, column has constant x. */
  axis: 'row' | 'column';
  tagIds: number[];
  coordinateM: number;
  /** Maximum transverse residual before the cluster is collapsed onto its median. */
  maxResidualM: number;
}
export interface CorrectionAmbiguity {code: string; tagIds: number[]; message: string}
export interface CorrectionReason {code: string; tagIds: number[]; message: string}
export interface OrthogonalCorrectionPreview {
  ready: boolean;
  /** Diagnostic candidate, also available when blocked. Never apply without checking ready. */
  map: FieldMap | null;
  reason: string;
  points: FittedPoint[];
  outlierIds: number[];
  maxDisplacementM: number;
  maxFitDisplacementM: number;
  maxDistanceChangeM: number;
  distanceChanges: {fromId: number; toId: number; beforeM: number; afterM: number; changeM: number}[];
  rotationDeg: number | null;
  lines: CorrectionLine[];
  ambiguities: CorrectionAmbiguity[];
  /** Blocking conditions only. */
  reasons: CorrectionReason[];
  /** Informational conditions that never block applying. */
  notes: CorrectionReason[];
  /** Axis-consensus confidence of the rigid rotation, not measured positioning accuracy. */
  confidence: number;
  /** Allows a separate manual workflow; does not override any readiness blocker. */
  manualFallbackAllowed: boolean;
}

type Axis = CorrectionLine['axis'];
interface AxisCluster {ids: number[]; coordinateM: number; maxResidualM: number}

const epsilon = 1e-10;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const point = (p: Point): Point => ({x: p.x, y: p.y});
const transverse = (axis: Axis): 'x' | 'y' => axis === 'row' ? 'y' : 'x';

/**
 * Groups coordinates that already sit on one line after the rigid rotation.
 * The span is bounded to 2 * tolerance so two neighbouring rows cannot chain
 * into one cluster through a run of small gaps.
 */
function clusterAxis(entries: {id: number; value: number}[], tolerance: number): AxisCluster[] {
  const sorted = [...entries].sort((a, b) => a.value - b.value || a.id - b.id);
  const groups: {id: number; value: number}[][] = [];
  for (const entry of sorted) {
    const group = groups[groups.length - 1];
    if (group && entry.value - group[0]!.value <= 2 * tolerance + epsilon
      && Math.abs(entry.value - median(group.map(item => item.value))) <= tolerance + epsilon) {
      group.push(entry);
      continue;
    }
    groups.push([entry]);
  }
  return groups.map(group => {
    const values = group.map(item => item.value), coordinateM = median(values);
    return {
      ids: group.map(item => item.id),
      coordinateM,
      maxResidualM: Math.max(...values.map(value => Math.abs(value - coordinateM))),
    };
  });
}

/**
 * Pure map-only preview.
 *
 * 1. The whole map is rotated rigidly so the dominant row direction is parallel to
 *    the x axis. A rotation preserves every centre-to-centre distance.
 * 2. Centres that fall on one row (same y) or one column (same x) are collapsed onto
 *    that cluster's median, which is the only nonrigid step and is bounded by the
 *    tolerance. Unequal row/column spacing is retained: each cluster keeps its own
 *    offset and centres keep their longitudinal coordinate.
 *
 * No scale factor, no path fitting, no persistence, no version change, and no claim
 * about measured accuracy.
 */
export function previewOrthogonalCorrection(
  source: FieldMap, options: OrthogonalCorrectionOptions = {},
): OrthogonalCorrectionPreview {
  const tolerance = options.toleranceM ?? .08;
  // A snap can never exceed the tolerance by construction; the limit only guards against
  // a caller passing an inconsistent pair of options.
  const fitLimit = options.maxFitDisplacementM ?? tolerance * 1.5;
  const totalLimit = options.maxDisplacementM ?? 1.5;
  for (const [name, value] of [['toleranceM', tolerance], ['maxFitDisplacementM', fitLimit], ['maxDisplacementM', totalLimit]] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
  }
  if (options.rotationDeg !== undefined && !Number.isFinite(options.rotationDeg)) throw new Error('rotationDeg must be finite');
  if (options.adjacency !== undefined && !Array.isArray(options.adjacency)) throw new Error('adjacency must be an array');
  const map = mapSchema.parse(source);
  const result: OrthogonalCorrectionPreview = {
    ready: false, map: null, reason: '', points: [], outlierIds: [],
    maxDisplacementM: 0, maxFitDisplacementM: 0, maxDistanceChangeM: 0, distanceChanges: [],
    rotationDeg: null, lines: [], ambiguities: [], reasons: [], notes: [], confidence: 0, manualFallbackAllowed: false,
  };
  const addReason = (code: string, message: string, tagIds: number[] = []) => {
    result.reasons.push({code, message, tagIds: [...new Set(tagIds)].sort((a, b) => a - b)});
  };
  const addNote = (code: string, message: string, tagIds: number[] = []) => {
    result.notes.push({code, message, tagIds: [...new Set(tagIds)].sort((a, b) => a - b)});
  };
  const disclaimer = '不代表实测精度提升；须人工检查并通过现有 API 显式保存新版本';
  if (map.routeMode !== 'map-only') {
    addReason('unsupported-route-mode', '非刚体几何校正仅适用于 map-only 定位码地图');
    result.reason = `${result.reasons[0]!.message}；${disclaimer}`;
    return result;
  }
  result.manualFallbackAllowed = true;
  const sourceErrors = validate(map).errors;
  if (sourceErrors.length) addReason('invalid-source', sourceErrors.join('；'));

  const estimated = estimateMapAlignment({tags: [...map.tags].sort((a, b) => a.id - b.id)});
  result.confidence = estimated.confidence;
  const centroid = map.tags.length
    ? {x: map.tags.reduce((sum, tag) => sum + tag.x, 0) / map.tags.length, y: map.tags.reduce((sum, tag) => sum + tag.y, 0) / map.tags.length}
    : {x: 0, y: 0};
  // A scan is not perfectly rigid: one long row can be a few degrees off the global
  // axis estimate while short rows look flat. Sweeping the angle and keeping the one
  // that puts the most centres onto shared lines aligns the longest evidence first,
  // and the bounded snap below absorbs the remaining few centimetres.
  const scoreRotation = (angleDeg: number) => {
    const cos = Math.cos(angleDeg * Math.PI / 180), sin = Math.sin(angleDeg * Math.PI / 180);
    const xs: {id: number; value: number}[] = [], ys: {id: number; value: number}[] = [];
    for (const tag of map.tags) {
      const dx = tag.x - centroid.x, dy = tag.y - centroid.y;
      xs.push({id: tag.id, value: centroid.x + cos * dx - sin * dy});
      ys.push({id: tag.id, value: centroid.y + sin * dx + cos * dy});
    }
    let supported = 0, residual = 0;
    for (const cluster of [...clusterAxis(xs, tolerance), ...clusterAxis(ys, tolerance)]) {
      if (cluster.ids.length < 2) continue;
      supported += cluster.ids.length;
      residual += cluster.maxResidualM;
    }
    return {supported, residual};
  };
  let rotation = options.rotationDeg ?? null, sweepSupported = 0;
  if (rotation === null) {
    let best = {angle: estimated.rotationDeg ?? 0, supported: -1, residual: Infinity};
    for (let step = -180; step < 180; step++) {
      const angle = step * .25, score = scoreRotation(angle);
      if (score.supported > best.supported || (score.supported === best.supported && score.residual < best.residual - epsilon)) {
        best = {angle, ...score};
      }
    }
    rotation = best.angle;
    sweepSupported = best.supported;
  }
  let aligned: FieldMap = {...map, coordinateStatus: 'draft'};
  if (rotation === null) addReason('no-rotation', `无法估计地图主方向：${estimated.reason}`);
  else {
    const rigid = applyMapAlignment(map, rotation);
    aligned = rigid.map;
    result.rotationDeg = rigid.transform.rotationDeg;
  }

  const original = new Map(map.tags.map(tag => [tag.id, tag]));
  const alignedTags = [...aligned.tags];
  const clusterForced = (clusters: AxisCluster[], axis: Axis): AxisCluster[] => {
    const pairs = options.adjacency ?? [];
    if (!pairs.length) return clusters;
    const parent = new Map<number, number>();
    const root = (id: number): number => {
      let r = id;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (id !== r) {const next = parent.get(id)!; parent.set(id, r); id = next;}
      return r;
    };
    for (const cluster of clusters) for (const id of cluster.ids) parent.set(id, id);
    for (const pair of pairs) {
      if (!parent.has(pair.fromId) || !parent.has(pair.toId)) continue;
      const a = root(pair.fromId), b = root(pair.toId);
      if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
    }
    const merged = new Map<number, number[]>();
    for (const cluster of clusters) for (const id of cluster.ids) {
      const key = root(id), ids = merged.get(key) ?? [];
      ids.push(id);
      merged.set(key, ids);
    }
    return [...merged.values()].map(ids => {
      const values = ids.map(id => alignedTags.find(tag => tag.id === id)![transverse(axis)]), coordinateM = median(values);
      return {ids: ids.sort((a, b) => a - b), coordinateM, maxResidualM: Math.max(...values.map(value => Math.abs(value - coordinateM)))};
    });
  };
  const rows = clusterForced(clusterAxis(alignedTags.map(tag => ({id: tag.id, value: tag.y})), tolerance), 'row');
  const columns = clusterForced(clusterAxis(alignedTags.map(tag => ({id: tag.id, value: tag.x})), tolerance), 'column');

  const targets = new Map<number, Partial<Point>>();
  const assign = (axis: Axis, clusters: AxisCluster[]) => {
    for (const cluster of clusters) {
      if (cluster.ids.length < 2) continue;
      if (cluster.maxResidualM > 2 * tolerance + epsilon) {
        result.ambiguities.push({code: 'cluster-drift', tagIds: cluster.ids, message: `同${axis === 'row' ? '排' : '列'}点位跨度超过容差，不能吸附到同一条线`});
        continue;
      }
      result.lines.push({id: `${axis}:${cluster.ids.join('-')}`, axis, tagIds: cluster.ids, coordinateM: cluster.coordinateM, maxResidualM: cluster.maxResidualM});
      for (const id of cluster.ids) targets.set(id, {...targets.get(id), [transverse(axis)]: cluster.coordinateM});
    }
  };
  assign('row', rows);
  assign('column', columns);
  result.lines.sort((a, b) => a.axis.localeCompare(b.axis) || Math.min(...a.tagIds) - Math.min(...b.tagIds));

  // Two centres must never be collapsed onto the same grid intersection.
  const intersections = new Map<string, number>();
  for (const tag of alignedTags) {
    const target = targets.get(tag.id);
    if (!target) continue;
    const key = `${(target.x ?? tag.x).toFixed(6)}|${(target.y ?? tag.y).toFixed(6)}`;
    const previous = intersections.get(key);
    if (previous !== undefined) result.ambiguities.push({code: 'intersection-collision', tagIds: [previous, tag.id], message: '两个定位码会被吸附到同一交点'});
    else intersections.set(key, tag.id);
  }

  const corrected = alignedTags.map((tag, index) => {
    const target = targets.get(tag.id), after = {...tag, x: target?.x ?? tag.x, y: target?.y ?? tag.y};
    const before = original.get(tag.id) ?? map.tags[index]!;
    const displacementM = distance(before, after), fitDisplacementM = distance(tag, after);
    result.points.push({id: tag.id, before: point(before), aligned: point(tag), after: point(after), displacementM, fitDisplacementM, outlier: !target});
    if (!target) result.outlierIds.push(tag.id);
    result.maxDisplacementM = Math.max(result.maxDisplacementM, displacementM);
    result.maxFitDisplacementM = Math.max(result.maxFitDisplacementM, fitDisplacementM);
    return after;
  });
  for (let i = 0; i < corrected.length; i++) for (let j = i + 1; j < corrected.length; j++) {
    const beforeM = distance(original.get(corrected[i]!.id) ?? map.tags[i]!, original.get(corrected[j]!.id) ?? map.tags[j]!);
    const afterM = distance(corrected[i]!, corrected[j]!), changeM = afterM - beforeM;
    result.distanceChanges.push({fromId: corrected[i]!.id, toId: corrected[j]!.id, beforeM, afterM, changeM});
    result.maxDistanceChangeM = Math.max(result.maxDistanceChangeM, Math.abs(changeM));
  }

  if (!result.lines.length) addReason('no-support', '没有任何两个定位码落在同一排或同一列，无法确定吸附目标；请检查地图或改用实测坐标验收');
  if (result.maxFitDisplacementM > fitLimit + epsilon) addReason('fit-displacement-limit', '逐点吸附位移超过上限',
    result.points.filter(p => p.fitDisplacementM > fitLimit + epsilon).map(p => p.id));
  if (result.maxDisplacementM > totalLimit + epsilon) addReason('total-displacement-limit', '包含整体旋转的总位移超过上限',
    result.points.filter(p => p.displacementM > totalLimit + epsilon).map(p => p.id));

  if (result.rotationDeg !== null) {
    addNote('rigid-rotation', `整体旋转 ${result.rotationDeg.toFixed(2)}°（刚性旋转，不改变任何码间距离）`);
    if (sweepSupported) addNote('rotation-sweep', `方向按“最多点位能落在同一条水平/垂直线上”挑选：${sweepSupported} 个点位有同排/同列同伴`);
    if (result.maxDisplacementM > .25 + epsilon) addNote('rigid-shift', `旋转使最远点移动 ${(result.maxDisplacementM * 100).toFixed(1)} cm，这是坐标方向变化，不是点位误差`);
  }
  if (result.outlierIds.length) addNote('unsupported-points', `${result.outlierIds.length} 个点位单独成排/成列，未参与吸附，保持旋转后的位置`, result.outlierIds);
  if (!estimated.ready) addNote('axis-consensus', `全局主轴一致性 ${(estimated.confidence * 100).toFixed(0)}%，已改用逐点对齐最优方向；请目视确认预览`);

  const candidate = mapSchema.safeParse({...aligned, tags: corrected, coordinateStatus: 'draft'});
  if (candidate.success) {
    result.map = candidate.data;
    const errors = validate(candidate.data).errors;
    if (errors.length) addReason('invalid-preview', errors.join('；'));
  } else addReason('invalid-preview', candidate.error.issues.map(issue => issue.message).join('；'));
  result.ready = result.reasons.length === 0;
  result.reason = result.ready
    ? `整图旋转 ${(result.rotationDeg ?? 0).toFixed(2)}° 后，${result.lines.length} 条行列线上的码已对齐到同一条水平/垂直线；逐点最大移动 ${(result.maxFitDisplacementM * 100).toFixed(1)} cm`
    : result.reasons.map(item => item.message).join('；');
  return result;
}
