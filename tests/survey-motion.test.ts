import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateMotionSegments,motionRecordSchema} from '../web/backend/src/survey-motion';
import {Store} from '../web/backend/src/store';
import {surveyTables,createSurvey,appendSamples,appendMotionRecords,getSurvey} from '../web/backend/src/survey';
const samples=(x=1,y=0,yaw=0)=>[{stamp:1,localEpoch:'epoch',pose:{x:0,y:0,yaw:0},tags:[{id:0,groupId:'A',x:0,y:0}]},{stamp:2,localEpoch:'epoch',pose:{x,y,yaw},tags:[{id:1,groupId:'B',x:0,y:0}]}];
const records=(gear=6,vx=1,vy=0,wz=0)=>Array.from({length:21},(_,i)=>motionRecordSchema.parse({stamp:1+i*.05,seq:i,receivedMonotonic:i*.05,localEpoch:'epoch',bodyGear:gear,steeringGear:gear===6?5:7,vx,vy,vyRaw:vy*10,wz,feedbackAgeS:.01,feedbackSource:'chassis_info_fb_aggregate'}));
test('区间档位：前进、倒车、左右平移和转弯分别通过双重校验',()=>{
 for(const [g,vx,vy,x,y] of [[6,1,0,1,0],[6,-1,0,-1,0],[8,0,1,0,1],[8,0,-1,0,-1]])assert.equal(validateMotionSegments(samples(x,y),records(g,vx,vy)).ready,true);
 const w=.5;assert.equal(validateMotionSegments(samples(Math.sin(w)/w,(1-Math.cos(w))/w,w),records(6,1,0,w)).ready,true);
});
test('中途短暂切换另一运动模式仍拒绝；静止握手不算第二种模式',()=>{
 const r=records();r[10]!.bodyGear=8;assert.match(validateMotionSegments(samples(),r).segments[0]!.reasons.join(),/混用/);
 r[10]={...r[10]!,bodyGear:9,vx:0,vy:0,wz:0};assert.equal(validateMotionSegments(samples(),r).ready,true);
 r[10]!.vx=1;assert.match(validateMotionSegments(samples(),r).segments[0]!.reasons.join(),/未知档位/);
});
test('旧记录、反馈缺口、序号回退、原点重置和假零轨迹均拒绝',()=>{
 assert.equal(validateMotionSegments(samples(),[]).ready,false);
 const gap=records().filter((_,i)=>i<3||i>15);assert.match(validateMotionSegments(samples(),gap).segments[0]!.reasons.join(),/断流/);
 const dropped=records().filter((_,i)=>i!==10);assert.equal(validateMotionSegments(samples(),dropped).ready,false);
 const seq=records();seq[10]!.seq=0;assert.equal(validateMotionSegments(samples(),seq).ready,false);
 const epoch=records();epoch[10]!.localEpoch='reset';assert.equal(validateMotionSegments(samples(),epoch).ready,false);
 assert.match(validateMotionSegments(samples(0),records()).segments[0]!.reasons.join(),/未更新/);
 assert.equal(validateMotionSegments(samples(),records(6,0,1)).ready,false);
 assert.equal(validateMotionSegments(samples(0,1,1),records(8,0,1,1)).ready,false);
});
test('重复识别和多码数组顺序不会制造额外区间',()=>{
 const s=samples();s[0]!.tags.push({id:9,groupId:'Z',x:1,y:0});
 assert.equal(validateMotionSegments([s[0]!,{...s[0]!,stamp:1.1,tags:[...s[0]!.tags].reverse()},s[1]!],records()).segments.length,1);
});
test('连续档位在没有可见二维码的间隔仍持久化，停录后不追加',()=>{
 const store=new Store(':memory:');surveyTables(store);
 // getSurvey inspects linked task tables only through the list API, not here.
 try{
 const session=createSurvey(store,'档位记录');
 appendMotionRecords(store,session.id,records());
 const s=samples().map(p=>({...p,calibrated:true,synchronized:true,tags:p.tags.map(({groupId,...t})=>({...t,angle:0,sigma:.02}))}));
 appendSamples(store,session.id,s);
 const got=getSurvey(store,session.id);assert.equal(got.motionRecords.length,21);assert.equal(got.motionValidation.ready,true);
 store.db.prepare('UPDATE survey_sessions SET state=? WHERE id=?').run('stopped',session.id);
 assert.equal(appendMotionRecords(store,session.id,[{...records()[0]!,stamp:3}]).stored,0);
 }finally{store.close();}
});

