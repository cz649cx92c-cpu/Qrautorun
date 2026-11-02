<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {
 TOPOLOGY_DISCLAIMER,
 addEdge,
 moveOccurrence,
 nextOccurrence,
 removeEdge,
 reverseEdge,
 topologyStrategyChoices,
 topologySummary,
 validateTopology,
 type RouteTopology,
 type TopologyEdge,
 type TopologyIssue,
} from '../../../shared/route-topology';
import {strategyOptions} from '../../../shared/segment-strategy';
import type {Point} from '../../../shared/model';
import Button from './ui/Button.vue';
import {AlertTriangle, ArrowLeftRight, CheckCircle2, ChevronDown, ChevronRight, Link2, Plus, RefreshCw, Save, Trash2} from 'lucide-vue-next';

/**
 * 路线拓扑面板（稳定 tagId 的有向图）。
 *
 * 为什么要有这一层：`points` 只是一条折线副本，`motionSegments` 靠数组顺序区分
 * 「第几次经过同一对码」。折线一被拖动，点就可能离开它本该绑定的码心；同一对码
 * 经过两次也无法表达。这里用**真实 tagId** 作为顶点、`occurrence` 显式记录
 * 「第几次经过」，把顺序、策略、中间点都挂在边上。
 *
 * 三条硬边界，本组件一条都不放宽：
 *  1. 几何是渲染结果。保存时把拓扑展平成交给后端**现有** `compileDesignedRoute`
 *     的折线，正交/8cm 最短段/50m 最长段/点数/区间数/端点捕获全在那边判定。
 *  2. 保存拓扑 ≠ 允许实车执行。界面原样展示后端下发的免责声明，并且从不调用
 *     任何导航启动接口。
 *  3. 本组件不修改地图二维码坐标，也不改 props。
 */

const props=defineProps<{
 routeId:string;
 mapId:string;
 version:number;
 tags:{id:number;x:number;y:number}[];
 aliases?:{tagId:number;name:string}[];
 disabled?:boolean;
 /** 画布上刚连出来的有向边，等待用户在这里确认后加入拓扑。 */
 pendingLink?:{fromId:number;toId:number}|null;
}>();
const emit=defineEmits<{applied:[result:any];dirty:[value:boolean];'pending-consumed':[]}>();

type Direction='forward'|'reverse'|'lateral';
type Mode='4t4d'|'crab';

const busy=ref(false),loading=ref(false),error=ref(''),message=ref('');
const stored=ref(false);
const topology=ref<RouteTopology>({nodes:[],edges:[]});
const summary=ref<string[]>([]);
const issues=ref<TopologyIssue[]>([]);
const disclaimer=ref(TOPOLOGY_DISCLAIMER);
const savePoints=ref(false);
const dirty=ref(false);
watch(dirty,value=>emit('dirty',value),{immediate:true});

/** 新增区间的表单。默认取上一段的终点作为起点，减少现场手点。 */
const draftFrom=ref(0),draftTo=ref(1),draftMode=ref<Mode>('4t4d'),draftDirection=ref<Direction>('forward');
const draftStrategy=ref('auto'),draftWaypoints=ref<Point[]>([]);
const waypointX=ref(''),waypointY=ref('');

const tagIds=computed(()=>[...props.tags].map(tag=>tag.id).sort((a,b)=>a-b));
const aliasByTagId=computed(()=>new Map((props.aliases??[]).map(alias=>[alias.tagId,alias.name])));
const label=(id:number)=>aliasByTagId.value.get(id)??('Q'+String(id).padStart(3,'0'));
const labelWithId=(id:number)=>{
 const name=aliasByTagId.value.get(id);
 return name?`${name}（Q${id}）`:`Q${id}`;
};

const centers=computed(()=>props.tags.map(tag=>({id:tag.id,x:tag.x,y:tag.y})));

/** 本地校验：改完立刻能看到断链/未知码/斜线，不必等保存被拒。 */
const report=computed(()=>validateTopology(topology.value,centers.value));
const localErrors=computed(()=>report.value.errors);
const localWarnings=computed(()=>report.value.warnings);
const canSave=computed(()=>!props.disabled&&!busy.value&&!localErrors.value.length&&topology.value.edges.length>0);

