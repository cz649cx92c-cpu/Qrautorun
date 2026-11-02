<script lang="ts">
/**
 * 路径编辑工具条 —— 画布上方的固定工具条（**布局 chrome，不含任何业务状态**）。
 *
 * 设计目标（对应用户截图暴露的问题）：
 *  1. 高频操作（选择/加点/连线/平移/测距、撤销/重做、保存路径/退出）固定可见，
 *     不再需要滚动左侧面板才能找到；
 *  2. 低频操作收进「更多」下拉，但仍可发现；
 *  3. 工具条在画布**之外**的普通文档流里（不是 position:absolute），因此不会盖住画布；
 *     允许换行 + 右侧动作组 flex:0 0 auto，窗口变矮/变窄时保存/退出也不会被裁掉；
 *  4. 选中态一律用 aria-pressed（选择/加点/连线/平移/测距/属性），测距是独立开关；
 *  5. 按钮的 data-testid 沿用既有约定，避免破坏既有浏览器回归：
 *     route-select-tool / route-draw-tool / route-connect-tool / route-pan-tool /
 *     route-measure-tool / route-undo / route-redo / route-more / route-save / route-exit /
 *     route-properties-toggle；「更多」里的低频项统一用 route-more-* 前缀。
 *
 * 所有交互只 emit，不调用接口、不读写路径数据。
 */
export type RouteEditorToolId = 'select' | 'draw' | 'connect' | 'pan';
export type RouteEditorToolbarAction =
  | 'measure'
  | 'undo'
  | 'redo'
  | 'save'
  | 'exit'
  | 'properties'
  | 'clear'
  | 'delete-selected'
  | 'delete-route'
  | 'delete-point'
  | 'save-as'
  | 'auto-chain'
  | 'generate-route';
</script>

<script setup lang="ts">
import {onBeforeUnmount,onMounted,ref,type Component} from 'vue';
import {
  Hand, Link2, LogOut, MoreHorizontal, Move, PenLine, Redo2, Ruler, Save, Settings2, Undo2,
} from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    /** 当前画布工具（单选）：选择 / 加点 / 连线 / 平移。 */
    tool?: RouteEditorToolId;
    /** 测距是独立开关，不占用 canvas 工具位。 */
    measuring?: boolean;
    canUndo?: boolean;
    canRedo?: boolean;
    canSave?: boolean;
    canExit?: boolean;
    saving?: boolean;
    /** 路线锁（导航运行中、版本冲突等）：全部禁用，但按钮仍可见。 */
    locked?: boolean;
    /** 是否显示「属性」开关（右侧属性区的开合由 App 决定）。 */
    showProperties?: boolean;
    propertiesActive?: boolean;
    /** 逐项禁用（例如测距需要 ≥2 个定位组）。 */
    disabled?: Partial<Record<RouteEditorToolbarAction, boolean>>;
    /** 窄高度/窄宽度下的紧凑排版。 */
    dense?: boolean;
    saveLabel?: string;
    exitLabel?: string;
    moreLabel?: string;
  }>(),
  {
    tool: 'select',
    measuring: false,
    canUndo: false,
    canRedo: false,
    canSave: true,
    canExit: true,
    saving: false,
    locked: false,
    showProperties: false,
    propertiesActive: false,
    disabled: () => ({}),
    dense: false,
    saveLabel: '保存路径',
    exitLabel: '退出',
    moreLabel: '更多',
  },
);

const emit = defineEmits<{
  (event: 'tool', id: RouteEditorToolId): void;
  (event: 'action', id: RouteEditorToolbarAction): void;
}>();

interface ToolButton {
  id: RouteEditorToolId;
  label: string;
  title: string;
  testid: string;
  icon: Component;
  shortcut?: string;
}
const tools: ToolButton[] = [
  {id: 'select', label: '选择', title: '选择并拖动路点', testid: 'route-select-tool', icon: Hand, shortcut: 'V'},
  {id: 'draw', label: '加点', title: '单击画布追加路点', testid: 'route-draw-tool', icon: PenLine, shortcut: 'A'},
  {id: 'connect', label: '连线', title: '点两个定位码连出一条有向经过', testid: 'route-connect-tool', icon: Link2, shortcut: 'L'},
  {id: 'pan', label: '平移', title: '拖动地图（不修改路线）', testid: 'route-pan-tool', icon: Move, shortcut: 'H'},
];

function isDisabled(action: RouteEditorToolbarAction): boolean {
  return props.locked || props.disabled[action] === true;
}
function pickTool(id: RouteEditorToolId): void {
  if (props.locked) return;
  emit('tool', id);
}
function run(action: RouteEditorToolbarAction): void {
  if (isDisabled(action)) return;
  closeMore();
  emit('action', action);
}
function toggleMeasure(): void {
  run('measure');
}

