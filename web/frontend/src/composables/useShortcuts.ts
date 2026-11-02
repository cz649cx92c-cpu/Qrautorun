/**
 * useShortcuts —— 编辑器统一快捷键表 + 注册/注销。
 *
 * 为什么要有这一层：撤销、删除、Esc、方向键微调以前散落在 App.vue 的 routeKey 里和各面板的
 * @keydown 上，容易重复绑定、互相抢事件，也容易在输入框里误触发。
 *
 * 结构分两半：
 *   - 纯函数（normalizeShortcutKey / isEditableTarget / matchesShortcut / resolveShortcut /
 *     nudgeStepM / isMultiSelectModifier）不依赖 Vue 与 DOM，可直接在 node:test 里跑；
 *   - useShortcuts() 只负责把这些纯函数接到 window 的 keydown/keyup、以及组件的
 *     onMounted/onBeforeUnmount 生命周期上。
 *
 * 安全约定（必须保持）：
 *   1) 焦点在 input / textarea / select / [contenteditable] 内 → 一律不触发，也不阻止默认行为；
 *   2) 只拦截自己真正消费的按键。Ctrl+C / Ctrl+V / F5 / Ctrl+L 等浏览器行为不在表里，
 *      永远不会被 preventDefault；
 *   3) Delete / Backspace / Esc / 方向键 / 空格会阻止默认的滚动、返回等行为，因为它们被消费了；
 *   4) Ctrl+Y 与 Ctrl/Cmd+Shift+Z 都映射到 redo（Windows 与 macOS 习惯都覆盖）。
 */
import {getCurrentInstance, onBeforeUnmount, onMounted, ref, type Ref} from 'vue';

export type ShortcutAction = 'undo' | 'redo' | 'delete' | 'escape' | 'nudge' | 'tool' | 'temporaryPan';

/** 工具快捷切换（与画布交互模式一一对应）。 */
export type ShortcutTool = 'select' | 'pan' | 'link' | 'measure' | 'spacing';

/** 与 KeyboardEvent 对齐的最小事件形状，测试里可以传普通对象。 */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target?: unknown;
}

export interface ShortcutSpec {
  id: string;
  action: ShortcutAction;
  /** 归一化后的小写按键名：z / delete / backspace / escape / arrowleft / v / ' ' */
  key: string;
  /** true = Ctrl 或 Meta 任选其一（跨平台）。 */
  mod?: boolean;
  /** 显式要求 Ctrl（用于 Ctrl+Y 这种平台专属组合）。 */
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * Shift / Alt 允许作为「步长修饰键」额外按下（方向键微调专用）。
   * 工具切换、撤销这类按键必须保持精确匹配，否则 Shift+V 会被当成切换工具。
   */
  allowExtraModifiers?: boolean;
  /** 被消费的按键要阻止浏览器默认行为（滚动 / 返回上一页）。 */
  preventDefault?: boolean;
  tool?: ShortcutTool;
  label: string;
}

/**
 * 方向键微调步长（米）：
 *   普通 1 cm = 0.01 m、Shift 10 cm = 0.1 m、Alt 1 mm = 0.001 m。
 * 用米而不是「画布像素」是因为路点/二维码坐标本来就在米制世界坐标系里，
 * 像素步长在缩放变化时会得到不一致的物理位移。
 */
export const NUDGE_STEPS_M = {
  fine: 0.001,
  normal: 0.01,
  coarse: 0.1,
} as const;

export const TOOL_SHORTCUTS: Readonly<Record<string, ShortcutTool>> = Object.freeze({
  v: 'select',
  h: 'pan',
  l: 'link',
  m: 'measure',
  g: 'spacing',
});

const toolLabels: Record<ShortcutTool, string> = {
  select: '选择',
  pan: '平移',
  link: '连线',
  measure: '测距',
  spacing: '间距',
};

