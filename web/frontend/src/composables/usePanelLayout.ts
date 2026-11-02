/**
 * usePanelLayout —— 编辑器「左侧导航 / 画布 / 右侧属性 / 底部面板」的宽度、高度与折叠状态。
 *
 * 设计直接沿用 App.vue 里 route-steps 浮窗现成的 clamp 范式（clampRouteStepsLayout）：
 * 任何一次写入都要同时满足「不小于最小尺寸」「不越过视口边界」「画布保留最小可用面积」，
 * 而不是各处自己 Math.max/Math.min。
 *
 * 分工：
 *   - 默认值 / clamp / 序列化 / 反序列化都是纯函数，既不依赖 Vue 也不依赖 DOM，
 *     因此能直接在 node:test 里跑（见 tests/panel-layout.test.ts）；
 *   - usePanelLayout() 只负责把纯函数接到 Vue 响应式与 localStorage 上。
 *
 * 容错原则：存储里的 JSON 坏掉、字段缺失 / 类型不对、版本号不匹配，一律回默认值，绝不抛异常，
 * 也不让编辑器因为一份坏布局打不开。
 */
import {computed, getCurrentInstance, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref} from 'vue';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface PanelLayout {
  /** 左栏宽度（像素），画布优先，宽度受视口与 canvasMinWidth 双重约束。 */
  leftWidth: number;
  /** 右栏宽度（像素），窄屏下会被强制折叠。 */
  rightWidth: number;
  /** 底部面板高度（像素）。 */
  bottomHeight: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  bottomCollapsed: boolean;
  /** 右栏浮动（脱离 flex 流，覆盖在画布上，不再挤压画布宽度）。 */
  rightFloating: boolean;
}

export type PanelSide = 'left' | 'right';
export type PanelRegion = 'left' | 'right' | 'bottom';

/** 本地存储键：带版本号，未来结构变更时直接换键，旧数据自然失效。 */
export const LAYOUT_STORAGE_KEY = 'qrautorun.editor.layout.v1';
export const LAYOUT_VERSION = 1;
/** 低于该宽度视为窄屏：右侧属性面板强制折叠，避免把画布挤到不可用。 */
export const NARROW_VIEWPORT_PX = 1200;

export const LAYOUT_LIMITS = {
  leftMin: 200,
  leftMax: 400,
  rightMin: 200,
  rightMax: 380,
  bottomMin: 120,
  bottomMax: 380,
  /** 画布最小可用宽度 / 高度：任何 clamp 都必须给它让路。 */
  canvasMinWidth: 360,
  canvasMinHeight: 260,
  /** 顶栏 + 工具栏等固定 chrome 的高度估算，用于底部面板的预算。 */
  chromeHeightPx: 200,
  floatingRightMinWidth: 260,
  floatingRightMaxWidth: 420,
} as const;

export const DEFAULT_PANEL_LAYOUT: Readonly<PanelLayout> = Object.freeze({
  leftWidth: 280,
  rightWidth: 248,
  bottomHeight: 180,
  leftCollapsed: false,
  rightCollapsed: false,
  bottomCollapsed: false,
  rightFloating: false,
});

export function defaultPanelLayout(): PanelLayout {
  return {...DEFAULT_PANEL_LAYOUT};
}

const px = (value: number) => Math.round(value);

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clampNumber = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * 视口归一化：SSR / 初次挂载 / 测试里拿不到窗口尺寸时给一个「桌面默认」，
 * 保证下游 clamp 永远有可用数字，不会算出 NaN。
 */
export function normalizeViewport(viewport?: ViewportSize | null): ViewportSize {
  const width = finiteOr(viewport?.width, 0);
  const height = finiteOr(viewport?.height, 0);
  return {width: width > 0 ? width : 1440, height: height > 0 ? height : 900};
}

export function isNarrowViewport(viewport?: ViewportSize | null): boolean {
  return normalizeViewport(viewport).width < NARROW_VIEWPORT_PX;
}

/**
 * 左右侧栏宽度 clamp。
 * @param otherSideWidthPx 另一侧当前占用的宽度（已折叠 / 浮动时传 0），用于给画布留出 canvasMinWidth。
 */
export function clampSideWidth(
  side: PanelSide,
  value: number,
  viewport: ViewportSize,
  otherSideWidthPx = 0,
): number {
  const view = normalizeViewport(viewport);
  const min = side === 'left' ? LAYOUT_LIMITS.leftMin : LAYOUT_LIMITS.rightMin;
  const max = side === 'left' ? LAYOUT_LIMITS.leftMax : LAYOUT_LIMITS.rightMax;
  const others = Math.max(0, finiteOr(otherSideWidthPx, 0));
  // 可用预算 = 视口宽 - 另一侧 - 画布最小宽度；预算比硬上限还小时以预算为准。
  const budget = view.width - others - LAYOUT_LIMITS.canvasMinWidth;
  const hardMax = Math.max(min, Math.min(max, budget));
  return px(clampNumber(finiteOr(value, min), min, hardMax));
}

