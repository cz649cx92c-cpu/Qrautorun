import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MultipartJpegParser,framePacket,cameraPreviewConfigSchema,cameraVideoOptions} from '../web/backend/src/camera';
test('实时相机：跨块分帧、嵌入JPEG结束标记、帧时间和规格、长度限制',()=>{
 const jpeg=Buffer.from([255,216,1,2,255,217,3,4,255,217]); // 中间的结束标记不能截断按长度封装的图像。
 const part=Buffer.concat([Buffer.from('--qrframe\r\nContent-type: image/jpeg\r\nContent-length: '+jpeg.length+'\r\n\r\n'),jpeg,Buffer.from('\r\n')]);
 const all=Buffer.concat([part,part,part]),frames:Buffer[]=[];const parser=new MultipartJpegParser(j=>frames.push(j));
 for(let i=0;i<all.length;i+=7)parser.push(all.subarray(i,i+7));assert.equal(frames.length,3);for(const frame of frames)assert.deepEqual(frame,jpeg);
 const packet=framePacket(jpeg,1024,1700000000123,1280,720);assert.equal(packet.readUInt32BE(0),1024);assert.equal(packet.readDoubleBE(4),1700000000123);assert.equal(packet.readUInt16BE(12),1280);assert.equal(packet.readUInt16BE(14),720);assert.deepEqual(packet.subarray(16),jpeg);
 assert.throws(()=>new MultipartJpegParser(()=>{}).push(Buffer.from('--frame\r\nContent-length: 9999999\r\n\r\n')),/长度/);
 assert.throws(()=>new MultipartJpegParser(()=>{}).push(Buffer.from('--frame\r\nOther: 1\r\n\r\n')),/缺少长度/);
});
test('相机方向：180°旋转且分辨率/FPS/设备、其他配置不变',()=>{
 const config=cameraPreviewConfigSchema.parse(JSON.parse(readFileSync(new URL('../config/camera_preview.json',import.meta.url),'utf8')));
 assert.equal(config.rotate,180);
 assert.deepEqual(cameraVideoOptions(config.rotate),['-vf','hflip,vflip','-c:v','mjpeg','-q:v','2']);
 assert.deepEqual(cameraVideoOptions(0),['-c:v','copy']);
 assert.throws(()=>cameraVideoOptions(90),/仅支持/);
 const profile=config.profiles.find(p=>p.id===config.defaultProfile)!;
 assert.deepEqual({...profile},{id:'720p',label:'高清 720P',width:1280,height:720,fps:30});
 assert.equal(config.device,'/dev/v4l/by-id/usb-Generic_HBVCAM_Camera_200901010001-video-index0');
});

test('相机方向：rotate 只影响预览滤镜，不改变采集规格（时序标定不受影响）',()=>{
 const base={device:'/dev/v4l/by-id/usb-Generic_HBVCAM_Camera_200901010001-video-index0',vendor:'0bda',product:'5846',name:'HBVCAM',defaultProfile:'720p',
  profiles:[{id:'720p',label:'高清 720P',width:1280,height:720,fps:30},{id:'480p',label:'流畅 480P',width:640,height:480,fps:30}]};
 const upright=cameraPreviewConfigSchema.parse({...base,rotate:0});
 const flipped=cameraPreviewConfigSchema.parse({...base,rotate:180});
 assert.deepEqual(cameraVideoOptions(upright.rotate),['-c:v','copy']);
 assert.deepEqual(cameraVideoOptions(flipped.rotate),['-vf','hflip,vflip','-c:v','mjpeg','-q:v','2']);
 // 采集侧字段必须逐项相同，否则时序标定会被误判失效。
 for(const key of ['device','vendor','product','defaultProfile','profiles'] as const)assert.deepEqual(flipped[key],upright[key],key);
 assert.deepEqual({...flipped,rotate:0},upright);
});