const edges=computed(()=>topology.value.edges.map((edge,index)=>({
 index,
 edge,
 fromLabel:labelWithId(edge.fromId),
 toLabel:labelWithId(edge.toId),
 title:`第 ${index+1} 段 · ${labelWithId(edge.fromId)} → ${labelWithId(edge.toId)}`,
 occurrenceText:edge.occurrence>1?`第 ${edge.occurrence} 次经过`:'',
 pairTotal:topology.value.edges.filter(other=>other.fromId===edge.fromId&&other.toId===edge.toId).length,
})));

const usedTags=computed(()=>new Set(topology.value.edges.flatMap(edge=>[edge.fromId,edge.toId])));
const orphanTags=computed(()=>topology.value.nodes.map(node=>node.tagId).filter(id=>!usedTags.value.has(id)));
const unusedMapTags=computed(()=>tagIds.value.filter(id=>!usedTags.value.has(id)));

const directionOptions:{value:Direction;label:string}[]=[
 {value:'forward',label:'前进'},
 {value:'reverse',label:'倒车'},
 {value:'lateral',label:'横移（Crab）'},
];

const syncModeWithDirection=()=>{
 if(draftDirection.value==='lateral'&&draftMode.value!=='crab')draftMode.value='crab';
 if(draftDirection.value!=='lateral'&&draftMode.value==='crab')draftMode.value='4t4d';
};

/** 从后端拉取：没存过也会从 motionSegments 还原，所以旧路径同样能打开。 */
async function load(){
 if(!props.routeId){topology.value={nodes:[],edges:[]};return;}
 loading.value=true;error.value='';
 try{
  const response=await fetch('/api/routes/'+encodeURIComponent(props.routeId)+'/topology');
  const json=await response.json();
  if(!response.ok)throw new Error(json.error??'读取路线拓扑失败');
  topology.value=json.topology??{nodes:[],edges:[]};
  stored.value=!!json.stored;
  summary.value=json.summary??[];
  issues.value=json.issues??[];
  disclaimer.value=json.disclaimer??TOPOLOGY_DISCLAIMER;
  dirty.value=false;
  const last=topology.value.edges.at(-1);
  if(last){draftFrom.value=last.toId;}
 }catch(e){error.value=(e as Error).message;}
 finally{loading.value=false;}
}

watch(()=>props.routeId,()=>{void load();},{immediate:true});

/** 画布连线 → 这里只是「待确认」。用户点「加入拓扑」才会走 addEdge。 */
const pendingText=computed(()=>{
 const link=props.pendingLink;
 return link?`画布刚连出 Q${link.fromId} → Q${link.toId}`:'';
});
function acceptPendingLink(){
 const link=props.pendingLink;
 if(!link)return;
 const result=addEdge(topology.value,{fromId:link.fromId,toId:link.toId,mode:'4t4d',direction:'forward'});
 applyEdit(result);
 emit('pending-consumed');
}

/** 每次编辑都走 shared 纯函数：被拒的编辑拿回原图 + 中文 issues，不会留下半成品。 */
function applyEdit(result:{topology:RouteTopology;issues:TopologyIssue[]}){
 topology.value=result.topology;
 issues.value=result.issues;
 dirty.value=true;
 summary.value=topologySummary(result.topology,centers.value);
 const blocking=result.issues.filter(issue=>issue.severity==='error');
 error.value=blocking.length?blocking.map(issue=>issue.message).join('；'):'';
 message.value=blocking.length?'':'已修改，记得保存';
}

function addCurrent(){
 syncModeWithDirection();
 const result=addEdge(topology.value,{
  fromId:draftFrom.value,toId:draftTo.value,
  mode:draftMode.value,direction:draftDirection.value,
  ...(draftStrategy.value!=='auto'?{strategy:draftStrategy.value}:{}),
  ...(draftWaypoints.value.length?{waypoints:draftWaypoints.value.map(point=>({...point}))}:{}),
 });
 applyEdit(result);
 if(!result.issues.some(issue=>issue.severity==='error')){
  draftFrom.value=draftTo.value;
  draftWaypoints.value=[];
  waypointX.value='';waypointY.value='';
 }
}

