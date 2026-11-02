import {distance,type Point} from './model';
import {ROUTE_GROUP_CAPTURE,ROUTE_GRID,routeCorners} from './route-design';

/**
 * Pure geometry editing for the orthogonal route editor.
 *
 * Every function here is side-effect free: it never mutates its arguments and
 * never touches a map, a QR coordinate or a stored route. A route anchor is a
 * path point, so all of these edits only move path points; map tag centres stay
 * immutable. The result is always a candidate point list plus `issues` /
 * `notes`. Saving is the backend's job and still has to pass the existing
 * `compileDesignedRoute` gate (orthogonality, 8cm leg, 50m total, 501 points,
 * 100 intervals) — nothing here relaxes those limits.
 *
 * Coordinates are rounded to micron resolution (1e-6 m) so float noise never
 * reaches a saved route, and `-0` is folded into `0`.
 */

/** Floating-point noise threshold for "this leg is on one axis". */
export const AXIS_EPS = 1e-9;
/** Absolute floor for one leg, mirroring the map QR spacing floor. */
export const MIN_LEG_M = 0.08;
/** Total route length limit, mirroring the compiler. */
export const MAX_TOTAL_M = 50;
/** Control point limit, mirroring `pointSchema` in a route and the compiler. */
export const MAX_POINTS = 501;

/** Round to 1e-6 m and fold `-0` into `0`. */
export const micro = (value: number) => Math.round(value * 1e6) / 1e6 + 0;

export type RouteAxis = 'horizontal' | 'vertical';
export type LegAxis = RouteAxis | 'diagonal' | 'zero';

export interface GeometryIssue {code: string; message: string; legIndex?: number; index?: number; tagIds?: number[]}
export interface RouteEditBase {ready: boolean; points: Point[]; issues: GeometryIssue[]; notes: string[]}

const clone = (points: Point[]): Point[] => points.map(point => ({x: micro(point.x), y: micro(point.y)}));

function readPoints(points: Point[]): Point[] | null {
 if (!Array.isArray(points)) return null;
 const result: Point[] = [];
 for (const point of points) {
  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  result.push({x: micro(point.x), y: micro(point.y)});
 }
 return result;
}

const isFinitePoint = (point: Point | undefined | null): point is Point =>
 !!point && Number.isFinite(point.x) && Number.isFinite(point.y);

export const sameLine = (a: Point, b: Point) =>
 Math.abs(a.x - b.x) <= AXIS_EPS || Math.abs(a.y - b.y) <= AXIS_EPS;

export function axisOf(a: Point, b: Point): LegAxis {
 const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
 if (dx <= AXIS_EPS && dy <= AXIS_EPS) return 'zero';
 if (dy <= AXIS_EPS) return 'horizontal';
 if (dx <= AXIS_EPS) return 'vertical';
 return 'diagonal';
}

/** The corner that turns `previous -> next` into two axis-aligned legs, preferring the longer delta first (same rule as `orthogonalRoute`). */
function cornerBetween(previous: Point, next: Point): Point {
 const dx = next.x - previous.x, dy = next.y - previous.y;
 return Math.abs(dx) >= Math.abs(dy) ? {x: next.x, y: previous.y} : {x: previous.x, y: next.y};
}

/**
 * Append `next` to `out`, inserting at most one corner so the new leg stays
 * horizontal/vertical. Returns the index of the inserted corner, if any.
 * Exact duplicates are dropped so a degenerate move cannot add a zero-length leg.
 */
function appendOrthogonal(out: Point[], next: Point): number | null {
 const previous = out.at(-1);
 if (!previous) {out.push({...next}); return null;}
 const dx = next.x - previous.x, dy = next.y - previous.y;
 if (Math.abs(dx) <= AXIS_EPS && Math.abs(dy) <= AXIS_EPS) return null;
 let corner: number | null = null;
 if (Math.abs(dx) > AXIS_EPS && Math.abs(dy) > AXIS_EPS) {
  out.push(cornerBetween(previous, next));
  corner = out.length - 1;
 }
 out.push({...next});
 return corner;
}

// --- grid -------------------------------------------------------------------

/** Snap one point to the drawing grid (or to an exact group centre upstream). */
export function snapToGrid(point: Point, grid: number = ROUTE_GRID): Point {
 if (!isFinitePoint(point)) throw new Error('吸附点坐标必须是有限数值');
 if (!Number.isFinite(grid) || grid <= 0) throw new Error('网格尺寸必须是正数');
 return {x: micro(Math.round(point.x / grid) * grid), y: micro(Math.round(point.y / grid) * grid)};
}