test('控制模式与原始反馈分开；只有配对的横移反馈可识别为平移',()=>{
 const four=records(5);four.forEach(r=>r.steeringGear=5);assert.equal(validateMotionSegments(samples(),four).ready,true);assert.equal(validateMotionSegments(samples(),four).segments[0]!.mode,'4t4d');
 const paired=records(7,0,1);assert.equal(validateMotionSegments(samples(0,1),paired).segments[0]!.mode,'crab');assert.equal(validateMotionSegments(samples(0,1),paired).ready,true);
 for(const gear of [5,9,7]){const rs=records(gear);if(gear===7)rs.forEach(r=>r.steeringGear=6);if(gear===5)rs.forEach(r=>r.steeringGear=7);const result=validateMotionSegments(samples(),rs);assert.equal(result.ready,false);assert.match(result.segments[0]!.reasons.join(),/未知档位/);}
 assert.equal(validateMotionSegments(samples(0,1,.5),records(7,0,1,.5)).ready,false);
});
test('切到停车档的一帧旧速度后立即真实零速，不制造第二模式；持续异常仍拒绝',()=>{
 const r=records();r[10]!.bodyGear=0;r[11] = {...r[11]!,bodyGear:0,vx:0};
 assert.equal(validateMotionSegments(samples(),r).ready,true,JSON.stringify(validateMotionSegments(samples(),r)));
 r[11]!.vx=1;assert.equal(validateMotionSegments(samples(),r).ready,false);
});

test('同一可见二维码处停稳再切模式，以停车窗口划分区间',()=>{
 const base=records()[0]!;
 const rs=Array.from({length:61},(_,i)=>{const stamp=1+i*.05;const incoming=stamp<2,outgoing=stamp>3;return {...base,stamp,seq:i,receivedMonotonic:stamp,bodyGear:stamp<2.5?6:7,steeringGear:stamp<2.5?6:7,vx:incoming?1:0,vy:outgoing?1:0,vyRaw:outgoing?10:0};});
 const ss=[samples()[0]!,{stamp:1.9,localEpoch:'epoch',pose:{x:1,y:0,yaw:0},tags:[{id:1,groupId:'B',x:0,y:0}]},{stamp:2.4,localEpoch:'epoch',pose:{x:1,y:0,yaw:0},tags:[{id:1,groupId:'B',x:.02,y:0}]},{stamp:4,localEpoch:'epoch',pose:{x:1,y:1,yaw:0},tags:[{id:2,groupId:'C',x:0,y:0}]}];
 const before=JSON.stringify({ss,rs});const good=validateMotionSegments(ss,rs);
 assert.equal(good.ready,true,JSON.stringify(good));assert.deepEqual(good.segments.map(s=>s.mode),['4t4d','crab']);assert.equal(good.segments[0]!.endStamp,2.4);assert.equal(good.segments[1]!.startStamp,2.4);assert.equal(JSON.stringify({ss,rs}),before);
 // A stop while the QR is far away cannot redefine that QR's boundary.
 const far=ss.map(s=>s.stamp===2.4?{...s,tags:[{...s.tags[0]!,x:.2}]}:s);
 assert.equal(validateMotionSegments(far,rs).ready,false);
 // A single zero-speed sample is insufficient to mask an in-motion switch.
 const transient=rs.map(r=>r.stamp>=2&&r.stamp<=3?{...r,vx:r.stamp===2.4?0:.1}:r);
 assert.equal(validateMotionSegments(ss,transient).ready,false);
});

test('配对平移反馈停车时的一帧缓存保持原始数据且不报未知',()=>{
 const rs=records(7,0,1);rs[10]!.bodyGear=0;rs[10]!.steeringGear=0;rs[11]={...rs[11]!,bodyGear:0,steeringGear:0,vx:0,vy:0};
 const before=JSON.stringify(rs);assert.equal(validateMotionSegments(samples(0,1),rs).ready,true);assert.equal(JSON.stringify(rs),before);
 rs[11]!.vy=1;assert.equal(validateMotionSegments(samples(0,1),rs).ready,false);
});
