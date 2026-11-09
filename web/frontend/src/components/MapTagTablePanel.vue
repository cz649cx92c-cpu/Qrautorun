<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import type {FieldMap} from '../../../shared/model';
import {previewTagUpdates,TAG_UPDATE_DISCLAIMER,type TagUpdateEdit} from '../../../shared/map-tag-update';
import Button from './ui/Button.vue';
import {AlertTriangle,CheckCircle2,Plus,Save,Trash2,Table2,Undo2} from 'lucide-vue-next';

const props=defineProps<{map:FieldMap;version:number;disabled?:boolean;aliases?:{tagId:number;name:string}[]}>();
// 定位组几何：后端新字段可选；旧地图缺字段时按 legacy 方形（rows=cols=gridSize，
// widthMm=heightMm=sizeMm）回退，不把方板文案套到矩形板上。
type GroupGeometry={gridSize:number;sizeMm:number;rows?:number;cols?:number;widthMm?:number;heightMm?:number;members?:readonly unknown[]};
const countOf=(value:number|undefined,fallback:number)=>Number.isFinite(value)&&(value as number)>=1?Math.round(value as number):fallback;
const mmText=(value:number)=>Number.isInteger(value)?String(value):value.toFixed(1);
function groupGeometrySpec(group:GroupGeometry):string{
 const rows=countOf(group.rows,countOf(group.gridSize,1)),cols=countOf(group.cols,countOf(group.gridSize,1));
 const width=Number.isFinite(group.widthMm)?group.widthMm as number:group.sizeMm;
 const height=Number.isFinite(group.heightMm)?group.heightMm as number:group.sizeMm;
 const count=group.members?.length??rows*cols;
 const tileW=(width-(cols-1)*2)/cols,tileH=(height-(rows-1)*2)/rows,single=Math.min(tileW,tileH)/1.25;
 return `${count} 码 · 列×行 ${cols}×${rows} · 整组 ${mmText(width)}×${mmText(height)} mm · 单码 ${single.toFixed(1)} mm`;
}
const emit=defineEmits<{
 'preview-map':[map:FieldMap|null];
 editing:[active:boolean];
 applied:[result:any];
 'save-aliases':[aliases:{tagId:number;name:string}[]];
}>();

const active=ref(false),busy=ref(false),error=ref(''),message=ref('');
const draft=ref<TagUpdateEdit[]>([]);
const selectedId=ref<number|null>(null);
const base=ref<FieldMap|null>(null);
const deleting=ref(false);
// 现场名称草稿：与几何草稿完全独立——名称不进地图 body，所以它不会脏地图版本。
const aliasDraft=ref<Map<number,string>>(new Map());
const aliasByTagId=computed(()=>{
 const merged=new Map<number,string>();
 for(const alias of props.aliases??[])if(alias.name)merged.set(alias.tagId,alias.name);
 for(const [id,name] of aliasDraft.value)if(name)merged.set(id,name);
 return merged;
});
const aliasDirty=computed(()=>aliasDraft.value.size>0);
function aliasFor(id:number){return aliasByTagId.value.get(id)??'';}
function setAlias(id:number,raw:string){
 if(!active.value||busy.value||props.disabled)return;
 const next=new Map(aliasDraft.value);
 const name=raw.trim();
 if(name)next.set(id,name);else next.delete(id);
 aliasDraft.value=next;
}
function saveAliases(){
 if(!aliasDraft.value.size)return;
 const merged=new Map<number,string>();
 for(const alias of props.aliases??[])if(alias.name)merged.set(alias.tagId,alias.name);
 for(const [id,name] of aliasDraft.value){if(name)merged.set(id,name);else merged.delete(id);}
 emit('save-aliases',[...merged].map(([tagId,name])=>({tagId,name})));
 aliasDraft.value=new Map();
}

const source=computed(()=>base.value??props.map);
const groupById=computed(()=>{
 const byId=new Map<string,GroupGeometry>();
 for(const group of source.value.groups??[])byId.set(group.id,group as unknown as GroupGeometry);
 return byId;
});
const groupSpec=(groupId:string)=>groupById.value.has(groupId)?groupGeometrySpec(groupById.value.get(groupId)!):'';
const tags=computed(()=>[...source.value.tags].sort((a,b)=>a.id-b.id));
const draftById=computed(()=>new Map(draft.value.map(edit=>[edit.id,edit])));
const editFor=(id:number):TagUpdateEdit=>draftById.value.get(id)??{id};

