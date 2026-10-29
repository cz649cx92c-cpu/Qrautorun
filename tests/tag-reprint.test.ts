import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../web/backend/src/server';
import {generateBoards} from '../web/shared/boards';
import {defaults,generate} from '../web/shared/model';
import {tagSvg} from '../web/backend/src/tags';
import Fastify from 'fastify';
import {Store} from '../web/backend/src/store';
import {registerTagReprintRoutes} from '../web/backend/src/tag-reprint';
import {boardTables,registerBoards} from '../web/backend/src/boards';
test('v4地图原码补打：原ID尺寸、单码/板组区分、原子只读及越界拒绝',async()=>{
 const app=await createApp(':memory:');try{
  const board=generateBoards({gridSize:4,groupSizeMm:100,groupCount:1,startId:100})[0]!;
  const map=generate({...defaults,count:1,angle:0});map.id='reprint-map';map.groups=[board];map.tags=[{...map.tags[0]!,id:100,groupId:board.id,size:.1,x:0,y:0},{...map.tags[0]!,id:200,size:.08,x:1,y:0}];
  assert.equal((await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{gridSize:4,groupSizeMm:100,groupCount:1,startId:100}})).statusCode,200);
  const beforeMap=(await app.inject('/api/maps/reprint-map')).body,beforeBoards=(await app.inject('/api/boards')).body;
  const url='/api/maps/reprint-map/tags/100/';
  const info=await app.inject(url+'print-info?version=1');assert.equal(info.statusCode,200,info.body);assert.equal(info.json().kind,'board');assert.equal(info.json().board.sizeMm,100);assert.equal(info.json().members[1].id,101);assert.equal(info.json().members[1].sizeMm,18.8);
  const child=await app.inject(url+'reprint.svg?version=1&target=member&memberId=101');assert.equal(child.statusCode,200,child.body);assert.equal(child.body,tagSvg({id:101,size:board.members[1]!.size}));
  const full=await app.inject(url+'reprint.svg?version=1&target=board');assert.equal(full.statusCode,200);assert.match(full.body,/width="100mm"/);assert.equal((full.body.match(/<line /g)??[]).length,4);assert.match(full.body,/stroke-width="0.15"/);
  assert.doesNotMatch((await app.inject(url+'reprint.svg?version=1&target=board&centerCrosshair=false')).body,/data-center-crosshair/);
  for(const suffix of ['reprint.pdf?version=1&target=board','reprint.pdf?version=1&target=member&memberId=101']){const pdf=await app.inject(url+suffix);assert.equal(pdf.statusCode,200,pdf.body);assert.equal(pdf.rawPayload.subarray(0,4).toString(),'%PDF');}
  const single='/api/maps/reprint-map/tags/200/';const singleInfo=(await app.inject(single+'print-info?version=1')).json();assert.equal(singleInfo.kind,'single');assert.equal(singleInfo.members[0].sizeMm,80);
  assert.equal((await app.inject(single+'reprint.svg?version=1&target=member')).body,tagSvg({id:200,size:.08}));assert.equal((await app.inject(single+'reprint.pdf?version=1&target=member')).statusCode,200);
  assert.equal((await app.inject(url+'reprint.pdf?version=1&target=member&memberId=200')).statusCode,404);assert.equal((await app.inject(url+'reprint.pdf?version=2&target=board')).statusCode,404);assert.equal((await app.inject(url+'reprint.pdf?version=1&target=board&sizeMm=120')).statusCode,400);
  assert.equal((await app.inject('/api/maps/reprint-map')).body,beforeMap);assert.equal((await app.inject('/api/boards')).body,beforeBoards);assert.deepEqual((await app.inject('/api/tasks')).json(),[]);
 }finally{await app.close();}
});
test('v4旧数据缺尺寸不伪造原规格，重印不再被注册冲突阻断',async()=>{
 const app=Fastify(),store=new Store(':memory:');boardTables(store);registerTagReprintRoutes(app,store);
 app.setErrorHandler((error,_req,reply)=>reply.code((error as {statusCode?:number}).statusCode??400).send({error:(error as Error).message}));
 try{
  const map=generate({...defaults,count:1,angle:0});map.id='legacy-no-size';const raw=JSON.parse(JSON.stringify(map));delete raw.tags[0].size;
  store.db.prepare('INSERT INTO versions VALUES(?,?,?,?,?)').run(map.id,1,map.name,'old-stamp',JSON.stringify(raw));
  const before=store.db.prepare('SELECT * FROM versions').all();const base=`/api/maps/${map.id}/tags/${raw.tags[0].id}/`;
  const info=await app.inject(base+'print-info');assert.equal(info.statusCode,200,info.body);assert.equal(info.json().members[0].sizeMm,null);assert.equal(info.json().printable,false);assert.match(info.json().unavailableReason,/缺少/);
  assert.equal((await app.inject(base+'reprint.pdf')).statusCode,422);assert.deepEqual(store.db.prepare('SELECT * FROM versions').all(),before);assert.deepEqual(store.db.prepare('SELECT * FROM marker_boards').all(),[]);
  const board=generateBoards({gridSize:2,groupSizeMm:100,groupCount:1,startId:100})[0]!;registerBoards(store,[board]);
  const other=generateBoards({gridSize:2,groupSizeMm:120,groupCount:1,startId:100})[0]!;
  raw.id='conflict-board';raw.tags=[{...map.tags[0],id:100,groupId:other.id,size:.12}];raw.groups=[other];store.db.prepare('INSERT INTO versions VALUES(?,?,?,?,?)').run(raw.id,1,map.name,'old-stamp',JSON.stringify(raw));
  const registered=store.db.prepare('SELECT * FROM marker_boards').all();const conflict=await app.inject('/api/maps/conflict-board/tags/100/reprint.pdf?target=board');assert.notEqual(conflict.statusCode,409,'重印不再被注册冲突阻断');
 }finally{await app.close();store.close();}
});
