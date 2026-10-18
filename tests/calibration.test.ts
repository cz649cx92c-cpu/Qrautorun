import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CameraCalibration} from '../web/backend/src/calibration';
import type {CameraPreview} from '../web/backend/src/camera';
import {generateBoards} from '../web/shared/boards';
import {calibrationTargetSchema} from '../web/shared/calibration-target';

test('相机标定：真实帧保存、重复/规格拦截、独立目录恢复、安装实测门禁与毫米换算',async()=>{
 const root=mkdtempSync(join(tmpdir(),'qr-calibration-'));mkdirSync(join(root,'config'));
 let stamp=1700000000000,width=1280;
 const camera={snapshot:()=>({stamp,width,height:720,sequence:1,jpeg:Buffer.from([255,216,4,5,255,217])})} as unknown as CameraPreview;
 const boards=generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:16});
 try{
  const calibration=new CameraCalibration(root,camera,()=>boards);
  assert.throws(()=>calibration.start({boardId:'../../bad'}));
  calibration.start({boardId:'B016'});let status=calibration.capture();assert.equal(status.session?.sampleCount,1);
  const id=status.session!.id;assert.deepEqual(readFileSync(join(root,'logs/calibration',id,status.session!.samples[0]!.file)),camera.snapshot().jpeg);
  assert.throws(()=>calibration.capture(),/移动或倾斜/);stamp+=1000;width=640;assert.throws(()=>calibration.capture(),/分辨率/);width=1280;calibration.capture();
  const reloaded=new CameraCalibration(root,camera,()=>boards);assert.equal(reloaded.status().session?.sampleCount,2);
  await assert.rejects(()=>reloaded.solve({physicalScaleConfirmed:true}),/16张/);
  assert.throws(()=>reloaded.mount({heightMm:140,forwardMm:20,leftMm:-30,imageTopForward:true,measured:false}));
  reloaded.mount({heightMm:140,forwardMm:20,leftMm:-30,imageTopForward:true,measured:true});
  const mount=JSON.parse(readFileSync(join(root,'config/camera_extrinsics.json'),'utf8'));
  assert.deepEqual(mount.translationM,[.02,-.03,.14]);assert.equal(mount.extrinsicsVerified,true);
  assert.deepEqual(mount.quaternionXyzw,[Math.SQRT1_2,-Math.SQRT1_2,0,0]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('6×6专用AprilGrid：独立规格、码族容量校验、会话恢复与棋盘格选择',()=>{
 const root=mkdtempSync(join(tmpdir(),'qr-calibration-target-'));mkdirSync(join(root,'config'));
 const camera={snapshot:()=>({stamp:1700000000000,width:1280,height:720,sequence:1,jpeg:Buffer.from([255,216,4,5,255,217])})} as unknown as CameraPreview;
 const dedicated={type:'aprilgrid' as const,rows:6,columns:6,tagSizeMm:25,gapMm:7.5,family:'auto' as const,layoutMode:'manual' as const,firstId:0,idOrder:'row-major' as const};
 try{
  const calibration=new CameraCalibration(root,camera,()=>[]);
  const status=calibration.start({target:dedicated});assert.deepEqual(status.session?.target,dedicated);assert.equal(status.session?.boardId,undefined);
  const folder=join(root,'logs/calibration',status.session!.id);
  const saved=JSON.parse(readFileSync(join(folder,'session.json'),'utf8'));assert.equal(saved.board,undefined);assert.equal(saved.physicalScaleConfirmed,false);
  assert.equal(new CameraCalibration(root,camera,()=>[]).status().session?.target.type,'aprilgrid');
  assert.equal(calibration.capture().session?.sampleCount,1);
  for(const change of [{tagSizeMm:0},{gapMm:0},{family:'tag25h9'},{firstId:2320},{firstId:2300},{rows:13}])assert.equal(calibrationTargetSchema.safeParse({...dedicated,...change}).success,false);
  assert.equal(calibrationTargetSchema.safeParse({...dedicated,family:'tag36h10',firstId:2000}).success,true);
  const automatic=calibrationTargetSchema.parse({type:'aprilgrid',rows:6,columns:6,tagSizeMm:22,gapMm:6.4,family:'auto',layoutMode:'auto'});
  assert.equal(automatic.type,'aprilgrid');assert.deepEqual(calibration.start({target:automatic}).session?.target,automatic);
  assert.equal(new CameraCalibration(root,camera,()=>[]).status().session?.target.type,'aprilgrid');
  const checker={type:'checkerboard',columns:5,rows:5,squareSizeMm:20};
  assert.deepEqual(calibration.start({target:checker}).session?.target,checker);
  assert.equal(calibrationTargetSchema.safeParse({...checker,rows:2}).success,false);
  assert.equal(existsSync(join(root,'config/camera_calibration.json')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('标定照片：预览、单张删除、删除后采集不覆盖、持久化、清空与路径保护',()=>{
 const root=mkdtempSync(join(tmpdir(),'qr-calibration-photos-'));mkdirSync(join(root,'config'));
 let stamp=1700000000000;
 const camera={snapshot:()=>({stamp,width:1280,height:720,sequence:1,jpeg:Buffer.from([255,216,stamp%251,255,217])})} as unknown as CameraPreview;
 const boards=generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:16});
 try{
  const calibration=new CameraCalibration(root,camera,()=>boards);calibration.start({boardId:'B016'});
  calibration.capture();stamp+=1000;calibration.capture();stamp+=1000;const before=calibration.capture().session!;
  const first=before.samples[0]!,middle=before.samples[1]!,last=before.samples[2]!,folder=join(root,'logs/calibration',before.id);
  const lastBytes=calibration.photo(before.id,last.file);
  assert.throws(()=>calibration.photo(before.id,'../../config/camera_extrinsics.json'));
  assert.throws(()=>calibration.removePhoto(before.id,'frame-999.jpg'),/不存在/);
  assert.equal(calibration.status().session?.sampleCount,3);
  const after=calibration.removePhoto(before.id,middle.file).session!;
  assert.equal(after.sampleCount,2);assert.equal(existsSync(join(folder,middle.file)),false);
  assert.throws(()=>calibration.photo(before.id,middle.file),/已删除/);
  stamp+=1000;const captured=calibration.capture().session!;
  assert.equal(captured.sampleCount,3);assert.equal(new Set(captured.samples.map(p=>p.file)).size,3);
  assert.deepEqual(calibration.photo(before.id,last.file),lastBytes);
  const reloaded=new CameraCalibration(root,camera,()=>boards);assert.equal(reloaded.status().session?.sampleCount,3);
  const saved=JSON.parse(readFileSync(join(folder,'session.json'),'utf8'));assert.equal(saved.samples.some((p:{file:string})=>p.file===middle.file),false);
  writeFileSync(join(root,'config/camera_calibration.json'),JSON.stringify({calibrationVerified:true,rmsPixels:.5}));
  (reloaded as any).busy=true;assert.throws(()=>reloaded.clearPhotos(before.id),/正在计算/);assert.throws(()=>reloaded.removePhoto(before.id,first.file),/正在计算/);(reloaded as any).busy=false;
  assert.equal(reloaded.clearPhotos(before.id).session?.sampleCount,0);
  for(const p of captured.samples)assert.equal(existsSync(join(folder,p.file)),false);
  assert.equal(reloaded.status().intrinsics?.verified,true);assert.equal(new CameraCalibration(root,camera,()=>boards).status().session?.sampleCount,0);
  reloaded.start({boardId:'B016'});assert.throws(()=>reloaded.clearPhotos(before.id),/已变化/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('标定默认规格：重启持久化、独立于旧采集、非法输入不覆盖且不保存确认状态',()=>{
 const root=mkdtempSync(join(tmpdir(),'qr-calibration-defaults-'));
 const camera={snapshot:()=>({stamp:1700000000000,width:1280,height:720,sequence:1,jpeg:Buffer.from([255,216,4,5,255,217])})} as unknown as CameraPreview;
 const boards=generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:16});
 const dedicated=calibrationTargetSchema.parse({type:'aprilgrid',rows:6,columns:6,tagSizeMm:22,gapMm:6.6,family:'auto',layoutMode:'auto'});
 try{
  const calibration=new CameraCalibration(root,camera,()=>boards);
  assert.deepEqual(calibration.status().defaults,{target:dedicated});
  calibration.start({boardId:'B016'});const session=calibration.capture().session!;
  const sessionPath=join(root,'logs/calibration',session.id,'session.json');
  // A pre-existing legacy session retains its board-only interpretation.
  const legacy=JSON.parse(readFileSync(sessionPath,'utf8'));delete legacy.target;legacy.physicalScaleConfirmed=true;writeFileSync(sessionPath,JSON.stringify(legacy));
  const before=readFileSync(sessionPath);
  const intrinsicsPath=join(root,'config/camera_calibration.json');writeFileSync(intrinsicsPath,JSON.stringify({calibrationVerified:true,rmsPixels:.5}));const intrinsicBefore=readFileSync(intrinsicsPath);
  const status=calibration.defaults({target:{...dedicated,physicalScaleConfirmed:true,measured:true},physicalScaleConfirmed:true,measured:true});
  assert.deepEqual(status.defaults,{target:dedicated});assert.equal(status.session?.id,session.id);assert.equal(status.session?.sampleCount,1);
  assert.deepEqual(status.session?.target,{type:'registered',boardId:'B016'});
  assert.deepEqual(readFileSync(sessionPath),before);assert.deepEqual(readFileSync(intrinsicsPath),intrinsicBefore);
  const defaultsPath=join(root,'config/calibration_defaults.json'),saved=readFileSync(defaultsPath);
  assert.deepEqual(JSON.parse(saved.toString()),{target:dedicated});
  for(const request of [{target:{...dedicated,gapMm:0}},{target:{...dedicated,rows:13}},{target:{type:'registered',boardId:'missing'}},{target:{...dedicated,family:'unknown'}},{}]){
   assert.throws(()=>calibration.defaults(request));assert.deepEqual(readFileSync(defaultsPath),saved);
  }
  const reloaded=new CameraCalibration(root,camera,()=>boards);assert.deepEqual(reloaded.status().defaults,{target:dedicated});assert.equal(reloaded.status().session?.id,session.id);
  const checker=calibrationTargetSchema.parse({type:'checkerboard',rows:7,columns:9,squareSizeMm:18});
  reloaded.start({target:checker});assert.deepEqual(new CameraCalibration(root,camera,()=>boards).status().defaults,{target:checker});
  reloaded.defaults({target:{type:'registered',boardId:'B016'}});assert.deepEqual(new CameraCalibration(root,camera,()=>boards).status().defaults,{target:{type:'registered',boardId:'B016'}});
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('标定默认规格：损坏配置和已删除定位板安全回退，不修改配置或会话',()=>{
 const root=mkdtempSync(join(tmpdir(),'qr-calibration-defaults-invalid-'));mkdirSync(join(root,'config'));
 const camera={} as CameraPreview;
 try{
  const path=join(root,'config/calibration_defaults.json'),calibration=new CameraCalibration(root,camera,()=>[]);
  for(const stored of ['invalid json',JSON.stringify({target:{type:'registered',boardId:'deleted'}}),JSON.stringify({target:{type:'aprilgrid',rows:1}})]){
   writeFileSync(path,stored);const status=calibration.status();assert.equal(status.defaults.target.type,'aprilgrid');if(status.defaults.target.type==='aprilgrid'){assert.equal(status.defaults.target.gapMm,6.6);assert.equal(status.defaults.target.tagSizeMm,22);}assert.equal(status.session,null);assert.equal(readFileSync(path,'utf8'),stored);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('标定照片质量：最终重投影诊断可读，增删照片后失效且不修改已通过内参',()=>{
 const root=mkdtempSync(join(tmpdir(),'qr-calibration-quality-'));mkdirSync(join(root,'config'));
 let stamp=1700000000000;
 const camera={snapshot:()=>({stamp,width:1280,height:720,sequence:1,jpeg:Buffer.from([255,216,4,5,255,217])})} as unknown as CameraPreview;
 try{
  const c=new CameraCalibration(root,camera,()=>[]);c.start({target:{type:'checkerboard',columns:5,rows:5,squareSizeMm:20}});
  c.capture();stamp+=1000;const s=c.capture().session!,folder=join(root,'logs/calibration',s.id),files=s.samples.map(p=>p.file);
  const intrinsic=join(root,'config/camera_calibration.json');writeFileSync(intrinsic,JSON.stringify({calibrationVerified:true,rmsPixels:.21367}));const before=readFileSync(intrinsic);
  writeFileSync(join(folder,'analysis.json'),JSON.stringify(files.map((file,i)=>({file,valid:true,matchedCount:25,reprojection:{role:'training',rmsPixels:i?6.46:.2,thresholdPixels:.8,excessive:!!i}}))));
  writeFileSync(join(folder,'review.json'),JSON.stringify({files,rmsPixels:1.55,validationMaxPixels:.23}));
  const status=c.status();assert.equal(status.session!.calibrationReview.current,true);assert.equal(status.session!.samples[1]!.detection.reprojection.excessive,true);
  c.removePhoto(s.id,files[1]!);assert.equal(c.status().session!.calibrationReview.current,false);assert.equal(c.status().session!.samples[0]!.detection.reprojection,undefined);assert.deepEqual(readFileSync(intrinsic),before);
  stamp+=1000;c.capture();assert.equal(c.status().session!.calibrationReview.current,false);assert.deepEqual(readFileSync(intrinsic),before);
 }finally{rmSync(root,{recursive:true,force:true});}
});
