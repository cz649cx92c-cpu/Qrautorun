import {parseArgs} from 'node:util';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';
import {batchPlan,exportBatch} from '../web/backend/src/batch-print';

const root=fileURLToPath(new URL('../',import.meta.url));
const {values}=parseArgs({options:{start:{type:'string',default:'0'},end:{type:'string',default:'586'},'size-mm':{type:'string',default:'80'},layout:{type:'string',default:'packed'},map:{type:'string'},out:{type:'string',default:'prints'}}});
const map=values.map?JSON.parse(readFileSync(resolve(values.map),'utf8')):null;
const request=map?{source:'map',map:map.map??map,layout:values.layout,format:'bundle'}:{source:'range',startId:Number(values.start),endId:Number(values.end),sizeMm:Number(values['size-mm']),layout:values.layout,format:'bundle'};
const plan=batchPlan(request),result=await exportBatch(request),files=unzipSync(result.data),directory=resolve(root,values.out);
mkdirSync(directory,{recursive:true});
writeFileSync(resolve(directory,plan.filename+'.zip'),result.data);
writeFileSync(resolve(directory,plan.filename+'.pdf'),files['print-all.pdf']!);
writeFileSync(resolve(directory,plan.filename+'-清单.csv'),files['markers.csv']!);
writeFileSync(resolve(directory,plan.filename+'-说明.txt'),files['打印说明.txt']!);
console.log(`已生成 ${plan.count} 张标记 / ${plan.pages} 页A4 / ${plan.columns}×${plan.rows}排版：\n${resolve(directory,plan.filename+'.pdf')}\n${resolve(directory,plan.filename+'.zip')}`);