// --- insert / remove / move -------------------------------------------------

export interface InsertAnchorResult extends RouteEditBase {
 index: number;
 /** Position of the inserted point in `points`, -1 when rejected. */
 insertedIndex: number;
 /** Positions of corner points that had to be added around the new anchor. */
 cornerIndexes: number[];
}

/**
 * Insert one anchor at `index` (0..points.length) without moving any existing
 * anchor. When the new point is off the neighbouring axis, the two joints are
 * repaired with corners so the path stays orthogonal.
 */
export function insertAnchorAt(points: Point[], index: number, point: Point): InsertAnchorResult {
 const base = readPoints(points);
 const reject = (code: string, message: string): InsertAnchorResult =>
  ({ready: false, points: base ?? [], issues: [{code, message, index}], notes: [], index, insertedIndex: -1, cornerIndexes: []});
 if (!base) return reject('bad-points', '路径点必须是有限数值坐标');
 if (!Number.isInteger(index) || index < 0 || index > base.length) return reject('bad-index', '插入位置必须在 0 到路径点数之间');
 if (!isFinitePoint(point)) return reject('bad-point', '插入点坐标必须是有限数值');
 const inserted = {x: micro(point.x), y: micro(point.y)};
 if (base.some(existing => distance(existing, inserted) <= AXIS_EPS)) return reject('duplicate-point', '该位置已存在路径点，不能重复插入');

 const out: Point[] = [], cornerIndexes: number[] = [];
 for (let i = 0; i <= base.length; i++) {
  if (i === index) {
   const corner = appendOrthogonal(out, inserted);
   if (corner !== null) cornerIndexes.push(corner);
  }
  if (i === base.length) break;
  const corner = appendOrthogonal(out, base[i]!);
  if (corner !== null) cornerIndexes.push(corner);
 }
 const insertedIndex = out.findIndex(candidate => candidate.x === inserted.x && candidate.y === inserted.y);
 return {
  ready: true, points: out, issues: [], index, insertedIndex, cornerIndexes,
  notes: cornerIndexes.length ? [`为保持水平/垂直布线，自动插入 ${cornerIndexes.length} 个拐点`] : [],
 };
}

export interface RemoveAnchorResult extends RouteEditBase {
 index: number;
 removed: Point | null;
 /** False when the point was redundant and the path is byte-identical afterwards. */
 changed: boolean;
}

/**
 * Remove one anchor. A point in the middle of a straight run is simply dropped;
 * a real corner is refused because the two neighbouring legs would turn into a
 * diagonal — the operator has to move the corner instead of deleting it.
 */
export function removeAnchor(points: Point[], index: number): RemoveAnchorResult {
 const base = readPoints(points);
 const reject = (code: string, message: string): RemoveAnchorResult =>
  ({ready: false, points: base ?? [], issues: [{code, message, index}], notes: [], index, removed: null, changed: false});
 if (!base) return reject('bad-points', '路径点必须是有限数值坐标');
 if (!Number.isInteger(index) || index < 0 || index >= base.length) return reject('bad-index', '删除位置必须在 0 到路径点数减一之间');
 if (base.length <= 2) return reject('too-few-points', '路径至少保留两个控制点，无法再删除');
 const previous = base[index - 1], next = base[index + 1];
 if (previous && next && !sameLine(previous, next)) {
  return reject('corner-required', '该点是拐点，删除后相邻两段会变成斜线；请改用移动拐点，或删除相邻的直线中间点');
 }
 if (previous && next && distance(previous, next) <= AXIS_EPS) {
  return reject('fold-required', '该点是折返顶点，删除后首尾会重合；请先移开其中一侧');
 }
 const removed = {...base[index]!};
 const out = base.filter((_, position) => position !== index);
 const notes: string[] = [];
 if (index === 0) notes.push('已删除路径起点，路线将从新的第一个点开始');
 else if (index === base.length - 1) notes.push('已删除路径终点，路线将在新的最后一个点结束');
 else notes.push('该点位于直线段中间，删除后路线形状不变');
 return {ready: true, points: out, issues: [], notes, index, removed, changed: true};
}

export interface MoveAnchorResult extends RouteEditBase {
 index: number;
 delta: Point;
 /** Position of the moved anchor in `points`. */
 movedIndex: number;
 /** Positions of corners that had to be added around the moved anchor. */
 cornerIndexes: number[];
 changed: boolean;
}

/**
 * Move one anchor by `delta`, keeping every adjacent leg horizontal or vertical
 * by inserting a corner where the new position would otherwise produce a
 * diagonal. Neighbouring anchors never move.
 */