export const SHORTCUT_SPECS: readonly ShortcutSpec[] = Object.freeze([
  {id: 'undo', action: 'undo', key: 'z', mod: true, shift: false, label: '撤销'},
  {id: 'redo-shift-z', action: 'redo', key: 'z', mod: true, shift: true, label: '重做'},
  {id: 'redo-ctrl-y', action: 'redo', key: 'y', ctrl: true, shift: false, label: '重做'},
  {id: 'delete', action: 'delete', key: 'delete', preventDefault: true, label: '删除选中'},
  {id: 'backspace', action: 'delete', key: 'backspace', preventDefault: true, label: '删除选中'},
  {id: 'escape', action: 'escape', key: 'escape', preventDefault: true, label: '取消 / 退出编辑 / 清空选择'},
  {id: 'nudge-left', action: 'nudge', key: 'arrowleft', allowExtraModifiers: true, preventDefault: true, label: '向左微调'},
  {id: 'nudge-right', action: 'nudge', key: 'arrowright', allowExtraModifiers: true, preventDefault: true, label: '向右微调'},
  {id: 'nudge-up', action: 'nudge', key: 'arrowup', allowExtraModifiers: true, preventDefault: true, label: '向上微调'},
  {id: 'nudge-down', action: 'nudge', key: 'arrowdown', allowExtraModifiers: true, preventDefault: true, label: '向下微调'},
  {id: 'tool-select', action: 'tool', key: 'v', tool: 'select', label: '工具：选择'},
  {id: 'tool-pan', action: 'tool', key: 'h', tool: 'pan', label: '工具：平移'},
  {id: 'tool-link', action: 'tool', key: 'l', tool: 'link', label: '工具：连线'},
  {id: 'tool-measure', action: 'tool', key: 'm', tool: 'measure', label: '工具：测距'},
  {id: 'tool-spacing', action: 'tool', key: 'g', tool: 'spacing', label: '工具：间距'},
  {id: 'temporary-pan', action: 'temporaryPan', key: ' ', preventDefault: true, label: '按住临时平移'},
]);

/** Esc 在旧浏览器 / 部分键盘布局下是 'Esc'，空格可能是 'Spacebar'。 */
export function normalizeShortcutKey(event: KeyEventLike | null | undefined): string {
  const raw = typeof event?.key === 'string' ? event.key : '';
  if (!raw) return '';
  if (raw === 'Spacebar') return ' ';
  if (raw === 'Esc') return 'escape';
  // 单字符键位统一小写：Shift+V 仍然是 v 键，但 shift 会被单独判定为不匹配。
  return raw.toLowerCase();
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

function tagNameOf(target: unknown): string {
  const tag = (target as {tagName?: unknown} | null | undefined)?.tagName;
  return typeof tag === 'string' ? tag.toUpperCase() : '';
}

/**
 * 焦点是否在「正在接收文本输入」的元素里。
 * 命中时所有编辑器快捷键都必须让路——否则在输入框里按退格会删除选中的路点。
 */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    type?: unknown;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
  };
  const tag = tagNameOf(element);
  if (EDITABLE_TAGS.has(tag)) return true;
  if (element.isContentEditable === true) return true;
  if (typeof element.getAttribute === 'function') {
    if (element.getAttribute('contenteditable') === 'true') return true;
    if (element.getAttribute('contenteditable') === '') return true;
    if (element.getAttribute('role') === 'textbox') return true;
    if (element.getAttribute('data-shortcuts-ignore') !== null) return true;
  }
  if (typeof element.closest === 'function') {
    try {
      if (element.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"],[data-shortcuts-ignore]')) return true;
    } catch {
      // closest 在非 DOM 的假对象上可能抛错，忽略即可。
    }
  }
  return false;
}

/**
 * 单个 spec 的匹配。修饰键默认必须「精确」：
 *   - 表里没写 shift，则按住 Shift 不匹配（避免 Shift+V 被当成工具切换）；
 *   - Shift+Alt 同时按下时，Alt（更细的步长）优先，因此 step 判定见 nudgeStepM；
 *     但匹配本身仍要求 alt 与 spec 对齐。
 */
export function matchesShortcut(event: KeyEventLike | null | undefined, spec: ShortcutSpec): boolean {
  if (!event || !spec) return false;
  if (normalizeShortcutKey(event) !== spec.key) return false;
  const ctrl = event.ctrlKey === true;
  const meta = event.metaKey === true;
  const shift = event.shiftKey === true;
  const alt = event.altKey === true;

  if (spec.mod === true) {
    if (!ctrl && !meta) return false;
  } else if (spec.ctrl === true) {
    if (!ctrl) return false;
  } else if (spec.meta === true) {
    if (!meta) return false;
  } else if (ctrl || meta) {
    // 未声明修饰键的普通按键（V/H/L/M/G/Delete/Esc）不允许带 Ctrl/Meta，
    // 否则会抢走 Ctrl+L（地址栏）、Ctrl+M、Ctrl+H 等浏览器快捷键。
    return false;
  }
  if (spec.allowExtraModifiers === true) {
    // 步长修饰键（Shift / Alt）按任意组合都算命中方向键，由 nudgeStepM 决定实际步长。
    if (spec.shift === true && !shift) return false;
    if (spec.alt === true && !alt) return false;
    return true;
  }
  if (shift !== (spec.shift === true)) return false;
  if (alt !== (spec.alt === true)) return false;
  return true;
}

export interface ShortcutMatch {
  spec: ShortcutSpec;
  action: ShortcutAction;
  tool?: ShortcutTool;
  /** 是否应该 event.preventDefault()。 */
  preventDefault: boolean;
}