const removeAt=(index:number)=>{
 const edge=topology.value.edges[index];
 if(!edge)return;
 applyEdit(removeEdge(topology.value,edge.fromId,edge.toId,edge.occurrence));
};
const reverseAt=(index:number)=>{
 const edge=topology.value.edges[index];
 if(!edge)return;
 applyEdit(reverseEdge(topology.value,edge.fromId,edge.toId,edge.occurrence));
};
const moveAt=(index:number,delta:number)=>{
 const edge=topology.value.edges[index];
 if(!edge)return;
 applyEdit(moveOccurrence(topology.value,edge.fromId,edge.toId,edge.occurrence,edge.occurrence+delta));
};

/** 策略与中间点是「这一次通过」的属性，直接改在那条边上。 */
function setStrategy(index:number,value:string){
 const next:RouteTopology={nodes:topology.value.nodes.map(node=>({tagId:node.tagId})),edges:topology.value.edges.map(edge=>({...edge}))};
 const edge=next.edges[index];
 if(!edge)return;
 if(value==='auto')delete edge.strategy;else edge.strategy=value;
 topology.value=next;dirty.value=true;summary.value=topologySummary(next,centers.value);
 const choices=topologyStrategyChoices(next);
 issues.value=choices.issues;
 error.value='';message.value='已修改策略，记得保存';
}

function addWaypoint(index:number){
 const x=Number(waypointX.value),y=Number(waypointY.value);
 if(!Number.isFinite(x)||!Number.isFinite(y)){error.value='中间点坐标必须是数字';return;}
 const next:RouteTopology={nodes:topology.value.nodes.map(node=>({tagId:node.tagId})),edges:topology.value.edges.map(edge=>({...edge}))};
 const edge=next.edges[index];
 if(!edge)return;
 edge.waypoints=[...(edge.waypoints??[]),{x:Math.round(x*1e6)/1e6,y:Math.round(y*1e6)/1e6}];
 topology.value=next;dirty.value=true;waypointX.value='';waypointY.value='';
 summary.value=topologySummary(next,centers.value);
 const check=validateTopology(next,centers.value);
 issues.value=[...check.errors,...check.warnings];
 error.value=check.errors.map(issue=>issue.message).join('；');
 message.value=check.errors.length?'':'已加中间点，记得保存';
}

function removeWaypoint(index:number,waypointIndex:number){
 const next:RouteTopology={nodes:topology.value.nodes.map(node=>({tagId:node.tagId})),edges:topology.value.edges.map(edge=>({...edge}))};
 const edge=next.edges[index];
 if(!edge?.waypoints)return;
 edge.waypoints=edge.waypoints.filter((_,position)=>position!==waypointIndex);
 if(!edge.waypoints.length)delete edge.waypoints;
 topology.value=next;dirty.value=true;
 summary.value=topologySummary(next,centers.value);
 const check=validateTopology(next,centers.value);
 issues.value=[...check.errors,...check.warnings];
 error.value=check.errors.map(issue=>issue.message).join('；');
 message.value=check.errors.length?'':'已删除中间点，记得保存';
}

async function save(){
 if(!canSave.value)return;
 busy.value=true;error.value='';
 try{
  const response=await fetch('/api/routes/'+encodeURIComponent(props.routeId)+'/topology',{
   method:'PUT',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({baseVersion:props.version,topology:topology.value,savePoints:savePoints.value}),
  });
  const json=await response.json();
  if(!response.ok)throw new Error(json.error??'保存路线拓扑失败');
  topology.value=json.topology??topology.value;
  stored.value=true;dirty.value=false;
  summary.value=json.summary??[];
  issues.value=json.issues??[];
  message.value=savePoints.value?'拓扑已保存，折线已按拓扑重写':'拓扑已保存（折线未改动）';
  emit('applied',json);
 }catch(e){error.value=(e as Error).message;}
 finally{busy.value=false;}
}

const reload=()=>{void load();};

/** 每段详情是否展开：默认全部收起，只显示「起点→终点 + 重复经过」一行。 */
const openEdges=ref<Set<number>>(new Set());
const isEdgeOpen=(index:number):boolean=>openEdges.value.has(index);
function toggleEdge(index:number):void{
 const next=new Set(openEdges.value);
 if(next.has(index))next.delete(index);else next.add(index);
 openEdges.value=next;
}
/** 新加载/切换路线时回到全收起，避免上一份路线的展开状态串到新数据。 */
watch(()=>props.routeId,()=>{openEdges.value=new Set();});

</script>

