import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {generateBoards} from '../web/shared/boards';
import {boardTables,registerBoards,boardRegistrationPlan} from '../web/backend/src/boards';
const batch={gridSize:4,groupSizeMm:100,groupCount:10,startId:0};
test('跨板成员重叠：计划允许且数据库保持唯一合法代表',()=>{
 const store=new Store(':memory:');boardTables(store);try{
  registerBoards(store,generateBoards({gridSize:1,groupSizeMm:20,groupCount:587,startId:0}));
  const original=store.db.prepare('SELECT * FROM marker_boards ORDER BY id').all();
  const plan=boardRegistrationPlan(store,batch);assert.equal(plan.registration.available,true);assert.equal('suggestedStartId' in plan.registration,false);assert.deepEqual(store.db.prepare('SELECT * FROM marker_boards ORDER BY id').all(),original);
 }finally{store.close();}
});
test('十组打印：重叠编号/幂等重打/同板换规格均可打印，导航清单保持唯一',async()=>{
 const app=await createApp(':memory:');try{
  for(const seed of [{...batch,groupCount:3},{...batch,groupCount:4,startId:49},{...batch,groupCount:2,startId:300,groupSizeMm:140}])assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:seed})).statusCode,200);
  const original=(await app.inject('/api/boards')).body;
  const boards=generateBoards(batch);assert.deepEqual(boards.map(b=>b.referenceId),[0,16,32,48,64,80,96,112,128,144]);assert.equal(new Set(boards.flatMap(b=>b.members.map(m=>m.id))).size,160);
  const plan=await app.inject({method:'POST',url:'/api/boards/plan',payload:batch});assert.equal(plan.statusCode,200);const reg=plan.json().registration;assert.equal(reg.available,true);
  assert.equal((await app.inject('/api/boards/preview.svg?gridSize=4&groupSizeMm=100&startId=0')).statusCode,200);const beforeReprint=JSON.parse((await app.inject('/api/boards')).body);for(const b of JSON.parse(original))assert.deepEqual(beforeReprint.find((item:any)=>item.id===b.id),b,'原板应保持不变');
  const conflict=await app.inject({method:'POST',url:'/api/boards/pdf',payload:batch});assert.equal(conflict.statusCode,200,'重复编号应允许下载');assert.ok(conflict.rawPayload.length>1000);
  const free={...batch,startId:113};assert.equal((await app.inject({method:'POST',url:'/api/boards/plan',payload:free})).json().registration.available,true);const afterFree=JSON.parse((await app.inject('/api/boards')).body);for(const b of JSON.parse(original))assert.deepEqual(afterFree.find((item:any)=>item.id===b.id),b,'原板应保持不变');
  for(let i=0;i<2;i++)assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:free})).statusCode,200);
  const after=(await app.inject('/api/boards')).json();assert.ok(after.length>=1,'导航板清单不得清空');for(const b of JSON.parse(original))assert.deepEqual(after.find((item:any)=>item.id===b.id),b,'原板应保持不变');
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{...batch,groupCount:4,startId:49}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{...batch,groupCount:4,startId:49,groupSizeMm:140}})).statusCode,200,'不同尺寸重打应允许');
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

test('重复打印语义：历史可重复、代表表保持唯一、同板换规格替换',async()=>{
 const app=await createApp(':memory:');try{
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{gridSize:4,groupSizeMm:100,groupCount:1,startId:0}})).statusCode,200);
  const b000=async()=>JSON.parse((await app.inject('/api/boards')).body).find((b:any)=>b.id==='B000');
  const before=await b000();
  const plan=await app.inject({method:'POST',url:'/api/boards/plan',payload:{gridSize:2,groupSizeMm:140,groupCount:1,startId:4}});
  assert.equal(plan.statusCode,200);assert.equal(plan.json().registration.available,true);
  const rejected=await app.inject({method:'POST',url:'/api/boards/pdf',payload:{gridSize:2,groupSizeMm:140,groupCount:1,startId:4}});
  assert.equal(rejected.statusCode,200);assert.ok(rejected.rawPayload.length>1000);
  assert.deepEqual(await b000(),before);assert.equal((await app.inject('/api/boards')).json().length,1);
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{gridSize:2,groupSizeMm:140,groupCount:1,startId:0}})).statusCode,200,'同板换规格应允许并替换');
  const replaced=await b000();assert.equal(replaced.gridSize,2);assert.equal(replaced.sizeMm,140);assert.deepEqual(replaced.members.map((m:any)=>m.id),[0,1,2,3]);
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{gridSize:2,groupSizeMm:140,groupCount:1,startId:4}})).statusCode,200,'原冲突成员释放后应放行');
  assert.equal((await app.inject('/api/boards')).json().length,2);
  const snapshot=JSON.stringify((await app.inject('/api/boards')).json());
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{gridSize:2,groupSizeMm:140,groupCount:1,startId:0}})).statusCode,200,'幂等重打应允许');
  assert.equal(JSON.stringify((await app.inject('/api/boards')).json()),snapshot,'幂等重打不得改变登记');
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{gridSize:2,groupSizeMm:140,groupCount:1,startId:200}})).statusCode,200,'不冲突新批次应允许');
  assert.equal((await app.inject('/api/boards')).json().length,3);
 }finally{await app.close();}
});
