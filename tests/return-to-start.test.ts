import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp,root} from '../web/backend/src/server';
import {taskSchema} from '../web/shared/task';
test('原路倒车开关持久保存；设置不触发运动，显式启动才携带返回选项',async()=>{
 const app=await createApp(':memory:');try{
  const raw=JSON.parse(readFileSync('tests/fixtures/office-return.json','utf8')),map=raw.map??raw;
  const saved=(await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}})).json();
  const task={id:'office-return-api',name:'办公室往返',mapId:map.id,mapVersion:saved.version,rowOrder:map.order,forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true};
  assert.equal(taskSchema.parse(task).returnToStart,false);
  const config=JSON.parse(readFileSync(resolve(root,'config/web.json'),'utf8')),headers={'x-bridge-key':readFileSync(resolve(root,config.bridgeKeyFile),'utf8').trim()};
  const changed=await app.inject({method:'POST',url:'/api/tasks',payload:{...task,returnToStart:true}});assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().returnToStart,true);
  assert.equal((await app.inject('/api/tasks')).json()[0].returnToStart,true);
  assert.deepEqual((await app.inject({method:'GET',url:'/api/robot/commands',headers})).json(),[]);
  const telemetry={bootId:'office-return-test',seq:1,state:'IDLE',running:false,paused:false,rowId:'',pose:null,speed:0,wheelAngle:null,tagId:null,chassis:{connected:true,feedback:{vx:0}},sensors:{camera:'在线',odom:'在线',imu:'在线',localization:'在线'},conditions:[],events:[],cycleMs:1};
  assert.equal((await app.inject({method:'POST',url:'/api/robot/telemetry',headers,payload:telemetry})).statusCode,200);
  const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:task.id}});assert.equal(start.statusCode,200,start.body);
  const commands=(await app.inject({method:'GET',url:'/api/robot/commands',headers})).json();assert.equal(commands.length,1);assert.equal(commands[0].type,'start');assert.equal(commands[0].payload.task.returnToStart,true);
  await app.inject({method:'POST',url:'/api/tasks',payload:{...task,returnToStart:false}});assert.equal((await app.inject('/api/tasks')).json()[0].returnToStart,false);
  // The queued mission is a snapshot; changing the next task cannot alter it.
  assert.equal((await app.inject({method:'GET',url:'/api/robot/commands',headers})).json()[0].payload.task.returnToStart,true);
 }finally{await app.close();}
});
