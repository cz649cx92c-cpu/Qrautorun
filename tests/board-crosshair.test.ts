import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {mkdirSync,writeFileSync} from 'node:fs';
import {boardSvg,boardPdf,boardPlan,CENTER_CROSSHAIR_WIDTH_MM,CENTER_CROSSHAIR_GAP_MM,centerCrosshairGeometry} from '../web/backend/src/boards';
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

test('定位板十字线：每整组仅中心白缝一枚，奇数阵列无安全空隙则跳过',()=>{
 assert.equal(boardPrintSchema.parse(request).centerCrosshair,true);assert.equal(CENTER_CROSSHAIR_WIDTH_MM,.15);assert.equal(CENTER_CROSSHAIR_GAP_MM,2);
 for(let gridSize=1;gridSize<=6;gridSize++){
  const board=generateBoards({...request,gridSize,startId:0})[0]!,tile=(board.sizeMm-(gridSize-1)*board.gapMm)/gridSize;
  const on=boardSvg(board),off=boardSvg(board,false),lines=[...on.matchAll(/<line [^>]+\/>/g)].map(m=>numbers(m[0]));
  assert.equal(lines.length,gridSize%2===0?2:0);assert.doesNotMatch(off,/data-center-crosshair|<line /);assert.equal(on.replace(/<g data-center-crosshair="true"[^>]*>[\s\S]*?<\/g>/,'').replace(/<metadata[^>]*>[\s\S]*?<\/metadata>/,''),off);
  if(gridSize%2){assert.match(on,/data-center-crosshair="omitted"/);assert.match(on,/data-crosshair-safety="no-central-gap"/);assert.equal(centerCrosshairGeometry(board).available,false);continue;}
  assert.match(on,/data-crosshair-safety="central-group-gap"/);const geometry=centerCrosshairGeometry(board);assert.equal(geometry.available,true);
  const horizontal=lines[0]!,vertical=lines[1]!;close(horizontal.y1!,board.sizeMm/2);close(horizontal.y2!,board.sizeMm/2);close(vertical.x1!,board.sizeMm/2);close(vertical.x2!,board.sizeMm/2);close(horizontal.x2!-horizontal.x1!,board.gapMm-CENTER_CROSSHAIR_WIDTH_MM);close(vertical.y2!-vertical.y1!,board.gapMm-CENTER_CROSSHAIR_WIDTH_MM);assert.ok(tile>board.members[0]!.size*1000);
 }
});
test('PDF内容流：开启包含0.15mm十字笔画，关闭不包含，50mm尺与100% ACTUAL SIZE保持一致',async()=>{
 const boards=generateBoards(request),on=await boardPdf(boards),off=await boardPdf(boards,false),odd=await boardPdf(generateBoards({...request,gridSize:3})),a=contentStreams(on),b=contentStreams(off),oddStream=contentStreams(odd);
 assert.equal(on.subarray(0,4).toString(),'%PDF');assert.equal(off.subarray(0,4).toString(),'%PDF');
 assert.equal((a.match(/(?:^|\n)0\.15 w(?:\n|$)/g)??[]).length,2);assert.equal((oddStream.match(/(?:^|\n)0\.15 w(?:\n|$)/g)??[]).length,0);
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
