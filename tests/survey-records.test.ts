import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {defaults} from '../web/shared/model';

test('扫描记录：统计、活动保护、地图引用保护、持久删除及观测清理',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qr-survey-delete-')),database=join(dir,'test.db');
 const app=await createApp(database);
 let removedId='';
 try{
  const first=(await app.inject({method:'POST',url:'/api/survey/start',payload:{name:'同名扫描'}})).json();
  let summaries=(await app.inject('/api/surveys')).json();
  assert.equal(summaries[0].deletable,false);assert.equal(summaries[0].protectedReason,'采集中');
  assert.equal((await app.inject({method:'DELETE',url:'/api/surveys/'+first.id})).statusCode,409);
  const samples=[1,2].map(stamp=>({stamp,pose:{x:0,y:0,yaw:0},tags:[{id:3,x:0,y:0,angle:0,sigma:.02},{id:8,x:1,y:0,angle:0,sigma:.02}],calibrated:true,synchronized:true}));
  await app.inject({method:'POST',url:'/api/survey/import',payload:{sessionId:first.id,samples}});
  await app.inject({method:'POST',url:'/api/survey/stop',payload:{}});
  summaries=(await app.inject('/api/surveys')).json();assert.equal(summaries[0].groupCount,2);assert.equal(summaries[0].sampleCount,2);assert.equal(summaries[0].deletable,true);
  const {map}=(await app.inject({method:'POST',url:'/api/maps/generate',payload:defaults})).json();map.id='scan-'+first.id.replaceAll('-','');
  await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});
  summaries=(await app.inject('/api/surveys')).json();assert.equal(summaries[0].deletable,true);assert.equal(summaries[0].mapId,map.id);assert.equal(summaries[0].protectedReason,null);
  assert.equal((await app.inject({method:'DELETE',url:'/api/surveys/'+first.id})).statusCode,200);
  assert.equal((await app.inject('/api/maps/'+map.id)).statusCode,404);
  const second=(await app.inject({method:'POST',url:'/api/survey/start',payload:{name:'同名扫描'}})).json();removedId=second.id;
  await app.inject({method:'POST',url:'/api/survey/import',payload:{sessionId:second.id,samples}});
  await app.inject({method:'POST',url:'/api/survey/stop',payload:{}});
  const deleted=await app.inject({method:'DELETE',url:'/api/surveys/'+second.id});assert.equal(deleted.statusCode,200);assert.equal(deleted.json().sampleCount,2);
  assert.equal((await app.inject('/api/surveys')).json().length,0);
  assert.equal((await app.inject('/api/surveys/'+second.id)).statusCode,404);
  assert.equal((await app.inject({method:'DELETE',url:'/api/surveys/'+second.id})).statusCode,404);
  assert.equal((await app.inject('/api/maps/'+map.id)).statusCode,404);
  assert.equal((await app.inject('/api/surveys/'+first.id)).statusCode,404);
 }finally{await app.close();}
 try{
  const store=new Store(database);try{
   assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM survey_sessions WHERE id=?').get(removedId) as {n:number}).n,0);
   assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM survey_samples WHERE session_id=?').get(removedId) as {n:number}).n,0);
  }finally{store.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