export function moveAnchorKeepingOrthogonal(points: Point[], index: number, delta: Point): MoveAnchorResult {
 const base = readPoints(points);
 const reject = (code: string, message: string): MoveAnchorResult =>
  ({ready: false, points: base ?? [], issues: [{code, message, index}], notes: [], index, delta: {...(delta ?? {x: 0, y: 0})}, movedIndex: -1, cornerIndexes: [], changed: false});
 if (!base) return reject('bad-points', '路径点必须是有限数值坐标');
 if (!Number.isInteger(index) || index < 0 || index >= base.length) return reject('bad-index', '移动位置必须在 0 到路径点数减一之间');
 if (!isFinitePoint(delta)) return reject('bad-delta', '位移必须是有限数值');
 const origin = base[index]!;
 const moved = {x: micro(origin.x + delta.x), y: micro(origin.y + delta.y)};
 if (moved.x === origin.x && moved.y === origin.y) {
  return {ready: true, points: base, issues: [], notes: ['位移为 0，路径未变化'], index, delta: {...delta}, movedIndex: index, cornerIndexes: [], changed: false};
 }
 if (base.some((point, position) => position !== index && distance(point, moved) <= AXIS_EPS)) {
  return reject('duplicate-point', '移动后与已有路径点重合');
 }

 const out: Point[] = [], cornerIndexes: number[] = [];
 for (let i = 0; i < base.length; i++) {
  const corner = appendOrthogonal(out, i === index ? moved : base[i]!);
  if (corner !== null) cornerIndexes.push(corner);
 }
 const movedIndex = out.findIndex(candidate => candidate.x === moved.x && candidate.y === moved.y);
 const notes: string[] = [];
 if (cornerIndexes.length) notes.push(`为保持水平/垂直布线，在移动点两侧自动插入 ${cornerIndexes.length} 个拐点`);
 notes.push('只移动路径锚点，地图二维码坐标不变');
 return {ready: true, points: out, issues: [], notes, index, delta: {...delta}, movedIndex, cornerIndexes, changed: true};
}

// --- equal spacing ----------------------------------------------------------

export interface EqualizeLegsOptions {minLegM?: number; maxLegM?: number}

export interface EqualizeLegsResult extends RouteEditBase {
 fromIndex: number;
 toIndex: number;
 axis: RouteAxis | null;
 direction: 1 | -1 | 0;
 targetM: number;
 spanBeforeM: number;
 spanAfterM: number;
 gapsBeforeM: number[];
 gapsAfterM: number[];
 /** Signed distance the tail after `toIndex` was translated along the axis. */
 tailDeltaM: number;
 movedIndexes: number[];
}

/**
 * Re-space a straight run `[fromIndex..toIndex]` on an exact pitch.
 *
 * The first point of the run is the fixed anchor; the intermediate anchors are
 * re-laid at `start + k * targetM`, the last point of the run lands on the
 * matching multiple and everything after it is translated by the same signed
 * delta along the run axis. Sliding the tail (instead of re-shaping it) is what
 * keeps every following leg orthogonal and unchanged in length.
 *
 * A run containing a corner or a fold is refused with an explanation, because
 * equal spacing only has a meaning on one straight line.
 */
