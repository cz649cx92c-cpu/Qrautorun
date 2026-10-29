<script setup lang="ts">
import {ref,watch,computed} from 'vue';
import type {FieldMap} from '../../../shared/model';
const props=defineProps<{map:FieldMap,version:number,tagId:number}>();
type Info={family:string,kind:'single'|'board',board?:{id:string,sizeMm:number,gridSize:number},members:{id:number,sizeMm:number|null}[],printable:boolean,unavailableReason?:string};
const info=ref<Info|null>(null),error=ref(''),memberId=ref(0),crosshair=ref(true),loading=ref(false);
const base=computed(()=>`/api/maps/${encodeURIComponent(props.map.id)}/tags/${props.tagId}/`);
function url(format:string,target:string){return `${base.value}reprint.${format}?version=${props.version}&target=${target}&memberId=${memberId.value}&centerCrosshair=${crosshair.value}`;}
let generation=0;
watch(()=>[props.map.id,props.version,props.tagId],async()=>{const current=++generation;info.value=null;error.value='';try{const response=await fetch(`${base.value}print-info?version=${props.version}`),data=await response.json();if(!response.ok)throw new Error(data.error);if(current!==generation)return;info.value=data;memberId.value=data.members[0].id;}catch(e){if(current===generation)error.value=(e as Error).message;}},{immediate:true});
async function download(target:string){loading.value=true;error.value='';try{const response=await fetch(url('pdf',target));if(!response.ok)throw new Error((await response.json()).error);const blob=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=blob;link.download=`${target==='board'?info.value?.board?.id:'Q'+String(memberId.value).padStart(3,'0')}-original.pdf`;link.click();setTimeout(()=>URL.revokeObjectURL(blob),1000);}catch(e){error.value=(e as Error).message;}finally{loading.value=false;}}
</script>
<template>
 <section class="tag-inspector" data-testid="tag-inspector" aria-label="原码查看与补打">
  <p v-if="error" role="alert">{{error}}</p>
  <template v-if="info">
   <strong>{{info.family}} · {{info.kind==='board'?'整组定位板 '+info.board?.id:'独立单码'}}</strong>
   <template v-if="info.board">
    <p>原板 {{info.board.gridSize}}×{{info.board.gridSize}} · {{info.board.sizeMm}} mm</p>
    <label><input v-model="crosshair" type="checkbox">整组中心十字（有安全白缝时）</label>
    <img :src="url('svg','board')" :alt="`${info.board.id} 原尺寸整板预览`" data-testid="original-board-preview">
    <button type="button" :disabled="loading" @click="download('board')" data-testid="reprint-board">下载原尺寸整板 PDF</button>
   </template>
   <template v-else-if="info.printable">
    <p>Q{{String(memberId).padStart(3,'0')}} · 黑边 {{info.members.find(member=>member.id===memberId)?.sizeMm??'未知'}} mm</p>
    <img :src="url('svg','member')" :alt="`tag36h11 Q${String(memberId).padStart(3,'0')} 真实单码预览`" data-testid="original-tag-preview">
    <button type="button" :disabled="loading" @click="download('member')" data-testid="reprint-member">下载原尺寸单码 PDF</button>
   </template>
   <small v-if="info.printable">100% / ACTUAL SIZE；保留静区，按 50 mm 尺校验。</small>
   <p v-else role="status">{{info.unavailableReason}}</p>
  </template>
 </section>
</template>
<style scoped>
.tag-inspector{display:grid;gap:8px;padding:10px 0;border-top:1px solid #e2e8f0}.tag-inspector p{margin:0;font-size:12px}.tag-inspector img{display:block;width:100%;height:auto;background:#fff}.tag-inspector label{font-size:12px}.tag-inspector small{font-size:11px;color:#64748b}.tag-inspector button{padding:6px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#0f172a}.tag-inspector select{width:100%}
</style>
