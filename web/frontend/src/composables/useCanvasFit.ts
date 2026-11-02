/**
 * 画布「适应视图」(fit) 的纯逻辑 + 标签避让。
 *
 * 为什么不直接用全部几何算包围盒：
 * 手动地图的 `zone`（作业区外框）可以比真实定位码大一个数量级，而旧 fit() 把 zone
 * 一起塞进包围盒，结果线上出现 14% 缩放——二维码挤成一小团、编号糊成一片，
 * 画布大半区域是空的。所以默认模式只用**真实点位**（tag 中心 + 当前路径锚点），
 * zone 只在「查看整张地图」(whole-map) 时参与。
 *
 * 本模块不依赖 Konva / DOM，纯函数，可被 node:test 直接覆盖。
 */

export type FitMode = 'tags-and-route' | 'whole-map';

export interface FitPoint {
  x: number;
  y: number;
}

export interface FitBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FitResult {
  /** 目标包围盒（米，与地图坐标同单位）。 */
  bounds: FitBounds;
  /** 包围盒退化（宽度或高度≈0，例如只剩一个点/一条直线）。 */
  degenerate: boolean;
  /** 真正参与计算的点数。 */
  usedPoints: number;
  /** 被判为离群并剔除的点数。 */
  excludedOutliers: number;
  /** 实际使用的相对边距比例。 */
  paddingRatio: number;
  mode: FitMode;
}

export interface FitInput {
  tags: readonly FitPoint[];
  anchors?: readonly FitPoint[];
  zone?: readonly FitPoint[];
  mode?: FitMode;
  /** 相对边距比例，默认 0.10（10%），会被夹到 [0.08, 0.12]。 */
  paddingRatio?: number;
}

/** 默认相对边距（8%–12% 区间内的中值）。 */
export const DEFAULT_PADDING_RATIO = 0.1;
export const MIN_PADDING_RATIO = 0.08;
export const MAX_PADDING_RATIO = 0.12;

/** 离群判定：与中位中心距离超过 max(中位距离 × 该倍数, 该绝对下限) 视为离群。 */
export const OUTLIER_MEDIAN_FACTOR = 4;
export const OUTLIER_ABS_FLOOR_M = 0.5;
/** 剔除比例上限：超过这个比例就放弃剔除，避免把正常分布的地图裁掉一半。 */
export const OUTLIER_MAX_FRACTION = 0.2;

/** 缩放夹取区间，与 scaleBy() 的历史行为保持一致。 */
export const MIN_SCALE = 0.08;
export const MAX_SCALE = 8;

const isFinitePoint = (p: FitPoint | null | undefined): p is FitPoint =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clampPadding(value: number | undefined): number {
  if (!Number.isFinite(value as number)) return DEFAULT_PADDING_RATIO;
  return Math.min(MAX_PADDING_RATIO, Math.max(MIN_PADDING_RATIO, value as number));
}

/**
 * 稳健剔除离群点：以「中位中心」为原点算距离，超过 max(中位距离×4, 0.5m) 的视为离群。
 * 关键约束：**最多剔除 OUTLIER_MAX_FRACTION 比例**；一旦超过就整体放弃剔除，
 * 否则一个正常的稀疏地图会被自己的规则裁成一小块。
 */
export function dropOutliers(points: readonly FitPoint[]): { kept: FitPoint[]; excluded: number } {
  const finite = points.filter(isFinitePoint);
  if (finite.length < 4) return { kept: finite, excluded: points.length - finite.length };

  const cx = median(finite.map(p => p.x));
  const cy = median(finite.map(p => p.y));
  const distances = finite.map(p => Math.hypot(p.x - cx, p.y - cy));
  const medianDistance = median(distances);
  const threshold = Math.max(medianDistance * OUTLIER_MEDIAN_FACTOR, OUTLIER_ABS_FLOOR_M);

  const kept = finite.filter((_, index) => distances[index]! <= threshold);
  const excluded = finite.length - kept.length;
  const limit = Math.floor(finite.length * OUTLIER_MAX_FRACTION);
  if (excluded > limit || kept.length < 2) {
    // 剔除过多或会把点清空：放弃剔除，宁可包围盒略大也不能丢正常点位。
    return { kept: finite, excluded: points.length - finite.length };
  }
  return { kept, excluded };
}

