import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import {createApp} from '../web/backend/src/server';
import {generate,defaults} from '../web/shared/model';
import {batchPlan,exportBatch} from '../web/backend/src/batch-print';
import {mkdirSync,writeFileSync} from 'node:fs';

test('整批打印：587唯一编号、A4尺寸与排版、原地图快照及无虚构坐标',async()=>{
 const all={source:'range',startId:0,endId:586,sizeMm:80,layout:'packed'};
 const plan=batchPlan(all);assert.equal(plan.count,587);assert.equal(plan.pages,147);assert.equal(plan.columns,2);assert.equal(plan.rows,2);
 assert.equal(batchPlan({...all,layout:'single'}).pages,587);
 assert.throws(()=>batchPlan({...all,startId:20,endId:19}),/结束ID/);
 assert.throws(()=>batchPlan({...all,sizeMm:151}));assert.throws(()=>batchPlan({...all,endId:587}));
 const result=await exportBatch({...all,startId:584,format:'bundle'}),zip=unzipSync(result.data);
 assert.equal(Buffer.from(zip['print-all.pdf']!.subarray(0,4)).toString(),'%PDF');assert.equal(Object.keys(zip).filter(k=>k.startsWith('svg/')).length,3);
 const csv=strFromU8(zip['markers.csv']!);assert.match(csv,/"586","Q586","80.000","","","","","printed-right","unassigned"/);assert.ok(!zip['map.json']);
 const map=generate({...defaults,count:1,length:1,startId:100});const snapshot=structuredClone(map);
 const mapped=unzipSync((await exportBatch({source:'map',map,layout:'packed',format:'bundle'})).data);
 assert.deepEqual(JSON.parse(strFromU8(mapped['map.json']!)),snapshot);assert.match(strFromU8(mapped['markers.csv']!),/map-snapshot/);assert.ok(mapped['placement.svg']);assert.deepEqual(map,snapshot);
 const duplicate=structuredClone(map);duplicate.tags[1]!.id=duplicate.tags[0]!.id;assert.throws(()=>batchPlan({source:'map',map:duplicate}),/ID重复/);
 assert.throws(()=>batchPlan({source:'map',map:{...map,tags:[]}}),/没有可打印/);
 const app=await createApp(':memory:');try{
  assert.equal((await app.inject({method:'POST',url:'/api/print/plan',payload:all})).json().pages,147);
  assert.equal((await app.inject({method:'POST',url:'/api/print/export',payload:{...all,startId:586,endId:586,format:'pdf'}})).rawPayload.subarray(0,4).toString(),'%PDF');
  assert.equal((await app.inject('/api/print/tag/586.svg?sizeMm=80')).statusCode,200);
  assert.equal((await app.inject('/api/print/tag/587.svg')).statusCode,400);
  assert.match((await app.inject('/api/print/tag/5.svg?sizeMm=80&x=2&y=3&angle=90')).body,/\(2.000, 3.000\)/);
 }finally{await app.close();}
});

test('固定A4网格PDF：1×1至4×4、尾页、尺寸超限及编号边界',async()=>{
 const app=await createApp(':memory:');try{
  for(const [gridSize,sizeMm] of [[1,120],[2,70],[3,45],[4,30]]){
   const count=gridSize!*gridSize!+1,request={source:'range',startId:500,endId:500+count-1,sizeMm,layout:'grid',gridSize,format:'pdf'};
   const plan=batchPlan(request);assert.equal(plan.columns,gridSize);assert.equal(plan.rows,gridSize);assert.equal(plan.pages,2);assert.equal(plan.perPage,gridSize!*gridSize!);
   assert.ok('maxSizeMm' in plan);assert.ok(typeof plan.maxSizeMm==='number');const maxSizeMm=plan.maxSizeMm;
   assert.ok(maxSizeMm>=sizeMm!);assert.throws(()=>batchPlan({...request,sizeMm:maxSizeMm+.1}));
   const response=await app.inject({method:'POST',url:'/api/print/export',payload:request});assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['content-type'],'application/pdf');assert.equal(response.rawPayload.subarray(0,4).toString(),'%PDF');assert.match(response.headers['content-disposition']!,new RegExp(`${gridSize}x${gridSize}\\.pdf`));
   const dir=new URL(`../logs/grid-print-verification/${gridSize}x${gridSize}/`,import.meta.url);mkdirSync(dir,{recursive:true});writeFileSync(new URL('tags.pdf',dir),response.rawPayload);
  }
  const options=await app.inject('/api/print/options');assert.equal(options.statusCode,200);
  for(const invalid of [{gridSize:0},{gridSize:5},{endId:587},{sizeMm:200}]){
   assert.equal((await app.inject({method:'POST',url:'/api/print/export',payload:{source:'range',startId:0,endId:10,sizeMm:30,layout:'grid',gridSize:4,...invalid}})).statusCode,400);
  }
 }finally{await app.close();}
});
