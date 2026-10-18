<script setup lang="ts">
import {ref,computed,defineAsyncComponent,watch,nextTick,onBeforeUnmount} from 'vue';
import {DialogRoot,DialogPortal,DialogOverlay,DialogContent,DialogTitle,DialogClose,DialogDescription} from 'reka-ui';
import {Ruler,Plus,Calculator,X,Check,Trash2} from 'lucide-vue-next';
import Button from './ui/Button.vue';
import {calibrationTargetSchema} from '../../../shared/calibration-target';
const LivePreview=defineAsyncComponent(()=>import('./CameraPreview.vue'));
const open=ref(false),busy=ref(false),error=ref(''),message=ref(''),status=ref<any>({session:null}),boards=ref<any[]>([]),board=ref('');
const scaleConfirmed=ref(false),measured=ref(false),mount=ref({heightMm:140,forwardMm:0,leftMm:0,imageTopForward:true});
const selectedPhoto=ref(''),clearConfirm=ref(false);
const outlierSelection=ref<string[]>([]),outlierConfirm=ref(false);
const outliers=computed<any[]>(()=>status.value.session?.calibrationReview?.current?status.value.session.samples.filter((p:any)=>p.detection?.reprojection?.excessive):[]);
watch(()=>status.value.session?.calibrationReview,()=>{outlierSelection.value=[];outlierConfirm.value=false;});
watch(outliers,items=>{if(items.length)void nextTick(()=>document.querySelector('.outlier-review')?.scrollIntoView({block:'start'}));});
function showPhoto(file:string){selectedPhoto.value=file;void nextTick(()=>document.querySelector('.photo-enlarged')?.scrollIntoView({block:'nearest'}));}
const restoring=ref(false),defaultsNote=ref('');
const targetKind=ref<'registered'|'aprilgrid'|'checkerboard'>('registered');
const aprilGrid=ref({family:'auto',rows:6,columns:6,tagSizeMm:'' as number|string,gapMm:'' as number|string,layoutMode:'auto',firstId:0,idOrder:'row-major'});
const chess=ref({rows:6,columns:6,squareSizeMm:'' as number|string,counts:'squares'});
const target=computed(()=>calibrationTargetSchema.safeParse(targetKind.value==='registered'?{type:'registered',boardId:board.value}:targetKind.value==='aprilgrid'?{type:'aprilgrid',...aprilGrid.value,tagSizeMm:Number(aprilGrid.value.tagSizeMm),gapMm:Number(aprilGrid.value.gapMm)}:{type:'checkerboard',rows:chess.value.rows-(chess.value.counts==='squares'?1:0),columns:chess.value.columns-(chess.value.counts==='squares'?1:0),squareSizeMm:Number(chess.value.squareSizeMm)}));
const matchesSession=computed(()=>{const saved=calibrationTargetSchema.safeParse(status.value.session?.target??{type:'registered',boardId:status.value.session?.boardId});return saved.success&&target.value.success&&JSON.stringify(saved.data)===JSON.stringify(target.value.data);});
const targetLabel=computed(()=>{const t=status.value.session?.target;return !t||t.type==='registered'?status.value.session?.boardId:t.type==='aprilgrid'?`AprilGrid ${t.columns}×${t.rows}`:`棋盘格 ${t.columns}×${t.rows} 内角点`;});
let defaultsTimer:ReturnType<typeof setTimeout>|undefined,defaultsRevision=0,pendingDefaults:unknown=null,defaultsQueue=Promise.resolve();
function persistDefaults(chosen:unknown,revision:number){
 defaultsQueue=defaultsQueue.then(async()=>{
  if(revision!==defaultsRevision)return;
  defaultsNote.value='正在保存参数…';
  try{const response=await fetch('/api/camera/calibration/defaults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:chosen}),keepalive:true});const json=await response.json();if(!response.ok)throw new Error(json.error??'参数保存失败');if(revision===defaultsRevision)defaultsNote.value='默认参数已保存';}
  catch(e){if(revision===defaultsRevision)defaultsNote.value=(e as Error).message;}
 });
 return defaultsQueue;
}
watch(target,value=>{
 if(restoring.value)return;
 clearTimeout(defaultsTimer);const revision=++defaultsRevision;pendingDefaults=null;
 if(!value.success){defaultsNote.value='';return;}
 pendingDefaults=value.data;
 defaultsTimer=setTimeout(()=>{const chosen=pendingDefaults;pendingDefaults=null;void persistDefaults(chosen,revision);},450);
});
onBeforeUnmount(()=>{clearTimeout(defaultsTimer);if(pendingDefaults)void persistDefaults(pendingDefaults,defaultsRevision);});
async function request(path:string,body?:unknown,method?:string){const response=await fetch('/api/camera/calibration'+path,{method:method??(body===undefined?'GET':'POST'),headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const json=await response.json();if(!response.ok)throw new Error(json.error??'标定失败');return json;}
async function act(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';message.value='';try{await fn();}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
async function load(){if(busy.value)return;restoring.value=true;clearTimeout(defaultsTimer);const pending=pendingDefaults;pendingDefaults=null;try{await act(async()=>{if(pending)await persistDefaults(pending,defaultsRevision);else await defaultsQueue;const response=await fetch('/api/boards');boards.value=await response.json();status.value=await request('');const robot=await (await fetch('/api/robot/status')).json();const visible=robot.detector?.groups?.find((g:any)=>boards.value.some(b=>b.id===g.id));board.value=status.value.session?.boardId??visible?.id??boards.value[0]?.id??'';const saved=status.value.defaults?.target??status.value.session?.target;if(saved){targetKind.value=saved.type;if(saved.type==='registered')board.value=saved.boardId;if(saved.type==='aprilgrid')aprilGrid.value={...saved,layoutMode:saved.layoutMode??'manual'};if(saved.type==='checkerboard')chess.value={rows:saved.rows,columns:saved.columns,squareSizeMm:saved.squareSizeMm,counts:'corners'};}selectedPhoto.value='';clearConfirm.value=false;scaleConfirmed.value=false;defaultsNote.value=saved?'已恢复上次参数':'';if(status.value.mount){mount.value={heightMm:status.value.mount.heightMm,forwardMm:status.value.mount.forwardMm,leftMm:status.value.mount.leftMm,imageTopForward:true};measured.value=status.value.mount.verified;}});}finally{await nextTick();restoring.value=false;}}
function changed(value:boolean){if(value)void load();}
async function start(){if(!target.value.success)return;const chosen=target.value.data;await act(async()=>{status.value=await request('/start',{target:chosen});selectedPhoto.value='';clearConfirm.value=false;scaleConfirmed.value=false;});}
async function probe(){if(!target.value.success)return;const chosen=target.value.data;await act(async()=>{const result=await request('/probe',{target:chosen});if(result.valid)message.value=`${result.family??'棋盘格'} · 已识别 ${result.matchedCount} ${chosen.type==='checkerboard'?'个角点':'个子码'}`;else error.value=result.reason;});}
async function capture(){await act(async()=>{status.value=await request('/capture',{});});}
function photoUrl(file:string){return '/api/camera/calibration/'+encodeURIComponent(status.value.session.id)+'/photos/'+encodeURIComponent(file);}
async function removePhoto(file:string){await act(async()=>{status.value=await request('/'+status.value.session.id+'/photos/'+encodeURIComponent(file),undefined,'DELETE');if(selectedPhoto.value===file)selectedPhoto.value='';clearConfirm.value=false;});}
async function clearPhotos(){await act(async()=>{status.value=await request('/'+status.value.session.id+'/photos',undefined,'DELETE');selectedPhoto.value='';clearConfirm.value=false;message.value='照片已清空';});}
async function removeOutliers(){
 const id=status.value.session?.id,files=[...outlierSelection.value].filter(file=>outliers.value.some(p=>p.file===file));
 if(!outlierConfirm.value||!id||!files.length)return;
 await act(async()=>{let removed=0;try{for(const file of files){status.value=await request('/'+id+'/photos/'+encodeURIComponent(file),undefined,'DELETE');removed++;if(selectedPhoto.value===file)selectedPhoto.value='';}}finally{outlierSelection.value=[];outlierConfirm.value=false;scaleConfirmed.value=false;if(removed)message.value=`已删除 ${removed} 张照片，请重新计算并验证内参`;}});
}
async function solve(){await act(async()=>{try{status.value=await request('/solve',{physicalScaleConfirmed:scaleConfirmed.value});message.value='内参标定完成';}catch(e){status.value=await request('');throw e;}});}
async function saveMount(){await act(async()=>{status.value=await request('/mount',{...mount.value,measured:measured.value});message.value='安装参数已保存';});}
</script>
<template>
 <DialogRoot v-model:open="open" @update:open="changed">
  <Button variant="outline" class="w-full mt-3" @click="open=true;load()"><Ruler :size="20"/>定位标定</Button>
  <DialogPortal><DialogOverlay class="calibration-overlay"/><DialogContent class="calibration-dialog">
   <div class="calibration-heading"><DialogTitle>定位标定</DialogTitle><DialogClose as-child><Button variant="ghost" size="icon" aria-label="关闭定位标定"><X :size="22"/></Button></DialogClose></div>
   <DialogDescription class="sr-only">移动并向不同方向倾斜定位板，采集至少16个视角。</DialogDescription>
   <div class="calibration-workspace">
    <section class="calibration-preview-column" aria-label="标定实时画面与采集">
     <div v-if="open" class="calibration-live"><LivePreview compact/></div>
     <div v-if="error||message" class="calibration-feedback"><div v-if="error" role="alert" class="calibration-error">{{error}}</div><div v-if="message" role="status" class="calibration-success">{{message}}</div></div>
     <div class="calibration-controls">
      <div class="calibration-control-meta"><div class="calibration-count">{{status.session?.sampleCount??0}} <span>/ 16 张</span></div><Button variant="outline" size="sm" :disabled="busy||status.busy||!target.success" @click="start">新建采集</Button></div>
      <div v-if="status.session" class="target-session">当前采集：{{targetLabel}}<span v-if="!matchesSession">参数已修改，请新建采集</span></div>
      <div class="calibration-buttons"><Button :disabled="busy||status.busy||!matchesSession" @click="capture"><Plus :size="20"/>采集当前画面</Button><Button variant="outline" :disabled="busy||status.busy||!target.success" @click="probe">检查当前画面</Button></div>
      <label class="calibration-check"><input v-model="scaleConfirmed" type="checkbox"/>已核对标定板实际尺寸与参数一致</label>
      <Button class="w-full" :disabled="busy||status.busy||!matchesSession||!scaleConfirmed||(status.session?.sampleCount??0)<16" @click="solve"><Calculator :size="20"/>{{busy?'处理中…':'计算并验证内参'}}</Button>
      <div v-if="status.intrinsics" class="calibration-result"><Check :size="18"/>{{status.intrinsics.verified?'已验证':'待验证'}} · {{status.intrinsics.rmsPixels?.toFixed(2)}} px</div>
     </div>
    </section>
    <div class="calibration-settings" aria-label="标定参数与照片">
   <section v-if="outliers.length" class="outlier-review" aria-label="高误差标定照片">
    <h3>{{outliers.length}} 张照片误差过大</h3>
    <div v-for="sample in outliers" :key="sample.file" class="outlier-item">
     <label><input v-model="outlierSelection" :value="sample.file" type="checkbox" :disabled="busy||outlierConfirm" :aria-label="`选择高误差照片 ${status.session.samples.findIndex((p:any)=>p.file===sample.file)+1}`"/>照片 {{status.session.samples.findIndex((p:any)=>p.file===sample.file)+1}}</label>
     <span>{{sample.detection.reprojection.role==='training'?'拟合':'验证'}} {{sample.detection.reprojection.rmsPixels.toFixed(2)}} px / {{sample.detection.reprojection.thresholdPixels.toFixed(1)}} px</span>
     <button type="button" class="photo-open" :aria-label="`查看高误差照片 ${status.session.samples.findIndex((p:any)=>p.file===sample.file)+1}`" @click="showPhoto(sample.file)"><img :src="photoUrl(sample.file)" alt="高误差标定照片"/></button>
    </div>
    <div v-if="outlierConfirm" class="photos-confirm" role="group" aria-label="删除高误差照片确认"><span>删除所选 {{outlierSelection.length}} 张照片？</span><Button variant="outline" :disabled="busy" @click="outlierConfirm=false">取消删除</Button><Button variant="destructive" :disabled="busy||status.busy" @click="removeOutliers">确认删除 {{outlierSelection.length}} 张</Button></div>
    <Button v-else variant="destructive" class="w-full" :disabled="busy||status.busy||!outlierSelection.length" @click="outlierConfirm=true">删除所选高误差照片</Button>
   </section>
   <div v-else-if="status.session?.calibrationReview&&!status.session.calibrationReview.current" class="defaults-note" role="status">照片已变化，请重新计算照片误差。</div>
   <div class="calibration-body">
    <section><h3>相机内参</h3>
     <div class="target-options" role="group" aria-label="标定板类型"><Button :variant="targetKind==='registered'?'default':'outline'" :aria-pressed="targetKind==='registered'" :disabled="busy" @click="targetKind='registered'">已打印定位板</Button><Button :variant="targetKind==='aprilgrid'?'default':'outline'" :aria-pressed="targetKind==='aprilgrid'" :disabled="busy" @click="targetKind='aprilgrid'">专用 AprilGrid 板</Button><Button :variant="targetKind==='checkerboard'?'default':'outline'" :aria-pressed="targetKind==='checkerboard'" :disabled="busy" @click="targetKind='checkerboard'">黑白棋盘格</Button></div>
     <label v-if="targetKind==='registered'">定位板<select v-model="board" aria-label="标定定位板"><option v-for="b in boards" :key="b.id" :value="b.id">{{b.id}} · {{b.gridSize}}×{{b.gridSize}} · {{b.sizeMm}} mm</option></select></label>
     <template v-else-if="targetKind==='aprilgrid'">
      <div class="target-fields"><label>码列数<input v-model.number="aprilGrid.columns" type="number" min="2" max="12"/></label><label>码行数<input v-model.number="aprilGrid.rows" type="number" min="2" max="12"/></label></div>
      <label>单码黑框边长 / mm<input v-model.number="aprilGrid.tagSizeMm" type="number" min="3" max="200" step="0.1" placeholder="填写实测边长"/></label>
      <label>相邻黑框间距 / mm<input v-model.number="aprilGrid.gapMm" type="number" min="0.1" max="200" step="0.1" placeholder="填写两黑框之间的空白宽度"/></label>
      <label>码族<select v-model="aprilGrid.family"><option value="auto">自动识别</option><option value="tag36h11">tag36h11</option><option value="tag36h10">tag36h10</option><option value="tag25h9">tag25h9</option><option value="tag16h5">tag16h5</option></select></label>
      <label>编号方式<select v-model="aprilGrid.layoutMode"><option value="auto">自动识别编号和布局</option><option value="manual">手动填写已知编号</option></select></label>
      <div v-if="aprilGrid.layoutMode==='manual'" class="target-fields"><label>起始 ID<input v-model.number="aprilGrid.firstId" type="number" min="0" max="2319"/></label><label>编号排列<select v-model="aprilGrid.idOrder"><option value="row-major">逐行递增</option><option value="column-major">逐列递增</option></select></label></div>
     </template>
     <template v-else><label>数量填写方式<select v-model="chess.counts"><option value="squares">格子数量</option><option value="corners">内角点数量</option></select></label><div class="target-fields"><label>棋盘列数<input v-model.number="chess.columns" type="number" min="3" max="20"/></label><label>棋盘行数<input v-model.number="chess.rows" type="number" min="3" max="20"/></label></div><label>单格边长 / mm<input v-model.number="chess.squareSizeMm" type="number" min="1" max="200" step="0.1" placeholder="填写实测边长"/></label></template>
     <div v-if="defaultsNote" class="defaults-note" aria-live="polite">{{defaultsNote}}</div>
    </section>
    <section><h3>安装参数</h3><label>镜头离地 / mm<input v-model.number="mount.heightMm" type="number" min="20" max="1000"/></label><label>相对车体中心前移 / mm<input v-model.number="mount.forwardMm" type="number" min="-1000" max="1000"/></label><label>相对车体中心左移 / mm<input v-model.number="mount.leftMm" type="number" min="-1000" max="1000"/></label>
     <div class="calibration-hint">负值表示后移或右移。镜头竖直朝下，画面上方对应车头。</div>
     <label class="calibration-check"><input v-model="measured" type="checkbox"/>已实测并确认安装参数</label><Button variant="outline" class="w-full" :disabled="busy||!measured" @click="saveMount">保存安装参数</Button>
    </section>
   </div>
   <section v-if="status.session" class="calibration-photos">
    <div class="photos-heading"><h3>已采集照片 · {{status.session.sampleCount}}</h3><Button variant="outline" :disabled="busy||status.busy||!status.session.sampleCount" @click="clearConfirm=true"><Trash2 :size="18"/>清空照片</Button></div>
    <div v-if="clearConfirm" class="photos-confirm" role="group" aria-label="清空标定照片确认"><span>清空这 {{status.session.sampleCount}} 张照片？</span><Button variant="outline" :disabled="busy" @click="clearConfirm=false">取消</Button><Button variant="destructive" :disabled="busy||status.busy" @click="clearPhotos">确认清空</Button></div>
    <div v-if="selectedPhoto" class="photo-enlarged"><Button variant="ghost" size="icon" aria-label="关闭照片预览" @click="selectedPhoto=''"><X :size="22"/></Button><img :src="photoUrl(selectedPhoto)" alt="标定照片大图"/></div>
    <div v-if="status.session.sampleCount" class="photos-grid">
     <figure v-for="(sample,index) in status.session.samples" :key="sample.file" class="photo-card" :data-photo-file="sample.file">
      <button type="button" class="photo-open" :aria-label="`查看标定照片 ${Number(index)+1}`" @click="selectedPhoto=sample.file"><img :src="photoUrl(sample.file)" :alt="`标定照片 ${Number(index)+1}`" loading="lazy"/></button>
      <figcaption><span>照片 {{Number(index)+1}}</span><Button variant="ghost" size="icon" :disabled="busy||status.busy" :aria-label="`删除标定照片 ${Number(index)+1}`" @click="removePhoto(sample.file)"><Trash2 :size="19"/></Button></figcaption>
      <div v-if="sample.detection" :class="['photo-detection',{invalid:!sample.detection.valid}]">{{sample.detection.valid?'可用 · '+sample.detection.matchedCount:sample.detection.reason}}</div>
      <div v-if="sample.detection?.reprojection" :class="['photo-detection',{invalid:sample.detection.reprojection.excessive}]">{{sample.detection.reprojection.role==='training'?'拟合':'验证'}} {{sample.detection.reprojection.rmsPixels.toFixed(2)}} px{{sample.detection.reprojection.excessive?' · 误差过大':''}}</div>
     </figure>
    </div><div v-else class="photos-empty">暂无照片</div>
   </section>
    </div>
   </div>
  </DialogContent></DialogPortal>
 </DialogRoot>
</template>
<style scoped>
.calibration-overlay{position:fixed;inset:0;background:#0f172a60;z-index:80}
.calibration-dialog{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1280px,calc(100vw - 32px));height:min(880px,calc(100dvh - 32px));overflow:hidden;display:flex;flex-direction:column;gap:18px;border-radius:8px;background:white;padding:14px;z-index:81;box-shadow:none;font-size:14px;color:var(--accent)}
.calibration-heading{display:flex;align-items:center;justify-content:space-between;flex-shrink:0;font-size:18px;font-weight:600}
.calibration-workspace{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:14px;flex:1;min-height:0}
.calibration-preview-column{display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0}
.calibration-live{flex:1;min-height:0;overflow:hidden;border:1px solid var(--line);border-radius:8px}
.calibration-live :deep(.preview-page),.calibration-live :deep(.preview-main){height:100%;min-height:0}
.calibration-live :deep(.preview-main){padding:0}
.calibration-live :deep(.preview-screen){min-height:0;aspect-ratio:auto}
.calibration-live :deep(.preview-footer){display:none}
.calibration-controls{flex-shrink:0;display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--line);border-radius:8px;background:var(--background)}
.calibration-control-meta{display:flex;align-items:center;justify-content:space-between;gap:12px}
.calibration-count{display:flex;align-items:baseline;gap:8px;font-size:18px;color:var(--accent);line-height:1}
.calibration-count span{font-size:14px}
.calibration-buttons{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
.calibration-check{display:flex!important;align-items:center;gap:10px;flex-direction:row!important;justify-content:flex-start!important;font-size:14px;line-height:1.5}
.calibration-check input{width:19px;height:19px;accent-color:var(--accent);flex-shrink:0}
.target-session{font-size:14px;color:var(--muted);line-height:1.4}
.target-session span{display:block;color:var(--accent);margin-top:4px}
.calibration-feedback{max-height:100px;overflow:auto;flex-shrink:0}
.calibration-error,.calibration-success{padding:12px;border-radius:8px;background:var(--background);color:var(--accent);overflow-wrap:anywhere}
.calibration-success{background:var(--panel);color:var(--accent)}
.calibration-result{display:flex;align-items:center;gap:8px;color:var(--accent);font-size:14px}
.calibration-settings{min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;border-left:1px solid var(--line);padding-left:20px;padding-right:4px}
.calibration-body{display:flex;flex-direction:column;gap:14px}
.calibration-body section{min-width:0}
.calibration-body h3{font-size:14px;margin:0 0 16px}
.calibration-body label{display:block;margin:12px 0}
.calibration-body input:not([type=checkbox]),select{display:block;width:100%;height:46px;border:1px solid var(--line);border-radius:8px;margin-top:8px;padding:8px 12px;font-size:14px}
.calibration-hint{font-size:14px;color:var(--muted);line-height:1.6;margin:12px 0}
.defaults-note{font-size:14px;color:var(--muted);margin:12px 0;line-height:1.5}
.target-options{display:grid;grid-template-columns:1fr;gap:8px;margin-bottom:16px}
.target-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.photo-detection{font-size:14px;color:var(--accent);padding:0 8px 8px;line-height:1.5;overflow-wrap:anywhere}
.photo-detection.invalid{color:var(--accent)}
.outlier-review{border:1px solid var(--line);background:var(--background);border-radius:8px;padding:12px;margin-bottom:12px}.outlier-review h3{font-size:14px;color:var(--accent);margin:0 0 12px}.outlier-item{display:grid;grid-template-columns:1fr;gap:7px;margin:14px 0;font-size:14px}.outlier-item label{display:flex;align-items:center;gap:10px}.outlier-item input{width:19px;height:19px;accent-color:var(--accent)}.outlier-item span{color:var(--accent)}.outlier-item .photo-open{border-radius:8px;overflow:hidden}.outlier-item img{max-height:130px}
@media(max-width:850px){.calibration-dialog{padding:16px;gap:12px;width:calc(100vw - 24px);height:calc(100dvh - 24px)}.calibration-heading{font-size:18px}.calibration-workspace{display:flex;flex-direction:column;gap:12px}.calibration-preview-column{flex:0 0 62%;gap:8px}.calibration-controls{padding:10px;gap:8px}.calibration-count{font-size:18px}.calibration-live :deep(.preview-stats){display:none}.calibration-live :deep(.preview-toolbar){flex-wrap:nowrap;padding:6px 10px;gap:8px}.calibration-settings{flex:1;border-left:0;border-top:1px solid var(--line);padding:14px 4px 0 0}.target-session{font-size:14px}.calibration-check{font-size:14px}}
</style>
<style scoped>
.calibration-photos{margin-top:14px;border-top:1px solid var(--line);padding-top:18px}.photos-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.photos-heading h3{font-size:14px;font-weight:600;margin:0}.photos-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px}.photo-card{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;min-width:0}.photo-open{display:block;width:100%;background:#0f172a;padding:0;border:0;cursor:zoom-in}.photo-open img{width:100%;aspect-ratio:16/9;object-fit:contain;display:block}.photo-card figcaption{display:flex;align-items:center;justify-content:space-between;padding:5px 8px;font-size:14px}.photos-empty{padding:22px;color:var(--muted);text-align:center}.photos-confirm{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;padding:12px;background:var(--background);border-radius:8px;margin-top:12px;font-size:14px}.photos-confirm span{margin-right:auto}.photo-enlarged{position:relative;margin-top:14px;background:#0f172a;border-radius:8px;overflow:hidden}.photo-enlarged img{display:block;width:100%;max-height:300px;object-fit:contain}.photo-enlarged>button{position:absolute;right:8px;top:8px;background:white;z-index:1}
</style>