/** 在整张表里找第一个匹配项；找不到返回 null（表示「这个键不归编辑器管」）。 */
export function resolveShortcut(
  event: KeyEventLike | null | undefined,
  specs: readonly ShortcutSpec[] = SHORTCUT_SPECS,
): ShortcutMatch | null {
  if (!event) return null;
  for (const spec of specs) {
    if (matchesShortcut(event, spec)) {
      return {spec, action: spec.action, tool: spec.tool, preventDefault: spec.preventDefault === true};
    }
  }
  return null;
}

export interface NudgeDelta {
  /** 水平位移（米），右为正。 */
  dx: number;
  /** 竖直位移（米），下为正（与画布屏幕坐标一致）。 */
  dy: number;
  /** 本次步长（米），便于面板显示「已移动 1 cm」。 */
  stepM: number;
  stepCm: number;
}

/** 方向键 → 位移。Alt 优先于 Shift（1 mm 比 1 cm 更细，用户按住两个修饰键时按更精细的算）。 */
export function nudgeStepM(event: KeyEventLike | null | undefined): number {
  if (event?.altKey === true) return NUDGE_STEPS_M.fine;
  if (event?.shiftKey === true) return NUDGE_STEPS_M.coarse;
  return NUDGE_STEPS_M.normal;
}

export function nudgeDeltaFromKey(event: KeyEventLike | null | undefined): NudgeDelta | null {
  const key = normalizeShortcutKey(event);
  const stepM = nudgeStepM(event);
  switch (key) {
    case 'arrowleft':
      return {dx: -stepM, dy: 0, stepM, stepCm: stepM * 100};
    case 'arrowright':
      return {dx: stepM, dy: 0, stepM, stepCm: stepM * 100};
    case 'arrowup':
      return {dx: 0, dy: -stepM, stepM, stepCm: stepM * 100};
    case 'arrowdown':
      return {dx: 0, dy: stepM, stepM, stepCm: stepM * 100};
    default:
      return null;
  }
}

/** Shift 多选：点击带修饰键时追加/取消选择，而不是替换选择。 */
export function isMultiSelectModifier(event: {shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean} | null | undefined): boolean {
  if (!event) return false;
  return event.shiftKey === true || event.metaKey === true || event.ctrlKey === true;
}

/** 中键平移：pointerdown/pointerup 的 button === 1。 */
export function isMiddlePanButton(event: {button?: number} | null | undefined): boolean {
  return event?.button === 1;
}

export interface ShortcutHandlers {
  onUndo?(): void;
  onRedo?(): void;
  onDelete?(): void;
  onEscape?(): void;
  onNudge?(delta: NudgeDelta, event: KeyEventLike): void;
  onToolChange?(tool: ShortcutTool, event: KeyEventLike): void;
  onTemporaryPan?(active: boolean): void;
  /** 可选：按下的组合键未被消费时回调，便于面板显示「未绑定」。 */
  onUnhandled?(event: KeyEventLike): void;
}

export interface UseShortcutsOptions extends ShortcutHandlers {
  /** false = 完全不挂监听（面板进入只读 / 弹窗打开时切换）。 */
  enabled?: boolean | Ref<boolean>;
  /** 替换默认表（测试或面板自定义）。 */
  specs?: readonly ShortcutSpec[];
  /** 事件宿主，默认 window。 */
  target?: EventTargetHost | null;
  /** 额外的「不该触发」判定，例如弹窗打开时。 */
  shouldIgnore?: (event: KeyEventLike) => boolean;
}

interface EventTargetHost {
  addEventListener(type: string, listener: (event: Event) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: unknown): void;
}

export interface UseShortcutsApi {
  enabled: Ref<boolean>;
  attach(): void;
  detach(): void;
  /** 供测试直接注入事件，等价于一次 window keydown。 */
  handleKeyDown(event: KeyEventLike): ShortcutMatch | null;
  handleKeyUp(event: KeyEventLike): void;
  /** 失焦时必须复位「空格临时平移」，否则松开空格的状态会丢。 */
  releaseTemporaryPan(): void;
  isTemporaryPanActive(): boolean;
  isEditableTarget: typeof isEditableTarget;
  isMultiSelectModifier: typeof isMultiSelectModifier;
}

function eventHost(): EventTargetHost | null {
  const host = globalThis as unknown as Partial<EventTargetHost>;
  return typeof host.addEventListener === 'function' && typeof host.removeEventListener === 'function'
    ? (host as EventTargetHost)
    : null;
}

/**
 * 注册统一的键盘快捷键。
 * 组件内调用：onMounted 挂、onBeforeUnmount 卸；非组件上下文只返回函数，不自动挂载。
 */
