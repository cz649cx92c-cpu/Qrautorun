import trial from '../../../src/greenhouse_navigation/greenhouse_navigation/recorded_trial_limits.json';
import {type Point,type FieldMap} from '../../shared/model';
import {validateMotionSegments,motionRecordSchema} from './survey-motion';
import {z} from 'zod';
type Sample={stamp:number;pose:{x:number;y:number;yaw:number};localEpoch?:string;tags:{id:number;x:number;y:number;groupId?:string}[]};
type Motion=z.infer<typeof motionRecordSchema>;
type Result={tags:{id:number;x:number;y:number}[];poses:[number,number,number][]};
const wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a));
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
// Integrate the positive and negative areas separately, including zero crossings.
export function longitudinalTravel(records:Pick<Motion,'stamp'|'vx'>[]){
 let forwardM=0,reverseM=0;
 for(let i=1;i<records.length;i++){
  const p=records[i-1]!,q=records[i]!,dt=q.stamp-p.stamp;
  if(p.vx*q.vx<0){
   const split=Math.abs(p.vx)/(Math.abs(p.vx)+Math.abs(q.vx));
   const a=p.vx*dt*split/2,b=q.vx*dt*(1-split)/2;
   forwardM+=Math.max(a,0)+Math.max(b,0);reverseM-=Math.min(a,0)+Math.min(b,0);
  }else{
   const d=(p.vx+q.vx)*dt/2;forwardM+=Math.max(d,0);reverseM-=Math.min(d,0);
  }
 }
 return {forwardM,reverseM};
}
export function compileMotionSegments(result:Result,samples:Sample[],optimizedSamples:Sample[],records:Motion[]):NonNullable<FieldMap['motionSegments']>{
 const validation=validateMotionSegments(samples,records);
 if(!validation.ready)throw new Error('区间模式校验未通过，请查看扫描记录中的原因');
 if(result.poses.length!==optimizedSamples.length)throw new Error('优化轨迹与原始样本不匹配，请重新整理记录');
 const sampleAt=(stamp:number)=>samples.reduce((a,b)=>Math.abs(a.stamp-stamp)<=Math.abs(b.stamp-stamp)?a:b);
 const mapYaw=(sample:Sample)=>{let best=0;optimizedSamples.forEach((s,i)=>{if(Math.abs(s.stamp-sample.stamp)<Math.abs(optimizedSamples[best]!.stamp-sample.stamp))best=i;});return wrap(sample.pose.yaw+wrap(result.poses[best]![2]-optimizedSamples[best]!.pose.yaw));};
 return validation.segments.map((segment,index)=>{
  const a=sampleAt(segment.startStamp),b=sampleAt(segment.endStamp);
  const from={id:segment.fromId},to={id:segment.toId};
  const start=result.tags.find(t=>t.id===from.id),end=result.tags.find(t=>t.id===to.id);
  if(!start||!end||distance(start,end)<.08)throw new Error('区间端点缺失或距离不足8厘米');
  const selected=records.filter(r=>r.stamp>=segment.startStamp&&r.stamp<=segment.endStamp);
  const moving=selected.filter(r=>Math.hypot(r.vx,r.vy)>.01);
  const mode=segment.mode as '4t4d'|'crab',bodyYaw=mapYaw(a),endYaw=mapYaw(b);
  let direction:'forward'|'reverse'|'lateral'='lateral',wheelAngle=0;
  let points:Point[]=[];
  if(mode==='crab'){
   if(Math.abs(wrap(endYaw-bodyYaw))>.10)throw new Error('平移区间车头方向变化超过5.7度，请保持车头方向重新录制');
   const angle=wrap(Math.atan2(end.y-start.y,end.x-start.x)-bodyYaw);
   wheelAngle=angle*180/Math.PI;if(wheelAngle>90)wheelAngle-=180;if(wheelAngle< -90)wheelAngle+=180;
   const ux=(end.x-start.x)/distance(start,end),uy=(end.y-start.y)/distance(start,end);
   const wx=Math.cos(bodyYaw)*ux+Math.sin(bodyYaw)*uy,wy=-Math.sin(bodyYaw)*ux+Math.cos(bodyYaw)*uy;
   // Small measured alignment/stop corrections may reverse briefly. Preserve raw
   // data and bound cumulative opposing/off-axis travel instead of one sample.
   const along=selected.map(r=>({stamp:r.stamp,vx:r.vx*wx+r.vy*wy}));
   const {forwardM,reverseM}=longitudinalTravel(along);
   let offAxisM=0;
   for(let i=1;i<selected.length;i++){const p=selected[i-1]!,q=selected[i]!;offAxisM+=(Math.abs(-p.vx*wy+p.vy*wx)+Math.abs(-q.vx*wy+q.vy*wx))/2*(q.stamp-p.stamp);}
   if(forwardM-reverseM<.02||reverseM>trial.maxOpposedTravel||offAxisM>trial.maxOffAxisTravel)throw new Error('平移区间方向或横向偏移超限，请在二维码处停车后换向');
   const n=Math.max(2,Math.ceil(distance(start,end)/.03));points=Array.from({length:n+1},(_,i)=>({x:start.x+(end.x-start.x)*i/n,y:start.y+(end.y-start.y)*i/n}));
  }else{
   // Direction is a travelled-distance decision. Sub-resolution stop rebound
   // must not turn an otherwise continuous interval into a forward/reverse route.
   const rs=[...selected];if(rs[0]!.stamp>a.stamp)rs.unshift({...rs[0]!,stamp:a.stamp});if(rs.at(-1)!.stamp<b.stamp)rs.push({...rs.at(-1)!,stamp:b.stamp});
   const {forwardM,reverseM}=longitudinalTravel(rs);
   if(Math.abs(forwardM-reverseM)<.02||Math.min(forwardM,reverseM)>.015)throw new Error('4T4D区间前后换向，请将换向位置设为二维码边界');
   direction=forwardM>reverseM?'forward':'reverse';
   const trace:{x:number;y:number;travel:number}[]=[{x:start.x,y:start.y,travel:0}];
   let x=start.x,y=start.y,yaw=bodyYaw,travel=0;
   for(let i=1;i<rs.length;i++){
    const p=rs[i-1]!,q=rs[i]!,dt=q.stamp-p.stamp,vx=(p.vx+q.vx)/2,vy=(p.vy+q.vy)/2,w=(p.wz+q.wz)/2,mid=yaw+w*dt/2;
    x+=(vx*Math.cos(mid)-vy*Math.sin(mid))*dt;y+=(vx*Math.sin(mid)+vy*Math.cos(mid))*dt;yaw=wrap(yaw+w*dt);travel+=Math.hypot(vx,vy)*dt;
    trace.push({x,y,travel});
   }
   if(travel<.02)throw new Error('区间反馈运动距离不足');
   const correction={x:end.x-x,y:end.y-y};
   const adjusted=trace.map(p=>({x:p.x+correction.x*p.travel/travel,y:p.y+correction.y*p.travel/travel}));
   points=[{x:start.x,y:start.y}];
   adjusted.slice(1,-1).forEach(p=>{if(distance(points.at(-1)!,p)>=.03)points.push(p);});
   if(distance(points.at(-1)!,end)<.015&&points.length>1)points.pop();points.push({x:end.x,y:end.y});
   for(let i=1;i<points.length-1;i++){
    const p=points[i-1]!,q=points[i]!,r=points[i+1]!,turn=wrap(Math.atan2(r.y-q.y,r.x-q.x)-Math.atan2(q.y-p.y,q.x-p.x));
    if(Math.abs(turn)/(Math.max(.001,(distance(p,q)+distance(q,r))/2))>trial.maxCurvature)throw new Error('录制区间曲率超过低速试用范围');
   }
   const startTangent=Math.atan2(points[1]!.y-start.y,points[1]!.x-start.x),finishTangent=Math.atan2(end.y-points.at(-2)!.y,end.x-points.at(-2)!.x),offset=direction==='reverse'?Math.PI:0;
   if(Math.abs(wrap(bodyYaw-startTangent-offset))>.10||Math.abs(wrap(endYaw-finishTangent-offset))>.15)throw new Error('区间路径方向与记录车头方向不一致，请检查定位或重新录制');
  }
  if(points.length===2)points.splice(1,0,{x:(points[0]!.x+points[1]!.x)/2,y:(points[0]!.y+points[1]!.y)/2});
  return {id:'interval-'+(index+1),fromId:from.id,toId:to.id,mode,direction,executionProfile:trial.profile as 'recorded_slow_trial',bodyYaw,endYaw,wheelAngle,points};
 });
}
