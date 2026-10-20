import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import type {Store} from './store';
import {boardSchema} from '../../shared/boards';
import {boardPdf,boardSvg,checkBoardRegistration,listBoards} from './boards';
import {tagSvg} from './tags';

const params=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),tagId:z.coerce.number().int().min(0).max(586)});
const query=z.object({version:z.coerce.number().int().positive().optional(),target:z.enum(['member','board']).default('member'),memberId:z.coerce.number().int().min(0).max(586).optional(),centerCrosshair:z.enum(['true','false']).default('true')}).strict();
function fail(statusCode:number,message:string):never{throw Object.assign(new Error(message),{statusCode});}
/** Reads the original version directly: missing legacy sizes must never acquire a schema default. */
function original(store:Store,id:string,tagId:number,version?:number){
 const row=(version?store.db.prepare('SELECT body,version FROM versions WHERE map_id=? AND version=?').get(id,version):store.db.prepare('SELECT body,version FROM versions WHERE map_id=? ORDER BY version DESC LIMIT 1').get(id)) as {body:string,version:number}|undefined;
 if(!row)fail(404,'地图版本不存在');
 const map=JSON.parse(row.body);if(map.family!=='tag36h11')fail(422,'仅支持已知 tag36h11 原码');
 const tag=(map.tags as {id:number,size?:number,groupId?:string}[]).find(item=>item.id===tagId);if(!tag)fail(404,'二维码不在此地图中');
 const registered=listBoards(store);
 const definition=(map.groups??[]).find((item:{id:string,referenceId:number})=>tag.groupId?item.id===tag.groupId:item.referenceId===tagId);
 const saved=registered.find(item=>tag.groupId?item.id===tag.groupId:item.referenceId===tagId);
 if(tag.groupId&&!definition&&!saved)fail(422,'缺少原定位板定义，不能推测规格补打');
 const board=definition?boardSchema.parse(definition):saved;
 if(board)checkBoardRegistration(store,[board]);
 const size=typeof tag.size==='number'&&Number.isFinite(tag.size)&&tag.size>0?tag.size:undefined;
 return {version:row.version,board,size};
}
async function originalPdf(id:number,size:number){
 const total=size*1250;if(total>190)fail(422,'原尺寸超出 A4 安全打印宽度，不能缩放补打');
 return new Promise<Buffer>((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:0}),chunks:Buffer[]=[];const mm=72/25.4;
  doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  SVGtoPDF(doc,tagSvg({id,size}),(210-total)/2*mm,20*mm,{width:total*mm,height:(total+22)*mm});
  doc.moveTo(10*mm,278*mm).lineTo(60*mm,278*mm).stroke();doc.fontSize(8).text('50 mm',63*mm,276*mm,{lineBreak:false});doc.text('100% / ACTUAL SIZE',10*mm,285*mm,{lineBreak:false});doc.end();
 });
}
export function registerTagReprintRoutes(app:FastifyInstance,store:Store){
 app.get('/api/maps/:id/tags/:tagId/print-info',req=>{
  const p=params.parse(req.params),q=query.parse(req.query),source=original(store,p.id,p.tagId,q.version);
  return {family:'tag36h11',mapId:p.id,version:source.version,tagId:p.tagId,kind:source.board?'board':'single',board:source.board,
   members:source.board?source.board.members.map(member=>({id:member.id,sizeMm:member.size*1000})):[{id:p.tagId,sizeMm:source.size===undefined?null:source.size*1000}],
   printable:!!source.board||source.size!==undefined,unavailableReason:!source.board&&source.size===undefined?'原地图缺少黑边尺寸，不能假称原规格补打':undefined};
 });
 for(const format of ['svg','pdf'] as const)app.get(`/api/maps/:id/tags/:tagId/reprint.${format}`,async(req,reply)=>{
  const p=params.parse(req.params),q=query.parse(req.query),source=original(store,p.id,p.tagId,q.version);
  let content:string|Buffer,filename:string;
  if(q.target==='board'){
   if(!source.board)fail(404,'此码没有原定位板定义');
   content=format==='svg'?boardSvg(source.board,q.centerCrosshair==='true'):await boardPdf([source.board],q.centerCrosshair==='true');filename=source.board.id;
  }else{
   const member=source.board?.members.find(item=>item.id===(q.memberId??p.tagId));
   if(source.board&&!member||!source.board&&q.memberId!==undefined&&q.memberId!==p.tagId)fail(404,'所选子码不属于此定位板');
   const id=member?.id??p.tagId,size=member?.size??source.size;if(size===undefined)fail(422,'原地图缺少黑边尺寸，禁止推测尺寸补打');
   content=format==='svg'?tagSvg({id,size}):await originalPdf(id,size);filename=`Q${String(id).padStart(3,'0')}`;
  }
  reply.header('Cache-Control','no-store');if(format==='pdf')reply.header('Content-Disposition',`attachment; filename="${filename}-original.pdf"`);
  return reply.type(format==='svg'?'image/svg+xml':'application/pdf').send(content);
 });
}
