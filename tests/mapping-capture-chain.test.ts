import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createApp} from '../web/backend/src/server';
import {generateBoards} from '../web/shared/boards';

test('104帧正式观测实际入内存扫描库；静止0米不等于首帧未写入',async()=>{
 const app=await createApp(':memory:');
 try{
  const board=generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:113})[0]!;
  const registration=await app.inject({method:'POST',url:'/api/boards/pdf',payload:{gridSize:4,groupSizeMm:100,groupCount:1,startId:113}});assert.equal(registration.statusCode,200,registration.body);
  const started=await app.inject({method:'POST',url:'/api/survey/start',payload:{name:'104帧隔离回归'}});assert.equal(started.statusCode,200);const id=started.json().id;
  const samples=Array.from({length:104},(_,i)=>({stamp:100+i*.04,pose:{x:1,y:2,yaw:0},representation:'board-centers',groupLayouts:[board],calibrated:true,synchronized:true,localEpoch:'formal-origin',tags:[{id:113,groupId:board.id,x:.1,y:0,angle:0,sigma:.01,memberIds:board.members.map(member=>member.id),visibleCount:16,size:.1}]}));
  const stored=await app.inject({method:'POST',url:'/api/survey/import',payload:{sessionId:id,samples}});assert.equal(stored.statusCode,200,stored.body);
  const loaded=(await app.inject('/api/surveys/'+id)).json();assert.equal(loaded.samples.length,104);assert.equal(loaded.captureQuality,'verified');assert.equal(loaded.state,'collecting');assert.equal(loaded.counts['113'],104);
  assert.equal(loaded.samples.slice(1).reduce((sum:number,p:any,i:number)=>sum+Math.hypot(p.pose.x-loaded.samples[i].pose.x,p.pose.y-loaded.samples[i].pose.y),0),0);
  assert.equal((await app.inject('/api/surveys')).json()[0].sampleCount,104);
  // A bridge reconnect (health GET) does not stop or delete the backend-owned session.
  assert.equal((await app.inject('/api/health')).statusCode,200);assert.equal((await app.inject('/api/surveys/'+id)).json().samples.length,104);
 }finally{await app.close();}
});

test('实际网页门禁：104样本不会提示首帧未写入；摄像头首帧与扫描样本独立',()=>{
 const source=readFileSync(new URL('../web/frontend/src/App.vue',import.meta.url),'utf8').split('<script setup lang="ts">')[1]!.split('</script>')[0]!;
 const ast=ts.createSourceFile('App.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const statement=ast.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(ast)==='scanWaitReasons'))!;assert.ok(statement);
 const session={value:{state:'collecting',samples:Array.from({length:104},()=>({pose:{x:0,y:0}}))}};
 const robot={value:{detector:{connected:true,positionReady:true},sensors:{imu:'在线'},mapping:{ready:true,reason:''}}};
 const context=vm.createContext({computed:(fn:()=>unknown)=>({get value(){return fn();}}),bridgeOnline:{value:true},session,robot,originChanged:{value:false},recoveryReason:(text:string)=>text});
 vm.runInContext(ts.transpileModule(statement.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 const reasons=()=>JSON.parse(vm.runInContext('JSON.stringify(scanWaitReasons.value)',context));assert.deepEqual(reasons(),[]);
 robot.value.mapping={ready:false,reason:'等待新鲜的正式同步定位观测'};assert.deepEqual(reasons(),['等待新鲜的正式同步定位观测']);
 robot.value.mapping={ready:true,reason:''};session.value.samples=[];assert.deepEqual(reasons(),['等待首帧定位观测写入']);
 const camera=readFileSync(new URL('../web/frontend/src/components/CameraPreview.vue',import.meta.url),'utf8');assert.match(camera,/hasFrame\?'最近画面距今 '\+freshness.ageMs\+' ms':'等待首帧'/);
});
