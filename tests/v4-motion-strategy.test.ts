import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../web/backend/src/server';
import {defaults,generate} from '../web/shared/model';
import {routeDesignSchema,compileDesignedRoute} from '../web/backend/src/route-design';
import {planStrategies,degrees,segmentExecutionBlockers} from '../web/shared/segment-strategy';
import {RobotLink} from '../web/backend/src/robot';
test('v4转角与旋转方向来自几何，倒车与180转前进不同，重复有向段分别配置',()=>{
 const nodes=[{id:0,x:0,y:0},{id:1,x:-1,y:0}];
 const reverse=planStrategies(nodes,0,[{fromId:0,toId:1,occurrence:0,mode:'reverse'}])[0]!;assert.equal(degrees(reverse.arrivalYaw),0);assert.equal(degrees(reverse.turn),0);assert.equal(Math.abs(degrees(reverse.travelYaw)),180);
 const turn=planStrategies(nodes,0,[{fromId:0,toId:1,occurrence:0,mode:'turn_forward'}])[0]!;assert.equal(Math.abs(degrees(turn.turn)),180);assert.equal(Math.abs(degrees(turn.arrivalYaw)),180);assert.match(turn.blocked,/禁止执行/);
 for(const y of [-1,1]){const plan=planStrategies([{id:0,x:0,y:0},{id:1,x:0,y}],0,[{fromId:0,toId:1,occurrence:0,mode:'turn_forward'}])[0]!;assert.equal(degrees(plan.turn),90*y);assert.equal(degrees(plan.arrivalYaw),90*y);}
 const repeated=planStrategies([...nodes,nodes[0]!,nodes[1]!],0,[{fromId:0,toId:1,occurrence:1,mode:'reverse'}]);assert.equal(repeated[0]!.mode,'auto');assert.equal(repeated[2]!.mode,'reverse');assert.equal(repeated[2]!.occurrence,1);
 assert.deepEqual(segmentExecutionBlockers(compileDesignedRoute(fixture(),points,0).map.motionSegments),[]);
});
const points=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
function fixture(){const map=generate({...defaults,count:1,angle:0});map.id='v4-strategies';map.tags=points.map((p,id)=>({id,...p,rowId:map.rows[0]!.id,size:.08,angle:0,kind:'waypoint' as const,rules:[]}));return map;}
test('v4接口接受有向区间策略，不把策略静默丢弃',()=>{
 const parsed=routeDesignSchema.safeParse({mapId:'v4-strategies',baseVersion:1,points,bodyYawDeg:0,segmentModes:[{fromId:1,toId:2,occurrence:0,mode:'left'}]});assert.ok(parsed.success,JSON.stringify(parsed));
});
test('v4支持策略编译成原执行器真实forward/reverse/crab参数，几何和输入不变',()=>{
 const source=fixture(),before=JSON.stringify(source);
 const result=(compileDesignedRoute as any)(source,points,0,[{fromId:0,toId:1,occurrence:0,mode:'forward'},{fromId:1,toId:2,occurrence:0,mode:'left'},{fromId:2,toId:3,occurrence:0,mode:'reverse'}]);
 assert.deepEqual(result.map.motionSegments.map((s:any)=>[s.strategy,s.direction,s.mode]),[['forward','forward','4t4d'],['left','lateral','crab'],['reverse','reverse','4t4d']]);assert.equal(JSON.stringify(source),before);
 assert.throws(()=>(compileDesignedRoute as any)(source,points,0,[{fromId:1,toId:2,occurrence:0,mode:'right'}]),/方向|右/);
 assert.throws(()=>(compileDesignedRoute as any)(source,points,0,[{fromId:4,toId:5,occurrence:0,mode:'forward'}]),/区间|不匹配/);
});
test('v4路线策略保存/刷新/任务快照/另存和409；转向规划禁止导航且旧路线默认兼容',async()=>{
 const status=RobotLink.prototype.status,enqueue=RobotLink.prototype.enqueue,commands:any[]=[];
 let lateralSupported=true;
 RobotLink.prototype.status=function(){return {...status.call(this),connected:true,running:false,mapping:{ready:true,quality:'verified' as const,reason:'mock',localEpoch:'mock',lateralSupported},conditions:[{id:'mock',label:'纯软件',ready:true}]};};
 RobotLink.prototype.enqueue=function(type,payload){commands.push({type,payload});return {accepted:true,commandId:'00000000-0000-4000-8000-000000000000',state:'mock'};};
 const app=await createApp(':memory:');try{
  const initial=compileDesignedRoute(fixture(),points,0).map;assert.equal((await app.inject({method:'POST',url:'/api/maps',payload:{map:initial,baseVersion:0}})).statusCode,200);
  const original=(await app.inject('/api/maps/'+initial.id)).body;
  const payload={mapId:initial.id,baseVersion:1,points,bodyYawDeg:0,routeId:'v4-route',routeName:'逐段模式',segmentModes:[{fromId:1,toId:2,occurrence:0,mode:'left'}]};
  const first=await app.inject({method:'POST',url:'/api/route/design',payload});assert.equal(first.statusCode,200,first.body);const saved=first.json();assert.equal(saved.route.motionSegments[1].strategy,'left');assert.deepEqual(saved.task.routeSnapshot,saved.route);
  const loaded=(await app.inject('/api/routes/v4-route')).json().route;assert.deepEqual(loaded,saved.route);
  lateralSupported=false;const lateralDenied=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:saved.task.id}});assert.equal(lateralDenied.statusCode,423);assert.match(lateralDenied.body,/横移能力/);assert.equal(commands.length,0);lateralSupported=true;
  const started=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:saved.task.id}});assert.equal(started.statusCode,200,started.body);assert.equal(commands.length,1);assert.equal(commands[0].payload.map.motionSegments[1].mode,'crab');assert.deepEqual(commands[0].payload.task.routeSnapshot,saved.route);
  const copy=await app.inject({method:'POST',url:'/api/route/design',payload:{...payload,saveAs:true,routeName:'另存策略'}});assert.equal(copy.statusCode,200,copy.body);assert.notEqual(copy.json().route.routeId,saved.route.routeId);
  const turn=await app.inject({method:'POST',url:'/api/route/design',payload:{...payload,routeUpdated:loaded.updated,segmentModes:[{fromId:1,toId:2,occurrence:0,mode:'turn_forward'}]}});assert.equal(turn.statusCode,200,turn.body);assert.equal(turn.json().route.motionSegments[1].strategy,'turn_forward');
  const denied=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:turn.json().task.id}});assert.equal(denied.statusCode,423);assert.match(denied.body,/转向|未接入/);
  assert.equal(commands.length,1,'转向规划不可到达执行消费端');
  const stale=await app.inject({method:'POST',url:'/api/route/design',payload:{...payload,routeUpdated:loaded.updated}});assert.equal(stale.statusCode,409);assert.equal((await app.inject('/api/maps/'+initial.id)).body,original);
  assert.equal((await app.inject('/api/robot/status')).json().running,false);
 }finally{await app.close();RobotLink.prototype.status=status;RobotLink.prototype.enqueue=enqueue;}
});
