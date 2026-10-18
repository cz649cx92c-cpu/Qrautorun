import {z} from 'zod';
export const motionRecordSchema=z.object({stamp:z.number().finite().nonnegative(),seq:z.number().int().nonnegative(),receivedMonotonic:z.number().finite(),localEpoch:z.string().max(80),bodyGear:z.number().int(),steeringGear:z.number().int(),vx:z.number().finite(),vy:z.number().finite(),vyRaw:z.number().finite(),wz:z.number().finite(),feedbackAgeS:z.number().finite().min(0).max(.3),feedbackSource:z.literal('chassis_info_fb_aggregate')});
type Motion=z.infer<typeof motionRecordSchema>;
type Sample={stamp:number;pose:{x:number;y:number;yaw:number};localEpoch?:string;tags:{id:number;x:number;y:number;groupId?:string}[]};
// Receive-side state only: the mature controller already decodes paired raw
// feedback 5/6 as 4T4D and 7/8 as crab, gated by paired steering state. Body control commands remain exclusively 6/8.
export const recordedMotionMode=(r:Pick<Motion,'bodyGear'|'steeringGear'>)=>r.bodyGear===6||(r.bodyGear===5&&[5,6].includes(r.steeringGear))?'4t4d':r.bodyGear===8||(r.bodyGear===7&&r.steeringGear===7)?'crab':'unknown';
const wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a));
export function validateMotionSegments(samples:Sample[],records:Motion[]){
 const visits:{id:number;name:string;sample:Sample;distance:number;candidates:{sample:Sample;distance:number}[]}[]=[];
 for(const sample of samples){
  const sorted=[...sample.tags].sort((a,b)=>Math.hypot(a.x,a.y)-Math.hypot(b.x,b.y));
  let tag=sorted[0];if(!tag)continue;
  const last=visits.at(-1),same=sample.tags.find(t=>t.id===last?.id);
  if(same&&Math.hypot(same.x,same.y)<=Math.hypot(tag.x,tag.y)+.03)tag=same;
  const distance=Math.hypot(tag.x,tag.y);
  if(last?.id===tag.id){last.candidates.push({sample,distance});if(distance<last.distance){last.sample=sample;last.distance=distance;}}
  else visits.push({id:tag.id,name:tag.groupId??String(tag.id),sample,distance,candidates:[{sample,distance}]});
 }
 // A QR encounter can start before arrival and continue through a mode change.
 // Use a measured stop at that same visible QR as its interval boundary; closest
 // optical approach can occur while the incoming mode is still decelerating.
 const stops:Motion[][]=[];
 let run:Motion[]=[];
 const flush=()=>{if(run.length>=5&&run.at(-1)!.stamp-run[0]!.stamp>=.25)stops.push(run);run=[];};
 for(const r of records){
  const p=run.at(-1);
  if(Math.hypot(r.vx,r.vy)>.002||Math.abs(r.wz)>Math.PI/180*.1){flush();continue;}
  if(p&&(r.seq!==p.seq+1||r.stamp<=p.stamp||r.stamp-p.stamp>.050001||r.receivedMonotonic<=p.receivedMonotonic||r.localEpoch!==p.localEpoch))flush();
  run.push(r);
 }
 flush();
 const movingMode=(r:Motion)=>Math.hypot(r.vx,r.vy)>.01||Math.abs(r.wz)>.02;
 const handoffs=stops.filter(run=>{
  const first=records.indexOf(run[0]!),last=records.indexOf(run.at(-1)!);
  const before=records.slice(0,first).reverse().find(r=>movingMode(r)&&recordedMotionMode(r)!=='unknown');
  const after=records.slice(last+1).find(r=>movingMode(r)&&recordedMotionMode(r)!=='unknown');
  return before&&after&&recordedMotionMode(before)!==recordedMotionMode(after);
 });
 for(const visit of visits){
  const stopped=visit.candidates.filter(c=>c.distance<=.06&&handoffs.some(run=>run[0]!.localEpoch===c.sample.localEpoch&&c.sample.stamp>=run[0]!.stamp+.1&&c.sample.stamp<=run.at(-1)!.stamp-.1));
  if(stopped.length){const chosen=stopped.reduce((a,b)=>a.distance<=b.distance?a:b);visit.sample=chosen.sample;visit.distance=chosen.distance;}
 }
 const segments=visits.slice(1).map((to,index)=>{
  const from=visits[index]!,a=from.sample,b=to.sample;
  const selected=records.filter(r=>r.stamp>=a.stamp&&r.stamp<=b.stamp);
  // Retain raw records. A parking gear can precede its cleared speed cache by
  // one aggregate frame; only a tightly bounded, independently followed zero
  // snapshot qualifies. Do not classify it as a second/unknown drive mode.
  const parkingTransition=(r:Motion,i:number)=>{
   const p=selected[i-1],q=selected[i+1];
   return [0,1,2].includes(r.bodyGear)&&!!p&&!!q&&recordedMotionMode(p)!=='unknown'&&q.bodyGear===r.bodyGear
    &&r.stamp-p.stamp<=.050001&&q.stamp-r.stamp<=.050001&&r.stamp>p.stamp&&q.stamp>r.stamp
    &&Math.hypot(q.vx,q.vy)<=.002&&Math.abs(q.wz)<=Math.PI/180*.1;
  };
  const moving=selected.filter((r,i)=>(Math.hypot(r.vx,r.vy)>.01||Math.abs(r.wz)>.02)&&!parkingTransition(r,i));
  const modes=[...new Set(moving.map(r=>recordedMotionMode(r)))];
  const reasons:string[]=[];
  if(!records.length)return {fromId:from.id,toId:to.id,from:from.name,to:to.name,startStamp:a.stamp,endStamp:b.stamp,mode:null,status:'invalid',reasons:['旧记录没有连续档位，请重新录制'],feedbackCount:0,travelM:0,displacementErrorM:0,headingErrorDeg:0};
  if(!selected.length||!moving.length)reasons.push('缺少区间运动反馈');
  if(!a.localEpoch||!b.localEpoch||a.localEpoch!==b.localEpoch||selected.some(r=>!r.localEpoch||r.localEpoch!==a.localEpoch))reasons.push('定位原点缺失或发生重置');
  if(modes.includes('unknown'))reasons.push('运动期间出现未知档位');
  if(modes.includes('4t4d')&&modes.includes('crab'))reasons.push('同一二维码区间混用4T4D和平移');
  const boundaries=[a.stamp,...selected.map(r=>r.stamp),b.stamp];
  if(boundaries.some((t,i)=>i>0&&t-boundaries[i-1]!>.35))reasons.push('区间反馈断流超过0.35秒');
  if(selected.some((r,i)=>i>0&&(r.seq!==selected[i-1]!.seq+1||r.receivedMonotonic<=selected[i-1]!.receivedMonotonic||r.stamp<=selected[i-1]!.stamp)))reasons.push('反馈丢帧或序号、时间异常');
  if(moving.some(r=>recordedMotionMode(r)==='4t4d'&&Math.abs(r.vy)>Math.max(.02,Math.abs(r.vx)*.25)))reasons.push('4T4D档位与横向速度冲突');
  if(moving.some(r=>recordedMotionMode(r)==='crab'&&Math.abs(r.wz)>.08))reasons.push('平移档位与车体旋转冲突');
  let x=0,y=0,yaw=a.pose.yaw,travel=0;
  for(let i=1;i<selected.length;i++){
   const p=selected[i-1]!,q=selected[i]!,dt=q.stamp-p.stamp;if(dt<=0||dt>.35)continue;
   const vx=(p.vx+q.vx)/2,vy=(p.vy+q.vy)/2,w=(p.wz+q.wz)/2,mid=yaw+w*dt/2;
   x+=(vx*Math.cos(mid)-vy*Math.sin(mid))*dt;y+=(vx*Math.sin(mid)+vy*Math.cos(mid))*dt;yaw=wrap(yaw+w*dt);travel+=Math.hypot(vx,vy)*dt;
  }
  const dx=b.pose.x-a.pose.x,dy=b.pose.y-a.pose.y;
  const displacementErrorM=Math.hypot(dx-x,dy-y),headingErrorDeg=Math.abs(wrap(b.pose.yaw-yaw))*180/Math.PI;
  if(travel>.08&&Math.hypot(dx,dy)<.02)reasons.push('车辆已运动但轨迹位置未更新');
  if(displacementErrorM>Math.max(.12,travel*.3))reasons.push('档位速度积分与记录轨迹不一致');
  if(headingErrorDeg>12)reasons.push('底盘角速度与车头朝向不一致');
  const mode=modes.length===1&&modes[0]!=='unknown'?modes[0]:null;
  return {fromId:from.id,toId:to.id,from:from.name,to:to.name,startStamp:a.stamp,endStamp:b.stamp,mode,status:reasons.length?'invalid':'confirmed',reasons,feedbackCount:selected.length,travelM:travel,displacementErrorM,headingErrorDeg};
 });
 const reasons=segments.length?[]:['至少需要两个不同定位组才能生成自动路线'];
 return {recordCount:records.length,ready:segments.length>0&&segments.every(s=>s.status==='confirmed'),reasons,segments};
}