/**
 * 计算 fit 的目标包围盒。
 * - `tags-and-route`（默认）：用**全部**有限 tag 坐标 + 路径锚点，**排除 zone**，**不做离群剔除**。
 *   理由：离群剔除会把合法的远端码排除在包围盒外，该码随即落到可视区之外，等同于隐藏用户码。
 *   默认视图宁可整体缩小，也要让每一个真实 tag 都留在视野内。
 * - `whole-map`：把 zone 也算进来（「查看整张地图」按钮用），不做离群剔除。
 * - 有效点少于 2 个时返回 `null`，调用方应保持当前视角而不是算出 0 尺寸。
 */
export function computeFitBounds(input: FitInput): FitResult | null {
  const mode: FitMode = input.mode ?? 'tags-and-route';
  const paddingRatio = clampPadding(input.paddingRatio);

  let candidates: FitPoint[];
  if (mode === 'whole-map') {
    candidates = [...input.tags, ...(input.anchors ?? []), ...(input.zone ?? [])].filter(isFinitePoint);
    if (candidates.length < 2) return null;
    const bounds = boundsOf(candidates, paddingRatio);
    return { bounds, degenerate: isDegenerate(bounds), usedPoints: candidates.length, excludedOutliers: 0, paddingRatio, mode };
  }

  // 默认 fit：全部有限 tag + 锚点都参与包围盒，不剔除任何合法码（见上方说明）。
  // zone 仍然只在 whole-map 纳入，避免人工图幅边界把真实码挤小。
  const visible = [...input.tags, ...(input.anchors ?? [])].filter(isFinitePoint);
  if (visible.length < 2) return null;
  const bounds = boundsOf(visible, paddingRatio);
  return { bounds, degenerate: isDegenerate(bounds), usedPoints: visible.length, excludedOutliers: 0, paddingRatio, mode };
}

function boundsOf(points: readonly FitPoint[], paddingRatio: number): FitBounds {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  // 退化方向（宽或高为 0）也要留出可视厚度，否则缩放会算成 Infinity。
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const padX = spanX * paddingRatio;
  const padY = spanY * paddingRatio;
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}

function isDegenerate(bounds: FitBounds): boolean {
  return bounds.maxX - bounds.minX < 1e-6 || bounds.maxY - bounds.minY < 1e-6;
}

export interface FitViewport {
  width: number;
  height: number;
}

export interface FitTransform {
  /** 缩放倍数（stage.scale）。 */
  scale: number;
  /** stage 位置（Konva px）。 */
  x: number;
  y: number;
}

/** 屏幕坐标固定边距（px）：给左上角说明与右下角控件留出空间。 */
export const FIT_SCREEN_PADDING_PX = 56;

/**
 * 把包围盒换算成 stage 的 scale/position。
 * 世界坐标 → 屏幕：screenX = worldX * 100 * scale + stageX，screenY = -worldY * 100 * scale + stageY。
 */
export function fitTransform(bounds: FitBounds, viewport: FitViewport, paddingPx: number = FIT_SCREEN_PADDING_PX): FitTransform {
  const availableWidth = Math.max(viewport.width - paddingPx * 2, 1);
  const availableHeight = Math.max(viewport.height - paddingPx * 2, 1);
  const worldWidthPx = Math.max((bounds.maxX - bounds.minX) * 100, 1e-6);
  const worldHeightPx = Math.max((bounds.maxY - bounds.minY) * 100, 1e-6);
  const rawScale = Math.min(availableWidth / worldWidthPx, availableHeight / worldHeightPx);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number.isFinite(rawScale) ? rawScale : MIN_SCALE));
  const centerWorldX = (bounds.minX + bounds.maxX) / 2;
  const centerWorldY = (bounds.minY + bounds.maxY) / 2;
  return {
    scale,
    x: viewport.width / 2 - centerWorldX * 100 * scale,
    y: viewport.height / 2 + centerWorldY * 100 * scale,
  };
}

// ---------------------------------------------------------------------------
// 标签避让
// ---------------------------------------------------------------------------

export interface LabelCandidate {
  id: number;
  /** 屏幕坐标（CSS px）——避让必须在屏幕空间做，否则缩放后结论就失效了。 */
  sx: number;
  sy: number;
  /** 越高越重要：选中/悬停的标签必须保住。 */
  priority: number;
  /** 该标签的屏幕宽高（px）。缺省用 options 里的统一值。
   *  不同类标签（B 编号 / 段动作 / 路点序号）实际占位差别很大，
   *  统一按最宽的算会白白挤掉 B 编号，所以允许逐条给出。 */
  w?: number;
  h?: number;
}

