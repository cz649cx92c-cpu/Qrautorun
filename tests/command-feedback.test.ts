import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {RobotLink} from '../web/backend/src/robot';
import {createApp,root} from '../web/backend/src/server';
import {defaults} from '../web/shared/model';

test('入队不等同成功；按ID保存真实拒绝原因，重复及陌生回执不覆盖',()=>{
 const robot=new RobotLink(),first=robot.enqueue('start'),other=robot.enqueue('pause');
 assert.equal(first.accepted,true);assert.equal(robot.commandResult(first.commandId)?.ok,null);
 robot.ack(other.commandId,true,'暂停成功');
 assert.equal(robot.commandResult(first.commandId)?.ok,null);
 robot.ack(first.commandId,false,'起点偏差 8cm，超过 5cm');
 const rejected=robot.commandResult(first.commandId)!;
 assert.equal(rejected.ok,false);assert.equal(rejected.type,'start');assert.match(rejected.message,/8cm/);
 assert.equal(typeof rejected.acknowledgedAt,'number');assert.deepEqual(robot.poll(),[]);
 robot.ack(first.commandId,true,'重复回执');robot.ack('unknown',true,'陌生回执');
 assert.deepEqual(robot.commandResult(first.commandId),rejected);assert.equal(robot.commandResult('unknown'),null);
 assert.equal(robot.commandResult(other.commandId)?.ok,true);
});

test('兼容ack(id)，队列过期或stop清空均不伪造成功，也不重发',t=>{
 let now=100_000;t.mock.method(Date,'now',()=>now);
 const robot=new RobotLink(),legacy=robot.enqueue('pause');robot.ack(legacy.commandId);
 assert.deepEqual(robot.poll(),[]);assert.equal(robot.commandResult(legacy.commandId)?.ok,null);
 const expired=robot.enqueue('start');now+=5001;assert.deepEqual(robot.poll(),[]);
 assert.equal(robot.commandResult(expired.commandId)?.ok,null);
 robot.ack(expired.commandId,false,'迟到但真实的拒绝');assert.equal(robot.commandResult(expired.commandId)?.ok,false);
 const pending=robot.enqueue('start'),stop=robot.enqueue('stop');
 assert.deepEqual(robot.poll().map(c=>c.id),[stop.commandId]);assert.equal(robot.commandResult(pending.commandId)?.ok,null);
});

test('结果按容量128和60秒时间界限清理',t=>{
 let now=100_000;t.mock.method(Date,'now',()=>now);
 const robot=new RobotLink(),ids=Array.from({length:129},()=>robot.enqueue('pause').commandId);
 assert.equal(robot.commandResult(ids[0]!),null);assert.ok(robot.commandResult(ids[1]!));
 now+=59_999;assert.ok(robot.commandResult(ids.at(-1)!));now++;
 assert.equal(robot.commandResult(ids.at(-1)!),null);
});

test('内存Fastify：真实start入队→授权ack拒绝→独立GET结果，兼容旧ack请求',async t=>{
 const status=new RobotLink().status();t.mock.method(RobotLink.prototype,'status',()=>({...status,connected:true,conditions:[{id:'pose',label:'定位就绪',ready:true}]}));
 const app=await createApp(':memory:');
 try{
  const {map}=(await app.inject({method:'POST',url:'/api/maps/generate',payload:defaults})).json();
  await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});
  await app.inject({method:'POST',url:'/api/tasks',payload:{id:'ack-test',name:'离线回执测试',mapId:map.id,mapVersion:1,rowOrder:map.order,forwardSpeed:.12,reverseSpeed:.1,lateralSpeed:.06,endWaitSeconds:2,enabled:true}});
  const confirmation=await app.inject({method:'POST',url:'/api/maps/confirm',payload:{mapId:map.id,version:1,confirm:true,operator:'离线测试',updateTasks:true}});
  assert.equal(confirmation.statusCode,200,confirmation.body);
  const submitted=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'ack-test'}});
  assert.equal(submitted.statusCode,200,submitted.body);const {commandId}=submitted.json();
  const get=()=>app.inject('/api/robot/commands/'+commandId);
  assert.equal((await get()).json().ok,null);assert.equal((await get()).headers['cache-control'],'no-store');
  const payload={id:commandId,ok:false,message:'首行起点偏差过大：8cm'};
  assert.equal((await app.inject({method:'POST',url:'/api/robot/ack',payload})).statusCode,401);
  assert.equal((await get()).json().ok,null);
  const config=JSON.parse(readFileSync(resolve(root,'config/web.json'),'utf8'));
  const headers={'x-bridge-key':readFileSync(resolve(root,config.bridgeKeyFile),'utf8').trim()};
  assert.equal((await app.inject({method:'POST',url:'/api/robot/ack',headers,payload})).statusCode,200);
  assert.equal((await get()).json().ok,false);assert.equal((await get()).json().message,payload.message);
  assert.deepEqual((await app.inject({url:'/api/robot/commands',headers})).json(),[]);
  const pause=(await app.inject({method:'POST',url:'/api/navigation/pause',payload:{}})).json();
  assert.equal((await app.inject('/api/robot/commands/'+pause.commandId)).json().ok,null);
  assert.equal((await app.inject({method:'POST',url:'/api/robot/ack',headers,payload:{id:pause.commandId}})).statusCode,200);
  assert.equal((await app.inject('/api/robot/commands/'+pause.commandId)).json().ok,null);
  assert.equal((await get()).json().ok,false);
  assert.equal((await app.inject('/api/robot/commands/unknown')).statusCode,404);
 }finally{await app.close();}
});

