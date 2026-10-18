<script setup lang="ts">
import {computed} from 'vue';
const props=defineProps<{status:any,mapId:string,version:number,taskId:string,nowMs:number,receivedMs:number,online:boolean}>();
const raw=computed(()=>props.status?.executionDiagnostics);
const contextMatches=computed(()=>!!raw.value&&raw.value.mapId===props.mapId&&raw.value.mapVersion===props.version&&raw.value.taskId===props.taskId&&raw.value.localEpoch===props.status?.localization?.localEpoch);
const current=computed(()=>{
 const d=raw.value;if(!props.online||!d||!contextMatches.value||!d.measured||!d.decision)return null;
 if(d.status==='held')return d;
 if(d.status!=='live')return null;
 const age=(props.status.serverTimeMs??0)-d.poseStamp*1000+Math.max(0,props.nowMs-props.receivedMs);
 return Number.isFinite(age)&&age>=0&&age<=250?d:null;
});
const label=computed(()=>current.value?.status==='held'?current.value.reason:current.value?.decision.paused?'已暂停':'实时');
const emptyReason=computed(()=>!props.online?'导航连接中断，等待实时数据':raw.value?.status==='idle'?'开始导航后显示当前执行区间的偏差':raw.value?.mapId&&!contextMatches.value?'执行任务、地图版本或定位原点与当前选择不一致':raw.value?.reason||'等待新鲜的控制位姿与区间数据');
const measured=computed(()=>current.value?.measured);const decision=computed(()=>current.value?.decision);
const cm=(value:unknown,signed=false)=>typeof value==='number'&&Number.isFinite(value)?(signed&&value>0?'+':'')+(value*100).toFixed(2)+' cm':'—';
const degrees=(value:unknown,signed=false)=>typeof value==='number'&&Number.isFinite(value)?(signed&&value>0?'+':'')+(value*180/Math.PI).toFixed(2)+'°':'—';
function group(id:unknown){return typeof id==='number'?'B'+String(id).padStart(3,'0'):'—';}
function time(value:unknown){return typeof value==='number'?new Date(value*1000).toLocaleTimeString('zh-CN',{hour12:false}):'—';}
const crossExceeded=computed(()=>decision.value?.crossLimitM!=null&&Math.abs(measured.value?.crossTrackM)>decision.value.crossLimitM);
const headingExceeded=computed(()=>decision.value?.headingLimitRad!=null&&Math.abs(measured.value?.headingErrorRad)>decision.value.headingLimitRad);
</script>
<template>
 <section class="execution-errors" aria-label="实时误差监控" data-testid="execution-errors">
  <div class="error-heading"><strong>实时误差</strong><span class="error-kind">执行偏差 · 基于定位估计</span><span v-if="current" class="sample-label">{{label}} · {{time(current.sampledAt)}}</span></div>
  <p v-if="current" class="segment-label">区间 {{current.segment.index}} / {{current.segment.total}} · {{group(current.segment.fromId)}} → {{group(current.segment.toId)}} · {{current.segment.mode==='crab'?'平移':current.segment.direction==='reverse'?'4T4D 倒车':'4T4D 前进'}} · {{current.segment.leg==='return'?'返程':'去程'}}</p>
  <p v-else class="empty-reason">{{emptyReason}}</p>
  <dl class="error-grid">
   <div :class="{exceeded:crossExceeded}"><dt>路径侧偏</dt><dd>{{cm(measured?.crossTrackM,true)}}</dd><small>沿行进方向：左＋ / 右－</small></div>
   <div :class="{exceeded:headingExceeded}"><dt>车头角偏差</dt><dd>{{degrees(measured?.headingErrorRad,true)}}</dd><small>{{measured?.headingReference||'相对当前执行目标朝向'}}</small></div>
   <div><dt>距区间终点</dt><dd>{{cm(measured?.endDistanceM)}}</dd><small>当前位置到终点的直线距离</small></div>
   <div><dt>沿路径剩余</dt><dd>{{cm(measured?.remainingM)}}</dd><small>用于减速和末端停车判定</small></div>
  </dl>
  <div class="decision-line"><strong>决策判定依据</strong><span>{{decision?.outcome||decision?.reason||'等待当前任务的判定数据'}}</span></div>
  <details class="error-details">
   <summary>查看判定阈值与定位来源</summary>
   <template v-if="current">
    <dl class="decision-grid">
     <div><dt>判定阶段</dt><dd>{{decision.stage}}</dd></div>
     <div><dt>侧偏阈值</dt><dd>{{cm(decision.crossLimitM)}}</dd></div>
     <div><dt>角度阈值</dt><dd>{{degrees(decision.headingLimitRad)}}</dd></div>
     <div><dt>边界距离 / 容差</dt><dd>{{cm(decision.boundaryDistanceM)}} / {{cm(decision.boundaryRadiusM)}}</dd></div>
     <div><dt>末端停车剩余阈值</dt><dd>{{cm(decision.stopRemainingM)}}</dd></div>
     <div><dt>当前目标码</dt><dd>{{group(decision.boundaryTagId)}} · {{decision.targetTagVisible?'已识别':'未识别'}}</dd></div>
     <div><dt>底盘停稳检查</dt><dd>{{decision.stopped?'速度达标':'尚未达标'}} · 需连续 {{decision.stopRequiredFrames}} 帧反馈</dd></div>
     <div><dt>区间模式确认</dt><dd>{{decision.modeReady===null?'当前阶段不检查':decision.modeReady?'已就绪':'待确认'}}</dd></div>
     <div><dt>沿程终点差</dt><dd>{{cm(measured.alongToEndM,true)}}（＋未到 / －越过）</dd></div>
     <div><dt>定位估计不确定度 σ</dt><dd>{{cm(measured.sigmaM)}} · {{current.covarianceCalibrated?'已标定':'未实测标定'}}</dd></div>
    </dl>
    <p>位姿来源：控制器正式融合位姿 · 样本位姿年龄 {{(current.poseAgeS*1000).toFixed(0)}} ms{{current.status==='held'?'（冻结快照）':''}}。</p>
   </template>
   <p>执行偏差是估计位置与录制路线的差；判定阈值是程序决定停车、换挡或继续的依据。定位不确定度不是实测物理误差，决策是否正确也需要实际位置作参照。</p>
  </details>
 </section>