<template>
 <div class="rt" data-testid="route-topology-panel" :data-route-id="routeId" :data-map-version="version"
  :data-topology-edges="topology.edges.length" :data-topology-stored="stored?'1':'0'"
  :data-topology-dirty="dirty?'1':'0'" :data-topology-errors="localErrors.length">
  <div class="rt-head">
   <strong><Link2 :size="15"/> 路线拓扑（按二维码编号）</strong>
   <span :class="['rt-badge',localErrors.length?'bad':'ok']" data-testid="route-topology-status">
    {{localErrors.length?'拓扑不完整':'拓扑可保存'}}
   </span>
   <span v-if="stored" class="rt-badge stored" data-testid="route-topology-stored">已保存</span>
   <span v-else class="rt-badge auto" data-testid="route-topology-restored">由运动区间还原</span>
  </div>
  <p class="rt-hint">{{disclaimer}}</p>

  <div v-if="pendingLink" class="rt-pending" data-testid="route-topology-pending" role="status">
  <span>{{pendingText}}</span>
  <Button size="sm" :disabled="disabled||busy" data-testid="route-topology-pending-accept" @click="acceptPendingLink"><Plus :size="13"/>加入拓扑</Button>
 </div>
 <div v-if="loading" class="rt-hint" data-testid="route-topology-loading">正在读取拓扑…</div>
  <div v-if="error" class="rt-alert error" role="alert" data-testid="route-topology-error"><AlertTriangle :size="14"/><span>{{error}}</span></div>
  <div v-if="message" class="rt-alert ok" role="status" data-testid="route-topology-message"><CheckCircle2 :size="14"/><span>{{message}}</span></div>

  <!-- 1. 有向段列表 -->
  <section class="rt-sec" data-testid="route-topology-edges">
   <h4>有向区间 <small>{{topology.edges.length}} 段 · {{usedTags.size}} 个码</small></h4>
   <p v-if="!topology.edges.length" class="rt-hint" data-testid="route-topology-empty">还没有任何区间。选择起点与终点二维码后点「加一段」。</p>
   <ol class="rt-edges">
    <li v-for="row in edges" :key="row.index" :data-testid="'route-topology-edge-'+row.index"
     :data-from="row.edge.fromId" :data-to="row.edge.toId" :data-occurrence="row.edge.occurrence">
     <!-- 默认只显示「起点→终点 + 重复经过」这一行；模式/策略/反向/删除收进详情，
          避免 12 段常驻把左栏撑成一列长卡。真实路线与 occurrence 数据不变。 -->
     <div class="rt-edge-title">
      <b>{{row.title}}</b>
      <span v-if="row.occurrenceText" class="rt-chip" data-testid="'route-topology-occurrence-'+row.index">{{row.occurrenceText}}</span>
      <button type="button" class="rt-edge-expand" :aria-expanded="isEdgeOpen(row.index)"
       :aria-label="'展开第 '+(row.index+1)+' 段详情'" :data-testid="'route-topology-expand-'+row.index"
       @click="toggleEdge(row.index)">
       <component :is="isEdgeOpen(row.index) ? ChevronDown : ChevronRight" :size="13"/>
      </button>
     </div>
     <div v-show="isEdgeOpen(row.index)" class="rt-edge-meta" :data-testid="'route-topology-meta-'+row.index">
      <span class="rt-chip mode">{{row.edge.mode==='crab'?'Crab':'4T4D'}}</span>
     </div>
     <div v-show="isEdgeOpen(row.index)" class="rt-edge-actions">
      <select :value="row.edge.strategy??'auto'" :disabled="disabled||busy" :aria-label="'第 '+(row.index+1)+' 段策略'"
       :data-testid="'route-topology-strategy-'+row.index" @change="setStrategy(row.index,($event.target as HTMLSelectElement).value)">
       <option v-for="option in strategyOptions" :key="option.value" :value="option.value">{{option.label}}</option>
      </select>
      <Button size="sm" variant="outline" :disabled="disabled||busy" :data-testid="'route-topology-reverse-'+row.index"
       @click="reverseAt(row.index)"><ArrowLeftRight :size="13"/>反向</Button>
      <Button v-if="row.pairTotal>1&&row.edge.occurrence>1" size="sm" variant="outline" :disabled="disabled||busy"
       :data-testid="'route-topology-up-'+row.index" @click="moveAt(row.index,-1)">提前一次</Button>
      <Button v-if="row.pairTotal>1&&row.edge.occurrence<row.pairTotal" size="sm" variant="outline" :disabled="disabled||busy"
       :data-testid="'route-topology-down-'+row.index" @click="moveAt(row.index,1)">推后一次</Button>
      <Button size="sm" variant="outline" :disabled="disabled||busy" :data-testid="'route-topology-remove-'+row.index"
       @click="removeAt(row.index)"><Trash2 :size="13"/>删除</Button>
     </div>
     <div v-show="isEdgeOpen(row.index)" class="rt-waypoints" :data-testid="'route-topology-waypoints-'+row.index">
      <span class="rt-hint">中间点 {{row.edge.waypoints?.length??0}} 个</span>
      <span v-for="(waypoint,position) in row.edge.waypoints??[]" :key="position" class="rt-chip waypoint">
       ({{waypoint.x.toFixed(2)}}, {{waypoint.y.toFixed(2)}})
       <button type="button" :disabled="disabled||busy" :aria-label="'删除第 '+(position+1)+' 个中间点'"
        :data-testid="'route-topology-waypoint-remove-'+row.index+'-'+position" @click="removeWaypoint(row.index,position)">×</button>
      </span>
      <input v-model="waypointX" type="number" step="0.01" placeholder="X (m)" :disabled="disabled||busy"
       :data-testid="'route-topology-waypoint-x-'+row.index" class="rt-num"/>
      <input v-model="waypointY" type="number" step="0.01" placeholder="Y (m)" :disabled="disabled||busy"
       :data-testid="'route-topology-waypoint-y-'+row.index" class="rt-num"/>
      <Button size="sm" variant="outline" :disabled="disabled||busy" :data-testid="'route-topology-waypoint-add-'+row.index"
       @click="addWaypoint(row.index)"><Plus :size="13"/>加中间点</Button>
     </div>
    </li>
   </ol>
  </section>

  <!-- 2. 新增一段 -->
  <section class="rt-sec" data-testid="route-topology-add">
   <h4>加一段（有向）</h4>
   <div class="rt-form">
    <label>起点
     <select v-model.number="draftFrom" :disabled="disabled||busy" data-testid="route-topology-add-from">
      <option v-for="id in tagIds" :key="'f'+id" :value="id">{{labelWithId(id)}}</option>
     </select>
    </label>
    <label>终点
     <select v-model.number="draftTo" :disabled="disabled||busy" data-testid="route-topology-add-to">
      <option v-for="id in tagIds" :key="'t'+id" :value="id">{{labelWithId(id)}}</option>
     </select>
    </label>
    <label>方向
     <select v-model="draftDirection" :disabled="disabled||busy" data-testid="route-topology-add-direction"
      @change="syncModeWithDirection">
      <option v-for="option in directionOptions" :key="option.value" :value="option.value">{{option.label}}</option>
     </select>
    </label>
    <label>策略
     <select v-model="draftStrategy" :disabled="disabled||busy" data-testid="route-topology-add-strategy">
      <option v-for="option in strategyOptions" :key="option.value" :value="option.value">{{option.label}}</option>
     </select>
    </label>
    <Button size="sm" :disabled="disabled||busy" data-testid="route-topology-add-confirm" @click="addCurrent">
     <Plus :size="13"/>加一段
    </Button>
   </div>
   <p class="rt-hint">同一对码走两次要分别加两段，occurrence 会自动排到第 {{nextOccurrence(topology,draftFrom,draftTo)}} 次。</p>
  </section>

  <!-- 3. 连通性与摘要 -->
  <section class="rt-sec" data-testid="route-topology-check">
   <h4>连通性检查</h4>
   <div v-if="localErrors.length" class="rt-alert error" role="alert" data-testid="route-topology-blockers">
    <AlertTriangle :size="14"/>
    <div><b>保存前必须解决</b><p v-for="(item,index) in localErrors" :key="'e'+index">{{item.message}}</p></div>
   </div>
   <div v-else class="rt-alert ok" data-testid="route-topology-connected"><CheckCircle2 :size="14"/><span>区间首尾相接、码都存在、方向与模式一致。</span></div>
   <div v-if="localWarnings.length" class="rt-list warn" data-testid="route-topology-warnings">
    <b>提示</b><p v-for="(item,index) in localWarnings" :key="'w'+index">{{item.message}}</p>
   </div>
   <dl class="rt-rows" v-if="summary.length">
    <div v-for="(line,index) in summary" :key="'s'+index"><dt>{{index+1}}</dt><dd>{{line}}</dd></div>
   </dl>
   <p v-if="orphanTags.length" class="rt-hint" data-testid="route-topology-orphans">顶点表里有 {{orphanTags.length}} 个码没有参与任何区间：{{orphanTags.map(label).join('、')}}</p>
   <p v-if="unusedMapTags.length" class="rt-hint" data-testid="route-topology-unused">地图上另有 {{unusedMapTags.length}} 个码未参与本路径。</p>
  </section>

  <!-- 4. 保存 -->
  <div class="rt-actions">
   <label class="rt-check"><input v-model="savePoints" type="checkbox" :disabled="disabled||busy" data-testid="route-topology-save-points"/>
    同时按拓扑重写折线（走现有编译安全门）</label>
   <Button size="sm" :disabled="!canSave" data-testid="route-topology-save" @click="save">
    <Save :size="13"/>{{busy?'保存中…':'保存拓扑'}}
   </Button>
   <Button size="sm" variant="outline" :disabled="busy" data-testid="route-topology-reload" @click="reload">
    <RefreshCw :size="13"/>重新读取
   </Button>
  </div>
  <p class="rt-hint">保存拓扑只记录「码与码之间的有向经过关系」，不会解锁实车执行；能否导航仍由路径编译、定位锚定与设备就绪条件决定。</p>
 </div>
