import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../web/backend/src/store';
import {surveyTables,createSurvey,appendSamples,getSurvey,sampleSchema,listSurveys,deleteSurvey} from '../web/backend/src/survey';
import {createApp} from '../web/backend/src/server';
import {generate,defaults} from '../web/shared/model';

test('真实格式草稿采集：保存未验证时戳、禁止升级和混合定位原点',()=>{
 const store=new Store(':memory:');try{
  surveyTables(store);const session=createSurvey(store,'草稿');
  const sample={stamp:1,pose:{x:0,y:0,yaw:0},tags:[{id:0,x:.1,y:0,sigma:.02}],calibrated:true,synchronized:false,quality:'draft',timestampSource:'server_receive',localEpoch:'epoch-one'};
  appendSamples(store,session.id,[sample]);const s=getSurvey(store,session.id);assert.equal(s.captureQuality,'draft');assert.equal(s.samples[0].synchronized,false);
  assert.throws(()=>sampleSchema.parse({...sample,quality:'verified'}));
  assert.throws(()=>sampleSchema.parse({...sample,synchronized:true}));
  assert.throws(()=>appendSamples(store,session.id,[{...sample,stamp:2,localEpoch:'epoch-two'}]),/原点/);
  assert.equal(getSurvey(store,session.id).samples.length,1);
 }finally{store.close();}
});

test('草稿地图：不得确认或启动实体导航',async()=>{
 const app=await createApp(':memory:');try{
  const map={...generate(defaults),captureQuality:'draft'};
  await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});
  const accepted=await app.inject({method:'POST',url:'/api/maps/accept',payload:{mapId:map.id,version:1,operator:'离线检查',measurements:map.tags.slice(0,3).map(t=>({id:t.id,x:t.x,y:t.y}))}});
  assert.equal(accepted.statusCode,400);assert.match(accepted.body,/草稿/);
  await app.inject({method:'POST',url:'/api/tasks',payload:{id:'draft',name:'草稿任务',mapId:map.id,mapVersion:1,rowOrder:map.order,forwardSpeed:.1,reverseSpeed:.08,lateralSpeed:.05,endWaitSeconds:2,enabled:true}});
  const start=await app.inject({method:'POST',url:'/api/navigation/start',payload:{taskId:'draft'}});
  assert.equal(start.statusCode,423);assert.match(start.body,/草稿/);
 }finally{await app.close();}
});

test('点位草稿与扫描记录可一并删除，保留导航地图的保护',()=>{
 const store=new Store(':memory:');try{
  store.db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT,updated TEXT)');
  surveyTables(store);const s=createSurvey(store,'点位草稿');
  store.db.prepare('UPDATE survey_sessions SET state=? WHERE id=?').run('stopped',s.id);
  const map={...generate(defaults),id:'draft-scan-'+s.id.replaceAll('-',''),source:'survey',captureQuality:'draft',rows:[],order:[]};
  store.save(map,0);assert.equal(listSurveys(store)[0]!.deletable,true);
  assert.equal(listSurveys(store)[0]!.mapId,map.id);deleteSurvey(store,s.id);
  assert.equal(store.get(map.id),null);assert.equal(listSurveys(store).length,0);
 }finally{store.close();}
});
