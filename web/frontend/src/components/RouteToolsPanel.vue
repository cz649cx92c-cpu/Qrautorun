<script lang="ts">
/**
 * 路径工具面板 —— 左侧紧凑工具区（220–260px，可折叠），**纯 chrome，不含业务状态**。
 *
 * 对应用户截图暴露的问题：
 *  1. 原来「单列大按钮」把选择/加点/平移/连线/测距/串码/生成路径/删除/撤销/重做各占一整行，
 *     必须滚动且滚动后文字被裁切 → 这里改成**分组 + 两列紧凑按钮 + 允许换行**，
 *     容器用 overflow-x:auto 而不是 overflow:hidden，长中文可换行，绝不裁字；
 *  2. 「选择」标签重复两次 → 本面板**不再出现「选择」**（选择工具只在顶部工具条）；
 *  3. 底部常驻大段说明卡挤压画布 → 说明收进默认折叠的 <details>；
 *     但**真实错误/安全约束（警示条、偏离码、锁定态）始终可见，不可折叠**；
 *  4. 左侧没有独立属性区 → 面板可整栏折叠（折叠后只剩图标轨），属性区由 App 的
 *     EditorShell #inspector 承担；
 *  5. 分组可折叠（`路径编辑` / `点位与铺码` / `路线拓扑` / `步骤`），默认只展开「路径编辑」。
 *
 * 折叠/分组偏好持久化到 localStorage 键 `qrautorun.editor.routeTools.v1`。
 * 业务内容（点位、拓扑、步骤列表）由 App 通过具名 slot 注入，本组件不 import 任何 App 状态。
 */
export type RouteToolsPanelAction =
  | 'clear'
  | 'delete-point'
  | 'delete-selected'
  | 'delete-route'
  | 'save-as'
  | 'auto-chain'
  | 'generate-route'
  | 'open-steps'
  | 'measure';
export type RouteToolsPanelTool = 'draw' | 'connect';
export interface RouteToolsNotice {
  id: string;
  level: 'info' | 'warning' | 'error';
  text: string;
  title?: string;
}
export interface RouteToolsSkippedGroup {
  id: number;
  distanceM: number;
}
</script>

<script setup lang="ts">
import {computed, ref, watch} from 'vue';
import {
  AlertTriangle, ChevronDown, ChevronRight, CopyPlus, Eraser, Info, Link2, ListOrdered, PanelLeftClose,
  PanelLeftOpen, PenLine, Route, Trash2,
} from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    /** 持久化键（固定约定，App 接线时无需修改）。 */
    storageKey?: string;
    /** 受控折叠；不传则内部自管并持久化。 */
    collapsed?: boolean;
    defaultCollapsed?: boolean;
    dense?: boolean;
    /** 路线锁：导航运行中 / 版本冲突时全部命令禁用（但仍可见，不隐藏）。 */
    locked?: boolean;
    /** 真正的只读原因（机器人运行/版本冲突/等待指令）。busy 不算只读，
     *  否则每保存一次都会闪一下黄色「只读」标。不传时退回 locked。 */
    readonly?: boolean;
    /** 当前画布工具：仅用于“加点/连线”的高亮，不重复「选择」。 */
    tool?: string;
    /** 已选路点数。 */
    anchorCount?: number;
    /** 路线长度（米）。 */
    lengthM?: number;
    /** 经过 / 跳过的定位组数量。 */
    visitedCount?: number;
    skippedCount?: number;
    /** 偏离路线的码（厘米级距离），始终可见。 */
    skippedGroups?: RouteToolsSkippedGroup[];
    /** 路径名称（v-model:route-name）。 */
    routeName?: string;
    namePlaceholder?: string;
    /** 始终可见的警示（安全约束/真实错误），不会被折叠掉。 */
    notices?: RouteToolsNotice[];
    /** 初始展开的分组 id；默认 ['route']。 */
    openGroups?: string[];
  /** 必须始终展开的分组（安全状态所在，如待确认拓扑边）；不得被折叠藏起来。 */
  requiredGroups?: string[];
    /** 可用分组；默认四组全开。 */
    groups?: string[];
    /** 当前地图短标签（名称 · vN / 未选择），显示在「地图」组标题右侧。 */
    mapLabel?: string;
    /** 宽度约束（px），默认 220–260。 */
    minWidth?: number;
    maxWidth?: number;
    /** 自定义说明文字（默认折叠）；键：draw/connect/chain/generate/spacing。 */
    hints?: Record<string, string>;
  }>(),
  {
    storageKey: 'qrautorun.editor.routeTools.v2',
    defaultCollapsed: false,
    dense: false,
    locked: false,
    readonly: undefined,
    tool: 'select',
    anchorCount: 0,
    lengthM: 0,
    visitedCount: 0,
    skippedCount: 0,
    skippedGroups: () => [],
    routeName: '',
    namePlaceholder: '保存时自动命名',
    notices: () => [],
    openGroups: () => ['route'],
  requiredGroups: () => [],
    groups: () => ['map', 'route', 'tags', 'topology'],
    mapLabel: '',
    minWidth: 220,
    maxWidth: 260,
  },
);

