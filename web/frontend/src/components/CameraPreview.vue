<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref} from 'vue';
import {Camera,Crosshair,Expand,RefreshCw,Download,ZoomIn} from 'lucide-vue-next';
import Button from './ui/Button.vue';
import CameraCalibration from './CameraCalibration.vue';
import {previewFrameState} from '../previewFrameState';
withDefaults(defineProps<{compact?:boolean}>(),{compact:false});
const canvas=ref<HTMLCanvasElement>(),screen=ref<HTMLElement>(),crosshair=ref(true),original=ref(false),alive=ref(false),error=ref(''),busy=ref(false);
const status=ref<any>({name:'HBVCAM',fps:0,profiles:[],profile:'720p'}),lag=ref(0),renderFps=ref(0);
const frameSize=ref({width:1280,height:720}),hasFrame=ref(false),clock=ref(performance.now());
let socket:WebSocket|undefined,reconnect:ReturnType<typeof setTimeout>|undefined,timer:ReturnType<typeof setInterval>|undefined,disposed=false,lastFrame=0,offset=0,clockReady=false,epoch=0;
const rendered:number[]=[];
const freshness=computed(()=>previewFrameState(hasFrame.value,alive.value,lag.value,lastFrame,clock.value));
const dimensions=computed(()=>status.value.profiles.find((p:any)=>p.id===status.value.profile));
async function request(path:string,body?:unknown){const result=await fetch('/api/camera/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await result.json();if(!result.ok)throw new Error(data.error??'摄像头请求失败');return data;}
function connect(){
 if(disposed||document.hidden)return;clockReady=false;rendered.length=0;renderFps.value=0;const generation=++epoch;
 const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/camera`);socket=ws;ws.binaryType='arraybuffer';
 ws.onopen=()=>{error.value='';ws.send(JSON.stringify({type:'preview',maxFps:10}));ws.send(JSON.stringify({type:'ping',at:Date.now()}));};
 ws.onmessage=async event=>{
  if(generation!==epoch||disposed)return;
  if(typeof event.data==='string'){const data=JSON.parse(event.data);if(data.type==='camera'){status.value=data;if(data.error){error.value=data.error;alive.value=false;}}else if(data.type==='pong'){offset=data.serverAt-(data.at+Date.now())/2;clockReady=true;}return;}
  const buffer=event.data as ArrayBuffer;if(buffer.byteLength<20)return;const header=new DataView(buffer),sequence=header.getUint32(0),stamp=header.getFloat64(4),width=header.getUint16(12),height=header.getUint16(14);
  let bitmap:ImageBitmap|undefined;
  try{
   bitmap=await createImageBitmap(new Blob([buffer.slice(16)],{type:'image/jpeg'}));
   if(disposed||document.hidden||generation!==epoch||ws!==socket)return;
   const el=canvas.value;if(!el)return;if(el.width!==width||el.height!==height){el.width=width;el.height=height;}frameSize.value={width,height};
   el.getContext('2d',{alpha:false})?.drawImage(bitmap,0,0,width,height);lastFrame=performance.now();clock.value=lastFrame;hasFrame.value=true;alive.value=true;error.value='';
   rendered.push(lastFrame);while(rendered.length&&lastFrame-rendered[0]!>2000)rendered.shift();renderFps.value=rendered.length>1?Math.round((rendered.length-1)*10000/(lastFrame-rendered[0]!))/10:0;
   lag.value=clockReady?Math.max(0,Math.round(Date.now()+offset-stamp)):0;
  }catch{error.value='图像解码失败，等待新帧';alive.value=false;}finally{bitmap?.close();if(ws.readyState===1)ws.send(JSON.stringify({type:'ack',sequence}));}
 };
 ws.onclose=()=>{if(ws!==socket)return;alive.value=false;renderFps.value=0;error.value='连接中断，正在重连';if(!disposed&&!document.hidden)reconnect=setTimeout(connect,1000);};
 ws.onerror=()=>{error.value='摄像头连接异常';};
}
function clear(){hasFrame.value=false;const el=canvas.value;if(el)el.getContext('2d')?.clearRect(0,0,el.width,el.height);}
function retry(){error.value='';if(socket?.readyState===1)socket.send(JSON.stringify({type:'restart'}));else{clearTimeout(reconnect);connect();}}
async function profile(id:string){if(busy.value)return;busy.value=true;alive.value=false;rendered.length=0;renderFps.value=0;clear();try{status.value=await request('profile',{id});}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
function fullscreen(){void screen.value?.requestFullscreen().catch(()=>error.value='浏览器不支持全屏');}
function snapshot(){if(!alive.value)return;canvas.value?.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='HBVCAM-'+new Date().toISOString().replace(/[:.]/g,'-')+'.jpg';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},'image/jpeg',.95);}
function visibility(){if(document.hidden){epoch++;clearTimeout(reconnect);socket?.close();alive.value=false;}else connect();}
onMounted(()=>{connect();document.addEventListener('visibilitychange',visibility);timer=setInterval(()=>{clock.value=performance.now();if(alive.value&&clock.value-lastFrame>1500){alive.value=false;renderFps.value=0;error.value='画面停止更新，等待新帧';}},200);});
onBeforeUnmount(()=>{disposed=true;epoch++;clearInterval(timer);clearTimeout(reconnect);socket?.close();document.removeEventListener('visibilitychange',visibility);});
</script>
<template>
 <div :class="['preview-page',{compact}]">
  <div class="preview-main">
   <div class="preview-toolbar"><div class="preview-state"><i :class="{online:alive&&!freshness.delayed}"/>{{freshness.label}}</div><span>{{status.name}}</span><span class="preview-stats">{{dimensions?.width??1280}} × {{dimensions?.height??720}} · {{renderFps}} FPS</span><template v-if="compact"><Button variant="ghost" size="icon" aria-label="切换十字线" :aria-pressed="crosshair" @click="crosshair=!crosshair"><Crosshair :size="20"/></Button><Button variant="ghost" size="icon" aria-label="全屏实时画面" @click="fullscreen"><Expand :size="20"/></Button></template></div>
   <div ref="screen" :class="['preview-screen',{original}]">
    <canvas ref="canvas" class="preview-image" aria-label="摄像头实时画面"/>
    <div v-if="crosshair&&alive" class="preview-crosshair" :style="original?{left:frameSize.width/2+'px',top:frameSize.height/2+'px'}:undefined" aria-hidden="true"><i/><b/></div>
    <div v-if="hasFrame&&(freshness.delayed||!alive)" class="preview-notice" role="status">{{!alive?(error||'画面停止更新，等待新帧'):'画面有延迟'}} · 最近画面距今 {{(freshness.ageMs/1000).toFixed(1)}} 秒 <button v-if="!alive" class="preview-retry" @click="retry">重新连接</button></div>
    <div v-if="!hasFrame" class="preview-empty"><Camera :size="44"/><strong>{{error||'正在连接摄像头…'}}</strong><Button v-if="error" variant="outline" @click="retry"><RefreshCw :size="19"/>重新连接</Button></div>
   </div>
   <div class="preview-footer"><span>{{hasFrame?'最近画面距今 '+freshness.ageMs+' ms':'等待首帧'}}</span><span>HBVCAM</span></div>
  </div>
  <aside v-if="!compact" class="preview-panel">
   <div class="panel-title"><Camera :size="22"/>画面设置</div>
   <CameraCalibration/>
   <div class="section-label">画质</div><div class="preview-profiles"><button v-for="p in status.profiles" :key="p.id" :class="{active:status.profile===p.id}" :aria-pressed="status.profile===p.id" :disabled="busy" @click="profile(p.id)">{{p.label}}<small>{{p.fps}} FPS</small></button></div>
   <div class="section-label">显示</div><Button variant="outline" class="w-full mt-3" :aria-pressed="crosshair" @click="crosshair=!crosshair"><Crosshair :size="20"/>{{crosshair?'关闭十字线':'显示十字线'}}</Button><Button variant="outline" class="w-full mt-2" :aria-pressed="original" @click="original=!original"><ZoomIn :size="20"/>{{original?'适应窗口':'原尺寸查看'}}</Button><Button variant="outline" class="w-full mt-2" @click="fullscreen"><Expand :size="20"/>全屏画面</Button><Button variant="outline" class="w-full mt-2" :disabled="!alive" @click="snapshot"><Download :size="20"/>保存照片</Button>
  </aside>
 </div>
</template>
<style scoped>
.preview-page{display:flex;flex:1;min-height:0;min-width:0}.preview-main{display:flex;flex-direction:column;flex:1;min-width:0;padding:14px;gap:0;background:var(--background)}.preview-toolbar{display:flex;align-items:center;gap:18px;background:white;border:1px solid var(--panel);border-bottom:0;border-radius:8px;padding:10px 12px;font-size:14px;flex-wrap:wrap;color:var(--muted)}.preview-state{display:flex;align-items:center;gap:9px;font-weight:600;color:var(--ink)}.preview-state i{width:9px;height:9px;border-radius:8px;background:var(--accent)}.preview-state i.online{background:var(--accent)}.preview-stats{margin-left:auto;font-variant-numeric:tabular-nums}.preview-screen{position:relative;flex:1;display:flex;align-items:center;justify-content:center;background:#0f172a;overflow:hidden;min-height:320px}.preview-screen:fullscreen{width:100vw;height:100vh;min-height:0}.preview-image{display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain}.preview-screen.original{overflow:auto;display:block}.original .preview-image{width:auto;height:auto;max-width:none;max-height:none}.preview-crosshair{position:absolute;top:50%;left:50%;width:56px;height:56px;transform:translate(-50%,-50%);pointer-events:none;filter:none}.preview-crosshair i,.preview-crosshair b{position:absolute;display:block;background:var(--accent)}.preview-crosshair i{top:27px;left:0;width:56px;height:1px}.preview-crosshair b{top:0;left:27px;width:1px;height:56px}.preview-notice{position:absolute;left:12px;right:12px;top:12px;background:rgba(25,30,36,.9);color:var(--line);padding:10px 14px;border-radius:8px;font-size:14px;text-align:center;pointer-events:none}.preview-retry{pointer-events:auto;margin-left:12px;text-decoration:underline}.preview-empty{position:absolute;inset:0;background:#0f172a;color:var(--line);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:14px;text-align:center}.preview-empty strong{font-size:14px;font-weight:500}.preview-footer{padding:14px 20px;border:1px solid var(--panel);border-top:0;border-radius:8px;background:white;display:flex;justify-content:space-between;color:var(--muted);font-size:14px}.preview-panel{width:290px;flex-shrink:0;background:white;border-left:1px solid var(--panel);padding:14px 12px;overflow:auto}.preview-profiles{display:flex;gap:10px;margin-top:14px}.preview-profiles button{flex:1;background:white;border:1px solid var(--line);border-radius:8px;padding:12px 8px;color:var(--muted);font-size:14px}.preview-profiles button.active{border-color:var(--muted);background:var(--panel);color:var(--accent)}.preview-profiles small{display:block;margin-top:6px;font-size:14px;color:var(--muted)}
.compact .preview-main{padding:0}.compact .preview-toolbar,.compact .preview-footer{border-radius:8px;border-left:0;border-right:0}.compact .preview-toolbar{padding:12px 16px;gap:10px;border-top:0}.compact .preview-footer{padding:12px 16px}
@media(max-width:1000px){.preview-panel{width:250px;padding:14px 16px}.preview-main{padding:16px}.preview-toolbar{gap:12px;padding:16px}.preview-stats{margin-left:0}}
@media(max-width:760px){.preview-page{flex-direction:column}.preview-main{min-height:460px;padding:12px}.preview-screen{min-height:320px}.preview-panel{width:100%;border-left:0;border-top:1px solid var(--panel)}.preview-toolbar{font-size:14px}}
</style>
