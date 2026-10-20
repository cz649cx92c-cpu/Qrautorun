import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {RobotLink,telemetrySchema} from '../web/backend/src/robot';

const localization=(changes:Record<string,unknown>={})=>({stamp:1000,state:'STATIC_ANCHORED',source:'stationary_qr',stationary:true,absoluteHeading:true,poseAvailable:true,navigationReady:false,captureTimestampVerified:false,mapId:'office',localEpoch:'epoch-one',reason:'静止二维码定位',headingDeg:-30,...changes});
const telemetry=(changes:Record<string,unknown>={})=>({bootId:'offline-static-test',seq:1,state:'IDLE',running:false,paused:false,rowId:'',pose:{x:.012,y:-.013,yaw:-Math.PI/6},speed:0,wheelAngle:null,tagId:null,chassis:{connected:true,feedback:null},sensors:{camera:'待同步',odom:'在线',imu:'在线',localization:'静止已定位 / 运动同步待接入'},conditions:[{id:'execution',label:'实体执行许可',ready:false},{id:'pose',label:'正式定位',ready:false}],events:[],cycleMs:1,localization:localization(),...changes});

test('静止位姿遥测保留地图来源与角度，但不提升正式定位门禁',t=>{
 t.mock.method(Date,'now',()=>1_000_000);
 const robot=new RobotLink();robot.update(telemetry());const status=robot.status();
 assert.equal(status.localization?.state,'STATIC_ANCHORED');assert.equal(status.localization?.headingDeg,-30);
 assert.equal(status.localization?.mapId,'office');assert.equal(status.localization?.navigationReady,false);
 assert.equal(status.pose?.x,.012);assert.equal(status.conditions.find(c=>c.id==='pose')?.ready,false);assert.deepEqual(robot.poll(),[]);
});

test('schema拒绝静止来源声明导航就绪、采时同步或伪装正式来源',()=>{
 for(const change of [{navigationReady:true},{captureTimestampVerified:true},{source:'synchronized_qr'},
                     {state:'FORMAL'},{stationary:false},{absoluteHeading:false},{mapId:''},{headingDeg:181}]){
  assert.equal(telemetrySchema.safeParse(telemetry({localization:localization(change)})).success,false,JSON.stringify(change));
 }
 assert.equal(telemetrySchema.safeParse(telemetry({localization:localization({state:'LOCAL_ONLY',stationary:false})})).success,true);
 assert.equal(telemetrySchema.safeParse(telemetry({localization:localization({state:'FORMAL',source:'synchronized_qr',navigationReady:true,captureTimestampVerified:true})})).success,true);
});

test('静止消息时效独立于网页桥连接时效，过期立即隐藏车体',t=>{
 let now=1_000_000;t.mock.method(Date,'now',()=>now);
 const robot=new RobotLink();robot.update(telemetry());now+=251;
 const status=robot.status();assert.equal(status.connected,true);assert.equal(status.pose,null);
 assert.equal(status.localization?.state,'WAITING');assert.equal(status.localization?.poseAvailable,false);
 assert.equal(status.localization?.navigationReady,false);assert.equal(status.localization?.headingDeg,null);
 assert.match(status.sensors.localization??'',/过期/);
});

test('重复刷新遥测不延长旧二维码观测；未来时戳也不显示',t=>{
 let now=1_000_000;t.mock.method(Date,'now',()=>now);
 const robot=new RobotLink();robot.update(telemetry());now+=300;robot.update(telemetry({seq:2}));
 assert.equal(robot.status().pose,null);
 robot.update(telemetry({seq:3,localization:localization({stamp:1001})}));assert.equal(robot.status().pose,null);
});

test('LOCAL_ONLY或WAITING隐藏旧static pose，桥离线清除定位对象',t=>{
 let now=1_000_000;t.mock.method(Date,'now',()=>now);
 const robot=new RobotLink();robot.update(telemetry());
 robot.update(telemetry({seq:2,localization:localization({state:'LOCAL_ONLY',stationary:false})}));
 assert.equal(robot.status().pose,null);assert.equal(robot.status().localization?.source,'stationary_qr');
 robot.update(telemetry({seq:3,localization:localization({state:'WAITING',poseAvailable:false})}));assert.equal(robot.status().pose,null);
 now+=1600;assert.equal(robot.status().pose,null);assert.equal(robot.status().localization,null);
});

test('旧遥测不含localization仍可解析，保持协议兼容',t=>{
 t.mock.method(Date,'now',()=>1_000_000);
 const {localization:_omit,...legacy}=telemetry();const robot=new RobotLink();robot.update(legacy);
 assert.equal(robot.status().localization,null);assert.equal(robot.status().pose?.x,.012);
});