export function equalizeLegs(points: Point[], fromIndex: number, toIndex: number, targetM: number, options: EqualizeLegsOptions = {}): EqualizeLegsResult {
 const base = readPoints(points);
 const minLegM = options.minLegM ?? MIN_LEG_M, maxLegM = options.maxLegM ?? MAX_TOTAL_M;
 const empty: EqualizeLegsResult = {
  ready: false, points: base ?? [], issues: [], notes: [], fromIndex, toIndex, axis: null, direction: 0,
  targetM, spanBeforeM: 0, spanAfterM: 0, gapsBeforeM: [], gapsAfterM: [], tailDeltaM: 0, movedIndexes: [],
 };
 const reject = (code: string, message: string): EqualizeLegsResult => ({...empty, issues: [{code, message, index: fromIndex}]});
 if (!base) return reject('bad-points', '路径点必须是有限数值坐标');
 if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= base.length) return reject('bad-index', '等间距起点超出路径范围');
 if (!Number.isInteger(toIndex) || toIndex <= fromIndex || toIndex >= base.length) return reject('bad-index', '等间距终点必须在起点之后且位于路径内');
 if (!Number.isFinite(targetM)) return reject('bad-target', '间距必须是有效数值');
 if (targetM < minLegM) return reject('too-small', `相邻路径点间距不得小于 ${(minLegM * 100).toFixed(0)} 厘米`);
 if (targetM > maxLegM) return reject('too-large', '单段间距不得超过 50 米');

 let axis: RouteAxis | null = null;
 let direction: 1 | -1 = 1;
 for (let i = fromIndex; i < toIndex; i++) {
  const a = base[i]!, b = base[i + 1]!, kind = axisOf(a, b);
  if (kind === 'zero') return reject('zero-leg', `第 ${i + 1} 段长度为 0，无法等间距`);
  if (kind === 'diagonal') return reject('not-a-straight-run', `第 ${i + 1} 段不是水平或垂直直线，等间距只适用于正交直线段`);
  if (axis && axis !== kind) return reject('corner-in-run', '所选范围包含拐角，等间距只适用于一条直线段；请在拐角处拆开处理');
  axis = kind;
  const sign = Math.sign(kind === 'horizontal' ? b.x - a.x : b.y - a.y) || 1;
  if (i > fromIndex && sign !== direction) return reject('fold-in-run', '所选范围包含折返，等间距只适用于同向直线');
  direction = sign as 1 | -1;
 }
 if (!axis) return reject('empty-run', '请选择至少一段路径');

 const n = toIndex - fromIndex;
 const along = (point: Point) => axis === 'horizontal' ? point.x : point.y;
 const start = base[fromIndex]!, spanBeforeM = Math.abs(along(base[toIndex]!) - along(start));
 const out = base.map(point => ({...point}));
 for (let k = 1; k <= n; k++) {
  const value = micro(along(start) + direction * targetM * k);
  out[fromIndex + k] = axis === 'horizontal' ? {x: value, y: start.y} : {x: start.x, y: value};
 }
 const tailDeltaM = micro(along(out[toIndex]!) - along(base[toIndex]!));
 if (Math.abs(tailDeltaM) > 1e-12) {
  for (let k = toIndex + 1; k < out.length; k++) {
   const point = out[k]!;
   out[k] = axis === 'horizontal' ? {x: micro(point.x + tailDeltaM), y: point.y} : {x: point.x, y: micro(point.y + tailDeltaM)};
  }
 }
 const movedIndexes = out.map((point, position) => position).filter(position => distance(out[position]!, base[position]!) > 1e-12);
 const gapsAfterM = out.slice(fromIndex + 1, toIndex + 1).map((point, position) => micro(distance(out[fromIndex + position]!, point)));
 const notes: string[] = [`${n} 段按 ${(targetM * 100).toFixed(1)} cm 等间距重排，起点保持不动`];
 if (Math.abs(tailDeltaM) > 1e-12) notes.push(`第 ${toIndex + 1} 点之后沿${axis === 'horizontal' ? '水平' : '垂直'}方向整体平移 ${(Math.abs(tailDeltaM) * 100).toFixed(1)} cm，其后路段长度不变`);
 notes.push('只调整路径锚点，地图二维码坐标不变');
 return {
  ready: true, points: out, issues: [], notes, fromIndex, toIndex, axis, direction, targetM,
  spanBeforeM: micro(spanBeforeM), spanAfterM: micro(Math.abs(along(out[toIndex]!) - along(out[fromIndex]!))),
  gapsBeforeM: base.slice(fromIndex + 1, toIndex + 1).map((point, position) => micro(distance(base[fromIndex + position]!, point))),
  gapsAfterM, tailDeltaM, movedIndexes,
 };
}

// --- whole-route transforms -------------------------------------------------

export interface RouteTransformResult extends RouteEditBase {
 transform: 'translate' | 'rotate' | 'mirror';
 translation?: Point;
 degrees?: number;
 pivot?: Point;
 axis?: RouteAxis;
 at?: number;
}

const transformReject = (points: Point[], transform: RouteTransformResult['transform'], code: string, message: string): RouteTransformResult =>
 ({ready: false, points: clone(Array.isArray(points) ? points : []), issues: [{code, message}], notes: [], transform});

/** Translate the whole route. Orthogonality is preserved by construction. */
export function translateRoute(points: Point[], dx: number, dy: number): RouteTransformResult {
 const base = readPoints(points);
 if (!base) return transformReject(points, 'translate', 'bad-points', '路径点必须是有限数值坐标');
 if (!Number.isFinite(dx) || !Number.isFinite(dy)) return {...transformReject(base, 'translate', 'bad-delta', '平移量必须是有限数值'), points: base};
 const out = base.map(point => ({x: micro(point.x + dx), y: micro(point.y + dy)}));
 return {
  ready: true, points: out, issues: [], transform: 'translate', translation: {x: micro(dx), y: micro(dy)},
  notes: [`整条路径平移 (${micro(dx)}, ${micro(dy)}) m，形状与段长不变`, '地图二维码坐标不变；平移后端点需仍落在定位码 10 cm 捕捉范围内'],
 };
}

