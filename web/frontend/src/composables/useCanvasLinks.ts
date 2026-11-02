/**
 * 画布连线状态机（从第一个码连到第二个码）。
 *
 * 纯逻辑：不依赖 Konva / DOM，状态与判定都能被 node:test 直接覆盖。
 *
 * 关键约束：**连线只是「提出一条有向经过」**，它不是执行许可。这里只负责
 * 收集 (fromId, toId) 并给出明确的中文拒绝理由；能不能跑仍由后端编译安全门、
 * 定位锚定与设备就绪条件决定。因此本模块绝不返回「可执行」这种语义。
 */

export type LinkPhase = 'idle' | 'from-selected' | 'previewing';

export interface LinkState {
  phase: LinkPhase;
  fromId: number | null;
  /** 指针当前所在的候选终点（预览用，未提交）。 */
  toId: number | null;
}

export interface LinkRejection {
  code: string;
  message: string;
}

export interface LinkCandidate {
  fromId: number;
  toId: number;
}

export const IDLE_LINK: LinkState = {phase: 'idle', fromId: null, toId: null};

/** 已存在的有向边，用于拒绝重复连线。occurrence 不参与判定：同一对码第 N 次经过是合法的。 */
export interface ExistingLink {
  fromId: number;
  toId: number;
}

export function beginLink(fromId: number): LinkState {
  return {phase: 'from-selected', fromId, toId: null};
}

export function previewLink(state: LinkState, toId: number | null): LinkState {
  if (state.phase === 'idle' || state.fromId === null) return state;
  return {phase: toId === null ? 'from-selected' : 'previewing', fromId: state.fromId, toId};
}

export function cancelLink(): LinkState {
  return {...IDLE_LINK};
}

/**
 * 点击第二个码时判定能否提交。
 * 拒绝理由全部是中文，并且点名具体是哪两个码，方便界面原样展示。
 */
export function resolveLink(
  state: LinkState,
  toId: number,
  existing: readonly ExistingLink[] = [],
): {ok: true; candidate: LinkCandidate; next: LinkState} | {ok: false; rejection: LinkRejection; next: LinkState} {
  if (state.phase === 'idle' || state.fromId === null) {
    return {
      ok: false,
      rejection: {code: 'no-source', message: '请先点选起点二维码，再点终点二维码'},
      next: state,
    };
  }
  const fromId = state.fromId;
  if (fromId === toId) {
    return {
      ok: false,
      rejection: {code: 'self-loop', message: `不能把 Q${fromId} 连到它自己：路线不允许自环`},
      next: state,
    };
  }
  if (existing.some(link => link.fromId === fromId && link.toId === toId)) {
    return {
      ok: false,
      rejection: {
        code: 'duplicate-link',
        message: `Q${fromId} → Q${toId} 已经存在；同一对码要走第二次，请在路线拓扑里把它加成「第 2 次经过」`,
      },
      next: state,
    };
  }
  return {ok: true, candidate: {fromId, toId}, next: {...IDLE_LINK}};
}

/** 预览线的两个端点（画布直接画这两点之间的虚线）。 */
export function previewSegment(
  state: LinkState,
  centers: ReadonlyMap<number, {x: number; y: number}>,
  pointer: {x: number; y: number} | null,
): {from: {x: number; y: number}; to: {x: number; y: number}} | null {
  if (state.fromId === null) return null;
  const from = centers.get(state.fromId);
  if (!from) return null;
  const to = state.toId !== null ? centers.get(state.toId) ?? pointer : pointer;
  if (!to) return null;
  return {from: {x: from.x, y: from.y}, to: {x: to.x, y: to.y}};
}

/** 光标状态：连线中给 crosshair，让用户知道下一次点击会落一条边。 */
export function linkCursor(state: LinkState): 'crosshair' | 'default' {
  return state.phase === 'idle' ? 'default' : 'crosshair';
}
