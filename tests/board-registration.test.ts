import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {generateBoards} from '../web/shared/boards';
import {boardTables,registerBoards,boardRegistrationPlan} from '../web/backend/src/boards';
const batch={gridSize:4,groupSizeMm:100,groupCount:10,startId:0};
test('无连续空闲编号时不提供虚假起始号，检查仍不登记',()=>{
 const store=new Store(':memory:');boardTables(store);try{
  registerBoards(store,generateBoards({gridSize:1,groupSizeMm:20,groupCount:587,startId:0}));
  const original=store.db.prepare('SELECT * FROM marker_boards ORDER BY id').all();
  const plan=boardRegistrationPlan(store,batch);assert.equal(plan.registration.available,false);assert.equal('suggestedStartId' in plan.registration,false);assert.deepEqual(store.db.prepare('SELECT * FROM marker_boards ORDER BY id').all(),original);
 }finally{store.close();}
});
test('十组打印：提前指出Q049真冲突、预览不占号、显式空闲编号及同批重打',async()=>{
 const app=await createApp(':memory:');try{
  for(const seed of [{...batch,groupCount:3},{...batch,groupCount:4,startId:49},{...batch,groupCount:2,startId:300,groupSizeMm:140}])assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:seed})).statusCode,200);
  const original=(await app.inject('/api/boards')).body;
  const boards=generateBoards(batch);assert.deepEqual(boards.map(b=>b.referenceId),[0,16,32,48,64,80,96,112,128,144]);assert.equal(new Set(boards.flatMap(b=>b.members.map(m=>m.id))).size,160);
  const plan=await app.inject({method:'POST',url:'/api/boards/plan',payload:batch});assert.equal(plan.statusCode,200);assert.deepEqual(plan.json().registration,{available:false,message:'Q049已属于B049，请更换起始编号',suggestedStartId:113});
  assert.equal((await app.inject('/api/boards/preview.svg?gridSize=4&groupSizeMm=100&startId=0')).statusCode,200);assert.equal((await app.inject('/api/boards')).body,original);
  const conflict=await app.inject({method:'POST',url:'/api/boards/pdf',payload:batch});assert.equal(conflict.statusCode,409);assert.match(conflict.body,/Q049已属于B049/);assert.equal((await app.inject('/api/boards')).body,original,'失败不可部分登记');
  const free={...batch,startId:113};assert.equal((await app.inject({method:'POST',url:'/api/boards/plan',payload:free})).json().registration.available,true);assert.equal((await app.inject('/api/boards')).body,original);
  for(let i=0;i<2;i++)assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:free})).statusCode,200);
  const after=(await app.inject('/api/boards')).json();assert.equal(after.length,19);for(const b of JSON.parse(original))assert.deepEqual(after.find((item:any)=>item.id===b.id),b);
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{...batch,groupCount:4,startId:49}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{...batch,groupCount:4,startId:49,groupSizeMm:140}})).statusCode,409);
 }finally{await app.close();}
});
test('批量登记事务：SQL中途失败全回滚；相同重打不改旧board、地图及任务原行',()=>{
 const store=new Store(':memory:');boardTables(store);try{
  store.db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT,updated TEXT);');
  store.db.prepare('INSERT INTO versions VALUES(?,?,?,?,?)').run('old',1,'旧地图','old','unchanged geometry');store.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run('old-task','unchanged task','old-time');
  registerBoards(store,generateBoards({...batch,groupCount:1,startId:49}));
  const snapshot=()=>['marker_boards','versions','tasks'].map(table=>store.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all());const before=snapshot();
  store.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON marker_boards WHEN NEW.reference_id=129 BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  assert.throws(()=>registerBoards(store,generateBoards({...batch,startId:113})),/fixture failure/);assert.deepEqual(snapshot(),before);store.db.exec('DROP TRIGGER fail_second;');
  registerBoards(store,generateBoards({...batch,startId:113}));const saved=snapshot();registerBoards(store,generateBoards({...batch,startId:113}));assert.deepEqual(snapshot(),saved);assert.deepEqual(saved.slice(1),before.slice(1));
 }finally{store.close();}
});
