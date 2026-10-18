import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {z} from 'zod';
import {boardSchema,type Board} from '../../shared/boards';
import {calibrationTargetSchema,type CalibrationTarget} from '../../shared/calibration-target';
import type {CameraPreview} from './camera';
const uuid=z.string().uuid();
const photoFile=z.string().regex(/^frame-(?:[0-9]{3}|[0-9a-f-]{36})\.jpg$/);
const sessionSchema=z.object({id:uuid,board:boardSchema.optional(),target:calibrationTargetSchema.optional(),createdAt:z.string(),samples:z.array(z.object({stamp:z.number(),width:z.number(),height:z.number(),file:photoFile})).max(40),physicalScaleConfirmed:z.boolean().default(false)});
type Session=z.infer<typeof sessionSchema>;
const defaultsSchema=z.object({target:calibrationTargetSchema});
const initialTarget:CalibrationTarget={type:'aprilgrid',rows:6,columns:6,tagSizeMm:22,gapMm:6.6,family:'auto',layoutMode:'auto',firstId:0,idOrder:'row-major'};
async function pythonResult(script:string,args:string[],input?:Buffer,timeoutMs=45000):Promise<any>{
 return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/python3',[script,...args],{env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'2'},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',failure:Error|undefined;
  const timer=setTimeout(()=>{failure=new Error('标定计算超时');child.kill('SIGKILL');},timeoutMs);
  child.stdout.on('data',c=>{stdout+=c;if(stdout.length>100000){failure=new Error('标定输出异常');child.kill('SIGKILL');}});
  child.stderr.on('data',c=>stderr=(stderr+c).slice(-2000));child.stdin.on('error',()=>{});
  child.once('error',e=>{clearTimeout(timer);reject(e);});
  child.once('close',code=>{clearTimeout(timer);if(failure){reject(failure);return;}try{const parsed=JSON.parse(stdout.trim());if(code!==0||!parsed.ok)throw new Error(parsed.error??stderr??'标定失败');resolve(parsed.result);}catch(e){reject(e);}});
  child.stdin.end(input);
 });
}
export const mountSchema=z.object({heightMm:z.number().finite().min(20).max(1000),forwardMm:z.number().finite().min(-1000).max(1000),leftMm:z.number().finite().min(-1000).max(1000),imageTopForward:z.literal(true),measured:z.literal(true)});
export class CameraCalibration {
 private active:string|null=null;private busy=false;
 constructor(private root:string,private camera:CameraPreview,private boards:()=>Board[]){const p=join(root,'logs/calibration/active.json');if(existsSync(p)){try{this.active=uuid.parse(JSON.parse(readFileSync(p,'utf8')).id);}catch{}}}
 private folder(id:string){return join(this.root,'logs/calibration',uuid.parse(id));}
 private read(){return this.active?sessionSchema.parse(JSON.parse(readFileSync(join(this.folder(this.active),'session.json'),'utf8'))):null;}
 private save(s:Session){const path=join(this.folder(s.id),'session.json');writeFileSync(path+'.tmp',JSON.stringify(s,null,2));renameSync(path+'.tmp',path);}
 private selected(id:string){uuid.parse(id);const s=this.read();if(!s||s.id!==id)throw Object.assign(new Error('标定采集已变化，请重新打开'),{statusCode:409});return s;}
 private sample(s:Session,file:string){photoFile.parse(file);const sample=s.samples.find(p=>p.file===file);if(!sample)throw Object.assign(new Error('照片已删除或不存在'),{statusCode:404});return sample;}
 private resolveTarget(raw:unknown){const target=calibrationTargetSchema.parse(raw);if(target.type!=='registered')return {target,board:undefined};const board=this.boards().find(b=>b.id===target.boardId);if(!board)throw new Error('请选择已打印的定位板');return {target,board:structuredClone(board)};}
 private readDefaults(){const path=join(this.root,'config/calibration_defaults.json');if(existsSync(path)){try{const data=defaultsSchema.parse(JSON.parse(readFileSync(path,'utf8')));return {target:this.resolveTarget(data.target).target};}catch{}}return {target:structuredClone(initialTarget)};}
 private rememberTarget(target:CalibrationTarget){const path=join(this.root,'config/calibration_defaults.json'),temporary=path+'.'+randomUUID()+'.tmp';mkdirSync(join(this.root,'config'),{recursive:true});try{writeFileSync(temporary,JSON.stringify({target},null,2));renameSync(temporary,path);}finally{rmSync(temporary,{force:true});}}
 defaults(raw:unknown){const {target}=this.resolveTarget(defaultsSchema.parse(raw).target);this.rememberTarget(target);return this.status();}
 status(){
  const s=this.read();const load=(name:string)=>{const p=join(this.root,'config',name);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;};
  const intrinsic=load('camera_calibration.json'),mount=load('camera_extrinsics.json');let analysis:any[]=[],review:any=null;
  if(s){const path=join(this.folder(s.id),'analysis.json'),reviewPath=join(this.folder(s.id),'review.json');if(existsSync(path))analysis=JSON.parse(readFileSync(path,'utf8'));if(existsSync(reviewPath))review=JSON.parse(readFileSync(reviewPath,'utf8'));}
  const current=!!s&&!!review&&JSON.stringify(review.files)===JSON.stringify(s.samples.map(p=>p.file));
  return {defaults:this.readDefaults(),session:s?{id:s.id,boardId:s.board?.id,target:s.target??{type:'registered',boardId:s.board?.id},sampleCount:s.samples.length,width:s.samples[0]?.width,height:s.samples[0]?.height,
   calibrationReview:review?{...review,current}:null,
   samples:s.samples.map(p=>{const found=analysis.find(a=>a.file===p.file);const detection=found?{...found}:undefined;if(detection&&!current)delete detection.reprojection;return {...p,detection};})}:null,busy:this.busy,
   intrinsics:intrinsic?{verified:intrinsic.calibrationVerified===true,rmsPixels:intrinsic.rmsPixels,trainingCount:intrinsic.trainingCount,validationCount:intrinsic.validationCount}:null,
   mount:mount?{heightMm:mount.translationM[2]*1000,forwardMm:mount.translationM[0]*1000,leftMm:mount.translationM[1]*1000,imageTopForward:true,verified:mount.extrinsicsVerified===true}:null};
 }