/**
 * Rotate the whole route about `pivot`. Only multiples of 90° are accepted:
 * any other angle turns every horizontal/vertical leg into a diagonal, which the
 * executor cannot drive. Positive angles are counter-clockwise in map axes.
 */
export function rotateRoute(points: Point[], pivot: Point, deg: number): RouteTransformResult {
 const base = readPoints(points);
 if (!base) return transformReject(points, 'rotate', 'bad-points', '路径点必须是有限数值坐标');
 if (!isFinitePoint(pivot)) return {...transformReject(base, 'rotate', 'bad-pivot', '旋转中心必须是有限数值'), points: base};
 if (!Number.isFinite(deg)) return {...transformReject(base, 'rotate', 'bad-angle', '旋转角度必须是有限数值'), points: base};
 const quarters = deg / 90;
 if (Math.abs(quarters - Math.round(quarters)) > 1e-9) {
  return {...transformReject(base, 'rotate', 'not-right-angle', '旋转只允许 90° 的整数倍（90/180/270），其他角度会让路径失去正交性'), points: base};
 }
 const turns = ((Math.round(quarters) % 4) + 4) % 4;
 const out = base.map(point => {
  let x = point.x, y = point.y;
  for (let turn = 0; turn < turns; turn++) {
   const nx = pivot.x - (y - pivot.y), ny = pivot.y + (x - pivot.x);
   x = nx; y = ny;
  }
  return {x: micro(x), y: micro(y)};
 });
 return {
  ready: true, points: out, issues: [], transform: 'rotate', degrees: deg, pivot: {x: micro(pivot.x), y: micro(pivot.y)},
  notes: [`整条路径绕 (${micro(pivot.x)}, ${micro(pivot.y)}) 旋转 ${deg}°${turns === 0 ? '（整周，路径不变）' : ''}`, '地图二维码坐标不变'],
 };
}

/**
 * Mirror the whole route across an axis line: `axis: 'horizontal'` mirrors on
 * `y = at`, `axis: 'vertical'` mirrors on `x = at`. Reflection preserves
 * orthogonality and every leg length.
 */
export function mirrorRoute(points: Point[], axis: RouteAxis, at = 0): RouteTransformResult {
 const base = readPoints(points);
 if (!base) return transformReject(points, 'mirror', 'bad-points', '路径点必须是有限数值坐标');
 if (axis !== 'horizontal' && axis !== 'vertical') return {...transformReject(base, 'mirror', 'bad-axis', '镜像轴必须是 horizontal（水平线）或 vertical（垂直线）'), points: base};
 if (!Number.isFinite(at)) return {...transformReject(base, 'mirror', 'bad-axis', '镜像轴位置必须是有限数值'), points: base};
 const out = base.map(point => axis === 'horizontal'
  ? {x: point.x, y: micro(2 * at - point.y)}
  : {x: micro(2 * at - point.x), y: point.y});
 return {
  ready: true, points: out, issues: [], transform: 'mirror', axis, at: micro(at),
  notes: [`整条路径按 ${axis === 'horizontal' ? '水平线 y=' + micro(at) : '垂直线 x=' + micro(at)} 镜像，段长不变`, '地图二维码坐标不变'],
 };
}

// --- geometry validation ----------------------------------------------------

export interface RouteGeometryOptions {
 minLegM?: number;
 maxTotalM?: number;
 maxPoints?: number;
 /** Self-intersection is legal for a return trip, so it is a warning by default. */
 selfIntersection?: 'error' | 'warning' | 'ignore';
}

export interface RouteGeometryLeg {index: number; from: Point; to: Point; lengthM: number; axis: LegAxis}

export interface RouteGeometryReport {
 ok: boolean;
 errors: GeometryIssue[];
 warnings: GeometryIssue[];
 legs: RouteGeometryLeg[];
 lengthM: number;
 shortestLegM: number | null;
 longestLegM: number;
 axisAligned: boolean;
 corners: number;
 bounds: {minX: number; minY: number; maxX: number; maxY: number};
 selfIntersections: {a: number; b: number; point: Point}[];
 options: {minLegM: number; maxTotalM: number; maxPoints: number};
}

