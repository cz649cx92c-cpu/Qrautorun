<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref} from 'vue';
import {
  Download,FileDown,FilePlus2,FolderOpen,HelpCircle,Image,Keyboard,LayoutTemplate,Maximize2,Minus,
  PanelBottom,PanelLeft,PanelRight,Redo2,RotateCcw,Ruler,Save,ScanLine,Settings2,Sparkles,SquareDashedMousePointer,
  Trash2,Undo2,ZoomIn,ZoomOut,
} from 'lucide-vue-next';

/**
 * 顶部菜单栏（drawio 形态：文件 / 编辑 / 视图 / 布局 / 帮助）。
 *
 * 本组件**不持有任何业务状态**，也不直接调用接口：每个菜单项只 emit
 * `command`，由 App.vue 决定它对应哪个既有函数、当前是否可用。这样菜单不会
 * 变成第二套业务入口——真正的行为仍只有一份。
 *
 * `enabled` prop 是「当前环境下哪些命令可用」的布尔表：不可用的项仍然显示
 * （用户要能看到能力存在），但置灰且 aria-disabled，点了不 emit。
 */

export interface MenuCommand {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  /** 分隔线标记：只画一条线，不参与点击。 */
  separator?: boolean;
  /** 需要二次确认的危险操作（如删除路径）画成红色。 */
  danger?: boolean;
}

export interface MenuGroup {
  id: string;
  label: string;
  items: MenuCommand[];
}

const props=withDefaults(defineProps<{
  /** 命令可用性：缺省视为可用。 */
  enabled?:Record<string,boolean>;
  /** 当前是否为路径编辑态（决定「保存/退出路径」这类项的显示）。 */
  routeEditing?:boolean;
  /** 当前地图/路径名称，显示在菜单右侧。 */
  contextLabel?:string;
}>(),{enabled:()=>({}),routeEditing:false,contextLabel:''});

const emit=defineEmits<{command:[payload:{id:string}]}>();

const openMenu=ref('');

const groups=computed<MenuGroup[]>(()=>{
  const routeItems:MenuCommand[]=props.routeEditing
    ?[
      {id:'route-save',label:'保存路径',icon:'Save',shortcut:'Ctrl+S'},
      {id:'route-undo',label:'撤销',icon:'Undo2',shortcut:'Ctrl+Z'},
      {id:'route-redo',label:'重做',icon:'Redo2',shortcut:'Ctrl+Shift+Z'},
      {id:'route-step-delete',label:'删除选中步骤',icon:'Trash2',shortcut:'Delete'},
      {separator:true,id:'sep-route-1',label:''},
      {id:'route-exit',label:'退出路径编辑',icon:'X'},
    ]
    :[
      {id:'route-new',label:'新建路径',icon:'FilePlus2'},
      {id:'route-edit',label:'编辑已保存路径',icon:'PenLine'},
    ];
  return [
    {
      id:'file',label:'文件',
      items:[
        {id:'file-new-map',label:'新建空白地图',icon:'FilePlus2'},
        {id:'file-open-map',label:'打开地图…',icon:'FolderOpen'},
        {separator:true,id:'sep-file-1',label:''},
        ...routeItems,
        {separator:true,id:'sep-file-2',label:''},
        {id:'file-print',label:'打印定位板',icon:'Image'},
        {id:'file-export-pdf',label:'导出 PDF',icon:'FileDown'},
      ],
    },
    {
      id:'edit',label:'编辑',
      items:[
        {id:'edit-undo',label:'撤销',icon:'Undo2',shortcut:'Ctrl+Z'},
        {id:'edit-redo',label:'重做',icon:'Redo2',shortcut:'Ctrl+Shift+Z'},
        {separator:true,id:'sep-edit-1',label:''},
        {id:'edit-select-all',label:'全选二维码',icon:'SquareDashedMousePointer',shortcut:'Ctrl+A'},
        {id:'edit-box-select',label:'框选',icon:'SquareDashedMousePointer'},
        {id:'edit-connect',label:'连线（连两个码）',icon:'Link2'},
        {separator:true,id:'sep-edit-2',label:''},
        {id:'edit-measure',label:'中心测距',icon:'Ruler',shortcut:'M'},
      ],
    },
    {
      id:'view',label:'视图',
      items:[
        {id:'view-zoom-in',label:'放大',icon:'ZoomIn'},
        {id:'view-zoom-out',label:'缩小',icon:'ZoomOut'},
        {id:'view-zoom-fit',label:'适应窗口',icon:'Maximize2'},
        {separator:true,id:'sep-view-1',label:''},
        {id:'view-tag-reprint',label:'查看二维码 / 补打',icon:'ScanLine'},
        {id:'view-tag-position',label:'地图点位调整',icon:'Settings2'},
      ],
    },
    {
      id:'layout',label:'布局',
      items:[
        {id:'layout-toggle-left',label:'收起 / 展开左栏',icon:'PanelLeft'},
        {id:'layout-toggle-right',label:'收起 / 展开右栏',icon:'PanelRight'},
        {id:'layout-toggle-bottom',label:'收起 / 展开底部步骤',icon:'PanelBottom'},
        {id:'layout-toggle-float',label:'右栏浮动 / 停靠',icon:'LayoutTemplate'},
        {separator:true,id:'sep-layout-1',label:''},
        {id:'layout-reset',label:'恢复默认布局',icon:'RotateCcw'},
      ],
    },
    {
      id:'help',label:'帮助',
      items:[
        {id:'help-shortcuts',label:'快捷键一览',icon:'Keyboard'},
        {id:'help-guide',label:'使用指引',icon:'HelpCircle'},
        {id:'help-about',label:'关于版本',icon:'Sparkles'},
      ],
    },
  ];
});

