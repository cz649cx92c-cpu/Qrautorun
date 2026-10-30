import {distance,type Point} from './model';

/** Hard floor for one leg of a route: below this the two QR targets would overlap. */
export const MIN_LEG_DISTANCE_M = 0.08;
export const MAX_LEG_DISTANCE_M = 50;

export type LegAxis = 'horizontal' | 'vertical' | 'diagonal';

export interface LegDistanceIssue {code: string; message: string}

export interface LegDistancePreview {
  ready: boolean;
  anchors: Point[];
  index: number;
  axis: LegAxis;
  beforeM: number;
  afterM: number;
  distance: {m: number; cm: number; mm: number};
  deltaM: number;
  mode: 'move-endpoint' | 'shift-tail';
  /** Anchors whose coordinates changed, by step index. */
  movedIndexes: number[];
  maxDisplacementM: number;
  /**
   * `shift-tail` translates every later anchor by the same delta, so the shape of
   * the remaining path is untouched. `move-endpoint` only moves this one anchor
   * because the following leg is already parallel to the edited axis.
   */
  reason: string;
  notes: string[];
  issues: LegDistanceIssue[];
}

const micro = (value: number) => Math.round(value * 1e6) / 1e6;

function axisOf(a: Point, b: Point): LegAxis {
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  if (dx <= 1e-9 && dy <= 1e-9) return 'diagonal';
  if (dy <= 1e-9) return 'horizontal';
  if (dx <= 1e-9) return 'vertical';
  return 'diagonal';
}

const cloneAnchors = (anchors: Point[]) => anchors.map(point => ({x: point.x, y: point.y}));

/**
 * Change the centre-to-centre distance of one route leg by moving route anchors.
 *
 * This never touches the map: a route anchor is a path point, so the operator is
 * editing the path, not the surveyed QR coordinate. The edited leg keeps its
 * direction (we slide along the existing axis), which is what keeps the route
 * orthogonal without silently bending it.
 *
 * Stable rule, chosen so a saved route stays valid:
 * - if the edited leg is the last leg, or the next leg runs parallel to it, only
 *   the far endpoint of the leg moves (`move-endpoint`);
 * - otherwise the far endpoint and every later anchor translate by the same
 *   delta (`shift-tail`), so all following legs keep their exact length and the
 *   whole remaining path is merely shifted, never re-shaped.
 */
export function previewLegDistance(anchors: Point[], index: number, targetM: number): LegDistancePreview {
  const base = cloneAnchors(anchors);
  const issues: LegDistanceIssue[] = [];
  const notes: string[] = [];
  const fail = (code: string, message: string): LegDistancePreview => {
    issues.push({code, message});
    return {
      ready: false, anchors: base, index, axis: 'diagonal',
      beforeM: 0, afterM: 0, distance: {m: 0, cm: 0, mm: 0}, deltaM: 0,
      mode: 'move-endpoint', movedIndexes: [], maxDisplacementM: 0, reason: '', notes, issues,
    };
  };

  if (!Number.isInteger(index) || index < 1 || index >= base.length) return fail('bad-index', '只有第二个步骤之后的路段才有距离');
  const previous = base[index - 1]!, current = base[index]!;
  const beforeM = distance(previous, current);
  const axis = axisOf(previous, current);
  if (axis === 'diagonal') return fail('not-orthogonal', '该路段不是水平或垂直直线，请先把路径拆成正交段再改距离');
  if (!Number.isFinite(targetM)) return fail('bad-target', '请输入有效的目标距离');
  if (targetM < MIN_LEG_DISTANCE_M) return fail('too-small', `相邻二维码间距不得小于 ${(MIN_LEG_DISTANCE_M * 100).toFixed(0)} 厘米`);
  if (targetM > MAX_LEG_DISTANCE_M) return fail('too-large', '单段距离不得超过 50 米');

  const sign = axis === 'horizontal' ? Math.sign(current.x - previous.x) : Math.sign(current.y - previous.y);
  if (sign === 0) return fail('zero-length', '该路段长度为 0，请先调整路径点');
  const deltaM = micro(targetM - beforeM);

  const next = base[index + 1];
  const nextAxis = next ? axisOf(current, next) : null;
  const parallelNext = nextAxis === null || nextAxis === axis;
  const mode: 'move-endpoint' | 'shift-tail' = parallelNext ? 'move-endpoint' : 'shift-tail';

  const shift = (point: Point) => axis === 'horizontal'
    ? {x: micro(point.x + sign * deltaM), y: point.y}
    : {x: point.x, y: micro(point.y + sign * deltaM)};

  const movedIndexes: number[] = [];
  const result = cloneAnchors(base);
  for (let i = index; i < result.length; i++) {
    result[i] = shift(result[i]!);
    movedIndexes.push(i);
    if (mode === 'move-endpoint') break;
  }
  // Removing the moved points from an untouched tail is deliberate: in
  // move-endpoint mode nothing after the endpoint changes at all.
  if (mode === 'move-endpoint') result.length = base.length;

  const maxDisplacementM = movedIndexes.reduce((max, i) => Math.max(max, distance(base[i]!, result[i]!)), 0);
  const afterM = distance(result[index - 1]!, result[index]!);

  if (mode === 'shift-tail' && movedIndexes.length > 1) {
    notes.push(`后续 ${movedIndexes.length - 1} 个路径点整体平移 ${(Math.abs(deltaM) * 100).toFixed(1)} cm，其后路段长度不变`);
  }
  if (Math.abs(deltaM) > 0.05) {
    notes.push(`本段变化 ${(Math.abs(deltaM) * 100).toFixed(1)} cm，请确认路径不压到作物行`);
  }
  notes.push('只调整路径锚点，地图二维码坐标不变');

  return {
    ready: Math.abs(afterM - targetM) < 1e-6,
    anchors: result,
    index,
    axis,
    beforeM,
    afterM,
    distance: {m: micro(targetM), cm: micro(targetM * 100), mm: micro(targetM * 1000)},
    deltaM,
    mode,
    movedIndexes,
    maxDisplacementM,
    reason: mode === 'move-endpoint' ? '只移动本段终点，后一段保持正交' : '本段终点及后续点整体平移，保持正交与后续段长',
    notes,
    issues,
  };
}