/** Strict interior crossing of two segments; a shared endpoint is not a crossing. */
function crossing(a: Point, b: Point, c: Point, d: Point): Point | null {
 const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
 const denominator = rx * sy - ry * sx;
 if (Math.abs(denominator) <= AXIS_EPS) {
  // Parallel: report only a real collinear overlap, not a touch at one point.
  const scale = Math.max(1, Math.hypot(rx, ry));
  if (Math.abs((c.x - a.x) * ry - (c.y - a.y) * rx) > AXIS_EPS * scale) return null;
  const lengthSquared = rx * rx + ry * ry;
  if (lengthSquared <= AXIS_EPS) return null;
  const t0 = ((c.x - a.x) * rx + (c.y - a.y) * ry) / lengthSquared;
  const t1 = ((d.x - a.x) * rx + (d.y - a.y) * ry) / lengthSquared;
  const low = Math.max(0, Math.min(t0, t1)), high = Math.min(1, Math.max(t0, t1));
  if (high - low <= 1e-9) return null;
  const middle = (low + high) / 2;
  if (middle <= 1e-9 || middle >= 1 - 1e-9) return null;
  return {x: a.x + rx * middle, y: a.y + ry * middle};
 }
 const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denominator;
 const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denominator;
 if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
 return {x: a.x + rx * t, y: a.y + ry * t};
}

/**
 * The editor's own report card: orthogonality, minimum leg, total length, point
 * count and self-intersection. The compiler stays the final authority; this is
 * the early, explanatory check the UI shows while dragging.
 */
export function validateRouteGeometry(points: Point[], options: RouteGeometryOptions = {}): RouteGeometryReport {
 const minLegM = options.minLegM ?? MIN_LEG_M, maxTotalM = options.maxTotalM ?? MAX_TOTAL_M, maxPoints = options.maxPoints ?? MAX_POINTS;
 const selfMode = options.selfIntersection ?? 'warning';
 const errors: GeometryIssue[] = [], warnings: GeometryIssue[] = [];
 const base = readPoints(points);
 const report = (legs: RouteGeometryLeg[], extra: Partial<RouteGeometryReport> = {}): RouteGeometryReport => {
  const lengthM = micro(legs.reduce((sum, leg) => sum + leg.lengthM, 0));
  const lengths = legs.map(leg => leg.lengthM);
  const coords = base ?? [];
  return {
   ok: errors.length === 0, errors, warnings, legs, lengthM,
   shortestLegM: lengths.length ? Math.min(...lengths) : null,
   longestLegM: lengths.length ? Math.max(...lengths) : 0,
   axisAligned: legs.every(leg => leg.axis === 'horizontal' || leg.axis === 'vertical'),
   corners: base ? Math.max(0, routeCorners(base).length - 2) : 0,
   bounds: coords.length
    ? {minX: Math.min(...coords.map(point => point.x)), minY: Math.min(...coords.map(point => point.y)), maxX: Math.max(...coords.map(point => point.x)), maxY: Math.max(...coords.map(point => point.y))}
    : {minX: 0, minY: 0, maxX: 0, maxY: 0},
   selfIntersections: [], options: {minLegM, maxTotalM, maxPoints}, ...extra,
  };
 };
 if (!base) {
  errors.push({code: 'bad-points', message: '路径点必须是有限数值坐标'});
  return report([]);
 }
 if (base.length < 2) {errors.push({code: 'too-few-points', message: '路径至少需要两个控制点'}); return report([]);}
 if (base.length > maxPoints) errors.push({code: 'too-many-points', message: `路径控制点不能超过 ${maxPoints} 个`});

 const legs: RouteGeometryLeg[] = [];
 for (let i = 1; i < base.length; i++) {
  const from = base[i - 1]!, to = base[i]!, axis = axisOf(from, to), lengthM = micro(distance(from, to));
  legs.push({index: i - 1, from, to, lengthM, axis});
  if (axis === 'zero') {errors.push({code: 'zero-leg', message: `第 ${i} 段长度为 0，请删除重复点`, legIndex: i - 1}); continue;}
  if (axis === 'diagonal') {errors.push({code: 'not-orthogonal', message: `第 ${i} 段不是水平或垂直直线`, legIndex: i - 1}); continue;}
  if (lengthM < minLegM) errors.push({code: 'leg-too-short', message: `第 ${i} 段只有 ${(lengthM * 100).toFixed(1)} cm，不得小于 ${(minLegM * 100).toFixed(0)} cm`, legIndex: i - 1});
 }
 const lengthM = legs.reduce((sum, leg) => sum + leg.lengthM, 0);
 if (lengthM > maxTotalM) errors.push({code: 'too-long', message: `路径总长 ${lengthM.toFixed(2)} m，超过 ${maxTotalM} m 上限，请拆分任务`});

 const selfIntersections: RouteGeometryReport['selfIntersections'] = [];
 if (selfMode !== 'ignore') {
  for (let i = 0; i < legs.length; i++) {
   for (let j = i + 2; j < legs.length; j++) {
    const point = crossing(legs[i]!.from, legs[i]!.to, legs[j]!.from, legs[j]!.to);
    if (!point) continue;
    selfIntersections.push({a: i, b: j, point: {x: micro(point.x), y: micro(point.y)}});
    const issue: GeometryIssue = {code: 'self-intersection', message: `第 ${i + 1} 段与第 ${j + 1} 段交叉（折返路线允许，但请确认不与作物行冲突）`, legIndex: i};
    if (selfMode === 'error') errors.push(issue); else warnings.push(issue);
   }
  }
 }
 return report(legs, {selfIntersections});
}