/** 底部面板高度 clamp：同样给画布留出 canvasMinHeight。 */
export function clampBottomHeight(value: number, viewport: ViewportSize): number {
  const view = normalizeViewport(viewport);
  const budget = view.height - LAYOUT_LIMITS.chromeHeightPx - LAYOUT_LIMITS.canvasMinHeight;
  const hardMax = Math.max(LAYOUT_LIMITS.bottomMin, Math.min(LAYOUT_LIMITS.bottomMax, budget));
  return px(clampNumber(finiteOr(value, LAYOUT_LIMITS.bottomMin), LAYOUT_LIMITS.bottomMin, hardMax));
}

/** 右栏浮动时的宽度 clamp：不参与画布宽度预算，只保证不越出视口。 */
export function clampRightFloatingWidth(value: number, viewport: ViewportSize): number {
  const view = normalizeViewport(viewport);
  const max = Math.max(
    LAYOUT_LIMITS.floatingRightMinWidth,
    Math.min(LAYOUT_LIMITS.floatingRightMaxWidth, view.width - 48),
  );
  return px(clampNumber(finiteOr(value, LAYOUT_LIMITS.floatingRightMinWidth), LAYOUT_LIMITS.floatingRightMinWidth, max));
}

/**
 * 把任意一份布局 clamp 到当前视口内（不改变用户的折叠偏好）。
 * 先算右侧再算左侧，保证两侧同时满足预算。
 */
export function clampLayout(layout: PanelLayout, viewport: ViewportSize): PanelLayout {
  const view = normalizeViewport(viewport);
  const leftCollapsed = layout.leftCollapsed === true;
  const rightCollapsed = layout.rightCollapsed === true;
  const rightFloating = layout.rightFloating === true;

  const leftForRight = leftCollapsed ? 0 : clampSideWidth('left', layout.leftWidth, view, 0);
  const rightWidth = rightFloating
    ? clampRightFloatingWidth(layout.rightWidth, view)
    : clampSideWidth('right', layout.rightWidth, view, leftForRight);
  const leftWidth = clampSideWidth('left', layout.leftWidth, view, rightCollapsed || rightFloating ? 0 : rightWidth);

  return {
    leftWidth,
    rightWidth,
    bottomHeight: clampBottomHeight(layout.bottomHeight, view),
    leftCollapsed,
    rightCollapsed,
    bottomCollapsed: layout.bottomCollapsed === true,
    rightFloating,
  };
}

/**
 * 响应式降级：窄屏（< 1200px）强制收起右栏，否则两侧侧栏会把画布挤到不可用。
 * 只作用于「生效布局」，不回写用户偏好——窗口再拉宽时用户原来的宽度与折叠状态会自动回来。
 * 右栏处于浮动模式时本来就不占宽度，只保留用户自己的折叠选择。
 */
export function applyResponsiveLayout(layout: PanelLayout, viewport: ViewportSize): PanelLayout {
  const view = normalizeViewport(viewport);
  if (!isNarrowViewport(view)) return layout;
  const rightCollapsed = layout.rightFloating === true ? layout.rightCollapsed : true;
  return {...layout, rightCollapsed};
}

/** 生效布局 = 先 clamp 再响应式降级；组件里所有尺寸都应读这个结果。 */
export function resolveEffectiveLayout(layout: PanelLayout, viewport: ViewportSize): PanelLayout {
  return applyResponsiveLayout(clampLayout(layout, viewport), viewport);
}

export function layoutEquals(a: PanelLayout, b: PanelLayout): boolean {
  return (
    a.leftWidth === b.leftWidth &&
    a.rightWidth === b.rightWidth &&
    a.bottomHeight === b.bottomHeight &&
    a.leftCollapsed === b.leftCollapsed &&
    a.rightCollapsed === b.rightCollapsed &&
    a.bottomCollapsed === b.bottomCollapsed &&
    a.rightFloating === b.rightFloating
  );
}

/** 序列化：只写版本号与 7 个字段，不做任何函数/闭包，保证可以被 JSON 往返。 */
export function serializePanelLayout(layout: PanelLayout): string {
  return JSON.stringify({
    version: LAYOUT_VERSION,
    leftWidth: px(finiteOr(layout.leftWidth, DEFAULT_PANEL_LAYOUT.leftWidth)),
    rightWidth: px(finiteOr(layout.rightWidth, DEFAULT_PANEL_LAYOUT.rightWidth)),
    bottomHeight: px(finiteOr(layout.bottomHeight, DEFAULT_PANEL_LAYOUT.bottomHeight)),
    leftCollapsed: layout.leftCollapsed === true,
    rightCollapsed: layout.rightCollapsed === true,
    bottomCollapsed: layout.bottomCollapsed === true,
    rightFloating: layout.rightFloating === true,
  });
}

