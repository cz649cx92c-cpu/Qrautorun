import family from '../../assets/tag36h11.json' with {type:'json'};
import type { FieldMap, Tag } from '../../shared/model';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
export const label=(id:number)=>`Q${String(id).padStart(3,'0')}`;
export const escapeXml=(s:string)=>s.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]!));
// 精确移植官方 apriltag_to_image；黑色外边界宽8格，白色静区后总宽10格。
export function cells(id:number):number[][] {
 if(!Number.isInteger(id)||id<0||id>=family.codes.length) throw new Error('AprilTag ID 必须为 0–586');
 const out=Array.from({length:10},(_,y)=>Array.from({length:10},(_,x)=>x===0||x===9||y===0||y===9?1:0));
 const code=BigInt('0x'+family.codes[id]);for(let i=0;i<36;i++) if(code&(1n<<BigInt(35-i))) out[family.bitY[i]!+1]![family.bitX[i]!+1]=1;
 return out;
}
export type PrintableTag=Pick<Tag,'id'|'size'> & Partial<Pick<Tag,'x'|'y'|'angle'|'rowId'>>;
export function tagSvg(tag:PrintableTag) {
 const sizeMM=tag.size*1000,cell=sizeMM/8,total=cell*10,labelFont=Math.min(5,total/20),detailFont=Math.min(3.5,total/32);
 let rects=''; for(const [y,row] of cells(tag.id).entries()) for(const [x,v] of row.entries()) if(!v) rects+=`<rect x="${x*cell}" y="${y*cell}" width="${cell}" height="${cell}"/>`;
 const placement=tag.x!==undefined&&tag.y!==undefined&&tag.angle!==undefined?`(${tag.x.toFixed(3)}, ${tag.y.toFixed(3)}) m / ${tag.angle.toFixed(1)} deg`:'POSITION ASSIGNED AFTER SURVEY';
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}mm" height="${total+22}mm" viewBox="0 0 ${total} ${total+22}"><rect width="${total}" height="${total+22}" fill="white"/><g fill="black" shape-rendering="crispEdges">${rects}</g><g font-family="Helvetica,Arial" fill="black" text-anchor="middle"><text x="${total/2}" y="${total+6}" font-size="${labelFont}">${label(tag.id)} · tag36h11 · ${sizeMM.toFixed(1)} mm</text><text x="${total/2}" y="${total+12}" font-size="${detailFont}">${placement}</text><text x="${total/2}" y="${total+18}" font-size="${detailFont}">PRINT +X RIGHT -&gt; | NO SCALING</text></g></svg>`;
}
export type PrintLayout='packed'|'single'|'grid';
const gridArea={x:10,y:17,width:190,height:252,padding:2,labelHeight:9};
export function gridPrintOptions(gridSize:number) {
 if(!Number.isInteger(gridSize)||gridSize<1||gridSize>4)throw new Error('每页规格必须为1×1、2×2、3×3或4×4');
 const slotWidth=gridArea.width/gridSize,slotHeight=gridArea.height/gridSize;
 // size 是黑色外边界；官方白色静区使图案总宽为其1.25倍。
 const maxSizeMm=Math.floor(Math.min(150,(slotWidth-2*gridArea.padding)/1.25,(slotHeight-2*gridArea.padding-gridArea.labelHeight)/1.25)*1000)/1000;
 return {gridSize,columns:gridSize,rows:gridSize,perPage:gridSize*gridSize,minSizeMm:20,maxSizeMm,slotWidth,slotHeight};
}
function gridTagSvg(tag:PrintableTag) {
 const sizeMm=tag.size*1000,cell=sizeMm/8,total=cell*10;
 let rects='';for(const [y,row] of cells(tag.id).entries())for(const [x,v] of row.entries())if(!v)rects+=`<rect x="${x*cell}" y="${y*cell}" width="${cell}" height="${cell}"/>`;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}mm" height="${total+gridArea.labelHeight}mm" viewBox="0 0 ${total} ${total+gridArea.labelHeight}"><rect width="${total}" height="${total+gridArea.labelHeight}" fill="white"/><g fill="black" shape-rendering="crispEdges">${rects}</g><g font-family="Helvetica,Arial" fill="black" text-anchor="middle"><text x="${total/2}" y="${total+4}" font-size="4">${label(tag.id)}</text><text x="${total/2}" y="${total+8}" font-size="2.5">${Number(sizeMm.toFixed(3))} mm</text></g></svg>`;
}
export function printLayout(tags:PrintableTag[],layout:PrintLayout='single',gridSize=1) {
 if(!tags.length)throw new Error('没有可打印的标记');
 if(new Set(tags.map(t=>t.id)).size!==tags.length)throw new Error('AprilTag ID重复，不能打印');
 for(const tag of tags){cells(tag.id);if(!Number.isFinite(tag.size)||tag.size<.02||tag.size>.15)throw new Error('黑边尺寸必须为20–150mm');}
 if(layout==='grid') {
  const options=gridPrintOptions(gridSize);
  if(tags.some(tag=>tag.size*1000>options.maxSizeMm+1e-8))throw new Error(`${gridSize}×${gridSize}规格的黑边尺寸最大为${options.maxSizeMm}mm`);
  return {...options,pages:Math.ceil(tags.length/options.perPage)};
 }
 const width=Math.max(...tags.map(t=>t.size*1000*1.25));
 const slotWidth=Math.max(width,65),slotHeight=width+28;
 const columns=layout==='single'?1:Math.max(1,Math.floor((200+1e-8)/slotWidth));
 const rows=layout==='single'?1:Math.max(1,Math.floor(260/slotHeight));
 return {columns,rows,perPage:columns*rows,pages:Math.ceil(tags.length/(columns*rows)),slotHeight};
}
export async function printPdf(tags:PrintableTag[],layout:PrintLayout='single',gridSize=1):Promise<Buffer> {
 const plan=printLayout(tags,layout,gridSize);
 return new Promise((resolve,reject)=>{const doc=new PDFDocument({size:'A4',margin:36,autoFirstPage:false});const chunks:Buffer[]=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
 const mm=72/25.4;
 for(let start=0;start<tags.length;start+=plan.perPage) {
  const group=tags.slice(start,start+plan.perPage);doc.addPage();doc.fontSize(9).text(`tag36h11 / ${label(group[0]!.id)} - ${label(group.at(-1)!.id)} / ${start/plan.perPage+1} of ${plan.pages}`,10*mm,6*mm,{lineBreak:false});
  // SVG含显式mm单位，保留库的96px→72pt换算；assumePt会错误放大4/3。
  for(const [i,t] of group.entries()){
   const total=t.size*1000*1.25;
   if(layout==='grid') {
    const slotWidth=gridArea.width/plan.columns;
    const x=gridArea.x+(i%plan.columns)*slotWidth+(slotWidth-total)/2;
    const y=gridArea.y+Math.floor(i/plan.columns)*plan.slotHeight+(plan.slotHeight-total-gridArea.labelHeight)/2;
    SVGtoPDF(doc,gridTagSvg(t),x*mm,y*mm,{width:total*mm,height:(total+gridArea.labelHeight)*mm});
   } else {
    const slot=200/plan.columns,x=5+(i%plan.columns)*slot+(slot-total)/2,y=17+Math.floor(i/plan.columns)*plan.slotHeight;
    SVGtoPDF(doc,tagSvg(t),x*mm,y*mm,{width:total*mm,height:(total+22)*mm});
   }
  }
  doc.fontSize(8).text('100% / ACTUAL SIZE - disable fit, shrink and multiple pages per sheet',10*mm,283*mm,{lineBreak:false});doc.moveTo(10*mm,278*mm).lineTo(60*mm,278*mm).stroke();doc.text('50 mm',63*mm,276*mm,{lineBreak:false});
 }
 doc.end();});
}
export function manifest(map:FieldMap,tags=map.tags) {
 return '\ufeff'+['family,id,label,row_id,x_m,y_m,angle_deg,black_border_mm,print_plus_x',...tags.map(t=>`tag36h11,${t.id},${label(t.id)},${t.rowId},${t.x.toFixed(4)},${t.y.toFixed(4)},${t.angle.toFixed(2)},${(t.size*1000).toFixed(1)},printed-right`)].join('\n');
}
export function layoutSvg(map:FieldMap) {
 const ps=[...map.zone,...map.rows.flatMap(r=>r.points),...map.tags];const minX=Math.min(...ps.map(p=>p.x))-1,minY=Math.min(...ps.map(p=>p.y))-1,maxX=Math.max(...ps.map(p=>p.x))+1,maxY=Math.max(...ps.map(p=>p.y))+1;
 const screen=(p:{x:number,y:number})=>`${(p.x-minX)*100},${(maxY-p.y)*100}`;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" viewBox="0 0 ${(maxX-minX)*100} ${(maxY-minY)*100}"><rect width="100%" height="100%" fill="white"/><polygon points="${map.zone.map(screen).join(' ')}" fill="#ecfdf5" stroke="#16a085" stroke-dasharray="8 5"/>${map.rows.map(r=>`<polyline points="${r.points.map(screen).join(' ')}" fill="none" stroke="#a7d5b5" stroke-width="${r.width*100}"/><polyline points="${r.points.map(screen).join(' ')}" fill="none" stroke="#167a61" stroke-width="2"/>`).join('')}${map.tags.map(t=>{const [x,y]=screen(t).split(',');return `<g transform="translate(${x},${y})"><rect x="-5" y="-5" width="10" height="10" fill="#172b40"/><text y="-12" font-family="sans-serif" font-size="10" text-anchor="middle">${label(t.id)} (${t.x.toFixed(2)},${t.y.toFixed(2)}) ${t.angle.toFixed(0)}°</text><path d="M0 0 L16 0 M12 -3 L16 0 L12 3" transform="rotate(${-t.angle})" stroke="#f59e0b" fill="none"/></g>`}).join('')}<text x="15" y="20" font-size="14" font-family="sans-serif">${escapeXml(map.name)} · map X right / Y up · metres</text></svg>`;
}
