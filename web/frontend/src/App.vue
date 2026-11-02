<script setup lang="ts">
import ExecutionErrors from './components/ExecutionErrors.vue';
import CalibrationWorkspace from './components/CalibrationWorkspace.vue';
import {computed,nextTick,onMounted,onBeforeUnmount,ref,watch} from 'vue';
import {ScanLine,Navigation,Play,Pause,Square,CheckCircle2,AlertTriangle,Radio,Settings2,FileText,Camera,Ruler,ArrowRight,Route,Layers,Hand,PenLine,Trash2,Crosshair,Link2,Move,RotateCcw,PanelLeft,PanelRight,PanelBottom, ChevronUp} from 'lucide-vue-next';
import Button from './components/ui/Button.vue';
import MapCanvas from './components/MapCanvas.vue';
import PdfGenerator from './components/PdfGenerator.vue';
import TagInspector from './components/TagInspector.vue';
import SegmentStrategyEditor from './components/SegmentStrategyEditor.vue';
import OrthogonalCorrectionPanel from './components/OrthogonalCorrectionPanel.vue';
import MapSpacingPicker from './components/MapSpacingPicker.vue';
import MapTagPositionPanel from './components/MapTagPositionPanel.vue';
import MapTagCreatePanel from './components/MapTagCreatePanel.vue';
import MapTagTablePanel from './components/MapTagTablePanel.vue';
import EditorShell from './components/EditorShell.vue';
import EditorMenuBar from './components/EditorMenuBar.vue';
import EditorToolPalette from './components/EditorToolPalette.vue';
import RouteEditorToolbar from './components/RouteEditorToolbar.vue';
import RouteToolsPanel from './components/RouteToolsPanel.vue';
import {useEditorSession} from './composables/useEditorSession';
import {useShortcuts,nudgeDeltaFromKey,type ShortcutTool} from './composables/useShortcuts';
import {MODE_SPECS,canEnterMode,modeDragPans,resolveLegacyMode,type EditorMode} from '../../shared/editor-modes';
import {aliasMap,resolveTagLabel,checkTagAliasName,TAG_ALIAS_DISCLAIMER,type TagAlias} from '../../shared/tag-naming';
import RouteGeometryPanel from './components/RouteGeometryPanel.vue';
import RouteTopologyPanel from './components/RouteTopologyPanel.vue';
import MapDeleteConfirm from './components/MapDeleteConfirm.vue';
import {planStrategies,choicesFromSegments,segmentExecutionBlockers,strategyOptions,type SegmentChoice,type SegmentPlan,type StrategyMode} from '../../shared/segment-strategy';
import ScanRecords from './components/ScanRecords.vue';
import CameraPreview from './components/CameraPreview.vue';
import type {FieldMap,Point} from '../../shared/model';
import {distance,exitPoint,orderedTagsById} from '../../shared/model';
import {orthogonalRoute,routeCorners,snapRoutePoint,chainRouteGroups,routeGroupCenters,distanceToRoute,ROUTE_GRID,type SkippedRouteGroup} from '../../shared/route-design';
import {previewLegDistance,MIN_LEG_DISTANCE_M,MAX_LEG_DISTANCE_M} from '../../shared/route-leg-distance';
import {taskSchema,type Task} from '../../shared/task';
import type {Board} from '../../shared/boards';
import type {SurveySummary} from '../../shared/survey';
import type {Route as RouteEntity} from '../../shared/route';
type ConsolePage='scan'|'navigate'|'print'|'calibration';
const initialPage=new URLSearchParams(location.search).get('page');
const page=ref<ConsolePage>(initialPage==='calibration'?'calibration':'scan'),busy=ref(false),error=ref(''),message=ref(''),connected=ref(false);
const commandFeedback=ref<{id:string,state:'waiting'|'confirmed'|'rejected'|'unconfirmed',text:string}|null>(null);
let navigationAbort:AbortController|undefined;
// 自用版：不再让用户填写扫描名称，开始时按时间自动生成一个可读默认名。
function autoSurveyName(){const d=new Date(),p=(n:number)=>String(n).padStart(2,'0');return `扫描-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;}
const name=ref(''),settings=ref({tagSizeMm:80,rowWidth:.6,exitDistance:.8}),session=ref<any>(null),sessions=ref<SurveySummary[]>([]);
const field=ref<FieldMap|null>(null),version=ref(0),tasks=ref<Task[]>([]),routes=ref<RouteEntity[]>([]),selectedTask=ref(''),selectedMapId=ref(''),selectedRouteId=ref(''),routeNameDraft=ref(''),anchors=ref('[]');
const routeEditId=ref(''),routeEditUpdated=ref('');
const maps=ref<{id:string;name:string;version:number;created:string}[]>([]),showCaptureTrail=ref(false);
const routeDetailsOpen=ref(false);
// ---- 编辑器外壳布局（drawio 式）：尺寸/折叠/浮动由 EditorShell + usePanelLayout 持有，
// App 只保留最近一次的布局快照，用来在尺寸变化后让画布重新适配。
// EditorShell 的 defineExpose 表面：布局按钮必须走这些方法，因为它们内部会
// persist() 并 emit('layout-change')；直接改 api 内存值不会落盘。
interface EditorShellHandle{
 api?:{toggleSide:(side:'left'|'right')=>void;toggleBottom:()=>void;resetLayout:()=>void;setRightFloating:(value:boolean)=>void;setBottomHeight?:(value:number)=>void;setLeftWidth?:(value:number)=>void;setRightWidth?:(value:number)=>void;layout:{value:Record<string,unknown>}};
 toggleSide:(side:'left'|'right')=>void;
 toggleBottomPanel:()=>void;
 toggleRightFloating:()=>void;
 resetLayout:()=>void;
}
const editorShell=ref<EditorShellHandle|null>(null);
const editorLayout=ref<{leftWidth:number;rightWidth:number;bottomHeight:number}|null>(null);
const editorLayoutRevision=ref(0);

// ===== 二维码现场别名（只影响显示）=====
// 真实 tag36h11 编号永远是身份；别名只用于画布/表格/步骤里的人读标签。
const tagAliases=ref<TagAlias[]>([]);
const tagAliasByTagId=computed(()=>aliasMap(tagAliases.value));
const tagAliasError=ref('');
const tagAliasNotice=ref('');
async function loadTagAliases(mapId:string){
 if(!mapId){tagAliases.value=[];return;}
 try{
  const result=await api('/maps/'+encodeURIComponent(mapId)+'/tag-aliases');
  tagAliases.value=Array.isArray(result.aliases)?result.aliases:[];
  tagAliasError.value='';
 }catch(reason){
  tagAliases.value=[];
  tagAliasError.value=reason instanceof Error?reason.message:String(reason);
 }
}
async function onSaveTagAliases(next:{tagId:number;name:string}[]){
 await saveTagAliases(next.map(item=>({...item,updated:new Date().toISOString()})));
}
async function saveTagAliases(next:TagAlias[]){
 const map=field.value;if(!map)return false;
 tagAliasError.value='';tagAliasNotice.value='';
 try{
  const result=await api('/maps/'+encodeURIComponent(map.id)+'/tag-aliases',{aliases:next.map(alias=>({tagId:alias.tagId,name:alias.name}))});
  tagAliases.value=Array.isArray(result.aliases)?result.aliases:[];
  tagAliasNotice.value='已保存 '+tagAliases.value.length+' 个现场名称';
  return true;
 }catch(reason){
  tagAliasError.value=reason instanceof Error?reason.message:String(reason);
  return false;
 }
}
// 统一标签：有别名 → `名称 (Q012)`，无别名 → 与旧标签完全一致。
function tagLabel(tag:{id:number;groupId?:string|undefined}){
 return resolveTagLabel({id:tag.id,...(tag.groupId===undefined?{}:{groupId:tag.groupId})},tagAliasByTagId.value);
}

// ===== 编辑器会话：模式 / 选中 / 撤销重做的唯一入口 =====
// 历史三个真实缺陷都来自「模式判断散落各处」，现在所有判断只走 MODE_SPECS。
interface RouteSnapshot{anchors:Point[];modes:SegmentChoice[];selected:number;skipped:SkippedRouteGroup[]}
const editorSession=useEditorSession<RouteSnapshot>({initialMode:'select'});
// 从旧的散落布尔量推导当前模式；它是 computed，所以永远与真实状态一致。
const editorMode=computed<EditorMode>(()=>resolveLegacyMode({
 editingRoute:editingRoute.value,
 routeTool:routeTool.value,
 measuring:measuring.value,
 tagPositionEditing:tagPositionEditing.value,
 tagCreateEditing:tagCreateEditing.value,
 spacingActive:tagPositionEditing.value&&spacingSelectedIds.value.length>=2,
}));
const editorModeSpec=computed(()=>MODE_SPECS[editorMode.value]);
const editorModeLabel=computed(()=>editorModeSpec.value?.label??'选择');
// 画布是否允许左键拖动平移：唯一答案，MapCanvas 不再自己判断。
const canvasPansOnDrag=computed(()=>modeDragPans(editorMode.value));
// 最近一次模式切换被拒绝的原因（UI 要能看见，不能静默忽略）。
const editorModeNotice=ref('');
function setEditorMode(next:EditorMode):boolean{
 const current=editorMode.value;
 if(current===next){editorModeNotice.value='';return true;}
 const verdict=canEnterMode(current,next);
 if(!verdict.ok){editorModeNotice.value=verdict.reason??'当前状态不允许切换工具';return false;}
 editorModeNotice.value='';
 // 先把模式写进旧布尔量，再让会话记录；顺序反了会让 computed 的 editorMode 落后一帧。
 applyEditorMode(next);
 editorSession.setMode(next);
 return true;
}
// 把模式写回既有的布尔量，保持旧代码路径与模板绑定不变（单一真相 + 兼容层）。
function applyEditorMode(mode:EditorMode){
 switch(mode){
  case 'pan': if(editingRoute.value)routeTool.value='pan'; measuring.value=false; break;
  case 'draw': if(editingRoute.value)routeTool.value='draw'; measuring.value=false; break;
  case 'connect': if(editingRoute.value)routeTool.value='connect'; measuring.value=false; break;
  case 'measure': if(editingRoute.value)routeTool.value='select'; measuring.value=!!map.value&&map.value.tags.length>=2; break;
  case 'select': case 'boxSelect': if(editingRoute.value)routeTool.value='select'; measuring.value=false; break;
  default: break;
 }
}
function setRouteTool(tool:'select'|'draw'|'pan'|'connect'){
 const next:EditorMode=tool==='pan'?'pan':tool==='draw'?'draw':tool==='connect'?'connect':'select';
 const current=editorMode.value;
 if(current===next){routeTool.value=tool;editorModeNotice.value='';return;}
 // 先判定再写：editorMode 是从 routeTool 推导出来的，如果在写之前判定，
 // canEnterMode 看到的还是旧工具，互斥判断就永远拿不到正确的「当前模式」。
 const verdict=canEnterMode(current,next);
 if(!verdict.ok){editorModeNotice.value=verdict.reason??'当前状态不允许切换工具';return;}
 editorModeNotice.value='';
 routeTool.value=tool;
 measuring.value=false;
 // 切到平移（或任何非选择工具）时清掉路点选中：平移只动视口，不该继续「指着」某个路点，
 // 否则右侧属性与路径步骤高亮会指向一个用户并没有在操作的对象。
 if(tool!=='select')routeSelected.value=-1;
 editorSession.setMode(next);
}
function onLayoutChange(payload:{leftWidth:number;rightWidth:number;bottomHeight:number}){
 editorLayout.value={...payload};
 // 画布容器尺寸变了，Konva 需要重新 fit；用递增 revision 触发而不重建 stage。
 editorLayoutRevision.value+=1;
}
// 布局改动一律走 EditorShell 暴露的方法：只有它会同时 persist + emit layout-change。
// 直接调 api.setXxx 会改到内存却不落盘，刷新后布局就丢了。
function toggleEditorSide(side:'left'|'right'){editorShell.value?.toggleSide(side);}
function toggleEditorBottom(){editorShell.value?.toggleBottomPanel();}
function toggleEditorFloat(){editorShell.value?.toggleRightFloating();}
function resetEditorLayout(){editorShell.value?.resetLayout();}
// ===== 菜单栏与工具面板：唯一职责是把 id 映射到既有函数 =====
// 这里刻意不实现任何新行为：每一项都指向已经存在并被测试覆盖的函数，
// 所以菜单/工具条不会变成第二套业务入口，也不会绕过任何安全门。
const canUseMapTools=computed(()=>!!field.value&&!busy.value&&!robot.value.running);
const menuEnabled=computed<Record<string,boolean>>(()=>({
 'file-new-map':canUseMapTools.value,
 'file-open-map':!busy.value,
 'route-new':!!field.value&&!routeLocked.value,
 'route-edit':!!field.value&&!routeLocked.value&&(!!selectedRouteId.value||!!field.value.rows.length),
 'route-save':editingRoute.value&&!routeLocked.value&&routeDrawing.value.length>=2,
 'route-undo':editingRoute.value&&!routeLocked.value&&canUndoEdit.value,
 'route-redo':editingRoute.value&&!routeLocked.value&&canRedoEdit.value,
 'route-step-delete':editingRoute.value&&!routeLocked.value&&routeSelected.value>=0,
 'route-exit':editingRoute.value,
 'edit-undo':editingRoute.value&&!routeLocked.value&&canUndoEdit.value,
 'edit-redo':editingRoute.value&&!routeLocked.value&&canRedoEdit.value,
 'edit-select-all':!!field.value?.tags.length,
 'edit-box-select':editingRoute.value&&!routeLocked.value,
 'edit-connect':editingRoute.value&&!routeLocked.value,
 'edit-measure':!!field.value&&field.value.tags.length>=2&&!editingRoute.value,
 'view-zoom-in':!!canvasMap.value,
 'view-zoom-out':!!canvasMap.value,
 'view-zoom-fit':!!canvasMap.value,
 'view-tag-reprint':!!field.value?.tags.length,
 'view-tag-position':field.value?.routeMode==='map-only'&&canUseMapTools.value,
 'layout-toggle-left':true,
 'layout-toggle-right':!editingRoute.value,
 'layout-toggle-bottom':editingRoute.value,
 'layout-toggle-float':!editingRoute.value,
 'layout-reset':true,
 'file-print':!busy.value,
 'file-export-pdf':!busy.value,
 'help-shortcuts':true,'help-guide':true,'help-about':true,
}));
const paletteEnabled=computed<Record<string,boolean>>(()=>({
 'tag-create':field.value?.routeMode==='map-only'&&canUseMapTools.value,
 'tag-position':field.value?.routeMode==='map-only'&&canUseMapTools.value,
 'tag-reprint':!!field.value?.tags.length,
 'array-grid':field.value?.routeMode==='map-only'&&canUseMapTools.value,
 'array-line':field.value?.routeMode==='map-only'&&canUseMapTools.value,
 'array-align':field.value?.routeMode==='map-only'&&canUseMapTools.value,
 'path-new':!!field.value&&!routeLocked.value,
 'path-edit':!!field.value&&!routeLocked.value&&(!!selectedRouteId.value||!!field.value.rows.length),
 'path-topology':editingRoute.value&&!!routeEditId.value,
 'path-spacing':field.value?.routeMode==='map-only'&&canUseMapTools.value,
 'select-select':editingRoute.value&&!routeLocked.value,
 'select-box':editingRoute.value&&!routeLocked.value,
 'select-pan':editingRoute.value&&!routeLocked.value,
 'select-connect':editingRoute.value&&!routeLocked.value,
 'select-measure':!!field.value&&field.value.tags.length>=2,
 'view-fit':!!canvasMap.value,
 'view-layers':!!canvasMap.value,
}));
const paletteActive=computed(()=>{
 if(measuring.value)return 'select-measure';
 if(!editingRoute.value)return '';
 if(routeTool.value==='pan')return 'select-pan';
 return 'select-select';
});
function focusRouteToolCard(testId:string){
 // 面板在左栏里：先保证左栏展开，再滚到对应卡片，避免用户点完「什么都没发生」。
 if(editorShell.value?.api?.layout?.value?.leftCollapsed)editorShell.value.toggleSide('left');
 void nextTick(()=>{
  const card=document.querySelector('[data-testid="'+testId+'"]') as HTMLElement|null;
  card?.scrollIntoView({block:'nearest',behavior:'smooth'});
 });
}
/**
 * 全选二维码。选中集合是**派生**的（mapSelected 由 inspectedTagId /
 * spacingSelectedIds / measurementIds 算出），所以全选必须写进当前真正生效的那个
 * 来源，而不是另造一条选中状态——否则画布高亮与后续批量操作会各看一套。
 */
function selectAllTags(){
 if(!field.value)return;
 const ids=orderedTagsById(field.value.tags).map(tag=>tag.id);
 if(tagPositionEditing.value||tagTableEditing.value){
  spacingSelectedIds.value=ids;
  inspectedTagId.value=ids[0]??null;
  return;
 }
 inspectedTagId.value=ids[0]??null;
 message.value='已选中 '+ids.length+' 个二维码：可在「地图点位调整」里批量编辑，或直接拖动';
}
/**
 * 画布框选结果：命中集合直接写进当前真正生效的选中来源。
 * 与「全选」同一条纪律——不另造选中状态，画布高亮和批量操作必须看同一份数据。
 */
const canvasBoxCount=ref(0);
function onCanvasBoxSelect(ids:number[]){
 canvasBoxCount.value=ids.length;
 if(!editingRoute.value||routeLocked.value)return;
 if(tagPositionEditing.value||tagTableEditing.value){
  spacingSelectedIds.value=ids;
  inspectedTagId.value=ids[0]??null;
 }else{
  routeSelected.value=ids.length?routeAnchors.value.findIndex(point=>{
   const groupId=nearestGroupId(point);
   return groupId!==null&&ids.includes(groupId);
  }):-1;
  inspectedTagId.value=ids[0]??null;
 }
 message.value=ids.length?`框选 ${ids.length} 个二维码`:'框选未命中任何二维码';
}
/**
 * 画布连线结果：只是一条「有向经过」的声明，绝不代表可执行。
 * 这里把它交给路线拓扑面板的同一套纯函数逻辑（由用户在拓扑面板确认并保存），
 * 而不是自己另写一条写入路径。
 */
function onCanvasConnect(payload:{fromId:number;toId:number}){
 if(!editingRoute.value||routeLocked.value)return;
 pendingConnect.value=payload;
 message.value=`已连线 Q${payload.fromId} → Q${payload.toId}：请在「路线拓扑」里确认并保存（保存拓扑不会解锁实车执行）`;
 focusRouteToolCard('route-topology-panel');
}
function onCanvasLinkRejected(payload:{code:string;message:string}){
 error.value=payload.message;
}
function openTagCreate(){if(field.value?.routeMode!=='map-only')return;focusRouteToolCard('map-tag-create');}
function openTagTable(){if(field.value?.routeMode!=='map-only')return;focusRouteToolCard('map-tag-table-panel');}
function onEditorCommand(payload:{id:string}){
 const id=payload?.id;
 if(!id)return;
 switch(id){
  case 'file-new-map': void createBlankMapNow(); break;
  case 'file-open-map': page.value='navigate'; break;
  case 'route-new': beginNewRoute(); break;
  case 'route-edit': beginRoute(); break;
  case 'route-save': if(editingRoute.value) void saveRoute(false); break;
  case 'route-undo': case 'edit-undo': if(editingRoute.value)undoEdit(); break;
  case 'route-redo': case 'edit-redo': if(editingRoute.value)redoEdit(); break;
  case 'route-step-delete': if(editingRoute.value)deleteStep(routeSelected.value); break;
  case 'route-exit': requestExitRoute(); break;
  case 'edit-select-all': if(field.value)selectAllTags(); break;
  case 'edit-box-select': case 'edit-connect': if(editingRoute.value)setRouteTool('select'); break;
  case 'edit-measure': toggleMeasurement(); break;
  case 'view-tag-reprint': openTagInspector(); break;
  case 'view-tag-position': if(field.value?.routeMode==='map-only')focusRouteToolCard('route-tag-position-card'); break;
  case 'layout-toggle-left': toggleEditorSide('left'); break;
  case 'layout-toggle-right': toggleEditorSide('right'); break;
  case 'layout-toggle-bottom': toggleEditorBottom(); break;
  case 'layout-toggle-float': toggleEditorFloat(); break;
  case 'layout-reset': resetEditorLayout(); break;
  case 'file-print': case 'file-export-pdf': editingRoute.value=false;page.value='print'; break;
  case 'help-shortcuts': message.value='快捷键：V 选择 · H 平移 · L 连线 · M 测距 · Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · Delete 删除 · Esc 取消'; break;
  case 'help-guide': message.value='流程：先建或扫地图 → 铺码并核对中心与朝向 → 路径编辑并保存 → 选任务后启动导航'; break;
  case 'help-about': message.value='二维码地图与路径编辑器 · 拓扑只描述码与码之间的有向经过关系，保存拓扑不会解锁实车执行'; break;
  default: break;
 }
}
function onEditorPalettePick(payload:{id:string}){
 const id=payload?.id;
 if(!id)return;
 switch(id){
  case 'tag-create': openTagCreate(); break;
  case 'tag-position': if(field.value?.routeMode==='map-only')focusRouteToolCard('route-tag-position-card'); break;
  case 'tag-reprint': openTagInspector(); break;
  case 'array-grid': case 'array-line': case 'array-align': openTagCreate(); break;
  case 'path-new': beginNewRoute(); break;
  case 'path-edit': beginRoute(); break;
  case 'path-topology': focusRouteToolCard('route-topology-panel'); break;
  case 'path-spacing': openTagTable(); break;
  case 'select-select': case 'select-box': case 'select-connect': setRouteTool('select'); break;
  case 'select-pan': setRouteTool('pan'); break;
  case 'select-measure': toggleMeasurement(); break;
  default: break;
 }
}
const editorContextLabel=computed(()=>{
 const mapName=field.value?.name??'未选择地图';
 return editingRoute.value?`${mapName} · 路径编辑${routeNameDraft.value?' · '+routeNameDraft.value:''}`:`${mapName} · v${version.value}`;
});
const orthogonalPreviewMap=ref<FieldMap|null>(null);
// Only one map-maintenance draft may own the canvas at a time: the orthogonal
// correction preview and the QR position draft are mutually exclusive views of
// the same immutable base version.
const mapDraftSource=ref<'orthogonal'|'tag-position'|'tag-create'|'tag-table'|null>(null);
const tagPositionEditing=ref(false);
const tagCreatePanel=ref<{ghostTags:{x:number;y:number;id?:number}[]}|null>(null);
const tagCreateGhost=ref<{x:number;y:number;id?:number}[]>([]);
const tagCreateEditing=ref(false);
// 点位表格与「调整二维码位置」「铺码」是三种互斥的地图草稿来源，各自持有编辑态。
const tagTableEditing=ref(false);
const tagPositionPanel=ref<{selectTag:(id:number|null)=>void;moveTags:(ids:number[],dx:number,dy:number)=>void;reset:()=>void}|null>(null);
const tagTablePanel=ref<{moveTags:(ids:number[],dx:number,dy:number)=>void}|null>(null);
// A pending orthogonal-correction preview is a read-only view of a candidate map:
// path drawing, path saving and navigation must stay blocked until it is applied or discarded.
const orthogonalPreviewActive=computed(()=>orthogonalPreviewMap.value!==null);
const mapApproval=ref<{kind:string|null,accepted:boolean,digestValid:boolean}|null>(null);
function selectMap(result:any){field.value=result.map;version.value=result.version;mapApproval.value=result.acceptance??null;}
function setOrthogonalPreview(value:FieldMap|null){orthogonalPreviewMap.value=value;mapDraftSource.value=value?'orthogonal':null;}
function setTagPositionPreview(value:FieldMap|null){orthogonalPreviewMap.value=value;if(value)mapDraftSource.value='tag-position';else if(mapDraftSource.value==='tag-position')mapDraftSource.value=null;}
// 图内直接改间距：画布上每条相邻段都画出 cm 标注，点标注就地输入，
// 回车直接保存为新地图版本。侧栏不再承担输入职责。
const spacingCanvasGaps=computed<{fromId:number;toId:number;m:number}[]>(()=>{
 if(!tagPositionEditing.value||!field.value)return [];
 // 用画布上正在渲染的地图（预览优先），这样输入目标间距时标注立即变成新值。
 const tags=(canvasMap.value??field.value).tags;
 const byId=new Map(tags.map(tag=>[tag.id,tag]));
 const picked=spacingSelectedIds.value.filter(id=>byId.has(id));
 if(picked.length<2)return [];
 // 同一直线：按主轴排序，保证相邻段顺序稳定
 const xs=picked.map(id=>byId.get(id)!.x),ys=picked.map(id=>byId.get(id)!.y);
 const horizontal=(Math.max(...xs)-Math.min(...xs))>=(Math.max(...ys)-Math.min(...ys));
 const ordered=[...picked].sort((a,b)=>{
  const A=byId.get(a)!,B=byId.get(b)!;
  return horizontal?A.x-B.x:A.y-B.y;
 });
 const gaps:{fromId:number;toId:number;m:number}[]=[];
 for(let i=1;i<ordered.length;i++){
  const a=byId.get(ordered[i-1]!),b=byId.get(ordered[i]!);
  if(a&&b)gaps.push({fromId:a.id,toId:b.id,m:Math.hypot(b.x-a.x,b.y-a.y)});
 }
 return gaps;
});
interface GapEditState{fromId:number;toId:number;m:number;left:number;top:number;value:string;busy:boolean;error:string}
const gapEdit=ref<GapEditState|null>(null);
function onGapEdit(payload:{fromId:number;toId:number;m:number;x:number;y:number}){
 if(!field.value||robot.value.running)return;
 gapEdit.value={fromId:payload.fromId,toId:payload.toId,m:payload.m,left:payload.x,top:payload.y,value:(payload.m*100).toFixed(1),busy:false,error:''};
 void nextTick(()=>{const input=document.querySelector('[data-testid="gap-inline-input"]') as HTMLInputElement|null;input?.focus();input?.select();});
}
function cancelGapEdit(){gapEdit.value=null;}
async function commitGapEdit(){
 const state=gapEdit.value;
 if(!state||!field.value||state.busy)return;
 const cm=Number(state.value);
 if(!Number.isFinite(cm)||cm<8){state.error='至少 8 厘米';return;}
 // 只按输入精度换算，绝不取整到整厘米：填 55.4 却被存成 55 就是输入被悄悄改写。
 const targetM=Number((cm/100).toFixed(4));
 // 比较用 1 毫米级容差。0.5 cm 容差会把 55.4→55 这类真实改动当成“没改”
 // 直接关掉编辑器，用户看到的就是“点了没反应”。
 if(Math.abs(targetM-state.m)<0.001){gapEdit.value=null;message.value=`这段间距已经是 ${(state.m*100).toFixed(1)} cm，无需改动`;return;}
 state.busy=true;state.error='';
 try{
  const response=await fetch(`/api/maps/${encodeURIComponent(field.value.id)}/tag-distance`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseVersion:version.value,fromId:state.fromId,toId:state.toId,targetM})});
  const result=await response.json();
  if(!response.ok)throw Object.assign(new Error(result.error??'保存失败'),{status:response.status});
  gapEdit.value=null;
  selectMap(result);await refresh();
  // 回读服务端真正落库的间距，而不是复述输入值：两者不一致时现场必须立刻看见。
  const achieved=typeof result.afterM==='number'?result.afterM:targetM;
  const delta=Math.abs(achieved-targetM);
  message.value=delta>0.001
   ? `间距已保存为 ${(achieved*100).toFixed(1)} cm（你填的是 ${cm.toFixed(1)} cm，相差 ${(delta*100).toFixed(1)} cm）· 地图版本 v${result.version}`
   : `已把间距改为 ${(achieved*100).toFixed(1)} cm · 地图版本 v${result.version}；旧路线与旧任务仍绑定旧版本`;
 }catch(reason){
  const status=Number((reason as {status?:number}).status);
  state.error=status===409?'地图已更新，请重新加载后再改':(reason instanceof Error?reason.message:String(reason));
  state.busy=false;
 }
}
// 几何面板的预览只在它真的有一份草稿时才算「编辑」。
// 面板在 points 变化时会重新 seed 自己的基线并 emit 一次预览；
// 如果无条件写回，这个回显会把刚加的路点顶掉（DOM 显示新值、状态已回退）。
// 这里用「点数不能少于当前」作为最小护栏：预览只能增/改，不能悄悄删点。
function onRouteGeometryPreview(points:Point[]|null){
 if(!points)return;
 const next=points.map(point=>({x:point.x,y:point.y}));
 if(next.length<routeAnchors.value.length)return;
 routeAnchors.value=next;
}
async function onRouteGeometryApplied(result:any){
 await refresh();
 selectedRouteId.value=result.route?.routeId??selectedRouteId.value;
 routeEditUpdated.value=result.route?.updated??routeEditUpdated.value;
 message.value='路径几何已更新'+(result.version?` · 地图 v${result.version}`:'');
}
// 拓扑保存后：折线可能被后端按拓扑重写，所以这里直接采纳返回值里的 points/segments，
// 不走 onRouteGeometryPreview 那条「只允许变长」的守卫（那条守卫是给本地预览用的）。
async function onRouteTopologyApplied(result:any){
 await refresh();
 selectedRouteId.value=result.route?.routeId??selectedRouteId.value;
 routeEditUpdated.value=result.route?.updated??routeEditUpdated.value;
 if(Array.isArray(result.points)&&result.points.length>=2){
  routeAnchors.value=result.points.map((point:Point)=>({...point}));
  routeModes.value=result.segments?choicesFromSegments(result.segments):routeModes.value;
 }
 message.value='路线拓扑已保存'+(result.route?' · 折线已按拓扑重写':' · 折线未改动');
}
function onTagCreatePreview(map:FieldMap|null){
 // 铺码预览：画布换成"即将保存"的候选地图，新点交给 ghost 层高亮
 if(map){orthogonalPreviewMap.value=map;mapDraftSource.value='tag-create';}
 else if(mapDraftSource.value==='tag-create'){orthogonalPreviewMap.value=null;mapDraftSource.value=null;}
 tagCreateGhost.value=tagCreatePanel.value?.ghostTags??[];
}
/**
 * 关闭路点/二维码属性面板。
 * 仅把 routeInspectorOpen 置 false 不够：路径编辑态有一条
 * `.app-shell.is-route-editing .editor-shell.is-right-collapsed > .editor-shell__right{display:flex}`
 * 规则会强制右栏显示，于是「关闭」「收起」都看起来没反应。
 * 这里显式收起右栏，保证「关闭 = 面板消失 + 画布拿回宽度」。
 */
function closeRouteInspector(){
 routeInspectorUserClosed.value=true;
 // 必须「确定收起」而不是 toggle：toggle 在已收起时反而会展开，
 // 用户点「关闭」却看到面板弹回来。
 const shell:any=editorShell.value;
 const api=shell?.api;
 if(api?.layout?.value){
  if(!api.layout.value.rightCollapsed)shell.toggleSide('right');
 }else if(shell?.toggleSide){
  shell.toggleSide('right');
 }
}
function onTagCreateGhostMove(index:number,point:Point){
 const panel:any=tagCreatePanel.value;
 if(!panel||typeof panel.moveGhost!=='function')return;
 panel.moveGhost(index,{x:point.x,y:point.y});
 // 表单变了 → 预览地图随之重算，ghost 也要跟着更新（否则画布还停在旧位置）
 nextTick(()=>{tagCreateGhost.value=tagCreatePanel.value?.ghostTags??[];});
}
function onTagCreateEditing(active:boolean){
 tagCreateEditing.value=active;
 if(!active){tagCreateGhost.value=[];if(mapDraftSource.value==='tag-create'){orthogonalPreviewMap.value=null;mapDraftSource.value=null;}}
}
async function onTagCreateApplied(result:any){
 tagCreateEditing.value=false;tagCreateGhost.value=[];mapDraftSource.value=null;orthogonalPreviewMap.value=null;
 selectMap(result);await refresh();
 message.value=`已新建 ${result.created??result.tags?.length??0} 个二维码 · 地图版本 v${result.version}`;
}
function onTagTableEditing(active:boolean){
 tagTableEditing.value=active;
 if(active){orthogonalPreviewMap.value=null;mapDraftSource.value='tag-table';}
 else if(mapDraftSource.value==='tag-table'){orthogonalPreviewMap.value=null;mapDraftSource.value=null;}
}
// 点位表格有自己的草稿来源：绝不能复用 setTagPositionPreview，否则一改表格就把
// mapDraftSource 改写成 'tag-position'，退出表格时清不掉、画布也一直锁着。
function setTagTablePreview(value:FieldMap|null){
 orthogonalPreviewMap.value=value;
 if(value)mapDraftSource.value='tag-table';
 else if(mapDraftSource.value==='tag-table')mapDraftSource.value=null;
}
function onTagPositionEditing(active:boolean){tagPositionEditing.value=active;if(!active)spacingSelectedIds.value=[];if(active){orthogonalPreviewMap.value=null;mapDraftSource.value='tag-position';}else if(mapDraftSource.value==='tag-position'){orthogonalPreviewMap.value=null;mapDraftSource.value=null;}}
async function onTagPositionApplied(result:any){
 // 保存后保持间距模式与选区：现场要连着改多组，并要立刻在画布上看到新间距。
 // 只把基准地图替换成新版本，不能让用户重新点一遍。
 mapDraftSource.value=null;orthogonalPreviewMap.value=null;
 selectMap(result);
 selectedRouteId.value='';selectedTask.value='';
 await refresh();
 // 必须再取一次最新地图：接口回包的 map 是保存时构建的候选，
 // 而 refresh() 不会刷新 field，所以这里不重新 GET 就会继续显示旧坐标。
 try{
  const fresh=await api('/maps/'+encodeURIComponent((result.map??field.value).id));
  selectMap(fresh);
  if(mapDraftSource.value===null){
   if(tagPositionEditing.value)mapDraftSource.value='tag-position';
   else if(tagTableEditing.value)mapDraftSource.value='tag-table';
  }
 }catch{}
 message.value='已保存地图二维码位置 · 地图版本 v'+result.version+'；旧路线与旧任务仍绑定旧版本';
}
async function onOrthogonalApplied(result:any){selectMap(result);orthogonalPreviewMap.value=null;mapDraftSource.value=null;selectedRouteId.value='';selectedTask.value='';await refresh();message.value='正交校正已保存 · 地图版本 v'+result.version+'；旧路线保持原版本';}
const boards=ref<Board[]>([]);
type DetectorInference={id:number;board:Board|null;memberCount:number;message:string;registered:boolean};
const detectorInference=computed<DetectorInference|null>(()=>{
 const idsRaw=robot.value.detector?.ids;
 const ids=(Array.isArray(idsRaw)?idsRaw:[]).map((id:unknown)=>Number(id)).filter((id:number)=>Number.isInteger(id));
 if(ids.length!==1)return null;
 const id=ids[0]!;
 const board=boards.value.find((candidate:Board)=>candidate.members.some(member=>member.id===id))??null;
 return {id,board,memberCount:board?.members.length??0,registered:!!board,message:board?`已识别 ${label(id)} · 定位组 ${board.id} · 已推断 ${board.members.length} 个码位`:`已识别 ${label(id)} · 未登记定位组，无法推断完整板`};
});

const scanView=ref<'map'|'camera'>('map');
const robot=ref<any>({connected:false,state:'OFFLINE',running:false,paused:false,pose:null,chassis:{connected:false},conditions:[],sensors:{},events:[]});
const faultReason=computed(()=>{
 if(robot.value.state!=='FAULT')return '';
 const events:string[]=(robot.value.events??[]).filter((event:unknown):event is string=>typeof event==='string'&&!!event.trim());
 // Events are newest first; the reason is logged after the FAULT transition.
 const transition=events.findIndex(event=>/(?:^|[\s·])FAULT\s*$/.test(event));
 const current=transition<0?events:events.slice(0,transition);
 return current.find(event=>!/^(?:\d{2}:\d{2}:\d{2}\s+)?(?:.*·\s*)?[A-Z][A-Z0-9_]*$/.test(event.trim()))??'尚未收到具体故障原因';
});
// 组中心坐标只读展示扫描结果，不再提供手工实测输入。

let socket:WebSocket|undefined,poll:ReturnType<typeof setInterval>|undefined,posePoll:ReturnType<typeof setInterval>|undefined,reconnect:ReturnType<typeof setTimeout>|undefined,closed=false,polling=false;
const poseClock=ref(performance.now()),robotReceivedClock=ref(performance.now());
let sessionEpoch=0;
const previewStatus=ref<any>(null),previewError=ref('');
const bridgeOnline=computed(()=>connected.value&&robot.value.connected);
const previewLabel=computed(()=>previewError.value||(!previewStatus.value?'正在查询预览服务':previewStatus.value.error?'预览异常：'+previewStatus.value.error:previewStatus.value.running?'在线（预览画面）':previewStatus.value.starting?'预览连接中':previewStatus.value.present?'预览未开启':'未发现预览相机'));
const detectorLabel=computed(()=>!bridgeOnline.value?'ROS桥离线 / 识别状态未知':robot.value.detector?.connected?deviceStatus('camera',robot.value.sensors?.camera??'识别服务在线'):robot.value.detector?.reason||'未收到定位识别服务心跳');
function recoveryReason(reason:string){const recovering=/需重启|需轮式横移标定并重新初始化/.test(reason);const text=reason.replace(/，需重启融合/g,'').replace(/，需轮式横移标定并重新初始化/g,'（横移尚未标定）').replace(/融合不可用 \/ 需重启/g,'定位中断 / 等待自动恢复，请保持静止');return recovering&&!text.includes('等待自动恢复')?text+'；等待自动恢复，请保持车辆静止':text;}
const scanWaitReasons=computed(()=>{
 if(!bridgeOnline.value)return ['ROS桥离线，等待连接恢复'];
 const reasons:string[]=[];
 if(!robot.value.detector?.connected)reasons.push(robot.value.detector?.reason||'定位识别服务离线，等待服务恢复');
 else if(!robot.value.detector.positionReady)reasons.push(robot.value.detector.reason||'尚未识别到可定位的定位组，请检查定位板可见性和相机标定');
 const imu=String(robot.value.sensors?.imu??'');if(imu&&!imu.startsWith('在线'))reasons.push(imu);
 if(!robot.value.mapping?.ready){const cause=recoveryReason(robot.value.mapping?.reason||robot.value.sensors?.localization||'等待采集位姿');reasons.push(cause.includes('等待自动恢复')||!cause.includes('定位中断')?cause:cause+'；等待自动恢复，请保持车辆静止');}
 if(originChanged.value&&session.value?.state==='collecting')reasons.push('定位原点已变化，保留当前记录并停止采集');
 if(!reasons.length&&session.value?.state==='collecting'&&!session.value.samples?.length)reasons.push('等待首帧定位观测写入');
 return [...new Set(reasons)];
});
const originChanged=computed(()=>session.value?.samples?.[0]?.localEpoch&&robot.value.mapping?.localEpoch&&session.value.samples[0].localEpoch!==robot.value.mapping.localEpoch);
const label=(id:number)=>'Q'+String(id).padStart(3,'0');
function deviceStatus(key:string,status:string){if(key==='camera'&&status==='最后接入')return '等待定位识别观测';if(key==='odom'&&status==='原底盘反馈在线，横移标定待确认')return '在线 / 待标定';if(key==='imu'&&status==='未接入')return '未收到IMU数据，等待恢复';return recoveryReason(status);}
function selectSession(value:any){sessionEpoch++;session.value=value;name.value=value?.name??'';anchors.value=JSON.stringify(value?.anchors??[]);}
async function refreshPreview(){try{previewStatus.value=await api('/camera/status');previewError.value='';}catch{previewStatus.value=null;previewError.value='预览服务状态查询失败';}}
async function api(path:string,body?:unknown,method=body===undefined?'GET':'POST',signal?:AbortSignal,timeoutMs=8000){
 // 默认超时内联在参数里（而不是引用模块级常量）：command-feedback 单测只抽取
 // `api`/`navigation` 两个函数体在 vm 沙箱里运行，引用模块级常量会直接 ReferenceError。
 const ownTimeout=!signal;
 const controller=new AbortController();
 let timer:ReturnType<typeof setTimeout>|undefined;
 if(ownTimeout)timer=setTimeout(()=>controller.abort(),Math.max(1000,timeoutMs));
 const onOuterAbort=()=>controller.abort();
 if(signal)signal.addEventListener('abort',onOuterAbort,{once:true});
 try{
  const response=await fetch('/api'+path,{method,signal:controller.signal,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const json=await response.json();
  if(!response.ok)throw Object.assign(new Error(json.error??'请求失败'),{status:response.status});
  return json;
 }catch(err){
  // 超时统一成可读中文，避免用户只看到 "The operation was aborted"。
  if((err as {name?:string})?.name==='AbortError'){
   throw Object.assign(new Error(ownTimeout?'请求超时（'+Math.round(Math.max(1000,timeoutMs)/1000)+' 秒没有响应）：'+path:'请求已取消'+(path?('：'+path):'')),{status:0,timeout:ownTimeout,cancelled:!ownTimeout});
  }
  throw err;
 }finally{
  if(timer)clearTimeout(timer);
  if(signal)signal.removeEventListener('abort',onOuterAbort);
 }
}
/**
 * 串行执行一次操作，并维护全局 `busy`。
 *
 * 这里区分两类操作，因为它们对「超时」的容忍度完全不同：
 *
 *  - **只读/初始化**（`opts.timeoutMs` 有值）：超时就直接放弃等待并释放 busy。
 *    这类操作超时后即使后台继续跑，也不会产生第二次写，放行是安全的。
 *  - **写操作**（默认，无 timeoutMs）：**绝不用硬超时解锁**。
 *    以前的实现用 `Promise.race([fn(), hardStop])` 在 20 秒后把 busy 放掉，
 *    但 `fn()` 并没有被取消，它仍在后台跑；此时用户再点一次就会**第二次写**，
 *    出现「多阶段写并行 / 迟到回调覆写用户新状态」。
 *    现在写操作一直持锁到 `fn()` 真正 settle；要提前结束必须由调用方自己
 *    传 `signal` 并在内部可确认地中止（`opts.signal`），锁才会随之释放。
 */
async function act(fn:(signalAbort:AbortSignal)=>Promise<void>,opts:{timeoutMs?:number;signal?:AbortSignal}={}){
 if(busy.value){
  // 不再静默丢弃：必须让用户知道为什么没反应。
  message.value='上一个操作还在处理中，请稍候再试';
  return;
 }
 busy.value=true;error.value='';message.value='';
 // 只读操作可超时；写操作只有调用方显式给了 signal 才可能被提前中止。
 const controller=new AbortController();
 const abortFromOuter=()=>controller.abort();
 if(opts.signal){if(opts.signal.aborted)controller.abort();else opts.signal.addEventListener('abort',abortFromOuter,{once:true});}
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(opts.timeoutMs&&opts.timeoutMs>0){
   timer=setTimeout(()=>controller.abort(),opts.timeoutMs);
  }
  await fn(controller.signal);
 }catch(e){
  error.value=e instanceof Error?e.message:String(e);
 }finally{
  if(timer)clearTimeout(timer);
  if(opts.signal)opts.signal.removeEventListener('abort',abortFromOuter);
  // 只有真正结束（成功/失败/可确认取消）才释放互斥。
  busy.value=false;
 }
}
async function refresh(){
 const [mapsResult,surveysResult,tasksResult,routesResult,boardsResult]=await Promise.allSettled([
  api('/maps'),api('/surveys'),api('/tasks'),api('/routes'),api('/boards'),
 ]);
 const problems:string[]=[];
 if(mapsResult.status==='fulfilled')maps.value=mapsResult.value;
 else problems.push('地图列表：'+(mapsResult.reason instanceof Error?mapsResult.reason.message:String(mapsResult.reason)));
 if(surveysResult.status==='fulfilled')sessions.value=surveysResult.value;
 else problems.push('扫描记录：'+(surveysResult.reason instanceof Error?surveysResult.reason.message:String(surveysResult.reason)));
 if(tasksResult.status==='fulfilled')tasks.value=(tasksResult.value as Task[]).filter((t:Task)=>t.id.startsWith('task-scan-')||t.routeId);
 else problems.push('任务：'+(tasksResult.reason instanceof Error?tasksResult.reason.message:String(tasksResult.reason)));
 if(routesResult.status==='fulfilled')routes.value=routesResult.value;
 else problems.push('路径：'+(routesResult.reason instanceof Error?routesResult.reason.message:String(routesResult.reason)));
 if(boardsResult.status==='fulfilled')boards.value=boardsResult.value;
 else problems.push('定位板：'+(boardsResult.reason instanceof Error?boardsResult.reason.message:String(boardsResult.reason)));
 refreshDegraded.value=problems;
 // 只有地图拿不到才算致命（没地图什么都不能做）；其余降级为「部分数据暂不可用」。
 if(mapsResult.status==='rejected')throw new Error('地图列表加载失败：'+(mapsResult.reason instanceof Error?mapsResult.reason.message:String(mapsResult.reason)));
}
/** 初始化/刷新时哪些可选数据没取到；界面上只做轻提示，不挡操作。 */
const refreshDegraded=ref<string[]>([]);
async function generated(){await act(async()=>{boards.value=await api('/boards');message.value='定位组已保存';});}
function groupName(id:number){const board=(session.value?.boards??boards.value).find((b:Board)=>b.referenceId===id);return board?.id??label(id);}
async function refreshSurveys(){await act(async()=>{sessions.value=await api('/surveys');});}
/**
 * 打开一条扫描记录。
 *
 * 线上有一条 collecting 会话在 survey_motion 里积累了 246 万行 / 659MB，
 * `GET /api/surveys/:id` 会把它们全部读出并序列化 → 26.7 秒后 400（Invalid string length）。
 * 打开它就等于把界面锁死半分钟。
 *
 * 这里做两件事：
 *  1. 用较短超时先把失败暴露出来，并给出可读原因，而不是无限等；
 *  2. 提示用户这条记录本身数据异常（服务端应改为不返回全部 motion），
 *     而不是让「点了没反应」重复发生。
 */
async function loadSession(id:string){
 if(!id)return;
 await act(async()=>{
  if(session.value?.state==='collecting')throw new Error('请先停止当前扫描');
  const summary=sessions.value.find(item=>item.id===id);
  try{
   const detail=await api('/surveys/'+id,undefined,'GET',undefined,12000);
   sessionEpoch++;selectSession(detail);
  }catch(e){
   const msg=e instanceof Error?e.message:String(e);
   error.value=(summary?.state==='collecting'
    ?'这条采集中的记录数据量异常（运动记录过大），服务端读取超时；记录本身仍在，建议先停止该扫描再打开：'
    :'打开扫描记录失败：')+msg;
   throw e;
  }
 });
}
async function removeSession(id:string){await act(async()=>{sessionEpoch++;const target=sessions.value.find(item=>item.id===id);const result=await api('/surveys/'+id,undefined,'DELETE');if(session.value?.id===id){selectSession(null);}if(target?.mapId){if(field.value?.id===target.mapId){field.value=null;mapApproval.value=null;version.value=0;}if(selectedMapId.value===target.mapId)selectedMapId.value='';if(scanMap.value?.id===target.mapId){scanMap.value=null;scanMapVersion.value=0;}}orthogonalPreviewMap.value=null;if(mapDeletion.value&&mapDeletion.value.mapId===target?.mapId)mapDeletion.value=null;sessions.value=sessions.value.filter(s=>s.id!==id);const cascade=result.deletedMaps?` · 同时删除 ${result.deletedMaps} 张地图、${result.deletedRoutes} 条路径、${result.deletedTasks} 个任务绑定`:'';message.value='已删除扫描：'+result.name+cascade;sessions.value=await api('/surveys');await refresh();});}
// Map deletion is always two steps: a read-only cascade preview, then an explicit confirm.
const mapDeletion=ref<any>(null);
async function askDeleteMap(mapId:string,fallbackName=''){
 await act(async()=>{
  if(!mapId)throw new Error('请先选择要删除的地图');
  if(tagPositionEditing.value)throw new Error('二维码位置调整中，请先保存或退出调整再删除地图');
  if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再删除地图');
  if(robot.value.running)throw new Error('请先停止导航再删除地图');
  const info=await api('/maps/'+encodeURIComponent(mapId)+'/deletion');
  mapDeletion.value={...info,name:info.name||fallbackName||mapId};
 });
}
async function confirmDeleteMap(){
 await act(async()=>{
  const info=mapDeletion.value;if(!info)return;
  const result=await api('/maps/'+encodeURIComponent(info.mapId),undefined,'DELETE');
  mapDeletion.value=null;orthogonalPreviewMap.value=null;
  if(field.value?.id===result.mapId){field.value=null;mapApproval.value=null;version.value=0;}
  if(selectedMapId.value===result.mapId)selectedMapId.value='';
  if(scanMap.value?.id===result.mapId){scanMap.value=null;scanMapVersion.value=0;}
  selectedRouteId.value='';selectedTask.value='';routeNameDraft.value='';
  await refresh();
  message.value=`已删除地图「${result.name}」 · 同时删除 ${result.deletedVersions} 个版本、${result.deletedRoutes} 条路径、${result.deletedTasks} 个任务绑定`;
 });
}
// Route deletion also previews task bindings; detachTasks is only sent after the operator confirms.
const routeDeletion=ref<{routeId:string,name:string,mapId:string,tasks:{id:string,name:string}[]}|null>(null);
function pickRoute(routeId:string){selectedRouteId.value=routeId;chooseRoute();}
async function askDeleteRoute(route:RouteEntity){
 await act(async()=>{
  if(robot.value.running)throw new Error('请先停止导航再删除路径');
  const usage=await api('/routes/'+encodeURIComponent(route.routeId)+'/usage');
  routeDeletion.value={routeId:route.routeId,name:route.name,mapId:route.mapId,tasks:usage.tasks??[]};
 });
}
async function confirmDeleteRoute(){
 await act(async()=>{
  const info=routeDeletion.value;if(!info)return;
  await api('/routes/'+encodeURIComponent(info.routeId)+(info.tasks.length?'?detachTasks=1':''),undefined,'DELETE');
  routeDeletion.value=null;
  // 删除成功后必须把“正在显示的路线快照”一起清掉：selected route/task snapshot、编辑态、
  // 正交预览和残留的 motionSegments/rows 都不能继续留在画布上。
  routeEditId.value='';routeEditUpdated.value='';
  routeModes.value=[];routePolicyHistory.value=[];routePolicyHistory.value=[];selectedSegmentKey.value='';
  selectedRouteId.value='';selectedTask.value='';routeNameDraft.value='';orthogonalPreviewMap.value=null;
  if(editingRoute.value)editingRoute.value=false;
  await refresh();
  // 重新 GET 当前地图（不改变版本），确保画布只显示剩余路径/无路径状态。
  if(field.value&&field.value.id===info.mapId){selectMap(await api('/maps/'+info.mapId));}
  message.value=`已删除路径「${info.name}」`+(info.tasks.length?`，并移除 ${info.tasks.length} 个任务绑定`:'');
 });
}
async function start(){await act(async()=>{if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再开始扫描');if(!boards.value.length)throw new Error('请先生成多码定位组');const surveyName=name.value.trim()||autoSurveyName();name.value=surveyName;selectSession(await api('/survey/start',{name:surveyName}));scanView.value='camera';await refresh();message.value='扫描已开始 · '+surveyName;});}
async function stopSelectedSession(){
 if(!session.value)throw new Error('请先开始扫描');
 const id=session.value.id;
 if(session.value.state==='collecting')await api('/survey/stop',{sessionId:id});
 sessionEpoch++;session.value=await api('/surveys/'+id);
 return session.value;
}
async function savePositionMap(){
 if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再保存地图');
 const selected=await stopSelectedSession();
 const mapId='scan-'+selected.id.replace(/-/g,'');let baseVersion=0;
 try{baseVersion=(await api('/maps/'+mapId)).version;}catch(e){if((e as {status?:number}).status!==404)throw e;}
 const result=await api('/survey/map',{sessionId:selected.id,baseVersion,name:selected.name+'地图',tagSizeMm:settings.value.tagSizeMm});
 selectMap(result);orthogonalPreviewMap.value=null;selectedMapId.value=result.map.id;selectedRouteId.value='';selectedTask.value='';routeNameDraft.value='';
 await refresh();page.value='navigate';message.value='地图已保存 · '+result.map.tags.length+' 个定位组 · 未创建路径';
}
async function savePoints(){await act(savePositionMap);}
const selectedMapSurvey=computed(()=>selectedMapId.value?sessions.value.find(item=>'scan-'+item.id.replace(/-/g,'')===selectedMapId.value):undefined);
async function rebuildSelectedMap(){await act(async()=>{
 if(tagPositionEditing.value)throw new Error('二维码位置调整中，请先保存或退出调整再重建地图');
 if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再重建地图');
 if(!field.value||field.value.routeMode!=='map-only')throw new Error('当前地图不是可重建的定位码地图');
 const source=selectedMapSurvey.value;if(!source)throw new Error('找不到该地图对应的已停止原始扫描记录');
 const latest=await api('/maps/'+encodeURIComponent(field.value.id));
 const result=await api('/survey/map',{sessionId:source.id,baseVersion:latest.version,rebuild:true,name:source.name+'地图',tagSizeMm:settings.value.tagSizeMm});
 selectMap(result);orthogonalPreviewMap.value=null;selectedRouteId.value='';selectedTask.value='';
 await refresh();message.value='已从原始扫描重建地图新版本 v'+result.version+' · 旧版本和路线保持不变';
});}
async function resume(){await act(async()=>{if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再继续补扫');selectSession(await api('/survey/resume',{sessionId:session.value.id}));scanView.value='camera';await refresh();message.value='已继续扫描';});}
async function finish(){await act(savePositionMap);}
async function loadTask(){await act(async()=>{const task=tasks.value.find(t=>t.id===selectedTask.value);if(!task){field.value=null;mapApproval.value=null;return;}selectedMapId.value=task.mapId;selectedRouteId.value=task.routeId??routes.value.find(route=>route.mapId===task.mapId&&route.mapVersion===task.mapVersion&&route.routeId.startsWith('legacy-'))?.routeId??'';const result=task.routeId?await api('/routes/'+task.routeId):await api('/maps/'+task.mapId);selectMap(result);const route=routes.value.find(item=>item.routeId===selectedRouteId.value);routeNameDraft.value=route?.name??field.value?.rows[0]?.name??field.value?.name??'';});}
const availableMaps=computed(()=>maps.value);
const availableRoutes=computed(()=>routes.value.filter(route=>!selectedMapId.value||route.mapId===selectedMapId.value));
function taskForRoute(route:RouteEntity){return tasks.value.find(item=>item.routeId===route.routeId)??(route.routeId.startsWith('legacy-')?tasks.value.find(item=>!item.routeId&&item.mapId===route.mapId&&item.mapVersion===route.mapVersion):undefined);}
async function chooseMap(){await act(async()=>{
 selectedRouteId.value='';selectedTask.value='';routeNameDraft.value='';orthogonalPreviewMap.value=null;
 if(!selectedMapId.value){field.value=null;mapApproval.value=null;return;}
 selectMap(await api('/maps/'+selectedMapId.value));
});}
function chooseRoute(){const route=routes.value.find(item=>item.routeId===selectedRouteId.value);if(route&&(route.mapId!==field.value?.id||route.mapVersion!==version.value)){message.value='该路径不属于当前地图 v'+version.value+'，已忽略';selectedRouteId.value='';selectedTask.value='';routeNameDraft.value='';return;}const task=route?taskForRoute(route):undefined;selectedTask.value=task?.id??'';routeNameDraft.value=route?.name??'';if(task)void loadTask();}

// 自用版：坐标直接读取扫描结果，界面上不再有「启用此地图 / 确认启用地图」动作。
// 选中哪张地图，它就是当前导航地图与定位目标（见 syncLocalizationScope 的切图重锚）。
// 旧 POST /api/maps/confirm 与 /api/maps/accept 保留兼容，但前端不再调用、不再要求点击；
// 开始导航仍由定位/相机/IMU/底盘条件与地图+路径版本一致性共同把关。
// 现场所有板子同方向铺设：扫描估计的逐码朝向角只允许几度噪声，统一目标取中位数。
// 预览只读；只有点击应用才保存新版本，绝不自动修改。
const unifyAnglesInfo=computed(()=>{
 const tags=field.value?.tags??[];if(tags.length<2)return null;
 const sorted=tags.map(t=>t.angle).sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
 const target=sorted.length%2?sorted[middle]!:(sorted[middle-1]!+sorted[middle]!)/2;
 return {list:tags.map(t=>({id:t.id,angleDeg:t.angle})),targetDeg:target,spreadDeg:sorted[sorted.length-1]!-sorted[0]!};
});
async function unifyAngles(){await act(async()=>{
 if(!field.value||!unifyAnglesInfo.value)throw new Error('请先选择扫描地图');
 const result=await api('/maps/unify-angles',{mapId:field.value.id,version:version.value,confirm:true,updateTasks:true});
 selectMap(await api('/maps/'+field.value.id));
 await refresh();message.value=`已统一 ${result.before.length} 个定位码朝向到 ${Number(result.unifiedAngleDeg).toFixed(2)}°，路径与任务已同步到 v${result.version}`;
});}
const speedSettings=ref({forwardSpeed:8,reverseSpeed:6,lateralSpeed:5});
const selectedNavigationTask=computed(()=>tasks.value.find(t=>t.id===selectedTask.value));
const speedFields=[{key:'forwardSpeed',label:'前进',max:20},{key:'reverseSpeed',label:'倒车',max:15},{key:'lateralSpeed',label:'平移',max:10}] as const;
watch(selectedNavigationTask,(task,previous)=>{if(task&&previous&&task.id===previous.id&&speedFields.every(({key})=>task[key]===previous[key]))return;if(task)speedSettings.value={forwardSpeed:Math.round(task.forwardSpeed*10000)/100,reverseSpeed:Math.round(task.reverseSpeed*10000)/100,lateralSpeed:Math.round(task.lateralSpeed*10000)/100};},{immediate:true});
const speedDirty=computed(()=>!!selectedNavigationTask.value&&speedFields.some(({key})=>Math.abs(Number(speedSettings.value[key])/100-selectedNavigationTask.value![key])>1e-8||!Number.isFinite(Number(speedSettings.value[key]))));
async function saveSpeeds(){await act(async()=>{
 const task=selectedNavigationTask.value;if(!task)throw new Error('请先选择导航地图');
 if(robot.value.running||commandFeedback.value?.state==='waiting')throw new Error('请在停止导航后调整速度');
 const values=Object.fromEntries(speedFields.map(({key})=>[key,Number(speedSettings.value[key])/100]));
 const checked=taskSchema.pick({forwardSpeed:true,reverseSpeed:true,lateralSpeed:true}).safeParse(values);
 if(!checked.success)throw new Error('速度范围：前进 2–20、倒车 2–15、平移 2–10 厘米/秒');
 await api('/tasks/'+encodeURIComponent(task.id)+'/speeds',checked.data);await refresh();
 message.value='速度已保存，下次启动导航生效';
});}
const returnToStart=computed(()=>tasks.value.find(t=>t.id===selectedTask.value)?.returnToStart===true);
async function toggleReturnToStart(){await act(async()=>{
 const task=tasks.value.find(t=>t.id===selectedTask.value);if(!task)throw new Error('请先选择导航地图');
 if(robot.value.running)throw new Error('请在任务结束后设置返回方式');
 await api('/tasks',{...task,returnToStart:!returnToStart.value});await refresh();
 message.value=returnToStart.value?'已开启：导航完成后原路倒车返回起点':'已关闭：导航到终点停车';
});}
async function navigation(command:string){
 if(command==='start'&&(busy.value||commandFeedback.value?.state==='waiting'))return;
 if(command==='start'&&orthogonalPreviewActive.value){error.value='正交校正预览中，请先应用或撤销预览再开始导航';return;}
 navigationAbort?.abort();
 const controller=new AbortController();navigationAbort=controller;
 error.value='';message.value='';
 commandFeedback.value={id:'',state:'waiting',text:'正在提交指令，等待机器人回执…'};
 const timeout=setTimeout(()=>controller.abort(),6000);let commandId='';
 try{
  const result=await api('/navigation/'+command,command==='start'?{taskId:selectedTask.value}:{},'POST',controller.signal);
  if(navigationAbort!==controller||closed)return;
  if(controller.signal.aborted)throw new Error('指令请求超时');
  if(result.accepted!==true||typeof result.commandId!=='string'||!result.commandId)throw new Error(result.state||'未返回命令编号，指令未确认');
  commandId=result.commandId;
  commandFeedback.value={id:commandId,state:'waiting',text:'指令已提交，等待机器人回执…'};
  while(!controller.signal.aborted){
   try{
    const receipt=await api('/robot/commands/'+encodeURIComponent(commandId),undefined,'GET',controller.signal);
    if(!controller.signal.aborted&&receipt.id===commandId&&typeof receipt.ok==='boolean'){
     commandFeedback.value={id:commandId,state:receipt.ok?'confirmed':'rejected',text:receipt.ok?'机器人已确认接收'+(receipt.message?'：'+receipt.message:''):'指令被拒绝（REJECTED）：'+(receipt.message||'机器人未提供原因')};
     return;
    }
   }catch{/* Only result lookups may retry; never resubmit a navigation command. */}
   if(!controller.signal.aborted)await new Promise<void>(resolve=>{
    const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);resolve();};
    const timer=setTimeout(finish,200);controller.signal.addEventListener('abort',finish,{once:true});
   });
  }
  if(navigationAbort===controller&&!closed)commandFeedback.value={id:commandId,state:'unconfirmed',text:'指令未确认：6 秒内未收到机器人回执，请检查车辆状态。'};
 }catch(e){
  if(navigationAbort!==controller||closed)return;
  if(controller.signal.aborted)commandFeedback.value={id:commandId,state:'unconfirmed',text:'指令未确认：6 秒内未收到机器人回执，请检查车辆状态。'};
  else{commandFeedback.value=null;error.value=e instanceof Error?e.message:String(e);}
 }finally{clearTimeout(timeout);if(navigationAbort===controller)navigationAbort=undefined;}
}
const captureSampleCount=computed(()=>session.value?.samples?.length??0);
const capturePointCount=computed(()=>{
 const observed=new Set<string>();const layouts:Board[]=session.value?.boards??boards.value;
 const groupKey=(id:number,groupId?:string)=>groupId??layouts.find(board=>board.members.some(member=>member.id===id))?.id??String(id);
 for(const sample of session.value?.samples??[])for(const tag of sample.tags??[])observed.add(groupKey(tag.id,tag.groupId));
 if(!observed.size)for(const [id,count] of Object.entries(session.value?.counts??{}))if(Number(count)>0)observed.add(groupKey(Number(id)));
 return observed.size;
});
const scanPreview=computed<FieldMap|null>(()=>{
 if(!session.value?.samples?.length)return null;
 const optimized=session.value.result;
 const estimates=new Map<number,{x:number,y:number,angle:number,count:number}>();
 for(const sample of session.value.samples){const c=Math.cos(sample.pose.yaw),s=Math.sin(sample.pose.yaw);for(const tag of sample.tags){const x=sample.pose.x+c*tag.x-s*tag.y,y=sample.pose.y+s*tag.x+c*tag.y,angle=(sample.pose.yaw+tag.angle)*180/Math.PI;const prev=estimates.get(tag.id);if(prev){prev.x+=x;prev.y+=y;prev.count++;}else estimates.set(tag.id,{x,y,angle,count:1});}}
 const layouts:Board[]=session.value.boards??[];const tagProperties=(id:number)=>{const b=layouts.find(g=>g.referenceId===id);return b?{groupId:b.id,size:b.sizeMm/1000}:{size:settings.value.tagSizeMm/1000};};
 const tags=optimized?optimized.tags.map((t:any)=>({...t,...tagProperties(t.id),rowId:'',kind:'waypoint',rules:[]})):[...estimates.entries()].map(([id,t])=>({id,x:t.x/t.count,y:t.y/t.count,angle:t.angle,...tagProperties(id),rowId:'',kind:'waypoint',rules:[]}));
 return {schemaVersion:1,id:session.value.id,name:session.value.name,frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',rows:[],tags,groups:layouts,order:[],zone:[],vehicle:{width:.4,length:.8,margin:.05},notes:'扫描观测预览，坐标仍待校准。'} as FieldMap;
});
const trail=computed<Point[]>(()=>session.value?.result?.poses?session.value.result.poses.map((p:number[])=>({x:p[0],y:p[1]})):session.value?.samples?.map((s:any)=>({x:s.pose.x,y:s.pose.y}))??[]);
const map=computed(()=>page.value==='scan'?scanPreview.value:field.value);
// Scan page keeps its own copy of the selected record's saved map so the rebuild
// button and orthogonal panel are reachable without leaving the scan workflow.
const scanMapId=computed(()=>session.value?.id?'scan-'+session.value.id.replace(/-/g,''):'');
const scanMap=ref<FieldMap|null>(null),scanMapVersion=ref(0),scanMapLoaded=ref(false);
async function loadScanMap(){
 const id=scanMapId.value;
 if(!id){scanMap.value=null;scanMapVersion.value=0;scanMapLoaded.value=false;return;}
 try{
  const result=await api('/maps/'+encodeURIComponent(id));
  scanMap.value=result.map;scanMapVersion.value=result.version;scanMapLoaded.value=true;
 }catch(e){
  scanMap.value=null;scanMapVersion.value=0;scanMapLoaded.value=(e as {status?:number}).status!==404;
 }
}
async function createBlankMapNow(){
 await act(async()=>{
  if(robot.value.running)throw new Error('请先停止导航再新建地图');
  const stamp=new Date().toISOString().slice(5,16).replace(/[-:T]/g,'');
  const result=await api('/maps/new',{name:`手动铺码图-${stamp}`});
  selectedMapId.value=result.map.id;
  selectMap({map:result.map,version:result.version,acceptance:null});
  await refresh();
  // 统一工作区：新建空图后停在同一页（路径编辑即「地图与路径编辑」），
  // 不再自动 beginNewRoute()——进入页面不得凭空创建生产路线。
  page.value='navigate';
  message.value='已新建空白地图 · 版本 v'+result.version+' · 可在左侧「点位与铺码」加二维码，需要时再「新建路径」';
 });
}
async function rebuildScanMap(){await act(async()=>{
 if(orthogonalPreviewActive.value)throw new Error('正交校正预览中，请先应用或撤销预览再重建地图');
 const current=session.value;
 if(!current)throw new Error('请先在「已保存扫描」中选择一条记录');
 if(current.state==='collecting')throw new Error('请先停止扫描再重建地图');
 const id='scan-'+current.id.replace(/-/g,'');
 const latest=await api('/maps/'+encodeURIComponent(id));
 if(latest.map?.routeMode!=='map-only')throw new Error('当前地图不是可重建的定位码地图');
 const result=await api('/survey/map',{sessionId:current.id,baseVersion:latest.version,rebuild:true,name:current.name+'地图',tagSizeMm:settings.value.tagSizeMm});
 await refresh();await loadScanMap();
 message.value='已从原始扫描重建地图新版本 v'+result.version+' · 旧版本和路线保持不变';
});}
async function onScanMapApplied(result:any){orthogonalPreviewMap.value=null;await refresh();await loadScanMap();message.value='正交校正已保存 · 地图版本 v'+result.version+'；旧路线保持原版本';}
watch([scanMapId,()=>session.value?.state],()=>{orthogonalPreviewMap.value=null;if(page.value==='scan')void loadScanMap();},{immediate:true});
function matchingMapPose(status:any,mapId:string,nowMs:number,receivedMs=nowMs){
 const pose=status.pose,localization=status.localization;
 if(!status.connected||!mapId||!pose||!localization||localization.mapId!==mapId||localization.poseAvailable!==true||localization.absoluteHeading!==true)return null;
 // The server and ROS share a clock; the browser may have a different wall clock.
 // Preserve the 250 ms observation limit and expire stalled browser updates locally.
 const serverNowMs=status.serverTimeMs??nowMs;
 const ageMs=serverNowMs-localization.stamp*1000+(nowMs-receivedMs);
 if(![pose.x,pose.y,pose.yaw,localization.stamp,serverNowMs,nowMs,receivedMs].every(v=>typeof v==='number'&&Number.isFinite(v))||!(0<=ageMs&&ageMs<=250))return null;
 const isStatic=localization.state==='STATIC_ANCHORED'&&localization.source==='stationary_qr'&&localization.stationary===true&&localization.navigationReady===false&&localization.captureTimestampVerified===false;
 const isFormal=localization.state==='FORMAL'&&localization.source==='synchronized_qr';
 const isSynchronizedPreview=localization.state==='LOCAL_ONLY'&&localization.source==='synchronized_qr'&&localization.captureTimestampVerified===true;
 if(!isStatic&&!isFormal&&!isSynchronizedPreview)return null;
 return {...pose,headingDeg:((pose.yaw*180/Math.PI+180)%360+360)%360-180,isStatic,sourceLabel:isStatic?'静止二维码定位':isFormal?(localization.approvalBasis==='user_confirmation'?'同步二维码融合定位':'正式二维码融合定位'):'同步二维码位姿'};
}
// Shared empty identities: a render caused by telemetry must not hand MapCanvas a brand-new
// array prop, otherwise its deep watcher would rebuild every QR/handle even though nothing changed.
const EMPTY_TAG_IDS:number[]=[],EMPTY_POINTS:Point[]=[];
// Single source of truth for the live vehicle overlay. Scanning/building and route editing never
// paint the real pose, no matter how much telemetry arrives; only the navigation monitor does.
const mapVehicle=computed(()=>page.value==='navigate'&&!editingRoute.value&&bridgeOnline.value?matchingMapPose(robot.value,field.value?.id??'',poseClock.value,robotReceivedClock.value):null);
// The pose card and the map read the same gated value, so they can never disagree.
const displayedPose=mapVehicle;
// Static/interactive props are derived once per real state change instead of being allocated
// inline in the template (where every telemetry render produced new arrays and forced a redraw).
const spacingSelectedIds=ref<number[]>([]);
const mapSelected=computed<number[]>(()=>{
 if(measuring.value)return measurementIds.value;
 if(tagPositionEditing.value)return spacingSelectedIds.value.length?spacingSelectedIds.value:EMPTY_TAG_IDS;
 return inspectedTagId.value===null?EMPTY_TAG_IDS:[inspectedTagId.value];
});
const mapMeasurement=computed<number[]>(()=>measuring.value?measurementIds.value:EMPTY_TAG_IDS);
const mapDrawing=computed<Point[]>(()=>editingRoute.value?routeDrawing.value:EMPTY_POINTS);
// Capture trail is a diagnostic overlay available on the scan page only while its explicit
// toggle is checked; editing and navigation never receive those points.
const mapTrail=computed<Point[]>(()=>page.value==='scan'&&!editingRoute.value&&showCaptureTrail.value?trail.value:EMPTY_POINTS);
// Stored map versions can still carry an old row/motionSegments (示教/旧路线). The canvas must
// never render those unless they belong to the route the operator selected right now:
// - scan page: the map itself (map-only maps carry no route);
// - navigation monitor: only the selected route snapshot;
// - route editing: the orthogonal drawing preview is authoritative, so stored routes are hidden.
const canvasMap=computed<FieldMap|null>(()=>{
 const base=orthogonalPreviewMap.value??map.value;if(!base)return null;
 if(page.value==='scan')return base;
 const route=editingRoute.value?undefined:routes.value.find(item=>item.routeId===selectedRouteId.value);
 return {...base,rows:[],motionSegments:route?.motionSegments};
});
const measuring=ref(false),measureFrom=ref<number|''>(''),measureTo=ref<number|''>('');
const measurementIds=computed(()=>[measureFrom.value,measureTo.value].filter((id):id is number=>typeof id==='number'));
const centerDistance=computed(()=>{
 if(measureFrom.value===''||measureTo.value===''||measureFrom.value===measureTo.value)return null;
 const a=map.value?.tags.find(t=>t.id===measureFrom.value),b=map.value?.tags.find(t=>t.id===measureTo.value);
 return a&&b?Math.hypot(b.x-a.x,b.y-a.y):null;
});
function measureLabel(tag:FieldMap['tags'][number]){return tag.groupId??'Q'+String(tag.id).padStart(3,'0');}
function clearMeasurement(){measureFrom.value='';measureTo.value='';}
function toggleMeasurement(){if(tagPositionEditing.value)return;measuring.value=!measuring.value;clearMeasurement();if(measuring.value&&page.value==='scan')scanView.value='map';}
function measureSelect(id:number){
 if(!measuring.value)return;
 if(measureFrom.value===''||measureTo.value!==''){measureFrom.value=id;measureTo.value='';}
 else if(id!==measureFrom.value)measureTo.value=id;
}
watch([()=>page.value,()=>map.value?.id],()=>{measuring.value=false;clearMeasurement();});
watch(()=>map.value?.tags.map(t=>t.id),ids=>{
 if(measureFrom.value!==''&&!ids?.includes(measureFrom.value))measureFrom.value='';
 if(measureTo.value!==''&&!ids?.includes(measureTo.value))measureTo.value='';
});
// 折叠状态：左侧导航栏、路径工具/参数卡片、右侧节点属性面板。
const sidebarCollapsed=ref(false),toolsOpen=ref(true),paramsOpen=ref(false),commandsOpen=ref(false),routeStepsOpen=ref(false);
// 低频操作（串码/生成路径/删除/撤销重做）默认收起：它们不常驻占位，但入口始终可发现。
const routeToolsMoreOpen=ref(false);
const routeStepsLayout=ref<{left:number;top:number;width:number;height:number}|null>(null);
// 步骤面板的高度（停靠模式）。默认 240px，可拖拽调整，上限为视口 60%。
const routeStepsDockHeight=ref(240);
const routeStepsDockStyle=computed(()=>({'--route-steps-height':routeStepsDockHeight.value+'px'}));
let routeStepsDockDrag:{startY:number;startH:number}|null=null;
function startRouteStepsDockResize(event:PointerEvent){
 if(event.button!==0&&event.pointerType==='mouse')return;
 event.preventDefault();
 routeStepsDockDrag={startY:event.clientY,startH:routeStepsDockHeight.value};
 try{(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);}catch{/* 触摸场景退回 document 监听 */}
 document.addEventListener('pointermove',moveRouteStepsDockResize,true);
 document.addEventListener('pointerup',endRouteStepsDockResize,true);
 document.addEventListener('pointercancel',endRouteStepsDockResize,true);
}
function moveRouteStepsDockResize(event:PointerEvent){
 if(!routeStepsDockDrag)return;
 // 往上拖 = 变高；限制 120..60% 视口，避免把画布压没。
 const next=routeStepsDockDrag.startH+(routeStepsDockDrag.startY-event.clientY);
 routeStepsDockHeight.value=Math.round(Math.max(120,Math.min(maxRouteStepsDockHeight(),next)));
}
/** 键盘调整步骤面板高度（无指针时的等价操作）。 */
/** 步骤面板允许的最大高度：触发器上方可用空间，且不超过视口 60%。
 *  以前只按 innerHeight*0.6 限制，面板底部会超出视口（实测 y=758+248=1006 > 900），
 *  连自己的「关闭」按钮都被推到视口外，用户点不到。 */
function maxRouteStepsDockHeight(){
 // 面板在触发器**下方**展开；触发器本身贴着视口底部，剩余空间很小，
 // 所以不能「按触发器底边算可用空间」（那会把面板压到 120，头部被压扁、
 // 关闭按钮变成 0 高、点不到）。正确做法：给底部停靠区一个**确定高度**，
 // 让页面整体滚动到能看到它，而不是把面板压扁。
 return Math.round(Math.max(200,Math.min(window.innerHeight*0.5,window.innerHeight-220)));
}
function clampRouteStepsDockHeight(){
 const max=maxRouteStepsDockHeight();
 if(routeStepsDockHeight.value>max)routeStepsDockHeight.value=max;
}
function nudgeRouteStepsDock(delta:number){
 routeStepsDockHeight.value=Math.round(Math.max(120,Math.min(maxRouteStepsDockHeight(),routeStepsDockHeight.value+delta)));
}
function endRouteStepsDockResize(){
 document.removeEventListener('pointermove',moveRouteStepsDockResize,true);
 document.removeEventListener('pointerup',endRouteStepsDockResize,true);
 document.removeEventListener('pointercancel',endRouteStepsDockResize,true);
 routeStepsDockDrag=null;
}
let routeStepsDrag:{pointerId:number;startX:number;startY:number;left:number;top:number;width:number;height:number}|null=null;
let routeStepsResize:{pointerId:number;startX:number;startY:number;left:number;top:number;width:number;height:number}|null=null;
const routeStepsStyle=computed(()=>routeStepsLayout.value?{left:routeStepsLayout.value.left+'px',top:routeStepsLayout.value.top+'px',right:'auto',bottom:'auto',width:routeStepsLayout.value.width+'px',height:routeStepsLayout.value.height+'px'}:{});
function clampRouteStepsLayout(layout:{left:number;top:number;width:number;height:number}){
 const minW=280,minH=160,maxW=Math.max(minW,Math.min(window.innerWidth-24,760)),maxH=Math.max(minH,Math.min(window.innerHeight-24,560));
 const width=Math.min(maxW,Math.max(minW,layout.width)),height=Math.min(maxH,Math.max(minH,layout.height));
 return {left:Math.max(12,Math.min(window.innerWidth-width-12,layout.left)),top:Math.max(12,Math.min(window.innerHeight-height-12,layout.top)),width,height};
}
/**
 * 路径步骤浮窗的初始位置。
 *
 * 历史行为是「贴着窗口右下角」，结果浮窗一打开就同时盖住两样东西：
 * 画布中央（用户正在点路径点的位置）和它自己的触发按钮（想关也点不到）。
 * 现在改成贴着底部面板上方、横向靠右下，并且高度上限只占视口 42%，
 * 保证画布仍有大块可点区域；用户仍可拖动手柄把它挪到任意位置。
 */
function ensureRouteStepsLayout(){
 if(routeStepsLayout.value){routeStepsLayout.value=clampRouteStepsLayout(routeStepsLayout.value);return;}
 const bottomEntry=document.querySelector('[data-testid="route-steps-entry"]') as HTMLElement|null;
 const entryTop=bottomEntry?bottomEntry.getBoundingClientRect().top:window.innerHeight*.6;
 // 默认尺寸保持既有约定（760×520，route-editor 回归用例锁定这个尺寸），
 // 只改「挂在哪里」：贴底部面板上方，而不是盖住整个画布中央。
 const width=Math.min(760,Math.max(280,window.innerWidth-332));
 const maxHeightAbove=Math.max(220,entryTop-24);
 const height=Math.min(520,Math.max(220,Math.min(window.innerHeight*.62,maxHeightAbove)));
 const left=Math.max(12,window.innerWidth-width-12);
 const top=Math.max(12,entryTop-height-10);
 routeStepsLayout.value=clampRouteStepsLayout({left,top,width,height});
}
function startRouteStepsDrag(event:PointerEvent){
 if(event.button!==0&&event.pointerType==='mouse')return;
 const el=(event.currentTarget as HTMLElement)?.closest('[data-testid=route-steps-popover]') as HTMLElement|null;
 if(!el)return;
 ensureRouteStepsLayout();
 const r=el.getBoundingClientRect();
 routeStepsDrag={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,left:r.left,top:r.top,width:r.width,height:r.height};
 try{(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);}catch{}
 document.addEventListener('pointermove',moveRouteStepsDrag,true);
 document.addEventListener('pointerup',endRouteStepsDrag,true);
 document.addEventListener('pointercancel',endRouteStepsDrag,true);
}
function moveRouteStepsDrag(event:PointerEvent){if(!routeStepsDrag||event.pointerId!==routeStepsDrag.pointerId)return;routeStepsLayout.value=clampRouteStepsLayout({left:routeStepsDrag.left+event.clientX-routeStepsDrag.startX,top:routeStepsDrag.top+event.clientY-routeStepsDrag.startY,width:routeStepsDrag.width,height:routeStepsDrag.height});}
function endRouteStepsDrag(){
 document.removeEventListener('pointermove',moveRouteStepsDrag,true);
 document.removeEventListener('pointerup',endRouteStepsDrag,true);
 document.removeEventListener('pointercancel',endRouteStepsDrag,true);
 if(routeStepsLayout.value)routeStepsLayout.value=clampRouteStepsLayout(routeStepsLayout.value);
 routeStepsDrag=null;
}
function startRouteStepsResize(event:PointerEvent){
 if(event.button!==0&&event.pointerType==='mouse')return;
 const el=(event.currentTarget as HTMLElement)?.closest('[data-testid=route-steps-popover]') as HTMLElement|null;
 if(!el)return;
 ensureRouteStepsLayout();
 const r=el.getBoundingClientRect();
 routeStepsResize={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,left:r.left,top:r.top,width:r.width,height:r.height};
 try{(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);}catch{}
 document.addEventListener('pointermove',moveRouteStepsResize,true);
 document.addEventListener('pointerup',endRouteStepsResize,true);
 document.addEventListener('pointercancel',endRouteStepsResize,true);
}
function moveRouteStepsResize(event:PointerEvent){if(!routeStepsResize||event.pointerId!==routeStepsResize.pointerId)return;routeStepsLayout.value=clampRouteStepsLayout({left:routeStepsResize.left,top:routeStepsResize.top,width:routeStepsResize.width+event.clientX-routeStepsResize.startX,height:routeStepsResize.height+event.clientY-routeStepsResize.startY});}
function endRouteStepsResize(){
 document.removeEventListener('pointermove',moveRouteStepsResize,true);
 document.removeEventListener('pointerup',endRouteStepsResize,true);
 document.removeEventListener('pointercancel',endRouteStepsResize,true);
 if(routeStepsLayout.value)routeStepsLayout.value=clampRouteStepsLayout(routeStepsLayout.value);
 routeStepsResize=null;
}
const editingRoute=ref(false),routeAnchors=ref<Point[]>([]),routeSelected=ref(-1),bodyYawDeg=ref(0),initialHeadingManual=ref(false),routeTool=ref<'select'|'draw'|'pan'|'connect'>('select');
const tagInspectorVisible=ref(false);
// 双击地图上的二维码 → 就地弹出基本信息（不再显示子码/原图）
const tagDetailId=ref<number|null>(null);
const tagDetail=computed(()=>{
 const id=tagDetailId.value;if(id===null||!field.value)return null;
 const tag=field.value.tags.find(item=>item.id===id);if(!tag)return null;
 const groups=(field.value.groups??[]) as Array<{referenceId:number,gridSize:number,sizeMm:number}>;
 const board=groups.find(group=>group.referenceId===tag.id);
 return {id,label:tag.groupId??'Q'+String(tag.id).padStart(3,'0'),family:field.value.family,
  sizeMm:Math.round(tag.size*1000),rowId:tag.rowId??'—',
  kind:tag.groupId?'整组定位板':'独立单码',grid:board?board.gridSize:null};
});
function openTagDetail(id:number){tagDetailId.value=id;}

const inspectedTagId=ref<number|null>(null),selectedSegmentKey=ref(''),routeModes=ref<SegmentChoice[]>([]),routePolicyHistory=ref<SegmentChoice[][]>([]);
// Map QR position editing is a separate stage: canvas clicks only select a point
// and drags only move that point's centre. Route waypoint/drawing events never
// run while this stage is active.
function mapCanvasSelect(id:number){
 if(tagPositionEditing.value||tagTableEditing.value){
  // 画布直接点选：再点一次取消；支持连续点多码做批量等间距。
  inspectedTagId.value=id;
  spacingSelectedIds.value=spacingSelectedIds.value.includes(id)
   ?spacingSelectedIds.value.filter(item=>item!==id)
   :[...spacingSelectedIds.value,id];
  return;
 }
 measureSelect(id);
}
function mapCanvasMove(ids:number[],dx:number,dy:number){
 if(!ids.length)return;
 if(tagTableEditing.value){tagTablePanel.value?.moveTags(ids,dx,dy);}
 else{tagPositionPanel.value?.moveTags(ids,dx,dy);}
 if(ids.length===1)inspectedTagId.value=ids[0]!;
}
const routeHistory=ref<Point[][]>([]),routeSkippedHold=ref<SkippedRouteGroup[]>([]);
const spacingFrom=ref<number|null>(null),spacingTo=ref<number|null>(null),spacingTargetM=ref<number|null>(null),spacingOverrides=ref<{fromId:number;toId:number;occurrence:number;targetM:number}[]>([]);
const spacingPair=computed(()=>{if(spacingFrom.value===null||spacingTo.value===null)return null;const a=field.value?.tags.find(t=>t.id===spacingFrom.value),b=field.value?.tags.find(t=>t.id===spacingTo.value);if(!a||!b)return null;const eu=Math.hypot(b.x-a.x,b.y-a.y);const target=spacingTargetM.value??eu;return {a,b,eu,target};});
function applySpacingPreview(){const pair=spacingPair.value;if(!pair||spacingTargetM.value===null||spacingTargetM.value<.08)return;const ids=routeGroupIds.value;const ai=ids.indexOf(pair.a.id),bi=ids.indexOf(pair.b.id);if(ai<0||bi!==ai+1){message.value='请选择路径上相邻且按行进顺序的两个二维码';return;}const next={fromId:pair.a.id,toId:pair.b.id,occurrence:1,targetM:spacingTargetM.value};spacingOverrides.value=[...spacingOverrides.value.filter(x=>!(x.fromId===next.fromId&&x.toId===next.toId&&x.occurrence===1)),next];}
function chooseSpacingPair(){const ids=routeGroupIds.value;if(ids.length<2)return;spacingFrom.value=ids[0]??null;spacingTo.value=ids[1]??null;const a=field.value?.tags.find(t=>t.id===spacingFrom.value),b=field.value?.tags.find(t=>t.id===spacingTo.value);if(a&&b)spacingTargetM.value=Math.hypot(b.x-a.x,b.y-a.y);}

const routeDrawing=computed(()=>orthogonalRoute(routeAnchors.value));
const routeChain=computed(()=>chainRouteGroups(routeDrawing.value,field.value?routeGroupCenters(field.value):[]));
const routeGroupIds=computed(()=>[...new Set(routeChain.value.nodes.map(node=>node.id))]);
// Keep the reactive dependency on a stable primitive: reading robot.value inside routePlans would
// re-create the segment-plan array on every telemetry frame and re-trigger MapCanvas redraw.
const turnInPlaceCapability=computed(()=>robot.value.capabilities?.turnInPlace===true);
const routePlans=computed(()=>planStrategies(routeChain.value.nodes,bodyYawDeg.value*Math.PI/180,routeModes.value,{turnInPlace:turnInPlaceCapability.value}));
const savedStrategyBlockers=computed(()=>segmentExecutionBlockers(field.value?.motionSegments,{turnInPlace:turnInPlaceCapability.value}));
// The starting body heading belongs to the route, not to the recording. Until the
// operator sets it explicitly it follows the first leg's travel direction.
const norm360=(deg:number)=>((deg%360)+360)%360;
const wrapDeg180=(deg:number)=>norm360(deg+180)-180;
function firstLegHeadingDeg(points:Point[]=routeAnchors.value){
 // Prefer the first planned leg (snapped group centres), which is exactly what the
 // strategy planner uses as its first travel direction.
 const nodes=routeChain.value.nodes;
 const a=nodes.length>=2?nodes[0]!:points[0],b=nodes.length>=2?nodes[1]!:points[1];
 if(!a||!b)return 0;
 if(Math.hypot(b.x-a.x,b.y-a.y)<1e-6)return 0;
 return Math.round(norm360(Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI)*100)/100;
}
function setInitialHeading(deg:number){if(!Number.isFinite(deg))return;bodyYawDeg.value=Math.round(norm360(deg)*100)/100;initialHeadingManual.value=true;}
function setInitialHeadingRad(rad:number){if(!Number.isFinite(rad))return;setInitialHeading(rad*180/Math.PI);}
function nudgeInitialHeading(delta:number){setInitialHeading(bodyYawDeg.value+delta);}
function adoptFirstLegHeading(){setInitialHeading(firstLegHeadingDeg());}
function resetInitialHeading(){initialHeadingManual.value=false;bodyYawDeg.value=firstLegHeadingDeg();}
watch(routeAnchors,()=>{if(editingRoute.value&&!initialHeadingManual.value)bodyYawDeg.value=firstLegHeadingDeg();},{deep:true});
const lateralStrategyBlocked=computed(()=>field.value?.motionSegments?.some(segment=>segment.strategy==='left'||segment.strategy==='right')&&robot.value.mapping?.lateralSupported!==true);
function inspectTag(id:number){if(editingRoute.value){inspectedTagId.value=id;tagInspectorVisible.value=false;}}
function openTagInspector(){if(!field.value?.tags.length)return;inspectedTagId.value??=orderedTagsById(field.value.tags)[0]!.id;tagInspectorVisible.value=true;if(editingRoute.value)routeDetailsOpen.value=true;}
function changeSegmentMode(plan:SegmentPlan,mode:StrategyMode){if(routeLocked.value)return;rememberRoute();routeModes.value=[...routeModes.value.filter(choice=>!(choice.fromId===plan.fromId&&choice.toId===plan.toId&&choice.occurrence===plan.occurrence)),{fromId:plan.fromId,toId:plan.toId,occurrence:plan.occurrence,mode}];selectedSegmentKey.value=plan.key;}
function selectSegment(key:string){selectedSegmentKey.value=key;routeDetailsOpen.value=true;}
const routeSkipped=computed(()=>{
 const byId=new Map([...routeSkippedHold.value,...routeChain.value.skipped].map(tag=>[tag.id,tag]));
 return [...byId.values()].filter(tag=>!routeGroupIds.value.includes(tag.id)).map(tag=>({...tag,distanceM:distanceToRoute(tag,routeDrawing.value)}));
});
const routeLength=computed(()=>routeDrawing.value.slice(1).reduce((sum,p,i)=>sum+distance(routeDrawing.value[i]!,p),0));
// 路径编辑的"硬锁"：只有真正互斥的状态才锁（机器人运行、指令等待、地图预览）。
// 二维码间距调整不再锁路径编辑——它只锁"保存路径/导航/删除路径"这些会写版本的动作。
// 真正互斥的只有「正交校正预览」（它替换整张地图的几何）。
// 铺码（tag-create）与点位调整（tag-position）只影响二维码，不锁路径编辑。
const orthogonalDraft=computed(()=>orthogonalPreviewActive.value&&mapDraftSource.value==='orthogonal');
const routeLocked=computed(()=>busy.value||robot.value.running||commandFeedback.value?.state==='waiting'||orthogonalDraft.value);
// 间距调整期间禁止的是会同时写地图/版本的动作，不是路径点编辑本身。
const spacingBusy=computed(()=>tagPositionEditing.value);
// 每一步改动都同时压进「会话撤销栈」与旧的 routeHistory。
// 旧栈只有 anchors、没有 redo；会话栈是真正的双栈（Ctrl+Z / Ctrl+Shift+Z）。
function snapshotRoute():RouteSnapshot{
 return {
  anchors:routeAnchors.value.map(point=>({...point})),
  modes:routeModes.value.map(choice=>({...choice})),
  selected:routeSelected.value,
  skipped:routeSkippedHold.value.map(tag=>({...tag})),
 };
}
function restoreRouteSnapshot(snapshot:RouteSnapshot){
 routeAnchors.value=snapshot.anchors.map(point=>({...point}));
 routeModes.value=snapshot.modes.map(choice=>({...choice}));
 routeSelected.value=snapshot.selected;
 routeSkippedHold.value=snapshot.skipped.map(tag=>({...tag}));
}
// ===== 撤销/重做：在改动点成对记录 =====
// 诊断结论：撤销那一刻的 routeAnchors 已被几何面板的 re-seed 回退，
// 所以「用当前状态当重做目标」不可靠。改成每次改动都同时记下 before/after。
interface RouteEditPair{before:RouteSnapshot;after:RouteSnapshot}
const routeUndoPairs=ref<RouteEditPair[]>([]);
// 画布上刚连出来的那条有向边，等用户在拓扑面板确认。它只是**待确认的声明**，
// 不进撤销栈、不改折线、更不解锁执行。
const pendingConnect=ref<{fromId:number;toId:number}|null>(null);
// 拓扑面板按 motionSegments 还原「未保存时的拓扑」。本地一改折线，旧拓扑就过期了，
// 递增这个 epoch 让面板重新读一次，而不是让用户看着一张与画布不符的图去保存。
const routeTopologyEpoch=ref(0),routeTopologyDirty=ref(false);
const routeRedoPairs=ref<RouteEditPair[]>([]);
function commitRouteEdit(mutate:()=>void){
 const before=snapshotRoute();
 mutate();
 const after=snapshotRoute();
 routeUndoPairs.value=[...routeUndoPairs.value.slice(-99),{before,after}];
 // 拓扑草稿未保存时不能重挂面板：那会静默丢掉用户刚改的边/策略。
 if(!routeTopologyDirty.value)routeTopologyEpoch.value+=1;
 routeRedoPairs.value=[];
 editorSession.markDirty();
}
function rememberRoute(){
 routeSkippedHold.value=[];
 // 旧历史仅保留为「进入编辑时已有基线」的标记，不再参与撤销/重做。
 routeHistory.value=[...routeHistory.value.slice(-99),routeAnchors.value.map(p=>({...p}))];
 routePolicyHistory.value=[...routePolicyHistory.value.slice(-99),routeModes.value.map(choice=>({...choice}))];
 editorSession.pushSnapshot('路径改动',snapshotRoute());
}
const canUndoEdit=computed(()=>routeUndoPairs.value.length>0);
const canRedoEdit=computed(()=>routeRedoPairs.value.length>0);
// 撤销/重做只回放「成对快照」，不依赖撤销那一刻的实时状态：
// 诊断显示加点后 anchors 会在一个 tick 内被重置回旧值，而 DOM 还显示新值，
// 于是「以当前状态当重做目标」会记错。成对记录从根上避开这个问题。
function undoEdit(){
 if(routeLocked.value)return;
 const pair=routeUndoPairs.value.at(-1);
 if(!pair)return;
 routeUndoPairs.value=routeUndoPairs.value.slice(0,-1);
 routeRedoPairs.value=[...routeRedoPairs.value,{before:pair.before,after:pair.after}];
 restoreRouteSnapshot(pair.before);
 editorSession.markDirty();
}
function redoEdit(){
 if(routeLocked.value)return;
 const pair=routeRedoPairs.value.at(-1);
 if(!pair)return;
 routeRedoPairs.value=routeRedoPairs.value.slice(0,-1);
 routeUndoPairs.value=[...routeUndoPairs.value,{before:pair.before,after:pair.after}];
 restoreRouteSnapshot(pair.after);
 editorSession.markDirty();
}
/**
 * 进入路径编辑时**临时**收起全局导航（把宽度让给画布），退出时恢复用户原选择。
 * 用独立的 `sidebarBeforeRouteEdit` 记录进入前的状态，绝不覆盖用户的持久偏好。
 */
let sidebarBeforeRouteEdit:boolean|null=null;
function enterRouteLayout(){
 if(sidebarBeforeRouteEdit!==null)return;
 sidebarBeforeRouteEdit=sidebarCollapsed.value;
 sidebarCollapsed.value=true;
}
// ===== 退出路径编辑的未保存草稿保护 =====
// 旧实现直接 editingRoute.value=false，草稿被静默丢弃（没有任何提示）。
// 这里对齐「未保存就退出要确认」的通用编辑惯例：
//   - 没有任何未保存改动 → 直接退出；
//   - 有未保存改动 → 弹出确认，用户明确选择「放弃并退出」才丢弃。
const routeExitConfirm=ref(false);
// 只读调试钩子：让回归测试能核对「未保存改动」判定，而不是靠猜。
watch(()=>editorSession.dirty.value,d=>{if(typeof document!=='undefined')document.documentElement.dataset.editorDirty=d?'1':'0';},{immediate:true});
function requestExitRoute(){
 if(!editingRoute.value)return;
 if(!editorSession.dirty.value){editingRoute.value=false;message.value='';return;}
 routeExitConfirm.value=true;
}
function confirmExitRoute(){
 routeExitConfirm.value=false;
 editingRoute.value=false;message.value='';
}
function cancelExitRoute(){routeExitConfirm.value=false;message.value='已保留当前草稿';}
function exitRouteLayout(){
 if(sidebarBeforeRouteEdit===null)return;
 sidebarCollapsed.value=sidebarBeforeRouteEdit;
 sidebarBeforeRouteEdit=null;
}
// 唯一收口：无论从哪个按钮/快捷键退出路径编辑，都恢复用户进入前的导航栏状态。
// 分散在 6 个退出点各写一行一定会漏，漏掉就把用户的导航栏永久收起了。
watch(editingRoute,active=>{
 if(active)enterRouteLayout();else exitRouteLayout();
});
function beginRoute(){
 if(!field.value||routeLocked.value)return;
 orthogonalPreviewMap.value=null;
 routeDetailsOpen.value=false;tagInspectorVisible.value=false;
 const selectedRoute=routes.value.find(route=>route.routeId===selectedRouteId.value);routeModes.value=choicesFromSegments(selectedRoute?.motionSegments??field.value.motionSegments??[]);spacingOverrides.value=selectedRoute?.spacingOverrides?.map(item=>({...item}))??[];spacingFrom.value=null;spacingTo.value=null;spacingTargetM.value=null;routePolicyHistory.value=[];inspectedTagId.value=null;selectedSegmentKey.value='';
 routeTool.value='select';measuring.value=false;clearMeasurement();routeSelected.value=-1;routeHistory.value=[];routeSkippedHold.value=[];
 routeEditId.value=selectedRoute?.routeId??'';routeEditUpdated.value=selectedRoute?.updated??'';const row=field.value.rows[0],points=selectedRoute?.points??(row?[exitPoint(row),...row.points]:[]);routeNameDraft.value=selectedRoute?.name??row?.name??field.value.name;
 // 进入编辑即建立撤销基线：第一次改动就能 Ctrl+Z 回退，且这次回退可重做。
 editorSession.reset();
 const orthogonal=points.every((p,i)=>!i||Math.abs(p.x-points[i-1]!.x)<1e-8||Math.abs(p.y-points[i-1]!.y)<1e-8);
 routeAnchors.value=orthogonal?routeCorners(points):[];
 const storedHeading=selectedRoute?.initialHeadingRad;
 initialHeadingManual.value=typeof storedHeading==='number'&&Number.isFinite(storedHeading);
 bodyYawDeg.value=initialHeadingManual.value?Math.round(norm360(storedHeading!*180/Math.PI)*100)/100:firstLegHeadingDeg(routeAnchors.value);
 editingRoute.value=true;error.value='';message.value=orthogonal?'可拖动路点调整路径，或单击地图追加路点':'单击地图设计新路径；原示教路线保留至保存成功';
}
function uniqueRouteName(base:string){
 const mapId=field.value?.id??'';
 const names=new Set(routes.value.filter(route=>route.mapId===mapId).map(route=>route.name));
 if(!names.has(base))return base;
 let index=2;while(names.has(`${base} ${index}`))index+=1;
 return `${base} ${index}`;
}
/**
 * 进入「地图可编辑、但还没有路线」的统一工作区。
 * 不创建任何生产路线；画布可铺码/调点位/测距，用户点「新建路径」才真正开始一条路径。
 */
function beginEmptyRouteWorkspace(){
 orthogonalPreviewMap.value=null;
 routeDetailsOpen.value=false;tagInspectorVisible.value=false;
 routeModes.value=[];spacingOverrides.value=[];routeHistory.value=[];routeSelected.value=-1;
 routeSkippedHold.value=[];routeEditId.value='';routeEditUpdated.value='';
 routeAnchors.value=[];
 editorSession.reset();
}
/** 扫描页唯一的手动入口：进入统一工作区（地图与路径编辑）。 */
function openUnifiedEditor(){
 if(routeLocked.value){
  message.value=busy.value?'正在处理中，请稍候':'当前状态不可编辑：请先停止导航或等待指令完成';
  return;
 }
 enterRouteEditing();
}
function beginNewRoute(){
 if(!field.value||routeLocked.value)return;
 orthogonalPreviewMap.value=null;
 routeModes.value=[];routePolicyHistory.value=[];inspectedTagId.value=null;tagInspectorVisible.value=false;selectedSegmentKey.value='';
 routeDetailsOpen.value=false;
 // 默认落在「选择」而不是「加点」：用户进路径编辑的第一件事通常是选中/拖动已有对象，
 // 默认加点会让每次点击都变成追加路点，表现就是「点不进去、选不中」。
 routeTool.value='select';measuring.value=false;clearMeasurement();routeSelected.value=-1;routeHistory.value=[];routeSkippedHold.value=[];routeEditId.value='';routeEditUpdated.value='';routeAnchors.value=[];initialHeadingManual.value=false;bodyYawDeg.value=0;routeNameDraft.value=uniqueRouteName(field.value.name+'新路径');editingRoute.value=true;error.value='';message.value='新建路径：先点「加点」再单击地图追加路点，或点「生成路径」自动铺路';
}
function autoChainRoute(){
 if(!editingRoute.value||routeLocked.value)return;
 const chain=routeChain.value;
 if(chain.problem){error.value=chain.problem;return;}
 if(new Set(chain.nodes.map(node=>node.id)).size<2){error.value='可用定位组不足两个，请沿码连线绘制路径';return;}
 if(chain.points.length>501){error.value='自动串码后的控制点超过501个，请拆分路线';return;}
 const skipped=routeSkipped.value;commitRouteEdit(()=>{routeAnchors.value=chain.points.map(point=>({...point}));routeSkippedHold.value=skipped;routeSelected.value=-1;});error.value='';
 message.value=`已自动串起 ${new Set(chain.nodes.map(node=>node.id)).size} 个定位组 · 每到下一码纠正一次 · 跳过 ${routeSkipped.value.length} 个偏离码`;
}
function appendRoute(point:Point){
 // 临时观测点（验证后移除）
 if(typeof window!=='undefined'){const w=window as any;(w.__appendLog??=[]).push({p:{x:point.x,y:point.y},editing:editingRoute.value,locked:routeLocked.value,tool:routeTool.value,len:routeAnchors.value.length,last:routeAnchors.value.at(-1)?{x:routeAnchors.value.at(-1)!.x,y:routeAnchors.value.at(-1)!.y}:null});}
 if(!editingRoute.value||!field.value||routeLocked.value)return;
 // 只有「添加路径点」模式才在空白处追加路点；「选择」模式只用于拖动和点选。
 if(routeTool.value!=='draw')return;
 const p=snapRoutePoint(point,field.value.tags);
 if(routeAnchors.value.length&&distance(routeAnchors.value.at(-1)!,p)<.001)return;
 if(routeDrawing.value.length>=499){error.value='路径控制点过多，请先删除部分路点';return;}
 commitRouteEdit(()=>{routeAnchors.value=[...routeAnchors.value,p];routeSelected.value=routeAnchors.value.length-1;});
}
function moveRoute(index:number,point:Point){
 if(!editingRoute.value||routeLocked.value||!field.value)return;
 const p=snapRoutePoint(point,field.value.tags);
 if(!routeAnchors.value[index]||distance(routeAnchors.value[index]!,p)<1e-8)return;
 commitRouteEdit(()=>{routeAnchors.value=routeAnchors.value.map((old,i)=>i===index?p:old);routeSelected.value=index;});
}
function deleteRoute(){if(routeLocked.value||routeSelected.value<0)return;commitRouteEdit(()=>{routeAnchors.value=routeAnchors.value.filter((_,i)=>i!==routeSelected.value);routeSelected.value=-1;});}
function undoRoute(){if(routeLocked.value)return;routeSkippedHold.value=[];const previous=routeHistory.value.at(-1);if(!previous)return;routeAnchors.value=previous;routeHistory.value=routeHistory.value.slice(0,-1);routeModes.value=routePolicyHistory.value.at(-1)??[];routePolicyHistory.value=routePolicyHistory.value.slice(0,-1);routeSelected.value=-1;}
function clearRoute(){if(routeLocked.value||!routeAnchors.value.length)return;commitRouteEdit(()=>{routeAnchors.value=[];routeSelected.value=-1;});}
function blockNumericWheel(event:WheelEvent){if(event.target instanceof HTMLInputElement&&event.target.type==='number')event.preventDefault();}
// ===== 路径编辑工具条接线（App 是唯一持有业务状态的地方）=====
/** 右侧属性区是否展开（独立于旧的右栏，路径编辑态用它显示选中对象属性）。 */
/** 逐项禁用：只禁用当前确实不可用的动作，不整体锁死工具条。 */
const routeToolbarDisabled=computed<Record<string,boolean>>(()=>({
 measure:!field.value||field.value.tags.length<2,
 'delete-selected':routeSelected.value<0,
 'clear':!routeAnchors.value.length,
 'delete-point':routeSelected.value<0,
 'delete-route':!routeEditId.value,
 'save-as':!field.value,
 'auto-chain':routeDrawing.value.length<2,
 'generate-route':!field.value,
}));
function onToolbarTool(id:'select'|'draw'|'connect'|'pan'){
 setRouteTool(id);
}
function onToolbarAction(id:string){
 switch(id){
  case 'measure': toggleMeasurement(); break;
  case 'undo': undoEdit(); break;
  case 'redo': redoEdit(); break;
  case 'save': void saveRoute(false); break;
  case 'exit': editingRoute.value=false;message.value=''; break;
  case 'properties': routeInspectorOpen.value=!routeInspectorOpen.value; break;
  case 'clear': clearRoute(); break;
  case 'delete-selected': deleteRoute(); break;
  case 'delete-point': deleteRoute(); break;
  case 'delete-route': void deleteNamedRoute(); break;
  case 'save-as': void saveRoute(true); break;
  case 'auto-chain': autoChainRoute(); break;
  case 'generate-route': generateRouteFromRows(); break;
  default: break;
 }
}
// ===== 路径工具面板（RouteToolsPanel）接线 =====
/** 分组展开状态：默认展开「路径编辑」与「路线拓扑」。
    拓扑是路径编辑的核心对象（有向区间/待确认边/策略），默认收起会把核心功能藏起来；
    点位与铺码、步骤属于按需展开项。 */
const routePanelOpenGroups=ref<string[]>(['map','route','tags','topology']);
/** 有待确认的有向边时，拓扑组必须强制展开：它是安全状态，不能被折叠藏起来。 */

const routePanelRequiredGroups=computed<string[]>(()=>pendingConnect.value?['topology']:[]);

function onRoutePanelGroupToggle(payload:{id:string;collapsed:boolean}){
 const set=new Set(routePanelOpenGroups.value);
 if(payload.collapsed)set.delete(payload.id);else set.add(payload.id);
 routePanelOpenGroups.value=[...set];
}
/** 始终可见的警示：只放真实错误与安全约束，不放说明文字。 */
/** 当前选中的对象（路点优先）。没有选中时返回 null，inspector 自动收起。 */
const routeSelectedObject=computed(()=>{
 const index=routeSelected.value;
 const row=index>=0?stepRows.value[index]:undefined;
 if(row){
  return {kind:'waypoint' as const,index:row.index,coord:row.coord,qrLabel:row.qrLabel==='—'?'':row.qrLabel,
   type:row.type,speedMps:row.speedMps,lengthM:row.lengthM,blocked:row.blocked};
 }
 if(inspectedTagId.value!==null){
  const tag=field.value?.tags.find(item=>item.id===inspectedTagId.value);
  if(tag)return {kind:'tag' as const,index:tag.id,coord:`${tag.x.toFixed(2)}, ${tag.y.toFixed(2)}`,
   qrLabel:tagLabel(tag),type:'',speedMps:undefined,lengthM:0,blocked:false};
 }
 return null;
});

// 共用按需属性区：选中二维码或路点就显示对应属性，没有选中对象时自动收起。
// 用户仍可用工具条的「属性」按钮手动关/开，但默认跟随选中对象。
/** 当前打开的地图工具：null=只显示 6 个紧凑按键；点开后才渲染对应面板。 */
const mapTool=ref<'position'|'single'|'grid'|'line'|'table'|'spacing'|null>(null);

/**
 * 点紧凑按键 → 直接进入对应功能（不要求再点一次「开始」）。
 * 复用各面板已暴露的 start/activate，与面板内按钮走同一条路径，不新增保存链。
 */
function openMapTool(tool:'position'|'single'|'grid'|'line'|'table'|'spacing'){
 if(mapTool.value===tool){mapTool.value=null;return;}
 mapTool.value=tool;
 mapToolSwitchAt=Date.now();
 // 面板渲染由 mapTool 决定；下面只是「顺手自动进入」，即使 ref 未就绪，
 // 面板仍会渲染出来，用户可以直接点面板内的「开始」，不会出现点了没反应。
 // 面板是 v-if 渲染，ref 要等两拍（渲染 + 挂载）才可用。
 void nextTick(()=>nextTick(()=>{
  const create=tagCreatePanel.value as unknown as {beginWith?:(m?:string)=>void}|null;
  const table=tagTablePanel.value as unknown as {start?:()=>void}|null;
  const position=tagPositionPanel.value as unknown as {activate?:()=>void}|null;
  if(tool==='position')position?.activate?.();
  else if(tool==='table')table?.start?.();
  else if(tool==='single'||tool==='grid'||tool==='line')create?.beginWith?.(tool);
  else if(tool==='spacing')focusRouteToolCard('route-spacing-card');
 }));
 // 切到「非铺码」工具时，主动退出铺码编辑态，避免 tagCreateEditing 残留把界面锁住。
 if(tool!=='single'&&tool!=='grid'&&tool!=='line'){
  const create=tagCreatePanel.value as unknown as {deactivate?:()=>void}|null;
  create?.deactivate?.();
 }
}
/** 面板退出/取消后回到紧凑按钮组。 */
function closeMapTool(){mapTool.value=null;}
const routeInspectorUserClosed=ref(false);
const routeInspectorOpen=computed<boolean>({
 get:()=>!!routeSelectedObject.value&&!routeInspectorUserClosed.value,
 set:(value)=>{routeInspectorUserClosed.value=!value;},
});
watch(()=>{
 const target=routeSelectedObject.value;
 return target?target.kind+':'+target.index:null;
},key=>{
 // 换选中对象视为新的查看意图：自动展开
 if(key)routeInspectorUserClosed.value=false;
});
const routePanelNotices=computed(()=>{
 const list:{id:string;level:'info'|'warning'|'error';text:string}[]=[];
 if(routeLocked.value)list.push({id:'locked',level:'warning',text:'当前不可编辑：导航运行中或存在未完成的指令'});
 if(stepBlockedCount.value)list.push({id:'blocked',level:'warning',text:stepBlockedCount.value+' 个步骤存在阻断项，保存会被后端安全门拒绝'});
 if(editorModeNotice.value)list.push({id:'mode',level:'error',text:editorModeNotice.value});
 return list;
});
/**
 * 展开/收起步骤时，把 EditorShell 的底部面板高度同步到面板实际需要的高度。
 * 这样「画布让位、面板完整在视口内」，而不是把面板顶出屏幕。
 */
function syncRouteStepsBottomHeight(){
 const api=editorShell.value?.api;
 if(!api)return;
 if(!routeStepsOpen.value){
  // 收起：只保留触发器那一行。
  api.setBottomHeight?.(56);
  return;
 }
 // 展开：触发器 44 + 分隔条 8 + 面板高度 + 余量。
 api.setBottomHeight?.(Math.round(routeStepsDockHeight.value+64));
}
watch([routeStepsOpen,routeStepsDockHeight],()=>{void nextTick(syncRouteStepsBottomHeight);});function closeRouteSteps(){routeStepsOpen.value=false;}
/**
 * 「点外部关闭路径步骤」。
 *
 * 历史实现只把 popover / trigger / 画布算作内部区域。本轮把步骤面板改成
 * **停靠式**后新增了 `route-steps-dock` 与 `route-steps-resize-bar`，它们位于
 * popover 之外——于是「按下分隔条准备拖动」会被判定为外部点击，
 * 面板立刻被关掉（表现为 dock display:none、关闭按钮 rect 归零、用户点不到）。
 *
 * 现在内部区域包含：整个 dock（含分隔条与头部）、触发器、画布；
 * 并且**拖动调整高度期间一律不关闭**（拖动中指针可能短暂离开这些节点）。
 */
function routeStepsPointer(event:PointerEvent){
 if(!routeStepsOpen.value)return;
 // 正在拖分隔条/拖标题：期间不响应外部点击关闭。
 if(routeStepsDockDrag||routeStepsDrag||routeStepsResize)return;
 const target=event.target;
 if(!(target instanceof Element))return;
 const inside=target.closest('[data-testid=route-steps-dock],[data-testid=route-steps-popover],[data-testid=route-steps-trigger],[data-testid=route-steps-resize-bar],[data-testid=map-canvas]');
 if(!inside)closeRouteSteps();
}
function routeKey(event:KeyboardEvent){
 if(event.key==='Escape'&&routeStepsOpen.value){event.preventDefault();closeRouteSteps();return;}
 if(!editingRoute.value||routeLocked.value||event.target instanceof HTMLElement&&(event.target.matches('input,textarea,select')||event.target.isContentEditable))return;
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();undoRoute();}
 else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();deleteRoute();}
}
async function deleteNamedRoute(){const route=routes.value.find(item=>item.routeId===(routeEditId.value||selectedRouteId.value));if(!route){error.value='请先选择要删除的路径';return;}await askDeleteRoute(route);}
async function saveRoute(saveAs=false){await act(async()=>{
 if(!field.value||!editingRoute.value)return;
 if(orthogonalDraft.value)throw new Error('正交校正预览中，请先应用或撤销预览再保存路径');
 if(tagCreateEditing.value)throw new Error('正在批量铺码，请先点「退出」再保存路径');
 if(tagPositionEditing.value&&mapDraftSource.value==='tag-position')throw new Error('正在调整二维码位置，请先退出再保存路径');
 if(tagPositionEditing.value)throw new Error('正在调整二维码间距，请先点「退出」再保存路径');
 if(routeAnchors.value.length>=2&&!Number.isFinite(bodyYawDeg.value))throw new Error('请先设置有效的初始车头朝向（0–359°）');
 const invalid=routePlans.value.find(plan=>plan.problem);if(invalid)throw new Error(invalid.problem);
 const orthogonalPoints=routeDrawing.value;
 for(let i=1;i<orthogonalPoints.length;i++){const a=orthogonalPoints[i-1]!,b=orthogonalPoints[i]!;
  if(Math.abs(a.x-b.x)>1e-6&&Math.abs(a.y-b.y)>1e-6)throw new Error('路径必须由水平/垂直直线段组成；斜线段请先在画布上正交拆分（拖动路点会自动正交）');
 }
 const skippedCount=routeSkipped.value.length;const initialHeadingDeg=wrapDeg180(bodyYawDeg.value);const payload:any={mapId:field.value.id,baseVersion:version.value,points:orthogonalPoints,bodyYawDeg:initialHeadingDeg,initialHeadingRad:initialHeadingManual.value?initialHeadingDeg*Math.PI/180:null,routeName:routeNameDraft.value.trim()||uniqueRouteName(field.value.name+'新路径'),segmentModes:routePlans.value.filter(plan=>plan.mode!=='auto').map(({fromId,toId,occurrence,mode})=>({fromId,toId,occurrence,mode})),distanceModel:'center-euclidean',spacingOverrides:spacingOverrides.value};if(routeEditId.value){payload.routeId=routeEditId.value;payload.routeUpdated=routeEditUpdated.value;}if(saveAs||!routeEditId.value)payload.saveAs=true;
 const result=await api('/route/design',payload);selectMap(result);await refresh();selectedRouteId.value=result.route?.routeId??'';selectedTask.value=result.task?.id??selectedTask.value;selectedMapId.value=field.value.id;
 if(result.route){routeEditId.value=result.route.routeId;routeEditUpdated.value=result.route.updated;routeNameDraft.value=result.route.name;routeModes.value=result.route.motionSegments?choicesFromSegments(result.route.motionSegments):[];}
 editingRoute.value=false;
 const trim=result.trimmed.startM+result.trimmed.endM;message.value=`路径已保存 · 经过 ${new Set(result.map.motionSegments.flatMap((s:any)=>[s.fromId,s.toId])).size} 个定位组 · 每到下一码纠正一次 · 跳过 ${Math.max(skippedCount,result.routeGroups?.skipped.length??0)} 个偏离码`+(trim>.001?` · 已截去定位组外 ${trim.toFixed(2)} m`:'');
 if(savedStrategyBlockers.value.length)message.value='路径规划已保存 · '+savedStrategyBlockers.value[0];
 });}

watch(()=>field.value?.id,id=>{void loadTagAliases(id??'');},{immediate:true});
// 切换地图 → 退出编辑并清理（地图变了，旧草稿不能套到新地图上）。
// 但**单纯切页面**不再强制退出编辑：统一工作区进入时会把 page 设为 navigate，
// 若仍在此处清空 editingRoute，路径编辑会被自己刚打开的页面立刻关掉（实测进不去）。
// 切换地图 → 清理旧草稿，但**留在统一工作区**：新建空图后正是要继续铺码，
// 若把 editingRoute 置 false，刚新建完的地图就被弹出编辑器（实测工具条/面板消失）。
// 真正的退出只由「退出」按钮、主导航其它页、打印入口负责。
watch(()=>field.value?.id,()=>{routeSelected.value=-1;routeStepsOpen.value=false;inspectedTagId.value=null;tagInspectorVisible.value=false;orthogonalPreviewMap.value=null;mapDraftSource.value=null;tagPositionEditing.value=false;spacingSelectedIds.value=[];routeAnchors.value=[];routeEditId.value='';routeEditUpdated.value='';routeHistory.value=[];});
// 退出路径编辑时必须一并退出间距调整，否则面板与锁会残留到下一次进入。
// 退出统一编辑工作区 → 回到导航消费场景：按既有路径补一次 scope 同步，
// 保证编辑期间选的图在回到导航页后仍会切定位（与原行为一致，不新增/绕过门禁）。
// 地图工具面板退出后回到紧凑按钮组。
// 注意：切换工具时也会出现「三个 flag 同时为 false」的瞬时状态，
// 不能在那一刻清空 mapTool，否则新工具的面板还没渲染就被收起。
// 因此这里只在「用户是在同一个工具内点退出」时回落：
// 记录最近一次 openMapTool 的时间戳，切换窗口内（400ms）不回落。
let mapToolSwitchAt=0;
watch([tagCreateEditing,tagPositionEditing,tagTableEditing],([c,p,t])=>{
 if(!mapTool.value||mapTool.value==='spacing')return;
 if(Date.now()-mapToolSwitchAt<400)return;
 if(!c&&!p&&!t)mapTool.value=null;
});
watch(()=>editingRoute.value,active=>{
 if(!active)void syncLocalizationScope();
});
watch(()=>editingRoute.value,active=>{if(!active&&tagPositionEditing.value){tagPositionEditing.value=false;spacingSelectedIds.value=[];orthogonalPreviewMap.value=null;mapDraftSource.value=null;}});
onMounted(()=>{window.addEventListener('keydown',routeKey);window.addEventListener('wheel',blockNumericWheel,{passive:false});document.addEventListener('pointerdown',routeStepsPointer);});
onBeforeUnmount(()=>{window.removeEventListener('keydown',routeKey);window.removeEventListener('wheel',blockNumericWheel);document.removeEventListener('pointerdown',routeStepsPointer);});
const canNavigate=computed(()=>{if(editingRoute.value||orthogonalPreviewActive.value||speedDirty.value||savedStrategyBlockers.value.length||lateralStrategyBlocked.value)return false;const task=tasks.value.find(t=>t.id===selectedTask.value);return !!task&&task.mapId===field.value?.id&&task.mapVersion===version.value&&field.value?.captureQuality!=='draft'&&robot.value.connected&&robot.value.localization?.mapId===field.value?.id&&robot.value.localization?.mapVersion===version.value&&robot.value.localization?.poseAvailable===true&&!robot.value.running&&robot.value.conditions.length>0&&robot.value.conditions.every((c:any)=>c.ready);});
// 多张地图共用同一批物理二维码时，定位作用域必须跟着"当前选中的地图"走，否则切换后
// 定位仍锚在旧图上，界面只能显示"当前定位属于其他地图"并永久卡住。这里不依赖任务/验收：
// 选图即切换定位，切完等待该地图的二维码重新锚定；能否开始导航仍由 canNavigate 与后端门禁把关。
type ScopePhase='idle'|'switching'|'waiting'|'anchored'|'blocked';
const localizationScope=ref<{phase:ScopePhase;mapId:string;version:number;message:string}>({phase:'idle',mapId:'',version:0,message:''});
let scopeSeq=0;
async function waitScopeAnchored(mapId:string,version:number,seq:number){
 for(let attempt=0;attempt<40;attempt++){
  await new Promise(resolve=>setTimeout(resolve,500));
  if(seq!==scopeSeq)return;
  try{
   const state:any=await api('/localization/scope?mapId='+encodeURIComponent(mapId)+'&version='+version);
   if(seq!==scopeSeq)return;
   if(state.phase==='anchored'){localizationScope.value={phase:'anchored',mapId,version,message:'定位已锚定到当前地图 v'+version};return;}
   if(state.phase==='waiting-anchor'){localizationScope.value={phase:'waiting',mapId,version,message:'已切换到当前地图 v'+version+'，等待二维码重新锚定'};continue;}
   localizationScope.value={phase:'switching',mapId,version,message:'正在切换定位到当前地图 v'+version};
  }catch{/* 轮询失败保持上一状态，绝不把未锚定显示成已锚定 */}
 }
}
async function syncLocalizationScope(){
 const map=field.value;if(!map||!robot.value.connected||robot.value.running)return;
 const mapId=map.id,mapVersion=version.value;
 if(localizationScope.value.mapId===mapId&&localizationScope.value.version===mapVersion&&localizationScope.value.phase==='anchored')return;
 const seq=++scopeSeq;
 try{
  await api('/localization/map',{mapId,version:mapVersion});
  if(seq!==scopeSeq)return;
  localizationScope.value={phase:'switching',mapId,version:mapVersion,message:'正在切换定位到当前地图 v'+mapVersion};
  void waitScopeAnchored(mapId,mapVersion,seq);
 }catch(error){
  if(seq!==scopeSeq)return;
  localizationScope.value={phase:'blocked',mapId,version:mapVersion,message:String((error as Error)?.message??error)};
 }
}
// 恢复既有契约：导航页（非统一编辑工作区）在「选图 / 版本 / 连接状态」变化时同步定位 scope，
// 与改动前完全一致——这是导航消费者的既有行为，不在本轮授权范围内改动。
// 唯一的收窄：统一编辑工作区（editingRoute）内的选图属于**编辑消费者**，不触发定位切换，
// 避免只读铺码/画路径把机器人定位范围切走。离开编辑回到导航页后，下面的 watch 会按原路径补同步。
watch([()=>field.value?.id,()=>version.value,()=>robot.value.connected],()=>{
 if(editingRoute.value)return;
 void syncLocalizationScope();
});
const pendingConditions=computed(()=>robot.value.conditions.filter((condition:any)=>!condition.ready));
const diagnosticsSummary=computed(()=>!robot.value.connected?'设备离线':!robot.value.conditions.length?'等待设备状态':pendingConditions.value.length?`${pendingConditions.value.length} 项待恢复`:'设备正常');
const navigationBlockReason=computed(()=>{
 if(robot.value.running||canNavigate.value)return '';
 if(tagPositionEditing.value)return '二维码位置调整中，请先保存为新版本或退出调整';
 if(orthogonalPreviewActive.value)return '正交校正预览中，请应用或撤销预览后再继续';
 if(editingRoute.value)return '请保存路径或退出编辑后再开始导航';
 const task=tasks.value.find(t=>t.id===selectedTask.value);
 if(!task)return field.value?(availableRoutes.value.length?'请选择执行路径':'地图已保存，尚未创建路径；请先新建路径'):'请选择导航地图';
 if(speedDirty.value)return '请先保存速度设置';
 if(savedStrategyBlockers.value.length)return savedStrategyBlockers.value[0];
 if(lateralStrategyBlocked.value)return '横移能力尚未由当前导航节点确认，禁止执行显式平移策略';
 if(task.mapId!==field.value?.id||task.mapVersion!==version.value)return '所选任务与当前地图不一致，请重新选择';
 if(field.value?.captureQuality==='draft')return '该地图是临时采集草稿，请完成正式扫描后再导航';
 if(!robot.value.connected)return '等待导航服务连接';
 const scope=robot.value.localization;
 if(!scope||scope.mapId!==field.value.id||scope.mapVersion!==version.value)return localizationScope.value.message||'正在切换定位到当前地图，等待定位锚定';
 if(scope.poseAvailable!==true)return '已切换到当前地图，等待二维码重新锚定';
 if(!robot.value.conditions.length)return '等待设备状态';
 const labels=pendingConditions.value.map((condition:any)=>String(condition.label));
 return labels.length?`等待${labels.slice(0,2).join('、')}${labels.length>2?`等 ${labels.length} 项恢复`:''}`:'';
});
function connect(){if(closed)return;socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);socket.onopen=()=>connected.value=true;socket.onmessage=e=>{const data=JSON.parse(e.data);if(data.type==='robot'){robotReceivedClock.value=performance.now();poseClock.value=robotReceivedClock.value;robot.value=data.status;}};socket.onclose=()=>{connected.value=false;if(!closed)reconnect=setTimeout(connect,2000);};}
async function pollSession(){
 if(polling||busy.value||!session.value||page.value!=='scan')return;
 polling=true;const id=session.value.id,epoch=sessionEpoch,wasCollecting=session.value.state==='collecting';
 const stillSelected=()=>!closed&&!busy.value&&sessionEpoch===epoch&&session.value?.id===id&&page.value==='scan';
 try{
  // 轮询也必须有上界：采集中的会话 detail 可能很大，不能让它把定时器占住。
  const result=await api('/surveys/'+id,undefined,'GET',undefined,6000);if(!stillSelected())return;
  if(wasCollecting&&result.state==='stopped'){
   const records:SurveySummary[]=await api('/surveys');if(!stillSelected())return;
   sessions.value=records;
   if(result.stop_reason)error.value=result.stop_reason;
   else message.value='本次扫描已保存，路径和定位组已保留';
  }
  session.value=result;
 }catch{/* Leave a collecting selection intact so a failed continuation lookup can retry. */}
 finally{polling=false;}
}
const pageContent:Record<ConsolePage,{title:string;description:string}>={
 scan:{title:'扫描建图',description:''},
 navigate:{title:'导航监控',description:''},
 print:{title:'二维码 PDF',description:''},

 calibration:{title:'融合标定',description:''}
};
// 路径编辑控制台：所有数值都从 routeAnchors / routePlans / 当前任务派生，
// 不新增地图写入、不新增运动接口，也不伪造后端没有的字段。
const headingTitle=computed(()=>editingRoute.value?'二维码导航路径编辑':pageContent[page.value].title);
const headingDescription=computed(()=>pageContent[page.value].description);
const groupLabel=(id:number)=>'Q'+String(id).padStart(3,'0');
const nearestGroupId=(point:Point)=>{
 if(!field.value)return null;
 let best:{id:number,d:number}|undefined;
 for(const center of routeGroupCenters(field.value)){const d=distance(point,center);if(!best||d<best.d)best={id:center.id,d};}
 return best&&best.d<=ROUTE_GRID?best.id:null;
};
// 一段的"动作类型"取自真实分段规划：找到终点落在该路点上的那段。
const planArriving=(point:Point)=>routePlans.value.find(plan=>distance(plan.end,point)<=ROUTE_GRID);
// 折返路径里同一个码会重复出现（如 B080→…→B080），坐标完全相同。
// 按坐标 find 会永远命中最前面那一段，导致“改后面一行、前面一行跟着变”。
// 因此按路点索引取段：第 index 个路点由第 index-1 段到达。
const planArrivingAt=(index:number)=>{
 if(index<=0)return undefined;
 const prev=routeAnchors.value[index-1], cur=routeAnchors.value[index];
 if(!prev||!cur)return undefined;
 // 用定位组编号匹配，而不是坐标距离：
 // chainRouteGroups 返回的是投影点，与路点存在毫米~厘米级偏差，
 // 坐标阈值匹配会在 B032→B096 这类长段上失败，导致改不了动作。
 const fromId=nearestGroupId(prev), toId=nearestGroupId(cur);
 const plans=routePlans.value;
 if(fromId!==null&&toId!==null){
  let best:typeof plans[number]|undefined;
  let bestDiff=Number.POSITIVE_INFINITY;
  plans.forEach((plan,i)=>{
   if(plan.fromId!==fromId||plan.toId!==toId)return;
   const diff=Math.abs(i-(index-1));
   if(diff<bestDiff){bestDiff=diff;best=plan;}
  });
  if(best)return best;
 }
 // 编号取不到（路点没吸附到组）时按索引兜底，保证选中/改类型仍有可用段。
 return plans[index-1];
};
const nodeName=(index:number)=>{
 const point=routeAnchors.value[index];if(!point)return '';
 const groupId=nearestGroupId(point);
 return groupId===null?'P'+String(index+1).padStart(2,'0'):groupLabel(groupId);
};
const toolLabel=computed(()=>routeTool.value==='select'?'选择':routeTool.value==='draw'?'加点':routeTool.value==='connect'?'连线':'平移');
const modeShortLabels:Record<string,string>={auto:'自动',forward:'前进',reverse:'倒车',left:'左平移',right:'右平移',turn_forward:'转向前进'};
// 节点属性里的下拉用短标签：左侧「初始车头朝向」定的是车头角度，这里是这一段怎么走，两回事。
const nodeModeOptions=[{value:'auto',label:'自动'},{value:'forward',label:'前进'},{value:'reverse',label:'倒车'},{value:'left',label:'左平移'},{value:'right',label:'右平移'},{value:'turn_forward',label:'转向前进'}] as const;
// 速度/停留都是任务级真实字段：速度按动作类型取对应分量，停留取终点等待时间。
const taskSpeedsMps=computed(()=>({
 forward:Number(speedSettings.value.forwardSpeed)/100,
 reverse:Number(speedSettings.value.reverseSpeed)/100,
 lateral:Number(speedSettings.value.lateralSpeed)/100
}));
const taskDwellS=computed(()=>selectedNavigationTask.value?.endWaitSeconds??0);
function speedForMode(mode?:string){
 return mode==='reverse'?taskSpeedsMps.value.reverse:(mode==='left'||mode==='right')?taskSpeedsMps.value.lateral:taskSpeedsMps.value.forward;
}
// 作业速度以 m/s 编辑，内部仍写回模型规定的 cm/s 字段并复用既有保存接口。
const workSpeedMps=computed({
 get:()=>Number(speedSettings.value.forwardSpeed)/100,
 set:(value:number)=>{if(Number.isFinite(value))speedSettings.value.forwardSpeed=Math.round(value*100);}
});
// 路径指令列表：一行一个路点（步骤），可直接上移 / 下移 / 删除，全部作用于真实路点数组。
// 第 index 个路点由第 index-1 段到达；用定位组编号 + occurrence 定位那一段，
// 折返路径里同一个码重复出现时也不会串到别的行。
function stepPair(index:number):{fromId:number;toId:number;occurrence:number}|null{
 if(index<=0||index>=routeAnchors.value.length)return null;
 const from=nearestGroupId(routeAnchors.value[index-1]!),to=nearestGroupId(routeAnchors.value[index]!);
 if(from===null||to===null)return null;
 let occurrence=0;
 for(let i=1;i<index;i++){
  const a=nearestGroupId(routeAnchors.value[i-1]!),b=nearestGroupId(routeAnchors.value[i]!);
  if(a===from&&b===to)occurrence+=1;
 }
 return {fromId:from,toId:to,occurrence};
}
function choiceForStep(index:number):StrategyMode|undefined{
 const pair=stepPair(index);if(!pair)return undefined;
 return routeModes.value.find(item=>item.fromId===pair.fromId&&item.toId===pair.toId&&item.occurrence===pair.occurrence)?.mode;
}
const stepRows=computed(()=>routeAnchors.value.map((point,index)=>{
 const previous=index>0?routeAnchors.value[index-1]:null;
 const plan=index>0?planArrivingAt(index):undefined;
 const chosen=index>0?choiceForStep(index):undefined;
 const groupId=nearestGroupId(point);
 return{
  key:index,
  index:index+1,
  name:(previous?nodeName(index-1)+' → ':'')+nodeName(index),
  type:plan?(modeShortLabels[plan.effective]??plan.effective):chosen&&chosen!=='auto'?(modeShortLabels[chosen]??chosen):index===0?'起点':'途经点',
  mode:chosen??plan?.mode??'auto',
  coord:point?`${point.x.toFixed(2)}, ${point.y.toFixed(2)}`:'',
  qrLabel:groupId===null?'—':tagLabel({id:groupId}),
  speedMps:speedForMode(plan?.effective),
  lengthM:previous?distance(previous,point):0,
  headingDeg:plan?Math.round(plan.arrivalYaw*180/Math.PI*100)/100:null,
  dwellS:index===routeAnchors.value.length-1?taskDwellS.value:0,
  blocked:!!(plan?.problem||plan?.blocked)
 };
}));
const stepBlockedCount=computed(()=>stepRows.value.filter(row=>row.blocked).length);
/**
 * 路径步骤的整体状态文案。
 *
 * 旧实现只有两态：0 项待处理 → 显示「可执行」。于是「路径步骤 0」也顶着
 * 「可执行」四个字，这在语义上是错的，而且很容易被误读成「实车可执行」。
 *
 * 现在的语义（只描述**路径规划**层面，绝不声称实车可执行）：
 *  - 少于 2 个有效点：`未绘制` / `待添加路点`（没有任何规划）
 *  - 有点但有阻断项：`N 项待处理`
 *  - 至少 2 个有效点且无阻断：`规划通过`
 * 是否真能开动仍由后端编译安全门、定位锚定与设备就绪决定，本状态不绕过任何一道门。
 */
// 用 stepRows（渲染出来的步骤）而不是 routeAnchors 判据：
// 两者可能不同步（切换路径后锚点还在、步骤表已清空），
// 而用户看到的是步骤表——状态必须与它一致，不能一边显示「路径步骤 0」一边说「规划通过」。
const stepValidPointCount=computed(()=>stepRows.value.filter(row=>row.coord&&row.coord!=='—').length);
const stepStatusTone=computed<'muted'|'warning'|'success'>(()=>{
 if(stepValidPointCount.value<2)return 'muted';
 return stepBlockedCount.value?'warning':'success';
});
const stepStatusLabel=computed(()=>{
 if(stepValidPointCount.value===0)return '未绘制';
 if(stepValidPointCount.value<2)return '待添加路点';
 return stepBlockedCount.value?`${stepBlockedCount.value} 项待处理`:'规划通过';
});
/** 仅用于提示语的补充说明，避免用户把「规划通过」当成实车可执行。 */
const stepStatusHint=computed(()=>{
 if(stepValidPointCount.value<2)return '至少需要 2 个有效路点才能形成一段路径';
 return stepBlockedCount.value?'存在阻断项，保存会被后端安全门拒绝':'规划层面无阻断；能否开动仍由编译安全门、定位锚定与设备就绪决定';
});
function reorderAnchors(from:number,to:number){
 if(routeLocked.value||from===to||from<0||to<0||from>=routeAnchors.value.length||to>=routeAnchors.value.length)return false;
 rememberRoute();
 const next=[...routeAnchors.value];
 const [moved]=next.splice(from,1);
 next.splice(to,0,moved!);
 routeAnchors.value=next;
 routeSelected.value=to;
 return true;
}
function moveStepUp(index:number){return reorderAnchors(index,index-1);}
function moveStepDown(index:number){return reorderAnchors(index,index+1);}
// 点选底部某一步：同时选中路点与它对应的那一段，画布上会整段标红。
function selectStep(index:number){
 routeSelected.value=index;
 const point=routeAnchors.value[index];
 const plan=planArrivingAt(index);
 selectedSegmentKey.value=plan?.key??'';
}
function deleteStep(index:number){
 if(routeLocked.value||index<0||index>=routeAnchors.value.length)return;
 rememberRoute();
 commitRouteEdit(()=>{routeAnchors.value=routeAnchors.value.filter((_,i)=>i!==index);});
 routeSelected.value=-1;
}
// 路段距离编辑：改的是**路径锚点**，地图二维码坐标一概不动。
// 落库仍走原有的「保存路径」接口，语义与拖动路点完全一致。
// 注意：stepRows 里的 `index` 是 1-based 的显示序号，`key` 才是 0-based 的路点下标。
// previewLegDistance 要的是 0-based，所以这里一律用 key。
const legDraft=ref<{key:number;text:string}|null>(null);
const legInputText=(row:{key:number;lengthM:number})=>
 legDraft.value&&legDraft.value.key===row.key?legDraft.value.text:row.lengthM.toFixed(2);
const legCmText=(row:{key:number;lengthM:number})=>{
 const raw=legInputText(row);
 const value=Number(raw);
 return Number.isFinite(value)?(value*100).toFixed(0):(row.lengthM*100).toFixed(0);
};
function onLegInput(key:number,raw:string){legDraft.value={key,text:raw};}
function commitLegEdit(key:number){
 const draft=legDraft.value;
 if(!draft||draft.key!==key)return;
 // 无论成功还是失败，草稿都要清掉：失败时输入框必须回到真实路段长度，
 // 绝不能把一个被拒绝的数字留在屏幕上让人以为改成了。
 legDraft.value=null;
 if(routeLocked.value)return;
 const target=Number(draft.text);
 if(!Number.isFinite(target)||target<=0){error.value='路段距离必须是正数（米）';return;}
 const preview=previewLegDistance(routeAnchors.value,key,target);
 if(!preview.ready){error.value=preview.issues.map(issue=>issue.message).join('；')||'该路段距离无法应用';return;}
 rememberRoute();
 routeAnchors.value=preview.anchors.map(point=>({...point}));
 routeSelected.value=key;
 error.value='';
 message.value=`第 ${key+1} 段已改为 ${target.toFixed(2)} m（${(target*100).toFixed(0)} cm）· ${preview.reason}`;
}
// 节点属性里的"动作类型"：直接改真实分段策略，与右侧码间运动策略是同一份数据。
// ===== 快捷键：撤销/重做、删除、Esc、方向键微调、工具切换 =====
// 输入框聚焦时整层短路（useShortcuts 内部 isEditableTarget 已处理），
// 因此在间距/坐标输入框里打字绝不会触发撤销或微调。
const SHORTCUT_TO_MODE:Record<ShortcutTool,EditorMode>={select:'select',pan:'pan',link:'connect',measure:'measure',spacing:'spacing'};
useShortcuts({
 enabled:computed(()=>!busy.value),
 onUndo:()=>{if(editingRoute.value)undoEdit();},
 onRedo:()=>{if(editingRoute.value)redoEdit();},
 onDelete:()=>{if(editingRoute.value&&routeSelected.value>=0)deleteRoute();},
 onEscape:()=>{
  if(gapEdit.value){cancelGapEdit();return;}
  if(measuring.value){measuring.value=false;clearMeasurement();return;}
  if(editorSession.selection.value.length){editorSession.clearSelection();return;}
  // 下拉菜单打开时，Esc 只负责收起菜单（由 EditorMenuBar 处理）。
  // EditorMenuBar 的捕获监听会先 close() 并置位 __dshMenuEscConsumed，
  // 因此这里不能靠「DOM 里还有没有 panel」判断（那时已经关了），要看标记。
  const consumed=(window as unknown as {__dshMenuEscConsumed?:number}).__dshMenuEscConsumed;
  if(typeof consumed==='number'&&Date.now()-consumed<500){
   delete (window as unknown as {__dshMenuEscConsumed?:number}).__dshMenuEscConsumed;
   return;
  }
  if(editingRoute.value){editingRoute.value=false;message.value='';}
 },
 onNudge:(delta)=>{
  if(!editingRoute.value||routeLocked.value||routeSelected.value<0)return;
  const index=routeSelected.value,point=routeAnchors.value[index];
  if(!point)return;
  rememberRoute();
  // 屏幕向上是 -y，而地图坐标 +y 向上，所以 dy 取反。
  const moved={x:point.x+delta.dx,y:point.y-delta.dy};
  routeAnchors.value=routeAnchors.value.map((old,i)=>i===index?snapRoutePoint(moved,field.value?.tags??[]):old);
 },
 onToolChange:(tool)=>{
  if(!editingRoute.value)return;
  setEditorMode(SHORTCUT_TO_MODE[tool]);
 },
 onTemporaryPan:(active)=>{
  if(active)editorSession.beginTemporaryPan();
  else editorSession.endTemporaryPan();
 },
});
function setStepMode(index:number,mode:StrategyMode){
 const point=routeAnchors.value[index];if(!point)return;
 if(routeLocked.value)return;
 const plan=planArrivingAt(index);
 if(plan){changeSegmentMode(plan,mode);return;}
 // 没有分段规划（路点没吸附到定位码）时按索引推导真实码对，让下拉仍然生效；
 // 实在推导不出来就明确报错，绝不静默返回让用户以为界面坏了。
 const pair=stepPair(index);
 if(!pair){error.value=`第 ${index+1} 步没有吸附到定位码，无法设置动作：请把该路点拖到二维码中心后再选`;return;}
 rememberRoute();
 routeModes.value=[...routeModes.value.filter(choice=>!(choice.fromId===pair.fromId&&choice.toId===pair.toId&&choice.occurrence===pair.occurrence)),{...pair,mode}];
 selectedSegmentKey.value=pair.fromId+'>'+pair.toId+'#'+pair.occurrence;
 error.value='';
}
// 自动生成航行路径：按地图里已有的真实路线（rows）生成一串可编辑路点。
// 注意：加载已有路径时接口返回的 map 不带 rows，此时回退到基础上图的 rows。
const sourceRows=computed(()=>{
 const fieldRows=field.value?.rows??[];
 if(fieldRows.length)return fieldRows;
 return map.value?.rows??[];
});
function generateRouteFromRows(){
 if(!field.value||routeLocked.value)return;
 const rows=sourceRows.value;
 let raw:Point[]=[];
 if(rows.length){
  raw=rows.flatMap(row=>[exitPoint(row),...row.points]);
 }else{
  // 没有行数据时（加载已有路径的接口会去掉 rows），按地图里真实的定位码分行蛇形生成。
  const centers=routeGroupCenters(field.value);
  if(centers.length<2){error.value='当前地图可用的定位码不足两个，无法自动生成路径';return;}
  const rowOf=(centerId:number)=>field.value!.tags.find(tag=>tag.id===centerId)?.rowId??'';
  const rowIds=field.value.order?.length?field.value.order:[...new Set(centers.map(center=>rowOf(center.id)))];
  const buckets=rowIds.map(id=>centers.filter(center=>rowOf(center.id)===id)).filter(list=>list.length);
  const leftovers=centers.filter(center=>!buckets.some(list=>list.some(item=>item.id===center.id)));
  if(leftovers.length)buckets.push(leftovers);
  const ordered:Point[]=[];
  buckets.forEach((list,index)=>{
   const sorted=[...list];
   const xs=sorted.map(item=>item.x),ys=sorted.map(item=>item.y);
   const horizontal=(Math.max(...xs)-Math.min(...xs))>=(Math.max(...ys)-Math.min(...ys));
   sorted.sort((a,b)=>horizontal?a.x-b.x:a.y-b.y);
   if(index%2===1)sorted.reverse();
   ordered.push(...sorted.map(({x,y})=>({x,y})));
  });
  raw=ordered;
 }
 if(raw.length<2){error.value='当前地图没有可用的路线数据，请用「添加路径点」在画布上绘制';return;}
 rememberRoute();
 routeAnchors.value=routeCorners(raw);
 routeSelected.value=routeAnchors.value.length?0:-1;
 error.value='';
 message.value=rows.length?'已按地图现有行路线生成航行路径，可继续拖动或用「连接路径」串码':'已按定位码分行生成蛇形航行路径，可继续拖动或用「连接路径」串码';
}
/**
 * 侧栏「路径编辑」。
 *
 * 以前在 `!field` 或 `routeLocked` 时**静默 return**：用户点了没反应、也没有任何提示，
 * 看起来就是「入口点不了」。现在按原因给出明确下一步，并且没有地图时
 * 主动切到「开始导航」页的地图选择/新建引导，而不是什么都不做。
 */
function enterRouteEditing(){
 if(editingRoute.value)return;
 // 上一次导航的拒绝/未确认回执属于导航场景的历史状态，不带进编辑工作区。
 if(commandFeedback.value&&commandFeedback.value.state!=='waiting')commandFeedback.value=null;
 // 注意：不因 routeLocked 直接拒绝进入。锁定（busy/导航中/正交草稿）禁止的是**写入**，
 // 而统一工作区本身还要承担「选地图 / 新建空图 / 只读查看点位」等操作。
 // 真正的写入动作由各按钮的 :disabled 与 saveRoute 内的守卫负责。
 if(robot.value.running){
  message.value='机器人正在运行：已进入只读浏览，停止导航后才能修改点位与路径';
 }
 // 统一工作区：没有地图也进来。地图选择 / 新建空白地图都在本页左侧完成，
 // 不再要求「先去扫描页建空图再跳回来」。
 // 顺序很重要：先置 editingRoute，再切 page。
 // 反过来的话 page 变化会先触发定位 scope 的 watch（此时 editingRoute 还是 false），
 // 把一次「进入编辑」误当成导航消费者去切定位范围。
 editingRoute.value=true;
 page.value='navigate';
 if(!field.value){
  message.value=maps.value.length
   ?'尚未选择地图：在左侧「地图」里选一张，即可开始编辑点位与路径'
   :'还没有地图：在左侧「地图」里「新建空白地图」即可开始（不需要扫描）';
  return;
 }
 void nextTick(()=>{
  if(!field.value)return;
  // 已有路线就继续编辑它；没有路线则进入「地图可编辑、路线为空」的状态，
  // 不自动创建路线（只有用户点「新建路径」才建）。
  if(selectedRouteId.value||field.value.rows.length)beginRoute();
  else beginEmptyRouteWorkspace();
 });
}
const robotStateLabels:Record<string,string>={OFFLINE:'未连接',IDLE:'待命',INITIALIZING:'准备中',SEGMENT_ALIGN:'档位与轮角确认',FORWARD:'前进中',REVERSE:'倒车中',LATERAL_SHIFT:'平移中',ROW_END:'到点停车',ROW_EXIT:'退出区间',SWITCH_TO_LATERAL:'切换平移',SWITCH_TO_ACKERMANN:'恢复行驶模式',NEXT_ROW:'准备下一段',FINISHED:'任务完成',FAULT:'故障待处理'};
const robotStateLabel=computed(()=>!bridgeOnline.value?'未连接':robot.value.paused?'已暂停':robotStateLabels[robot.value.state]??'状态更新中');
onMounted(()=>{
 connect();void refreshPreview();
 // 初始化**不再**整条链套一个 act：那会把 busy 置 true 直到所有请求和后续 selectMap 全部完成，
 // 期间用户点任何入口都被 busy 守卫丢弃（线上实测慢请求可达 17–19 秒）。
 // 现在：基础数据刷新走 act（有上界、失败可见），但「选中扫描记录 / 载入地图」是可选步骤，
 // 各自 catch，失败只记降级提示，绝不连累导航切页与离线编辑。
 // 初始化必须**有确定顺序**：先拿到基础数据（refresh），再基于结果自动选中会话/地图。
 // 以前这两步是并发启动的，`maps.value` 还没赋值就检查 `maps.value.length`，
 // 于是「自动载入第一张地图」永远不会发生，界面一直停在「未选择地图 v0」，
 // 用户点「路径编辑」只会得到「请先选择地图」的提示。
 void (async()=>{
  await act(async()=>{await refresh();},{timeoutMs:15000});
  // 会话详情是可选的：失败只记录降级原因，绝不阻断地图载入。
  try{
   if(sessions.value.length){
    const current=sessions.value.find(item=>item.state==='collecting')??sessions.value[0]!;
    const detail=await api('/surveys/'+current.id,undefined,'GET',undefined,6000);
    selectSession(detail);
    if(current.state==='collecting')scanView.value='camera';
   }
  }catch(e){refreshDegraded.value=[...refreshDegraded.value,'扫描记录详情：'+(e instanceof Error?e.message:String(e))];}
  // 地图是「能不能干活」的前提：把第一张地图自动载入，让入口进来就能用。
  try{
   if(maps.value.length&&!field.value){
    selectedMapId.value=maps.value[0]!.id;
    selectMap(await api('/maps/'+selectedMapId.value,undefined,'GET',undefined,8000));
   }
  }catch(e){refreshDegraded.value=[...refreshDegraded.value,'地图载入：'+(e instanceof Error?e.message:String(e))];}
 })();
 poll=setInterval(()=>{void refreshPreview();void pollSession();},2000);
});
onMounted(()=>{posePoll=setInterval(()=>poseClock.value=performance.now(),100);});
onBeforeUnmount(()=>{closed=true;navigationAbort?.abort();clearInterval(poll);clearInterval(posePoll);clearTimeout(reconnect);socket?.close();});
</script>
<template>
 <div :class="['app-shell',{'is-route-editing':editingRoute,'is-sidebar-collapsed':sidebarCollapsed}]">
  <aside class="sidebar"><div class="brand"><span class="brand-icon" aria-hidden="true"><i/><i/><i/><i/></span><div><strong>QR 导航控制台</strong></div></div><button type="button" class="sidebar-toggle" data-testid="sidebar-toggle" :aria-label="sidebarCollapsed?'展开左侧导航':'收起左侧导航'" :aria-expanded="!sidebarCollapsed" @click="sidebarCollapsed=!sidebarCollapsed">{{sidebarCollapsed?'»':'«'}}</button>
   <nav aria-label="主导航"><span class="nav-group-label">作业</span><button :class="['nav-item',{active:page==='scan'}]" :aria-current="page==='scan'?'page':undefined" title="扫描建图" @click="editingRoute=false;page='scan'"><ScanLine :size="19"/>扫描建图</button><button :class="['nav-item',{active:page==='navigate'&&!editingRoute}]" :aria-current="page==='navigate'&&!editingRoute?'page':undefined" title="开始导航" @click="editingRoute=false;page='navigate'"><Navigation :size="19"/>开始导航</button><button :class="['nav-item',{active:editingRoute}]" :aria-current="editingRoute?'page':undefined" title="路径编辑" data-testid="nav-route-edit" @click="enterRouteEditing"><PenLine :size="19"/>路径编辑</button><span class="nav-group-label">标定</span><button :class="['nav-item',{active:page==='calibration'}]" :aria-current="page==='calibration'?'page':undefined" title="融合标定" data-testid="nav-calibration" @click="editingRoute=false;page='calibration'"><Crosshair :size="19"/>融合标定</button><span class="nav-group-label">资源</span><button :class="['nav-item',{active:page==='print'}]" :aria-current="page==='print'?'page':undefined" title="二维码 PDF" @click="editingRoute=false;page='print'"><FileText :size="19"/>二维码 PDF</button></nav>
   
  </aside>
  <main class="workspace">
   <!-- 编辑工作区已有自己的上下文（菜单条 context + 左栏地图组），这里不再重复大标题与「路径编辑中」标签，把纵向空间留给画布。 -->
   <header v-if="!editingRoute" class="topbar"><div class="page-heading"><h1>{{headingTitle}}<span v-if="page==='scan'||page==='navigate'" class="badge">{{page==='scan'?(session?.state==='collecting'?'扫描中':'待扫描'):field?.coordinateStatus==='reviewed'?'已验收坐标':'扫描坐标'}}</span></h1><p>{{headingDescription}}</p></div></header>
   <div v-if="error&&page!=='print'&&!editingRoute" class="scan-alert" role="alert"><AlertTriangle :size="20"/>{{error}}</div><div v-if="message&&page!=='print'&&!editingRoute&&!message.startsWith('新建路径：')" class="message" role="status"><CheckCircle2 :size="20"/>{{message}}</div>
   <!-- 指令回执改为就近可关闭单行；编辑工作区不继承上一次导航的拒绝/未确认横幅（那是历史状态，不是当前编辑的错误）。 -->
   <div v-if="commandFeedback&&page==='navigate'&&!editingRoute" class="command-feedback-inline" :class="commandFeedback.state==='confirmed'?'is-ok':commandFeedback.state==='waiting'?'is-waiting':'is-bad'" :role="commandFeedback.state==='rejected'||commandFeedback.state==='unconfirmed'?'alert':'status'" data-testid="command-feedback" :data-command-id="commandFeedback.id" :data-state="commandFeedback.state"><CheckCircle2 v-if="commandFeedback.state==='confirmed'" :size="20"/><Radio v-else-if="commandFeedback.state==='waiting'" :size="20"/><AlertTriangle v-else :size="20"/>{{commandFeedback.text}}<button type="button" class="command-feedback-close" aria-label="关闭指令回执" data-testid="command-feedback-close" @click="commandFeedback=null">×</button></div>
   <!-- 自用版：顶部商业化“作业概览”统计卡已移除，信息保留在右侧诊断面板。 -->
   <!--
    融合标定：KeepAlive 必须常驻在 v-if/v-else-if 链之外。
    以前把 KeepAlive 直接写成 v-else-if="page==='calibration'" 的一个分支，切页时 KeepAlive 自己也被卸载，
    缓存随之销毁 → CalibrationWorkspace 真的 unmount，onDeactivated 不触发，
    地图/会话/tagA/tagB/baselineM/试验表单全部回到默认值。把条件移到内部子节点即可真正缓存。
   -->
   <KeepAlive>
    <CalibrationWorkspace v-if="page==='calibration'" :maps="maps"/>
   </KeepAlive>
   
   <PdfGenerator v-if="page==='print'" @generated="generated"/>
   <div v-else-if="page!=='calibration'" class="editor-body">
    <!-- drawio 式编辑器外壳：左=工具/参数，中=画布，下=步骤，右=属性。
         折叠、拖拽改尺寸、右栏浮动/停靠、恢复默认都由 EditorShell 负责，
         布局由 usePanelLayout 持久化，刷新后自动恢复。 -->
    <EditorShell
      ref="editorShell"
      storage-key="qrautorun.editor.layout.v1"
      :show-left="editingRoute || page==='scan' || page==='navigate'"
      :show-right="!editingRoute"
      :inspector-open="editingRoute&&routeInspectorOpen&&!!routeSelectedObject"
      :show-menubar="editingRoute"
      :show-palette="false"
      :show-bottom="editingRoute"
      @layout-change="onLayoutChange"
    >
     <template #menubar>
      <EditorMenuBar :enabled="menuEnabled" :route-editing="editingRoute" :context-label="editorContextLabel" @command="onEditorCommand"/>
     </template>
     <template #palette>
      <!-- 路径编辑时顶部 RouteEditorToolbar 已承载选择/加点/连线/平移/测距等全部高频入口，
           左栏 palette 会与它重复（用户点名「避免重复选择/测量入口」）并挤占工具区高度，
           因此编辑态收起 palette；退出编辑即恢复。 -->
      <EditorToolPalette v-if="!editingRoute" :enabled="paletteEnabled" :active="paletteActive" @pick="onEditorPalettePick"/>
     </template>
     <template #left>
      <!-- 路径工具区：分组可折叠（路径编辑/点位与铺码/路线拓扑/步骤），
           说明默认折叠，真实错误与安全约束常显。业务面板通过 slot 注入，
           不再把所有长参数卡平铺成一列。 -->
      <RouteToolsPanel
       v-if="editingRoute"
       :tool="routeTool"
       :locked="routeLocked"
       :anchor-count="routeAnchors.length"
       :length-m="routeLength"
       :visited-count="routeGroupIds.length"
       :skipped-count="routeSkipped.length"
       :skipped-groups="routeSkipped.map(item=>({id:item.id,distanceM:item.distanceM}))"
       v-model:route-name="routeNameDraft"
       :notices="routePanelNotices"
       :open-groups="routePanelOpenGroups"
       :map-label="field?field.name+' · v'+version:'未选择地图'"
       :required-groups="routePanelRequiredGroups"
       @tool="onToolbarTool"
       @action="onToolbarAction"
       @group-toggle="onRoutePanelGroupToggle"
      >
       <!-- 地图组：在统一工作区里直接选图/新建空图，不需要先去扫描页 -->
       <template #group-map>
        <div class="route-panel-params" data-testid="route-panel-map">
         <label class="route-map-pick">当前地图
          <select v-model="selectedMapId" :disabled="busy||robot.running" data-testid="unified-map-select" @change="chooseMap">
           <option value="">选择地图</option>
           <option v-for="item in availableMaps" :key="item.id" :value="item.id">{{item.name}}</option>
          </select>
         </label>
         <div v-if="!availableMaps.length" class="route-map-empty" data-testid="unified-map-empty" role="status">
          还没有地图。可直接新建空白地图开始铺码与画路径，不需要扫描。
         </div>
         <Button class="w-full" variant="outline" data-testid="unified-new-blank-map" :disabled="busy||robot.running" @click="createBlankMapNow">＋ 新建空白地图（手动铺码）</Button>
         <small class="muted route-map-hint">新建后仍停留在本页：加二维码 → 调点位 → 画路径。</small>
        </div>
       </template>
       <template #group-route>
        <!-- 编辑态里的路径入口：画布工具条上的「新建路径」只在非编辑态显示，
             统一工作区内必须能从左侧直接开新路径（否则没有路线的地图无从开始）。 -->
        <div class="route-panel-actions" data-testid="route-panel-path-actions">
         <Button size="sm" variant="outline" data-testid="unified-new-route" :disabled="routeLocked" @click="beginNewRoute">＋ 新建路径</Button>
         <Button v-if="availableRoutes.length" size="sm" variant="ghost" data-testid="unified-pick-route" :disabled="routeLocked" @click="beginRoute">编辑已选路径</Button>
        </div>
        <div class="route-panel-params" data-testid="route-panel-params">
         <div class="route-param-row"><span>路点 / 长度</span><b class="route-metric" data-testid="route-anchors-length">{{routeAnchors.length}} 点 · {{routeLength.toFixed(2)}} m</b></div>
         <div class="route-param-row"><span>经过 / 跳过</span><span class="badge route-group-badge" data-testid="route-group-badge" title="每到下一定位码纠正一次">经过 {{routeGroupIds.length}} · 跳过 {{routeSkipped.length}}</span></div>
         <div class="route-param-row"><span>路径名称</span><span class="route-name-field route-name-auto" data-testid="route-name-field" :title="routeNameDraft">{{routeNameDraft||'保存时自动命名'}}</span></div>
         <div class="route-heading-panel" data-testid="route-initial-heading">
          <div class="route-heading-summary"><strong>初始车头朝向</strong><b>{{bodyYawDeg.toFixed(1)}}°</b><span :class="['route-heading-tag',initialHeadingManual?'is-manual':'is-auto']">{{initialHeadingManual?'手动':'默认'}}</span></div>
          <div class="route-heading-controls">
           <Button size="sm" variant="outline" :disabled="routeLocked" aria-label="初始朝向减15度" @click="nudgeInitialHeading(-15)">−15°</Button>
           <input class="route-heading-input" type="number" min="0" max="359" step="15" :value="bodyYawDeg" :disabled="routeLocked" aria-label="路径初始车头朝向（0-359度）" @input="setInitialHeading(($event.target as HTMLInputElement).valueAsNumber)"/>
           <Button size="sm" variant="outline" :disabled="routeLocked" aria-label="初始朝向加15度" @click="nudgeInitialHeading(15)">+15°</Button>
          </div>
          <div class="route-heading-actions">
           <Button size="sm" variant="ghost" data-testid="adopt-first-leg-heading" :disabled="routeLocked||routeAnchors.length<2" @click="adoptFirstLegHeading">用首段方向</Button>
           <Button size="sm" variant="ghost" data-testid="reset-initial-heading" :disabled="routeLocked" @click="resetInitialHeading">恢复默认</Button>
          </div>
         </div>
         <div v-if="routeSkipped.length" class="route-skipped-groups" data-testid="route-skipped-groups" role="status"><p v-for="tag in routeSkipped" :key="tag.id">Q{{String(tag.id).padStart(3,'0')}} · 偏离路线 {{(tag.distanceM*100).toFixed(1)}} cm，未串联：建议把路线画过此码或调整铺码</p></div>
        </div>
       </template>
       <!-- 点位与铺码：常驻只放 6 个紧凑按键，点开才渲染对应面板与详细参数。
            每个按键直接调用面板自身已暴露的 start/activate（与面板内「开始」同一条路径），
            不再要求「先点按钮再点开始」两次。 -->
       <template #group-tags>
        <div v-if="field?.routeMode==='map-only'" class="route-tool-compact" data-testid="map-tool-compact" role="group" aria-label="点位与铺码">
         <Button size="sm" variant="outline" data-testid="map-tool-position" :disabled="busy||robot.running"
                 title="在画布上拖动二维码调整位置" aria-label="调整点位"
                 @click="openMapTool('position')">调整点位</Button>
         <Button size="sm" variant="outline" data-testid="map-tool-single" :disabled="busy||robot.running"
                 title="在指定坐标新增一个二维码" aria-label="单个加码"
                 @click="openMapTool('single')">单个加码</Button>
         <Button size="sm" variant="outline" data-testid="map-tool-grid" :disabled="busy||robot.running"
                 title="按行列矩形阵列整片铺码" aria-label="阵列铺码"
                 @click="openMapTool('grid')">阵列铺码</Button>
         <Button size="sm" variant="outline" data-testid="map-tool-line" :disabled="busy||robot.running"
                 title="沿直线等距铺一排二维码" aria-label="直线铺码"
                 @click="openMapTool('line')">直线铺码</Button>
         <Button size="sm" variant="outline" data-testid="map-tool-table" :disabled="busy||robot.running"
                 title="逐行改编号、坐标、朝向或删除" aria-label="点位表"
                 @click="openMapTool('table')">点位表</Button>
         <Button size="sm" variant="outline" data-testid="map-tool-spacing" :disabled="busy||robot.running"
                 title="多选二维码后统一调整间距" aria-label="调整间距"
                 @click="openMapTool('spacing')">调整间距</Button>
        </div>

        <!-- 调整点位（含进入编辑态的两种来源，沿用原契约） -->
        <div v-if="field?.routeMode==='map-only'&&mapTool==='position'&&!tagPositionEditing" class="route-tool-card route-tag-position-card"><MapTagPositionPanel ref="tagPositionPanel" :map="field" :version="version" :selected-tag-id="inspectedTagId" :disabled="busy||robot.running||(orthogonalPreviewActive&&mapDraftSource!=='tag-position')" @preview-map="setTagPositionPreview" @editing="onTagPositionEditing" @update:selected-tag-id="inspectedTagId=$event" @applied="onTagPositionApplied"/></div>
        <div v-else-if="field?.routeMode==='map-only'&&mapTool==='position'&&tagPositionEditing&&mapDraftSource!=='tag-position'" class="route-tool-card route-tag-position-card"><MapTagPositionPanel ref="tagPositionPanel" :map="field" :version="version" :selected-tag-id="inspectedTagId" :disabled="false" @preview-map="setTagPositionPreview" @editing="onTagPositionEditing" @update:selected-tag-id="inspectedTagId=$event" @applied="onTagPositionApplied"/></div>

        <div v-if="field?.routeMode==='map-only'&&mapTool&&['single','grid','line'].includes(mapTool)" class="route-tool-card route-tag-create-card"><MapTagCreatePanel v-if="field" ref="tagCreatePanel" :map="field" :version="version" :disabled="busy||robot.running" @preview-map="onTagCreatePreview" @editing="onTagCreateEditing" @applied="onTagCreateApplied"/></div>

        <div v-if="field?.routeMode==='map-only'&&mapTool==='table'" class="route-tool-card route-tag-table-card"><MapTagTablePanel v-if="field" ref="tagTablePanel" :map="field" :version="version" :disabled="busy||robot.running" :aliases="tagAliases" @preview-map="setTagTablePreview" @editing="onTagTableEditing" @applied="onTagPositionApplied" @save-aliases="onSaveTagAliases"/></div>

        <div v-if="field?.routeMode==='map-only'&&mapTool==='spacing'" class="route-tool-card route-spacing-card"><MapSpacingPicker v-if="field" :map="field" :version="version" :selection="spacingSelectedIds" :disabled="busy||robot.running||(orthogonalPreviewActive&&mapDraftSource!=='tag-position')" @update:selection="spacingSelectedIds=$event" @preview-map="setTagPositionPreview" @editing="onTagPositionEditing" @applied="onTagPositionApplied"/></div>
       </template>
       <template #group-topology>
        <div v-if="editingRoute&&routeAnchors.length>=2" class="route-tool-card route-geometry-card"><RouteGeometryPanel :route-id="routeEditId" :map-id="field?.id??''" :version="version" :route-updated="routeEditUpdated" :points="routeAnchors" :tags="field?.tags??[]" :disabled="routeLocked" @preview-points="onRouteGeometryPreview" @applied="onRouteGeometryApplied"/></div>
        <div v-if="editingRoute&&routeEditId" class="route-tool-card route-topology-card"><RouteTopologyPanel :key="'topo-'+routeEditId+'-'+routeTopologyEpoch" :route-id="routeEditId" :map-id="field?.id??''" :version="version" :tags="field?.tags??[]" :aliases="tagAliases" :disabled="routeLocked" @applied="onRouteTopologyApplied" @dirty="routeTopologyDirty=$event" :pending-link="pendingConnect" @pending-consumed="pendingConnect=null"/></div>
       </template>
      </RouteToolsPanel>
      <section class="left-panel" v-if="page==='scan'">
       <div class="panel-title"><ScanLine :size="18"/>扫描控制</div>
        <!-- 扫描页只做真实扫描/记录/保存。手动建图、铺码、画路径统一在「路径编辑」
             （页面名「地图与路径编辑」）里完成，这里只留一个明确导航入口，不再重复一套表单。 -->
        <div class="scan-handoff" data-testid="scan-manual-entry">
         <Button class="w-full" variant="outline" data-testid="scan-open-map-editor" :disabled="busy||robot.running" @click="openUnifiedEditor">✎ 手动建图与路径编辑</Button>
         <small class="muted">不扫描也能用：在统一工作区里新建空白地图、铺码、画路径。</small>
        </div>
       <div class="auto-name" data-testid="scan-auto-name"><span>记录名</span><b>{{name||'待生成'}}</b></div>
       <Button class="w-full mt-4" :disabled="busy||session?.state==='collecting'||orthogonalPreviewActive" @click="start"><ScanLine :size="20"/>开始扫描</Button>
       <Button class="w-full mt-2" variant="outline" :disabled="busy||!session||orthogonalPreviewActive" @click="finish"><CheckCircle2 :size="18"/>{{busy?'正在处理…':session?.state==='collecting'?'完成扫描并保存地图':'整理记录并保存地图'}}</Button>
       <Button v-if="session?.state==='stopped'" class="w-full mt-2" variant="outline" :disabled="busy||originChanged||orthogonalPreviewActive" @click="resume">继续补扫此记录</Button>
       <div class="state-card" data-testid="capture-state"><span>{{session?.state==='collecting'?'正在记录':session?'已保存':'未开始'}}</span><strong data-testid="capture-count">已采集 {{capturePointCount}} 个定位点 · {{captureSampleCount}} 帧</strong>
        <!-- 等待原因必须常显：藏在默认折叠的 details 里，现场只看到“0 帧”却不知道为什么。 -->
        <small v-if="session?.state==='collecting'&&scanWaitReasons.length" class="scan-wait scan-wait-primary" role="status" data-testid="scan-wait-primary">等待扫描数据：{{scanWaitReasons[0]}}<template v-if="scanWaitReasons.length>1">（另有 {{scanWaitReasons.length-1}} 项，见采集诊断）</template></small>
        <details v-if="session?.state==='collecting'&&scanWaitReasons.length" class="capture-diagnostics"><summary>采集诊断</summary><small class="scan-wait" role="status">等待：{{scanWaitReasons.join('；')}}</small></details></div>
       <div v-if="session?.state==='collecting'&&detectorInference" class="scan-detector-inference" :class="{'is-unregistered':!detectorInference.registered}" data-testid="detector-inference" role="status"><strong>{{detectorInference.message}}</strong><small v-if="detectorInference.registered">单码观测可用于推断整组，继续采集或直接完成保存。</small><small v-else>请先在二维码打印页登记对应定位组，再继续采集。</small></div>
       <ScanRecords :records="sessions" :selected-id="session?.id" :busy="busy" :selection-disabled="session?.state==='collecting'" :error="error" @select="loadSession" @delete="removeSession" @refresh="refreshSurveys"/>
       <details class="scan-map-maintenance scan-fold" data-testid="scan-map-maintenance">
        <summary><Layers :size="16"/>地图维护</summary>
        <template v-if="scanMap">
         <template v-if="scanMap.routeMode==='map-only'">
          <div class="map-rebuild-actions"><Button class="w-full" variant="outline" data-testid="rebuild-map-from-survey" :disabled="busy||robot.running||orthogonalPreviewActive||session?.state==='collecting'" @click="rebuildScanMap">从原始扫描重建新版本</Button></div>
          <OrthogonalCorrectionPanel :map="scanMap" :version="scanMapVersion" :disabled="busy||robot.running||session?.state==='collecting'" @preview-map="setOrthogonalPreview" @applied="onScanMapApplied"/>
         </template>
         <p v-else class="scan-map-maintenance-hint">该地图已包含路径，重建与正交校正只对未建路径的定位码地图开放；如需清理可直接删除。</p>
         <div class="map-delete-actions" data-testid="scan-map-delete"><Button class="w-full" variant="destructive" data-testid="delete-scan-map" :disabled="busy||robot.running||orthogonalPreviewActive||session?.state==='collecting'" @click="askDeleteMap(scanMap.id,scanMap.name)"><Trash2 :size="16"/>删除此地图</Button></div>
         <MapDeleteConfirm :info="mapDeletion" :busy="busy" @confirm="confirmDeleteMap" @cancel="mapDeletion=null"/>
        </template>
        <p v-else class="scan-map-maintenance-hint">{{!session?'先在上方「已保存扫描」中选择一条记录。':session.state==='collecting'?'该扫描正在采集，停止后才能重建或校正地图。':'该扫描尚未保存地图；点击「完成扫描并保存地图」后此处会出现重建与校正入口。'}}</p>
     
       </details>
      </section>
      <section v-else-if="page==='navigate'&&!editingRoute" class="left-panel navigation-panel"><div class="navigation-settings"><div class="panel-title"><Navigation :size="18"/>导航控制</div><label>导航地图<select v-model="selectedMapId" :disabled="busy||robot.running||editingRoute" data-testid="map-select" @change="chooseMap"><option value="">选择扫描地图</option><option v-for="mapOption in availableMaps" :key="mapOption.id" :value="mapOption.id">{{mapOption.name}}</option></select></label>
       <div class="navigation-map-list" data-testid="map-list" aria-label="当前地图列表"><div class="navigation-map-head">当前地图 · {{availableMaps.length}}</div><div v-if="!availableMaps.length" class="navigation-map-empty">暂无地图</div><button v-for="mapOption in availableMaps" :key="mapOption.id" type="button" data-testid="map-list-item" :class="['navigation-map-item',{active:mapOption.id===selectedMapId}]" :disabled="busy||robot.running" @click="selectedMapId=mapOption.id;chooseMap()"><strong>{{mapOption.name}}</strong><span>v{{mapOption.version}} · {{routes.filter(route=>route.mapId===mapOption.id).length}}条路径</span></button></div>
       <Button class="w-full" variant="outline" data-testid="nav-open-map-editor" :disabled="busy||robot.running||editingRoute" @click="openUnifiedEditor">✎ 手动建图与路径编辑</Button>
       <label>执行路径<select v-model="selectedRouteId" :disabled="busy||robot.running||editingRoute" data-testid="route-select" @change="chooseRoute"><option value="">选择路径</option><option v-for="route in availableRoutes" :key="route.routeId" :value="route.routeId">{{route.name}}</option></select></label>
       <div v-if="availableRoutes.length" class="route-manage-list" data-testid="route-manage-list">
        <div class="route-manage-title">本图路径 · {{availableRoutes.length}}</div>
        <div v-for="route in availableRoutes" :key="route.routeId" :class="['route-manage-row',{active:route.routeId===selectedRouteId}]">
         <button type="button" class="route-manage-name" :disabled="busy||robot.running" @click="pickRoute(route.routeId)">{{route.name}}<small>{{route.points.length}} 点 · 地图 v{{route.mapVersion}}</small></button>
         <Button size="sm" variant="ghost" class="route-manage-delete" :disabled="busy||robot.running" :aria-label="'删除路径 '+route.name" data-testid="delete-route" @click="askDeleteRoute(route)"><Trash2 :size="16"/></Button>
        </div>
        <div v-if="routeDeletion" class="route-delete-confirm" role="alertdialog" data-testid="route-delete-confirm"><span>删除路径「{{routeDeletion.name}}」？<template v-if="routeDeletion.tasks.length">该路径被 {{routeDeletion.tasks.length}} 个导航任务引用（{{routeDeletion.tasks.map(task=>task.name).join('、')}}），确认后将同时移除这些任务绑定。</template><template v-else>此操作不可撤销。</template></span><div><Button variant="outline" size="sm" :disabled="busy" @click="routeDeletion=null">取消</Button><Button variant="destructive" size="sm" :disabled="busy" data-testid="confirm-delete-route" @click="confirmDeleteRoute">确认删除</Button></div></div>
       </div>
       <div v-if="robot.state==='FAULT'" class="scan-alert fault-reason" role="alert" data-testid="robot-fault-reason"><AlertTriangle :size="20"/><span>故障原因：{{faultReason}}</span></div>
       <div v-if="navigationBlockReason" class="navigation-block-reason" role="status" data-testid="navigation-block-reason"><AlertTriangle :size="17"/><span>{{navigationBlockReason}}</span></div>
       <fieldset class="navigation-speeds" :disabled="busy||robot.running||!selectedTask||commandFeedback?.state==='waiting'">
        <legend>目标速度 · 厘米/秒</legend>
        <div class="speed-grid"><label v-for="item in speedFields" :key="item.key" :for="'navigation-speed-'+item.key">{{item.label}}<input :id="'navigation-speed-'+item.key" v-model.number="speedSettings[item.key]" type="number" min="2" :max="item.max" step="1" :aria-label="item.label+'速度（厘米/秒）'"/></label></div>
      
        <Button class="w-full mt-2" variant="outline" :disabled="busy||robot.running||!selectedTask||!speedDirty||commandFeedback?.state==='waiting'" @click="saveSpeeds">{{speedDirty?'保存速度':'速度已保存'}}</Button>
      
       </fieldset>
       <Button class="w-full mt-3" :variant="returnToStart?'default':'outline'" :aria-pressed="returnToStart" :disabled="busy||robot.running||!selectedTask||commandFeedback?.state==='waiting'" data-testid="return-to-start-toggle" @click="toggleReturnToStart">完成后原路倒车：{{returnToStart?'开启':'关闭'}}</Button>
     
     
       <details v-if="field&&unifyAnglesInfo" class="scan-details" data-testid="unify-angles"><summary><Ruler :size="18"/>统一所有码朝向</summary><div class="unify-angle-list"><div v-for="a in unifyAnglesInfo.list" :key="a.id" class="unify-angle-row"><span>Q{{String(a.id).padStart(3,'0')}}</span><span>{{a.angleDeg.toFixed(2)}}°</span><span class="muted">→ {{unifyAnglesInfo.targetDeg.toFixed(2)}}°</span></div></div><Button class="w-full mt-2" :disabled="busy||unifyAnglesInfo.spreadDeg<0.5" @click="unifyAngles">统一朝向并保存新版本</Button></details>
       <div v-if="field?.routeMode==='map-only'" class="map-rebuild-actions"><Button class="w-full" variant="outline" data-testid="rebuild-map-from-survey" :disabled="busy||robot.running||!selectedMapSurvey||orthogonalPreviewActive||tagPositionEditing" @click="rebuildSelectedMap">从原始扫描重建新版本</Button></div><OrthogonalCorrectionPanel v-if="field?.routeMode==='map-only'" :map="field" :version="version" :disabled="busy||robot.running||tagPositionEditing||(orthogonalPreviewActive&&mapDraftSource!=='orthogonal')" @preview-map="setOrthogonalPreview" @applied="onOrthogonalApplied"/>
     
       </div><div class="navigation-actions"><Button class="w-full mt-3" :disabled="busy||commandFeedback?.state==='waiting'||!canNavigate" @click="navigation('start')"><Play :size="20"/>开始导航</Button><div class="export-grid mt-2"><Button variant="outline" :disabled="!robot.running" @click="navigation(robot.paused?'resume':'pause')"><Pause :size="18"/>{{robot.paused?'继续':'暂停'}}</Button><Button variant="destructive" @click="navigation('stop')"><Square :size="18"/>停止</Button></div></div>
      </section>
     </template>
     <template #canvas>
      <!-- 路径编辑工具条：固定占一行、在画布**之外**，不再浮在画布右上角盖住内容。
           高频（选择/加点/连线/平移/测距/撤销/重做/保存/退出）常驻；
           低频（清空/删除/另存/串码/生成路径）收在「更多」里但仍可发现。 -->
      <div v-if="editingRoute" class="route-editor" data-testid="route-editor">
       <RouteEditorToolbar
        :tool="routeTool==='connect'?'connect':routeTool==='pan'?'pan':routeTool==='draw'?'draw':'select'"
        :measuring="measuring"
        :can-undo="canUndoEdit"
        :can-redo="canRedoEdit"
        :can-save="!routeLocked&&routeDrawing.length>=2"
        :can-exit="!routeLocked"
        :saving="busy"
        :locked="routeLocked"
        :show-properties="true"
        :properties-active="routeInspectorOpen"
        :disabled="routeToolbarDisabled"
        @tool="onToolbarTool"
        @action="onToolbarAction"
       />
       <!-- 模式状态行：工具条下方的轻量提示条（原来在左栏大卡里，删卡时一并丢了）。
            保留既有 testid 与语义，供真实回归断言「当前工具 / 拖动行为 / 被拒原因」。 -->
       <div class="route-tool-hint route-tool-hint--bar" role="status" data-testid="route-tool-hint">
        <span :class="['route-tool-dot','is-'+routeTool]"/>
        <!-- 只保留一个模式名：原来 {{toolLabel}} 与 {{editorModeLabel}} 常同时显示「选择 / 选择」。
             data-testid 与 data-mode 保留在同一个徽章上，不新增重复状态。 -->
        <span class="route-mode-badge" data-testid="editor-mode-badge" :data-mode="editorMode" :title="toolLabel">{{editorModeLabel}}</span>
        <span v-if="canvasPansOnDrag" class="route-mode-note" data-testid="editor-mode-pan-note" title="左键拖动＝平移画布">拖动＝平移</span>
        <span v-if="canvasBoxCount>0" class="route-mode-note" data-testid="route-box-select-hint">框选 {{canvasBoxCount}} 个二维码</span>
       </div>
       <div v-if="editorModeNotice" class="route-mode-rejected" role="alert" data-testid="editor-mode-rejected">{{editorModeNotice}}</div>
      </div>
      <div class="canvas-section"><div class="canvas-toolbar">
     <div v-if="editingRoute" class="editor-layout-tools" data-testid="editor-layout-tools" role="toolbar" aria-label="面板布局">
      <Button size="sm" variant="ghost" data-testid="layout-toggle-left" title="收起/展开左栏（工具与参数）" aria-label="收起或展开左栏" @click="toggleEditorSide('left')"><PanelLeft :size="15"/></Button>
      <Button v-if="editingRoute" size="sm" variant="ghost" data-testid="layout-toggle-bottom" title="收起/展开底部路径步骤" aria-label="收起或展开底部路径步骤" @click="toggleEditorBottom"><PanelBottom :size="15"/></Button>
      <Button v-if="!editingRoute" size="sm" variant="ghost" data-testid="layout-toggle-right" title="收起/展开右栏（属性与诊断）" aria-label="收起或展开右栏" @click="toggleEditorSide('right')"><PanelRight :size="15"/></Button>
      <Button v-if="!editingRoute" size="sm" variant="ghost" data-testid="layout-toggle-float" title="右栏浮动 / 停靠" aria-label="右栏浮动或停靠" @click="toggleEditorFloat"><Move :size="15"/></Button>
      <Button size="sm" variant="ghost" data-testid="layout-reset" title="恢复默认布局" aria-label="恢复默认布局" @click="resetEditorLayout"><RotateCcw :size="15"/></Button>
     </div>
       <template v-if="page==='scan'"><Button size="sm" :variant="scanView==='map'?'default':'ghost'" :aria-pressed="scanView==='map'" @click="scanView='map'">地图</Button><Button size="sm" :variant="scanView==='camera'?'default':'ghost'" :aria-pressed="scanView==='camera'" @click="scanView='camera'"><Camera :size="18"/>实时画面</Button></template><span v-else class="canvas-label">导航地图</span>

       <!-- 扫描页也要能测距：刚建好的图正是在这里核对码间距的。点开自动切到地图视图。 -->
       <Button v-if="map&&editingRoute" size="sm" :disabled="map.tags.length<2" :variant="measuring?'default':'outline'" :aria-pressed="measuring" data-testid="center-measure-toggle" @click="toggleMeasurement"><Ruler :size="18"/>中心测距</Button>
       <template v-if="page==='navigate'&&field&&!editingRoute">
        <Button size="sm" variant="outline" data-testid="new-route" :disabled="routeLocked" @click="beginNewRoute"><PenLine :size="15"/>新建路径</Button>
        <Button v-if="field" size="sm" variant="outline" :disabled="routeLocked||(!selectedRouteId&&!field.rows.length)" :title="selectedRouteId||field.rows.length?'编辑已保存路径':'请先点「新建路径」创建路径'" data-testid="edit-route" @click="beginRoute">编辑路径</Button>
        <Button size="sm" variant="outline" :disabled="!field.tags.length" data-testid="view-tag-reprint" @click="openTagInspector">查看二维码/补打</Button>
       </template>
       <span v-if="map" class="ml-auto badge">{{map.tags.length}} 个定位组 · {{map.routeMode==='map-only'?(!selectedRouteId?'未创建路径':'路径已选（routeMode 仍为 map-only）'):map.rows.length+' 条路线'}}</span>
      </div>
       <div v-if="page==='navigate'&&!editingRoute&&tagInspectorVisible&&field" class="route-details-scroll tag-reprint-popover">
        <div class="route-properties-heading"><strong>查看二维码/补打</strong><Button size="sm" variant="ghost" aria-label="关闭二维码预览" @click="tagInspectorVisible=false">关闭</Button></div>
        <label>地图二维码<select v-model="inspectedTagId" aria-label="查看地图二维码"><option v-for="tag in orderedTagsById(field.tags)" :key="tag.id" :value="tag.id">{{tag.groupId??label(tag.id)}}{{tag.groupId?' · 码组中心':' · 单码'}}</option></select></label>
        <TagInspector v-if="inspectedTagId!==null" :map="field" :version="version" :tag-id="inspectedTagId"/>
       </div>
       <div v-if="gapEdit" class="gap-inline" data-testid="gap-inline-editor" :style="{left:gapEdit.left+'px',top:gapEdit.top+'px'}">
        <div class="gap-inline-head">{{gapEdit.fromId}} → {{gapEdit.toId}}</div>
        <div class="gap-inline-row">
         <input ref="gapInput" v-model="gapEdit.value" data-testid="gap-inline-input" type="number" step="0.1" min="8" :disabled="gapEdit.busy" aria-label="相邻二维码间距（厘米）"
          @keydown.enter.prevent="commitGapEdit" @keydown.esc.prevent="cancelGapEdit"/>
         <span>cm</span>
         <button type="button" data-testid="gap-inline-apply" :disabled="gapEdit.busy" @click="commitGapEdit">{{gapEdit.busy?'…':'确定'}}</button>
         <button type="button" data-testid="gap-inline-cancel" :disabled="gapEdit.busy" @click="cancelGapEdit">取消</button>
        </div>
        <div v-if="gapEdit.error" class="gap-inline-error" data-testid="gap-inline-error">{{gapEdit.error}}</div>
       </div>
       <div v-if="editingRoute&&(error||message)" class="route-toast" data-testid="route-toast" :class="{'route-toast-error':error}" :role="error?'alert':'status'" :title="error||message">{{error||message}}</div>
       <div v-if="measuring&&map&&(page!=='scan'||scanView==='map')" class="distance-panel">
        <div class="distance-fields"><label>起点<select v-model.number="measureFrom" aria-label="测距起点"><option value="">请选择定位组</option><option v-for="tag in orderedTagsById(map.tags)" :key="tag.id" :value="tag.id">{{measureLabel(tag)}}</option></select></label><span class="distance-arrow">↔</span><label>终点<select v-model.number="measureTo" aria-label="测距终点"><option value="">请选择定位组</option><option v-for="tag in orderedTagsById(map.tags)" :key="tag.id" :value="tag.id">{{measureLabel(tag)}}</option></select></label><Button size="sm" variant="ghost" @click="clearMeasurement">清除测距</Button></div>
        <div class="distance-result" data-testid="center-distance-result" role="status"><strong v-if="centerDistance!==null">中心距离 {{centerDistance.toFixed(3)}} m <span>（{{(centerDistance*100).toFixed(1)}} cm）</span></strong><span v-else>{{measureFrom!==''&&measureTo===measureFrom?'请选择两个不同的定位组':measureFrom!==''?'请点击第二个定位组，或选择测距终点':'点击地图上的两个定位组，或选择起点和终点'}}</span><small class="distance-disclaimer" data-testid="center-distance-disclaimer">两块二维码板中心的平面直线距离 · 地图计算值{{mapApproval?.accepted?'，已按用户确认接纳':map&&(map.coordinateStatus!=='reviewed'||map.captureQuality==='draft')?'，尚未实测验收':''}}</small></div>
       </div>
       <CameraPreview v-if="page==='scan'&&scanView==='camera'" compact/>
       <MapCanvas v-else-if="canvasMap" :map="canvasMap" :selected="mapSelected" :measurement="mapMeasurement" row-id="" :tool="measuring?'measure':tagPositionEditing?'select':editingRoute?(routeTool==='pan'?'pan':routeTool==='connect'?'connect':'route-design'):'pan'" @select="mapCanvasSelect" @inspect="inspectTag" @tag-detail="openTagDetail" :segment-plans="editingRoute?routePlans:undefined" :selected-segment="selectedSegmentKey" @segment-select="selectSegment" :editable="tagPositionEditing||tagTableEditing?true:(editingRoute?(editingRoute&&!routeLocked&&routeTool!=='pan'):false)" :drawing="mapDrawing" :pan-enabled="editingRoute?(routeTool==='pan'):true" :spacing-mode="tagPositionEditing||tagTableEditing" :tag-editing="tagPositionEditing||tagTableEditing" :pan-mode="editingRoute||tagPositionEditing||tagTableEditing?(canvasPansOnDrag?'pan':'select'):undefined" :mode-label="editorModeLabel" :tag-aliases="tagAliasByTagId" :spacing-line="spacingSelectedIds" :spacing-gaps="spacingCanvasGaps" :ghost-tags="tagCreateGhost" :route-group-ids="routeGroupIds" :route-skipped-groups="routeSkipped" :route-name="routeNameDraft||availableRoutes.find(r=>r.routeId===selectedRouteId)?.name" :route-anchors="routeAnchors" :route-selected="routeSelected" :draw-mode="editingRoute&&routeTool==='draw'" :initial-heading="editingRoute?bodyYawDeg*Math.PI/180:undefined" @heading="setInitialHeadingRad" @blank="appendRoute" @design-select="routeSelected=$event" @design-move="moveRoute" @gap-edit="onGapEdit" @move="mapCanvasMove" @box-select="onCanvasBoxSelect" @connect="onCanvasConnect" @ghost-move="onTagCreateGhostMove" @link-rejected="onCanvasLinkRejected" :vehicle="mapVehicle??undefined" :trail="mapTrail"/>
       <div v-else class="scan-empty"><div class="empty-illustration"><ScanLine v-if="page==='scan'" :size="32"/><Route v-else :size="32"/></div><strong>{{page==='scan'?'暂无扫描数据':'请选择地图'}}</strong><div class="getting-started" data-testid="getting-started"><h2>{{page==='scan'?'打印并铺设定位板后开始扫描':'选择地图与路径后开始导航'}}</h2><p>{{page==='scan'?'检查相机，点「开始扫描」即可。已有记录可从左侧打开继续整理。':'先选择地图，再选择或新建路径。'}}</p><div><Button size="sm" @click="page=page==='scan'?'print':'scan'">{{page==='scan'?'打印定位板':'前往扫描建图'}}<ArrowRight :size="15"/></Button></div></div></div>
       <div class="legend"><span><i class="tag-dot"/>定位组</span><span><i class="line-green"/>作物行</span></div>
       <div v-if="editingRoute&&tagDetail" class="tag-detail-card" data-testid="tag-detail-card" role="status">
        <div class="tag-detail-head"><strong>{{tagDetail.label}}</strong><button type="button" aria-label="关闭二维码信息" @click="tagDetailId=null">✕</button></div>
        <TagInspector v-if="field&&tagDetail" :map="field" :version="version" :tag-id="tagDetail.id"/>
       </div>
      </div>
     </template>
     <template #bottom>
      <div v-if="editingRoute" class="route-steps-entry" data-testid="route-steps-entry">
       <button v-show="!routeStepsOpen" type="button" class="route-steps-trigger" data-testid="route-steps-trigger" :aria-expanded="routeStepsOpen" aria-haspopup="dialog" @click.stop="routeStepsOpen=!routeStepsOpen;routeStepsOpen&&nextTick(clampRouteStepsDockHeight)">
        <strong>路径步骤 {{stepRows.length}}</strong><span :class="['route-steps-trigger-status','is-'+stepStatusTone]" data-testid="route-steps-status" :title="stepStatusHint">{{stepStatusLabel}}</span><span class="panel-caret">{{routeStepsOpen?'▴':'▾'}}</span>
       </button>
       <div v-show="routeStepsOpen" class="route-steps-dock" data-testid="route-steps-dock" :style="routeStepsDockStyle">
       <div class="route-steps-resize-bar" data-testid="route-steps-resize-bar" role="separator" aria-orientation="horizontal"
        :aria-label="'调整路径步骤高度（当前 ' + routeStepsDockHeight + ' 像素）'" tabindex="0"
        @pointerdown.prevent="startRouteStepsDockResize"
        @keydown.up.prevent="nudgeRouteStepsDock(16)"
        @keydown.down.prevent="nudgeRouteStepsDock(-16)"/>
       <div class="route-steps-popover" data-testid="route-steps-popover" role="dialog" aria-label="路径步骤详情" @pointerdown.stop
        :style="{height:routeStepsDockHeight+'px',maxHeight:'60vh'}">
        <!-- 单行头部：标题/数量 + 状态 + 上移/下移/删除 + 收起/关闭 全部同一横排。
             不再拆成「标题行 + 操作行」两行，消除中间大留白。 -->
        <div class="route-commands-head route-steps-drag-handle route-steps-headline" data-testid="route-steps-drag-handle" title="路径步骤（停靠在底部）">
         <button type="button" class="route-steps-collapse-head" data-testid="route-steps-collapse" aria-expanded="true" aria-label="收起路径步骤" @pointerdown.stop @click.stop="routeStepsOpen=false">
          <ChevronUp :size="14"/><strong class="route-steps-drag-title">路径步骤 {{stepRows.length}}</strong>
         </button>
         <span :class="['status-badge',stepStatusTone==='success'?'success':stepStatusTone==='warning'?'warning':'']" data-testid="route-steps-badge"><i/>{{stepStatusLabel}}</span>
         <div class="route-commands-ops">
          <Button size="sm" variant="outline" :disabled="routeLocked||routeSelected<=0" aria-label="上移选中步骤" title="上移" @click.stop="moveStepUp(routeSelected)">上移</Button>
          <Button size="sm" variant="outline" :disabled="routeLocked||routeSelected<0||routeSelected>=stepRows.length-1" aria-label="下移选中步骤" title="下移" @click.stop="moveStepDown(routeSelected)">下移</Button>
          <Button size="sm" variant="outline" class="route-tool-danger" :disabled="routeLocked||routeSelected<0" aria-label="删除选中步骤" title="删除选中" @click.stop="deleteStep(routeSelected)"><Trash2 :size="14"/><span class="route-steps-op-text">删除选中</span></Button>
         </div>
         <button type="button" class="route-steps-close" aria-label="关闭路径步骤" title="关闭" @pointerdown.stop @click.stop="closeRouteSteps">×</button>
        </div>
        <div class="route-commands-scroll">
        <table class="route-commands-table">
         <colgroup><col class="col-index"/><col class="col-name"/><col class="col-type"/><col class="col-qr"/><col class="col-coord"/><col class="col-speed"/><col class="col-distance"/><col class="col-dwell"/><col class="col-ops"/></colgroup>
         <thead><tr><th scope="col">#</th><th scope="col">步骤名称</th><th scope="col">类型</th><th scope="col">关联二维码</th><th scope="col">坐标 (m)</th><th scope="col">速度 / m·s⁻¹</th><th scope="col">距离 / m</th><th scope="col">停留 / s</th><th scope="col">操作</th></tr></thead>
         <tbody>
          <tr v-for="row in stepRows" :key="row.key" :class="{blocked:row.blocked,active:row.key===routeSelected}" @click="selectStep(row.key)">
           <td>{{row.index}}</td><td>{{row.name}}</td>
           <td>
            <select v-if="row.key>0" class="route-type-select" :class="{blocked:row.blocked}" :value="row.mode" :disabled="routeLocked" :aria-label="'第'+row.index+'步本段动作'" @click.stop @change.stop="setStepMode(row.key,($event.target as HTMLSelectElement).value as StrategyMode)">
             <option v-for="option in nodeModeOptions" :key="option.value" :value="option.value">{{option.label}}</option>
            </select>
            <span v-else class="route-command-state is-ok">{{row.type}}</span>
           </td>
           <td :data-testid="'route-step-qr-'+row.key">{{row.qrLabel}}</td><td>{{row.coord}}</td><td>{{row.speedMps.toFixed(2)}}</td>
           <td class="route-leg-cell">
            <input v-if="row.key>0" class="route-leg-input" type="number" min="0.08" max="50" step="0.01" :value="legInputText(row)" :disabled="routeLocked" data-testid="route-leg-distance" :aria-label="'第'+row.index+'段距离（米）'" :title="routeLocked?'当前不可编辑':'修改本段距离，地图二维码坐标不变'" @input="onLegInput(row.key,($event.target as HTMLInputElement).value)" @change="commitLegEdit(row.key)" @keydown.enter.prevent="commitLegEdit(row.key)" @keydown.esc.prevent="legDraft=null" @blur="commitLegEdit(row.key)"/>
            <small v-if="row.key>0" class="route-leg-cm" :data-testid="'route-leg-cm-'+row.index">{{legCmText(row)}}cm</small>
            <span v-else class="muted">—</span>
           </td>
           <td>{{row.dwellS.toFixed(1)}}</td>
           <td class="route-command-ops">
            <button type="button" aria-label="上移该步骤" :disabled="routeLocked||row.key===0" @click.stop="moveStepUp(row.key)">↑</button>
            <button type="button" aria-label="下移该步骤" :disabled="routeLocked||row.key>=stepRows.length-1" @click.stop="moveStepDown(row.key)">↓</button>
            <button type="button" class="route-command-remove" aria-label="删除该步骤" :disabled="routeLocked" @click.stop="deleteStep(row.key)">✕</button>
           </td>
          </tr>
         </tbody>
        </table>
         <div v-if="!stepRows.length" class="route-commands-empty">先添加路径点或用「自动生成航行路径」，这里会列出每一步指令。</div>

        </div>
       </div>
      </div>
      </div>
     </template>
     <template #inspector>
      <!-- 选中对象才显示属性：没选中就收起，避免常驻占位。
           属性来自当前选中路点/二维码的真实数据，只读展示 + 可跳转到对应面板。 -->
      <section v-if="editingRoute&&routeInspectorOpen&&routeSelectedObject" class="right-panel route-inspector" data-testid="route-inspector">
       <div class="route-properties-heading">
        <strong>{{routeSelectedObject.kind==='waypoint'?'路点属性':'二维码属性'}}</strong>
        <Button size="sm" variant="ghost" aria-label="关闭属性" data-testid="route-inspector-close" @click="closeRouteInspector">关闭</Button>
       </div>
       <dl class="route-inspector-rows">
        <div><dt>序号</dt><dd>{{routeSelectedObject.index}}</dd></div>
        <div><dt>坐标 (m)</dt><dd>{{routeSelectedObject.coord}}</dd></div>
        <div v-if="routeSelectedObject.qrLabel"><dt>关联二维码</dt><dd>{{routeSelectedObject.qrLabel}}</dd></div>
        <div v-if="routeSelectedObject.type"><dt>本段动作</dt><dd>{{routeSelectedObject.type}}</dd></div>
        <div v-if="routeSelectedObject.speedMps!==undefined"><dt>速度 (m/s)</dt><dd>{{routeSelectedObject.speedMps.toFixed(2)}}</dd></div>
        <div v-if="routeSelectedObject.lengthM"><dt>本段距离</dt><dd>{{routeSelectedObject.lengthM.toFixed(2)}} m</dd></div>
       </dl>
       <p v-if="routeSelectedObject.blocked" class="route-inspector-warn" role="alert">该步骤存在阻断项，保存会被后端安全门拒绝</p>
       <p class="route-inspector-hint">属性只读展示；修改请用画布拖动或左侧对应分组。</p>
      </section>
     </template>
     <template #right>
      <section v-if="!editingRoute" class="right-panel">
       <div v-if="page==='scan'" class="scan-detector-status" role="status">{{session?.state==='collecting'?'正在记录':session?'采集记录已保存':'等待开始采集'}} · {{capturePointCount}} 个定位点 · {{captureSampleCount}} 帧</div>
       <div v-else class="task-overview"><strong>{{selectedNavigationTask?.name??'未选择任务'}}</strong><small>{{field?.name??'未加载地图'}} · {{robot.running?(robot.paused?'已暂停':'执行中'):editingRoute?'编辑中':'待启动'}}</small></div>
       <details class="advanced-diagnostics" data-testid="advanced-diagnostics"><summary><Settings2 :size="16"/><span>高级诊断</span><small>{{diagnosticsSummary}}</small></summary><div class="diagnostics-content">
  <div class="sensor-line"><span>连接</span><b>{{bridgeOnline?'在线':'离线'}}</b></div><div class="sensor-line"><span>底盘反馈</span><b>{{bridgeOnline&&robot.chassis?.connected?'在线':'离线'}}</b></div><div class="sensor-line" data-sensor="preview"><span>相机预览</span><span class="muted-pill">{{previewLabel}}</span></div><div class="sensor-line" data-sensor="detector"><span>定位识别</span><span class="muted-pill">{{detectorLabel}}</span></div><div v-for="key in ['odom','imu','localization']" :key="key" class="sensor-line" :data-sensor="key"><span>{{{odom:'轮式里程计',imu:'IMU',localization:'定位'}[key]}}</span><span class="muted-pill">{{bridgeOnline?deviceStatus(key,String(robot.sensors?.[key]??'等待状态反馈')):'ROS桥离线 / 状态未知'}}</span></div>
       <template v-if="page==='scan'"><div v-if="originChanged&&session?.state!=='collecting'" class="scan-detector-status" role="status">此历史记录使用旧定位原点，请开始新的扫描。</div><div v-if="bridgeOnline&&robot.detector?.groups?.length" class="section-label">当前画面</div><div v-for="g in bridgeOnline?robot.detector?.groups??[]:[]" :key="g.id" class="metric-row"><span>{{g.id}}</span><b>{{g.visible}} / {{g.total}} 码</b></div><div class="section-label">组识别统计</div><div class="log-list"><div v-for="(count,id) in session?.counts??{}" :key="id">{{groupName(Number(id))}} · {{count}} 次</div><div v-for="(v,id) in session?.visibility??{}" :key="'v'+id">{{id}} · 可见 {{v.visible}} / {{v.total}} 码</div></div><div v-if="session" class="section-label">区间运动模式（档位＋轨迹）</div><div v-if="session" class="metric-row"><span>连续档位记录</span><b>{{session.motionValidation?.recordCount??0}} 条</b></div><div v-for="(segment,index) in session?.motionValidation?.segments??[]" :key="'motion-'+index" class="log-list"><div>{{segment.from}} → {{segment.to}} · {{segment.mode==='crab'?'平移':segment.mode==='4t4d'?'4T4D':'待确认'}} · {{segment.status==='confirmed'?'聚合反馈与轨迹一致':'校验未通过'}}</div><div v-for="reason in segment.reasons" :key="reason">{{reason}}</div></div><div v-if="session?.result" class="metric-row"><span>扫描残差</span><b>{{(session.result.rmsM*100).toFixed(2)}} cm</b></div></template>
       <template v-else><div class="metric-row"><span>当前定位组</span><b>{{robot.group?.id??'—'}}</b></div><div v-if="robot.group" class="metric-row"><span>可见子码</span><b>{{robot.group.visible}} / {{robot.group.total}}</b></div><div v-if="robot.group" class="metric-row"><span>定位质量</span><b>{{robot.group.degraded?'部分可见':'完整'}}</b></div><details class="scan-details navigation-diagnostics" data-testid="navigation-diagnostics"><summary><Settings2 :size="18"/><span>设备诊断</span><small>{{diagnosticsSummary}}</small></summary><div v-for="c in robot.conditions" :key="c.id" class="readiness-line"><CheckCircle2 v-if="c.ready" :size="18"/><AlertTriangle v-else :size="18"/><span>{{c.label}}<template v-if="!c.ready&&c.id==='execution'"><br/><small>当前为只读模式，实体执行尚未开启</small></template><template v-else-if="!c.ready&&c.id==='pose'"><br/><small>{{robot.localization?.reason||'等待新鲜定位/误差达标'}}</small></template></span></div></details><div class="log-list"><div v-for="(event,i) in robot.events" :key="i">{{event}}</div></div></template>
       <ExecutionErrors v-if="page==='navigate'&&!editingRoute" :status="robot" :map-id="field?.id??''" :version="version" :task-id="selectedTask" :now-ms="poseClock" :received-ms="robotReceivedClock" :online="bridgeOnline"/>
  </div></details>
      </section>
     </template>
    </EditorShell>
   </div>
  </main>
 </div>
  <div v-if="routeExitConfirm" class="route-exit-confirm-overlay" role="alertdialog" data-testid="route-exit-confirm" :data-dirty="editorSession.dirty.value?'1':'0'"><div class="route-exit-confirm-box"><span>当前路径有未保存的改动，退出将丢弃这些改动。是否继续？</span><div><Button variant="outline" size="sm" data-testid="route-exit-cancel" @click="cancelExitRoute">继续编辑</Button><Button variant="destructive" size="sm" data-testid="route-exit-discard" @click="confirmExitRoute">放弃并退出</Button></div></div></div>
</template>
<style scoped>
.auto-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 4px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:12px;color:var(--muted)}
.auto-name b{font-weight:500;color:var(--ink);overflow-wrap:anywhere}
.auto-name small{margin-left:auto;font-size:11px;color:#94a3b8}

.route-name-auto{display:inline-flex;align-items:center;gap:6px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--background);font-size:12px;color:var(--muted)}
.route-name-auto small{font-size:10px;color:#94a3b8}
.capture-trail-toggle{display:flex;align-items:center;gap:5px;font-size:12px;margin:0}.capture-trail-toggle input{width:14px;height:14px}.capture-diagnostics{margin-top:8px;font-size:12px}.capture-diagnostics summary{cursor:pointer}.state-card [data-testid="capture-count"]{font-size:15px;line-height:1.5}
.scan-wait-primary{display:block;margin-top:6px;color:#b45309;font-size:12px;line-height:1.6}.tag-reprint-popover{position:absolute;right:8px;top:60px;bottom:32px;width:260px;max-width:calc(100% - 16px);overflow:auto;background:white;border:1px solid var(--line);border-radius:8px;box-shadow:var(--dialog-shadow);padding:12px;z-index:25}.tag-reprint-shortcut{position:absolute;right:12px;top:12px;z-index:5}
.route-skipped-groups{padding:8px 10px;margin-top:8px;border:1px solid #fde68a;border-radius:6px;background:#fffbeb;color:#b45309;font-size:12px;line-height:1.6;max-height:100px;overflow:auto}.route-skipped-groups p{margin:0}.route-group-badge{white-space:normal}

.route-editor{flex-shrink:0;padding:12px 16px;background:var(--panel);border-bottom:1px solid var(--accent);color:var(--ink)}.route-editor-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.route-editor-actions strong{font-size:14px;letter-spacing:1px}.route-editor-actions label{display:flex;align-items:center;gap:6px;margin:0;font-size:13px}.route-editor-actions input{width:78px;height:34px;padding:5px;border:1px solid #94a3b8;border-radius:8px;background:white}.route-editor p{margin:8px 0 0;font-size:12px;line-height:1.7;color:var(--muted)}.route-metric{font:12px monospace;color:var(--muted);margin-right:auto}.route-waypoints{display:flex;gap:6px;overflow:auto;max-height:72px;margin-top:8px}.route-waypoints button{white-space:nowrap;padding:4px 8px;border:1px solid var(--line);background:var(--background);border-radius:8px;font:12px monospace}.route-waypoints button.active{border-color:var(--accent);background:var(--panel)}.route-waypoints button:disabled{opacity:.5}

.navigation-speeds{min-width:0;margin:16px 0 0;padding:12px 0;border:0;border-top:1px solid var(--line)}.navigation-speeds legend{padding:0 8px 0 0;color:var(--ink);font-size:14px}.speed-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.speed-grid label{min-width:0;margin:0;font-size:14px}.speed-grid input{width:100%;min-width:0;height:42px;margin-top:6px;padding:8px}.navigation-speeds small{display:block;margin-top:8px;color:var(--muted);font-size:12px;line-height:1.6}.navigation-speeds:disabled input{opacity:.55}

.navigation-block-reason{display:flex;align-items:flex-start;gap:8px;margin-top:12px;color:var(--accent);font-size:14px;line-height:1.6;overflow-wrap:anywhere}.navigation-block-reason svg{flex-shrink:0;margin-top:3px}
.navigation-diagnostics summary small{margin-left:auto;font-size:13px;font-weight:400;color:var(--muted)}.navigation-diagnostics summary::after{content:'⌄';font-size:14px;transition:transform .15s}.navigation-diagnostics[open] summary::after{transform:rotate(180deg)}
.fault-reason{margin-top:12px;padding:12px 14px;border-radius:8px;align-items:flex-start;overflow-wrap:anywhere}
.map-pose-card{display:flex;flex-direction:column;gap:7px;margin-top:12px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font-size:14px;overflow-wrap:anywhere}.map-pose-card b{font-weight:500}.map-pose-card small{color:var(--muted);line-height:1.6}
.distance-panel{padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel);flex-shrink:0}
.distance-fields{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.distance-fields label{display:flex;align-items:center;gap:8px;font-size:14px;margin:0;flex:1;min-width:145px}.distance-fields select{width:100%;min-width:0;max-width:220px;height:40px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:white;color:var(--ink)}.distance-arrow{color:var(--muted)}.distance-result{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 16px;margin-top:10px;color:var(--ink);font-size:14px}.distance-result strong{font-size:14px;font-weight:600}.distance-result strong span{font-size:14px;font-weight:400}.distance-result small{display:block;font-size:13px;color:var(--muted)}
.distance-disclaimer{margin-top:2px;line-height:1.55}.canvas-toolbar{flex-wrap:wrap}
.canvas-section{position:relative}
.route-mode-badge{margin-left:6px;padding:1px 7px;border-radius:999px;background:#eff6ff;color:#1d4ed8;font-size:11px;white-space:nowrap}
.route-mode-note{margin-left:6px;color:var(--muted);font-size:11px;white-space:nowrap}
.route-mode-rejected{margin-top:6px;padding:5px 8px;border-radius:6px;background:#fef2f2;color:#b91c1c;font-size:11.5px}
.editor-layout-tools{display:inline-flex;align-items:center;gap:2px;padding-right:6px;margin-right:2px;border-right:1px solid var(--line)}
.editor-layout-tools button{height:28px;width:28px;padding:0}
/* EditorShell 接管布局后，editor-body 只负责外层内边距；内部三栏由外壳的 flex 决定。 */
.editor-body>.editor-shell{flex:1 1 auto;min-width:0;min-height:0;width:100%}
/* 关键 1：路径编辑时 .editor-body 是两列 grid；外壳是它唯一的子元素，必须跨满全部列，
   否则外壳只拿到第一列宽度（272px），中间画布列被算成 0px，所有点击都落在 stage 之外。 */
.editor-body>.editor-shell{grid-column:1/-1;grid-row:1/-1}
/* 关键 2：中间列必须能吃掉剩余宽度。 */
.editor-shell>.editor-shell__main{flex:1 1 0%;min-width:0}
.editor-shell__main>.editor-shell__canvas{flex:1 1 auto;min-height:0}
/* 左右栏折叠时不要保留占位宽度。 */
.editor-shell.is-left-collapsed>.editor-shell__left,.editor-shell.is-right-collapsed>.editor-shell__right{display:none}
/* 路径编辑态：右栏承载「按需属性区」。
   旧实现用 display:flex 强行压过折叠规则，导致「收起右栏 / 关闭属性」都收不进去
   （用户点了没反应）。现在折叠规则统一生效；属性区需要显示时由
   EditorShell 的 inspectorOpen 控制（选择对象时才展开），不再用 !important 级别的覆盖。 */
.app-shell.is-route-editing .editor-shell.is-right-collapsed>.editor-shell__right{display:none}
/* 左栏里的工具/参数卡片在 shell 里不再自己撑宽度。 */
.editor-shell__left .route-tools-panel,.editor-shell__left .left-panel{width:100%!important;flex-basis:auto!important;box-shadow:none;border:0;padding:0;background:transparent}
.editor-shell__right .right-panel{width:100%!important;flex-basis:auto!important;box-shadow:none;border:0;padding:0;background:transparent}
.editor-shell__canvas .canvas-section{width:100%!important;flex:1 1 auto;min-height:0}
/* 编辑器外壳（含菜单条/工具面板）任何宽度下都不得撑出横向滚动条：
   窄屏时 Konva 画布靠 fit() 缩放，而不是让容器变宽。 */
.editor-shell,.editor-shell__row,.editor-shell__menubar,.editor-shell__left,.editor-shell__right{min-width:0;max-width:100%}
/* 宽屏：外壳自己纵向滚动（画布固定高度，参数面板在内部滚）。
   窄屏由 EditorShell 的媒体查询改成 overflow:visible，交给文档滚动。 */
/* 只做宽度约束，不把外壳变成滚动容器：
   外壳一旦自己滚动，里面 position:absolute 的折叠手柄就会固定在视口上方，
   滚动后正好压住画布工具栏上的按钮（窄屏回归就是这么挂的）。 */
.editor-body>.editor-shell{max-width:100%}
.editor-shell__bottom /* 触发器 + 停靠面板必须是一个纵向 flex 列：触发器在上、面板在下。
   否则面板的固定高度会向上溢出，盖住自己的触发器（用户点不开也关不掉）。 */
.route-steps-entry{width:100%;display:flex;flex-direction:column;min-height:0}
/* 底部停靠区必须能容纳「触发器 + 展开的面板」，不能被父级高度压扁。
   否则面板会被压到 8px，用户看不到内容，还挡住触发器。 */
.app-shell.is-route-editing .editor-shell__bottom{overflow:visible}
.app-shell.is-route-editing .editor-shell__bottom>.route-steps-entry{min-height:0;height:auto}
.route-steps-entry>.route-steps-trigger{flex:0 0 auto}
.route-steps-entry>.route-steps-dock{flex:0 0 auto}
@media(max-width:760px){.canvas-section{height:auto;min-height:430px}.distance-panel{padding:10px 12px}.distance-fields{gap:6px}.distance-fields label{min-width:120px}.distance-fields .distance-arrow{display:none}.distance-result strong{font-size:14px}}

.scan-detector-status{margin-top:12px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font-size:14px;line-height:1.65;overflow-wrap:anywhere}
.scan-empty{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;background:var(--background);color:var(--muted);min-height:320px}
.scan-empty strong{font-size:18px;font-weight:500;color:var(--muted)}
.scan-alert{display:flex;align-items:center;gap:8px;color:#b91c1c;background:#fef2f2;padding:10px 14px;font-size:13px;line-height:1.6}
.scan-alert svg{flex-shrink:0}
.scan-details{margin-top:14px;border-top:1px solid var(--panel);padding-top:20px}
.scan-details summary{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:500;color:var(--ink);cursor:pointer;min-height:40px}
.unify-angle-list{margin-top:8px;max-height:160px;overflow:auto;border:1px solid var(--panel);border-radius:6px}
.unify-angle-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:4px 8px;border-top:1px solid var(--panel);font-family:var(--mono);font-size:11px}
.unify-angle-row:first-child{border-top:0}
.sensor-line{gap:12px}.sensor-line>span:first-child{flex-shrink:0}.sensor-line .muted-pill{white-space:normal;text-align:right;overflow-wrap:anywhere}.scan-wait{line-height:1.65;overflow-wrap:anywhere}
.sensor-line b{font-size:14px;color:var(--ink);font-weight:500}
.scan-map-maintenance{margin-top:16px;border-top:1px solid var(--panel);padding-top:16px}
.scan-map-maintenance .panel-title{margin-bottom:10px}
.scan-map-maintenance-hint{margin:0;color:var(--muted);font-size:12px;line-height:1.6}
.map-delete-actions{margin-top:14px;display:flex;flex-direction:column;gap:6px}
.map-delete-actions small{color:var(--muted);font-size:12px;line-height:1.6}
.route-heading-panel{margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--background)}
.route-heading-summary{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:13px}
.route-heading-summary strong{font-weight:600;color:var(--ink)}
.route-heading-summary b{font:13px monospace;color:#b45309}
.route-heading-tag{padding:1px 7px;border-radius:999px;font-size:11px;line-height:1.7}
.route-heading-tag.is-auto{background:#fffbeb;color:#b45309}
.route-heading-tag.is-manual{background:#eef2ff;color:#3730a3}
.route-heading-controls{display:flex;align-items:center;gap:6px;margin-top:8px}
.route-heading-controls .route-heading-input{width:86px;min-width:86px;height:32px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;font:13px monospace;text-align:center;background:white;color:var(--ink)}
.route-heading-hint{display:block;margin-top:8px;color:var(--muted);font-size:11px;line-height:1.6}
.route-manage-list{margin-top:12px;border:1px solid var(--panel);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px}
.route-manage-title{font-size:12px;color:var(--muted);letter-spacing:.5px}
.route-manage-row{display:flex;align-items:center;gap:8px;border-radius:8px;padding:2px 4px}
.route-manage-row.active{background:var(--panel)}
.route-manage-name{flex:1;min-width:0;text-align:left;border:0;background:none;color:var(--ink);font-size:13px;padding:6px 4px;display:flex;flex-direction:column;gap:2px}
.route-manage-name small{color:var(--muted);font-size:11px}
.route-manage-name:disabled{opacity:.6}
.route-manage-delete,.route-editor-delete{color:var(--accent)}
.route-delete-confirm{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);margin-top:4px;padding-top:8px;font-size:12px;line-height:1.7;color:var(--accent)}
.route-exit-confirm-overlay{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.35)}
.route-exit-confirm-box{display:flex;flex-direction:column;gap:10px;min-width:320px;max-width:min(92vw,460px);background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px 18px;box-shadow:0 12px 32px rgba(15,23,42,.24);font-size:13px;line-height:1.7;color:var(--accent)}
.route-exit-confirm-box>div{display:flex;gap:8px;justify-content:flex-end}
.route-delete-confirm>div{display:flex;gap:8px;justify-content:flex-end}
@media(max-width:760px){.scan-empty{min-height:350px}}

/* ---------- 简洁化第二轮：紧凑工具条、折叠区、减少留白 ---------- */
/* 工具按钮：两列紧凑网格 */
.route-tool-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.route-tool-list button{justify-content:center;min-height:30px;height:auto;padding:0 6px;font-size:12px}
.route-tool-extra{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:8px}
.route-tool-extra button{min-height:28px;font-size:11.5px;padding:0 6px}
.route-tool-hint{margin-top:6px;padding:4px 7px;font-size:11px;background:transparent;border:0}
/* 卡片留白收紧 */
.route-tool-card{padding:clamp(10px,0.85vw,14px)}
.route-tool-card .panel-title{margin-bottom:8px}
.panel-toggle{margin-bottom:8px}
/* 扫描页维护折叠 */
.scan-fold{border:0;padding-top:0}
.scan-fold>summary{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#475569;padding:8px 0;list-style:none}
.scan-fold>summary::-webkit-details-marker{display:none}
.scan-fold>summary::after{content:'▸';margin-left:auto;color:#94a3b8;font-size:11px}
.scan-fold[open]>summary::after{content:'▾'}
/* 折叠态指令表：只留标题条 */
.route-commands-panel.is-collapsed{max-height:46px}
.route-commands-panel.is-collapsed .route-commands-scroll{display:none}
.route-commands-panel.is-collapsed .route-commands-head{padding-bottom:10px}
/* 窄屏工具两列 */
@media(max-width:760px){
 .route-tool-list{grid-template-columns:repeat(2,minmax(0,1fr))}
}


/* ---------- 简洁化：指令表折叠、画布优先 ---------- */
.route-commands-toggle{display:flex;align-items:center;gap:8px;width:auto;margin:0;border:0;background:none;padding:0;cursor:pointer;font-size:13px;font-weight:600;color:#1e293b}
.route-commands-toggle:hover{color:var(--accent)}
.route-commands-head{align-items:center;gap:10px}
/* 折叠态：整个面板只有标题条高度，不再挤占画布 */
.route-commands-panel.is-collapsed{max-height:44px}
.route-commands-panel.is-collapsed .route-commands-scroll{display:none}


/* ---------- 自适应：宽屏适度放大、窄屏紧凑，画布优先 ---------- */
.route-tools-panel{width:clamp(220px,15vw,260px);overflow-x:auto;overflow-wrap:anywhere}
/* ===== 紧凑工具格：替代原来的 10 个整行大按钮 =====
   两列网格，图标在上文字在下，单格高度约 44px；常用 5 个工具一屏放得下，
   不再需要滚动去看「撤销/重做」。 */
.route-tool-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:0 0 8px}
.route-tool-grid--low{grid-template-columns:repeat(2,minmax(0,1fr))}
.route-tool-chip{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
 min-height:44px;padding:6px 4px;border:1px solid var(--line);border-radius:8px;background:white;
 color:#334155;font-size:11px;line-height:1.2;cursor:pointer;min-width:0;overflow-wrap:anywhere}
.route-tool-chip span{display:block;max-width:100%;text-align:center}
.route-tool-chip:hover:not(:disabled){background:#f1f6fd;border-color:#b9cde4}
.route-tool-chip.is-active{background:#2563a6;border-color:#2563a6;color:#fff}
.route-tool-chip.is-danger{color:#b91c1c;border-color:#f0c4c4}
.route-tool-chip.is-danger:hover:not(:disabled){background:#fdf2f2}
.route-tool-chip:disabled{color:#a7b0bb;background:#f8fafc;cursor:default}
.route-tool-more{display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:4px 8px;margin:0 0 6px;
 border:1px dashed var(--line);border-radius:8px;background:#fbfcfd;color:#475569;font-size:11px;cursor:pointer;text-align:left}
.route-tool-more:hover{background:#f1f6fd}
.route-tool-more .panel-caret{margin-left:auto}
/* 步骤状态的三档语义（未绘制 / 待处理 / 规划通过），不要用颜色暗示可执行 */
.route-steps-trigger-status.is-muted{color:var(--muted)}
.route-steps-trigger-status.is-warning{color:#b45309}
.route-steps-trigger-status.is-success{color:#15803d}
.route-tool-card{padding:clamp(12px,1vw,16px);border-radius:10px}
.route-tool-card .panel-title{font-size:clamp(13px,0.9vw,15px)}
.route-param-row,.route-tool-hint{font-size:clamp(11.5px,0.55vw + 8px,13px)}
.route-tool-list button{min-height:clamp(28px,2.2vh,34px);height:auto;font-size:clamp(11.5px,0.6vw + 8px,13px)}
/* 底部指令表：限高更小，把高度让给画布；表体内部滚动 */
.route-steps-entry{position:relative;flex:0 0 auto;margin-top:clamp(8px,0.8vw,12px)}
.route-steps-trigger{display:flex;align-items:center;gap:10px;width:100%;min-height:42px;padding:9px 14px;border:1px solid var(--line);border-radius:10px;background:white;box-shadow:var(--card-shadow);color:#1e293b;text-align:left;cursor:pointer}
.route-steps-trigger:hover{background:#f8fbff}.route-steps-trigger-status{margin-left:auto;color:var(--muted);font-size:11px}
.route-steps-collapse-head{display:flex;align-items:center;gap:6px;background:transparent;border:0;padding:0;margin:0;cursor:pointer;color:inherit;font:inherit;min-height:28px}
.route-steps-collapse-head:hover{color:#2563a6}
.route-steps-headline{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;min-height:38px;height:38px;padding:0 8px!important;box-sizing:border-box;overflow:hidden}
.route-steps-headline .route-commands-ops{pointer-events:none}
.route-steps-headline .route-commands-ops button{pointer-events:auto}
.route-steps-headline .route-commands-ops{display:inline-flex;gap:6px;margin-left:auto;flex:0 0 auto}
.route-steps-headline .status-badge{flex:0 0 auto;white-space:nowrap}
.route-steps-headline .route-steps-close{flex:0 0 auto;margin-left:2px}
.route-steps-headline .btn,.route-steps-headline button{min-height:28px;height:28px;padding:0 9px;font-size:12px}
.route-steps-headline .route-steps-collapse-head{height:auto;min-height:28px;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:760px){
 .route-steps-headline{gap:5px;padding:3px 5px}
 .route-steps-headline .btn,.route-steps-headline button{padding:0 6px;font-size:11px}
 .route-steps-headline .route-steps-op-text{display:none}
 .route-steps-headline .route-steps-drag-title{font-size:12px}
 .route-steps-headline .status-badge{max-width:96px;overflow:hidden;text-overflow:ellipsis}
}
/* 步骤面板停靠在底部面板内部（不再 absolute 盖住画布），高度可拖拽调整。
   默认高度 240px；用户拖动上边缘的分隔条可调，上限为底部面板可用高度的 60%。 */
.route-steps-dock{display:flex;flex-direction:column;gap:0;flex:0 0 auto}
/* 桌面停靠：由 EditorShell 的 bottomHeight 分配高度，展开时 canvas 让位。 */
/* dock 高度由内容决定：分隔条 8px + 面板 routeStepsDockHeight。
   显式给高度，避免被上层 flex 压扁成只剩分隔条（那样面板看不见还挡住触发器）。 */
.route-steps-resize-bar{flex:0 0 auto;height:8px;cursor:row-resize;display:flex;align-items:center;justify-content:center;touch-action:none}
.route-steps-resize-bar::after{content:'';width:44px;height:3px;border-radius:2px;background:#cbd5e1}
.route-steps-resize-bar:hover::after{background:#94a3b8}
.route-steps-popover{position:static;z-index:auto;left:auto;right:auto;top:auto;
 display:flex;flex-direction:column;min-height:0;
 /* 关键：不许被父级 flex 压扁。底部面板高度有限时会把它压到 0，
    表现就是「面板打开了但看不见，还把触发器盖住」。 */
 flex:0 0 auto;
 background:white;border:1px solid var(--line);border-radius:10px;box-shadow:none;overflow:hidden}
.route-steps-close{margin-left:auto;border:0;background:transparent;color:var(--muted);font-size:24px;line-height:1;cursor:pointer;padding:2px 7px}.route-steps-close:hover{color:#1e293b}
/* 图内就地改间距：输入框直接压在被点的 cm 标注上 */
.gap-inline{position:absolute;z-index:40;transform:translate(-50%,-50%);display:flex;flex-direction:column;gap:4px;padding:7px 9px;border:1px solid #93c5fd;border-radius:8px;background:white;box-shadow:0 10px 24px rgb(29 78 216 / 22%)}
.gap-inline-head{font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.gap-inline-row{display:flex;align-items:center;gap:5px}
.gap-inline-row input{width:82px;padding:3px 6px;border:1px solid #cbd5e1;border-radius:6px;font:inherit;font-size:12.5px;text-align:right;font-variant-numeric:tabular-nums}
.gap-inline-row input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgb(37 99 235 / 14%)}
.gap-inline-row span{font-size:11px;color:var(--muted)}
.gap-inline-row button{padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:white;font-size:11.5px;color:#334155;cursor:pointer}
.gap-inline-row button[data-testid="gap-inline-apply"]{background:var(--accent);border-color:var(--accent);color:white}
.gap-inline-row button:disabled{opacity:.5;cursor:default}
.gap-inline-error{font-size:11px;color:#b91c1c}
.navigation-map-list{display:flex;flex-direction:column;gap:4px;max-height:150px;overflow-y:auto;margin:7px 0 10px;padding:2px;border:1px solid var(--line);border-radius:7px;background:var(--panel)}
.navigation-map-item{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;width:100%;padding:7px 9px;border:1px solid transparent;border-radius:5px;background:white;color:var(--text);text-align:left;cursor:pointer}
.navigation-map-item:hover{background:#f8fbff}.navigation-map-item.active{border-color:var(--accent);background:#eff6ff}.navigation-map-item:disabled{cursor:not-allowed;opacity:.65}.navigation-map-item strong,.navigation-map-item span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.navigation-map-item span{flex:0 0 auto;color:var(--muted);font-size:11px}.navigation-map-head{padding:5px 8px 3px;color:var(--muted);font-size:11px}.navigation-map-empty{padding:9px;color:var(--muted);font-size:12px;text-align:center}
.route-commands-panel{max-height:clamp(132px,18dvh,208px)}
.route-commands-table th,.route-commands-table td{padding:clamp(5px,0.6vh,8px) clamp(8px,0.8vw,14px);font-size:clamp(11px,0.55vw + 8px,12.5px)}
.route-commands-head{padding:clamp(8px,0.8vh,11px) clamp(10px,0.9vw,14px) clamp(6px,0.6vh,9px)}
.route-commands-ops{flex-wrap:nowrap;gap:6px;padding-right:8px}
.route-commands-ops .btn,.route-commands-ops button{white-space:nowrap;flex:0 0 auto;word-break:keep-all}
@media(max-width:1500px){
 .route-commands-ops{gap:4px}
 .route-commands-ops .btn,.route-commands-ops button{padding-left:8px;padding-right:8px;font-size:11.5px}
}
/* 浮动操作条随屏宽 */
.app-shell.is-route-editing .route-editor{gap:6px;padding:clamp(4px,0.4vw,7px)}
/* 宽屏（≥1600）：整体放大一点，但封顶 */
@media(min-width:1600px){
 html{font-size:14.5px}
 .route-tool-card{padding:16px}
 .route-tool-list button{min-height:34px}
 .route-commands-panel{max-height:216px}
 .route-commands-table th,.route-commands-table td{padding:8px 14px}
}
@media(min-width:1900px){
 html{font-size:15px}
 .route-tools-panel{width:300px}
 .route-tool-card{padding:18px}
}
/* 中窄屏（≤1200）：进一步压缩左栏，画布优先 */
@media(max-width:1200px){
 .route-tools-panel{width:232px}
 .route-tool-card{padding:12px}
 .route-commands-panel{max-height:clamp(120px,16dvh,180px)}
}
/* 窄屏：单列堆叠，不横向溢出 */
@media(max-width:760px){
 .route-tools-panel{width:100%}
 .route-commands-panel{max-height:200px}
 .route-commands-table th,.route-commands-table td{padding:6px 8px}
 .app-shell.is-route-editing .route-editor{padding:6px;gap:6px;flex-wrap:wrap}
}


/* ---------- 折叠：左侧导航 / 卡片标题 / 右侧节点属性面板 ---------- */
.sidebar{position:relative}
.sidebar-toggle{position:absolute;top:20px;right:8px;width:22px;height:22px;border:1px solid var(--line);border-radius:6px;background:white;color:#64748b;font-size:12px;line-height:1;display:grid;place-items:center;z-index:3}
.sidebar-toggle:hover{background:var(--panel);color:var(--accent)}
.app-shell.is-sidebar-collapsed .sidebar{width:64px;padding:16px 8px}
.app-shell.is-sidebar-collapsed .brand{justify-content:center;margin-bottom:20px}
.app-shell.is-sidebar-collapsed .brand>div{display:none}
.app-shell.is-sidebar-collapsed .brand-icon{width:28px;height:28px;padding:6px}
.app-shell.is-sidebar-collapsed .sidebar-toggle{position:static;margin:0 auto 12px;display:grid}
.app-shell.is-sidebar-collapsed .nav-group-label{display:none}
.app-shell.is-sidebar-collapsed .nav-item{justify-content:center;font-size:0;gap:0;padding:10px 0}
.app-shell.is-sidebar-collapsed .nav-item svg{width:20px;height:20px}
.app-shell.is-sidebar-collapsed .sidebar-bottom{justify-content:center;margin:auto 0 0}
.app-shell.is-sidebar-collapsed .sidebar-bottom>div{display:none}

.panel-toggle{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;padding:0;margin:0 0 10px;cursor:pointer;text-align:left;font-size:14px;font-weight:600;color:#1e293b}
.panel-toggle:hover{color:var(--accent)}
.panel-caret{margin-left:auto;color:#94a3b8;font-size:11px}

.app-shell.is-route-editing .route-editor{position:relative}
/* 路径属性：现在放在左侧卡片里，内联滚动，不再浮在画布上 */
.app-shell.is-route-editing .route-details-scroll{position:static;width:auto;max-width:none;max-height:320px;overflow:auto;background:transparent;border:0;box-shadow:none;padding:0;margin-top:0}
.route-props-card{gap:0}
.tag-detail-card .tag-inspector{padding-top:8px}
.tag-detail-card{position:absolute;z-index:35;left:12px;bottom:44px;width:232px;max-height:min(76%,620px);overflow:auto;background:white;border:1px solid var(--line);border-radius:8px;box-shadow:var(--dialog-shadow);padding:10px 12px}
.tag-detail-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.tag-detail-head strong{font-size:13px}
.tag-detail-head button{border:0;background:none;color:#94a3b8;cursor:pointer;font-size:12px;line-height:1}
.tag-detail-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;font-size:12px;color:var(--muted)}
.tag-detail-row b{font:12px var(--mono);color:#334155;white-space:nowrap}

/* ---------- 路径编辑控制台：左侧工具/参数、中间画布、右侧节点属性、底部指令列表 ---------- */
.route-tools-panel{width:clamp(232px,17vw,300px);flex-shrink:0;display:flex;flex-direction:column;gap:clamp(8px,0.8vw,12px);min-height:0;overflow-y:auto;overscroll-behavior:contain}
.route-tool-card{background:white;border:1px solid var(--line);border-radius:8px;box-shadow:var(--card-shadow);padding:14px}
.route-tool-card .panel-title{margin-bottom:10px}
.route-tool-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.route-tool-grid button{width:100%;justify-content:center;min-height:34px}
.route-tool-extra{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
.route-tool-extra button{min-height:30px;height:30px;font-size:12px;padding:0 8px}
.route-tool-list{display:flex;flex-direction:column;gap:5px}
.route-tool-list button{width:100%;justify-content:flex-start;min-height:30px;height:30px;padding:0 10px;font-size:12px;gap:8px}
.route-tool-mode{position:relative}
.route-tool-now{margin-left:auto;font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.22);line-height:1.6}
.route-tool-danger{color:var(--danger)!important;border-color:#fecaca!important;background:#fef2f2!important}
.route-tool-danger:hover:not(:disabled){background:#fee2e2!important}
.route-param-field{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 0;font-size:12px;color:var(--muted)}
.route-param-field input{width:96px;height:32px;font-family:var(--mono);text-align:right}
.route-param-actions{flex-wrap:wrap;gap:6px}
.route-param-actions small{flex:1 1 100%;font-size:10px;color:#94a3b8;line-height:1.5}
.route-commands-ops{display:inline-flex;gap:6px;margin-left:auto}
.route-commands-ops button{min-height:30px;padding:0 10px}
.route-commands-table tbody tr{cursor:pointer}
.route-commands-table tbody tr.active,.route-commands-table tbody tr.active:hover{background:#dbeafe;box-shadow:inset 4px 0 0 var(--accent);font-weight:600}
.route-type-select{width:auto;min-width:96px;height:28px;padding:2px 6px;font-size:12px;border-radius:6px;background:white}
.route-type-select.blocked{border-color:#fde68a;color:#b45309}
.route-commands-table tbody tr.active td{color:#1e3a8a}
.route-leg-cell{display:flex;align-items:center;gap:4px;min-width:104px}
.route-leg-input{width:74px;min-width:74px;padding:2px 5px;border:1px solid var(--line);border-radius:5px;font:inherit;text-align:right;font-variant-numeric:tabular-nums}
.route-leg-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px rgb(37 99 235 / 12%)}
.route-leg-input:disabled{opacity:.6}
.route-leg-cm{color:var(--muted);font-size:10.5px;white-space:nowrap}
.route-command-ops{display:flex;gap:4px;flex-wrap:nowrap}
.route-command-ops button{width:26px;height:26px;padding:0;border:1px solid var(--line);border-radius:6px;background:white;color:#475569;font-size:12px;line-height:1}
.route-command-ops button:disabled{opacity:.4}
.route-command-ops button:not(:disabled):hover{background:var(--panel);border-color:#93c5fd;color:var(--accent)}
.route-command-remove:not(:disabled):hover{background:#fef2f2!important;border-color:#fecaca!important;color:var(--danger)!important}
.node-prop-field{display:flex;flex-direction:column;align-items:stretch;gap:5px;margin:8px 0;font-size:12px;color:var(--muted)}
.node-prop-field select{width:100%;height:32px;font-size:12px;padding:4px 6px}
.route-tool-hint{display:flex;align-items:flex-start;gap:7px;margin-top:10px;padding:8px 9px;border:1px solid #dbeafe;border-radius:6px;background:#f8fbff;color:#1e40af;font-size:11px;line-height:1.6}
/* 工具条下方的状态行：比原来的左栏提示卡更薄，横向排列，随工具条一起换行。 */
.route-tool-hint--bar{margin-top:0;margin-bottom:2px;padding:4px 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-radius:8px}
.route-tool-hint--bar .route-mode-badge{margin-left:0}
.route-mode-badge{display:inline-flex;align-items:center;padding:1px 6px;border-radius:999px;background:#dbeafe;color:#1d4ed8;font-size:10px;font-weight:600}
.route-mode-note{color:#64748b;font-size:10px}
.route-mode-rejected{margin:-4px 0 2px;padding:4px 8px;border-radius:6px;background:#ffebe9;color:#a40e26;font-size:11px}
.route-tool-dot{width:7px;height:7px;border-radius:50%;background:#94a3b8;flex:0 0 auto}
.route-tool-dot.is-draw{background:#2563a6}.route-tool-dot.is-connect{background:#d97706}.route-tool-dot.is-pan{background:#0f766e}
.route-tool-dot{flex:0 0 7px;width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--accent)}
.route-tool-dot.is-pan{background:#0f766e}
.route-tool-dot.is-select{background:var(--accent)}
.route-tool-dot.is-draw{background:#b45309}
.route-param-row{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px;padding:6px 0;font-size:12px;color:var(--muted)}
.route-map-pick{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);margin-bottom:6px}
.route-map-pick select{height:32px;border:1px solid var(--line);border-radius:6px;background:#fff;font-size:12px;padding:0 6px;max-width:100%}
.route-map-empty{margin:6px 0;padding:8px;border:1px dashed var(--line);border-radius:6px;background:var(--panel);font-size:11px;line-height:1.6;color:var(--muted)}
.route-map-hint{display:block;margin-top:4px;font-size:11px;color:var(--muted);line-height:1.5}
.route-panel-actions{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.route-tool-compact{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:2px 0 8px}
.command-feedback-inline{display:flex;align-items:center;gap:8px;margin:6px 16px;padding:6px 10px;border-radius:6px;font-size:12px;line-height:1.5;max-width:100%;box-sizing:border-box}
.command-feedback-inline.is-ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d}
.command-feedback-inline.is-waiting{background:#fffbeb;border:1px solid #fef3c7;color:#b45309}
.command-feedback-inline.is-bad{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c}
.command-feedback-close{margin-left:auto;flex:0 0 auto;background:transparent;border:0;cursor:pointer;font-size:15px;line-height:1;color:inherit;opacity:.7;padding:0 2px}
.command-feedback-close:hover{opacity:1}
.route-tool-compact button{width:100%;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:32px;padding:0 6px;font-size:12px}
.scan-handoff{margin:8px 0 12px}
.route-param-row>span:first-child{white-space:nowrap}
.route-param-row>b{font:12px var(--mono);color:#334155;text-align:right;white-space:nowrap}
.route-param-row>.badge,.route-param-row>.route-name-auto{justify-self:end}
.route-speed-box{display:flex;align-items:center;gap:6px;justify-self:end;min-width:0}
.route-speed-box input{width:78px;height:30px;padding:2px 8px;text-align:right;font-family:var(--mono)}
.route-speed-saved{font-size:11px;color:#94a3b8;white-space:nowrap}
.route-param-row .route-name-auto{max-width:158px}
.route-node-nav{display:inline-flex;gap:4px}
.route-node-nav button{min-height:26px;padding:0 8px;font-size:11px}

.route-commands-panel{flex:0 0 auto;margin-top:clamp(8px,0.8vw,12px);background:white;border:1px solid var(--line);border-radius:10px;box-shadow:var(--card-shadow);display:flex;flex-direction:column;overflow:hidden;max-height:clamp(132px,18dvh,208px)}
.route-commands-head{display:flex;align-items:center;gap:10px;padding:10px 14px 8px;flex-shrink:0}
.route-commands-head strong{font-size:13px;font-weight:600;color:#1e293b}
.route-commands-head .badge{background:var(--panel);border-color:var(--line);color:var(--muted)}
.route-commands-head .status-badge{margin-left:auto}
.route-commands-scroll{flex:1;min-height:0;overflow:auto}
.route-commands-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
/* 列宽固定：操作列必须留够 3 个按钮的位置，否则在最右会被裁掉。
   距离列给输入框 + cm 提示留出真实空间。 */
.route-commands-table{table-layout:fixed;width:100%;min-width:0}
.route-commands-table col.col-index{width:3.4%}
.route-commands-table col.col-name{width:14%}
.route-commands-table col.col-type{width:10%}
.route-commands-table col.col-qr{width:12.5%}
.route-commands-table col.col-coord{width:11.5%}
.route-commands-table col.col-speed{width:10.5%}
.route-commands-table col.col-distance{width:15%}
.route-commands-table col.col-dwell{width:7.6%}
.route-commands-table col.col-ops{width:15.5%}
.route-commands-table td.route-command-ops{white-space:nowrap}
.route-leg-editable{color:var(--accent);font-size:10px;font-weight:600;letter-spacing:0;white-space:nowrap;opacity:.85}
.route-commands-table th{position:sticky;top:0;z-index:1;background:var(--panel);color:var(--muted);font-weight:600;font-size:11px;text-align:left;padding:7px 12px;border-bottom:1px solid #eef2f7;white-space:normal;line-height:1.25;vertical-align:bottom}
.route-commands-table td:first-child,.route-commands-table th:first-child{overflow:visible;text-overflow:clip;padding-right:4px}
.route-commands-table td{padding:7px 12px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.route-commands-table td.route-leg-cell,.route-commands-table td.route-command-ops{overflow:visible;text-overflow:clip}
/* 路径步骤「距离 / m」可编辑：给输入框固定宽度与数字排版，
   否则在 nowrap 的窄列里会被压成只显示一位数字和下拉箭头。 */
.route-commands-table .route-leg-input{
 width:76px;min-width:76px;box-sizing:border-box;
 padding:3px 6px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;
 color:#0f172a;font:inherit;font-variant-numeric:tabular-nums;text-align:right;
}
.route-commands-table .route-leg-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgb(37 99 235 / 12%)}
.route-commands-table .route-leg-input:disabled{background:#f8fafc;color:#94a3b8}
/* 第一步没有路段距离：用同样的排版占位，但不画成输入框。 */
.route-commands-table .route-leg-input.is-static{display:inline-block;width:76px;min-width:76px;padding:3px 6px;border-color:transparent;background:transparent;color:var(--muted);text-align:right;box-sizing:border-box}
.route-commands-table td:has(> .route-leg-input){padding-left:6px;padding-right:6px}
.route-commands-table th:nth-child(7){min-width:96px}
/* 该列同时给出 cm 以便现场核对 */
.route-leg-hint{margin-left:4px;margin-right:6px;color:var(--muted);font-size:10.5px;font-variant-numeric:tabular-nums}
.route-commands-table td.route-leg-cell{padding-right:8px}
/* 停留列单独右对齐，和距离列之间保持清晰间隔 */
.route-commands-table th:nth-child(8),.route-commands-table td:nth-child(8){padding-left:12px;text-align:right}
@media(max-width:1200px){
 .route-commands-table .route-leg-input{width:72px;min-width:72px}
}
.route-commands-table tbody tr:nth-child(even){background:#fcfdff}
.route-commands-table tbody tr:hover{background:#f1f7ff}
.route-commands-table tbody tr.blocked{background:#fffbeb}
.route-commands-table tbody tr.blocked td{color:#b45309}
.route-command-state{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;line-height:1.7}
.route-command-state.is-ok{background:#f0fdf4;color:#15803d}
.route-command-state.is-blocked{background:#fef3c7;color:#b45309}
.route-commands-empty{text-align:center;color:var(--muted);padding:18px 12px!important;white-space:normal!important}

.node-prop-card{flex:0 0 auto;margin-top:10px;padding:10px 0 0;border-top:1px solid var(--line)}
.node-prop-card .route-properties-heading small{font-size:11px;color:var(--muted);font-family:var(--mono)}
/* 路点/二维码属性：原来 .route-inspector-rows 完全没有样式，dt/dd 是块级元素
   → 标签与数值上下堆成一列，看起来像文字互相压住。这里做成「左标签 / 右数值」。 */
.route-inspector{display:flex;flex-direction:column;gap:8px;min-width:0}
.route-properties-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.route-properties-heading strong{font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap}
.route-inspector-rows{display:flex;flex-direction:column;margin:0;padding:0;min-width:0}
.route-inspector-rows>div{display:grid;grid-template-columns:minmax(64px,auto) minmax(0,1fr);align-items:start;gap:10px;padding:6px 0;border-bottom:1px solid var(--line)}
.route-inspector-rows>div:last-child{border-bottom:none}
.route-inspector-rows dt{margin:0;font-size:12px;line-height:1.6;color:var(--muted);white-space:nowrap}
.route-inspector-rows dd{margin:0;font-size:12px;line-height:1.6;color:var(--ink);text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.route-inspector-warn{margin:0;padding:6px 8px;border:1px solid #fecaca;border-radius:6px;background:#fef2f2;color:#b91c1c;font-size:12px;line-height:1.6}
.route-inspector-hint{margin:0;font-size:11px;line-height:1.6;color:var(--muted)}
.node-prop-list{display:flex;flex-direction:column;margin-top:10px}
.node-prop-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;font-size:12px;color:var(--muted)}
.node-prop-row>b{font:12px var(--mono);color:#334155;overflow-wrap:anywhere;text-align:right}
.node-prop-empty{margin:8px 0 0;padding:10px;border:1px dashed var(--line);border-radius:6px;background:var(--panel);color:var(--muted);font-size:11px;line-height:1.7}

.app-shell.is-route-editing .editor-body{position:relative;display:grid;grid-template-columns:clamp(220px,15vw,260px) minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;gap:clamp(8px,0.9vw,14px);align-content:stretch}
/* 窄屏（≤1024px）改为单列堆叠：画布优先并保住最小可用高度，
   左栏工具面板移到画布下方。双列网格会在窄屏把 canvas 挤成 0 高（实测 375/760 都是 0）。 */
@media(max-width:1024px){
 /* 窄屏/矮屏：canvas 必须优先并保住确定高度。
    .editor-body 在窄屏是 flex+wrap（style.css 的 @media(max-width:940px)），不是 grid；
    左栏工具面板可达 2000px 高，会把画布顶出视口、高度塌成 0。 */
 /* 真实链路：EditorShell 的窄屏媒体查询把 .editor-shell__row 变成 flex-direction:column，
    左栏（工具面板可达 2000px 高）排在 .editor-shell__main 之前，把画布推到 y=2416、
    高度塌成 0。所以要在 row 内部让 main 排第一、左栏排第二。 */
 .app-shell.is-route-editing :deep(.editor-shell__row){display:flex;flex-direction:column}
 .app-shell.is-route-editing :deep(.editor-shell__row)>.editor-shell__main{order:1!important;flex:0 0 auto!important;min-height:0}
 .app-shell.is-route-editing :deep(.editor-shell__canvas){height:min(58vh,480px);min-height:280px;flex:0 0 auto}
 .app-shell.is-route-editing :deep(.editor-shell__canvas)>.canvas-section{height:100%;min-height:0}
 .app-shell.is-route-editing :deep(.editor-shell__row)>.editor-shell__left{order:2!important;flex:0 0 auto!important;max-height:none;width:100%!important;flex-basis:auto!important}
 .app-shell.is-route-editing .route-tools-panel{width:100%!important;max-height:none;flex:0 0 auto}
 /* 窄屏工具条必须收缩到视口内：否则保存/退出会被推到视口右侧外（实测 375px 时
    save 在 x=427、exit 在 x=463，right=495 > 375，两个按钮都点不到）。 */
 .app-shell.is-route-editing .route-editor{width:100%;max-width:100%;min-width:0;box-sizing:border-box}
 .app-shell.is-route-editing .route-editor :deep(.route-editor-toolbar){width:100%;max-width:100%;min-width:0;box-sizing:border-box}
 .app-shell.is-route-editing .editor-body{display:flex;flex-direction:column;align-items:stretch;overflow-y:auto}
 .app-shell.is-route-editing :deep(.editor-shell){flex:0 0 auto;min-height:0}

}
/* 路径编辑器工具条：占据第一行、横跨画布列，**不再 absolute 浮在画布上**。
   行高由内容决定，所以窗口变矮时它也不会被裁掉。 */
/* 路径编辑态：canvas slot 内部改为「画布占满 + 工具条 + 状态行」的列布局。
   工具条在文档流里（不是 absolute），所以永远不会盖住画布内容。 */
.app-shell.is-route-editing .editor-shell__canvas{display:flex;flex-direction:column;min-height:0}
.app-shell.is-route-editing .editor-shell__canvas>.canvas-section{flex:1 1 auto;min-height:0}
/* 工具条必须严格贴合画布列宽：实测 1280 时工具条宽 785 > 画布列 636，右侧越界压到 inspector，保存/退出中心点被 editor-shell-inspector-body 命中。 */
.app-shell.is-route-editing .editor-shell__canvas>.route-editor{width:auto;max-width:100%;min-width:0;box-sizing:border-box;align-self:stretch}
.app-shell.is-route-editing .route-editor{flex:0 0 auto;position:static;z-index:auto;top:auto;right:auto;
 display:flex;flex-direction:row;align-items:center;flex-wrap:wrap;gap:clamp(4px,0.4vw,8px);
 background:white;border:1px solid var(--line);border-radius:10px;box-shadow:var(--card-shadow);
 margin-top:8px;padding:clamp(4px,0.5vw,8px) clamp(6px,0.6vw,10px);max-height:none;overflow:visible}
.app-shell.is-route-editing .canvas-section{grid-column:2;grid-row:1}
.app-shell.is-route-editing .route-commands-panel{grid-column:2;grid-row:3}
.app-shell.is-route-editing .route-tools-panel{grid-column:1;grid-row:1/4;min-height:0;overflow-y:auto;overflow-x:auto}
.app-shell.is-route-editing .route-tools-panel{grid-column:1;grid-row:1/3;min-height:0}
.app-shell.is-route-editing .canvas-section{grid-column:2;grid-row:1;min-height:0}
.app-shell.is-route-editing .route-commands-panel{grid-column:2;grid-row:2;margin-top:0}
/* 注意：上面已经把 route-editor 改成 grid 行内的静态工具条；
   这里只保留「窗口较矮时仍可见」的兜底，不再重新引入 absolute。 */
.app-shell.is-route-editing .route-editor{position:static;height:auto;max-height:none}
.app-shell.is-route-editing .route-editor-actions{flex:0 0 auto;flex-wrap:wrap;gap:6px;height:auto}
.app-shell.is-route-editing .route-details-scroll{position:static;flex:1;min-height:0;overflow-y:auto;width:auto;max-width:none;border:0;border-radius:0;box-shadow:none;padding:10px 0 0;margin-top:8px;border-top:1px solid var(--line)}
@media(max-width:1500px){.app-shell.is-route-editing .editor-body{grid-template-columns:clamp(224px,16vw,268px) minmax(0,1fr)}.route-tools-panel{width:clamp(224px,16vw,268px)}}
@media(max-width:1200px){.app-shell.is-route-editing .editor-body{grid-template-columns:clamp(210px,20vw,248px) minmax(0,1fr)}}
@media(max-width:760px){
 .app-shell.is-route-editing .editor-body{display:flex;flex-direction:column;flex-wrap:nowrap;overflow-y:auto;padding:0 12px 12px}
 /* 窄屏同样保持「工具条在画布上方」：order 交换，工具条先、画布后。
    实测原顺序在 760/375 下 toolbar y=434 而 canvas y=101，工具条落到画布下方。 */
 .app-shell.is-route-editing .route-editor{position:static;order:1;flex:none;max-height:none;height:auto;margin-top:8px;justify-content:space-between;width:100%}
 .app-shell.is-route-editing .canvas-section{order:2;flex:none;height:60dvh;min-height:449px}
 .app-shell.is-route-editing .route-editor button{flex:1 1 auto;min-width:0}
 .app-shell.is-route-editing .route-details-scroll{position:static;width:auto;max-width:none;max-height:none;margin-top:8px}
 .tag-detail-card{position:static;width:auto;margin-top:8px}
 .route-tools-panel{width:100%;overflow:visible;flex:none;order:3}
 .app-shell.is-route-editing .route-commands-panel{order:4;max-height:260px}
 .app-shell.is-route-editing .route-commands-panel.is-collapsed{max-height:46px}
 .route-tool-grid{grid-template-columns:1fr 1fr}
 .route-commands-table th,.route-commands-table td{padding:6px 8px}
 /* 移动端父容器高度是 auto，flex:1 + overflow:hidden 会把操作行压成 0 高，必须放开 */
 .app-shell.is-route-editing .route-editor-body{flex:none;min-height:0;overflow:visible}
 .route-rail{flex-direction:row;justify-content:center;margin-top:8px}
}
.scan-detector-inference{display:flex;flex-direction:column;gap:4px;margin-top:12px;padding:10px 12px;border:1px solid #bfdbfe;border-radius:8px;background:#eff6ff;color:#1e3a8a;font-size:12px;line-height:1.6}.scan-detector-inference strong{font-weight:600}.scan-detector-inference small{color:#475569}.scan-detector-inference.is-unregistered{border-color:#fed7aa;background:#fff7ed;color:#9a3412}.scan-detector-inference.is-unregistered small{color:#9a3412}
</style>
