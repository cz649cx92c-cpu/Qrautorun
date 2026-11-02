<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {
  AlignHorizontalSpaceAround,ArrowLeftRight,Boxes,ChevronDown,ChevronRight,Crosshair,Grid3x3,Hand,
  LayoutGrid,Layers,Link2,MousePointerSquareDashed,Plus,Route,Ruler,ScanLine,SquareDashedMousePointer,
  Waypoints,
} from 'lucide-vue-next';

/**
 * 左侧工具面板（drawio 形态的分组工具条）。
 *
 * 与菜单栏同样的纪律：**不持有业务状态、不调用接口**。每项只 emit `pick`
 * 带 `{id}`，由 App.vue 映射到既有函数并判断可用性。
 *
 * 分组可折叠，折叠状态写 localStorage（键 `qrautorun.editor.palette.v1`）。
 * 这里存的是纯 UI 偏好，与地图/路径数据无关，因此不会污染业务状态。
 */

export interface PaletteItem {
  id: string;
  label: string;
  icon?: string;
  /** 快捷键提示，纯展示。 */
  shortcut?: string;
}
export interface PaletteGroup {
  id: string;
  label: string;
  items: PaletteItem[];
}

const props=withDefaults(defineProps<{
  enabled?:Record<string,boolean>;
  /** 当前激活的工具 id，用于高亮。 */
  active?:string;
  storageKey?:string;
}>(),{enabled:()=>({}),active:'',storageKey:'qrautorun.editor.palette.v1'});

const emit=defineEmits<{pick:[payload:{id:string}]}>();

const groups:PaletteGroup[]=[
  {
    id:'tag',label:'二维码',
    items:[
      {id:'tag-create',label:'新建二维码',icon:'Plus'},
      {id:'tag-position',label:'地图点位调整',icon:'Crosshair'},
      {id:'tag-reprint',label:'查看 / 补打',icon:'ScanLine'},
    ],
  },
  {
    id:'array',label:'阵列与铺码',
    items:[
      {id:'array-grid',label:'批量阵列',icon:'Grid3x3'},
      {id:'array-line',label:'直线铺码',icon:'AlignHorizontalSpaceAround'},
      {id:'array-align',label:'对齐二维码',icon:'Boxes'},
    ],
  },
  {
    id:'path',label:'路径',
    items:[
      {id:'path-new',label:'新建路径',icon:'Route'},
      {id:'path-edit',label:'编辑路径',icon:'Waypoints'},
      {id:'path-topology',label:'路线拓扑',icon:'Link2'},
      {id:'path-spacing',label:'等间距',icon:'ArrowLeftRight'},
    ],
  },
  {
    id:'select',label:'选择与测量',
    items:[
      {id:'select-select',label:'选择',icon:'MousePointerSquareDashed',shortcut:'V'},
      {id:'select-box',label:'框选',icon:'SquareDashedMousePointer'},
      {id:'select-pan',label:'平移画布',icon:'Hand',shortcut:'H'},
      {id:'select-connect',label:'连线',icon:'Link2',shortcut:'L'},
      {id:'select-measure',label:'中心测距',icon:'Ruler',shortcut:'M'},
    ],
  },
  {
    id:'view',label:'视图',
    items:[
      {id:'view-fit',label:'适应窗口',icon:'LayoutGrid'},
      {id:'view-layers',label:'图层',icon:'Layers'},
    ],
  },
];

const icons:Record<string,unknown>={
  AlignHorizontalSpaceAround,ArrowLeftRight,Boxes,Crosshair,Grid3x3,Hand,LayoutGrid,Layers,Link2,
  MousePointerSquareDashed,Plus,Route,Ruler,ScanLine,SquareDashedMousePointer,Waypoints,
};

