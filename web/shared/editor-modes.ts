/**
 * 编辑器模式表：把「当前处于什么模式」从散落的一堆布尔量收敛成唯一枚举。
 *
 * 为什么要有这张表：历史上有三个真实缺陷都来自"模式判断分散在各处"——
 *   1) panEnabled 曾让路径编辑里左键一点就平移，导致点选失效；
 *   2) tagPositionEditing 曾被算进 routeLocked，整个路径编辑按钮全灰；
 *   3) 铺码预览把地图草稿置为 active，同样锁死路径编辑。
 * 现在所有"这个模式能不能平移/能不能选/会不会改数据"的答案都只来自这里，
 * UI 不要在别处再写一遍判断。
 */

export type EditorMode =
  | 'select'
  | 'boxSelect'
  | 'pan'
  | 'draw'
  | 'connect'
  | 'measure'
  | 'spacing'
  | 'tagEdit';

export const EDITOR_MODES: readonly EditorMode[] = [
  'select', 'boxSelect', 'pan', 'draw', 'connect', 'measure', 'spacing', 'tagEdit',
] as const;

export interface EditorModeSpec {
  mode: EditorMode;
  label: string;
  /** 左键在空白处拖动是否平移画布。这条是 bug 1 的根治点。 */
  dragPansCanvas: boolean;
  /** 左键点击对象是否改变选中集。 */
  clickSelects: boolean;
  /** 是否会修改数据（决定 dirty 与撤销栈）。 */
  mutates: boolean;
  /** 该模式下不允许同时进入的其它模式（双向判定）。 */
  conflictsWith: readonly EditorMode[];
  /** 单击空白是否允许"追加对象"（画点/连线）。 */
  clickCreates: boolean;
}

export const MODE_SPECS: Record<EditorMode, EditorModeSpec> = {
  select: {
    mode: 'select',
    label: '选择',
    // 关键：选择模式绝不平移。否则单击会先被平移手势吃掉，点选永远失败。
    dragPansCanvas: false,
    clickSelects: true,
    mutates: false,
    // 注意：不要与 measure/spacing/tagEdit 互斥——从"选择"切到这些工具是常规操作。
    conflictsWith: ['pan'],
    clickCreates: false,
  },
  boxSelect: {
    mode: 'boxSelect',
    label: '框选',
    dragPansCanvas: false,
    clickSelects: true,
    mutates: false,
    conflictsWith: ['pan', 'draw', 'connect'],
    clickCreates: false,
  },
  pan: {
    mode: 'pan',
    label: '平移',
    dragPansCanvas: true,
    clickSelects: false,
    mutates: false,
    conflictsWith: ['select', 'boxSelect', 'draw', 'connect', 'tagEdit'],
    clickCreates: false,
  },
  draw: {
    mode: 'draw',
    label: '加点',
    dragPansCanvas: false,
    clickSelects: false,
    mutates: true,
    conflictsWith: ['pan', 'tagEdit', 'spacing'],
    clickCreates: true,
  },
  connect: {
    mode: 'connect',
    label: '连线',
    dragPansCanvas: false,
    clickSelects: true,
    mutates: true,
    conflictsWith: ['pan', 'draw', 'spacing'],
    clickCreates: true,
  },
  measure: {
    mode: 'measure',
    label: '测距',
    dragPansCanvas: false,
    clickSelects: true,
    mutates: false,
    conflictsWith: ['draw', 'connect'],
    clickCreates: false,
  },
  spacing: {
    mode: 'spacing',
    label: '二维码间距',
    dragPansCanvas: false,
    clickSelects: true,
    mutates: true,
    conflictsWith: ['pan', 'draw', 'tagEdit'],
    clickCreates: false,
  },
  tagEdit: {
    mode: 'tagEdit',
    label: '调整二维码',
    // 点位编辑必须能直接拖动二维码，但空白拖动不能平移画布。
    dragPansCanvas: false,
    clickSelects: true,
    mutates: true,
    conflictsWith: ['pan', 'draw', 'spacing'],
    clickCreates: false,
  },
};