</template>
<style scoped>
.execution-errors{flex-shrink:0;padding:14px 18px;border-bottom:1px solid var(--line);background:var(--background);color:var(--ink);font-size:13px}.error-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.error-heading>strong{font-size:14px;font-weight:600}.error-kind{color:var(--muted)}.sample-label{margin-left:auto;color:var(--muted);font-size:12px}.segment-label,.empty-reason{margin:7px 0 0;color:var(--muted);font-size:12px}.error-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:12px 0}.error-grid>div{min-width:0;padding-left:10px;border-left:2px solid var(--line)}.error-grid dt{color:var(--muted)}.error-grid dd{margin:5px 0;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--accent)}.error-grid small{display:block;color:var(--muted);font-size:11px;line-height:1.5}.error-grid .exceeded{border-color:var(--accent)}.error-grid .exceeded dd{color:var(--accent)}.decision-line{display:flex;gap:10px;align-items:baseline;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.decision-line strong{white-space:nowrap;font-weight:500}.decision-line span{color:var(--muted)}.error-details{margin-top:9px;color:var(--muted);font-size:12px;line-height:1.6}.error-details summary{cursor:pointer}.error-details p{margin:8px 0 0}.decision-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 18px;margin:10px 0}.decision-grid>div{display:flex;gap:8px;justify-content:space-between;border-bottom:1px solid var(--panel);padding-bottom:5px}.decision-grid dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}.decision-grid dt{flex-shrink:0;color:var(--muted)}
@media(max-width:760px){.execution-errors{padding:12px}.error-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 8px}.error-grid dd{font-size:14px}.sample-label{margin-left:0}.decision-grid{grid-template-columns:1fr}.decision-line{align-items:flex-start}}
</style>