// Execute the actual SFC request/navigation functions with a fake clock and fetch;
// no browser/server process is started and all navigation POSTs stay in memory.
const source=readFileSync(resolve('web/frontend/src/App.vue'),'utf8');
const script=source.split('<script setup lang="ts">')[1]!.split('</script>')[0]!;
const ast=ts.createSourceFile('App.ts',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const functions=ast.statements.filter(s=>ts.isFunctionDeclaration(s)&&['api','navigation'].includes(s.name?.text??'')).map(s=>s.getText(ast)).join('\n');
const js=ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
type Request={url:string,options:RequestInit};
function harness(handle:(request:Request)=>unknown|Promise<unknown>){
 let now=0,next=0;const timers=new Map<number,{at:number,run:()=>void}>(),requests:Request[]=[];
 const context=vm.createContext({AbortController,encodeURIComponent,
  busy:{value:false},error:{value:''},message:{value:''},commandFeedback:{value:null},selectedTask:{value:'task-scan-test'},orthogonalPreviewActive:{value:false},closed:false,navigationAbort:undefined,
  setTimeout:(run:()=>void,ms:number)=>{const id=++next;timers.set(id,{at:now+ms,run});return id;},clearTimeout:(id:number)=>timers.delete(id),
  fetch:async(url:string,options:RequestInit)=>{const request={url,options};requests.push(request);const body=await handle(request);return {ok:true,json:async()=>body};}
 });
 vm.runInContext(js,context);
 const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
 const advance=async(ms:number)=>{
  const end=now+ms;
  while(true){const nextTimer=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!nextTimer)break;
   now=nextTimer[1].at;timers.delete(nextTimer[0]);nextTimer[1].run();await flush();
  }now=end;await flush();
 };
 return {context,requests,flush,advance,start:(command='start')=>vm.runInContext(`navigation('${command}')`,context) as Promise<void>,feedback:()=>context.commandFeedback.value};
}

test('前端accepted只显示等待，忽略别人的回执，再显示自己的REJECTED原始原因',async()=>{
 let reads=0;const h=harness(({url})=>url.startsWith('/api/navigation/')?{accepted:true,commandId:'mine'}:++reads===1?{id:'other',ok:true,message:'别人成功'}:{id:'mine',ok:false,message:'起点偏差8cm'});
 const done=h.start();await h.flush();assert.equal(h.feedback().state,'waiting');assert.equal(h.context.busy.value,false);
 await h.advance(200);await done;assert.equal(h.feedback().state,'rejected');assert.match(h.feedback().text,/REJECTED.*起点偏差8cm/);
 assert.equal(h.requests.filter(r=>r.options.method==='POST').length,1);
});

test('前端仅机器人ok=true显示确认接收，保留回执消息',async()=>{
 const h=harness(({url})=>url.startsWith('/api/navigation/')?{accepted:true,commandId:'mine'}:{id:'mine',ok:true,message:'启动完成'});
 await h.start();assert.equal(h.feedback().state,'confirmed');assert.equal(h.feedback().text,'机器人已确认接收：启动完成');
});

test('前端6秒后未确认；GET失败可继续查询但不重发POST',async()=>{
 const h=harness(({url})=>{if(url.startsWith('/api/navigation/'))return {accepted:true,commandId:'mine'};throw new Error('查询连接断开');});
 const done=h.start();await h.flush();await h.advance(5999);assert.equal(h.feedback().state,'waiting');
 await h.advance(1);await done;assert.equal(h.feedback().state,'unconfirmed');assert.doesNotMatch(h.feedback().text,/成功/);
 assert.equal(h.requests.filter(r=>r.options.method==='POST').length,1);assert.equal(h.context.busy.value,false);
});

test('挂起的GET或POST也受6秒总超时限制',async()=>{
 for(const hangPost of [false,true]){
  const h=harness(({url,options})=>{
   if(!hangPost&&url.startsWith('/api/navigation/'))return {accepted:true,commandId:'mine'};
   return new Promise((_resolve,reject)=>options.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  });
  const done=h.start();await h.flush();await h.advance(6000);await done;
  assert.equal(h.feedback().state,'unconfirmed');assert.equal(h.requests.filter(r=>r.options.method==='POST').length,1);
 }
});

test('等待start时stop/pause立即提交，即使busy；旧回执不得覆盖新结果',async()=>{
 for(const command of ['stop','pause']){
  let release:((value:unknown)=>void)|undefined;
  const h=harness(({url})=>{
   if(url==='/api/navigation/start')return {accepted:true,commandId:'old'};
   if(url==='/api/robot/commands/old')return new Promise(resolve=>{release=resolve;});
   if(url==='/api/navigation/'+command)return {accepted:true,commandId:'new'};
   return {id:'new',ok:true,message:command+'成功'};
  });
  const old=h.start();await h.flush();h.context.busy.value=true;
  await h.start(command);assert.equal(h.feedback().id,'new');assert.equal(h.feedback().state,'confirmed');
  release!({id:'old',ok:false,message:'旧命令拒绝'});await old;
  assert.equal(h.feedback().id,'new');assert.equal(h.feedback().state,'confirmed');
  assert.deepEqual(h.requests.filter(r=>r.options.method==='POST').map(r=>r.url),['/api/navigation/start','/api/navigation/'+command]);
 }
 const stopButton=source.match(/<Button[^>]*@click="navigation\('stop'\)"/);assert.ok(stopButton);assert.doesNotMatch(stopButton[0],/disabled/);
 const pauseButton=source.match(/<Button[^>]*@click="navigation\(robot.paused/);assert.ok(pauseButton);assert.doesNotMatch(pauseButton[0],/busy/);
});
