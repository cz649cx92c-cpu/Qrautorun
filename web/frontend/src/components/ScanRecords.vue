<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {DialogClose,DialogContent,DialogOverlay,DialogPortal,DialogRoot,DialogTitle,DialogTrigger} from 'reka-ui';
import {Check,ChevronRight,Clock3,FolderOpen,Search,Trash2,X,LockKeyhole} from 'lucide-vue-next';
import Button from './ui/Button.vue';
import type {SurveySummary} from '../../../shared/survey';
const props=defineProps<{records:SurveySummary[],selectedId?:string,busy:boolean,selectionDisabled:boolean,error:string}>();
const emit=defineEmits<{select:[id:string],delete:[id:string],refresh:[]}>();
const open=ref(false),query=ref(''),pendingDelete=ref('');
const selected=computed(()=>props.records.find(r=>r.id===props.selectedId));
const filtered=computed(()=>{const q=query.value.trim().toLocaleLowerCase();return props.records.filter(r=>`${r.name} ${r.id} ${date(r.created)}`.toLocaleLowerCase().includes(q));});
function date(value:string){return new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value));}
function choose(id:string){emit('select',id);open.value=false;}
function remove(id:string){pendingDelete.value='';emit('delete',id);}
watch(open,value=>{query.value='';pendingDelete.value='';if(value)emit('refresh');});
</script>
<template>
 <div class="records-field">
  <span class="records-label">已保存扫描</span>
  <DialogRoot v-model:open="open">
   <DialogTrigger as-child>
    <button class="records-trigger" :disabled="busy" aria-label="管理扫描记录">
     <FolderOpen :size="22"/><span><strong>{{selected?.name??'选择扫描记录'}}</strong><small>{{records.length}} 条记录</small></span><ChevronRight :size="20"/>
    </button>
   </DialogTrigger>
   <DialogPortal>
    <DialogOverlay class="records-overlay"/>
    <DialogContent class="records-dialog" :aria-describedby="undefined" @escape-key-down="busy&&$event.preventDefault()" @interact-outside="busy&&$event.preventDefault()">
     <header class="records-heading"><div><DialogTitle class="records-title">扫描记录</DialogTitle><span class="records-total">{{records.length}} 条</span></div><DialogClose as-child><Button variant="ghost" size="icon" aria-label="关闭扫描记录" :disabled="busy"><X :size="23"/></Button></DialogClose></header>
     <div class="records-search"><Search :size="21"/><input v-model="query" aria-label="搜索扫描记录" placeholder="搜索名称、编号或时间"/><button v-if="query" aria-label="清空搜索" @click="query=''"><X :size="18"/></button></div>
     <div v-if="error" class="records-error" role="alert">{{error}}</div>
     <div class="records-list">
      <article v-for="r in filtered" :key="r.id" :class="['record-card',{selected:r.id===selectedId}]" :data-record-id="r.id">
       <div class="record-top"><strong>{{r.name}}</strong><span :class="['record-state',{'is-active':r.state==='collecting'}]">{{r.state==='collecting'?'采集中':r.mapId?'已建图':'已保存'}}</span></div>
       <div class="record-time"><Clock3 :size="16"/><time :datetime="r.created">{{date(r.created)}}</time><span>#{{r.id.slice(-8)}}</span></div>
       <div class="record-bottom"><div class="record-counts"><span>{{r.groupCount}} 定位组</span><span>{{r.sampleCount}} 帧</span></div><div class="record-actions">
        <Button variant="outline" size="sm" :disabled="busy||selectionDisabled" :aria-label="'打开扫描 '+r.name" @click="choose(r.id)"><Check v-if="r.id===selectedId" :size="17"/>{{r.id===selectedId?'当前记录':'打开'}}</Button>
        <Button variant="ghost" size="icon" class="record-delete" :disabled="busy||!r.deletable" :aria-label="'删除扫描 '+r.name" :title="r.protectedReason??'删除记录'" @click="pendingDelete=r.id"><LockKeyhole v-if="!r.deletable" :size="20"/><Trash2 v-else :size="20"/></Button>
       </div></div>
       <div v-if="pendingDelete===r.id" class="record-confirm"><span>删除这条扫描及观测数据？</span><div><Button variant="outline" size="sm" :disabled="busy" @click="pendingDelete=''">取消</Button><Button variant="destructive" size="sm" :disabled="busy" @click="remove(r.id)">确认删除</Button></div></div>
      </article>
      <div v-if="!filtered.length" class="records-empty"><FolderOpen :size="36"/><span>{{query?'没有匹配的记录':'暂无扫描记录'}}</span></div>
     </div>
    </DialogContent>
   </DialogPortal>
  </DialogRoot>
 </div>
