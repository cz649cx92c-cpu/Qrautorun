import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp,root} from '../web/backend/src/server';
test('办公室地图直接启用；静止切换、版本一致、重复同步不重置',async()=>{
 const path=resolve(root,'maps/office-confirmed.json'),old=readFileSync(path),app=await createApp(':memory:');
 try{
  const generated=JSON.parse(readFileSync(new URL('../logs/office3-generated.json',import.meta.url),'utf8'));
  const save=(await app.inject({method:'POST',url:'/api/maps',payload:{map:generated.map,baseVersion:0}})).json();
  assert.equal(save.map.coordinateStatus,'reviewed');assert.equal(save.acceptance.kind,'office_test');assert.equal(save.acceptance.accepted,true);
  const payload={mapId:save.map.id,version:save.version};
  assert.equal((await app.inject({method:'POST',url:'/api/localization/map',payload})).statusCode,400);assert.deepEqual(readFileSync(path),old);
  const config=JSON.parse(readFileSync(resolve(root,'config/web.json'),'utf8')),headers={'x-bridge-key':readFileSync(resolve(root,config.bridgeKeyFile),'utf8').trim()};
  const telemetry={bootId:'office-activation-test',seq:1,state:'IDLE',running:false,paused:false,rowId:'',pose:null,speed:0,wheelAngle:null,tagId:null,chassis:{connected:true,feedback:{vx:0}},sensors:{camera:'在线',odom:'在线',imu:'在线',localization:'等待'},conditions:[],events:[],cycleMs:1};
  assert.equal((await app.inject({method:'POST',url:'/api/robot/telemetry',headers,payload:telemetry})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/localization/map',payload})).statusCode,200);assert.equal(JSON.parse(readFileSync(path,'utf8')).version,save.version);
  const stamp=statSync(path).mtimeMs;await app.inject({method:'POST',url:'/api/localization/map',payload});assert.equal(statSync(path).mtimeMs,stamp);
  await app.inject({method:'POST',url:'/api/robot/telemetry',headers,payload:{...telemetry,seq:2,running:true}});
  assert.equal((await app.inject({method:'POST',url:'/api/localization/map',payload})).statusCode,400);
  await app.inject({method:'POST',url:'/api/robot/telemetry',headers,payload:{...telemetry,seq:3,chassis:{connected:true,feedback:{vx:.08}}}});
  assert.equal((await app.inject({method:'POST',url:'/api/localization/map',payload})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/localization/map',payload:{...payload,version:99}})).statusCode,400);
  assert.deepEqual((await app.inject({method:'GET',url:'/api/robot/commands',headers})).json(),[]);
 }finally{writeFileSync(path,old);await app.close();}
});