function readCollapsed():Record<string,boolean>{
  try{
    const raw=globalThis.localStorage?.getItem(props.storageKey);
    if(!raw)return {};
    const parsed=JSON.parse(raw) as {collapsed?:unknown};
    const list=Array.isArray(parsed?.collapsed)?parsed.collapsed:[];
    return Object.fromEntries(list.filter(value=>typeof value==='string').map(id=>[id,true]));
  }catch{return {};}
}
const collapsed=ref<Record<string,boolean>>(readCollapsed());
watch(collapsed,value=>{
  try{
    const list=Object.keys(value).filter(id=>value[id]);
    globalThis.localStorage?.setItem(props.storageKey,JSON.stringify({version:1,collapsed:list}));
  }catch{/* 隐私模式写不进就不持久化，UI 仍可用 */}
},{deep:true});

const isCollapsed=(id:string)=>collapsed.value[id]===true;
function toggleGroup(id:string){collapsed.value={...collapsed.value,[id]:!isCollapsed(id)};}

const isEnabled=(item:PaletteItem)=>props.enabled[item.id]!==false;
function pick(item:PaletteItem){
  if(!isEnabled(item))return;
  emit('pick',{id:item.id});
}

const total=computed(()=>groups.reduce((sum,group)=>sum+group.items.length,0));
</script>

<template>
 <div class="editor-chrome__palette" data-testid="editor-tool-palette" :data-tool-count="total" role="toolbar" aria-label="工具面板">
  <section v-for="group in groups" :key="group.id" class="editor-chrome__palette-group"
   :data-testid="'editor-palette-group-'+group.id" :data-collapsed="isCollapsed(group.id)?'1':'0'">
   <button type="button" class="editor-chrome__palette-head" :aria-expanded="!isCollapsed(group.id)"
    :data-testid="'editor-palette-toggle-'+group.id" @click="toggleGroup(group.id)">
    <component :is="isCollapsed(group.id)?ChevronRight:ChevronDown" :size="13"/>
    <span>{{group.label}}</span>
    <small>{{group.items.length}}</small>
   </button>
   <div v-show="!isCollapsed(group.id)" class="editor-chrome__palette-items">
    <button v-for="item in group.items" :key="item.id" type="button"
     class="editor-chrome__palette-item" :class="{active:active===item.id,disabled:!isEnabled(item)}"
     :disabled="!isEnabled(item)" :aria-pressed="active===item.id" :title="item.label+(item.shortcut?'（'+item.shortcut+'）':'')"
     :data-testid="'editor-palette-'+item.id" @click="pick(item)">
     <component :is="icons[item.icon??'']" v-if="item.icon&&icons[item.icon]" :size="14"/>
     <span>{{item.label}}</span>
     <kbd v-if="item.shortcut">{{item.shortcut}}</kbd>
    </button>
   </div>
  </section>
 </div>
</template>

<style scoped>
.editor-chrome__palette{display:flex;flex-direction:column;gap:2px;font-size:12px}
.editor-chrome__palette-group{border-bottom:1px solid var(--line,#e8edf2)}
.editor-chrome__palette-group:last-child{border-bottom:0}
.editor-chrome__palette-head{display:flex;align-items:center;gap:5px;width:100%;height:26px;padding:0 4px;border:0;background:transparent;color:#475569;font-size:11px;font-weight:600;letter-spacing:.02em;text-align:left;cursor:pointer}
.editor-chrome__palette-head:hover{color:#0f172a}
.editor-chrome__palette-head small{margin-left:auto;color:#94a3b8;font-weight:400}
.editor-chrome__palette-items{display:flex;flex-direction:column;gap:1px;padding:0 0 6px}
.editor-chrome__palette-item{display:flex;align-items:center;gap:7px;width:100%;height:28px;padding:0 8px;border:0;border-radius:4px;background:transparent;color:#1f2937;font-size:12px;text-align:left;cursor:pointer}
.editor-chrome__palette-item:hover:not(.disabled){background:#eef4fb}
.editor-chrome__palette-item.active{background:#dbeafe;color:#1d4ed8;font-weight:600}
.editor-chrome__palette-item.disabled{color:#a7b0bb;cursor:default}
.editor-chrome__palette-item span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.editor-chrome__palette-item kbd{color:#94a3b8;font:10px ui-monospace,monospace}
</style>
