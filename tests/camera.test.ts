import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MultipartJpegParser,framePacket} from '../web/backend/src/camera';
test('实时相机：跨块分帧、嵌入JPEG结束标记、帧时间和规格、长度限制',()=>{
 const jpeg=Buffer.from([255,216,1,2,255,217,3,4,255,217]); // 中间的结束标记不能截断按长度封装的图像。
 const part=Buffer.concat([Buffer.from('--qrframe\r\nContent-type: image/jpeg\r\nContent-length: '+jpeg.length+'\r\n\r\n'),jpeg,Buffer.from('\r\n')]);
 const all=Buffer.concat([part,part,part]),frames:Buffer[]=[];const parser=new MultipartJpegParser(j=>frames.push(j));
 for(let i=0;i<all.length;i+=7)parser.push(all.subarray(i,i+7));assert.equal(frames.length,3);for(const frame of frames)assert.deepEqual(frame,jpeg);
 const packet=framePacket(jpeg,1024,1700000000123,1280,720);assert.equal(packet.readUInt32BE(0),1024);assert.equal(packet.readDoubleBE(4),1700000000123);assert.equal(packet.readUInt16BE(12),1280);assert.equal(packet.readUInt16BE(14),720);assert.deepEqual(packet.subarray(16),jpeg);
 assert.throws(()=>new MultipartJpegParser(()=>{}).push(Buffer.from('--frame\r\nContent-length: 9999999\r\n\r\n')),/长度/);
 assert.throws(()=>new MultipartJpegParser(()=>{}).push(Buffer.from('--frame\r\nOther: 1\r\n\r\n')),/缺少长度/);
});
