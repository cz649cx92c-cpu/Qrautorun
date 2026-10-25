import {spawn,type ChildProcess} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
interface PreviewSocket {
 readyState:number;bufferedAmount:number;
 send(data:string|Buffer,options?:{binary:boolean}):void;
 close(code?:number,reason?:string):void;
 on(event:'message',listener:(data:Buffer)=>void):unknown;
 on(event:'close'|'error',listener:()=>void):unknown;
}
const configSchema=z.object({device:z.string().startsWith('/dev/v4l/by-id/'),vendor:z.string().regex(/^[0-9a-f]{4}$/),product:z.string().regex(/^[0-9a-f]{4}$/),name:z.string(),defaultProfile:z.string(),profiles:z.array(z.object({id:z.string(),label:z.string(),width:z.number().int().positive(),height:z.number().int().positive(),fps:z.number().int().min(1).max(60)})).min(1),rotate:z.union([z.literal(0),z.literal(180)]).default(0)});
export const cameraPreviewConfigSchema=configSchema;
// 180° = horizontal + vertical flip. Only 0/180 keeps width/height, FPS, camera
// calibration and extrinsics untouched; other angles would change the frame size.
export function cameraVideoOptions(rotate:number):string[]{
 if(rotate===180)return ['-vf','hflip,vflip','-c:v','mjpeg','-q:v','2'];
 if(rotate===0)return ['-c:v','copy'];
 throw new Error('相机方向仅支持 0 或 180 度');
}
type Peer={socket:PreviewSocket,inFlight:number|null,sentAt:number,last:number,minIntervalMs:number};
// Only browser peers explicitly request pacing; camera_stream consumers retain full rate.
export const PREVIEW_ACK_TIMEOUT_MS=10000;
// FFmpeg mpjpeg 自带 Content-Length；按长度分帧，避免 JPEG 内嵌缩略图标记造成误切分。
export class MultipartJpegParser {
 private buffer=Buffer.alloc(0);private length:number|null=null;
 constructor(private frame:(jpeg:Buffer)=>void){}
 push(chunk:Buffer){
  this.buffer=Buffer.concat([this.buffer,chunk]);
  if(this.buffer.length>4*1024*1024)throw new Error('摄像头帧超出大小限制');
  for(;;){
   if(this.length===null){const end=this.buffer.indexOf('\r\n\r\n');if(end<0){if(this.buffer.length>4096)throw new Error('摄像头视频帧头无效');return;}const match=/content-length:\s*(\d+)/i.exec(this.buffer.subarray(0,end).toString('ascii'));if(!match)throw new Error('摄像头视频帧缺少长度');this.length=Number(match[1]);if(this.length<4||this.length>4*1024*1024)throw new Error('摄像头视频帧长度无效');this.buffer=this.buffer.subarray(end+4);}
   if(this.buffer.length<this.length)return;
   const jpeg=this.buffer.subarray(0,this.length);this.buffer=this.buffer.subarray(this.length);this.length=null;
   if(jpeg[0]!==255||jpeg[1]!==216)throw new Error('摄像头图像格式无效');
   this.frame(jpeg);
  }
 }
}
export function framePacket(jpeg:Buffer,sequence:number,stamp:number,width:number,height:number){const header=Buffer.alloc(16);header.writeUInt32BE(sequence,0);header.writeDoubleBE(stamp,4);header.writeUInt16BE(width,12);header.writeUInt16BE(height,14);return Buffer.concat([header,jpeg]);}
export class CameraPreview {
 private config:z.infer<typeof configSchema>;
 private peers=new Set<Peer>();private process:ChildProcess|null=null;private closing:Promise<void>|null=null;
 private latest:Buffer|null=null;private sequence=0;private frameAt=0;private startedAt=0;private frames:number[]=[];private error='';private starting=false;private disposed=false;
 private timer:ReturnType<typeof setInterval>;private serial=Promise.resolve();
 private profile:string;
 constructor(root:string){this.config=configSchema.parse(JSON.parse(readFileSync(join(root,'config/camera_preview.json'),'utf8')));this.profile=this.config.defaultProfile;this.timer=setInterval(()=>this.tick(),1000);}
 private selected(){return this.config.profiles.find(p=>p.id===this.profile)!;}
 private identity(){
  try{const target=realpathSync(this.config.device);if(!/^\/dev\/video\d+$/.test(target))return false;let dir=realpathSync('/sys/class/video4linux/'+target.split('/').at(-1)+'/device');for(let n=0;n<12;n++){try{if(readFileSync(join(dir,'idVendor'),'utf8').trim()===this.config.vendor&&readFileSync(join(dir,'idProduct'),'utf8').trim()===this.config.product)return true;}catch{}const parent=join(dir,'..');const next=realpathSync(parent);if(next===dir)break;dir=next;}return false;}catch{return false;}
 }
 status(){const now=Date.now();this.frames=this.frames.filter(t=>now-t<2000);return {type:'camera',name:this.config.name,present:this.identity(),running:!!this.process&&now-this.frameAt<1500&&this.frameAt>0,starting:this.starting,error:this.error,profile:this.profile,profiles:this.config.profiles,fps:this.frames.length>1?Math.round((this.frames.length-1)*10000/(this.frames.at(-1)!-this.frames[0]!))/10:0,frameAgeMs:this.frameAt?now-this.frameAt:null,viewers:this.peers.size};}
 snapshot(){if(!this.latest||Date.now()-this.frameAt>250)throw new Error('请先打开实时画面，等待摄像头出图');return {sequence:this.latest.readUInt32BE(0),stamp:this.latest.readDoubleBE(4),width:this.latest.readUInt16BE(12),height:this.latest.readUInt16BE(14),jpeg:Buffer.from(this.latest.subarray(16))};}
 private sendStatus(peer:Peer){if(peer.socket.readyState===1)peer.socket.send(JSON.stringify(this.status()));}
 private offer(peer:Peer){if(!this.latest||Date.now()-this.frameAt>250||peer.inFlight!==null||peer.last===this.sequence||peer.socket.readyState!==1||peer.socket.bufferedAmount>0||Date.now()-peer.sentAt<peer.minIntervalMs)return;peer.inFlight=this.sequence;peer.last=this.sequence;peer.sentAt=Date.now();peer.socket.send(this.latest,{binary:true});}
 add(socket:PreviewSocket){const peer:Peer={socket,inFlight:null,sentAt:0,last:-1,minIntervalMs:0};this.peers.add(peer);this.sendStatus(peer);socket.on('message',raw=>{if(raw.length>4096)return;try{const msg=JSON.parse(raw.toString());if(msg.type==='ack'&&msg.sequence===peer.inFlight){peer.inFlight=null;this.offer(peer);}else if(msg.type==='preview'&&typeof msg.maxFps==='number'&&Number.isFinite(msg.maxFps)){peer.minIntervalMs=1000/Math.max(1,Math.min(30,msg.maxFps));}else if(msg.type==='ping'&&typeof msg.at==='number'){socket.send(JSON.stringify({type:'pong',at:msg.at,serverAt:Date.now()}));}else if(msg.type==='restart'){void this.restart();}}catch{}});socket.on('close',()=>{this.peers.delete(peer);if(!this.peers.size)void this.stop();});socket.on('error',()=>socket.close());void this.start();}
 private async start(){
  if(this.closing)await this.closing;
  if(this.disposed||this.process||!this.peers.size)return;
  this.error='';if(!this.identity()){this.error='HBVCAM 未连接';for(const p of this.peers)this.sendStatus(p);return;}
  this.starting=true;this.startedAt=Date.now();this.latest=null;this.frameAt=0;this.frames=[];for(const p of this.peers){p.inFlight=null;p.last=-1;}
  const profile=this.selected();
  const child=spawn('/usr/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','warning','-f','v4l2','-input_format','mjpeg','-video_size',`${profile.width}x${profile.height}`,'-framerate',String(profile.fps),'-i',this.config.device,'-an',...cameraVideoOptions(this.config.rotate),'-f','mpjpeg','-boundary_tag','qrframe','-flush_packets','1','pipe:1'],{stdio:['ignore','pipe','pipe']});this.process=child;
  let stderr='';const parser=new MultipartJpegParser(jpeg=>{if(this.process!==child)return;this.sequence=(this.sequence+1)>>>0;this.frameAt=Date.now();this.frames.push(this.frameAt);this.starting=false;this.latest=framePacket(jpeg,this.sequence,this.frameAt,profile.width,profile.height);for(const p of this.peers)this.offer(p);});
  child.stderr!.on('data',data=>{stderr=(stderr+data.toString()).slice(-3000);});
  child.stdout!.on('data',data=>{try{parser.push(data);}catch(e){this.error=(e as Error).message;void this.stop();}});
  child.on('error',e=>{this.error='无法启动摄像头：'+e.message;});
  child.on('close',()=>{if(this.process!==child)return;this.process=null;this.starting=false;this.latest=null;if(!this.error)this.error=/No space left on device/.test(stderr)?'USB 带宽不足，请将 HBVCAM 接到独立 USB 接口':/busy/i.test(stderr)?'HBVCAM 正被其他程序占用':'摄像头采集中断，请重新连接';for(const p of this.peers)this.sendStatus(p);});
 }
 private tick(){if(this.process&&((this.starting&&Date.now()-this.startedAt>5000)||(this.frameAt&&Date.now()-this.frameAt>3000))){this.error='摄像头未持续输出画面，请重新连接';void this.stop();}for(const peer of this.peers){if(peer.inFlight!==null&&Date.now()-peer.sentAt>PREVIEW_ACK_TIMEOUT_MS){peer.socket.close(4000,'preview too slow');continue;}this.sendStatus(peer);}}
 private async stop(){
  if(this.closing)return this.closing;
  const child=this.process;if(!child)return;this.process=null;this.starting=false;this.latest=null;this.frameAt=0;this.frames=[];
  this.closing=new Promise<void>(resolve=>{const kill=setTimeout(()=>child.kill('SIGKILL'),1500);child.once('close',()=>{clearTimeout(kill);resolve();});child.kill('SIGTERM');});
  try{await this.closing;}finally{this.closing=null;}
 }
 private async restart(){await this.stop();await this.start();}
 setProfile(id:string){if(!this.config.profiles.some(p=>p.id===id))throw new Error('预览规格不存在');const update=this.serial.then(async()=>{this.profile=id;await this.restart();return this.status();});this.serial=update.then(()=>{},()=>{});return update;}
 async close(){this.disposed=true;clearInterval(this.timer);for(const p of this.peers)p.socket.close();await this.stop();}
}
