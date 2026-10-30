import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {generateBoards} from '../web/shared/boards';
import {mapSchema,type FieldMap} from '../web/shared/model';

const boards=()=>generateBoards({gridSize:2,groupSizeMm:120,groupCount:3,startId:0});
function pointMap():FieldMap{
 const groups=boards();
 return mapSchema.parse({schemaVersion:1,id:'scan-inplace',name:'原地改间距',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],tags:groups.map((group,index)=>({id:group.referenceId,x:0,y:-index*.532,angle:0,size:group.sizeMm/1000,groupId:group.id,rowId:'',kind:'waypoint',rules:[]})),groups,zone:[{x:-1,y:-2},{x:1,y:-2},{x:1,y:1},{x:-1,y:1}],vehicle:{width:.4,length:.8,margin:.05},notes:'测试'});
}
async function fixture(run:(a:Awaited<ReturnType<typeof createApp>>,s:Store)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'qr-inplace-')),p=join(dir,'test.db'),a=await createApp(p),s=new Store(p);
 try{await run(a,s);}finally{s.close();await a.close();rmSync(dir,{recursive:true,force:true});}
}
const count=(s:Store,id:string)=>(s.db.prepare('SELECT COUNT(*) AS c FROM versions WHERE map_id=?').get(id) as {c:number}).c;

test('间距保存默认原地覆盖：版本号不变、历史版本数量不增加',async()=>{
 await fixture(async(a,s)=>{
  const map=pointMap();
  s.save(map,0);
  const ids=map.tags.map(tag=>tag.id);
  assert.equal((await a.inject('/api/maps/'+map.id)).json().version,1);
  const before=count(s,map.id);

  const first=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-equal-spacing`,payload:{baseVersion:1,ids,targetM:0.55}});
  assert.equal(first.statusCode,200,first.body);
  assert.equal(first.json().version,1,'原地覆盖后版本号必须不变');

  const second=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-equal-spacing`,payload:{baseVersion:1,ids,targetM:0.6}});
  assert.equal(second.statusCode,200,second.body);
  assert.equal(second.json().version,1);
  assert.equal(count(s,map.id),before,'原地覆盖不得新增版本行');

  const latest=(await a.inject('/api/maps/'+map.id)).json();
  const ys=ids.map(id=>latest.map.tags.find((t:{id:number})=>t.id===id).y).sort((x:number,y:number)=>y-x);
  for(let i=1;i<ys.length;i++){
   const gap=ys[i-1]-ys[i];
   assert.ok(Math.abs(gap-0.6)<0.002,`间距应为 60cm，实际 ${(gap*100).toFixed(2)}cm`);
  }
 });
});

test('newVersion:true 时仍可显式新建版本号',async()=>{
 await fixture(async(a,s)=>{
  const map=pointMap();
  s.save(map,0);
  const ids=map.tags.map(tag=>tag.id);
  const r=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-equal-spacing`,payload:{baseVersion:1,ids,targetM:0.55,newVersion:true}});
  assert.equal(r.statusCode,200,r.body);
  assert.equal(r.json().version,2,'显式新建版本应升号');
  assert.equal(count(s,map.id),2);
 });
});

test('原地覆盖仍保留 baseVersion 冲突保护',async()=>{
 await fixture(async(a,s)=>{
  const map=pointMap();
  s.save(map,0);
  const ids=map.tags.map(tag=>tag.id);
  const stale=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-equal-spacing`,payload:{baseVersion:99,ids,targetM:0.55}});
  assert.equal(stale.statusCode,409,'过期版本必须 409');
 });
});

test('单点改距离默认也是原地覆盖',async()=>{
 await fixture(async(a,s)=>{
  const map=pointMap();
  s.save(map,0);
  const before=count(s,map.id);
  const pair=[map.tags[0]!.id,map.tags[1]!.id];
  const r=await a.inject({method:'POST',url:`/api/maps/${map.id}/tag-distance`,payload:{baseVersion:1,fromId:pair[0],toId:pair[1],targetM:0.55}});
  assert.equal(r.statusCode,200,r.body);
  assert.equal(r.json().version,1);
  assert.equal(count(s,map.id),before);
 });
});