export function useShortcuts(options: UseShortcutsOptions = {}): UseShortcutsApi {
  const enabledOption = options.enabled;
  const enabled = ref(typeof enabledOption === 'boolean' ? enabledOption : enabledOption?.value !== false);
  const specs = options.specs ?? SHORTCUT_SPECS;
  const mountHost = options.target === undefined ? eventHost() : options.target;
  let attached = false;
  let temporaryPan = false;

  const readEnabled = (): boolean => {
    if (typeof enabledOption === 'boolean') return enabledOption;
    if (enabledOption && typeof enabledOption === 'object') return enabledOption.value !== false;
    return enabled.value !== false;
  };

  function releaseTemporaryPan(): void {
    if (!temporaryPan) return;
    temporaryPan = false;
    options.onTemporaryPan?.(false);
  }

  function handleKeyDown(event: KeyEventLike): ShortcutMatch | null {
    if (!readEnabled()) return null;
    if (isEditableTarget(event.target)) return null;
    if (options.shouldIgnore?.(event)) return null;

    const match = resolveShortcut(event, specs);
    if (!match) {
      options.onUnhandled?.(event);
      return null;
    }
    // 方向键长按在浏览器里会连续触发，连续微调是期望行为；
    // 撤销/删除的重复触发会一次删掉多个对象，直接忽略长按重复。
    if (event.repeat === true && match.action !== 'nudge' && match.action !== 'temporaryPan') return match;

    switch (match.action) {
      case 'undo':
        options.onUndo?.();
        break;
      case 'redo':
        options.onRedo?.();
        break;
      case 'delete':
        options.onDelete?.();
        break;
      case 'escape':
        options.onEscape?.();
        break;
      case 'nudge': {
        const delta = nudgeDeltaFromKey(event);
        if (delta) options.onNudge?.(delta, event);
        break;
      }
      case 'tool':
        if (match.tool) options.onToolChange?.(match.tool, event);
        break;
      case 'temporaryPan':
        if (!temporaryPan) {
          temporaryPan = true;
          options.onTemporaryPan?.(true);
        }
        break;
      default:
        break;
    }
    return match;
  }

  function handleKeyUp(event: KeyEventLike): void {
    if (normalizeShortcutKey(event) === ' ' || event.code === 'Space') releaseTemporaryPan();
  }

  function onKeyDown(event: Event): void {
    const keyEvent = event as unknown as KeyEventLike;
    const match = handleKeyDown(keyEvent);
    if (match?.preventDefault && typeof (event as Event & {preventDefault?: () => void}).preventDefault === 'function') {
      event.preventDefault();
    }
  }

  function onKeyUp(event: Event): void {
    handleKeyUp(event as unknown as KeyEventLike);
  }

  function onBlur(): void {
    releaseTemporaryPan();
  }

  function attach(): void {
    if (attached || !mountHost) return;
    attached = true;
    mountHost.addEventListener('keydown', onKeyDown);
    mountHost.addEventListener('keyup', onKeyUp);
    mountHost.addEventListener('blur', onBlur);
  }

  function detach(): void {
    if (!attached || !mountHost) return;
    attached = false;
    mountHost.removeEventListener('keydown', onKeyDown);
    mountHost.removeEventListener('keyup', onKeyUp);
    mountHost.removeEventListener('blur', onBlur);
    releaseTemporaryPan();
  }

  if (getCurrentInstance()) {
    onMounted(attach);
    onBeforeUnmount(detach);
  }

  return {
    enabled,
    attach,
    detach,
    handleKeyDown,
    handleKeyUp,
    releaseTemporaryPan,
    isTemporaryPanActive: () => temporaryPan,
    isEditableTarget,
    isMultiSelectModifier,
  };
}

/** 给帮助面板用的快捷键表（纯数据，不含处理逻辑）。 */
export function shortcutCheatSheet(specs: readonly ShortcutSpec[] = SHORTCUT_SPECS): {label: string; keys: string}[] {
  return specs.map(spec => ({
    label: spec.action === 'tool' && spec.tool ? toolLabels[spec.tool] : spec.label,
    keys: [
      spec.mod ? 'Ctrl/Cmd' : '',
      spec.ctrl ? 'Ctrl' : '',
      spec.meta ? 'Cmd' : '',
      spec.shift ? 'Shift' : '',
      spec.alt ? 'Alt' : '',
      spec.key === ' '
        ? 'Space'
        : spec.key.length === 1
          ? spec.key.toUpperCase()
          : spec.key.startsWith('arrow')
            ? '方向键'
            : spec.key.toUpperCase(),
    ]
      .filter(Boolean)
      .join('+'),
  }));
}
