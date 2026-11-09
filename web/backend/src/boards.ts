import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import {boardCols,boardGridOptions,boardHeightMm,boardMinHeightMm,boardMinWidthMm,boardPrintSchema,boardRows,boardSchema,boardWidthMm,generateBoards,type Board} from '../../shared/boards';
import type {Store} from './store';
import {cells,label} from './tags';

export function boardOptions(){return {family:'tag36h11',paper:'A4',minId:0,maxId:586,gapMm:2,maxGroupSizeMm:180,grids:[1,2,3,4,5,6].map(boardGridOptions)};}
export function boardPlan(raw:unknown){
 const request=boardPrintSchema.parse(raw),boards=generateBoards(request);
 const first=boards[0]!;
 const rows=boardRows(first),cols=boardCols(first),widthMm=boardWidthMm(first),heightMm=boardHeightMm(first);
 const gridSize=Math.max(rows,cols),sizeMm=Math.max(widthMm,heightMm);
 const even=rows%2===0&&cols%2===0;
 const options=boardGridOptions(gridSize);
 const tileW=(widthMm-(cols-1)*2)/cols,tileH=(heightMm-(rows-1)*2)/rows;
 const centerCrosshairNote=!request.centerCrosshair?'已关闭中心十字，定位板尺寸和静区不变'
  :even?'整组中心十字四条独立线段各长约 10.5 mm、线宽 0.15 mm，沿中央白缝绘制'
  :rows===cols?`${rows}×${cols} 正中心是子码，没有安全白缝，无法画中心十字；请选择 2×2、4×4 或 6×6`
  :`${rows}×${cols} 的正中心不是安全白缝（行数或列数为奇数），无法画中心十字；请选择行数与列数均为偶数的规格`;
 const square=rows===cols&&widthMm===heightMm;
 const filename=`apriltag-boards-${boards[0]!.id}-${boards.at(-1)!.id}-${rows}x${cols}-${widthMm}${square?'':`x${heightMm}`}mm.pdf`;
 return {centerCrosshair:request.centerCrosshair,centerCrosshairAvailable:request.centerCrosshair&&even,centerCrosshairNote,groupCount:request.groupCount,memberCount:request.groupCount*rows*cols,pages:request.groupCount,
  childSizeMm:Math.min(tileW,tileH)/1.25,...options,rows,cols,widthMm,heightMm,sizeMm,gridSize,
  minWidthMm:boardMinWidthMm(cols),minHeightMm:boardMinHeightMm(rows),boards,filename};
}
/** 图案区正好widthMm×heightMm；成员标签全部置于阵列及白色静区外。 */
export const CENTER_CROSSHAIR_WIDTH_MM=.15;
export const CENTER_CROSSHAIR_GAP_MM=2;
export const CENTER_CROSSHAIR_SPAN_MM=10.5;
export function centerCrosshairGeometry(board:Board){
 const widthMm=boardWidthMm(board),heightMm=boardHeightMm(board),extent=Math.min(widthMm,heightMm),center=extent/2;
 // Perimeter markers are measured from the complete board boundary in mm.
 // Keep a 0.75mm end clearance; all four strokes point inward from the edge
 // and remain separate, with no geometry at the board centre.
 const edgeClearance=CENTER_CROSSHAIR_WIDTH_MM*5;
 const available=boardRows(board)%2===0&&boardCols(board)%2===0&&CENTER_CROSSHAIR_SPAN_MM+edgeClearance*2<=extent;
 const arm=available?Math.min(CENTER_CROSSHAIR_SPAN_MM,center-edgeClearance):0;
 return {available,center,centerX:widthMm/2,centerY:heightMm/2,widthMm,heightMm,arm,innerGap:edgeClearance,edgeClearance};
}
const round=(value:number)=>Number(value.toFixed(6));
export function boardSvg(board:Board,centerCrosshair=true,withLabels=false){
 const rows=boardRows(board),cols=boardCols(board),widthMm=boardWidthMm(board),heightMm=boardHeightMm(board);
 // 成员一律按保存的 x/y/size 画在整组板上：size 是子码黑边，含白静区的整格为其 1.25 倍。
 let shapes='';for(const member of board.members){
  const side=member.size*1.25*1000,cell=side/10;
  const x=round(member.x*1000+widthMm/2-side/2),y=round(heightMm/2-member.y*1000-side/2);
  for(const [cy,row] of cells(member.id).entries())for(const [cx,value] of row.entries())if(!value)shapes+=`<rect x="${round(x+cx*cell)}" y="${round(y+cy*cell)}" width="${round(cell)}" height="${round(cell)}"/>`;
 }
 // The viewBox uses millimetres. Each cell includes the complete white quiet zone;
 // Both 0.15mm strokes stay inside the 2mm central corridors, outside all cells.
 const crosshairGeometry=centerCrosshairGeometry(board);
 const e=crosshairGeometry.edgeClearance,a=crosshairGeometry.arm,cx=crosshairGeometry.centerX,cy=crosshairGeometry.centerY;
 const crosshair=!centerCrosshair?'':crosshairGeometry.available?`<g data-perimeter-crosshair="true" data-perimeter-lines="4" data-crosshair-safety="outer-white-margin" fill="none" stroke="black" stroke-width="${CENTER_CROSSHAIR_WIDTH_MM}" stroke-linecap="butt"><line x1="${cx}" y1="${e}" x2="${cx}" y2="${e+a}"/><line x1="${cx}" y1="${heightMm-e}" x2="${cx}" y2="${heightMm-e-a}"/><line x1="${e}" y1="${cy}" x2="${e+a}" y2="${cy}"/><line x1="${widthMm-e}" y1="${cy}" x2="${widthMm-e-a}" y2="${cy}"/></g>`:`<metadata data-perimeter-crosshair="omitted" data-crosshair-safety="insufficient-outer-margin">外侧白边不足，未绘制四边定位线</metadata>`;
 // 打印/PDF 只输出二维码板本体：默认不附带板号、规格、子码编号等标注区。
 const lines=Array.from({length:rows},(_,row)=>board.members.slice(row*cols,(row+1)*cols).map(member=>label(member.id)).join('  '));
 const extent=Math.min(widthMm,heightMm),titleFont=Math.min(4,extent/8),font=Math.min(3,extent/(Math.max(rows,cols)*10)),lineHeight=font*1.45,labelHeight=withLabels?16+lines.length*lineHeight:0;
 const totalH=heightMm+labelHeight;
 const spec=rows===cols&&widthMm===heightMm?`${rows}x${cols} · ${widthMm} mm`:`${rows}x${cols} · ${widthMm}x${heightMm} mm`;
 const labels=!withLabels?'':`<g font-family="Helvetica,Arial" fill="black" text-anchor="middle" font-size="${font}"><text x="${widthMm/2}" y="${heightMm+6}" font-size="${titleFont}">${board.id}</text><text x="${widthMm/2}" y="${heightMm+11}" font-size="${Math.min(3,extent/10)}">${spec}</text>${lines.map((line,index)=>`<text x="${widthMm/2}" y="${heightMm+16+index*lineHeight}">${line}</text>`).join('')}</g>`;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${totalH}mm" viewBox="0 0 ${widthMm} ${totalH}"><rect width="${widthMm}" height="${totalH}" fill="white"/><g fill="black" shape-rendering="crispEdges">${shapes}</g>${crosshair}${labels}</svg>`;
}
export async function boardPdf(boards:Board[],centerCrosshair=true):Promise<Buffer>{
 if(!boards.length)throw new Error('没有定位板');
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:28,autoFirstPage:false}),chunks:Buffer[]=[];
  doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  const mm=72/25.4;
  for(const board of boards){
   doc.addPage();
   // 打印/PDF 只输出二维码板本体：不含页眉标识、校准尺与尺寸说明。
   // SVG使用明确mm单位，不能设置assumePt，避免4/3错误放大。
   const widthMm=boardWidthMm(board),heightMm=boardHeightMm(board);
   SVGtoPDF(doc,boardSvg(board,centerCrosshair),(210-widthMm)/2*mm,(297-heightMm)/2*mm);
  }
  doc.end();
 });
}
/** Registration planning never blocks a user-specified repeat print. */
export function boardRegistrationPlan(_store:Store,raw:unknown){
 const plan=boardPlan(raw);
 return {...plan,registration:{available:true}};
}
export function boardTables(store:Store){store.db.exec('CREATE TABLE IF NOT EXISTS marker_boards(id TEXT PRIMARY KEY,reference_id INTEGER UNIQUE NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL);CREATE TABLE IF NOT EXISTS board_print_history(id INTEGER PRIMARY KEY AUTOINCREMENT,board_id TEXT NOT NULL,reference_id INTEGER NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL);');}
export function listBoards(store:Store):Board[]{return (store.db.prepare('SELECT body FROM marker_boards ORDER BY reference_id').all() as {body:string}[]).map(row=>boardSchema.parse(JSON.parse(row.body)));}