const preview=computed(()=>active.value&&draft.value.length&&base.value?previewTagUpdates(base.value,draft.value):null);
const blocking=computed(()=>((preview.value?.reasons??[]) as any[]).map(reason=>reason.message));
const ready=computed(()=>!!preview.value?.ready);

function start(){
 if(active.value||props.disabled||busy.value)return;
 base.value=props.map;draft.value=[];selectedId.value=null;error.value='';message.value='';
 active.value=true;emit('editing',true);emit('preview-map',null);
}
function exit(){
 if(!active.value)return;
 active.value=false;base.value=null;draft.value=[];error.value='';emit('preview-map',null);emit('editing',false);
}
function touch(next:TagUpdateEdit){
 const rest=draft.value.filter(edit=>edit.id!==next.id);
 const tag=source.value.tags.find(item=>item.id===next.id);
 if(!tag){return;}
 const unchanged=(next.nextId??tag.id)===tag.id
  &&(next.x??tag.x)===tag.x&&(next.y??tag.y)===tag.y
  &&(next.angle??tag.angle)===tag.angle&&(next.size??tag.size)===tag.size;
 draft.value=unchanged?rest:[...rest,next];
 emit('preview-map',preview.value?.map??null);
}
function setField(id:number,key:'nextId'|'x'|'y'|'angle'|'size',raw:string){
 const value=raw===''?undefined:Number(raw);
 const current={...editFor(id)};
 if(value===undefined||!Number.isFinite(value)){delete current[key];}
 else (current as any)[key]=key==='nextId'?Math.round(value):value;
 touch(current);
}
function undo(){
 if(!draft.value.length)return;
 draft.value=draft.value.slice(0,-1);
 emit('preview-map',preview.value?.map??null);
}
function resetAll(){draft.value=[];emit('preview-map',null);}
async function removeTag(id:number){
 if(!active.value||busy.value||props.disabled)return;
 deleting.value=true;error.value='';message.value='';
 try{
  const response=await fetch(`/api/maps/${encodeURIComponent(props.map.id)}/tags`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseVersion:props.version,ids:[id]})});
  const result=await response.json();
  if(!response.ok)throw Object.assign(new Error(result.error??'删除失败'),{status:response.status});
  base.value=result.map??base.value;
  draft.value=draft.value.filter(edit=>edit.id!==id);
  message.value=`已删除 Q${String(id).padStart(3,'0')}`;
  emit('applied',result);
 }catch(reason){
  const status=Number((reason as {status?:number}).status);
  error.value=status===409?'地图已更新，请重新加载后再删除':reason instanceof Error?reason.message:String(reason);
 }finally{deleting.value=false;}
}
async function save(){
 if(!active.value||busy.value||props.disabled)return;
 if(!ready.value){error.value=blocking.value.join('；')||'尚无可保存的改动';return;}
 busy.value=true;error.value='';message.value='';
 try{
  const response=await fetch(`/api/maps/${encodeURIComponent(props.map.id)}/tags/update`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseVersion:props.version,edits:draft.value})});
  const result=await response.json();
  if(!response.ok)throw Object.assign(new Error(result.error??'保存失败'),{status:response.status});
  base.value=result.map!;
  draft.value=[];
  message.value=`已保存 ${result.changedIds?.length??0} 个点位改动 · 地图 v${result.version}`;
  emit('applied',result);
 }catch(reason){
  const status=Number((reason as {status?:number}).status);
  error.value=status===409?'地图已更新，本次没有保存；请重新加载后再改':reason instanceof Error?reason.message:String(reason);
 }finally{busy.value=false;}
}
// 画布上直接拖码：把位移写进同一份草稿，与表格里改 X/Y 完全等价。
function moveTags(ids:number[],dx:number,dy:number){
 if(!active.value||busy.value||props.disabled)return;
 for(const id of ids){
  const tag=source.value.tags.find(item=>item.id===id);
  if(!tag)continue;
  const current=editFor(id);
  const nextX=Math.round(((current.x??tag.x)+dx)*1e6)/1e6;
  const nextY=Math.round(((current.y??tag.y)+dy)*1e6)/1e6;
  const rest=draft.value.filter(edit=>edit.id!==id);
  const merged:TagUpdateEdit={...current,id,x:nextX,y:nextY};
  const unchanged=(merged.nextId??tag.id)===tag.id&&nextX===tag.x&&nextY===tag.y&&(merged.angle??tag.angle)===tag.angle&&(merged.size??tag.size)===tag.size;
  draft.value=unchanged?rest:[...rest,merged];
 }
 selectedId.value=ids.at(-1)??selectedId.value;
 emit('preview-map',preview.value?.map??null);
}
defineExpose({moveTags,start,isActive:()=>active.value});
watch([()=>props.map.id],()=>{if(active.value)exit();});
onBeforeUnmount(()=>{if(active.value){active.value=false;emit('preview-map',null);emit('editing',false);}});
</script>

