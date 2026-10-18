import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generate,defaults,validate,paths,exitPoint,heading,rule,envelopeInside,mapSchema} from '../web/shared/model';
import {Store} from '../web/backend/src/store';
import {cells,printPdf,tagSvg} from '../web/backend/src/tags';
import {mkdirSync,writeFileSync} from 'node:fs';

test('米制参数生成、旋转、唯一ID与正式导航草稿门禁',()=>{
 const m=generate({...defaults,angle:0,x:2,y:3});assert.equal(m.rows[0]!.points[1]!.x,10);assert.equal(m.rows[1]!.points[0]!.y,4.2);assert.equal(new Set(m.tags.map(t=>t.id)).size,m.tags.length);assert.deepEqual(validate(m).errors,[]);assert.equal(m.coordinateStatus,'draft');assert.ok(validate(m).warnings.some(w=>w.includes('禁止实体导航')));
 for(const angle of [0,90,180,-90,37])assert.deepEqual(validate(generate({...defaults,angle})).errors,[]);
});
test('倒车沿同一中心线、车体朝向不旋转180°、横移只在入口外',()=>{const m=generate(defaults),p=paths(m)[0]!;assert.deepEqual(p.reverse.slice(0,-1),[...m.rows[0]!.points].reverse());assert.equal(p.bodyYaw,p.reverseBodyYaw);assert.deepEqual(p.lateral[0],exitPoint(m.rows[0]!));assert.ok(envelopeInside(p.lateral[0]!,heading(m.rows[0]!),m));});
test('码本容量、非法输入与安全包络验证',()=>{assert.throws(()=>generate({...defaults,count:100,length:200,tagSpacing:0.2}));assert.throws(()=>generate({...defaults,tagSpacing:0}));assert.throws(()=>mapSchema.parse({...generate(defaults),family:'fake'}));const m=generate(defaults);m.tags[1]!.id=m.tags[0]!.id;m.rows[0]!.exitDistance=0.4;m.vehicle.length=2;const errors=validate(m).errors;assert.ok(errors.some(e=>e.includes('ID 重复')));assert.ok(errors.some(e=>e.includes('退出距离不足')));assert.ok(errors.some(e=>e.includes('包络')));});
test('SQLite多版本、进程重载数据与并发保存冲突',()=>{const db=new Store(':memory:'),m=generate(defaults);assert.equal(db.save(m,0).version,1);m.name='修订地图';assert.equal(db.save(m,1).version,2);assert.equal(db.get(m.id,1)!.map.name,'温室作物行地图');assert.equal(db.get(m.id)!.map.name,'修订地图');assert.throws(()=>db.save(m,1),/重新加载/);assert.equal(db.versions(m.id).length,2);db.close();});
test('打印真实SVG物理尺寸、PDF文件与全部官方码本检测输入',async()=>{
 const m=generate(defaults),t=m.tags[0]!;assert.match(tagSvg(t),/width="100mm"/);assert.match(tagSvg(t),/80.0 mm/);const pdf=await printPdf([t,m.tags[1]!]);assert.equal(pdf.subarray(0,4).toString(),'%PDF');
 const dir=new URL('../logs/print-verification/',import.meta.url);mkdirSync(dir,{recursive:true});writeFileSync(new URL('tags.pdf',dir),pdf);writeFileSync(new URL('tag.svg',dir),tagSvg(t));
 for(let id=0;id<587;id++){const matrix=cells(id);assert.equal(matrix.length,10);const rows=matrix.map(row=>row.map(c=>c?'0':'1').join(' ')).join('\n');writeFileSync(new URL(`${id}.pbm`,dir),`P1\n10 10\n${rows}\n`);}
 assert.throws(()=>cells(587));
});