/** 重复打印不再阻断：已注册编号/板组允许再次生成。保留函数签名以兼容现有调用。 */
function boardConflict(message:string):never{throw Object.assign(new Error(message),{statusCode:409});}
/** 跨板成员冲突明细：只统计与“其他 board ID”的交集；同 id 走幂等/替换语义，不计冲突。 */
export function boardMemberConflicts(store:Store,boards:Board[]){
 const existing=listBoards(store),batchIds=new Set(boards.map(b=>b.id)),conflicts:{boardId:string,memberIds:number[]}[]=[];
 for(const board of boards){
  const members=new Set(board.members.map(m=>m.id));
  for(const other of existing){
   if(batchIds.has(other.id))continue;
   const overlap=other.members.filter(m=>members.has(m.id)).map(m=>m.id);
   if(overlap.length)conflicts.push({boardId:other.id,memberIds:overlap});
  }
 }
 return conflicts;
}
function conflictMessage(conflicts:{boardId:string,memberIds:number[]}[]){
 const parts=conflicts.map(c=>`${c.memberIds.slice(0,8).map(label).join('、')}${c.memberIds.length>8?` 等 ${c.memberIds.length} 个子码`:''} 已属于 ${c.boardId}`);
 return `跨板成员冲突，整批拒绝登记：${parts.join('；')}`;
}
/** Compatibility no-op: repeat prints never block registration. */
export function checkBoardRegistration(_store:Store,_boards:Board[]){return;}
export function registerBoards(store:Store,boards:Board[]){
 store.db.transaction(()=>{
  const now=new Date().toISOString();
  const history=store.db.prepare('INSERT INTO board_print_history(board_id,reference_id,body,created) VALUES(?,?,?,?)');
  const remove=store.db.prepare('DELETE FROM marker_boards WHERE id=?');
  const insert=store.db.prepare('INSERT INTO marker_boards(id,reference_id,body,created) VALUES(?,?,?,?)');
  const existing=listBoards(store);
  const byId=new Map(existing.map(item=>[item.id,item] as const));
  const batchIds=new Set(boards.map(b=>b.id));

  // 1) 每次打印都写历史（允许任意重叠，历史不做唯一性约束）
  for(const board of boards)history.run(board.id,board.referenceId,JSON.stringify(board),now);

  // 2) 确定“将被同 id 替换”的板：其旧成员在本批次内释放
  const replaced=new Set<string>();
  for(const board of boards){
   const same=byId.get(board.id);
   if(same&&JSON.stringify(same)!==JSON.stringify(board))replaced.add(board.id);
  }

  // 3) 计算本批次写入 marker_boards 后仍占用的成员：其他板（不含本批同 id）成员
  const kept=[...existing.filter(item=>!batchIds.has(item.id)&&!replaced.has(item.id))];

  // 4) 逐个决定是否可作为导航代表写入
  const accepted:Board[]=[];
  for(const board of boards){
   const same=byId.get(board.id);
   if(same&&JSON.stringify(same)===JSON.stringify(board))continue; // 幂等：不写不改
   const memberIds=new Set(board.members.map(m=>m.id));
   const conflict=kept.some(other=>other.members.some(m=>memberIds.has(m.id)))
     ||accepted.some(other=>other.members.some(m=>memberIds.has(m.id)));
   if(conflict)continue; // 与其他 board ID 成员交集非空 → 只留在历史
   accepted.push(board);
  }

  // 5) 应用：先删被替换的同 id 行，再插入合法代表
  for(const id of replaced)remove.run(id);
  for(const board of accepted){
   remove.run(board.id);
   insert.run(board.id,board.referenceId,JSON.stringify(board),now);
  }
 })();
}