</template>
<style scoped>
.records-field{margin-top:20px}.records-label{display:block;color:var(--muted);font-size:14px;margin-bottom:9px}
.records-trigger{display:flex;align-items:center;gap:12px;width:100%;padding:14px;border:1px solid var(--line);border-radius:8px;background:white;color:var(--ink);text-align:left;min-height:76px}.records-trigger:hover{border-color:var(--muted);background:var(--background)}.records-trigger:focus-visible{outline:2px solid var(--muted);outline-offset:3px}.records-trigger>svg{flex-shrink:0}.records-trigger>span{flex:1;min-width:0}.records-trigger strong{display:block;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.records-trigger small{display:block;font-size:14px;color:var(--muted);margin-top:5px}
.records-overlay{position:fixed;inset:0;z-index:50;background:rgba(25,30,36,.4);backdrop-filter:none}
.records-dialog{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:51;width:min(700px,calc(100vw - 32px));max-height:calc(100dvh - 48px);display:flex;flex-direction:column;background:var(--background);border:1px solid var(--panel);border-radius:8px;box-shadow:none;padding:14px;outline:none}
.records-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}.records-heading>div{display:flex;align-items:center;gap:12px;min-width:0}.records-title{font-size:18px;font-weight:600;margin:0;color:var(--ink)}.records-total{background:var(--panel);color:var(--muted);border-radius:8px;padding:4px 9px;font-size:14px;white-space:nowrap}
.records-search{display:flex;align-items:center;gap:10px;background:var(--background);border:1px solid var(--line);border-radius:8px;padding:0 13px;margin-bottom:12px;color:var(--muted);flex-shrink:0}.records-search:focus-within{border-color:var(--muted);box-shadow:none}.records-search input{border:0;background:none;padding:12px 0;box-shadow:none;font-size:14px;min-width:0}.records-search button{display:grid;place-items:center;border:0;background:none;color:var(--muted);padding:5px}.records-search>svg{flex-shrink:0}
.records-list{overflow-y:auto;min-height:0;padding:2px;display:flex;flex-direction:column;gap:12px}.record-card{border:1px solid var(--panel);border-radius:8px;padding:18px;background:white}.record-card.selected{border-color:var(--muted);background:var(--background)}.record-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.record-top>strong{font-size:14px;font-weight:550;color:var(--ink);overflow-wrap:anywhere;min-width:0}.record-state{font-size:14px;border-radius:8px;padding:3px 8px;background:var(--panel);color:var(--muted);white-space:nowrap}.record-state.is-active{background:var(--panel);color:var(--accent)}.record-time{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:14px;margin-top:11px;flex-wrap:wrap}.record-time>span{margin-left:auto;font-variant-numeric:tabular-nums}.record-bottom{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:15px}.record-counts{display:flex;gap:15px;color:var(--muted);font-size:14px;flex-wrap:wrap}.record-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}.record-delete{color:var(--accent)}.record-delete:disabled{color:var(--muted)}.record-confirm{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;border-top:1px solid var(--line);margin-top:16px;padding-top:16px;color:var(--accent);font-size:14px}.record-confirm>div{display:flex;gap:8px}.records-error{padding:12px 14px;color:var(--accent);background:var(--panel);border-radius:8px;margin-bottom:16px;font-size:14px}.records-empty{display:flex;align-items:center;justify-content:center;gap:12px;flex-direction:column;min-height:200px;color:var(--muted);font-size:14px}
@media(max-width:600px){.records-dialog{padding:18px;max-height:calc(100dvh - 24px);width:calc(100vw - 24px)}.record-card{padding:14px}.record-bottom{align-items:flex-end}.record-counts{gap:5px;flex-direction:column}.record-time>span{margin-left:0}.record-top{gap:8px}.records-title{font-size:18px}}
</style>
