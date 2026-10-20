<script setup lang="ts">
import {AlertTriangle} from 'lucide-vue-next';
import Button from './ui/Button.vue';
type DeletionInfo={mapId:string,name:string,latestVersion:number,versions:number,routes:{routeId:string,name:string}[],tasks:{id:string,name:string}[],blocked:boolean,blockedReason:string|null};
defineProps<{info:DeletionInfo|null,busy:boolean}>();
const emit=defineEmits<{confirm:[],cancel:[]}>();
</script>
<template>
 <div v-if="info" class="map-delete-confirm" data-testid="map-delete-confirm" role="alertdialog" aria-label="确认删除地图">
  <div class="map-delete-heading"><AlertTriangle :size="18"/><strong>确认删除地图「{{info.name}}」？</strong></div>
  <p class="map-delete-summary">此操作不可撤销，将同时删除：</p>
  <ul class="map-delete-list">
   <li data-testid="map-delete-versions">地图 {{info.versions}} 个版本（当前 v{{info.latestVersion}}）</li>
   <li data-testid="map-delete-routes">{{info.routes.length}} 条路径<span v-if="info.routes.length">：{{info.routes.map(route=>route.name).join('、')}}</span></li>
   <li data-testid="map-delete-tasks">{{info.tasks.length}} 个导航任务绑定<span v-if="info.tasks.length">：{{info.tasks.map(task=>task.name).join('、')}}</span></li>
  </ul>
  <p v-if="info.blocked" class="map-delete-blocked" role="status">{{info.blockedReason}}</p>
  <div class="map-delete-actions"><Button variant="outline" size="sm" :disabled="busy" data-testid="map-delete-cancel" @click="emit('cancel')">取消</Button><Button variant="destructive" size="sm" :disabled="busy||info.blocked" data-testid="map-delete-confirm-button" @click="emit('confirm')">确认删除</Button></div>
 </div>
</template>
<style scoped>
.map-delete-confirm{margin-top:12px;border:1px solid var(--accent);border-radius:8px;padding:14px;background:white;color:var(--ink);font-size:14px}
.map-delete-heading{display:flex;align-items:center;gap:8px;color:var(--accent)}.map-delete-heading strong{font-weight:600;font-size:14px;overflow-wrap:anywhere}
.map-delete-summary{margin:10px 0 6px;color:var(--muted)}
.map-delete-list{margin:0;padding-left:20px;color:var(--ink);display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere}
.map-delete-blocked{margin:10px 0 0;color:var(--accent)}
.map-delete-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
</style>