const more = ref<HTMLDetailsElement | null>(null);
const moreOpen = ref(false);
function onMoreToggle(): void {
  moreOpen.value = more.value?.open === true;
}
function closeMore(): void {
  if (more.value?.open) more.value.open = false;
  moreOpen.value = false;
}
function onDocumentPointerDown(event: PointerEvent): void {
  if (!moreOpen.value) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('[data-testid="route-more"]')) return;
  closeMore();
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && moreOpen.value) closeMore();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onKeydown);
});

interface MoreItem {
  id: RouteEditorToolbarAction;
  label: string;
  testid: string;
  danger?: boolean;
}
const moreItems: MoreItem[] = [
  {id: 'save-as', label: '另存为新路径', testid: 'route-more-save-as'},
  {id: 'auto-chain', label: '自动串码', testid: 'route-more-auto-chain'},
  {id: 'generate-route', label: '按行生成路径', testid: 'route-more-generate-route'},
  {id: 'clear', label: '清空路径', testid: 'route-more-clear'},
  {id: 'delete-point', label: '删除路径点', testid: 'route-more-delete-point'},
  {id: 'delete-selected', label: '删除选中', testid: 'route-more-delete-selected'},
  {id: 'delete-route', label: '删除路径', testid: 'route-more-delete-route', danger: true},
];
defineExpose({closeMore});
</script>

