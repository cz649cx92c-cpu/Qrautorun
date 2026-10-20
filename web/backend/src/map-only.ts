import {z} from 'zod';
import {groupsSchema,mapSchema,validate} from '../../shared/model';
import {sampleSchema,optimizeSurvey,optimizationSamples,type getSurvey} from './survey';
export const mapOnlyRequestSchema=z.object({sessionId:z.string().min(1).max(80),baseVersion:z.number().int().nonnegative(),rebuild:z.boolean().default(false),name:z.string().trim().min(1).max(100).optional(),tagSizeMm:z.number().finite().min(20).max(180).default(80)}).strict();
const finite=z.number().finite().min(-10000).max(10000);
const optimizedPointSchema=z.object({tags:z.array(z.object({id:z.number().int().min(0).max(586),x:finite,y:finite,angle:finite,count:z.number().int().positive(),residualM:z.number().finite().nonnegative()})).min(1).max(587),poses:z.array(z.tuple([finite,finite,finite])).min(3).max(500),rmsM:z.number().finite().nonnegative()});
// Optimize observation geometry independently of automatic routes and motion gates.
export function surveyPointMap(session:ReturnType<typeof getSurvey>,options:{name?:string;tagSizeMm:number},geometry?:unknown){
 const samples=z.array(sampleSchema).min(1,'尚无定位组观测').max(10000).parse(session.samples),boards=groupsSchema.parse(session.boards),first=samples[0];
 const estimates=new Map<number,{x:number;y:number;sin:number;cos:number;count:number;points:{x:number;y:number}[]}>();
 for(const sample of samples){
  if((sample.localEpoch===first.localEpoch&&sample.quality===first.quality)===false)throw new Error('记录定位原点或采集质量不一致');
  const c=Math.cos(sample.pose.yaw),s=Math.sin(sample.pose.yaw);
  for(const t of sample.tags){
   const board=boards.find(b=>b.referenceId===t.id);
   if(boards.length){
    const snapshot=sample.groupLayouts?.find(b=>b.id===t.groupId);
    if(board===undefined||sample.representation==='board-centers'===false||t.groupId===board.id===false||JSON.stringify(snapshot)===JSON.stringify(board)===false)throw new Error('观测定位组布局与扫描记录不一致');
    const members=t.memberIds??[];
    if(members.length===0||new Set(members).size===members.length===false||t.visibleCount===members.length===false||members.some(id=>board.members.some(m=>m.id===id)===false))throw new Error('观测子码与定位组成员不符');
    const penalty=Math.max(members.length===1?1.5:1,Math.sqrt(board.members.length/members.length));
    if(t.sigma+1e-7<.01*penalty||(t.size===undefined?false:Math.abs(t.size-board.sizeMm/1000)>1e-9))throw new Error('定位组尺寸或不确定度无效');
   }else if(t.groupId)throw new Error('扫描缺少定位组定义');
   const x=sample.pose.x+c*t.x-s*t.y,y=sample.pose.y+s*t.x+c*t.y,angle=sample.pose.yaw+t.angle;
   const p=estimates.get(t.id)??{x:0,y:0,sin:0,cos:0,count:0,points:[]};p.x+=x;p.y+=y;p.sin+=Math.sin(angle);p.cos+=Math.cos(angle);p.count++;p.points.push({x,y});estimates.set(t.id,p);
  }
 }
 if(estimates.size===0)throw new Error('尚无有效定位组观测');
 const optimized=geometry===undefined?undefined:optimizedPointSchema.parse(geometry);
 if(optimized){
  const ids=new Set(optimized.tags.map(t=>t.id));
  if(ids.size!==optimized.tags.length||ids.size!==estimates.size||optimized.tags.some(t=>!estimates.has(t.id)))throw new Error("整理结果定位组与原始记录不一致");
  if(optimized.rmsM>.03||optimized.tags.some(t=>t.residualM>.05))throw new Error("整理观测残差超限，请补扫或校准；原始记录已保留");
 }
 // Without a usable anchor the solver fixes its first pose at zero. Restore that
 // gauge into the capture frame; this rigid transform never changes distances.
 const anchored=session.anchors.some((a:{id:number})=>estimates.has(a.id));
 const yaw=anchored?0:first.pose.yaw,c=Math.cos(yaw),s=Math.sin(yaw),origin=anchored?{x:0,y:0}:first.pose;
 let sumSq=0,count=0;
 const tags=[...estimates].map(([id,p])=>{
  const solved=optimized?.tags.find(t=>t.id===id);
  const x=solved?origin.x+c*solved.x-s*solved.y:p.x/p.count,y=solved?origin.y+s*solved.x+c*solved.y:p.y/p.count;
  const angle=solved?Math.atan2(Math.sin(solved.angle*Math.PI/180+yaw),Math.cos(solved.angle*Math.PI/180+yaw))*180/Math.PI:Math.atan2(p.sin,p.cos)*180/Math.PI;
  if(Math.hypot(p.sin,p.cos)/p.count<.7)throw new Error('定位组朝向观测不一致');
  if(!optimized)for(const q of p.points){const residual=Math.hypot(q.x-x,q.y-y);if(residual>.05)throw new Error('定位组观测残差超过5cm，请补扫或校准');sumSq+=residual*residual;count++;}
  const board=boards.find(b=>b.referenceId===id);
  return {id,x,y,angle,size:board?board.sizeMm/1000:options.tagSizeMm/1000,...(board?{groupId:board.id}:{}),rowId:'',kind:'waypoint',rules:[]};
 });
 if(!optimized&&Math.sqrt(sumSq/count)>.03)throw new Error('定位组观测均方根残差超过3cm');
 const xs=tags.map(t=>t.x),ys=tags.map(t=>t.y),minX=Math.min(...xs)-.5,maxX=Math.max(...xs)+.5,minY=Math.min(...ys)-.5,maxY=Math.max(...ys)+.5;
 const map=mapSchema.parse({schemaVersion:1,id:'scan-'+session.id.replaceAll('-',''),name:options.name??session.name,frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',captureQuality:first.quality,routeMode:'map-only',rows:[],order:[],tags,groups:boards,zone:[{x:minX,y:minY},{x:maxX,y:minY},{x:maxX,y:maxY},{x:minX,y:maxY}],vehicle:{width:.4,length:.8,margin:.05},notes:(optimized?'已依据同步观测联合整理点位；':'')+'已保存定位码位置、朝向及布局；扫描轨迹仅供诊断，导航路径请另行手动编辑。范围为显示边界，内部残差不代表实测精度。'});
 const validation=validate(map);if(validation.errors.length)throw new Error(validation.errors.join('；'));return map;
}

export async function createSurveyPointMap(root:string,session:ReturnType<typeof getSurvey>,options:{name?:string;tagSizeMm:number}){
 const samples=optimizationSamples(session.samples);
 if(samples.length<3)return surveyPointMap(session,options);
 const result=optimizedPointSchema.parse(await optimizeSurvey(root,{samples,anchors:session.anchors}));
 const counts=new Map<number,number>();for(const sample of samples)for(const tag of sample.tags)counts.set(tag.id,(counts.get(tag.id)??0)+1);
 if(result.poses.length!==samples.length||result.tags.length!==counts.size||result.tags.some(t=>t.count!==counts.get(t.id)))throw new Error("整理结果与本次观测数量不一致，原始记录已保留");
 return surveyPointMap(session,options,result);
}