const emit = defineEmits<{
  (event: 'tool', id: RouteToolsPanelTool): void;
  (event: 'action', id: RouteToolsPanelAction): void;
  (event: 'update:routeName', value: string): void;
  (event: 'update:collapsed', value: boolean): void;
  (event: 'group-toggle', payload: {id: string; collapsed: boolean}): void;
}>();

/* ------------------------------------------------------------------ 持久化 */

interface StoredState {
  version?: number;
  collapsed?: boolean;
  openGroups?: string[];
  /** 必须始终展开的分组（安全状态所在，如待确认拓扑边）；不得被折叠藏起来。 */
  requiredGroups?: string[];
}
function readStored(): StoredState {
  try {
    const raw = globalThis.localStorage?.getItem(props.storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
const stored = readStored();

const internalCollapsed = ref<boolean>(stored.collapsed === true || props.defaultCollapsed === true);
const collapsed = computed<boolean>(() => (typeof props.collapsed === 'boolean' ? props.collapsed : internalCollapsed.value));
const open = ref<string[]>(
  Array.isArray(stored.openGroups) && stored.openGroups.length
    ? stored.openGroups.filter(id => props.groups.includes(id))
    : [...props.openGroups],
);

function persist(): void {
  try {
    globalThis.localStorage?.setItem(
      props.storageKey,
      JSON.stringify({version: 1, collapsed: collapsed.value, openGroups: open.value} satisfies StoredState),
    );
  } catch {
    /* 隐私模式写不进就不持久化，UI 仍可用 */
  }
}
watch([collapsed, open], persist, {deep: true});

function toggleCollapsed(): void {
  const next = !collapsed.value;
  if (typeof props.collapsed === 'boolean') emit('update:collapsed', next);
  else internalCollapsed.value = next;
  persist();
}
const isOpen = (id: string): boolean => open.value.includes(id);
/* 外部把某组标成 requiredGroups 时必须立刻展开：待确认的拓扑边是安全状态，
   藏在折叠组里等于隐藏「还没保存、不会解锁实车执行」。 */
watch(
  () => props.requiredGroups,
  ids => {
    const need = (ids ?? []).filter(id => props.groups.includes(id) && !open.value.includes(id));
    if (need.length) open.value = [...open.value, ...need];
  },
  {immediate: true, deep: true},
);
/* 父级 openGroups 变化时同步内部展开状态（外部命令需要能展开某组）。 */
watch(
  () => props.openGroups,
  ids => {
    if (!Array.isArray(ids)) return;
    const next = ids.filter(id => props.groups.includes(id));
    if (next.length && next.some(id => !open.value.includes(id))) open.value = [...new Set([...open.value, ...next])];
  },
  {deep: true},
);

function toggleGroup(id: string): void {
  if (isOpen(id)) open.value = open.value.filter(item => item !== id);
  else open.value = [...open.value, id];
  emit('group-toggle', {id, collapsed: !isOpen(id)});
}

/* ------------------------------------------------------------------ 事件 */

function emitTool(id: RouteToolsPanelTool): void {
  if (props.locked) return;
  emit('tool', id);
}
function run(id: RouteToolsPanelAction): void {
  if (props.locked) return;
  emit('action', id);
}
function onNameInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  emit('update:routeName', value);
}

const lengthText = computed(() => (Number.isFinite(props.lengthM) ? props.lengthM.toFixed(2) : '0.00'));
const noticeCount = computed(() => props.notices.length + props.skippedGroups.length);
const groupLabels: Record<string, string> = {
  map: '地图',
  route: '路径编辑',
  tags: '点位与铺码',
  topology: '路线拓扑',
  steps: '步骤',
};
const defaultHints: Record<string, string> = {
  draw: '加点：在画布空白处单击追加一个路点（自动吸附到 4cm 内的二维码中心并自动正交）。',
  connect: '连线：依次点两个定位码，生成一条有向经过；保存拓扑不会解锁实车执行。',
  chain: '串码：沿已画折线自动串起途经的定位码，偏离 10cm 以上的码会被标为跳过。',
  generate: '生成路径：按地图里已有的作物行/定位码顺序生成一条可继续拖动的路线。',
  spacing: '二维码间距：只调整哪些码作为校正目标，不会移动或修改地图上的二维码坐标。',
};
const hintText = (key: string): string => props.hints?.[key] ?? defaultHints[key] ?? '';

const noticeIcon = (level: RouteToolsNotice['level']) => (level === 'info' ? Info : AlertTriangle);
</script>

<template>
  <aside
    class="route-tools"
    :class="{'is-collapsed': collapsed, 'is-dense': dense, 'is-locked': locked}"
    data-testid="route-tools-panel"
    aria-label="路径工具与参数"
    :data-collapsed="collapsed ? '1' : '0'"
    :data-locked="locked ? '1' : '0'"
    :style="{'--route-tools-min': minWidth + 'px', '--route-tools-max': maxWidth + 'px'}"
  >
    <header class="route-tools__head">
      <button
        v-if="!collapsed"
        type="button"
        class="route-tools__collapse"
        data-testid="route-tools-collapse"
        aria-label="收起路径工具面板"
        title="收起路径工具面板（只留图标轨）"
        :aria-expanded="true"
        @click="toggleCollapsed"
      >
        <PanelLeftClose :size="15" />
      </button>
      <strong v-if="!collapsed" class="route-tools__title">路径工具</strong>
      <span v-if="!collapsed && (readonly ?? locked)" class="route-tools__lock" data-testid="route-tools-locked" role="status" title="导航运行中或地图版本冲突，路径命令暂时只读">只读</span>
      <button
        v-if="collapsed"
        type="button"
        class="route-tools__collapse is-rail"
        data-testid="route-tools-expand"
        aria-label="展开路径工具面板"
        title="展开路径工具面板"
        :aria-expanded="false"
        @click="toggleCollapsed"
      >
        <PanelLeftOpen :size="15" />
      </button>
    </header>

    <!-- 折叠后只留图标轨：常用入口仍可点，但不再挤压画布、也不再出现「选择」标签。 -->
    <div v-if="collapsed" class="route-tools__rail" role="toolbar" aria-label="路径工具快捷入口">
      <button type="button" class="route-tools__rail-btn" data-testid="route-rail-draw" aria-label="加点" title="加点" :disabled="locked" @click="emitTool('draw')"><PenLine :size="16" /></button>
      <button type="button" class="route-tools__rail-btn" data-testid="route-rail-connect" aria-label="连线" title="连线" :disabled="locked" @click="emitTool('connect')"><Link2 :size="16" /></button>
      <button type="button" class="route-tools__rail-btn" data-testid="route-rail-chain" aria-label="串码" title="串码" :disabled="locked" @click="run('auto-chain')"><Route :size="16" /></button>
      <button type="button" class="route-tools__rail-btn" data-testid="route-rail-generate" aria-label="生成路径" title="生成路径" :disabled="locked" @click="run('generate-route')"><ListOrdered :size="16" /></button>
      <button type="button" class="route-tools__rail-btn" data-testid="route-rail-clear" aria-label="清空路径" title="清空路径" :disabled="locked" @click="run('clear')"><Eraser :size="16" /></button>
    </div>

    <div v-else class="route-tools__body" data-testid="route-tools-body">
      <!-- 警示/错误/安全约束：永不被折叠，永远排在分组之前。 -->
      <div v-if="notices.length || skippedGroups.length" class="route-tools__alerts" data-testid="route-tools-alerts" :data-alert-count="noticeCount">
        <p
          v-for="notice in notices"
          :key="notice.id"
          class="route-tools__notice"
          :class="'is-' + notice.level"
          :data-testid="'route-tools-notice-' + notice.id"
          :data-level="notice.level"
          :role="notice.level === 'error' ? 'alert' : 'status'"
          :title="notice.title || notice.text"
        >
          <component :is="noticeIcon(notice.level)" :size="13" />
          <span>{{ notice.text }}</span>
        </p>
        <div v-if="skippedGroups.length" class="route-tools__skipped" data-testid="route-skipped-groups" role="status" title="偏离路线超过 10cm 的定位码，不会成为校正目标">
          <p v-for="group in skippedGroups" :key="group.id">
            Q{{ String(group.id).padStart(3, '0') }} · 偏离路线 {{ (group.distanceM * 100).toFixed(1) }} cm，未串联：建议把路线画过此码或调整铺码
          </p>
        </div>
      </div>

      <!-- 路径编辑（默认展开） -->
      <!-- 地图组：统一工作区的地图选择与新建入口，放在最前（先有地图才有点位与路径）。 -->
      <section v-if="groups.includes('map')" class="route-tools__group" data-testid="route-tools-group-map" :data-open="isOpen('map') ? '1' : '0'">
        <button type="button" class="route-tools__group-head" data-testid="route-tools-group-toggle-map" :aria-expanded="isOpen('map')" @click="toggleGroup('map')">
          <component :is="isOpen('map') ? ChevronDown : ChevronRight" :size="13" />
          <span>{{ groupLabels.map }}</span>
          <small>{{ mapLabel || '未选择' }}</small>
        </button>
        <div v-show="isOpen('map')" class="route-tools__group-body">
          <slot name="group-map"/>
        </div>
      </section>

      <section v-if="groups.includes('route')" class="route-tools__group" data-testid="route-tools-group-route" :data-open="isOpen('route') ? '1' : '0'">
        <button type="button" class="route-tools__group-head" data-testid="route-tools-group-toggle-route" :aria-expanded="isOpen('route')" @click="toggleGroup('route')">
          <component :is="isOpen('route') ? ChevronDown : ChevronRight" :size="13" />
          <span>{{ groupLabels.route }}</span>
          <small>{{ anchorCount }} 点</small>
        </button>
        <div v-show="isOpen('route')" class="route-tools__group-body">
          <div class="route-tools__tools" role="group" aria-label="路径画布工具">
            <button type="button" class="route-tools__btn" :class="{active: tool === 'draw'}" data-testid="route-panel-draw" :aria-pressed="tool === 'draw'" aria-label="加点" :disabled="locked" @click="emitTool('draw')"><PenLine :size="14" /><span>加点</span></button>
            <button type="button" class="route-tools__btn" :class="{active: tool === 'connect'}" data-testid="route-panel-connect" :aria-pressed="tool === 'connect'" aria-label="连线" :disabled="locked" @click="emitTool('connect')"><Link2 :size="14" /><span>连线</span></button>
            <button type="button" class="route-tools__btn" data-testid="auto-chain-route" aria-label="串码" title="沿路线串起途经定位码" :disabled="locked" @click="run('auto-chain')"><Route :size="14" /><span>串码</span></button>
            <button type="button" class="route-tools__btn" data-testid="generate-route-from-rows" aria-label="生成路径" title="按地图行/定位码顺序生成路径" :disabled="locked" @click="run('generate-route')"><ListOrdered :size="14" /><span>生成路径</span></button>
          </div>

          <div class="route-tools__tools is-secondary" role="group" aria-label="路径清理命令">
            <button type="button" class="route-tools__btn" data-testid="route-clear" aria-label="清空" :disabled="locked || !anchorCount" @click="run('clear')"><Eraser :size="14" /><span>清空</span></button>
            <button type="button" class="route-tools__btn" data-testid="route-delete-point" aria-label="删除路点" :disabled="locked" @click="run('delete-point')"><Trash2 :size="14" /><span>删除路点</span></button>
            <button type="button" class="route-tools__btn" data-testid="route-save-as" aria-label="另存为" :disabled="locked || anchorCount < 2" @click="run('save-as')"><CopyPlus :size="14" /><span>另存为</span></button>
          </div>



          <slot name="group-route" />
        </div>
      </section>

      <!-- 点位与铺码 -->
      <section v-if="groups.includes('tags')" class="route-tools__group" data-testid="route-tools-group-tags" :data-open="isOpen('tags') ? '1' : '0'">
        <button type="button" class="route-tools__group-head" data-testid="route-tools-group-toggle-tags" :aria-expanded="isOpen('tags')" @click="toggleGroup('tags')">
          <component :is="isOpen('tags') ? ChevronDown : ChevronRight" :size="13" />
          <span>{{ groupLabels.tags }}</span>
        </button>
        <div v-show="isOpen('tags')" class="route-tools__group-body">
          <slot name="group-tags">
            <p class="route-tools__empty">新增二维码、地图点位调整与二维码间距都在这里；未接入时显示本提示。</p>
          </slot>
        </div>
      </section>

      <!-- 路线拓扑 -->
      <section v-if="groups.includes('topology')" class="route-tools__group" data-testid="route-tools-group-topology" :data-open="isOpen('topology') ? '1' : '0'">
        <button type="button" class="route-tools__group-head" data-testid="route-tools-group-toggle-topology" :aria-expanded="isOpen('topology')" @click="toggleGroup('topology')">
          <component :is="isOpen('topology') ? ChevronDown : ChevronRight" :size="13" />
          <span>{{ groupLabels.topology }}</span>
        </button>
        <div v-show="isOpen('topology')" class="route-tools__group-body">
          <slot name="group-topology">
            <p class="route-tools__empty">选择已保存路径后，此处显示可编辑的有向码间拓扑。</p>
          </slot>
        </div>
      </section>

      <slot name="footer" />
    </div>
  </aside>
</template>

<style scoped>
/* 宽度 clamp 到 220–260px（可用 --route-tools-min/max 覆盖）；折叠后只剩 36px 图标轨。 */
.route-tools{display:flex;flex-direction:column;width:clamp(var(--route-tools-min,220px),22vw,var(--route-tools-max,260px));max-width:100%;min-width:0;box-sizing:border-box;border-right:1px solid var(--line,#e2e8f0);background:#fff}
.route-tools.is-collapsed{width:36px;min-width:36px;max-width:36px}
.route-tools.is-dense{font-size:11px}
.route-tools__head{display:flex;align-items:center;gap:5px;padding:5px 6px;border-bottom:1px solid var(--line,#e8edf2);flex:0 0 auto;min-width:0}
.route-tools__title{font-size:12px;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.route-tools__lock{margin-left:auto;padding:0 5px;border:1px solid #fde68a;border-radius:4px;background:#fffbeb;color:#b45309;font-size:10px;line-height:16px;white-space:nowrap}
.route-tools__collapse{display:inline-grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid var(--line,#e2e8f0);border-radius:5px;background:#fff;color:#64748b;cursor:pointer;flex:0 0 auto}
.route-tools__collapse:hover{background:#f1f5f9;color:#0f172a}
.route-tools__collapse.is-rail{margin:0 auto}
/* 关键：允许横向滚动 + 换行，绝不用 overflow:hidden 裁掉文字。 */
.route-tools__body{flex:1 1 auto;min-height:0;min-width:0;overflow-y:auto;overflow-x:auto;padding:4px 6px 8px;display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere;word-break:break-word}
.route-tools__alerts{display:flex;flex-direction:column;gap:3px;flex:0 0 auto}
.route-tools__notice{display:flex;align-items:flex-start;gap:5px;margin:0;padding:5px 6px;border-radius:5px;font-size:11px;line-height:1.45;overflow-wrap:anywhere}
.route-tools__notice>span{min-width:0;white-space:normal}
.route-tools__notice.is-info{border:1px solid #dbeafe;background:#f8fbff;color:#1e40af}
.route-tools__notice.is-warning{border:1px solid #fde68a;background:#fffbeb;color:#b45309}
.route-tools__notice.is-error{border:1px solid #fecaca;background:#fef2f2;color:#b91c1c}
.route-tools__skipped{padding:5px 6px;border:1px solid #fde68a;border-radius:5px;background:#fffbeb;color:#b45309;font-size:11px;line-height:1.5;max-height:96px;overflow:auto}
.route-tools__skipped p{margin:0 0 2px}
.route-tools__group{border-bottom:1px solid var(--line,#eef1f4);min-width:0;flex:0 0 auto}
.route-tools__group:last-of-type{border-bottom:0}
.route-tools__group-head{display:flex;align-items:center;gap:5px;width:100%;height:26px;padding:0 2px;border:0;background:transparent;color:#475569;font-size:11px;font-weight:600;text-align:left;cursor:pointer;min-width:0}
.route-tools__group-head:hover{color:#0f172a}
.route-tools__group-head>span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.route-tools__group-head small{color:#94a3b8;font-weight:400;white-space:nowrap}
.route-tools__group-body{display:flex;flex-direction:column;gap:5px;padding:0 0 6px;min-width:0}
.route-tools__rows{display:flex;flex-direction:column;gap:3px;min-width:0}
.route-tools__row{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0;font-size:11.5px;color:#64748b}
.route-tools__row>span:first-child{white-space:nowrap}
.route-tools__row b{font:11.5px ui-monospace,SFMono-Regular,monospace;color:#334155;text-align:right;min-width:0;overflow-wrap:anywhere}
.route-tools__badge{padding:0 6px;border:1px solid #dbeafe;border-radius:999px;background:#eff6ff;color:#1e40af;font-size:10.5px;line-height:18px;white-space:normal;text-align:right}
/* Global labels use a column layout: a 96px flex-basis on the input becomes
   vertical space, not width. Keep this field explicitly single-line and non-growing. */
.route-tools__name{flex:0 0 auto;flex-direction:column;flex-wrap:nowrap;align-items:stretch;justify-content:flex-start;gap:4px;margin:4px 0 0;width:100%;min-width:0}
.route-tools__name input{box-sizing:border-box;display:block;flex:0 0 auto;width:100%;max-width:100%;min-width:0;height:34px;min-height:34px;max-height:34px;margin:0;padding:6px 8px;border:1px solid var(--line,#e2e8f0);border-radius:5px;font-size:13px;line-height:20px;color:#0f172a;background:#fff}
.route-tools__name input:disabled{background:#f8fafc;color:#94a3b8}
.route-tools__tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;min-width:0}
.route-tools__tools.is-secondary{grid-template-columns:repeat(2,minmax(0,1fr))}
.route-tools__btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:0;height:27px;padding:0 6px;border:1px solid var(--line,#e2e8f0);border-radius:6px;background:#fff;color:#334155;font-size:11.5px;line-height:1;cursor:pointer;white-space:normal;overflow-wrap:anywhere;text-align:center}
.route-tools__btn>span{min-width:0}
.route-tools__btn:hover:not(:disabled){background:#f1f5f9;border-color:#cbd5e1}
.route-tools__btn.active,.route-tools__btn[aria-pressed='true']{background:#dbeafe;border-color:#93c5fd;color:#1d4ed8;font-weight:600}
.route-tools__btn:disabled{opacity:.45;cursor:not-allowed}
.route-tools__btn.is-wide{grid-column:1/-1}
.route-tools__hint{font-size:11px;color:#64748b;border:1px dashed var(--line,#e2e8f0);border-radius:6px;padding:3px 6px;min-width:0}
.route-tools__hint summary{cursor:pointer;color:#475569;list-style-position:inside;white-space:normal}
.route-tools__hint ul{margin:4px 0 0;padding-left:14px;display:flex;flex-direction:column;gap:3px}
.route-tools__hint li{white-space:normal;overflow-wrap:anywhere;line-height:1.5}
.route-tools__empty{margin:0;padding:4px 2px;font-size:11px;line-height:1.5;color:#94a3b8;white-space:normal}
/* 折叠后的图标轨 */
.route-tools__rail{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 0;flex:1 1 auto;min-height:0;overflow-y:auto}
.route-tools__rail-btn{display:inline-grid;place-items:center;width:26px;height:26px;padding:0;border:1px solid var(--line,#e2e8f0);border-radius:6px;background:#fff;color:#334155;cursor:pointer}
.route-tools__rail-btn:hover:not(:disabled){background:#eef4fb;color:#1d4ed8}
.route-tools__rail-btn:disabled{opacity:.4;cursor:not-allowed}
</style>
