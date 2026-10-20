import {mapSchema, validate, distance, type FieldMap, type Point} from './model';
import {applyMapAlignment, estimateMapAlignment, type FittedPoint} from './map-alignment';

export interface CorrectionAdjacency {fromId: number; toId: number}
export interface OrthogonalCorrectionOptions {
  rotationDeg?: number;
  /** Maximum residual from a common line, in metres; default .05. */
  toleranceM?: number;
  /** Maximum nonrigid displacement, in metres; default .05. */
  maxFitDisplacementM?: number;
  /** Maximum displacement including SE2, in metres; default .25. */
  maxDisplacementM?: number;
  /** Verified edges only. When supplied, replaces inferred adjacency, including []. */
  adjacency?: readonly CorrectionAdjacency[];
}
export interface CorrectionLine {
  id: string;
  /** In the SE2-aligned frame: row has constant y, column has constant x. */
  axis: 'row' | 'column';
  tagIds: number[];
  coordinateM: number;
  /** Maximum transverse residual before nonrigid projection. */
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
  reasons: CorrectionReason[];
  /** Geometric consensus and coverage, not measured positioning accuracy. */
  confidence: number;
  /** Allows a separate manual workflow; does not override any readiness blocker. */
  manualFallbackAllowed: boolean;
}

type Axis = CorrectionLine['axis'];
type Edge = {a: number; b: number; axis: Axis; explicit: boolean};
type CandidateLine = CorrectionLine & {explicit: boolean};
const minimumBaselineM = .08;
const angularSlope = Math.tan(6 * Math.PI / 180);
const epsilon = 1e-10;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const point = (p: Point): Point => ({x: p.x, y: p.y});
const transverse = (axis: Axis): 'x' | 'y' => axis === 'row' ? 'y' : 'x';
const longitudinal = (axis: Axis): 'x' | 'y' => axis === 'row' ? 'x' : 'y';

/**
 * Pure map-only preview. SE2 comes from map-alignment; only supported line centres
 * undergo nonrigid projection. Independent line offsets retain unequal spacing.
 * No scale factor, path fitting, persistence, version change, or measured-accuracy claim.
 */
