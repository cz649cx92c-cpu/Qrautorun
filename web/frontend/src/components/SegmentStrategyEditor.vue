<script setup lang="ts">
import {ref,watch} from 'vue';
import {degrees,strategyOptions,type SegmentPlan,type StrategyMode} from '../../../shared/segment-strategy';
const props=defineProps<{plans:SegmentPlan[],locked:boolean,selected:string}>();
const emit=defineEmits<{change:[plan:SegmentPlan,mode:StrategyMode],select:[key:string]}>();
const label=(id:number)=>'Q'+String(id).padStart(3,'0');
// The list stays collapsed: only route names are shown, and the segment you want to
// change is expanded on demand. `lastEmitted` keeps the canvas selection from
// immediately re-expanding a segment the user just collapsed.
const openKey=ref('');
let lastEmitted='';
function toggle(key:string){openKey.value=openKey.value===key?'':key;lastEmitted=key;emit('select',key);}
watch(()=>props.selected,key=>{if(key&&key!==lastEmitted)openKey.value=key;});
</script>
<template>
 <details class="segment-strategies" data-testid="segment-strategies" open>
  <summary>码间运动策略 · {{plans.length}} 段</summary>
  <p v-if="!plans.length">先绘制经过至少两个码中心的路径。</p>
  <p v-else class="segment-hint">默认只列出各段，点开要修改的那一段再改策略。</p>
  <article v-for="plan in plans" :key="plan.key" :class="{active:selected===plan.key,expanded:openKey===plan.key}" :data-segment-key="plan.key" :data-segment-open="openKey===plan.key?'1':'0'">
   <div class="segment-row" role="button" tabindex="0" :aria-expanded="openKey===plan.key" :aria-label="'展开或收起 '+label(plan.fromId)+' 到 '+label(plan.toId)+' 的运动策略'" @click="toggle(plan.key)" @keydown.enter.prevent="toggle(plan.key)" @keydown.space.prevent="toggle(plan.key)">
    <span class="segment-caret" aria-hidden="true">{{openKey===plan.key?'▾':'▸'}}</span>
    <strong>{{label(plan.fromId)}} → {{label(plan.toId)}}<small v-if="plan.occurrence"> · 第{{plan.occurrence+1}}次</small></strong>
    <span v-if="selected===plan.key" class="segment-active-badge">当前段</span>
    <span v-if="plan.blocked||plan.problem" class="segment-flag" :title="plan.problem||plan.blocked">!</span>
   </div>
   <div v-if="openKey===plan.key" class="segment-detail" @click.stop>
    <select :aria-label="'区间 '+label(plan.fromId)+' → '+label(plan.toId)+' 第'+(plan.occurrence+1)+'次运动策略'" :value="plan.mode" :disabled="locked" @change="emit('change',plan,($event.target as HTMLSelectElement).value as StrategyMode)"><option v-for="option in strategyOptions" :key="option.value" :value="option.value">{{option.label}}</option></select>
    <div class="segment-directions" data-testid="segment-directions">起始朝向 {{degrees(plan.startYaw)}}° · {{Math.abs(plan.turn)<.001?'保持朝向':(plan.turn>0?'逆时针':'顺时针')+'转 '+Math.abs(degrees(plan.turn))+'°'}}<br/>行进 {{degrees(plan.travelYaw)}}° · 到达朝向 {{degrees(plan.arrivalYaw)}}°</div>
    <p v-if="plan.problem||plan.blocked" class="segment-blocked" role="status">{{plan.problem||plan.blocked}}</p>
   </div>
  </article>
  <small>红色为当前选中段（整段变红），其余段与路径保持蓝色；白箭头为行进方向，琥珀箭头为车头朝向。平移使用现有蟹行协议，仍受实时档位、轮角和定位门禁约束。</small>
 </details>
</template>
<style scoped>
.segment-strategies{margin-top:12px;font-size:12px}
.segment-strategies summary{cursor:pointer;font-weight:600}
.segment-hint{margin:4px 0 6px;font-size:11px;line-height:1.5;color:var(--muted)}
.segment-strategies article{margin:2px 0;border:1px solid transparent;border-left:3px solid transparent;border-radius:6px}
.segment-row{display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:6px;cursor:pointer}
.segment-row:hover{background:#f8fafc}
.segment-caret{flex:0 0 12px;width:12px;color:var(--muted);font-size:10px;line-height:1}
.segment-row strong{flex:1 1 auto;min-width:0;font-size:12px}
.segment-strategies article.active{border-color:#fecaca;border-left-color:#dc2626;background:#fef2f2}
.segment-strategies article.active .segment-row:hover{background:#fee2e2}
.segment-active-badge{flex:0 0 auto;padding:1px 6px;border-radius:999px;background:#dc2626;color:#fff;font-size:10px;font-weight:600;line-height:1.6}
.segment-flag{flex:0 0 16px;width:16px;height:16px;border-radius:999px;background:#fffbeb;color:#b45309;font-size:11px;font-weight:700;line-height:16px;text-align:center}
.segment-detail{padding:0 8px 8px}
.segment-strategies select{width:100%;font-size:12px;padding:6px;min-height:32px}
.segment-directions{margin-top:5px;font-size:11px;line-height:1.6;color:var(--muted)}
.segment-strategies article.active .segment-directions{color:#b91c1c}
.segment-blocked{margin:5px 0;padding:5px;line-height:1.5;color:#b45309;background:#fffbeb}
.segment-strategies small{display:block;margin-top:6px;font-size:10px;line-height:1.5;color:var(--muted)}
</style>