</template>

<style scoped>
.rt{display:flex;flex-direction:column;gap:8px;font-size:12px}
.rt-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-head strong{display:inline-flex;align-items:center;gap:6px;font-size:13px}
.rt-badge{border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid #d0d7de;background:#f6f8fa;color:#57606a}
.rt-badge.ok{border-color:#2da44e;background:#e8f5ec;color:#1a7f37}
.rt-badge.bad{border-color:#cf222e;background:#ffebe9;color:#a40e26}
.rt-badge.stored{border-color:#0969da;background:#ddf4ff;color:#0550ae}
.rt-hint{margin:0;color:#57606a;font-size:11px;line-height:1.5}
.rt-sec{border:1px solid #e1e4e8;border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}
.rt-sec h4{margin:0;font-size:12px;display:flex;align-items:center;gap:6px}
.rt-sec h4 small{color:#57606a;font-weight:400}
.rt-edges{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.rt-edges>li{border:1px solid #eaeef2;border-radius:6px;padding:6px;display:flex;flex-direction:column;gap:4px}
.rt-edge-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rt-chip{border-radius:999px;padding:0 6px;font-size:10px;background:#f6f8fa;border:1px solid #d0d7de;color:#57606a}
.rt-chip.mode{background:#fff8c5;border-color:#d4a72c;color:#7d4e00}
.rt-chip.waypoint{display:inline-flex;align-items:center;gap:2px}
.rt-chip.waypoint button{border:0;background:transparent;cursor:pointer;color:#a40e26;font-size:12px;line-height:1;padding:0 2px}
.rt-edge-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.rt-waypoints{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.rt-num{width:72px;padding:2px 4px;font-size:11px}
.rt-form{display:flex;align-items:flex-end;gap:6px;flex-wrap:wrap}
.rt-form label{display:flex;flex-direction:column;gap:2px;font-size:11px;color:#57606a}
.rt-alert{display:flex;gap:6px;border-radius:6px;padding:6px;font-size:11px;line-height:1.5}
.rt-alert p{margin:2px 0 0}
.rt-alert.error{border:1px solid #ffcecb;background:#ffebe9;color:#a40e26}
.rt-alert.ok{border:1px solid #aceebb;background:#e8f5ec;color:#1a7f37}
.rt-list.warn{border:1px solid #d4a72c;background:#fff8c5;border-radius:6px;padding:6px;color:#7d4e00;font-size:11px}
.rt-list.warn p{margin:2px 0 0}
.rt-rows{margin:0;display:flex;flex-direction:column;gap:2px}
.rt-rows>div{display:flex;gap:6px}
.rt-rows dt{color:#57606a;min-width:16px}
.rt-rows dd{margin:0;flex:1}
.rt-pending{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid #d4a72c;background:#fff8c5;border-radius:6px;padding:6px;font-size:11px;color:#7d4e00}
.rt-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-check{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#57606a}
</style>
