<script setup lang="ts">
/**
 * EditorShell —— 编辑器布局外壳（只做布局，不承载任何业务）。
 *
 * 结构沿用 App.vue 里 `.editor-body` 的 flex 范式：
 *   [左栏][分隔条][画布][分隔条][右栏]
 *              └──── 底部面板 ────┘
 *
 * 拖拽分隔条使用 pointer events + setPointerCapture，写法与 App.vue 的
 * startRouteStepsDrag / startRouteStepsResize 一致（按下时记录起点，document 上监听
 * pointermove/pointerup，移动中用 clamp 保证不越界）。
 *
 * 所有尺寸/折叠状态都来自 usePanelLayout：远端只负责画 UI，不持有布局数字。
 */
import {computed, ref, useSlots, watch} from 'vue';
import {usePanelLayout, type PanelSide} from '../composables/usePanelLayout';

const props = withDefaults(
  defineProps<{
    /** 持久化键，默认 qrautorun.editor.layout.v1。 */
    storageKey?: string;
    /** 左栏 / 右栏 / 底部是否可用（业务页不提供对应 slot 时传 false）。 */
    showLeft?: boolean;
    showRight?: boolean;
    showBottom?: boolean;
    /** 拖拽时的最小步进（像素），避免 1px 抖动。 */
    dragStep?: number;
    /**
     * 左栏紧凑（dense）排版：只给 `.editor-shell__left` 加 `data-dense="1"`，
     * 并把该属性下的内边距/字号压紧。默认 false，**不改变任何既有布局数字**；
     * 路径编辑态可临时收窄全局导航/工具区的影响，由 App 决定何时打开。
     */
    leftDense?: boolean;
    /**
     * 是否接受可选 slot `#inspector`（右侧属性区）。默认 true，
     * 但只有调用方真的传了 `#inspector` 时才渲染；不传时右侧行为与原来完全一致。
     * `#inspector` 与 `#right` 共用同一列几何（宽度/拖拽/浮动/折叠），
     * 二者互斥由 App 决定传哪一个；同时传入时优先渲染 `#inspector`。
     */
    showInspector?: boolean;
    /** 调用方要求现在展开属性区（例如选中了二维码/路点）。窄屏折叠右栏时仍会显示。 */
    inspectorOpen?: boolean;
    /** 编辑器专属外壳（菜单条 / 工具 palette）只在统一工作区显示。 */
    showMenubar?: boolean;
    showPalette?: boolean;
  }>(),
  {
    storageKey: 'qrautorun.editor.layout.v1',
    showLeft: true,
    showRight: true,
    showBottom: true,
    dragStep: 1,
    leftDense: false,
    showInspector: true,
    inspectorOpen: false,
    showMenubar: true,
    showPalette: true,
  },
);

const slots = useSlots();
const emit = defineEmits<{
  (event: 'layout-change', payload: {leftWidth: number; rightWidth: number; bottomHeight: number}): void;
}>();

const api = usePanelLayout({storageKey: () => props.storageKey});
const {layout, effective, isNarrow} = api;

const hasLeft = computed(() => props.showLeft && (!!slots.left || !!slots.palette));
/** 顶部菜单条整行：只在调用方真的传了 #menubar 时才占位，否则高度行为与原来一致。 */
const hasMenubar = computed(() => props.showMenubar && !!slots.menubar);
const hasRight = computed(() => props.showRight && !!slots.right);
/**
 * 可选右侧属性区：只有调用方真的传了 #inspector 才渲染，且**不受 showRight 约束**
 * （路径编辑态常把 showRight=false，但属性区仍可能要用）。不传时 hasInspector=false，
 * 下面所有右侧几何/渲染分支都与改动前逐字一致。
 */
const hasInspector = computed(() => props.showInspector && !!slots.inspector);
const hasRightColumn = computed(() => hasInspector.value || hasRight.value);
/**
 * 属性区「有内容」：调用方通过 #inspector 里自身的 v-if 决定是否渲染内容。
 * 这里用 showInspector + 传入的 inspectorActive prop 表示「现在确实要看属性」，
 * 从而在窄屏右栏默认折叠的情况下仍然渲染并显示属性栏。
 */
const inspectorActive = computed(() => props.showInspector && !!slots.inspector && props.inspectorOpen === true);
const hasBottom = computed(() => props.showBottom && !!slots.bottom);

