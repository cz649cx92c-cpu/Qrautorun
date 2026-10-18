import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {compileScan,scanSettings} from '../web/backend/src/scan-map';
import {officeRoute} from '../web/backend/src/office-route';
import {exitPoint,validate} from '../web/shared/model';
const fixture=JSON.parse(readFileSync('tests/fixtures/office3-scan.json','utf8'));
const result=compileScan(fixture.result,scanSettings.parse({sessionId:'9e0efffc-bfff-4250-b8c1-c4cf4f6b9efe',name:'办公室3地图',rowWidth:.6,exitDistance:.8}),fixture.boards);
test('真实办公室3扫描：连接 B000→B032→B049→B016，坐标不变，转弯曲率不超过底盘限制',()=>{
 const map=result.map,row=map.rows[0]!,points=[exitPoint(row),...row.points];
 assert.deepEqual(map.tags.map(t=>t.id),[0,32,49,16]);assert.equal(map.routeMode,'waypoints');assert.deepEqual(validate(map).errors,[]);
 assert.ok(map.tags.every(t=>t.rowId===row.id));assert.equal(map.tags.at(-1)!.kind,'end');
 assert.deepEqual(points[0],{x:map.tags[0]!.x,y:map.tags[0]!.y});assert.deepEqual(points.at(-1),{x:map.tags.at(-1)!.x,y:map.tags.at(-1)!.y});
 for(const t of map.tags){const old=fixture.result.tags.find((v:any)=>v.id===t.id);assert.deepEqual([t.x,t.y,t.angle],[old.x,old.y,old.angle]);}
 for(let i=1;i<points.length-1;i++){
  const a=points[i-1]!,b=points[i]!,c=points[i+1]!,h1=Math.atan2(b.y-a.y,b.x-a.x),h2=Math.atan2(c.y-b.y,c.x-b.x);
  const k=Math.abs(Math.atan2(Math.sin(h2-h1),Math.cos(h2-h1)))/((Math.hypot(b.x-a.x,b.y-a.y)+Math.hypot(c.x-b.x,c.y-b.y))/2);assert.ok(k<.6,`${i}: ${k}`);
 }
});
test('无法连续前进的折返必须明确报错，不能静默丢掉后续定位板',()=>{
 assert.throws(()=>officeRoute([{x:0,y:0},{x:1,y:0},{x:0,y:0}]),/折返/);
 assert.throws(()=>officeRoute([{x:0,y:0},{x:.2,y:0},{x:.2,y:.2}]),/间距/);
});
writeFileSync(new URL('../logs/office3-generated.json',import.meta.url),JSON.stringify(result));