export interface ModeTransition {
  ok: boolean;
  reason?: string;
}

/**
 * 判断能否从 current **切换**到 next。
 *
 * 关键语义：`conflictsWith` 描述的是「两个模式不能同时生效」，不是「不能互相切换」。
 * 模式是单一枚举，切换本身就是先离开再进入，所以互斥的一对（选择↔平移）也必须可切。
 * 早期版本把互斥当成禁切，导致点「平移」毫无反应、徽章永远停在「选择」——
 * 这正是用户报的「工具切不过去」。
 *
 * 仍然拒绝的两类情况：
 * 1) 未知模式（防御性，理论上不可达）；
 * 2) 目标模式要求独占画布、而当前模式正持有未保存的编辑草稿（mutates 且 dirty），
 *    由调用方通过 `requireCleanDraft` 传入——避免静默丢弃草稿。
 */
export interface ModeTransitionOptions {
  /** 当前是否有未保存的编辑草稿；为 true 时禁止切到会抢走画布的模式。 */
  dirtyDraft?: boolean;
}
export function canEnterMode(
  current: EditorMode,
  next: EditorMode,
  options: ModeTransitionOptions = {},
): ModeTransition {
  if (current === next) return { ok: true };
  const currentSpec = MODE_SPECS[current];
  const nextSpec = MODE_SPECS[next];
  if (!currentSpec || !nextSpec) return { ok: false, reason: `未知模式：${String(!currentSpec ? current : next)}` };
  // 只有「有未保存草稿时被别的模式抢走画布」才拒绝；纯切换一律允许。
  if (options.dirtyDraft === true && currentSpec.mutates && nextSpec.conflictsWith.includes(current)) {
    return { ok: false, reason: `正在${currentSpec.label}且有未保存改动，请先保存或退出再切到${nextSpec.label}` };
  }
  return { ok: true };
}

/**
 * 空格/中键的临时平移：进入临时 pan，松开后回到原模式。
 * 临时平移不改变 mutates，也不应该污染调用方的"当前工具"。
 */
export function withTemporaryPan(current: EditorMode): {temporary: EditorMode; restore: EditorMode} {
  return { temporary: 'pan', restore: current };
}

export interface LegacyModeInput {
  editingRoute?: boolean;
  routeTool?: string;
  measuring?: boolean;
  tagPositionEditing?: boolean;
  tagCreateEditing?: boolean;
  spacingActive?: boolean;
}

/**
 * 迁移期兼容：从旧的散落布尔量推导唯一模式。
 *
 * 优先级刻意这样排：显式的编辑态（点位调整 > 铺码 > 测距 > 路径工具）
 * 高于"是否正在编辑路径"，因为历史 bug 就是把区域状态混进了全局锁。
 * 注意：这里**绝不会**因为 tagPositionEditing 而返回一个"锁死路径"的模式，
 * 点位编辑只是模式之一，路径工具仍然可用。
 */
export function resolveLegacyMode(input: LegacyModeInput): EditorMode {
  if (input.tagPositionEditing) return 'tagEdit';
  if (input.tagCreateEditing) return 'draw';
  if (input.spacingActive) return 'spacing';
  if (input.measuring) return 'measure';
  if (input.editingRoute) {
    if (input.routeTool === 'pan') return 'pan';
    if (input.routeTool === 'draw') return 'draw';
    if (input.routeTool === 'connect') return 'connect';
    return 'select';
  }
  return 'select';
}

/** 该模式是否允许写入数据（供保存按钮与 dirty 判定统一调用）。 */
export function modeMutates(mode: EditorMode): boolean {
  return !!MODE_SPECS[mode]?.mutates;
}

/** 该模式是否允许左键拖动平移画布（供 MapCanvas 单一入口读取）。 */
export function modeDragPans(mode: EditorMode): boolean {
  return !!MODE_SPECS[mode]?.dragPansCanvas;
}