// 折叠只影响渲染，宽度仍保留在 layout 里，展开时回到原值。
const leftCollapsed = computed(() => !hasLeft.value || effective.value.leftCollapsed);
const rightCollapsed = computed(() => !hasRightColumn.value || effective.value.rightCollapsed);
const bottomCollapsed = computed(() => !hasBottom.value || effective.value.bottomCollapsed);
const rightFloating = computed(() => hasRightColumn.value && effective.value.rightFloating && !rightCollapsed.value);

const leftStyle = computed(() => ({width: effective.value.leftWidth + 'px', flexBasis: effective.value.leftWidth + 'px'}));
const rightStyle = computed(() => ({width: effective.value.rightWidth + 'px', flexBasis: effective.value.rightWidth + 'px'}));
const bottomStyle = computed(() => ({height: effective.value.bottomHeight + 'px', flexBasis: effective.value.bottomHeight + 'px'}));

type DragKind = 'left' | 'right' | 'bottom';
interface DragState {
  kind: DragKind;
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}
let drag: DragState | null = null;
const dragging = ref<DragKind | null>(null);

function snapshot(): {leftWidth: number; rightWidth: number; bottomHeight: number} {
  const current = effective.value;
  return {leftWidth: current.leftWidth, rightWidth: current.rightWidth, bottomHeight: current.bottomHeight};
}

function startDrag(kind: DragKind, event: PointerEvent): void {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  const current = effective.value;
  drag = {
    kind,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: kind === 'right' ? current.rightWidth : current.leftWidth,
    startHeight: current.bottomHeight,
  };
  dragging.value = kind;
  try {
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
  } catch {
    // 某些浏览器/触摸场景不支持捕获，退回 document 监听即可。
  }
  document.addEventListener('pointermove', moveDrag, true);
  document.addEventListener('pointerup', endDrag, true);
  document.addEventListener('pointercancel', endDrag, true);
}

function moveDrag(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const step = Math.max(1, props.dragStep);
  const dxRaw = event.clientX - drag.startX;
  const dyRaw = event.clientY - drag.startY;
  const dx = Math.round(dxRaw / step) * step;
  const dy = Math.round(dyRaw / step) * step;
  if (drag.kind === 'left') {
    // 左栏往右拖 = 变宽。
    api.setLeftWidth(drag.startWidth + dx);
  } else if (drag.kind === 'right') {
    // 右栏在右侧，往左拖 = 变宽。
    api.setRightWidth(drag.startWidth - dx);
  } else {
    // 底部面板往上拖 = 变高。
    api.setBottomHeight(drag.startHeight - dy);
  }
}

function endDrag(): void {
  document.removeEventListener('pointermove', moveDrag, true);
  document.removeEventListener('pointerup', endDrag, true);
  document.removeEventListener('pointercancel', endDrag, true);
  if (drag) {
    // 只在拖动结束后写一次存储，避免 pointermove 期间的高频写盘。
    api.persist();
    drag = null;
  }
  dragging.value = null;
  emit('layout-change', snapshot());
}

function toggleSide(side: PanelSide): void {
  if (side === 'left') {
    if (!hasLeft.value) return;
    api.toggleSide('left');
  } else {
    if (!hasRightColumn.value) return;
    api.toggleSide('right');
  }
  api.persist();
  emit('layout-change', snapshot());
}

function toggleBottomPanel(): void {
  if (!hasBottom.value) return;
  api.toggleBottom();
  api.persist();
  emit('layout-change', snapshot());
}

function toggleRightFloating(): void {
  api.setRightFloating(!layout.value.rightFloating);
  api.persist();
  emit('layout-change', snapshot());
}

function resetLayout(): void {
  api.resetLayout();
  emit('layout-change', snapshot());
}

/**
 * 分隔条的无指针替代操作：聚焦后按方向键 / Home / End 调宽度。
 * 键盘步进固定 16px（不跟随 dragStep），这样一次按键就是一次可感知的位移。
 */
const KEYBOARD_RESIZE_STEP = 16;

function onSplitterKey(kind: DragKind, event: KeyboardEvent): void {
  const key = event.key;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
  event.preventDefault();
  const step = event.shiftKey ? KEYBOARD_RESIZE_STEP * 4 : KEYBOARD_RESIZE_STEP;
  if (kind === 'left') {
    if (key === 'ArrowLeft') api.setLeftWidth(effective.value.leftWidth - step);
    else if (key === 'ArrowRight') api.setLeftWidth(effective.value.leftWidth + step);
  } else if (kind === 'right') {
    if (key === 'ArrowLeft') api.setRightWidth(effective.value.rightWidth + step);
    else if (key === 'ArrowRight') api.setRightWidth(effective.value.rightWidth - step);
  } else {
    if (key === 'ArrowUp') api.setBottomHeight(effective.value.bottomHeight + step);
    else if (key === 'ArrowDown') api.setBottomHeight(effective.value.bottomHeight - step);
  }
  api.persist();
  emit('layout-change', snapshot());
}