<template>
 <div v-if="map.routeMode==='map-only'" class="tag-table" data-testid="map-tag-table" :data-map-version="version" :data-active="active?'1':'0'">
  <div class="tag-table-head">
   <strong><Table2 :size="15"/> 点位表格（改编号/坐标/删除）</strong>
   <span v-if="active" class="tag-table-count">{{tags.length}} 个码 · 改动 {{draft.length}}</span>
   <Button v-if="!active" size="sm" variant="outline" :disabled="disabled||busy" data-testid="map-tag-table-start" @click.prevent="start">打开表格</Button>
   <Button v-else size="sm" variant="ghost" :disabled="busy" data-testid="map-tag-table-exit" @click.prevent="exit">退出</Button>
  </div>
  <p v-if="!active" class="tag-table-hint">逐行改二维码编号、坐标、朝向，或直接删除贴错的码。</p>
  <p v-else class="tag-table-hint">{{TAG_UPDATE_DISCLAIMER}}改完点保存。</p>

  <div v-if="active" class="tag-table-scroll" data-testid="map-tag-table-grid">
   <table class="tag-table-grid">
    <thead><tr><th>编号</th><th>现场名称</th><th>X / m</th><th>Y / m</th><th>朝向 / °</th><th>边长 / m</th><th>组</th><th>操作</th></tr></thead>
    <tbody>
     <tr v-for="tag in tags" :key="tag.id" :class="{edited:draftById.has(tag.id),sel:selectedId===tag.id}" @click="selectedId=tag.id">
      <td><input type="number" min="0" max="586" step="1" :value="editFor(tag.id).nextId??tag.id" :disabled="busy||deleting" :data-testid="'map-tag-id-'+tag.id" :title="'当前 Q'+tag.id" @click.stop @input.stop="setField(tag.id,'nextId',($event.target as HTMLInputElement).value)"/></td>
      <td><input type="text" maxlength="24" class="tag-alias-input" :value="aliasFor(tag.id)" :disabled="busy||deleting" :data-testid="'map-tag-alias-'+tag.id" :placeholder="'Q'+String(tag.id).padStart(3,'0')" :title="'现场名称只用于显示，真实编号仍是 Q'+tag.id" @click.stop @input.stop="setAlias(tag.id,($event.target as HTMLInputElement).value)"/></td>
      <td><input type="number" step="0.001" :value="editFor(tag.id).x??tag.x" :disabled="busy||deleting" :data-testid="'map-tag-x-'+tag.id" @click.stop @input.stop="setField(tag.id,'x',($event.target as HTMLInputElement).value)"/></td>
      <td><input type="number" step="0.001" :value="editFor(tag.id).y??tag.y" :disabled="busy||deleting" :data-testid="'map-tag-y-'+tag.id" @click.stop @input.stop="setField(tag.id,'y',($event.target as HTMLInputElement).value)"/></td>
      <td><input type="number" step="0.1" :value="editFor(tag.id).angle??tag.angle" :disabled="busy||deleting" :data-testid="'map-tag-angle-'+tag.id" @click.stop @input.stop="setField(tag.id,'angle',($event.target as HTMLInputElement).value)"/></td>
      <td><input type="number" step="0.01" min="0.02" max="0.18" :value="editFor(tag.id).size??tag.size" :disabled="busy||deleting" :data-testid="'map-tag-size-'+tag.id" @click.stop @input.stop="setField(tag.id,'size',($event.target as HTMLInputElement).value)"/></td>
      <td class="tag-table-group"><span>{{tag.groupId??'—'}}</span><small v-if="tag.groupId&&groupSpec(tag.groupId)">{{groupSpec(tag.groupId)}}</small></td>
      <td><Button size="sm" variant="ghost" :disabled="busy||deleting" :data-testid="'map-tag-del-'+tag.id" :aria-label="'删除 Q'+tag.id" @click.stop="removeTag(tag.id)"><Trash2 :size="13"/></Button></td>
     </tr>
     <tr v-if="!tags.length"><td colspan="8" class="tag-table-empty">地图上还没有二维码；先在「批量新建 / 铺码」里加码。</td></tr>
    </tbody>
   </table>
  </div>

  <template v-if="active">
   <div v-if="preview&&preview.changedIds.length" class="tag-table-diff" data-testid="map-tag-table-diff">
    将修改 {{preview.changedIds.length}} 点<template v-if="preview.renumbered.length">，改号 {{preview.renumbered.length}} 个（{{preview.renumbered.map(r=>'Q'+r.from+'→Q'+r.to).join('、')}}）</template>；最大位移 {{(preview.maxDisplacementM*100).toFixed(1)}} cm
   </div>
   <div v-if="blocking.length" class="tag-table-blocked" data-testid="map-tag-table-blocked">{{blocking.join('；')}}</div>
   <div class="tag-table-actions">
    <Button size="sm" :disabled="busy||disabled||!ready" data-testid="map-tag-table-save" @click.prevent="save"><Save :size="14"/>{{busy?'正在保存…':'保存改动'}}</Button>
    <Button size="sm" variant="outline" :disabled="busy||!draft.length" data-testid="map-tag-table-undo" @click.prevent="undo"><Undo2 :size="14"/>撤销一步</Button>
    <Button size="sm" variant="ghost" :disabled="busy||!draft.length" data-testid="map-tag-table-reset" @click.prevent="resetAll">全部还原</Button>
    <Button size="sm" variant="outline" :disabled="busy||!aliasDirty" data-testid="map-tag-alias-save" title="名称只改显示，不动编号/坐标/地图版本" @click.prevent="saveAliases">保存现场名称</Button>
   </div>
  </template>

  <div v-if="error" class="tag-table-alert error" role="alert" data-testid="map-tag-table-error"><AlertTriangle :size="15"/>{{error}}</div>
  <div v-if="message" class="tag-table-alert success" role="status" data-testid="map-tag-table-message"><CheckCircle2 :size="15"/>{{message}}</div>
 </div>