const isEnabled=(item:MenuCommand)=>item.separator?false:props.enabled[item.id]!==false;

function toggle(id:string){
  openMenu.value=openMenu.value===id?'':id;
}
function close(){openMenu.value='';}
function pick(item:MenuCommand){
  if(!isEnabled(item))return;
  close();
  emit('command',{id:item.id});
}
function onKeydown(event:KeyboardEvent){
  if(event.key==='Escape'&&openMenu.value){
    event.preventDefault();
    // 标记本次 Esc 已被菜单消费：全局快捷键的 onEscape 看到标记就不再退出编辑工作区。
    (window as unknown as {__dshMenuEscConsumed?:number}).__dshMenuEscConsumed=Date.now();
    close();
  }
}
function onPointerDown(event:PointerEvent){
  const target=event.target as HTMLElement|null;
  if(!target?.closest('.editor-chrome__menubar'))close();
}

onMounted(()=>{
  document.addEventListener('pointerdown',onPointerDown,true);
  document.addEventListener('keydown',onKeydown,true);
});
onBeforeUnmount(()=>{
  document.removeEventListener('pointerdown',onPointerDown,true);
  document.removeEventListener('keydown',onKeydown,true);
});

const icons:Record<string,unknown>={
  Download,FileDown,FilePlus2,FolderOpen,HelpCircle,Image,Keyboard,LayoutTemplate,Maximize2,Minus,
  PanelBottom,PanelLeft,PanelRight,Redo2,RotateCcw,Ruler,Save,ScanLine,Settings2,Sparkles,
  SquareDashedMousePointer,Trash2,Undo2,ZoomIn,ZoomOut,
};
</script>

<template>
 <div class="editor-chrome__menubar" data-testid="editor-menubar" role="menubar" aria-label="编辑器菜单">
  <div class="editor-chrome__brand" aria-hidden="true"><span class="editor-chrome__brand-mark">QR</span><span class="editor-chrome__brand-text">地图与路径编辑器</span></div>
  <div class="editor-chrome__menus">
   <div v-for="group in groups" :key="group.id" class="editor-chrome__menu">
    <button type="button" class="editor-chrome__menu-btn" :class="{active:openMenu===group.id}"
     role="menuitem" :aria-expanded="openMenu===group.id" :aria-haspopup="true"
     :data-testid="'editor-menu-'+group.id" @click.stop="toggle(group.id)">{{group.label}}</button>
    <div v-if="openMenu===group.id" class="editor-chrome__dropdown" role="menu" :data-testid="'editor-menu-panel-'+group.id">
     <template v-for="item in group.items" :key="item.id">
      <div v-if="item.separator" class="editor-chrome__menu-sep" role="separator"/>
      <button v-else type="button" class="editor-chrome__menu-item" :class="{danger:item.danger,disabled:!isEnabled(item)}"
       role="menuitem" :aria-disabled="!isEnabled(item)" :disabled="!isEnabled(item)"
       :data-testid="'editor-command-'+item.id" @click.stop="pick(item)">
       <component :is="icons[item.icon??'']" v-if="item.icon&&icons[item.icon]" :size="14"/>
       <span class="editor-chrome__menu-label">{{item.label}}</span>
       <kbd v-if="item.shortcut" class="editor-chrome__kbd">{{item.shortcut}}</kbd>
      </button>
     </template>
    </div>
   </div>
  </div>
  <span v-if="contextLabel" class="editor-chrome__context" data-testid="editor-menubar-context" :title="contextLabel">{{contextLabel}}</span>
 </div>
</template>

<style scoped>
.editor-chrome__menubar{display:flex;align-items:center;gap:10px;min-height:34px;padding:0 10px;border-bottom:1px solid var(--line,#e2e8f0);background:#fbfcfd;font-size:12px;user-select:none}
.editor-chrome__brand{display:inline-flex;align-items:center;gap:6px;padding-right:10px;margin-right:2px;border-right:1px solid var(--line,#e2e8f0)}
.editor-chrome__brand-mark{display:grid;place-items:center;width:20px;height:20px;border-radius:4px;background:#1f2937;color:#fff;font-size:10px;font-weight:700;letter-spacing:.02em}
.editor-chrome__brand-text{color:#475569;font-weight:600;white-space:nowrap}
.editor-chrome__menus{display:flex;align-items:center;gap:1px}
.editor-chrome__menu{position:relative}
.editor-chrome__menu-btn{height:26px;padding:0 9px;border:0;border-radius:4px;background:transparent;color:#334155;font-size:12px;cursor:pointer}
.editor-chrome__menu-btn:hover{background:#eef2f6}
.editor-chrome__menu-btn.active{background:#e2e8f0;color:#0f172a}
.editor-chrome__dropdown{position:absolute;z-index:60;top:calc(100% + 3px);left:0;min-width:236px;padding:4px;border:1px solid #d8dee6;border-radius:6px;background:#fff;box-shadow:0 12px 28px rgba(15,23,42,.16)}
.editor-chrome__menu-item{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;border:0;border-radius:4px;background:transparent;color:#1f2937;font-size:12px;text-align:left;cursor:pointer}
.editor-chrome__menu-item:hover:not(.disabled){background:#eef4fb}
.editor-chrome__menu-item.disabled{color:#a7b0bb;cursor:default}
.editor-chrome__menu-item.danger{color:#b91c1c}
.editor-chrome__menu-label{flex:1;white-space:nowrap}
.editor-chrome__kbd{color:#94a3b8;font:11px ui-monospace,monospace;white-space:nowrap}
.editor-chrome__menu-sep{height:1px;margin:4px 6px;background:#e8edf2}
.editor-chrome__context{margin-left:auto;color:#64748b;font-size:11px;max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
