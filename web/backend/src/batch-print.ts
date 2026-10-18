import {z} from 'zod';
import {zipSync,strToU8} from 'fflate';
import {mapSchema,type FieldMap} from '../../shared/model';
import {label,tagSvg,printPdf,printLayout,layoutSvg,type PrintableTag} from './tags';

const settings={layout:z.enum(['packed','single','grid']).default('packed'),gridSize:z.number().int().min(1).max(4).default(1),format:z.enum(['pdf','bundle']).default('pdf')};
export const batchPrintSchema=z.discriminatedUnion('source',[
 z.object({source:z.literal('map'),map:mapSchema,...settings}),
 z.object({source:z.literal('range'),startId:z.number().int().min(0).max(586),endId:z.number().int().min(0).max(586),sizeMm:z.number().min(20).max(150),...settings})
]);
export function prepareBatch(raw:unknown) {
 const request=batchPrintSchema.parse(raw);
 let tags:PrintableTag[],map:FieldMap|undefined;
 if(request.source==='map'){
  map=request.map;if(('groups' in map)&&Array.isArray(map.groups)&&map.groups.length)throw new Error('此地图使用多码定位板，请从生成二维码页面按原规格重印定位板');
  tags=[...map.tags].sort((a,b)=>a.id-b.id);
 }
 else {if(request.endId<request.startId)throw new Error('结束ID不能小于起始ID');tags=Array.from({length:request.endId-request.startId+1},(_,i)=>({id:request.startId+i,size:request.sizeMm/1000}));}
 const layout=printLayout(tags,request.layout,request.gridSize);
 const sizesMm=[...new Set(tags.map(t=>Number((t.size*1000).toFixed(3))))].sort((a,b)=>a-b);
 const layoutName=request.layout==='grid'?`${request.gridSize}x${request.gridSize}`:request.layout;
 const filename=`apriltags-${label(tags[0]!.id)}-${label(tags.at(-1)!.id)}-${sizesMm.length===1?sizesMm[0]+'mm':'mixed'}-${layoutName}`;
 return {request,tags,map,layout,sizesMm,filename};
}
export function batchPlan(raw:unknown){const b=prepareBatch(raw);return {source:b.request.source,count:b.tags.length,firstId:b.tags[0]!.id,lastId:b.tags.at(-1)!.id,sizesMm:b.sizesMm,...b.layout,filename:b.filename,preview:b.tags.slice(0,12)};}
const csvCell=(value:unknown)=>'"'+String(value??'').replaceAll('"','""')+'"';
export function batchManifest(tags:PrintableTag[]) {
 const headers=['family','id','label','black_border_mm','row_id','x_m','y_m','angle_deg','print_plus_x','placement_status'];
 return '\ufeff'+[headers,...tags.map(t=>['tag36h11',t.id,label(t.id),(t.size*1000).toFixed(3),t.rowId,t.x,t.y,t.angle,'printed-right',t.x===undefined?'unassigned':'map-snapshot'])].map(row=>row.map(csvCell).join(',')).join('\r\n');
}
export async function exportBatch(raw:unknown) {
 const b=prepareBatch(raw),pdf=await printPdf(b.tags,b.request.layout,b.request.gridSize);
 if(b.request.format==='pdf')return {data:pdf,type:'application/pdf',filename:b.filename+'.pdf'};
 const files:Record<string,Uint8Array>={'print-all.pdf':pdf,'markers.csv':strToU8(batchManifest(b.tags))};
 for(const t of b.tags)files[`svg/${label(t.id)}.svg`]=strToU8(tagSvg(t));
 if(b.map){files['map.json']=strToU8(JSON.stringify(b.map,null,2));files['placement.svg']=strToU8(layoutSvg(b.map));}
 files['打印说明.txt']=strToU8(`温室地面AprilTag批量打印\n码族：tag36h11\n编号：${b.tags.map(t=>label(t.id)).join('、')}\n数量：${b.tags.length}；A4页数：${b.layout.pages}；黑边尺寸：${b.sizesMm.join('、')}mm\n\n1. 打开print-all.pdf，选择A4、单面、100% / 实际大小。关闭适应页面、缩小页面及打印机额外的多页合一。\n2. PDF已完成${b.layout.columns}列×${b.layout.rows}行排版，请打印全部页面。先印一页，用尺测量50mm标尺和标记黑色外边界。\n3. 保留完整白色静区，不沿黑边裁切；编号和说明在标记静区外侧。打印向右箭头表示安装+X方向。\n4. ${b.map?'map.json为打印时地图快照，markers.csv及placement.svg给出对应坐标和安装角度，铺设后进行现场坐标验收。':'编号模式尚未分配地面位置；markers.csv中的坐标为空。先铺标记后通过现场采集或地图编辑给这些原ID指定坐标，不要重新编号。'}\n5. 标记不能承载控制命令；此打印功能不会启动摄像头或底盘。\n`);
 return {data:Buffer.from(zipSync(files)),type:'application/zip',filename:b.filename+'.zip'};
}
