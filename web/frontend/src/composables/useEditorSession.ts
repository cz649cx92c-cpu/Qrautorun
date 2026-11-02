import {computed,ref,shallowRef,type Ref} from 'vue';
import {UndoStack} from './useUndoStack';
import {MODE_SPECS,canEnterMode,withTemporaryPan,type EditorMode} from '../../../shared/editor-modes';

/**
 * 编辑器会话：模式 / 选中 / 撤销 / 脏标记的**唯一入口**。
 *
 * 刻意不在这里调后端：保存由调用方（App.vue）按当前模式决定是存地图还是存路线。
 * 这样"地图点位调整只生成地图版本、路线编辑只生成路线版本"的隔离由调用点保证，
 * 而会话层只负责状态与撤销语义。
 */
export interface EditorSessionOptions {
  initialMode?: EditorMode;
  capacity?: number;
  now?: () => number;
}

export interface EditorSnapshot<T> {
  payload: T;
  label: string;
}

export function useEditorSession<T = unknown>(options: EditorSessionOptions = {}) {
  const mode = ref<EditorMode>(options.initialMode ?? 'select');
  const restoreMode = ref<EditorMode | null>(null);
  const selection = ref<number[]>([]);
  const dirty = ref(false);
  const busy = ref(false);
  const lastError = ref('');
  const stack = shallowRef(new UndoStack<T>({capacity: options.capacity, now: options.now}));
  // UndoStack 的 canUndo/canRedo 是普通 getter，原地修改不会触发响应式更新。
  // 用递增 revision 让下游 computed 真正重算，否则重做按钮永远 disabled。
  const stackRevision = ref(0);
  const bumpStack = () => {
    stackRevision.value += 1;
  };

  const spec = computed(() => MODE_SPECS[mode.value]);
  const canUndo = computed(() => (stackRevision.value, stack.value.canUndo));
  const canRedo = computed(() => (stackRevision.value, stack.value.canRedo));
  const undoLabel = computed(() => (stackRevision.value, stack.value.topLabel));
  const isTemporaryPan = computed(() => restoreMode.value !== null);

  function setMode(next: EditorMode): {ok: boolean; reason?: string} {
    // 临时平移期间切换模式，先结束临时态，避免 restore 指向已废弃的模式
    if (restoreMode.value) restoreMode.value = null;
    const result = canEnterMode(mode.value, next);
    if (result.ok) {
      mode.value = next;
      lastError.value = '';
    } else {
      lastError.value = result.reason ?? '当前状态不允许切换';
    }
    return result;
  }

  function beginTemporaryPan(): void {
    if (restoreMode.value) return;
    const {temporary, restore} = withTemporaryPan(mode.value);
    restoreMode.value = restore;
    mode.value = temporary;
  }

  function endTemporaryPan(): void {
    if (!restoreMode.value) return;
    mode.value = restoreMode.value;
    restoreMode.value = null;
  }

  function selectOne(id: number): void {
    selection.value = [id];
  }

  function toggle(id: number): void {
    selection.value = selection.value.includes(id)
      ? selection.value.filter(item => item !== id)
      : [...selection.value, id];
  }

  function selectRange(ids: readonly number[]): void {
    selection.value = [...new Set(ids)];
  }

  function clearSelection(): void {
    selection.value = [];
  }

  function pushSnapshot(label: string, payload: T): void {
    stack.value.push(label, payload);
    bumpStack();
    dirty.value = true;
  }

  function undo(current: T): EditorSnapshot<T> | null {
    const entry = stack.value.undo(current);
    bumpStack();
    if (entry) dirty.value = true;
    return entry;
  }

  function redo(current: T): EditorSnapshot<T> | null {
    const entry = stack.value.redo(current);
    bumpStack();
    if (entry) dirty.value = true;
    return entry;
  }

  /**
   * 记录一次「已经知道两端」的撤销：leaving 是离开时的状态（重做目标），
   * restored 是恢复后的状态（撤销结果）。等价于 push(leaving) 后立刻 undo，
   * 但不需要调用方再算一次快照，也就不会出现「把自己刚压进去的帧弹回来」。
   */
  function adoptUndo(label: string, leaving: T, restored: T): void {
    // 撤销栈存的是「要回到的状态」。这里要回到 restored，
    // 于是压入 restored，并把当前所在状态 leaving 交给 undo 归档为「重做目标」。
    stack.value.push(label, restored);
    stack.value.undo(leaving);
    bumpStack();
    dirty.value = true;
  }

  function markDirty(): void {
    dirty.value = true;
  }

  function markSaved(): void {
    dirty.value = false;
  }

  function reset(): void {
    stack.value.clear();
    bumpStack();
    selection.value = [];
    dirty.value = false;
    lastError.value = '';
    restoreMode.value = null;
    mode.value = 'select';
  }

  return {
    mode: mode as Ref<EditorMode>,
    spec,
    selection,
    dirty,
    busy,
    lastError,
    canUndo,
    canRedo,
    undoLabel,
    isTemporaryPan,
    setMode,
    beginTemporaryPan,
    endTemporaryPan,
    selectOne,
    toggle,
    selectRange,
    clearSelection,
    pushSnapshot,
    adoptUndo,
    undo,
    redo,
    markDirty,
    markSaved,
    reset,
  };
}

export type EditorSession = ReturnType<typeof useEditorSession>;