/**
 * 把「任意形状的已存数据」收敛成布局对象：
 *   - 不是普通对象（null / 数组 / 字符串 / 数字）→ 默认值；
 *   - version 不是当前版本（缺失也算不匹配）→ 默认值，避免旧结构被误读成新结构；
 *   - 单个字段类型不对 → 只有该字段回默认值。
 */
export function coercePanelLayout(value: unknown, base: PanelLayout = defaultPanelLayout()): PanelLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {...base};
  const record = value as Record<string, unknown>;
  if (record.version !== LAYOUT_VERSION) return {...base};
  const number = (key: string, fallback: number): number => {
    const raw = record[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  };
  const flag = (key: string, fallback: boolean): boolean => (typeof record[key] === 'boolean' ? (record[key] as boolean) : fallback);
  return {
    leftWidth: number('leftWidth', base.leftWidth),
    rightWidth: number('rightWidth', base.rightWidth),
    bottomHeight: number('bottomHeight', base.bottomHeight),
    leftCollapsed: flag('leftCollapsed', base.leftCollapsed),
    rightCollapsed: flag('rightCollapsed', base.rightCollapsed),
    bottomCollapsed: flag('bottomCollapsed', base.bottomCollapsed),
    rightFloating: flag('rightFloating', base.rightFloating),
  };
}

/**
 * 反序列化入口：坏 JSON / 空串 / 版本不符 / 字段缺失都回默认值，并统一过一遍 clamp。
 * 这是 restore() 的唯一解析路径，保证「存储坏了也照样能打开编辑器」。
 */
export function parsePanelLayout(raw: string | null | undefined, viewport?: ViewportSize): PanelLayout {
  const view = normalizeViewport(viewport);
  const fallback = resolveEffectiveLayout(defaultPanelLayout(), view);
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  return resolveEffectiveLayout(coercePanelLayout(parsed), view);
}

export interface LayoutStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function resolveStorageKey(key?: string): string {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  return trimmed || LAYOUT_STORAGE_KEY;
}