// 折叠按钮改变的是响应式布局，窗口变宽/变窄时让外壳自己记住最新状态即可。
watch(effective, () => emit('layout-change', snapshot()));

defineExpose({api, toggleSide, toggleBottomPanel, toggleRightFloating, resetLayout});
</script>

<template>
  <div
    class="editor-shell"
    :class="{
      'is-left-collapsed': leftCollapsed,
      'is-right-collapsed': rightCollapsed,
      'is-bottom-collapsed': bottomCollapsed,
      'is-right-floating': rightFloating,
      'is-narrow': isNarrow,
      'is-dragging': dragging !== null,
    }"
    data-testid="editor-shell"
  >
    <div v-if="hasMenubar" class="editor-shell__menubar" data-testid="editor-shell-menubar">
      <slot name="menubar" />
    </div>
    <!-- 列容器：菜单条是整行，其余仍是 [左][画布][右] 的一行。
         不传 #menubar 时这里只是把原来的同级节点包了一层，flex 结果完全一致。 -->
    <div class="editor-shell__row" data-testid="editor-shell-row">
    <aside v-if="hasLeft" v-show="!leftCollapsed" class="editor-shell__left" :style="leftStyle" :data-dense="leftDense ? '1' : undefined" data-testid="editor-shell-left">
      <div v-if="slots.palette && showPalette" class="editor-shell__palette" data-testid="editor-shell-palette">
        <slot name="palette" />
      </div>
      <slot name="left" />
    </aside>
    <div
      v-if="hasLeft && !leftCollapsed"
      class="editor-shell__splitter is-left"
      :class="{'is-active': dragging === 'left'}"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整左栏宽度"
      :tabindex="0"
      data-testid="editor-shell-splitter-left"
      @pointerdown.prevent="startDrag('left', $event)"
      @keydown="onSplitterKey('left', $event)"
    >
      <button
        type="button"
        class="editor-shell__collapse is-left"
        aria-label="收起左栏"
        title="收起左栏"
        data-testid="editor-shell-collapse-left"
        @pointerdown.stop
        @click.stop="toggleSide('left')"
      >
        ‹
      </button>
    </div>
    <button
      v-if="hasLeft && leftCollapsed"
      type="button"
      class="editor-shell__collapse is-floating is-left"
      aria-label="展开左栏"
      title="展开左栏"
      data-testid="editor-shell-expand-left"
      @click.stop="toggleSide('left')"
    >
      ›
    </button>

    <div class="editor-shell__main">
      <div class="editor-shell__canvas" data-testid="editor-shell-canvas">
        <slot name="canvas" />
      </div>
    <div
      class="editor-shell__splitter is-bottom"
      v-if="hasBottom"
      :class="{'is-active': dragging === 'bottom', 'is-collapsed': bottomCollapsed}"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="bottomCollapsed ? '展开底部面板' : '调整底部面板高度'"
      :tabindex="bottomCollapsed ? -1 : 0"
      data-testid="editor-shell-splitter-bottom"
      @pointerdown.prevent="bottomCollapsed ? undefined : startDrag('bottom', $event)"
      @keydown="onSplitterKey('bottom', $event)"
    >
        <button
          type="button"
          class="editor-shell__collapse is-bottom"
          :aria-label="bottomCollapsed ? '展开底部面板' : '收起底部面板'"
          :title="bottomCollapsed ? '展开底部面板' : '收起底部面板'"
          data-testid="editor-shell-collapse-bottom"
          @pointerdown.stop
          @click.stop="toggleBottomPanel"
        >
          {{ bottomCollapsed ? '▴' : '▾' }}
        </button>
      </div>
      <section v-if="hasBottom && !bottomCollapsed" class="editor-shell__bottom" :style="bottomStyle" data-testid="editor-shell-bottom">
        <slot name="bottom" />
      </section>
    </div>

    <div
      v-if="hasRightColumn && !rightCollapsed && !rightFloating"
      class="editor-shell__splitter is-right"
      :class="{'is-active': dragging === 'right'}"
      role="separator"
      aria-orientation="vertical"
      :aria-label="hasInspector ? '调整属性栏宽度' : '调整右栏宽度'"
      :tabindex="0"
      :data-testid="hasInspector ? 'editor-shell-splitter-inspector' : 'editor-shell-splitter-right'"
      @pointerdown.prevent="startDrag('right', $event)"
      @keydown="onSplitterKey('right', $event)"
    >
      <button
        type="button"
        class="editor-shell__collapse is-right"
        :aria-label="hasInspector ? '收起属性栏' : '收起右栏'"
        :title="hasInspector ? '收起属性栏' : '收起右栏'"
        :data-testid="hasInspector ? 'editor-shell-collapse-inspector' : 'editor-shell-collapse-right'"
        @pointerdown.stop
        @click.stop="toggleSide('right')"
      >
        ›
      </button>
    </div>
    <aside
      v-if="hasRightColumn && (!rightCollapsed || inspectorActive)"
      v-show="!rightCollapsed || inspectorActive"
      class="editor-shell__right"
      :class="{'is-floating': rightFloating, 'is-inspector': hasInspector}"
      :style="rightStyle"
      :data-testid="hasInspector ? 'editor-shell-inspector' : 'editor-shell-right'"
    >
      <div class="editor-shell__right-tools">
        <button
          type="button"
          class="editor-shell__mini"
          :aria-pressed="rightFloating"
          :title="rightFloating ? '停靠右栏' : '右栏浮动'"
          data-testid="editor-shell-float-right"
          @click.stop="toggleRightFloating"
        >
          {{ rightFloating ? '停靠' : '浮动' }}
        </button>
        <button type="button" class="editor-shell__mini" title="恢复默认布局" data-testid="editor-shell-reset" @click.stop="resetLayout">复位</button>
        <button
          type="button"
          class="editor-shell__mini"
          aria-label="收起右栏"
          title="收起右栏"
          data-testid="editor-shell-collapse-right-inline"
          @click.stop="toggleSide('right')"
        >
          »
        </button>
      </div>
      <div class="editor-shell__right-body" :data-testid="hasInspector ? 'editor-shell-inspector-body' : undefined">
        <slot v-if="hasInspector" name="inspector" />
        <slot v-else name="right" />
      </div>
    </aside>
    <button
      v-if="hasRightColumn && rightCollapsed"
      type="button"
      class="editor-shell__collapse is-floating is-right"
      :aria-label="hasInspector ? '展开属性栏' : '展开右栏'"
      :title="hasInspector ? '展开属性栏' : '展开右栏'"
      :data-testid="hasInspector ? 'editor-shell-expand-inspector' : 'editor-shell-expand-right'"
      @click.stop="toggleSide('right')"
    >
      ‹
    </button>
    </div>
  </div>