export function previewOrthogonalCorrection(
  source: FieldMap, options: OrthogonalCorrectionOptions = {},
): OrthogonalCorrectionPreview {
  const tolerance = options.toleranceM ?? .05;
  const fitLimit = options.maxFitDisplacementM ?? .05;
  const totalLimit = options.maxDisplacementM ?? .25;
  for (const [name, value] of [['toleranceM', tolerance], ['maxFitDisplacementM', fitLimit], ['maxDisplacementM', totalLimit]] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
  }
  if (options.rotationDeg !== undefined && !Number.isFinite(options.rotationDeg)) throw new Error('rotationDeg must be finite');
  if (options.adjacency !== undefined && !Array.isArray(options.adjacency)) throw new Error('adjacency must be an array');
  const map = mapSchema.parse(source);
  const result: OrthogonalCorrectionPreview = {
    ready: false, map: null, reason: '', points: [], outlierIds: [],
    maxDisplacementM: 0, maxFitDisplacementM: 0, maxDistanceChangeM: 0, distanceChanges: [],
    rotationDeg: null, lines: [], ambiguities: [], reasons: [], confidence: 0, manualFallbackAllowed: false,
  };
  const addReason = (code: string, message: string, tagIds: number[] = []) => {
    result.reasons.push({code, message, tagIds: [...new Set(tagIds)].sort((a, b) => a - b)});
  };
  const disclaimer = '不代表实测精度提升；须人工检查并通过现有 API 显式保存新版本';
  if (map.routeMode !== 'map-only') {
    addReason('unsupported-route-mode', '非刚体几何校正仅适用于 map-only 定位码地图');
    result.reason = `${result.reasons[0].message}；${disclaimer}`;
    return result;
  }
  result.manualFallbackAllowed = true;
  const sourceErrors = validate(map).errors;
  if (sourceErrors.length) addReason('invalid-source', sourceErrors.join('；'));
  const estimated = estimateMapAlignment({tags: [...map.tags].sort((a, b) => a.id - b.id)});
  if (!estimated.ready) addReason('low-confidence', `${estimated.reason}；可另行手动回退，不自动确认`);
  const rotation = options.rotationDeg ?? estimated.rotationDeg;
  let aligned: FieldMap = {...map, coordinateStatus: 'draft'};
  if (rotation !== null) {
    const rigid = applyMapAlignment(map, rotation);
    aligned = rigid.map;
    result.rotationDeg = rigid.transform.rotationDeg;
  }
  const tags = [...aligned.tags].sort((a, b) => a.id - b.id);
  const byId = new Map(tags.map(t => [t.id, t]));
  const edges: Edge[] = [];
  const blocked = new Set<number>();
  const ambiguityKeys = new Set<string>();
  const ambiguous = (code: string, ids: number[], message: string) => {
    const tagIds = [...new Set(ids)].sort((a, b) => a - b), key = `${code}:${tagIds.join(',')}`;
    if (!ambiguityKeys.has(key)) {
      ambiguityKeys.add(key);
      result.ambiguities.push({code, tagIds, message});
    }
    tagIds.forEach(id => blocked.add(id));
  };
  const axial = (a: Point, b: Point): Axis | null => {
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    if (dx >= minimumBaselineM && dy <= 2 * tolerance + epsilon && dy <= dx * angularSlope + epsilon) return 'row';
    if (dy >= minimumBaselineM && dx <= 2 * tolerance + epsilon && dx <= dy * angularSlope + epsilon) return 'column';
    return null;
  };
  if (rotation !== null && sourceErrors.length === 0) {
    if (options.adjacency !== undefined) {
      const seen = new Set<string>();
      for (const edge of options.adjacency) {
        const a = byId.get(edge.fromId), b = byId.get(edge.toId);
        const axis = a && b && a.id !== b.id ? axial(a, b) : null;
        if (!a || !b || !axis) {
          addReason('invalid-adjacency', '显式邻接引用无效、基线不足或方向不支持正交线', [edge.fromId, edge.toId]);
          continue;
        }
        const lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id), key = `${axis}:${lo}:${hi}`;
        if (!seen.has(key)) {seen.add(key); edges.push({a: lo, b: hi, axis, explicit: true});}
      }
    } else {
      // Use local geometric evidence, not all pairs sharing nearly the same x/y.
      const nearest = tags.map(a => Math.min(...tags.filter(b => b.id !== a.id)
        .map(b => distance(a, b)).filter(d => d >= minimumBaselineM))).filter(Number.isFinite);
      const cutoff = nearest.length ? 3 * median(nearest) : 0;
      const buckets = new Map<string, {id: number; length: number; along: number}[]>();
      const candidates: Edge[] = [];
      const directionKey = (id: number, otherId: number, axis: Axis): string => {
        const coordinate = longitudinal(axis);
        return `${id}:${axis}:${Math.sign(byId.get(otherId)![coordinate] - byId.get(id)![coordinate])}`;
      };
      for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
        const a = tags[i], b = tags[j], length = distance(a, b);
        if (length > cutoff + epsilon) continue;
        const axis = axial(a, b);
        if (!axis) continue;
        candidates.push({a: a.id, b: b.id, axis, explicit: false});
        for (const [from, to] of [[a, b], [b, a]]) {
          const key = directionKey(from.id, to.id, axis), group = buckets.get(key) ?? [];
          group.push({id: to.id, length, along: Math.abs(to[longitudinal(axis)] - from[longitudinal(axis)])});
          buckets.set(key, group);
        }
      }
      const selected = new Map<string, number>();
      for (const [key, neighbors] of buckets) {
        neighbors.sort((a, b) => a.length - b.length || a.id - b.id);
        const best = neighbors[0];
        const ties = neighbors.slice(1).filter(n => n.length - best.length <= 2 * tolerance + epsilon
          && Math.abs(n.along - best.along) <= 2 * tolerance + epsilon);
        if (ties.length) {
          ambiguous('neighbor-ambiguity', [Number(key.split(':')[0]), best.id, ...ties.map(n => n.id)],
            '同一方向存在近等价邻接候选，不能自动选择同排同列');
        } else selected.set(key, best.id);
      }
      for (const edge of candidates) {
        if (!blocked.has(edge.a) && !blocked.has(edge.b)
          && selected.get(directionKey(edge.a, edge.b, edge.axis)) === edge.b
          && selected.get(directionKey(edge.b, edge.a, edge.axis)) === edge.a) edges.push(edge);
      }
    }
  }
  const candidates: CandidateLine[] = [];
  for (const axis of ['row', 'column'] as const) {
    const relevant = edges.filter(e => e.axis === axis), parent = new Map<number, number>();
    const root = (id: number): number => {
      let r = id;
      while (parent.get(r)! !== r) r = parent.get(r)!;
      while (id !== r) {const next = parent.get(id)!; parent.set(id, r); id = next;}
      return r;
    };
    for (const edge of relevant) {
      if (!parent.has(edge.a)) parent.set(edge.a, edge.a);
      if (!parent.has(edge.b)) parent.set(edge.b, edge.b);
      const a = root(edge.a), b = root(edge.b);
      parent.set(Math.max(a, b), Math.min(a, b));
    }
    const groups = new Map<number, number[]>();
    for (const id of parent.keys()) {const r = root(id), ids = groups.get(r) ?? []; ids.push(id); groups.set(r, ids);}
    for (const ids of [...groups.values()].sort((a, b) => Math.min(...a) - Math.min(...b))) {
      ids.sort((a, b) => a - b);
      const values = ids.map(id => byId.get(id)![transverse(axis)]), coordinateM = median(values);
      const maxResidualM = Math.max(...values.map(v => Math.abs(v - coordinateM)));
      // A bounded whole cluster prevents transitive tolerance chaining.
      if (maxResidualM > tolerance + epsilon || Math.max(...values) - Math.min(...values) > 2 * tolerance + epsilon) {
        ambiguous('cluster-drift', ids, '邻接链整体超出同一直线容差，不能逐段吸附扩大线簇');
        continue;
      }
      candidates.push({id: `${axis}:${ids.join('-')}`, axis, tagIds: ids, coordinateM, maxResidualM,
        explicit: relevant.some(e => e.explicit && ids.includes(e.a) && ids.includes(e.b))});
    }
  }
  let active = candidates.filter(line => line.tagIds.every(id => !blocked.has(id)));
  // Prune unsupported two-point lines to a fixed point. Rectangles support each
  // other; L/U fragments cannot bootstrap missing independent constraints.
  for (;;) {
    const membership = new Map<string, string>();
    for (const line of active) for (const id of line.tagIds) membership.set(`${line.axis}:${id}`, line.id);
    const next = active.filter(line => {
      if (line.explicit || line.tagIds.length >= 3) return true;
      const other: Axis = line.axis === 'row' ? 'column' : 'row';
      const a = membership.get(`${other}:${line.tagIds[0]}`), b = membership.get(`${other}:${line.tagIds[1]}`);
      return a !== undefined && b !== undefined && a !== b;
    });
    if (next.length === active.length) break;
    active = next;
  }
  result.lines = active.map(({explicit: _explicit, ...line}) => line);
  const targets = new Map<number, Partial<Point>>();
  const memberships = new Map<string, string>();
  for (const line of result.lines) for (const id of line.tagIds) {
    const target = targets.get(id) ?? {};
    target[transverse(line.axis)] = line.coordinateM;
    targets.set(id, target);
    memberships.set(`${line.axis}:${id}`, line.id);
  }
  const intersections = new Map<string, number>();
  for (const tag of tags) {
    const row = memberships.get(`row:${tag.id}`), column = memberships.get(`column:${tag.id}`);
    if (!row || !column) continue;
    const key = `${row}|${column}`, previous = intersections.get(key);
    if (previous !== undefined) ambiguous('intersection-collision', [previous, tag.id], '多个定位码被分配到同一交点');
    else intersections.set(key, tag.id);
  }
  const corrected = aligned.tags.map((tag, i) => {
    const target = targets.get(tag.id), after = {...tag, x: target?.x ?? tag.x, y: target?.y ?? tag.y};
    const displacementM = distance(map.tags[i], after), fitDisplacementM = distance(tag, after), outlier = !target;
    result.points.push({id: tag.id, before: point(map.tags[i]), aligned: point(tag), after: point(after),
      displacementM, fitDisplacementM, outlier});
    if (outlier) result.outlierIds.push(tag.id);
    result.maxDisplacementM = Math.max(result.maxDisplacementM, displacementM);
    result.maxFitDisplacementM = Math.max(result.maxFitDisplacementM, fitDisplacementM);
    return after;
  });
  for (let i = 0; i < corrected.length; i++) for (let j = i + 1; j < corrected.length; j++) {
    const beforeM = distance(map.tags[i], map.tags[j]), afterM = distance(corrected[i], corrected[j]), changeM = afterM - beforeM;
    result.distanceChanges.push({fromId: corrected[i].id, toId: corrected[j].id, beforeM, afterM, changeM});
    result.maxDistanceChangeM = Math.max(result.maxDistanceChangeM, Math.abs(changeM));
  }
  result.confidence = estimated.confidence * (corrected.length - result.outlierIds.length) / corrected.length;
  if (result.lines.length === 0) addReason('insufficient-support', '没有获得第三点、正交交叉或显式邻接支持的线簇');
  if (result.outlierIds.length) addReason('outliers', '部分点位没有可靠线簇支持，保留其 SE2 基线位置，不自动确认', result.outlierIds);
  if (result.ambiguities.length) addReason('ambiguity', '存在邻接、线簇或交点歧义，禁止自动确认', result.ambiguities.flatMap(a => a.tagIds));
  if (result.maxFitDisplacementM > fitLimit + epsilon) addReason('fit-displacement-limit', '非刚体拟合位移超过上限',
    result.points.filter(p => p.fitDisplacementM > fitLimit + epsilon).map(p => p.id));
  if (result.maxDisplacementM > totalLimit + epsilon) addReason('total-displacement-limit', '包含 SE2 的总位移超过上限',
    result.points.filter(p => p.displacementM > totalLimit + epsilon).map(p => p.id));
  const candidate = mapSchema.safeParse({...aligned, tags: corrected, coordinateStatus: 'draft'});
  if (candidate.success) {
    result.map = candidate.data;
    const errors = validate(candidate.data).errors;
    if (errors.length) addReason('invalid-preview', errors.join('；'));
  } else addReason('invalid-preview', candidate.error.issues.map(i => i.message).join('；'));
  result.ready = result.reasons.length === 0;
  result.reason = `${result.ready ? '可靠邻接支持的正交线簇中位数投影预览' : result.reasons.map(r => r.message).join('；')}；${disclaimer}`;
  return result;
}