// --- route / QR binding diagnostics ----------------------------------------

export interface RouteTagPoint {id: number; x: number; y: number}
export interface RouteBindingOptions {toleranceM?: number}

export type EndpointStatus = 'exact' | 'snapped' | 'unbound';

export interface RouteEndpointBinding {
 pointIndex: number;
 point: Point;
 tagId: number | null;
 distanceM: number;
 status: EndpointStatus;
 /** Index of the leg this endpoint starts; the last point maps to the last leg. */
 legIndex: number;
 end: 'from' | 'to';
}

export interface RouteLegBinding {
 index: number;
 from: Point;
 to: Point;
 lengthM: number;
 fromStatus: EndpointStatus;
 toStatus: EndpointStatus;
 /** `tag-to-tag` means both ends sit on a map QR (exact or within tolerance). */
 kind: 'tag-to-tag' | 'tag-to-free' | 'free-to-tag' | 'free-to-free';
 /** Both ends are exactly on a QR centre, so the compiler can cut an interval here. */
 exact: boolean;
}

export interface RouteBindingReport {
 ok: boolean;
 pointCount: number;
 tagCount: number;
 toleranceM: number;
 exactToleranceM: number;
 endpoints: RouteEndpointBinding[];
 legs: RouteLegBinding[];
 /** Leg indexes whose both ends are exactly on a QR centre. */
 exactTagToTagLegs: number[];
 /** Leg indexes whose both ends are bound but at least one end needed snapping. */
 snappedTagToTagLegs: number[];
 unboundEndpoints: RouteEndpointBinding[];
 snappedEndpoints: RouteEndpointBinding[];
 /** QRs the path runs over without ending an interval; they still correct the run. */
 passedTags: {id: number; x: number; y: number; distanceM: number}[];
 /** QRs that are nowhere near this path. */
 unusedTagIds: number[];
 warnings: string[];
}

const EXACT_M = 1e-6;

function nearestTag(point: Point, tags: RouteTagPoint[]): {tag: RouteTagPoint | null; distanceM: number} {
 let best: RouteTagPoint | null = null, bestDistance = Infinity;
 for (const tag of tags) {
  const gap = distance(point, tag);
  if (gap < bestDistance - AXIS_EPS || (Math.abs(gap - bestDistance) <= AXIS_EPS && best && tag.id < best.id)) {best = tag; bestDistance = gap;}
 }
 return {tag: best, distanceM: best ? bestDistance : Infinity};
}

function distanceToPolyline(point: Point, points: Point[]): number {
 if (points.length < 2) return points[0] ? distance(point, points[0]) : Infinity;
 let best = Infinity;
 for (let i = 1; i < points.length; i++) {
  const a = points[i - 1]!, b = points[i]!, dx = b.x - a.x, dy = b.y - a.y, denominator = dx * dx + dy * dy;
  const t = denominator ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator)) : 0;
  best = Math.min(best, distance(point, {x: a.x + dx * t, y: a.y + dy * t}));
 }
 return best;
}

/**
 * Explain how a drawn point list binds to the surveyed QR set: which legs are
 * code-to-code, which endpoints are not on a map point, which endpoints merely
 * snapped to the nearest code (the compiler capture radius) and which codes the
 * path runs over without stopping. Pure read-only diagnostics for the UI.
 */