export interface PlacedLabel {
  id: number;
  /** 最终放置的屏幕坐标（标签左上角对应的锚点：标签以该点为中心水平、向下偏移）。 */
  sx: number;
  sy: number;
  forced: boolean;
}

export interface LabelPlan {
  placed: PlacedLabel[];
  /** 被判定为「当前缩放/密度下放不下」而隐藏的 id。 */
  hidden: number[];
  visibleCount: number;
}

export interface LabelPlanOptions {
  labelWidth?: number;
  labelHeight?: number;
  /** 纵向错开的候选偏移（屏幕 px），按顺序尝试。 */
  verticalOffsets?: number[];
  /** 两个标签之间的最小间隙（px）。 */
  gap?: number;
}

/**
 * 估算标签在屏幕上的真实宽度（CSS px）。
 * Konva.Text 在未显式给 width 时，宽度由文本 + 字号决定；
 * 中文按 1em、ASCII 数字/字母按 ~0.62em 估算，与常见无衬线/monospace 渲染接近。
 * 避让必须用**同一口径**的尺寸，否则「规划 52px、实际 68px」会漏判重叠。
 */
export function estimateLabelWidth(text: string, fontSizePx: number, fallback: number): number {
  if (!text) return fallback;
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK / 全角
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60)) em += 1;
    // 数字与大写字母在多数无衬线体里略宽
    else if (code >= 0x30 && code <= 0x39) em += 0.62;
    else if (code >= 0x41 && code <= 0x5a) em += 0.68;
    else if (ch === ' ') em += 0.3;
    else em += 0.55;
  }
  return Math.max(8, Math.ceil(em * fontSizePx) + 2);
}

export const DEFAULT_LABEL_WIDTH = 52;
export const DEFAULT_LABEL_HEIGHT = 13;
export const DEFAULT_LABEL_GAP = 2;
export const DEFAULT_VERTICAL_OFFSETS = [0, 15, -15, 30, -30, 45, -45, 60, -60];

/**
 * 屏幕空间标签避让。
 * 规则：
 * 1. 高优先级（选中/hover）先占位，并且**永远不会被隐藏**——最多放在碰撞最少的偏移上。
 * 2. 低优先级标签依次尝试纵向偏移，全被占用就隐藏（不是一刀切：只有真正压在一起才隐藏）。
 * 3. 隐藏的是「次要编号」，数量通过 data-canvas-visible-labels 暴露给测试。
 */
export function planLabels(candidates: readonly LabelCandidate[], options: LabelPlanOptions = {}): LabelPlan {
  const labelWidth = options.labelWidth ?? DEFAULT_LABEL_WIDTH;
  const labelHeight = options.labelHeight ?? DEFAULT_LABEL_HEIGHT;
  const gap = options.gap ?? DEFAULT_LABEL_GAP;
  const offsets = options.verticalOffsets ?? DEFAULT_VERTICAL_OFFSETS;

  const sorted = [...candidates].sort((a, b) => b.priority - a.priority || a.sy - b.sy || a.sx - b.sx);
  const occupied: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  const placed: PlacedLabel[] = [];
  const hidden: number[] = [];

  const boxAt = (sx: number, sy: number, offset: number, w = labelWidth, h = labelHeight) => ({
    left: sx - w / 2 - gap,
    right: sx + w / 2 + gap,
    top: sy + offset - gap,
    bottom: sy + offset + h + gap,
  });
  const collides = (box: { left: number; right: number; top: number; bottom: number }) =>
    occupied.some(o => !(box.right < o.left || box.left > o.right || box.bottom < o.top || box.top > o.bottom));

  for (const candidate of sorted) {
    let chosen: { offset: number; box: ReturnType<typeof boxAt>; hits: number } | null = null;
    for (const offset of offsets) {
      const box = boxAt(candidate.sx, candidate.sy, offset, candidate.w ?? labelWidth, candidate.h ?? labelHeight);
      if (!collides(box)) { chosen = { offset, box, hits: 0 }; break; }
      const hits = occupied.filter(o => !(box.right < o.left || box.left > o.right || box.bottom < o.top || box.top > o.bottom)).length;
      if (!chosen || hits < chosen.hits) chosen = { offset, box, hits };
    }
    const forced = candidate.priority > 0;
    if (chosen && (chosen.hits === 0 || forced)) {
      occupied.push(chosen.box);
      placed.push({ id: candidate.id, sx: candidate.sx, sy: candidate.sy + chosen.offset, forced });
    } else {
      hidden.push(candidate.id);
    }
  }

  return { placed, hidden, visibleCount: placed.length };
}