// Compile only the production SFC's display function/computed gate into memory; no browser server or API writes.
const source=readFileSync(resolve('web/frontend/src/App.vue'),'utf8').split('<script setup lang="ts">')[1]!.split('</script>')[0]!;
const ast=ts.createSourceFile('App.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const displayNode=ast.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='matchingMapPose');
assert.ok(displayNode);
const displayJs=ts.transpileModule(displayNode.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const display=vm.runInNewContext(displayJs+'\nmatchingMapPose;') as (status:unknown,mapId:string,now:number,received?:number)=>{x:number,y:number,yaw:number,headingDeg:number,isStatic:boolean,sourceLabel:string}|null;
const staticStatus=()=>({...telemetry(),connected:true});

test('网页显示当前地图的静止坐标与包裹朝向，其他地图或局部坐标不绘制',()=>{
 const status=staticStatus();const pose=display(status,'office',1_000_000);
 assert.ok(pose);assert.equal(pose.x,.012);assert.equal(pose.headingDeg,-30);assert.equal(pose.sourceLabel,'静止二维码定位');
 assert.equal(display(status,'other-map',1_000_000),null);
 assert.equal(display({...status,localization:localization({state:'LOCAL_ONLY',stationary:false})},'office',1_000_000),null);
 assert.equal(display({...status,localization:null},'office',1_000_000),null);
 for(const [yaw,heading] of [[Math.PI,-180],[-Math.PI,-180],[190*Math.PI/180,-170],[-190*Math.PI/180,170]]){
  const rendered=display({...status,pose:{x:0,y:0,yaw}},'office',1_000_000);assert.ok(rendered);assert.ok(Math.abs(rendered.headingDeg!-heading!)<1e-10);
 }
});

test('网页隐藏过期、运动、未知来源及非有限位姿',()=>{
 const status=staticStatus();
 assert.equal(display(status,'office',1_000_251),null);
 assert.equal(display({...status,connected:false},'office',1_000_000),null);
 assert.equal(display({...status,localization:localization({stationary:false})},'office',1_000_000),null);
 assert.equal(display({...status,localization:localization({source:'legacy'})},'office',1_000_000),null);
 assert.equal(display({...status,pose:{x:NaN,y:0,yaw:0}},'office',1_000_000),null);
 assert.equal(display({...status,localization:localization({navigationReady:true})},'office',1_000_000),null);
});

test('网页正式位姿使用同步来源，静止预览不解除canNavigate条件',()=>{
 const status=staticStatus();assert.equal(display({...status,localization:localization({state:'FORMAL',source:'synchronized_qr',navigationReady:true,captureTimestampVerified:true})},'office',1_000_000)?.sourceLabel,'正式二维码融合定位');
 const statement=ast.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(ast)==='canNavigate'));
 assert.ok(statement);const gate=ts.transpileModule(statement.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const context=vm.createContext({computed:(fn:()=>boolean)=>({get value(){return fn()}}),
  editingRoute:{value:false},speedDirty:{value:false},savedStrategyBlockers:{value:[]},lateralStrategyBlocked:{value:false},
  tasks:{value:[{id:'task-scan-office',mapId:'office',mapVersion:2}]},selectedTask:{value:'task-scan-office'},
  field:{value:{id:'office',coordinateStatus:'reviewed',captureQuality:'draft'}},version:{value:2},
  mapApproval:{value:{accepted:true,digestValid:true}},userConfirmedMap:{value:true},robot:{value:status}});
 vm.runInContext(gate,context);assert.equal(vm.runInContext('canNavigate.value',context),false);
 status.conditions=[{id:'pose',label:'正式定位',ready:false}];assert.equal(vm.runInContext('canNavigate.value',context),false);
});


test('用户确认导航保留精度未实测的状态，不伪造测量依据',t=>{
 t.mock.method(Date,'now',()=>1_000_000);
 const robot=new RobotLink();robot.update(telemetry({localization:localization({state:'FORMAL',source:'synchronized_qr',navigationReady:true,captureTimestampVerified:true,covarianceCalibrated:false,approvalBasis:'user_confirmation',reason:'同步二维码融合定位（用户确认实机测试；精度尚未实测）'})}));
 const status=robot.status();assert.equal(status.localization?.navigationReady,true);
 assert.equal(status.localization?.covarianceCalibrated,false);assert.equal(status.localization?.approvalBasis,'user_confirmation');
 assert.equal(display(status,'office',1_000_000)?.sourceLabel,'同步二维码融合定位');
});

test('display uses server observation age despite browser clock skew and expires stalled updates',()=>{
 const status={...staticStatus(),serverTimeMs:1_000_000};
 for(const browserNow of [5_000,1_000_000-86_400_000,1_000_000+86_400_000]){
  assert.ok(display(status,'office',browserNow+15,browserNow));
  assert.equal(display(status,'office',browserNow+251,browserNow),null);
 }
 assert.equal(display({...status,serverTimeMs:1_000_251},'office',5_000,5_000),null);
 assert.equal(display({...status,localization:localization({stamp:1001})},'office',5_000,5_000),null);
 assert.equal(display({...status,serverTimeMs:NaN},'office',5_000,5_000),null);
});

test('status timestamp uses the server clock without changing navigation gates',t=>{
 t.mock.method(Date,'now',()=>1_000_000);
 const robot=new RobotLink();robot.update(telemetry());const status=robot.status();
 assert.equal(status.serverTimeMs,1_000_000);
 assert.equal(status.conditions.find(c=>c.id==='execution')?.ready,false);
});
