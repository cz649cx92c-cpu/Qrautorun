<script setup lang="ts">
import {degrees,strategyOptions,type SegmentPlan,type StrategyMode} from '../../../shared/segment-strategy';
defineProps<{plans:SegmentPlan[],locked:boolean,selected:string}>();
const emit=defineEmits<{change:[plan:SegmentPlan,mode:StrategyMode],select:[key:string]}>();
const label=(id:number)=>'Q'+String(id).padStart(3,'0');
</script>
<template>
 <details class="segment-strategies" data-testid="segment-strategies" open>
  <summary>码间运动策略 · {{plans.length}} 段</summary>
  <p v-if="!plans.length">先绘制经过至少两个码中心的路径。</p>
  <article v-for="plan in plans" :key="plan.key" :class="{active:selected===plan.key}" @click="emit('select',plan.key)" :data-segment-key="plan.key">
   <strong>{{label(plan.fromId)}} → {{label(plan.toId)}}<small v-if="plan.occurrence"> · 第{{plan.occurrence+1}}次</small></strong>
   <select :aria-label="'区间 '+label(plan.fromId)+' → '+label(plan.toId)+' 第'+(plan.occurrence+1)+'次运动策略'" :value="plan.mode" :disabled="locked" @change="emit('change',plan,($event.target as HTMLSelectElement).value as StrategyMode)"><option v-for="option in strategyOptions" :key="option.value" :value="option.value">{{option.label}}</option></select>
   <div class="segment-directions" data-testid="segment-directions">起始朝向 {{degrees(plan.startYaw)}}° · {{Math.abs(plan.turn)<.001?'保持朝向':(plan.turn>0?'逆时针':'顺时针')+'转 '+Math.abs(degrees(plan.turn))+'°'}}<br/>行进 {{degrees(plan.travelYaw)}}° · 到达朝向 {{degrees(plan.arrivalYaw)}}°</div>
   <p v-if="plan.problem||plan.blocked" class="segment-blocked" role="status">{{plan.problem||plan.blocked}}</p>
  </article>
  <small>蓝箭头为行进方向，琥珀箭头为车头朝向。平移使用现有蟹行协议，仍受实时档位、轮角和定位门禁约束。</small>
 </details>
</template>
<style scoped>
.segment-strategies{margin-top:12px;font-size:12px}.segment-strategies summary{cursor:pointer;font-weight:600}.segment-strategies article{padding:9px 0;border-bottom:1px solid var(--line);border-left:2px solid transparent}.segment-strategies article.active{border-left-color:#2563eb;padding-left:6px}.segment-strategies strong{font-size:12px}.segment-strategies select{width:100%;margin-top:6px;font-size:12px;padding:6px;min-height:32px}.segment-directions{line-height:1.6;font-size:11px;margin-top:5px;color:var(--muted)}.segment-blocked{color:#b45309;background:#fffbeb;padding:5px;line-height:1.5;margin:5px 0}.segment-strategies small{font-size:10px;line-height:1.5;color:var(--muted)}
</style>