 photo(id:string,file:string){const s=this.selected(id);this.sample(s,file);return readFileSync(join(this.folder(s.id),file));}
 removePhoto(id:string,file:string){if(this.busy)throw new Error('标定正在计算');const s=this.selected(id);this.sample(s,file);s.samples=s.samples.filter(p=>p.file!==file);s.physicalScaleConfirmed=false;this.save(s);rmSync(join(this.folder(s.id),file),{force:true});return this.status();}
 clearPhotos(id:string){if(this.busy)throw new Error('标定正在计算');const s=this.selected(id),files=s.samples.map(p=>p.file);s.samples=[];s.physicalScaleConfirmed=false;this.save(s);for(const file of files)rmSync(join(this.folder(s.id),file),{force:true});return this.status();}
 start(raw:unknown){if(this.busy)throw new Error('标定正在计算');const request=z.object({boardId:z.string().optional(),target:calibrationTargetSchema.optional()}).parse(raw);const {target,board}=this.resolveTarget(request.target??{type:'registered',boardId:request.boardId});const id=randomUUID(),s:Session={id,board,target,createdAt:new Date().toISOString(),samples:[],physicalScaleConfirmed:false};mkdirSync(this.folder(id),{recursive:true});this.save(s);writeFileSync(join(this.root,'logs/calibration/active.json'),JSON.stringify({id}));this.active=id;this.rememberTarget(target);return this.status();}
 async probe(raw:unknown){if(this.busy)throw new Error('标定正在计算');const {target,board}=this.resolveTarget(z.object({target:calibrationTargetSchema}).parse(raw).target);const frame=this.camera.snapshot();this.busy=true;try{return await pythonResult(join(this.root,'scripts/probe_calibration_target.py'),[JSON.stringify({...target,board})],frame.jpeg,10000);}finally{this.busy=false;}}
 capture(){if(this.busy)throw new Error('标定正在计算');const s=this.read();if(!s)throw new Error('请先开始标定采集');if(s.samples.length>=40)throw new Error('最多采集40张照片');const frame=this.camera.snapshot(),previous=s.samples.at(-1);if(previous&&frame.stamp-previous.stamp<500)throw new Error('请移动或倾斜定位板后再采集');if(previous&&(previous.width!==frame.width||previous.height!==frame.height))throw new Error('分辨率已变化，请重新开始采集');const file='frame-'+randomUUID()+'.jpg';writeFileSync(join(this.folder(s.id),file),frame.jpeg);s.samples.push({stamp:frame.stamp,width:frame.width,height:frame.height,file});this.save(s);return this.status();}
 async solve(raw:unknown){if(this.busy)throw new Error('标定正在计算');z.object({physicalScaleConfirmed:z.literal(true)}).parse(raw);const s=this.read();if(!s||s.samples.length<16)throw new Error('请先采集至少16张不同位置和倾角的照片');s.physicalScaleConfirmed=true;this.save(s);const output=join(this.root,'config/camera_calibration.json');if(existsSync(output))copyFileSync(output,join(this.folder(s.id),'previous-calibration.json'));this.busy=true;
  try{await pythonResult(join(this.root,'scripts/calibrate_tag_board.py'),[this.folder(s.id),'--output',output]);}finally{this.busy=false;}return this.status();}
 mount(raw:unknown){const m=mountSchema.parse(raw);const data={parentFrame:'base_link',childFrame:'qr_camera_optical',translationM:[m.forwardMm/1000,m.leftMm/1000,m.heightMm/1000],quaternionXyzw:[Math.SQRT1_2,-Math.SQRT1_2,0,0],extrinsicsVerified:true,source:'用户填写并确认实测安装参数',measuredAt:new Date().toISOString(),baseDefinition:'平面导航：X前、Y左、Z=0地面；镜头竖直朝下，画面上方对应车头'};const path=join(this.root,'config/camera_extrinsics.json');if(existsSync(path))copyFileSync(path,path+'.previous');writeFileSync(path+'.tmp',JSON.stringify(data,null,2));renameSync(path+'.tmp',path);return this.status();}
}