export function diagnoseRouteBindings(points: Point[], tags: RouteTagPoint[], options: RouteBindingOptions = {}): RouteBindingReport {
 const toleranceM = options.toleranceM ?? ROUTE_GROUP_CAPTURE;
 const base = readPoints(points) ?? [];
 const clean = (Array.isArray(tags) ? tags : []).filter(tag => tag && Number.isFinite(tag.id) && Number.isFinite(tag.x) && Number.isFinite(tag.y));
 const warnings: string[] = [];
 const report: RouteBindingReport = {
  ok: true, pointCount: base.length, tagCount: clean.length, toleranceM, exactToleranceM: EXACT_M,
  endpoints: [], legs: [], exactTagToTagLegs: [], snappedTagToTagLegs: [], unboundEndpoints: [], snappedEndpoints: [],
  passedTags: [], unusedTagIds: [], warnings,
 };
 if (!base.length) {warnings.push('路径没有控制点'); report.ok = false; return report;}
 if (base.length < 2) warnings.push('路径只有一个控制点，无法形成码到码路段');
 if (!clean.length) {warnings.push('地图上没有定位码，路径无法与二维码绑定'); report.ok = false; return report;}
 if (!Number.isFinite(toleranceM) || toleranceM <= 0) {warnings.push('捕捉半径无效，已按 0.10 m 计算');}

 const endpoints: RouteEndpointBinding[] = base.map((point, pointIndex) => {
  const {tag, distanceM} = nearestTag(point, clean);
  const status: EndpointStatus = distanceM <= EXACT_M ? 'exact' : distanceM <= toleranceM ? 'snapped' : 'unbound';
  return {
   // 只有真正在捕捉半径内的端点才算"绑到某个码"；unbound 端点不得占用 tagId，
   // 否则该码会被误判成已使用、从 unusedTagIds 里消失。
   pointIndex, point, tagId: status === 'unbound' ? null : tag?.id ?? null, distanceM: micro(distanceM), status,
   legIndex: Math.min(pointIndex, Math.max(0, base.length - 2)),
   end: pointIndex < base.length - 1 ? 'from' : 'to',
  };
 });
 const legs: RouteLegBinding[] = [];
 for (let i = 1; i < base.length; i++) {
  const from = endpoints[i - 1]!, to = endpoints[i]!;
  const fromBound = from.status !== 'unbound', toBound = to.status !== 'unbound';
  const kind = fromBound && toBound ? 'tag-to-tag' : fromBound ? 'tag-to-free' : toBound ? 'free-to-tag' : 'free-to-free';
  const leg: RouteLegBinding = {
   index: i - 1, from: from.point, to: to.point, lengthM: micro(distance(from.point, to.point)),
   fromStatus: from.status, toStatus: to.status, kind, exact: from.status === 'exact' && to.status === 'exact',
  };
  legs.push(leg);
  if (leg.kind === 'tag-to-tag') (leg.exact ? report.exactTagToTagLegs : report.snappedTagToTagLegs).push(leg.index);
 }
 const usedTagIds = new Set(endpoints.map(endpoint => endpoint.tagId).filter((id): id is number => id !== null));
 const passedTags: RouteBindingReport['passedTags'] = [];
 const unusedTagIds: number[] = [];
 for (const tag of clean) {
  if (usedTagIds.has(tag.id)) continue;
  const gap = distanceToPolyline(tag, base);
  if (gap <= toleranceM) passedTags.push({id: tag.id, x: tag.x, y: tag.y, distanceM: micro(gap)});
  else unusedTagIds.push(tag.id);
 }
 report.endpoints = endpoints;
 report.legs = legs;
 report.unboundEndpoints = endpoints.filter(endpoint => endpoint.status === 'unbound');
 report.snappedEndpoints = endpoints.filter(endpoint => endpoint.status === 'snapped');
 report.passedTags = passedTags.sort((a, b) => a.distanceM - b.distanceM || a.id - b.id);
 report.unusedTagIds = unusedTagIds.sort((a, b) => a - b);
 const unboundCount = report.unboundEndpoints.length, snappedCount = report.snappedEndpoints.length;
 if (unboundCount) warnings.push(`${unboundCount} 个路径端点不在任何定位码 ${(toleranceM * 100).toFixed(0)} cm 范围内，编译时会被截去或导致串码失败`);
 if (snappedCount) warnings.push(`${snappedCount} 个路径端点吸附到最近的定位码（未精确落在码中心）`);
 if (passedTags.length) warnings.push(`${passedTags.length} 个定位码位于路径中途，会作为沿途校正点`);
 if (!legs.some(leg => leg.kind === 'tag-to-tag')) warnings.push('没有任何一段是码到码，路径将无法编译成执行区间');
 report.ok = unboundCount === 0;
 return report;
}