</template>

<style scoped>
.editor-shell{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0;position:relative;align-items:stretch}
.editor-shell__row{display:flex;flex:1 1 auto;min-height:0;min-width:0;align-items:stretch;position:relative}
.editor-shell.is-dragging{user-select:none;cursor:col-resize}
.editor-shell__left,.editor-shell__right{min-width:0;min-height:0;overflow-y:auto;display:flex;flex-direction:column;flex-grow:0;flex-shrink:0}
.editor-shell__right.is-floating{position:absolute;z-index:30;right:12px;top:12px;bottom:12px;max-height:none;border-radius:10px;box-shadow:0 10px 28px rgba(15,23,42,.18);background:white;overflow:hidden}
.editor-shell__right-tools{display:flex;align-items:center;gap:4px;justify-content:flex-end;padding:4px 6px;flex:0 0 auto}
.editor-shell__mini{border:1px solid var(--line,#e2e8f0);background:#fff;color:#475569;border-radius:6px;font-size:11px;line-height:1.6;padding:1px 7px;cursor:pointer}
.editor-shell__mini:hover{background:#f1f5f9}
.editor-shell__mini[aria-pressed='true']{border-color:var(--accent,#2563eb);color:var(--accent,#2563eb);background:#eff6ff}
.editor-shell__right-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column}
.editor-shell__main{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}
/* 菜单条整行：横跨外壳全宽，位于所有列之上。不传 #menubar 时该节点不存在，
   因此既有布局高度与 flex 分配完全不变（i1 回归验证这一点）。 */
.editor-shell__menubar{flex:0 0 auto;min-width:0;position:relative;z-index:30}
/* 左栏内的工具面板：固定不滚动区，业务面板在它下面继续滚动。 */
.editor-shell__palette{flex:0 0 auto;padding:2px 2px 4px;border-bottom:1px solid var(--line,#e8edf2);margin-bottom:4px}
/* 可选 dense 左栏：只在调用方传 leftDense 时生效（属性选择器），默认排版一字不变。
   目的：路径编辑态下允许把全局导航/工具区临时收窄压紧，把宽度让给画布。
   注意这里用 :deep() 作用于调用方 slot 进来的内容（业务卡片），不会影响默认布局。 */
.editor-shell__left[data-dense='1']{padding-right:0}
.editor-shell__left[data-dense='1'] :deep(.route-tool-card){padding:6px 8px;margin-bottom:5px}
.editor-shell__left[data-dense='1'] :deep(.panel-title){font-size:12px;line-height:1.4}
.editor-shell__left[data-dense='1'] :deep(.route-tools){border-right:0}
.editor-shell__left[data-dense='1'] :deep(.route-tools__body){padding:3px 5px 6px}
/* 可选 #inspector：复用右栏几何，只多一个语义 class 方便业务侧选中。 */
.editor-shell__right.is-inspector{border-left:1px solid var(--line,#e8edf2);background:#fff}
.editor-shell__canvas{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.editor-shell__bottom{flex:0 0 auto;min-height:0;overflow:auto;display:flex;flex-direction:column}
.editor-shell__splitter{position:relative;flex:0 0 6px;width:6px;background:transparent;cursor:col-resize;touch-action:none;align-self:stretch}
.editor-shell__splitter::after{content:'';position:absolute;inset:0 2px;border-radius:2px;background:transparent;transition:background .12s}
.editor-shell__splitter:hover::after,.editor-shell__splitter.is-active::after{background:var(--accent,#2563eb)}
.editor-shell__splitter.is-bottom{width:auto;height:6px;flex-basis:6px;cursor:row-resize;align-self:auto}
.editor-shell__splitter.is-bottom::after{inset:2px 0}
.editor-shell__splitter.is-collapsed{cursor:default}
.editor-shell__splitter.is-left{order:-1}
.editor-shell__collapse{position:absolute;z-index:2;display:grid;place-items:center;width:14px;height:26px;padding:0;border:1px solid var(--line,#e2e8f0);border-radius:6px;background:white;color:#64748b;font-size:11px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s}
.editor-shell__splitter:hover .editor-shell__collapse,.editor-shell__splitter.is-active .editor-shell__collapse{opacity:1}
/* 收起手柄贴在分隔条顶端/左端，而不是正中：分隔条正中的 26px 必须是纯拖拽区，
   否则「抓住中间拖宽度」会点在看不见的手柄上，表现为分隔条拖不动。 */
.editor-shell__collapse.is-left{left:-4px;top:6px}
.editor-shell__collapse.is-right{right:-4px;top:6px}
.editor-shell__collapse.is-bottom{left:6px;bottom:-4px;width:26px;height:14px;opacity:1}
.editor-shell__collapse.is-floating{position:absolute;top:12px;width:16px;height:38px;opacity:1;z-index:31}
.editor-shell__collapse.is-floating.is-left{left:0;border-radius:0 6px 6px 0}
.editor-shell__collapse.is-floating.is-right{right:0;border-radius:6px 0 0 6px}
@media(max-width:760px){
 /* 窄屏保持既有的「单行 flex」几何：这是这些窄屏回归用例一直依赖的布局，
    纵向堆叠会让整页高度随面板内容变化，交互过程中元素位置漂移（点不准）。
    新增的 chrome 在窄屏只做减法：菜单条压缩、分组工具面板隐藏。 */
 .editor-shell{flex-direction:column}
 .editor-shell__row{flex-direction:column;overflow:visible}
 .editor-shell__splitter{display:none}
 .editor-shell__left,.editor-shell__right{width:100%!important;flex-basis:auto!important}
 .editor-shell__right.is-floating{position:static;box-shadow:none}
 /* 窄屏（≤760px，手机宽度）隐藏菜单条与分组工具面板。
     理由：两者都是桌面式常驻 chrome，纵向堆叠后会占掉首屏并挤压画布；
     drawio 在手机宽度同样隐藏菜单栏。功能不丢——同一批命令仍由既有的
     画布工具栏与左侧面板提供，宽屏下菜单条/工具面板照常显示。 */
 .editor-shell__menubar{display:none}
 .editor-shell__palette{display:none}
 /* 折叠态的「展开」手柄默认是 position:absolute（贴着视口右上角）。
     窄屏内容变高后它会浮在画布工具栏上方，把真实按钮挡住。
     窄屏改成普通流内元素并排到最后：仍然可点，但绝不覆盖内容。 */
 .editor-shell__collapse.is-floating{position:static;width:100%;height:24px;border-radius:6px;margin:2px 0;order:9}
 .editor-shell__collapse.is-floating.is-left{left:auto}
 .editor-shell__collapse.is-floating.is-right{right:auto}
}
</style>
