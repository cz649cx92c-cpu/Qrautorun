import {distance,type Point} from '../../shared/model';
// Circular fillets respect the existing chassis curvature limit (0.6 / m).
// Every board remains assigned; intermediate corners are rounded, never discarded.
export function officeRoute(waypoints:Point[],radius=1.72):Point[]{
 if(waypoints.length<2)throw new Error('路线至少需要两个定位点');
 const lengths=waypoints.slice(1).map((p,i)=>distance(p,waypoints[i]!));
 if(lengths.some(l=>l<.03))throw new Error('不同定位点间距不足3厘米，请检查扫描坐标');
 const corners=waypoints.map((b,i)=>{
  if(i===0||i===waypoints.length-1)return null;
  const a=waypoints[i-1]!,c=waypoints[i+1]!,l=lengths[i-1]!,m=lengths[i]!;
  const u={x:(b.x-a.x)/l,y:(b.y-a.y)/l},v={x:(c.x-b.x)/m,y:(c.y-b.y)/m};
  const angle=Math.atan2(u.x*v.y-u.y*v.x,u.x*v.x+u.y*v.y);
  if(Math.abs(angle)<1e-5)return null;
  if(Math.abs(angle)>Math.PI*.9)throw new Error('前进路线出现折返，请按单程方向采集');
  const cut=radius*Math.tan(Math.abs(angle)/2),sign=Math.sign(angle);
  const entry={x:b.x-u.x*cut,y:b.y-u.y*cut},exit={x:b.x+v.x*cut,y:b.y+v.y*cut};
  const center={x:entry.x-u.y*sign*radius,y:entry.y+u.x*sign*radius};
  return {cut,entry,exit,center,angle,start:Math.atan2(entry.y-center.y,entry.x-center.x)};
 });
 lengths.forEach((length,i)=>{if((corners[i]?.cut??0)+(corners[i+1]?.cut??0)>length-.01)throw new Error('相邻转弯间距不足以按现有转向能力连续前进；请调整路线，定位点不会被自动省略');});
 const points:Point[]=[{...waypoints[0]!}];
 const append=(p:Point)=>{if(distance(points.at(-1)!,p)>.0011)points.push(p);};
 const line=(to:Point)=>{const from=points.at(-1)!,n=Math.ceil(distance(from,to)/.03);for(let j=1;j<=n;j++)append({x:from.x+(to.x-from.x)*j/n,y:from.y+(to.y-from.y)*j/n});};
 for(let i=1;i<waypoints.length;i++){
  const corner=corners[i];if(!corner){line(waypoints[i]!);continue;}
  line(corner.entry);const n=Math.ceil(Math.abs(corner.angle)*radius/.03);
  for(let j=1;j<=n;j++){const a=corner.start+corner.angle*j/n;append({x:corner.center.x+radius*Math.cos(a),y:corner.center.y+radius*Math.sin(a)});}
 }
 if(points.length>1001)throw new Error('路线过长，请分成不超过30米的单程任务');
 return points;
}
