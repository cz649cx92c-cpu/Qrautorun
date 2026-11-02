/**
 * 撤销栈：纯 TS、不依赖 Vue，便于 node 直接测试。
 *
 * 设计要点（对齐 drawio 的 mxUndoManager 思路）：
 * - 按「一次操作」入栈，而不是一个点一次。阵列 100 个码必须一次撤销。
 * - 快照是不可变深拷贝，push 之后调用方再改原对象不影响栈内副本。
 * - 容量上限裁剪最旧项；undo 后再 push 会清空 redo 分支。
 */
export interface UndoEntry<T> {
  label: string;
  payload: T;
  at: number;
}

export interface UndoStackOptions {
  capacity?: number;
  /** 取当前时间；测试里可注入固定值。 */
  now?: () => number;
}

const deepClone = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => deepClone(item)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = deepClone(item);
  return out as T;
};

export class UndoStack<T> {
  private readonly capacity: number;
  private readonly now: () => number;
  private undoEntries: UndoEntry<T>[] = [];
  private redoEntries: UndoEntry<T>[] = [];

  constructor(options: UndoStackOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 50);
    this.now = options.now ?? (() => Date.now());
  }

  get canUndo(): boolean {
    return this.undoEntries.length > 0;
  }

  get canRedo(): boolean {
    return this.redoEntries.length > 0;
  }

  get depth(): number {
    return this.undoEntries.length;
  }

  /** 最近一次入栈的操作名，用于 UI 显示"撤销：移动点位"。 */
  get topLabel(): string | null {
    return this.undoEntries.at(-1)?.label ?? null;
  }

  push(label: string, payload: T): void {
    this.undoEntries = [...this.undoEntries, {label, payload: deepClone(payload), at: this.now()}];
    if (this.undoEntries.length > this.capacity) {
      this.undoEntries = this.undoEntries.slice(this.undoEntries.length - this.capacity);
    }
    // 新的操作分支出现，原 redo 路径失效
    this.redoEntries = [];
  }

  undo(current: T): {payload: T; label: string} | null {
    const entry = this.undoEntries.at(-1);
    if (!entry) return null;
    this.undoEntries = this.undoEntries.slice(0, -1);
    this.redoEntries = [...this.redoEntries, {label: entry.label, payload: deepClone(current), at: this.now()}];
    return {payload: deepClone(entry.payload), label: entry.label};
  }

  redo(current: T): {payload: T; label: string} | null {
    const entry = this.redoEntries.at(-1);
    if (!entry) return null;
    this.redoEntries = this.redoEntries.slice(0, -1);
    this.undoEntries = [...this.undoEntries, {label: entry.label, payload: deepClone(current), at: this.now()}];
    return {payload: deepClone(entry.payload), label: entry.label};
  }

  clear(): void {
    this.undoEntries = [];
    this.redoEntries = [];
  }
}