/** 读存储：没有值 / 读失败 → null；有值但内容坏 → 默认布局（由 parsePanelLayout 兜底）。 */
export function readStoredPanelLayout(
  storage: LayoutStorageLike | null | undefined,
  viewport?: ViewportSize,
  key: string = LAYOUT_STORAGE_KEY,
): PanelLayout | null {
  if (!storage || typeof storage.getItem !== 'function') return null;
  let raw: unknown;
  try {
    raw = storage.getItem(resolveStorageKey(key));
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return parsePanelLayout(raw, viewport);
}

/** 写存储：配额满 / 隐私模式禁写都只返回 false，绝不打断编辑器。 */
export function writeStoredPanelLayout(
  storage: LayoutStorageLike | null | undefined,
  layout: PanelLayout,
  key: string = LAYOUT_STORAGE_KEY,
): boolean {
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(resolveStorageKey(key), serializePanelLayout(layout));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredPanelLayout(storage: LayoutStorageLike | null | undefined, key: string = LAYOUT_STORAGE_KEY): boolean {
  if (!storage || typeof storage.removeItem !== 'function') return false;
  try {
    storage.removeItem(resolveStorageKey(key));
    return true;
  } catch {
    return false;
  }
}

/** 事件宿主：不直接引用 window，这样本文件在无 DOM 的 node:test 里也能被导入。 */
interface ListenerHostLike {
  addEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
}

function eventHost(): ListenerHostLike | null {
  const host = globalThis as unknown as Partial<ListenerHostLike>;
  return typeof host.addEventListener === 'function' && typeof host.removeEventListener === 'function'
    ? (host as ListenerHostLike)
    : null;
}

function defaultStorage(): LayoutStorageLike | null {
  try {
    const store = (globalThis as unknown as {localStorage?: LayoutStorageLike}).localStorage;
    return store && typeof store.getItem === 'function' && typeof store.setItem === 'function' ? store : null;
  } catch {
    // 隐私模式 / 跨域 iframe 下访问 localStorage 会直接抛错。
    return null;
  }
}

function measureViewport(): ViewportSize {
  const host = globalThis as unknown as {innerWidth?: number; innerHeight?: number};
  return normalizeViewport({
    width: typeof host.innerWidth === 'number' ? host.innerWidth : 0,
    height: typeof host.innerHeight === 'number' ? host.innerHeight : 0,
  });
}

export interface UsePanelLayoutOptions {
  /** 覆盖默认键（EditorShell 的 storageKey prop）；函数形式支持 prop 变化。 */
  storageKey?: string | (() => string | undefined);
  /** 注入存储（测试 / 非浏览器环境）；传 null 表示禁用持久化。 */
  storage?: LayoutStorageLike | null;
  /** 注入视口尺寸来源（测试）。 */
  viewport?: () => ViewportSize | undefined;
  /** false = 不自动监听 window resize、不自动 restore（测试用）。 */
  attach?: boolean;
}

export interface PanelLayoutApi {
  readonly layout: Ref<PanelLayout>;
  readonly effective: ComputedRef<PanelLayout>;
  readonly viewport: Ref<ViewportSize>;
  readonly isNarrow: ComputedRef<boolean>;
  setLeftWidth(value: number): void;
  setRightWidth(value: number): void;
  setBottomHeight(value: number): void;
  update(patch: Partial<PanelLayout>): void;
  toggleSide(side: PanelSide): void;
  toggleBottom(): void;
  setRightFloating(floating: boolean): void;
  persist(): boolean;
  restore(): void;
  resetLayout(): void;
  measure(): ViewportSize;
  storageKey(): string;
  dispose(): void;
}

/**
 * 布局 composable。
 * 挂载时（组件上下文内）读取一次存储并监听 resize；onBeforeUnmount 自动注销。
 * 非组件上下文（纯逻辑测试）只暴露函数，不注册任何监听。
 */
export function usePanelLayout(options: UsePanelLayoutOptions = {}): PanelLayoutApi {
  const attach = options.attach !== false;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const keyOf = (): string => {
    const raw = options.storageKey;
    const value = typeof raw === 'function' ? raw() : raw;
    return resolveStorageKey(value);
  };

  const viewport = ref<ViewportSize>(normalizeViewport(options.viewport ? options.viewport() : measureViewport()));
  const layout = ref<PanelLayout>(defaultPanelLayout());
  const effective = computed(() => resolveEffectiveLayout(layout.value, viewport.value));
  const isNarrow = computed(() => isNarrowViewport(viewport.value));

  function update(patch: Partial<PanelLayout>): void {
    layout.value = {...layout.value, ...patch};
  }

  function setLeftWidth(value: number): void {
    const current = effective.value;
    const others = current.rightCollapsed || current.rightFloating ? 0 : current.rightWidth;
    update({leftWidth: clampSideWidth('left', value, viewport.value, others)});
  }

  function setRightWidth(value: number): void {
    const current = effective.value;
    const width = current.rightFloating
      ? clampRightFloatingWidth(value, viewport.value)
      : clampSideWidth('right', value, viewport.value, current.leftCollapsed ? 0 : current.leftWidth);
    update({rightWidth: width});
  }

  function setBottomHeight(value: number): void {
    update({bottomHeight: clampBottomHeight(value, viewport.value)});
  }

  function toggleSide(side: PanelSide): void {
    if (side === 'left') update({leftCollapsed: !layout.value.leftCollapsed});
    else update({rightCollapsed: !layout.value.rightCollapsed});
  }

  function toggleBottom(): void {
    update({bottomCollapsed: !layout.value.bottomCollapsed});
  }

  function setRightFloating(floating: boolean): void {
    // 浮动后右栏不占宽度，折叠状态自然解除；切回停靠时保留原宽度。
    update({rightFloating: floating === true, rightCollapsed: floating === true ? false : layout.value.rightCollapsed});
  }

  function persist(): boolean {
    return writeStoredPanelLayout(storage, layout.value, keyOf());
  }

  function restore(): void {
    const stored = readStoredPanelLayout(storage, viewport.value, keyOf());
    layout.value = stored ?? defaultPanelLayout();
  }

  function resetLayout(): void {
    layout.value = defaultPanelLayout();
    clearStoredPanelLayout(storage, keyOf());
  }

  function measure(): ViewportSize {
    const next = normalizeViewport(options.viewport ? options.viewport() : measureViewport());
    viewport.value = next;
    return next;
  }

  function onResize(): void {
    measure();
  }

  const host = eventHost();
  function dispose(): void {
    if (host) host.removeEventListener('resize', onResize);
  }

  // 组件上下文：先把存储里的布局恢复到初始状态（避免挂载瞬间的跳变），再监听 resize。
  if (getCurrentInstance()) {
    restore();
    if (attach && host) {
      onMounted(() => host.addEventListener('resize', onResize));
      onBeforeUnmount(dispose);
    }
  }

  return {
    layout,
    effective,
    viewport,
    isNarrow,
    setLeftWidth,
    setRightWidth,
    setBottomHeight,
    update,
    toggleSide,
    toggleBottom,
    setRightFloating,
    persist,
    restore,
    resetLayout,
    measure,
    storageKey: keyOf,
    dispose,
  };
}
