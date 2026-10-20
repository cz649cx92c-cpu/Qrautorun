<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import type {FieldMap} from '../../../shared/model';
import {previewOrthogonalCorrection,type OrthogonalCorrectionPreview} from '../../../shared/map-orthogonal-correction';
import Button from './ui/Button.vue';
import {Grid2X2,AlertTriangle,CheckCircle2,RotateCcw} from 'lucide-vue-next';

const props=defineProps<{map:FieldMap;version:number;disabled?:boolean}>();
const emit=defineEmits<{previewMap:[map:FieldMap|null];applied:[result:any]}>();
const preview=ref<OrthogonalCorrectionPreview|null>(null),busy=ref(false),error=ref(''),message=ref(''),baseVersion=ref<number|null>(null),open=ref(false);
const formatM=(value:number)=>`${(value*100).toFixed(1)} cm`;
function reset(){preview.value=null;baseVersion.value=null;error.value='';message.value='';emit('previewMap',null);}
function makePreview(){
 if(props.disabled||busy.value)return;
 if(props.map.routeMode!=='map-only'){error.value='仅支持未创建路径的定位码地图';return;}
 error.value='';message.value='';baseVersion.value=props.version;
 try{preview.value=previewOrthogonalCorrection(props.map);emit('previewMap',preview.value.map);}
 catch(reason){preview.value=null;emit('previewMap',null);error.value=reason instanceof Error?reason.message:String(reason);}
}
async function apply(){
 if(props.disabled||busy.value)return;
 const candidate=preview.value?.map;if(!preview.value?.ready||!candidate||baseVersion.value===null)return;
 busy.value=true;error.value='';message.value='';
 try{
  const response=await fetch('/api/maps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({map:candidate,baseVersion:baseVersion.value})});
  const result=await response.json();
  if(!response.ok)throw Object.assign(new Error(result.error??'保存正交校正版本失败'),{status:response.status});
  emit('applied',result);preview.value=null;baseVersion.value=null;emit('previewMap',null);message.value=`正交校正已保存为地图版本 v${result.version}`;
 }catch(reason){
  error.value=reason instanceof Error&&'status' in reason&&Number((reason as {status?:number}).status)===409?'地图版本已变化，草稿仍保留；请重新加载后再应用':reason instanceof Error?reason.message:String(reason);
 }finally{busy.value=false;}
}
// Reset the draft whenever the underlying map identity or version changes, so a
// stale preview can never be applied against an older baseVersion.
watch([()=>props.map.id,()=>props.version],reset);
</script>

<template>
 <details v-if="map.routeMode==='map-only'" class="orthogonal-correction" data-testid="orthogonal-correction" :open="open" @toggle="open=($event.target as HTMLDetailsElement).open">
  <summary><Grid2X2 :size="17"/>二维码点位正交校正</summary>
  <div class="orthogonal-body">
   <p class="orthogonal-note">只校正有可靠同排/同列证据的二维码中心，保留真实不等间距。它不能替代现场坐标修复，也不会自动改变采集记录或旧路线。</p>
   <div class="orthogonal-actions"><Button size="sm" variant="outline" :disabled="disabled||busy" data-testid="orthogonal-preview" @click.prevent="makePreview"><RotateCcw :size="15"/>预览校正</Button><Button v-if="preview" size="sm" variant="ghost" :disabled="busy" @click.prevent="reset">撤销预览</Button></div>
   <div v-if="error" class="orthogonal-alert error" role="alert"><AlertTriangle :size="16"/>{{error}}</div>
   <div v-if="message" class="orthogonal-alert success" role="status"><CheckCircle2 :size="16"/>{{message}}</div>
   <div v-if="preview" class="orthogonal-result" data-testid="orthogonal-result">
    <div :class="['orthogonal-status',preview.ready?'ready':'blocked']"><CheckCircle2 v-if="preview.ready" :size="16"/><AlertTriangle v-else :size="16"/><strong>{{preview.ready?'可以应用校正草稿':'暂不能应用校正'}}</strong><span>{{preview.reason}}</span></div>
    <dl class="orthogonal-metrics"><div><dt>基准版本</dt><dd>v{{baseVersion}}</dd></div><div><dt>几何置信度</dt><dd>{{(preview.confidence*100).toFixed(0)}}%</dd></div><div><dt>最大位移</dt><dd>{{formatM(preview.maxDisplacementM)}}</dd></div><div><dt>最大改距</dt><dd>{{formatM(preview.maxDistanceChangeM)}}</dd></div><div><dt>正交线簇</dt><dd>{{preview.lines.length}} 条</dd></div><div><dt>离群点</dt><dd>{{preview.outlierIds.length?preview.outlierIds.map(id=>'Q'+String(id).padStart(3,'0')).join('、'):'无'}}</dd></div></dl>
    <div v-if="preview.ambiguities.length" class="orthogonal-list"><b>歧义</b><p v-for="item in preview.ambiguities" :key="item.code+item.tagIds.join('-')">{{item.message}}（{{item.tagIds.map(id=>'Q'+String(id).padStart(3,'0')).join('、')}}）</p></div>
    <div v-if="preview.reasons.length" class="orthogonal-list"><b>阻止原因</b><p v-for="item in preview.reasons" :key="item.code+item.tagIds.join('-')">{{item.message}}</p></div>
    <details class="orthogonal-points"><summary>逐点位移（{{preview.points.length}} 个）</summary><div class="orthogonal-table"><div class="orthogonal-row head"><span>码</span><span>原坐标 → 改后坐标</span><span>位移</span></div><div v-for="point in preview.points" :key="point.id" class="orthogonal-row"><span>Q{{String(point.id).padStart(3,'0')}}<i v-if="point.outlier">离群</i></span><span>({{point.before.x.toFixed(3)}}, {{point.before.y.toFixed(3)}}) → ({{point.after.x.toFixed(3)}}, {{point.after.y.toFixed(3)}})</span><span>{{formatM(point.displacementM)}}</span></div></div></details>
    <details v-if="preview.distanceChanges.length" class="orthogonal-points"><summary>中心欧氏距离改动（{{preview.distanceChanges.length}} 对）</summary><div class="orthogonal-table"><div v-for="change in preview.distanceChanges" :key="change.fromId+'-'+change.toId" class="orthogonal-row"><span>Q{{String(change.fromId).padStart(3,'0')}}→Q{{String(change.toId).padStart(3,'0')}}</span><span>{{formatM(change.beforeM)}}→{{formatM(change.afterM)}}</span><span>{{change.changeM>=0?'+':''}}{{formatM(change.changeM)}}</span></div></div></details>
    <Button class="orthogonal-apply" :disabled="disabled||busy||!preview.ready" data-testid="orthogonal-apply" @click="apply">{{busy?'正在保存…':'应用并保存新地图版本'}}</Button>
    <small class="orthogonal-version-note">应用时按 v{{baseVersion}} 做版本保护；若返回 409，当前草稿会保留。</small>
   </div>
  </div>
 </details>
</template>

<style scoped>
.orthogonal-correction{margin-top:14px;border-top:1px solid var(--line);padding-top:12px;color:var(--ink)}.orthogonal-correction summary{display:flex;align-items:center;gap:7px;cursor:pointer;font-size:12px;color:#334155}.orthogonal-body{padding-top:10px}.orthogonal-note{margin:0 0 10px;color:var(--muted);font-size:11px;line-height:1.55}.orthogonal-actions{display:flex;gap:6px;flex-wrap:wrap}.orthogonal-alert,.orthogonal-status{display:flex;align-items:flex-start;gap:6px;margin-top:9px;padding:7px 8px;border-radius:6px;font-size:11px;line-height:1.45}.orthogonal-alert.error,.orthogonal-status.blocked{color:#b91c1c;background:#fef2f2;border:1px solid #fee2e2}.orthogonal-alert.success,.orthogonal-status.ready{color:#166534;background:#f0fdf4;border:1px solid #dcfce7}.orthogonal-status{flex-wrap:wrap}.orthogonal-status span{flex-basis:100%;padding-left:22px}.orthogonal-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:10px 0;font-size:11px}.orthogonal-metrics div{padding:6px;background:#f8fafc;border-radius:5px}.orthogonal-metrics dt{color:var(--muted)}.orthogonal-metrics dd{margin:2px 0 0;font-family:var(--mono);font-weight:600}.orthogonal-list{margin:8px 0;color:#92400e;font-size:11px}.orthogonal-list b{display:block}.orthogonal-list p{margin:3px 0}.orthogonal-points{margin-top:8px;border-top:1px solid var(--line);padding-top:6px;font-size:11px}.orthogonal-points summary{font-size:11px}.orthogonal-table{margin-top:6px;max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:5px}.orthogonal-row{display:grid;grid-template-columns:1.2fr .9fr 1.5fr;gap:5px;padding:4px 6px;border-top:1px solid #eef2f7;font-family:var(--mono);font-size:10px}.orthogonal-row:first-child{border-top:0}.orthogonal-row.head{font-family:inherit;color:var(--muted);background:#f8fafc}.orthogonal-row i{display:block;color:#b45309;font-style:normal}.orthogonal-apply{width:100%;margin-top:10px}.orthogonal-version-note{display:block;margin-top:6px;color:var(--muted);font-size:10px;line-height:1.4}
</style>
