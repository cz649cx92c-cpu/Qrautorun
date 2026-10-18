import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {mkdirSync,writeFileSync} from 'node:fs';
import {boardSvg,boardPdf,boardPlan,CENTER_CROSSHAIR_WIDTH_MM} from '../web/backend/src/boards';
import {boardPrintSchema,generateBoards} from '../web/shared/boards';
import {createApp} from '../web/backend/src/server';
const request={gridSize:2,groupSizeMm:140,groupCount:1,startId:16};
function contentStreams(pdf:Buffer){
 const text=pdf.toString('latin1'),streams:string[]=[];
 for(const match of text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)){
  const data=Buffer.from(match[1]!,'latin1');try{streams.push(inflateSync(data).toString('latin1'));}catch{streams.push(data.toString('latin1'));}
 }return streams.join('\n');
}
const numbers=(line:string)=>Object.fromEntries([...line.matchAll(/(x1|x2|y1|y2|data-tag-id)="([^"]+)"/g)].map(m=>[m[1]!,Number(m[2])]));
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('定位板十字线：默认开启，中心精确、覆盖静区、0.15mm黑色直线，不改变标签或尺寸',()=>{
 assert.equal(boardPrintSchema.parse(request).centerCrosshair,true);assert.equal(CENTER_CROSSHAIR_WIDTH_MM,.15);
 for(let gridSize=1;gridSize<=6;gridSize++){
  const board=generateBoards({...request,gridSize,startId:0})[0]!,tile=(board.sizeMm-(gridSize-1)*2)/gridSize;
  const on=boardSvg(board),off=boardSvg(board,false);
  assert.match(on,/<g data-center-crosshair="true" fill="none" stroke="black" stroke-width="0.15" stroke-linecap="butt">/);
  assert.doesNotMatch(off,/data-center-crosshair|<line /);
  assert.equal(on.replace(/<g data-center-crosshair="true"[^>]*>[\s\S]*?<\/g>/,''),off);
  const lines=[...on.matchAll(/<line [^>]+\/>/g)].map(m=>numbers(m[0]));assert.equal(lines.length,board.members.length*2);
  board.members.forEach((member,i)=>{
   const horizontal=lines[i*2]!,vertical=lines[i*2+1]!,cx=board.sizeMm/2+member.x*1000,cy=board.sizeMm/2-member.y*1000;
   assert.equal(horizontal['data-tag-id'],member.id);assert.equal(vertical['data-tag-id'],member.id);
   close(horizontal.y1!,cy);close(horizontal.y2!,cy);close(vertical.x1!,cx);close(vertical.x2!,cx);
   close((horizontal.x1!+horizontal.x2!)/2,cx);close((vertical.y1!+vertical.y2!)/2,cy);
   close(horizontal.x2!-horizontal.x1!,tile);close(vertical.y2!-vertical.y1!,tile);assert.ok(tile>member.size*1000);
  });
  assert.equal(boardPlan({...request,gridSize,centerCrosshair:false}).childSizeMm,boardPlan({...request,gridSize,centerCrosshair:true}).childSizeMm);
 }
});
test('PDF内容流：开启包含0.15mm十字笔画，关闭不包含，50mm尺与100% ACTUAL SIZE保持一致',async()=>{
 const boards=generateBoards(request),on=await boardPdf(boards),off=await boardPdf(boards,false),a=contentStreams(on),b=contentStreams(off);
 assert.equal(on.subarray(0,4).toString(),'%PDF');assert.equal(off.subarray(0,4).toString(),'%PDF');
 assert.ok((a.match(/(?:^|\n)0\.15 w(?:\n|$)/g)??[]).length>=boards[0]!.members.length*2);
 assert.doesNotMatch(b,/(?:^|\n)0\.15 w(?:\n|$)/);
 for(const stream of [a,b]){
  const text=[...stream.matchAll(/<([0-9a-f]+)>/gi)].map(m=>Buffer.from(m[1]!,'hex').toString('latin1')).join('');
  assert.match(text,/50 mm/);assert.match(text,/100% \/ ACTUAL SIZE/);
  // The physical verification ruler is outside SVG transforms, in PDF points.
  const ruler=[...stream.matchAll(/([\d.]+) ([\d.]+) m\n([\d.]+) ([\d.]+) l\nS/g)].find(m=>Math.abs(Number(m[2])-278*72/25.4)<1e-5);
  assert.ok(ruler,'缺少278mm高度处的50mm校对尺');assert.ok(Math.abs((Number(ruler[3])-Number(ruler[1]))-50*72/25.4)<1e-5);
 }
 mkdirSync('logs/ui-restyle-print',{recursive:true});writeFileSync('logs/ui-restyle-print/crosshair-on.pdf',on);writeFileSync('logs/ui-restyle-print/crosshair-off.pdf',off);writeFileSync('logs/ui-restyle-print/crosshair-on.svg',boardSvg(boards[0]!));writeFileSync('logs/ui-restyle-print/crosshair-off.svg',boardSvg(boards[0]!,false));
});
test('实际API：预览/下载/重印遵循开关，false字符串不被强制转换为true，不改变已注册定位板',async()=>{
 const app=await createApp(':memory:');try{
  for(const enabled of [true,false]){
   const query=`gridSize=2&groupSizeMm=140&startId=16&centerCrosshair=${enabled}`;
   const svg=await app.inject('/api/boards/preview.svg?'+query);assert.equal(svg.statusCode,200,svg.body);assert.equal(svg.body.includes('data-center-crosshair'),enabled);
   const plan=await app.inject({method:'POST',url:'/api/boards/plan',payload:{...request,centerCrosshair:enabled}});assert.equal(plan.statusCode,200,plan.body);assert.equal(plan.json().centerCrosshair,enabled);
   const pdf=await app.inject({method:'POST',url:'/api/boards/pdf',payload:{...request,centerCrosshair:enabled}});assert.equal(pdf.statusCode,200,pdf.body);
   assert.equal(contentStreams(pdf.rawPayload).includes('0.15 w'),enabled);
   const reprint=await app.inject('/api/boards/B016.svg?centerCrosshair='+enabled);assert.equal(reprint.statusCode,200);assert.equal(reprint.body.includes('data-center-crosshair'),enabled);
  }
  assert.equal((await app.inject('/api/boards')).json().length,1);assert.equal((await app.inject('/api/boards')).json()[0].centerCrosshair,undefined);
  assert.equal((await app.inject('/api/boards/preview.svg?gridSize=2&groupSizeMm=140')).body.includes('data-center-crosshair'),true);
  assert.equal((await app.inject('/api/boards/preview.svg?gridSize=2&groupSizeMm=140&centerCrosshair=invalid')).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{...request,centerCrosshair:'false'}})).statusCode,400);
 }finally{await app.close();}
});
