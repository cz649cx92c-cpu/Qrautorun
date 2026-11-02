/**
 * 画布框选（rubber-band）。
 *
 * 纯逻辑：不依赖 Konva、不依赖 DOM，输入是「按下点 + 当前点 + 一堆点的坐标」，
 * 输出是命中的 id 数组。这样框选规则可以被 node:test 直接覆盖，不需要起浏览器。
 *
 * 三个刻意的决定：
 * 1. **按下点与当前点必须归一化**：用户可以从右下往左上拉框，rect 的 x/y 不能直接用按下点。
 * 2. **命中用点中心**：定位码是画在地图上的点（中心坐标），用中心判定与画布上的视觉一致，
 *    不会出现「框住码的一角就算选中」的错觉。
 * 3. **空框不算全选**：拖动距离小于阈值视为一次普通单击，返回空数组而不是所有点，
 *    否则轻微抖动就会把整张图选中。
 */

export interface SelectionPoint {
  id: number;
  x: number;
  y: number;
}

export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 小于这个像素/米距离的拖动视为单击（画布坐标是米，与 Konva 的 px 无关）。 */
export const BOX_SELECT_MIN_SPAN = 0.02;

/** 把两个对角点归一化成左上角 + 正宽高。 */
export function normalizeRect(from: {x: number; y: number}, to: {x: number; y: number}): SelectionRect {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return {x, y, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y)};
}

/** 拖动是否足够大，够大才算框选而不是单击。 */
export function isMeaningfulBox(rect: SelectionRect): boolean {
  return rect.width >= BOX_SELECT_MIN_SPAN || rect.height >= BOX_SELECT_MIN_SPAN;
}

/** 框内命中的 id（按输入顺序，结果稳定可断言）。 */
export function pointsInRect(points: readonly SelectionPoint[], rect: SelectionRect): number[] {
  if (!isMeaningfulBox(rect)) return [];
  const right = rect.x + rect.width;
  const top = rect.y + rect.height;
  return points
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    .filter(point => point.x >= rect.x && point.x <= right && point.y >= rect.y && point.y <= top)
    .map(point => point.id);
}

/**
 * 框选后的选择结果。
 * - 默认替换选择（与桌面图形编辑器一致）；
 * - `additive`（按住 Shift）在已有选择上并集，而不是覆盖。
 */
export function applyBoxSelection(
  current: readonly number[],
  hit: readonly number[],
  additive = false,
): number[] {
  if (!hit.length) return additive ? [...current] : [];
  if (!additive) return [...new Set(hit)];
  return [...new Set([...current, ...hit])];
}

/** 点一下（不拖动）时的选择语义：Shift 加选/减选，否则单选。 */
export function applyClickSelection(current: readonly number[], id: number, additive = false): number[] {
  if (!additive) return [id];
  return current.includes(id) ? current.filter(item => item !== id) : [...current, id];
}

export function toggleSelection(current: readonly number[], id: number): number[] {
  return current.includes(id) ? current.filter(item => item !== id) : [...current, id];
}

export function selectAll(points: readonly SelectionPoint[]): number[] {
  return points.map(point => point.id);
}

export function clearSelection(): number[] {
  return [];
}
