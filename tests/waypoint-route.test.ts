import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mapSchema,validate,generate,defaults} from '../web/shared/model';

test('office B016 waypoint route validates with dense curve points and unchanged board centres',()=>{
 const m=mapSchema.parse(JSON.parse(readFileSync(new URL('../maps/office-confirmed.json',import.meta.url),'utf8')));
 assert.equal(m.routeMode,'waypoints');assert.deepEqual(validate(m).errors,[]);
 const end=m.rows[0]!.points.at(-1)!,tag=m.tags.find(t=>t.id===16)!;
 assert.deepEqual(end,{x:tag.x,y:tag.y});assert.equal(tag.kind,'end');
 assert.equal(m.tags.find(t=>t.id===32)!.kind,'waypoint');assert.equal(tag.rowId,m.rows[0]!.id);
 const bad=structuredClone(m);bad.rows[0]!.points[1]=bad.rows[0]!.points[0]!;
 assert.ok(validate(bad).errors.some(x=>x.includes('控制点过近')));
 const rows=generate(defaults);rows.rows[0]!.exitDistance=.4;
 assert.ok(validate(rows).errors.some(x=>x.includes('后退退出距离')));
});
