<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import type {FieldMap} from '../../../shared/model';
import {previewTagPositions,TAG_POSITION_DISCLAIMER,tagPositionLabel,type TagPositionEdit} from '../../../shared/map-tag-position';
import Button from './ui/Button.vue';
import {AlertTriangle,CheckCircle2,Crosshair,RotateCcw,Save,Undo2} from 'lucide-vue-next';

const props=defineProps<{map:FieldMap;version:number;selectedTagId:number|null;disabled?:boolean}>();
const emit=defineEmits<{
 'preview-map':[map:FieldMap|null];
 editing:[active:boolean];
 'update:selectedTagId':[id:number|null];
 applied:[result:any];
}>();
const active=ref(false),busy=ref(false),error=ref(''),message=ref('');
const base=ref<FieldMap|null>(null),edits=ref<Record<number,TagPositionEdit>>({}),history=ref<Record<number,TagPositionEdit>[]>([]);
const orderedTags=computed(()=>[...(base.value??props.map).tags].sort((a,b)=>a.id-b.id));
const selected=computed(()=>props.selectedTagId===null?null:(base.value??props.map).tags.find(tag=>tag.id===props.selectedTagId)??null);
const editList=computed(()=>Object.values(edits.value).sort((a,b)=>a.id-b.id));
const preview=computed(()=>(active.value&&editList.value.length&&base.value?previewTagPositions(base.value,editList.value):null));
const current=computed<TagPositionEdit|null>(()=>{
 const tag=selected.value;
 if(!tag)return null;
 return edits.value[tag.id]??{id:tag.id,x:tag.x,y:tag.y,angle:tag.angle};
});
const formatM=(value:number)=>`${value.toFixed(3)} m`;
const formatCm=(value:number)=>`${(value*100).toFixed(1)} cm`;
const same=(a:TagPositionEdit,b:TagPositionEdit)=>Math.abs(a.x-b.x)<1e-12&&Math.abs(a.y-b.y)<1e-12&&Math.abs((a.angle??0)-(b.angle??0))<1e-9;
const cloneEdits=(source:Record<number,TagPositionEdit>)=>Object.fromEntries(Object.entries(source).map(([id,edit])=>[id,{...edit}])) as Record<number,TagPositionEdit>;
function commit(next:Record<number,TagPositionEdit>){
 history.value=[...history.value.slice(-49),cloneEdits(edits.value)];
 edits.value=cloneEdits(next);
 emit('preview-map',previewCandidate());
}
function previewCandidate(){if(!active.value)return null;const candidate=editList.value.length&&base.value?previewTagPositions(base.value,Object.values(edits.value).sort((a,b)=>a.id-b.id)):null;return candidate?.map??base.value??null;}
function currentFor(tag:{id:number,x:number,y:number,angle:number}):TagPositionEdit{return edits.value[tag.id]??{id:tag.id,x:tag.x,y:tag.y,angle:tag.angle};}
function applyField(axis:'x'|'y'|'angle',raw:string){
 if(!active.value||!selected.value||props.disabled)return;
 const value=Number(raw);
 if(!Number.isFinite(value)){error.value='请输入有限数值';return;}
 const tag=selected.value,cur=currentFor(tag),next={...cur,[axis]:value};
 if(same(cur,next))return;
 error.value='';commit({...edits.value,[tag.id]:next});
}
function selectTag(id:number|null){emit('update:selectedTagId',id);}
function resetAll(){if(!active.value)return;history.value=[];edits.value={};error.value='';message.value='';emit('preview-map',previewCandidate());}
function undo(){
 if(!active.value)return;
 const previous=history.value.at(-1);
 if(!previous)return;
 history.value=history.value.slice(0,-1);edits.value=cloneEdits(previous);error.value='';emit('preview-map',previewCandidate());
}
function restoreInitial(){if(!active.value||!editList.value.length)return;resetAll();}
function activate(){
 if(active.value||props.disabled||busy.value)return;
 base.value=props.map;edits.value={};history.value=[];error.value='';message.value='';active.value=true;
 // Rendering the immutable base version as the draft view keeps every downstream
 // navigation/path gate blocked while the position stage is open, even before the
 // first coordinate change.
 emit('editing',true);emit('preview-map',props.map);
 if(props.selectedTagId===null||!props.map.tags.some(tag=>tag.id===props.selectedTagId))emit('update:selectedTagId',orderedTags.value[0]?.id??null);
}
function deactivate(){
 if(!active.value)return;
 active.value=false;base.value=null;edits.value={};history.value=[];error.value='';emit('preview-map',null);emit('editing',false);
}
async function save(){
 if(!active.value||props.disabled||busy.value)return;
 const candidate=preview.value;
 if(!candidate?.ready||!candidate.map){error.value=candidate?.reasons.map(reason=>reason.message).join('；')||'尚无可保存的位置调整';return;}
 busy.value=true;error.value='';message.value='';
 try{
  const response=await fetch(`/api/maps/${encodeURIComponent(props.map.id)}/tag-positions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseVersion:props.version,tags:Object.values(edits.value)})});
  const result=await response.json();
  if(!response.ok)throw Object.assign(new Error(result.error??'保存新地图版本失败'),{status:response.status});
  const success=`已保存为地图版本 v${result.version}`;
  deactivate();message.value=success;emit('applied',result);
 }catch(reason){
  error.value=reason instanceof Error&&'status' in reason&&Number((reason as {status?:number}).status)===409?'地图版本已变化，未保存任何改动；请重新加载最新版本后再调整':reason instanceof Error?reason.message:String(reason);
 }finally{busy.value=false;}
}
// Editing state can never survive switching the loaded map/version: a stale draft
// must not be applied to another base version.
watch([()=>props.map.id,()=>props.version],()=>{if(active.value)deactivate();});
watch(()=>props.disabled,disabled=>{if(disabled&&active.value)deactivate();});
onBeforeUnmount(()=>{if(active.value){active.value=false;emit('preview-map',null);emit('editing',false);}});
function moveTags(ids:number[],dx:number,dy:number){
 if(!active.value||props.disabled||busy.value||!base.value)return;
 const id=props.selectedTagId!==null&&ids.includes(props.selectedTagId)?props.selectedTagId:ids[0];
 if(id===undefined)return;
 const tag=base.value.tags.find(item=>item.id===id);if(!tag)return;
 const cur=currentFor(tag);
 commit({...edits.value,[id]:{...cur,x:Math.round((cur.x+dx)*1e6)/1e6,y:Math.round((cur.y+dy)*1e6)/1e6}});
}
defineExpose({selectTag,moveTags,reset:deactivate});
</script>

<template>
 <div v-if="map.routeMode==='map-only'" class="tag-position" data-testid="tag-position-panel" :data-map-version="version">
  <div class="tag-position-head"><strong><Crosshair :size="15"/> 调整二维码位置</strong><span class="tag-position-version">基准版本 v{{version}}</span></div>
  <p class="tag-position-disclaimer" data-testid="tag-position-disclaimer">{{TAG_POSITION_DISCLAIMER}}保存后旧版本、旧路线和旧任务保持不变，不会自动迁移。</p>
  <div class="tag-position-actions">
   <Button v-if="!active" size="sm" variant="outline" :disabled="disabled||busy" data-testid="tag-position-toggle" @click.prevent="activate">开始调整点位</Button>
   <template v-else>
    <Button size="sm" variant="ghost" :disabled="busy" data-testid="tag-position-exit" @click.prevent="deactivate">退出调整</Button>
    <Button size="sm" variant="outline" :disabled="busy||!history.length" data-testid="tag-position-undo" @click.prevent="undo"><Undo2 :size="14"/>撤销</Button>
    <Button size="sm" variant="outline" :disabled="busy||!editList.length" data-testid="tag-position-reset" @click.prevent="restoreInitial"><RotateCcw :size="14"/>恢复初始位置</Button>
    <Button size="sm" :disabled="busy||disabled||!preview?.ready" data-testid="tag-position-save" @click.prevent="save"><Save :size="14"/>{{busy?'正在保存…':'保存为新地图版本'}}</Button>
   </template>
  </div>
  <template v-if="active">
   <label class="tag-position-select">定位码<select :value="selectedTagId??''" :disabled="busy" data-testid="tag-position-select" @change="selectTag(($event.target as HTMLSelectElement).value===''?null:Number(($event.target as HTMLSelectElement).value))"><option value="">请选择二维码</option><option v-for="tag in orderedTags" :key="tag.id" :value="tag.id">{{tagPositionLabel(tag)}}{{tag.groupId?' · 整组中心':' · 独立码'}}</option></select></label>
   <div v-if="selected&&current" class="tag-position-fields" data-testid="tag-position-fields">
    <label>中心 X / m<input type="number" step="0.001" :value="current.x" :disabled="busy" data-testid="tag-position-x" @change="applyField('x',($event.target as HTMLInputElement).value)"/></label>
    <label>中心 Y / m<input type="number" step="0.001" :value="current.y" :disabled="busy" data-testid="tag-position-y" @change="applyField('y',($event.target as HTMLInputElement).value)"/></label>
    <label>朝向 / °<input type="number" step="0.1" :value="current.angle" :disabled="busy" data-testid="tag-position-angle" @change="applyField('angle',($event.target as HTMLInputElement).value)"/></label>
   </div>
   <p class="tag-position-hint">画布上直接拖动选中的二维码即可；整组定位板只移动组中心，成员按原布局刚性跟随（朝向输入会刚性旋转整组）。</p>
   <div v-if="error" class="tag-position-alert error" role="alert" data-testid="tag-position-error"><AlertTriangle :size="15"/>{{error}}</div>
   <div v-if="message" class="tag-position-alert success" role="status"><CheckCircle2 :size="15"/>{{message}}</div>
   <div v-if="preview" class="tag-position-preview" data-testid="tag-position-preview">
    <dl class="tag-position-metrics"><div><dt>调整点位</dt><dd>{{preview.changedIds.length}} / {{preview.points.length}}</dd></div><div><dt>最大中心位移</dt><dd data-testid="tag-position-max-displacement">{{formatCm(preview.maxDisplacementM)}}</dd></div><div><dt>最大朝向变化</dt><dd>{{preview.maxAngleChangeDeg.toFixed(2)}}°</dd></div><div><dt>保存版本</dt><dd>v{{version}} → v{{version+1}}</dd></div></dl>
    <div :class="['tag-position-status',preview.ready?'ready':'blocked']" data-testid="tag-position-status"><CheckCircle2 v-if="preview.ready" :size="15"/><AlertTriangle v-else :size="15"/><strong>{{preview.ready?'可以保存为新地图版本':'暂不能保存'}}</strong><span>{{preview.ready?'调整前坐标（v'+version+'）保留在版本历史；原始扫描版本请在版本历史中查看；保存生成 v'+(version+1):preview.reasons.map(reason=>reason.message).join('；')}}</span></div>
    <div v-if="preview.reasons.length" class="tag-position-list"><b>阻止原因</b><p v-for="reason in preview.reasons" :key="reason.code+reason.tagIds.join('-')">{{reason.message}}</p></div>
    <details class="tag-position-points" open><summary>逐点位移（{{preview.points.length}} 个，基线为当前载入版本 v{{version}}）</summary><div class="tag-position-table"><div class="tag-position-row head"><span>码</span><span>调整前 v{{version}} → 调整后</span><span>位移</span><span>朝向</span></div><div v-for="item in preview.points" :key="item.id" class="tag-position-row" data-testid="tag-position-point"><span>{{item.label}}<i v-if="item.rigidMemberCount">整组{{item.rigidMemberCount}}码</i></span><span>({{item.before.x.toFixed(3)}}, {{item.before.y.toFixed(3)}}) → ({{item.after.x.toFixed(3)}}, {{item.after.y.toFixed(3)}})</span><span>{{formatCm(item.displacementM)}}</span><span>{{item.angleChangeDeg.toFixed(2)}}°</span></div></div></details>
    <div v-if="preview.notes.length" class="tag-position-notes"><b>说明</b><p v-for="note in preview.notes" :key="note.code+note.tagIds.join('-')">{{note.message}}</p></div>
    <small class="tag-position-version-note">保存使用 v{{version}} 做版本保护；若返回 409，当前草稿会保留且不会产生新版本。</small>
   </div>
   <div v-else-if="!editList.length" class="tag-position-empty" role="status">选择二维码后拖动或输入新坐标，这里会显示逐点位移预览。</div>
  </template>
 </div>
</template>

<style scoped>
.tag-position{margin-top:14px;border-top:1px solid var(--line);padding-top:12px;color:var(--ink)}.tag-position-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}.tag-position-head strong{display:flex;align-items:center;gap:6px}.tag-position-version{color:var(--muted);font-family:var(--mono);font-size:11px}.tag-position-disclaimer{margin:7px 0;color:#92400e;background:#fffbeb;border:1px solid #fef3c7;border-radius:6px;padding:6px 8px;font-size:11px;line-height:1.5}.tag-position-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.tag-position-select{display:grid;gap:4px;margin-top:9px;font-size:11px;color:var(--muted)}.tag-position-select select{width:100%;padding:5px 6px;border:1px solid var(--line);border-radius:5px;background:#fff;color:var(--ink);font-size:12px}.tag-position-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:8px}.tag-position-fields label{display:grid;gap:3px;font-size:10px;color:var(--muted)}.tag-position-fields input{width:100%;padding:5px;border:1px solid var(--line);border-radius:5px;font-family:var(--mono);font-size:11px;color:var(--ink)}.tag-position-hint{margin:7px 0 0;color:var(--muted);font-size:10px;line-height:1.5}.tag-position-alert,.tag-position-status{display:flex;align-items:flex-start;gap:6px;margin-top:8px;padding:6px 8px;border-radius:6px;font-size:11px;line-height:1.45}.tag-position-alert.error,.tag-position-status.blocked{color:#b91c1c;background:#fef2f2;border:1px solid #fee2e2}.tag-position-alert.success,.tag-position-status.ready{color:#166534;background:#f0fdf4;border:1px solid #dcfce7}.tag-position-status{flex-wrap:wrap}.tag-position-status span{flex-basis:100%;padding-left:21px}.tag-position-preview{margin-top:9px}.tag-position-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin:8px 0;font-size:11px}.tag-position-metrics div{padding:5px 6px;background:#f8fafc;border-radius:5px}.tag-position-metrics dt{color:var(--muted)}.tag-position-metrics dd{margin:1px 0 0;font-family:var(--mono);font-weight:600}.tag-position-list,.tag-position-notes{margin:7px 0;font-size:11px;line-height:1.5}.tag-position-list{color:#92400e}.tag-position-notes{color:#475569}.tag-position-list b,.tag-position-notes b{display:block}.tag-position-list p,.tag-position-notes p{margin:2px 0}.tag-position-points{margin-top:7px;border-top:1px solid var(--line);padding-top:5px;font-size:11px}.tag-position-points summary{cursor:pointer;font-size:11px}.tag-position-table{margin-top:5px;max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:5px}.tag-position-row{display:grid;grid-template-columns:1.1fr 1.9fr .7fr .7fr;gap:4px;padding:3px 5px;border-top:1px solid #eef2f7;font-family:var(--mono);font-size:9.5px}.tag-position-row:first-child{border-top:0}.tag-position-row.head{font-family:inherit;color:var(--muted);background:#f8fafc}.tag-position-row i{display:block;color:#b45309;font-style:normal;font-size:9px}.tag-position-empty{margin-top:8px;color:var(--muted);font-size:11px}.tag-position-version-note{display:block;margin-top:7px;color:var(--muted);font-size:10px;line-height:1.5}
</style>
