import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import {boardGridOptions,boardPrintSchema,boardSchema,generateBoards,type Board} from '../../shared/boards';
import type {Store} from './store';
import {cells,label} from './tags';

export function boardOptions(){return {family:'tag36h11',paper:'A4',minId:0,maxId:586,gapMm:2,maxGroupSizeMm:180,grids:[1,2,3,4,5,6].map(boardGridOptions)};}
export function boardPlan(raw:unknown){
 const request=boardPrintSchema.parse(raw),boards=generateBoards(request),options=boardGridOptions(request.gridSize);
 return {centerCrosshair:request.centerCrosshair,groupCount:request.groupCount,memberCount:request.groupCount*request.gridSize**2,pages:request.groupCount,
  childSizeMm:(request.groupSizeMm-(request.gridSize-1)*2)/request.gridSize/1.25,...options,boards,
  filename:`apriltag-boards-${boards[0]!.id}-${boards.at(-1)!.id}-${request.gridSize}x${request.gridSize}-${request.groupSizeMm}mm.pdf`};
}
/** 图案区正好sizeMm×sizeMm；成员标签全部置于阵列及白色静区外。 */
export const CENTER_CROSSHAIR_WIDTH_MM=.15;
export function boardSvg(board:Board,centerCrosshair=true){
 const size=board.sizeMm,tile=(size-(board.gridSize-1)*board.gapMm)/board.gridSize;
 let shapes='';for(const [index,member] of board.members.entries()){
  const x=(index%board.gridSize)*(tile+board.gapMm),y=Math.floor(index/board.gridSize)*(tile+board.gapMm),cell=tile/10;
  for(const [cy,row] of cells(member.id).entries())for(const [cx,value] of row.entries())if(!value)shapes+=`<rect x="${x+cx*cell}" y="${y+cy*cell}" width="${cell}" height="${cell}"/>`;
 }
 // The viewBox uses millimetres. tile includes the complete white quiet zone;
 // square-ended strokes stop exactly at the tile edges, leaving group gaps intact.
 const crosshair=centerCrosshair?`<g data-center-crosshair="true" fill="none" stroke="black" stroke-width="${CENTER_CROSSHAIR_WIDTH_MM}" stroke-linecap="butt">${board.members.map((member,index)=>{
  const x=(index%board.gridSize)*(tile+board.gapMm),y=Math.floor(index/board.gridSize)*(tile+board.gapMm),cx=x+tile/2,cy=y+tile/2;
  return `<line data-tag-id="${member.id}" x1="${x}" y1="${cy}" x2="${x+tile}" y2="${cy}"/><line data-tag-id="${member.id}" x1="${cx}" y1="${y}" x2="${cx}" y2="${y+tile}"/>`;
 }).join('')}</g>`:'';
 const lines=Array.from({length:board.gridSize},(_,row)=>board.members.slice(row*board.gridSize,(row+1)*board.gridSize).map(member=>label(member.id)).join('  '));
 const titleFont=Math.min(4,size/8),font=Math.min(3,size/(board.gridSize*10)),lineHeight=font*1.45,labelHeight=16+lines.length*lineHeight;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}mm" height="${size+labelHeight}mm" viewBox="0 0 ${size} ${size+labelHeight}"><rect width="${size}" height="${size+labelHeight}" fill="white"/><g fill="black" shape-rendering="crispEdges">${shapes}</g>${crosshair}<g font-family="Helvetica,Arial" fill="black" text-anchor="middle" font-size="${font}"><text x="${size/2}" y="${size+6}" font-size="${titleFont}">${board.id}</text><text x="${size/2}" y="${size+11}" font-size="${Math.min(3,size/10)}">${board.gridSize}x${board.gridSize} · ${size} mm</text>${lines.map((line,index)=>`<text x="${size/2}" y="${size+16+index*lineHeight}">${line}</text>`).join('')}</g></svg>`;
}
export async function boardPdf(boards:Board[],centerCrosshair=true):Promise<Buffer>{
 if(!boards.length)throw new Error('没有定位板');
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:28,autoFirstPage:false}),chunks:Buffer[]=[];
  doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  const mm=72/25.4;
  for(const [index,board] of boards.entries()){
   doc.addPage();doc.fontSize(9).text(`tag36h11 / ${board.id} / ${index+1} of ${boards.length}`,10*mm,7*mm,{lineBreak:false});
   // SVG使用明确mm单位，不能设置assumePt，避免4/3错误放大。
   SVGtoPDF(doc,boardSvg(board,centerCrosshair),(210-board.sizeMm)/2*mm,20*mm);
   doc.moveTo(10*mm,278*mm).lineTo(60*mm,278*mm).stroke();doc.fontSize(8).text('50 mm',63*mm,276*mm,{lineBreak:false});
   doc.fontSize(8).text('100% / ACTUAL SIZE',10*mm,285*mm,{lineBreak:false});
  }
  doc.end();
 });
}
export function boardTables(store:Store){store.db.exec('CREATE TABLE IF NOT EXISTS marker_boards(id TEXT PRIMARY KEY,reference_id INTEGER UNIQUE NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL);');}
export function listBoards(store:Store):Board[]{return (store.db.prepare('SELECT body FROM marker_boards ORDER BY reference_id').all() as {body:string}[]).map(row=>boardSchema.parse(JSON.parse(row.body)));}
function boardConflict(message:string):never{throw Object.assign(new Error(message),{statusCode:409});}
export function checkBoardRegistration(store:Store,boards:Board[]){
 const existing=listBoards(store),byMember=new Map(existing.flatMap(board=>board.members.map(member=>[member.id,board] as const)));
 for(const board of boards){
  const registered=existing.find(item=>item.id===board.id);
  if(registered&&JSON.stringify(registered)!==JSON.stringify(board))boardConflict(`${board.id}已有不同尺寸或规格，不能覆盖已打印定位板`);
  for(const member of board.members){const used=byMember.get(member.id);if(used&&used.id!==board.id)boardConflict(`${label(member.id)}已属于${used.id}，请更换起始编号`);}
 }
}
export function registerBoards(store:Store,boards:Board[]){
 store.db.transaction(()=>{
  checkBoardRegistration(store,boards);
  const insert=store.db.prepare('INSERT INTO marker_boards(id,reference_id,body,created) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING');
  for(const board of boards)insert.run(board.id,board.referenceId,JSON.stringify(board),new Date().toISOString());
 })();
}
