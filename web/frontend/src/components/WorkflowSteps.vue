<script setup lang="ts">
import {Check,Printer,Grid2X2,ScanLine,Route,Navigation} from 'lucide-vue-next';
withDefaults(defineProps<{current:number}>(),{current:1});
const steps=[{label:'打印二维码',detail:'准备定位板',icon:Printer},{label:'铺设',detail:'标定与现场布置',icon:Grid2X2},{label:'扫描建图',detail:'记录环境与轨迹',icon:ScanLine},{label:'编辑路径',detail:'规划作业路线',icon:Route},{label:'开始导航',detail:'检查后执行任务',icon:Navigation}];
</script>
<template>
 <nav class="workflow-steps" aria-label="作业工作流" data-testid="workflow-steps">
  <ol><li v-for="(step,i) in steps" :key="step.label" :class="{current:i+1===current,complete:i+1<current}" :aria-current="i+1===current?'step':undefined">
   <span class="step-icon"><Check v-if="i+1<current" :size="16"/><component :is="step.icon" v-else :size="16"/></span><div><strong>{{step.label}}</strong><small>{{step.detail}}</small></div><span class="step-number">0{{i+1}}</span>
  </li></ol>
 </nav>
</template>