<template>
  <div
    class="route-editor-toolbar"
    :class="{'is-dense': dense, 'is-locked': locked}"
    data-testid="route-editor-toolbar"
    role="toolbar"
    aria-label="路径编辑工具条"
    :data-more-open="moreOpen ? '1' : '0'"
  >
    <div class="re-tb__group re-tb__tools" role="group" aria-label="画布工具">
      <button
        v-for="item in tools"
        :key="item.id"
        type="button"
        class="re-tb__btn"
        :class="{active: tool === item.id}"
        :data-testid="item.testid"
        :aria-pressed="tool === item.id"
        :aria-label="item.label"
        :title="item.title + (item.shortcut ? '（' + item.shortcut + '）' : '')"
        :disabled="locked"
        @click="pickTool(item.id)"
      >
        <component :is="item.icon" :size="16" />
        <span class="re-tb__label">{{ item.label }}</span>
      </button>
      <span class="re-tb__sep" aria-hidden="true" />
      <button
        type="button"
        class="re-tb__btn"
        :class="{active: measuring}"
        data-testid="route-measure-tool"
        :aria-pressed="measuring"
        aria-label="测距"
        title="测距：点选两个定位码测中心距（M）"
        :disabled="isDisabled('measure')"
        @click="toggleMeasure"
      >
        <Ruler :size="16" />
        <span class="re-tb__label">测距</span>
      </button>
    </div>

    <div class="re-tb__group re-tb__history" role="group" aria-label="编辑历史">
      <button
        type="button"
        class="re-tb__btn is-icon"
        data-testid="route-undo"
        aria-label="撤销"
        title="撤销（Ctrl+Z）"
        :disabled="locked || !canUndo"
        @click="run('undo')"
      >
        <Undo2 :size="16" />
        <span class="re-tb__label">撤销</span>
      </button>
      <button
        type="button"
        class="re-tb__btn is-icon"
        data-testid="route-redo"
        aria-label="重做"
        title="重做（Ctrl+Shift+Z）"
        :disabled="locked || !canRedo"
        @click="run('redo')"
      >
        <Redo2 :size="16" />
        <span class="re-tb__label">重做</span>
      </button>
      <button
        v-if="showProperties"
        type="button"
        class="re-tb__btn is-icon"
        :class="{active: propertiesActive}"
        data-testid="route-properties-toggle"
        :aria-pressed="propertiesActive"
        aria-label="属性"
        title="显示/隐藏右侧属性"
        :disabled="locked"
        @click="run('properties')"
      >
        <Settings2 :size="16" />
        <span class="re-tb__label">属性</span>
      </button>
    </div>

    <span class="re-tb__spacer" aria-hidden="true" />

    <div class="re-tb__group re-tb__actions" role="group" aria-label="路径命令">
      <details ref="more" class="re-tb__more" data-testid="route-more" @toggle="onMoreToggle">
        <summary class="re-tb__more-summary" :aria-label="moreLabel" :title="moreLabel + '：低频路径命令'">
          <MoreHorizontal :size="16" />
          <span class="re-tb__label">{{ moreLabel }}</span>
        </summary>
        <div class="re-tb__menu" role="menu" :aria-label="moreLabel + '菜单'">
          <button
            v-for="item in moreItems"
            :key="item.id"
            type="button"
            class="re-tb__menu-item"
            :class="{danger: item.danger}"
            :data-testid="item.testid"
            :disabled="isDisabled(item.id)"
            @click="run(item.id)"
          >{{ item.label }}</button>
        </div>
      </details>
      <!-- 保存/退出永远在最后且 flex:0 0 auto：换行/缩放时不会被裁掉。 -->
      <button
        type="button"
        class="re-tb__btn is-primary"
        data-testid="route-save"
        :disabled="locked || !canSave || saving"
        @click="run('save')"
      >
        <Save :size="16" />
        <span class="re-tb__label">{{ saving ? '保存中…' : saveLabel }}</span>
      </button>
      <button
        type="button"
        class="re-tb__btn"
        data-testid="route-exit"
        :disabled="locked || !canExit"
        @click="run('exit')"
      >
        <LogOut :size="16" />
        <span class="re-tb__label">{{ exitLabel }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 工具条在文档流里（不是 absolute/fixed）：永远不覆盖画布内容。 */
.route-editor-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;flex:0 0 auto;min-width:0;width:100%;max-width:100%;box-sizing:border-box;padding:5px 8px;border-bottom:1px solid var(--line,#e2e8f0);background:linear-gradient(#fff,#fbfcfd);position:relative;z-index:6}
.route-editor-toolbar.is-dense{padding:3px 6px;gap:3px 4px}
.re-tb__group{display:flex;align-items:center;gap:3px;flex-wrap:wrap;min-width:0}
.re-tb__tools,.re-tb__history{flex:0 1 auto}
.re-tb__actions{margin-left:auto;flex:0 0 auto;gap:4px}
.re-tb__spacer{flex:1 1 8px;min-width:0}
.re-tb__sep{width:1px;height:18px;background:var(--line,#e2e8f0);margin:0 2px;flex:0 0 auto}
.re-tb__btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:1px solid var(--line,#e2e8f0);border-radius:6px;background:#fff;color:#334155;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;flex:0 0 auto}
.re-tb__btn:hover:not(:disabled){background:#f1f5f9;border-color:#cbd5e1}
.re-tb__btn[aria-pressed='true'],.re-tb__btn.active{background:#dbeafe;border-color:#93c5fd;color:#1d4ed8;font-weight:600}
.re-tb__btn.is-primary{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff;font-weight:600}
.re-tb__btn.is-primary:hover:not(:disabled){background:#1d4ed8;border-color:#1d4ed8}
.re-tb__btn:disabled{opacity:.45;cursor:not-allowed}
.re-tb__label{white-space:nowrap}
.re-tb__more{position:relative;flex:0 0 auto}
.re-tb__more-summary{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:1px solid var(--line,#e2e8f0);border-radius:6px;background:#fff;color:#334155;font-size:12px;cursor:pointer;list-style:none;white-space:nowrap}
.re-tb__more-summary::-webkit-details-marker{display:none}
.re-tb__more[open]>.re-tb__more-summary{background:#eef4fb;border-color:#93c5fd;color:#1d4ed8}
.re-tb__menu{position:absolute;z-index:40;top:calc(100% + 4px);right:0;min-width:168px;padding:4px;display:flex;flex-direction:column;gap:1px;background:#fff;border:1px solid var(--line,#e2e8f0);border-radius:8px;box-shadow:0 10px 24px rgba(15,23,42,.16)}
.re-tb__menu-item{display:block;width:100%;padding:6px 10px;border:0;border-radius:5px;background:transparent;color:#1f2937;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap}
.re-tb__menu-item:hover:not(:disabled){background:#eef4fb}
.re-tb__menu-item.danger{color:#b91c1c}
.re-tb__menu-item.danger:hover:not(:disabled){background:#fef2f2}
.re-tb__menu-item:disabled{color:#a7b0bb;cursor:not-allowed}
/* 窄宽度：只留图标（aria-label 仍在），避免挤压画布或把动作组挤掉行。 */
@media(max-width:720px){
 .re-tb__label{display:none}
 .re-tb__btn,.re-tb__more-summary{padding:0 7px}
}
/* 矮窗口：压缩高度，动作组始终是最后一行/右侧，不会被裁掉。 */
@media(max-height:720px){
 .route-editor-toolbar{padding:3px 6px}
 .re-tb__btn,.re-tb__more-summary{height:26px}
}
</style>
