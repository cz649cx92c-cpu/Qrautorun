import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import {boardGridOptions,boardPrintSchema,boardSchema,generateBoards,type Board} from '../../shared/boards';
import type {Store} from './store';
import {cells,label} from './tags';

export function boardOptions(){return {family:'tag36h11',paper:'A4',minId:0,maxId:586,gapMm:2,maxGroupSizeMm:180,grids:[1,2,3,4,5,6].map(boardGridOptions)};}
export function boardPlan(raw:unknown){
 const request=boardPrintSchema.parse(raw),boards=generateBoards(request),options=boardGridOptions(request.gridSize);
 return {centerCrosshair:request.centerCrosshair,centerCrosshairAvailable:request.centerCrosshair&&request.gridSize%2===0,centerCrosshairNote:!request.centerCrosshair?'已关闭中心十字，定位板尺寸和静区不变':request.gridSize%2===0?'整组中心十字四条独立线段各长约 10.5 mm、线宽 0.15 mm，沿中央白缝绘制':request.gridSize+'×'+request.gridSize+' 正中心是子码，没有安全白缝，无法画中心十字；请选择 2×2、4×4 或 6×6',groupCount:request.groupCount,memberCount:request.groupCount*request.gridSize**2,pages:request.groupCount,
  childSizeMm:(request.groupSizeMm-(request.gridSize-1)*2)/request.gridSize/1.25,...options,boards,
  filename:`apriltag-boards-${boards[0]!.id}-${boards.at(-1)!.id}-${request.gridSize}x${request.gridSize}-${request.groupSizeMm}mm.pdf`};
}
/** 图案区正好sizeMm×sizeMm；成员标签全部置于阵列及白色静区外。 */
export const CENTER_CROSSHAIR_WIDTH_MM=.15;
export const CENTER_CROSSHAIR_GAP_MM=2;
export const CENTER_CROSSHAIR_SPAN_MM=10.5;
export function centerCrosshairGeometry(board:Board){
 const size=board.sizeMm,center=size/2;
 // Perimeter markers are measured from the complete board boundary in mm.
 // Keep a 0.75mm end clearance; all four strokes point inward from the edge
 // and remain separate, with no geometry at the board centre.
 const edgeClearance=CENTER_CROSSHAIR_WIDTH_MM*5;
 const available=board.gridSize%2===0&&CENTER_CROSSHAIR_SPAN_MM+edgeClearance*2<=size;
 const arm=available?Math.min(CENTER_CROSSHAIR_SPAN_MM,size/2-edgeClearance):0;
 return {available,center,arm,innerGap:edgeClearance,edgeClearance};
}
export function boardSvg(board:Board,centerCrosshair=true,withLabels=false){
 const size=board.sizeMm,tile=(size-(board.gridSize-1)*board.gapMm)/board.gridSize;
 let shapes='';for(const [index,member] of board.members.entries()){
  const x=(index%board.gridSize)*(tile+board.gapMm),y=Math.floor(index/board.gridSize)*(tile+board.gapMm),cell=tile/10;
  for(const [cy,row] of cells(member.id).entries())for(const [cx,value] of row.entries())if(!value)shapes+=`<rect x="${x+cx*cell}" y="${y+cy*cell}" width="${cell}" height="${cell}"/>`;
 }
 // The viewBox uses millimetres. tile includes the complete white quiet zone;
 // Both 0.15mm strokes stay inside the 2mm central corridors, outside all tiles.
 const crosshairGeometry=centerCrosshairGeometry(board);
 const e=crosshairGeometry.edgeClearance,a=crosshairGeometry.arm,c=crosshairGeometry.center;
 const crosshair=!centerCrosshair?'':crosshairGeometry.available?`<g data-perimeter-crosshair="true" data-perimeter-lines="4" data-crosshair-safety="outer-white-margin" fill="none" stroke="black" stroke-width="${CENTER_CROSSHAIR_WIDTH_MM}" stroke-linecap="butt"><line x1="${c}" y1="${e}" x2="${c}" y2="${e+a}"/><line x1="${c}" y1="${size-e}" x2="${c}" y2="${size-e-a}"/><line x1="${e}" y1="${c}" x2="${e+a}" y2="${c}"/><line x1="${size-e}" y1="${c}" x2="${size-e-a}" y2="${c}"/></g>`:`<metadata data-perimeter-crosshair="omitted" data-crosshair-safety="insufficient-outer-margin">外侧白边不足，未绘制四边定位线</metadata>`;
  // 打印/PDF 只输出二维码板本体：默认不附带板号、规格、子码编号等标注区。
  const lines=Array.from({length:board.gridSize},(_,row)=>board.members.slice(row*board.gridSize,(row+1)*board.gridSize).map(member=>label(member.id)).join('  '));
  const titleFont=Math.min(4,size/8),font=Math.min(3,size/(board.gridSize*10)),lineHeight=font*1.45,labelHeight=withLabels?16+lines.length*lineHeight:0;
  const totalH=size+labelHeight;
  const labels=!withLabels?'':`<g font-family="Helvetica,Arial" fill="black" text-anchor="middle" font-size="${font}"><text x="${size/2}" y="${size+6}" font-size="${titleFont}">${board.id}</text><text x="${size/2}" y="${size+11}" font-size="${Math.min(3,size/10)}">${board.gridSize}x${board.gridSize} · ${size} mm</text>${lines.map((line,index)=>`<text x="${size/2}" y="${size+16+index*lineHeight}">${line}</text>`).join('')}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}mm" height="${totalH}mm" viewBox="0 0 ${size} ${totalH}"><rect width="${size}" height="${totalH}" fill="white"/><g fill="black" shape-rendering="crispEdges">${shapes}</g>${crosshair}${labels}</svg>`;
}
export async function boardPdf(boards:Board[],centerCrosshair=true):Promise<Buffer>{
 if(!boards.length)throw new Error('没有定位板');
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:28,autoFirstPage:false}),chunks:Buffer[]=[];
  doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  const mm=72/25.4;
  for(const [index,board] of boards.entries()){
   doc.addPage();
   // 打印/PDF 只输出二维码板本体：不含页眉标识、校准尺与尺寸说明。
   // SVG使用明确mm单位，不能设置assumePt，避免4/3错误放大。
   SVGtoPDF(doc,boardSvg(board,centerCrosshair),(210-board.sizeMm)/2*mm,(297-board.sizeMm)/2*mm);
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
