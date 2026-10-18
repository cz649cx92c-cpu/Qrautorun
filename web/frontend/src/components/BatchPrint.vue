<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {Printer,Download,ScanLine,Map,ArrowRight,FileText,Package,CheckCircle2} from 'lucide-vue-next';
import Button from './ui/Button.vue';
import type {FieldMap} from '../../../shared/model';
const props=defineProps<{map:FieldMap,version:number}>();
const source=ref<'map'|'range'>('map'),startId=ref(0),endId=ref(99),sizeMm=ref(80),layout=ref<'packed'|'single'>('packed');
type Preview={id:number,size:number,x?:number,y?:number,angle?:number};
type Plan={count:number,firstId:number,lastId:number,sizesMm:number[],columns:number,rows:number,pages:number,filename:string,preview:Preview[]};
const plan=ref<Plan|null>(null),error=ref(''),message=ref(''),busy=ref(false),planBusy=ref(false),pdfUrl=ref('');
const request=computed(()=>source.value==='map'?{source:'map',map:props.map,layout:layout.value}:{source:'range',startId:startId.value,endId:endId.value,sizeMm:sizeMm.value,layout:layout.value});
const label=(id:number)=>'Q'+String(id).padStart(3,'0');
let timer:ReturnType<typeof setTimeout>|undefined,sequence=0;
watch(request,()=>{plan.value=null;error.value='';planBusy.value=true;sequence++;if(pdfUrl.value){URL.revokeObjectURL(pdfUrl.value);pdfUrl.value='';}clearTimeout(timer);timer=setTimeout(refreshPlan,200);},{deep:true,immediate:true});
async function refreshPlan(){const seq=sequence;try{const res=await fetch('/api/print/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request.value)});const result=await res.json();if(!res.ok)throw new Error(result.error);if(seq===sequence)plan.value=result;}catch(e){if(seq===sequence)error.value=e instanceof Error?e.message:String(e);}finally{if(seq===sequence)planBusy.value=false;}}
function allTags(){source.value='range';startId.value=0;endId.value=586;}
function previewUrl(t:Preview){const p=new URLSearchParams({sizeMm:String(t.size*1000)});if(t.x!==undefined&&t.y!==undefined&&t.angle!==undefined){p.set('x',String(t.x));p.set('y',String(t.y));p.set('angle',String(t.angle));}return `/api/print/tag/${t.id}.svg?${p}`;}
async function generate(format:'pdf'|'bundle',open=false){
 if(!plan.value||busy.value)return;
 const snapshot=JSON.parse(JSON.stringify(request.value)),filename=plan.value.filename;
 const printWindow=open?window.open('about:blank','_blank'):null;
 if(printWindow){printWindow.opener=null;printWindow.document.title='正在生成AprilTag打印文件';printWindow.document.body.textContent='正在生成整批AprilTag PDF，请稍候…';}
 busy.value=true;error.value='';message.value='';
 try{const res=await fetch('/api/print/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...snapshot,format})});if(!res.ok)throw new Error((await res.json()).error);const blob=await res.blob(),url=URL.createObjectURL(blob);
  if(format==='pdf'){if(pdfUrl.value)URL.revokeObjectURL(pdfUrl.value);pdfUrl.value=url;}
  if(printWindow)printWindow.location.replace(url);else {const a=document.createElement('a');a.href=url;a.download=filename+(format==='pdf'?'.pdf':'.zip');a.click();if(format==='bundle')setTimeout(()=>URL.revokeObjectURL(url),60000);}
  message.value=format==='bundle'?'打印包已下载，包含整份PDF、每个编号的SVG和编号清单。':'整份PDF已生成。打印全部页面，选择A4、单面、100%实际大小。';
 }catch(e){printWindow?.close();error.value=e instanceof Error?e.message:String(e);}finally{busy.value=false;}
}
onBeforeUnmount(()=>{clearTimeout(timer);sequence++;if(pdfUrl.value)URL.revokeObjectURL(pdfUrl.value);});
</script>

<template>
 <div class="batch-print-page">
  <aside class="print-settings">
   <div class="panel-title"><Printer :size="18"/>批量生成设置</div><p class="panel-desc">一份PDF打印整批标记，不需要逐张操作。</p>
   <div class="print-source-options"><button :class="{active:source==='map'}" :disabled="busy" @click="source='map'"><Map :size="18"/><span>当前地图全部标记<small>保留编号、尺寸与安装坐标</small></span></button><button :class="{active:source==='range'}" :disabled="busy" @click="source='range'"><ScanLine :size="18"/><span>按编号批量生成<small>适合先打印铺设，再现场建图</small></span></button></div>
   <template v-if="source==='range'"><div class="form-grid"><label>起始 ID<input v-model.number="startId" :disabled="busy" type="number" min="0" max="586"/></label><label>结束 ID<input v-model.number="endId" :disabled="busy" type="number" min="0" max="586"/></label></div><label>黑色外边界 / mm<input v-model.number="sizeMm" :disabled="busy" type="number" min="20" max="150" step="1"/></label><Button variant="outline" class="w-full mt-3" :disabled="busy" @click="allTags">生成全部 587 个编号</Button><p class="help">tag36h11 有效 ID 为 0–586。编号模式不预设地面坐标，后续用原编号建图。</p></template>
   <template v-else><div class="print-map-card"><strong>{{map.name}}</strong><span>{{map.tags.length}} 个标记 · {{version?'当前工作副本 / v'+version:'尚未保存的地图'}}</span></div><p class="help">直接使用当前编辑内容，标记尺寸取自地图。完整打印包附带此次地图快照与铺设图。</p></template>
   <div class="section-label">A4 排版</div><label>排版方式<select v-model="layout" :disabled="busy"><option value="packed">自动多张排版 · 节省纸张</option><option value="single">每页一张 · 方便单张使用</option></select></label><p class="help">保持真实物理尺寸，自动计算每页数量；保留白色静区，编号印在图案外侧。</p>
   <Button class="w-full mt-4" :disabled="busy||!plan||planBusy" @click="generate('pdf',true)"><Printer :size="16"/>{{busy?'正在生成…':'生成并打开打印'}}</Button>
   <Button class="w-full mt-2" variant="outline" :disabled="busy||!plan||planBusy" @click="generate('pdf')"><Download :size="16"/>下载整份 PDF</Button>
   <Button class="w-full mt-2" variant="outline" :disabled="busy||!plan||planBusy" @click="generate('bundle')"><Package :size="16"/>下载完整打印包</Button>
  </aside>
  <section class="print-content">
   <div class="print-hero"><div><span class="print-eyebrow">APRILTAG · TAG36H11</span><h2>整批生成，直接打印</h2><p>真实可识别图案 · 编号唯一 · A4 实际尺寸</p></div><Printer :size="40" stroke-width="1.3"/></div>
   <div v-if="error" class="error-text print-notice" role="alert">{{error}}</div><div v-if="message" class="print-notice print-success" role="status"><CheckCircle2 :size="16"/>{{message}}<a v-if="pdfUrl" :href="pdfUrl" target="_blank" rel="noopener">打开PDF <ArrowRight :size="14"/></a></div>
   <div v-if="plan" class="print-metrics"><div><span>本批标记</span><strong>{{plan.count}}<small> 张</small></strong></div><div><span>编号范围</span><strong class="print-range">{{label(plan.firstId)}}–{{label(plan.lastId)}}</strong></div><div><span>A4 纸张</span><strong>{{plan.pages}}<small> 页</small></strong></div><div><span>每页排版</span><strong>{{plan.columns}} × {{plan.rows}}</strong></div></div>
   <div class="print-preview-heading"><div class="panel-title"><ScanLine :size="17"/>标记预览</div><span>{{planBusy?'正在计算…':plan?'黑边 '+plan.sizesMm.join(' / ')+' mm · 前 '+plan.preview.length+' 张':'请设置有效编号与尺寸'}}</span></div>
   <div v-if="plan" class="print-preview-grid"><div v-for="t in plan.preview" :key="t.id" class="print-preview-card"><img :src="previewUrl(t)" :alt="'AprilTag '+label(t.id)" loading="lazy"/><div><strong>{{label(t.id)}}</strong><span>{{(t.size*1000).toFixed(0)}} mm</span></div></div></div>
   <div class="print-instructions"><div class="panel-title"><FileText :size="17"/>打印与铺设</div><ol><li>打开整份PDF，打印范围选择“全部”，纸张选择 A4、单面。</li><li>选择“100% / 实际大小”，关闭适应页面、缩小与打印机额外的多页合一。</li><li>先打印一页，测量底部 50mm 标尺和标记黑色外边界；尺寸正确后全部打印。</li><li>裁切时保留完整白色静区。打印向右箭头代表安装 +X 方向，按地图安装角度铺设。</li></ol></div>
  </section>
 </div>
</template>

<style scoped>
.batch-print-page{display:flex;flex:1;min-height:0}.print-settings{width:292px;flex-shrink:0;padding:25px 23px;background:#fff;border-right:1px solid #e3e9ef;overflow-y:auto}.print-content{flex:1;min-width:0;overflow-y:auto;padding:30px 34px;background:#f7faf9}.print-source-options{display:grid;gap:9px}.print-source-options button{display:flex;align-items:center;gap:11px;text-align:left;background:#fff;border:1px solid #e0e8e4;border-radius:9px;padding:13px 12px;color:#74877c;font-size:12px}.print-source-options button.active{border-color:#57a58a;background:#eff8f3;color:#197359}.print-source-options span{display:block}.print-source-options small{display:block;margin-top:6px;font-size:10px;color:#92a497}.print-map-card{padding:16px;background:#f3f8f5;border-radius:9px;margin-top:15px;word-break:break-word}.print-map-card strong{font-size:12px;display:block}.print-map-card span{font-size:10px;color:#869c8d;display:block;margin-top:8px}.print-hero{display:flex;justify-content:space-between;align-items:center;color:#27785e;margin-bottom:26px}.print-eyebrow{font-size:10px;letter-spacing:2px;color:#849d8f}.print-hero h2{font-size:25px;color:#2a4538;font-weight:600;margin:12px 0}.print-hero p{font-size:12px;color:#8a9c91;margin:0}.print-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:30px}.print-metrics>div{padding:18px;background:#fff;border:1px solid #e2ebe5;border-radius:10px;min-width:0}.print-metrics span{font-size:10px;color:#8c9d93}.print-metrics strong{display:block;font-size:23px;font-weight:600;color:#365f4b;margin-top:9px}.print-metrics strong.print-range{font-size:17px;white-space:nowrap;padding-top:5px}.print-metrics small{font-size:11px;font-weight:400;color:#8a9d91}.print-preview-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px;gap:10px}.print-preview-heading>span{font-size:10px;color:#8a9d91}.print-preview-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:15px}.print-preview-card{border:1px solid #e2eae5;background:white;border-radius:10px;padding:15px}.print-preview-card img{display:block;width:100%;height:155px;object-fit:contain}.print-preview-card>div{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #eef2ef;padding-top:13px;margin-top:12px}.print-preview-card strong{font-size:12px;color:#486653}.print-preview-card span{font-size:10px;color:#90a195}.print-instructions{padding:23px;background:#fff;border:1px solid #e2ebe5;border-radius:10px;margin-top:25px}.print-instructions ol{font-size:12px;line-height:2;color:#7e9387;margin-bottom:0;padding-left:18px}.print-notice{padding:13px 16px;border-radius:8px;font-size:12px;line-height:1.9;margin-bottom:16px}.print-success{display:flex;align-items:center;gap:9px;background:#e8f5ed;color:#327455;flex-wrap:wrap}.print-success a{display:flex;align-items:center;gap:4px;margin-left:auto;text-decoration:underline}@media(max-width:1200px){.print-settings{width:260px;padding:22px 18px}.print-content{padding:25px 22px}.print-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.batch-print-page{flex-direction:column}.print-settings{width:100%;max-height:none;overflow:visible}.print-content{overflow:visible}.print-preview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.print-preview-card img{height:130px}.print-preview-heading{flex-wrap:wrap}.print-hero h2{font-size:21px}}
</style>
