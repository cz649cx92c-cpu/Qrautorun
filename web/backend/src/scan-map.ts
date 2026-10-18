import {z} from 'zod';
import {distance,rule,mapSchema,groupsSchema,validate,type FieldMap,type Point} from '../../shared/model';
import {compileMotionSegments} from './segment-route';
import {officeRoute} from './office-route';
import type {Board} from '../../shared/boards';
const finite=z.number().finite().min(-10000).max(10000);
export const scanSettings=z.object({sessionId:z.string().min(1).max(80),name:z.string().min(1).max(100),tagSizeMm:z.number().min(20).max(150).default(80),rowWidth:z.number().min(.41).max(2),exitDistance:z.number().min(.5).max(10)});
const resultSchema=z.object({tags:z.array(z.object({id:z.number().int().min(0).max(586),x:finite,y:finite,angle:finite,count:z.number().int().positive(),residualM:z.number().nonnegative().finite()})).min(1).max(587),poses:z.array(z.tuple([finite,finite,finite])).min(3),rmsM:z.number().nonnegative().finite()});
type Recording={samples:Parameters<typeof compileMotionSegments>[1];optimizedSamples:Parameters<typeof compileMotionSegments>[2];records:Parameters<typeof compileMotionSegments>[3]};
// New recordings preserve the mode of every QR interval; old maps retain their route.
export function compileScan(raw:unknown,settings:z.infer<typeof scanSettings>,layouts:Board[]=[],observedOrder:number[]=[],recording?:Recording) {
 const result=resultSchema.parse(raw),boards=groupsSchema.parse(layouts),byId=new Map(boards.map(b=>[b.referenceId,b]));
 if(boards.length&&result.tags.some(t=>!byId.has(t.id)))throw new Error('扫描数据不是已注册的整组中心');
 if(result.tags.length<(recording?2:3))throw new Error(recording?'请至少扫描2个不同定位组':'请至少扫描3个不同定位组');
 if(result.rmsM>.03||result.tags.some(t=>t.residualM>.05))throw new Error('扫描观测残差偏大，请补扫或校准；内部残差不能代表实测精度');
 // Fallback for previously optimized records: project each center onto the measured trajectory.
 const progress=(tag:Point)=>{let along=0,best={distance:Infinity,progress:0};for(let i=1;i<result.poses.length;i++){
  const a=result.poses[i-1]!,b=result.poses[i]!,dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);if(length<1e-6)continue;
  const f=Math.max(0,Math.min(1,((tag.x-a[0])*dx+(tag.y-a[1])*dy)/(length*length))),d=Math.hypot(tag.x-a[0]-f*dx,tag.y-a[1]-f*dy);
  if(d<best.distance)best={distance:d,progress:along+f*length};along+=length;
 }return best.progress;};
 const ranks=new Map([...new Set(observedOrder)].map((id,i)=>[id,i]));
 const positions=new Map(result.tags.map(t=>[t.id,progress(t)]));
 const ordered=[...result.tags].sort((a,b)=>positions.get(a.id)!-positions.get(b.id)!||((ranks.get(a.id)??0)-(ranks.get(b.id)??0)));
 const motionSegments=recording?compileMotionSegments(result,recording.samples,recording.optimizedSamples,recording.records):undefined;
 const route=motionSegments?[motionSegments[0]!.points[0]!,...motionSegments.flatMap(s=>s.points.slice(1))]:officeRoute(ordered);
 if(route.length>1001)throw new Error('区间路径过长，请拆分录制');
 const mapId='scan-'+settings.sessionId.replaceAll('-',''),taskId='task-'+mapId,rowId='scan-route-1';
 const rows:FieldMap['rows']=[{id:rowId,name:ordered.map(t=>byId.get(t.id)?.id??'Q'+String(t.id).padStart(3,'0')).join(' → '),width:settings.rowWidth,exitDistance:settings.exitDistance,start:route[0]!,points:route.slice(1)}];
 const tags:FieldMap['tags']=ordered.map((t,i)=>{const board=byId.get(t.id);return {id:t.id,...(board?{groupId:board.id}:{}),rowId,x:t.x,y:t.y,angle:t.angle,size:board?board.sizeMm/1000:settings.tagSizeMm/1000,kind:i===0?'entry':i===ordered.length-1?'end':'waypoint',rules:[{...rule('LOCALIZE','FORWARD','forward'),task:taskId}]};});
 const xs=route.map(p=>p.x),ys=route.map(p=>p.y),minX=Math.min(...xs)-.5,maxX=Math.max(...xs)+.5,minY=Math.min(...ys)-.5,maxY=Math.max(...ys)+.5;
 const map=mapSchema.parse({schemaVersion:1,id:mapId,name:settings.name,frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',routeMode:'waypoints',rows,tags,...(motionSegments?{motionSegments}:{}),...(boards.length?{groups:boards.filter(b=>tags.some(t=>t.id===b.referenceId))}:{}),order:[rowId],zone:[{x:minX,y:minY},{x:maxX,y:minY},{x:maxX,y:maxY},{x:minX,y:maxY}],vehicle:{width:.4,length:.8,margin:.05},notes:motionSegments?'按二维码区间执行：到码停稳，确认下一段档位和轮角；平移保持录制车头方向，4T4D按录制前进或倒车轨迹跟踪。内部残差不代表实测导航精度。':'办公室单程前进测试：按定位板观测顺序连接全部定位点，转弯按现有底盘曲率上限平滑连接；中间定位板仅校正，不停车、不倒车、不换行。内部观测残差不代表实际导航精度。'});
 const check=validate(map);if(check.errors.length)throw new Error('路线无法连接：'+check.errors.join('；'));
 const task={id:taskId,name:settings.name+'任务',mapId,mapVersion:1,rowOrder:map.order,forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true};
 return {map,task,validation:check};
}
