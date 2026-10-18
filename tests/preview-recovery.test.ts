import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CameraPreview,framePacket,PREVIEW_ACK_TIMEOUT_MS} from '../web/backend/src/camera';
import {previewFrameState} from '../web/frontend/src/previewFrameState';

test('delayed pictures remain distinguishable from live pictures and their age keeps increasing',()=>{
 assert.deepEqual(previewFrameState(false,false,0,0,100),{ageMs:0,delayed:false,label:'等待画面'});
 assert.equal(previewFrameState(true,true,300,1000,1100).label,'实时画面');
 assert.deepEqual(previewFrameState(true,true,900,1000,1300),{ageMs:1200,delayed:true,label:'画面有延迟'});
 assert.deepEqual(previewFrameState(true,false,900,1000,5100),{ageMs:5000,delayed:true,label:'画面已暂停'});
});

test('a slow preview keeps one in-flight frame and sends the latest picture after acknowledgment',()=>{
 const sent:Buffer[]=[],closed:string[]=[];
 const socket={readyState:1,bufferedAmount:0,send:(data:Buffer)=>sent.push(data),close:(_:number,reason:string)=>closed.push(reason)};
 const peer={socket,inFlight:1 as number|null,sentAt:Date.now()-3200,last:1,minIntervalMs:0};
 const camera=Object.create(CameraPreview.prototype) as any;
 Object.assign(camera,{process:null,peers:new Set([peer]),latest:framePacket(Buffer.from([255,216,255,217]),9,Date.now(),1280,720),sequence:9,frameAt:Date.now(),sendStatus:()=>{}});
 camera.tick();camera.offer(peer);
 assert.equal(closed.length,0);assert.equal(sent.length,0);
 peer.inFlight=null;camera.offer(peer);
 assert.equal(sent.length,1);assert.equal(sent[0]!.readUInt32BE(0),9);
 assert.equal(peer.inFlight,9);
 peer.sentAt=Date.now()-PREVIEW_ACK_TIMEOUT_MS-1;camera.tick();
 assert.deepEqual(closed,['preview too slow']);
});

test('camera_stream peers retain full rate unless they explicitly request browser preview pacing',()=>{
 const sent:Buffer[]=[];
 const listeners=new Map<string,(data:Buffer)=>void>();
 const socket={readyState:1,bufferedAmount:0,send:(data:Buffer)=>sent.push(data),on:(name:string,fn:(data:Buffer)=>void)=>listeners.set(name,fn)};
 const camera=Object.create(CameraPreview.prototype) as any;
 Object.assign(camera,{peers:new Set(),latest:framePacket(Buffer.from([255,216,255,217]),1,Date.now(),1280,720),sequence:1,frameAt:Date.now(),sendStatus:()=>{},start:async()=>{}});
 camera.add(socket);const peer=Array.from(camera.peers)[0] as any;
 assert.equal(peer.minIntervalMs,0);
 camera.offer(peer);assert.equal(sent.length,1);
 listeners.get('message')!(Buffer.from(JSON.stringify({type:'ack',sequence:1})));
 camera.sequence=2;camera.latest=framePacket(Buffer.from([255,216,255,217]),2,Date.now(),1280,720);
 camera.offer(peer);assert.equal(sent.length,2,'unconfigured vision peer is not limited to preview FPS');
 listeners.get('message')!(Buffer.from(JSON.stringify({type:'preview',maxFps:10})));
 listeners.get('message')!(Buffer.from(JSON.stringify({type:'ack',sequence:2})));
 assert.equal(peer.minIntervalMs,100);
 camera.sequence=3;camera.latest=framePacket(Buffer.from([255,216,255,217]),3,Date.now(),1280,720);
 camera.offer(peer);assert.equal(sent.length,2);
 peer.sentAt-=101;camera.offer(peer);assert.equal(sent.length,3);
});