</template>

<style scoped>
.tag-table{display:flex;flex-direction:column;gap:7px}
.tag-table-head{display:flex;align-items:center;gap:7px;font-size:13px;color:#1e293b}
.tag-table-head strong{display:inline-flex;align-items:center;gap:5px;font-weight:650;white-space:nowrap}
.tag-table-head .btn,.tag-table-head button{flex:0 0 auto;white-space:nowrap}
.tag-table-count{margin-left:auto;color:var(--muted);font-size:11.5px;white-space:nowrap}
.tag-table-hint{margin:0;color:var(--muted);font-size:11.5px;line-height:1.55}
.tag-table-scroll{max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:7px}
.tag-table-grid{width:100%;border-collapse:collapse;font-size:11.5px}
.tag-table-grid th{position:sticky;top:0;background:var(--panel);color:var(--muted);font-weight:600;font-size:10.5px;text-align:left;padding:5px 6px;border-bottom:1px solid #eef2f7;white-space:nowrap}
.tag-table-grid td{padding:3px 5px;border-bottom:1px solid #f5f7fa}
.tag-table-grid tr.edited{background:#eff6ff}
.tag-table-grid tr.sel{box-shadow:inset 3px 0 0 var(--accent)}
.tag-table-grid input.tag-alias-input{width:104px;text-align:left}
.tag-table-grid input{width:74px;padding:2px 5px;border:1px solid #d7dee7;border-radius:5px;font:inherit;text-align:right;font-variant-numeric:tabular-nums}
.tag-table-grid input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px rgb(37 99 235 / 12%)}
.tag-table-group{color:var(--muted);font-size:10.5px;white-space:normal;max-width:190px}
.tag-table-group span{display:block}
.tag-table-group small{display:block;color:#94a3b8;font-size:9.5px;line-height:1.35;overflow-wrap:anywhere}
.tag-table-empty{color:var(--muted);text-align:center;padding:14px 6px}
.tag-table-diff{padding:5px 8px;border-radius:6px;background:#eff6ff;color:#1d4ed8;font-size:11.5px;line-height:1.6}
.tag-table-blocked{padding:5px 8px;border-radius:6px;background:#fef2f2;color:#b91c1c;font-size:11.5px}
.tag-table-actions{display:flex;gap:6px;flex-wrap:wrap}
.tag-table-alert{display:flex;align-items:center;gap:5px;padding:5px 8px;border-radius:6px;font-size:11.5px}
.tag-table-alert.error{background:#fef2f2;color:#b91c1c}
.tag-table-alert.success{background:#ecfdf5;color:#047857}
</style>
