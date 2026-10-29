import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {mkdirSync,writeFileSync} from 'node:fs';
import {boardSvg,boardPdf,boardPlan,CENTER_CROSSHAIR_WIDTH_MM,CENTER_CROSSHAIR_GAP_MM,CENTER_CROSSHAIR_SPAN_MM,centerCrosshairGeometry} from '../web/backend/src/boards';
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

test('定位板四边中点定位线：四条独立外侧线不相交且不触碰二维码安全区',()=>{
 assert.equal(boardPrintSchema.parse(request).centerCrosshair,true);assert.equal(CENTER_CROSSHAIR_WIDTH_MM,.15);assert.equal(CENTER_CROSSHAIR_GAP_MM,2);
 for(let gridSize=1;gridSize<=6;gridSize++){
  const board=generateBoards({...request,gridSize,startId:0})[0]!,size=board.sizeMm,center=size/2;
  const on=boardSvg(board),off=boardSvg(board,false),lines=[...on.matchAll(/<line [^>]+\/>/g)].map(m=>numbers(m[0]));
  assert.equal(lines.length,gridSize%2===0?4:0);assert.doesNotMatch(on,/data-center-crosshair|central-group-gap/);if(gridSize%2===0){assert.match(on,/data-perimeter-crosshair="true"/);assert.match(on,/data-perimeter-lines="4"/);}else assert.match(on,/data-perimeter-crosshair="omitted"/);assert.doesNotMatch(off,/data-perimeter-crosshair|<line /);
  const geometry=centerCrosshairGeometry(board);if(gridSize%2){assert.equal(geometry.available,false);continue;}assert.equal(geometry.available,true);assert.equal(geometry.center,center);assert.ok(geometry.arm<=CENTER_CROSSHAIR_SPAN_MM);
  assert.equal(lines.filter(line=>line.x1===line.x2).length,2);assert.equal(lines.filter(line=>line.y1===line.y2).length,2);
  const vertical=lines.filter(line=>line.x1===line.x2),horizontal=lines.filter(line=>line.y1===line.y2);
  for(const line of vertical){assert.equal(line.x1,center);assert.ok((line.y1===geometry.edgeClearance&&line.y2===geometry.edgeClearance+geometry.arm)||(line.y1===size-geometry.edgeClearance&&line.y2===size-geometry.edgeClearance-geometry.arm));}
  assert.ok(vertical.some(line=>line.y2<line.y1) || vertical.some(line=>line.y2>line.y1));
  for(const line of horizontal){assert.equal(line.y1,center);assert.ok(line.x1===geometry.edgeClearance||line.x1===size-geometry.edgeClearance);assert.ok(line.x2===geometry.edgeClearance+geometry.arm||line.x2===size-geometry.edgeClearance-geometry.arm);}
  assert.ok(!on.includes('data-center-crosshair'));
  const tile=(size-(gridSize-1)*board.gapMm)/gridSize;
  for(const line of lines){const half=CENTER_CROSSHAIR_WIDTH_MM/2;const stroke={left:Math.min(line.x1!,line.x2!)-half,right:Math.max(line.x1!,line.x2!)+half,top:Math.min(line.y1!,line.y2!)-half,bottom:Math.max(line.y1!,line.y2!)+half};for(let row=0;row<gridSize;row++)for(let column=0;column<gridSize;column++){const x=column*(tile+board.gapMm),y=row*(tile+board.gapMm);assert.ok(stroke.right<=x||stroke.left>=x+tile||stroke.bottom<=y||stroke.top>=y+tile,'外侧定位线不得接触二维码及完整静区');}}
 }
});
test('PDF内容流：开启包含0.15mm十字笔画，关闭不包含；打印只含二维码板本体，不含页眉/校准尺/尺寸说明',async()=>{
 const boards=generateBoards(request),on=await boardPdf(boards),off=await boardPdf(boards,false),odd=await boardPdf(generateBoards({...request,gridSize:3})),a=contentStreams(on),b=contentStreams(off),oddStream=contentStreams(odd);
 assert.equal(on.subarray(0,4).toString(),'%PDF');assert.equal(off.subarray(0,4).toString(),'%PDF');
 assert.equal((a.match(/(?:^|\n)0\.15 w(?:\n|$)/g)??[]).length,4);assert.equal((oddStream.match(/(?:^|\n)0\.15 w(?:\n|$)/g)??[]).length,0);
 assert.doesNotMatch(b,/(?:^|\n)0\.15 w(?:\n|$)/);
 for(const stream of [a,b]){
  const text=[...stream.matchAll(/<([0-9a-f]+)>/gi)].map(m=>Buffer.from(m[1]!,'hex').toString('latin1')).join('');
  // 打印输出只允许二维码板本体：页眉标识、校准尺、尺寸说明一律不得出现。
  assert.doesNotMatch(text,/tag36h11 \//,'PDF 不应含页眉码族标识');
  assert.doesNotMatch(text,/ACTUAL SIZE/,'PDF 不应含 ACTUAL SIZE 说明');
  assert.doesNotMatch(text,/50 mm/,'PDF 不应含 50mm 校准尺文字');
  const ruler=[...stream.matchAll(/([\d.]+) ([\d.]+) m\n([\d.]+) ([\d.]+) l\nS/g)].find(m=>Math.abs(Number(m[2])-278*72/25.4)<1e-5);
  assert.equal(ruler,undefined,'PDF 不应再绘制 278mm 高度处的校准尺');
  assert.ok(stream.length>1000,'PDF 内容流应包含二维码板本体');
 }
 mkdirSync('logs/ui-restyle-print',{recursive:true});writeFileSync('logs/ui-restyle-print/crosshair-on.pdf',on);writeFileSync('logs/ui-restyle-print/crosshair-off.pdf',off);writeFileSync('logs/ui-restyle-print/crosshair-on.svg',boardSvg(boards[0]!));writeFileSync('logs/ui-restyle-print/crosshair-off.svg',boardSvg(boards[0]!,false));
});
test('实际API：预览/下载/重印遵循开关，false字符串不被强制转换为true，不改变已注册定位板',async()=>{
 const app=await createApp(':memory:');try{
  for(const enabled of [true,false]){
   const query=`gridSize=2&groupSizeMm=140&startId=16&centerCrosshair=${enabled}`;
   const svg=await app.inject('/api/boards/preview.svg?'+query);assert.equal(svg.statusCode,200,svg.body);assert.equal(svg.body.includes('data-perimeter-crosshair'),enabled);
   const plan=await app.inject({method:'POST',url:'/api/boards/plan',payload:{...request,centerCrosshair:enabled}});assert.equal(plan.statusCode,200,plan.body);assert.equal(plan.json().centerCrosshair,enabled);
   const pdf=await app.inject({method:'POST',url:'/api/boards/pdf',payload:{...request,centerCrosshair:enabled}});assert.equal(pdf.statusCode,200,pdf.body);
   assert.equal(contentStreams(pdf.rawPayload).includes('0.15 w'),enabled);
   const reprint=await app.inject('/api/boards/B016.svg?centerCrosshair='+enabled);assert.equal(reprint.statusCode,200);assert.equal(reprint.body.includes('data-perimeter-crosshair'),enabled);
  }
  assert.equal((await app.inject('/api/boards')).json().length,1);assert.equal((await app.inject('/api/boards')).json()[0].centerCrosshair,undefined);
  assert.equal((await app.inject('/api/boards/preview.svg?gridSize=2&groupSizeMm=140')).body.includes('data-perimeter-crosshair'),true);
  assert.equal((await app.inject('/api/boards/preview.svg?gridSize=2&groupSizeMm=140&centerCrosshair=invalid')).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/boards/pdf',payload:{...request,centerCrosshair:'false'}})).statusCode,400);
 }finally{await app.close();}
});
