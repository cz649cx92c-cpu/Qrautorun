import {z} from 'zod';
import {randomUUID} from 'node:crypto';
export const localizationSchema=z.object({
 stamp:z.number().finite().nonnegative(),state:z.enum(['STATIC_ANCHORED','WAITING','LOCAL_ONLY','FORMAL']),
 source:z.enum(['stationary_qr','synchronized_qr']).nullable(),stationary:z.boolean(),absoluteHeading:z.boolean(),
 poseAvailable:z.boolean(),navigationReady:z.boolean(),captureTimestampVerified:z.boolean(),
 mapId:z.string().max(200),mapVersion:z.number().int().positive().optional(),localEpoch:z.string().max(80),reason:z.string().max(2000),
 headingDeg:z.number().finite().min(-180).max(180).nullable(),
 positionSigmaM:z.number().finite().nonnegative().nullable().optional(),positionLimitM:z.number().finite().positive().optional(),
 covarianceCalibrated:z.boolean().optional(),approvalBasis:z.enum(['measurement','user_confirmation']).nullable().optional()
}).superRefine((value,ctx)=>{
 const reject=(message:string)=>ctx.addIssue({code:z.ZodIssueCode.custom,message});
 if(value.source==='stationary_qr'&&(value.navigationReady||value.captureTimestampVerified))reject('静止二维码定位不能声明运动同步或导航就绪');
 if(value.state==='STATIC_ANCHORED'&&!(value.source==='stationary_qr'&&value.stationary&&value.absoluteHeading&&value.poseAvailable&&value.mapId&&value.headingDeg!==null))reject('静止二维码定位状态或来源不一致');
 if(value.state==='FORMAL'&&value.source!=='synchronized_qr')reject('正式定位必须来自同步二维码定位');
 if(value.navigationReady&&!(value.state==='FORMAL'&&value.source==='synchronized_qr'&&value.captureTimestampVerified&&value.poseAvailable))reject('导航就绪必须使用正式同步定位');
});
export const executionDiagnosticsSchema=z.object({
 status:z.enum(['idle','live','held','unavailable']),reason:z.string().max(2000),sampledAt:z.number().finite(),
 taskId:z.string().max(80).optional(),mapId:z.string().max(200).optional(),mapVersion:z.number().int().positive().nullable().optional(),
 localEpoch:z.string().max(80).optional(),poseSource:z.literal('control_fused').optional(),controllerState:z.string().max(40).optional(),covarianceCalibrated:z.boolean().optional(),
 poseStamp:z.number().finite().optional(),poseAgeS:z.number().finite().nonnegative().optional(),
 pose:z.object({x:z.number().finite(),y:z.number().finite(),yaw:z.number().finite()}).optional(),
 segment:z.object({index:z.number().int().positive(),total:z.number().int().positive(),fromId:z.number().int(),toId:z.number().int(),
  mode:z.enum(['4t4d','crab']),direction:z.enum(['forward','reverse','lateral']),phase:z.string().max(40),leg:z.enum(['outbound','return'])}).optional(),
 measured:z.object({crossTrackM:z.number().finite(),headingErrorRad:z.number().finite(),headingReference:z.string().max(100),
  remainingM:z.number().finite().nonnegative(),endDistanceM:z.number().finite().nonnegative(),alongToEndM:z.number().finite(),sigmaM:z.number().finite().nonnegative()}).optional(),
 decision:z.object({stage:z.string().max(100),reason:z.string().max(2000),paused:z.boolean(),
  crossLimitM:z.number().finite().nonnegative().nullable(),headingLimitRad:z.number().finite().nonnegative().nullable(),
  boundaryRadiusM:z.number().finite().nonnegative().nullable(),boundaryDistanceM:z.number().finite().nonnegative().nullable(),boundaryTagId:z.number().int(),
  targetTagVisible:z.boolean(),stopped:z.boolean(),stopRequiredFrames:z.number().int().positive(),modeReady:z.boolean().nullable(),
  stopRemainingM:z.number().finite().nonnegative().nullable(),outcome:z.string().max(2000).optional()}).optional()
});
export const telemetrySchema=z.object({bootId:z.string().min(1).max(80),seq:z.number().int().nonnegative(),state:z.string().max(40),running:z.boolean(),paused:z.boolean(),rowId:z.string().max(80),pose:z.object({x:z.number().finite(),y:z.number().finite(),yaw:z.number().finite()}).nullable(),speed:z.number().finite(),wheelAngle:z.number().finite().nullable(),tagId:z.number().int().nullable(),chassis:z.object({connected:z.boolean(),feedback:z.record(z.unknown()).nullable()}),sensors:z.object({camera:z.string(),odom:z.string(),imu:z.string(),localization:z.string()}),conditions:z.array(z.object({id:z.string(),label:z.string(),ready:z.boolean()})).max(30),detector:z.object({connected:z.boolean(),ids:z.array(z.number().int().min(0).max(586)).max(587),groups:z.array(z.object({id:z.string().max(80),visible:z.number().int().nonnegative(),total:z.number().int().positive()})).max(587),positionReady:z.boolean(),reason:z.string().max(2000),processingMs:z.number().finite().nonnegative()}).optional(),localization:localizationSchema.optional(),markerTracking:z.object({visible:z.boolean(),lastSeenAgeS:z.number().finite().nonnegative().nullable(),withinTimeout:z.boolean(),timeoutS:z.number().finite().nonnegative()}).optional(),mapping:z.object({ready:z.boolean(),quality:z.enum(['draft','verified']),reason:z.string().max(2000),localEpoch:z.string().max(80),lateralSupported:z.boolean()}).optional(),group:z.object({id:z.string().max(80),visible:z.number().int().nonnegative(),total:z.number().int().positive(),uncertaintyM:z.number().finite().nonnegative(),degraded:z.boolean()}).nullable().optional(),events:z.array(z.string().max(1000)).max(100),cycleMs:z.number().nonnegative(),taskId:z.string().max(80).default(''),executionDiagnostics:executionDiagnosticsSchema.optional()});
export type CommandResult={id:string,type:string,created:number,ok:boolean|null,message:string,acknowledgedAt:number|null};
export class RobotLink {
 private commandResults=new Map<string,CommandResult>();
 private pruneResults(){const now=Date.now();for(const [id,result] of this.commandResults)if(now-result.created>=60_000)this.commandResults.delete(id);while(this.commandResults.size>128)this.commandResults.delete(this.commandResults.keys().next().value!);}
 commandResult(id:string){this.pruneResults();return this.commandResults.get(id)??null;}
 private telemetry:z.infer<typeof telemetrySchema>|null=null;private received=0;private commands:{id:string,type:string,payload:unknown,created:number}[]=[];
 update(raw:unknown){const t=telemetrySchema.parse(raw);if(this.telemetry?.bootId===t.bootId&&t.seq<=this.telemetry.seq)throw new Error('反馈序号未递增');this.telemetry=t;this.received=Date.now();}
 status(){
  const now=Date.now(),connected=now-this.received<1500;
  let pose=connected?this.telemetry?.pose??null:null;
  let localization=connected?this.telemetry?.localization??null:null;
  const sensors=connected?{...this.telemetry?.sensors}:{camera:'最后接入',odom:'等待ROS2',imu:'等待ROS2',localization:'未就绪'};
  if(localization){
   if(localization.state==='STATIC_ANCHORED'&&(!(0<=now-localization.stamp*1000&&now-localization.stamp*1000<=250)||now-this.received>250)){
    pose=null;localization={...localization,state:'WAITING',stationary:false,absoluteHeading:false,poseAvailable:false,navigationReady:false,headingDeg:null,reason:'静止定位已过期，等待新的二维码定位'};
    sensors.localization='静止定位已过期 / 等待二维码';
   }else if(!localization.poseAvailable||!(localization.state==='STATIC_ANCHORED'||localization.state==='FORMAL'||
     (localization.state==='LOCAL_ONLY'&&localization.source==='synchronized_qr'&&localization.captureTimestampVerified)))pose=null;
  }
  return {mode:'greenhouse',serverTimeMs:now,connected,state:connected?this.telemetry?.state??'IDLE':'OFFLINE',running:connected&&!!this.telemetry?.running,paused:connected&&!!this.telemetry?.paused,pose,localization,rowId:this.telemetry?.rowId??'',speed:connected?this.telemetry?.speed??0:0,wheelAngle:connected?this.telemetry?.wheelAngle??null:null,tagId:this.telemetry?.tagId??null,chassis:connected?this.telemetry?.chassis??{connected:false,feedback:null}:{connected:false,feedback:null},sensors,conditions:connected?this.telemetry?.conditions??[]:[{id:'bridge',label:'ROS2导航节点连接',ready:false}],detector:connected?this.telemetry?.detector??null:null,mapping:connected?this.telemetry?.mapping??null:null,group:connected?this.telemetry?.group??null:null,markerTracking:connected?this.telemetry?.markerTracking??null:null,events:this.telemetry?.events??[],cycleMs:this.telemetry?.cycleMs??0,taskId:this.telemetry?.taskId??'',executionDiagnostics:connected?this.telemetry?.executionDiagnostics??null:null,trail:[]};
 }

 enqueue(type:string,payload:unknown={}){if(type==='start'&&(this.status().running||this.commands.some(c=>c.type==='start')))throw new Error('已有运行中或待处理任务');if(type==='stop')this.commands=[];const command={id:randomUUID(),type,payload,created:Date.now()};this.commands.push(command);this.commandResults.set(command.id,{id:command.id,type,created:command.created,ok:null,message:'等待ROS2安全状态机确认',acknowledgedAt:null});this.pruneResults();return {accepted:true,commandId:command.id,state:'等待ROS2安全状态机确认'};}
 poll(){const now=Date.now();this.commands=this.commands.filter(c=>now-c.created<5000);return this.commands;}
 ack(id:string,ok?:boolean,message=''){
  this.commands=this.commands.filter(c=>c.id!==id);
  const result=this.commandResult(id);
  // Legacy ack(id) only removes the queue entry; it is not evidence of success.
  if(result&&result.ok===null&&typeof ok==='boolean')this.commandResults.set(id,{...result,ok,message,acknowledgedAt:Date.now()});
 }
}
