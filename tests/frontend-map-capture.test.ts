import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const source=readFileSync(new URL('../web/frontend/src/App.vue',import.meta.url),'utf8').split('<script setup lang="ts">')[1]!.split('</script>')[0]!;
const ast=ts.createSourceFile('App.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function harness(){
 const wanted=new Set(['act','stopSelectedSession','savePositionMap','finish','availableMaps','capturePointCount','captureSampleCount']);
 const statements=ast.statements.filter(s=>ts.isFunctionDeclaration(s)&&!!s.name&&wanted.has(s.name.text)||ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>wanted.has(d.name.getText(ast))));
 const code=ts.transpileModule(statements.map(s=>s.getText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const samples=Array.from({length:104},(_,i)=>({pose:{x:i*.01,y:0,yaw:0},tags:[{id:49,groupId:'B049'},{id:50,groupId:'B049'},{id:65,groupId:'B065'}]}));
 const record:any={id:'scan-fixture',name:'位置地图',state:'collecting',samples,counts:{49:104,50:104,65:104},motionValidation:{ready:false,reasons:['区间前后换向']}};
 const state:any={busy:{value:false},error:{value:''},message:{value:''},session:{value:record},settings:{value:{tagSizeMm:80}},maps:{value:[{id:'route-less',name:'无路径地图'}]},tasks:{value:[]},selectedTask:{value:'old'},selectedMapId:{value:''},selectedRouteId:{value:'old'},routeNameDraft:{value:''},page:{value:'scan'},boards:{value:[]}};
 const calls:any[]=[];let selected:any=null;
 const context=vm.createContext({...state,sessionEpoch:0,computed:(fn:()=>unknown)=>({get value(){return fn();}}),selectMap:(result:any)=>selected=result,selectSession:(r:any)=>state.session.value=r,refresh:async()=>{},api:async(path:string,body?:any)=>{
  calls.push({path,body});if(path==='/survey/stop'){record.state='stopped';return record;}
  if(path==='/surveys/'+record.id)return record;
  if(path==='/maps/scan-scanfixture')throw Object.assign(new Error('不存在'),{status:404});
  if(path==='/survey/map')return {map:{id:'scan-scanfixture',tags:[{id:49},{id:65}],rows:[],routeMode:'map-only'},version:1,route:null,task:null};
  throw new Error('禁止自动编译/生成路线 '+path);
 }});vm.runInContext(code,context);
 return {state,calls,context,selected:()=>selected,record};
}
test('保存位置地图不受采集换向影响，不调用自动路线，且不自动选择任务',async()=>{
 const h=harness();await vm.runInContext('finish()',h.context);
 assert.equal(h.state.error.value,'');assert.equal(h.selected()?.map.routeMode,'map-only');
 assert.deepEqual(h.calls.map(c=>c.path),['/survey/stop','/surveys/scan-fixture','/maps/scan-scanfixture','/survey/map']);
 assert.equal(h.calls.at(-1).body.baseVersion,0);assert.equal(h.state.selectedRouteId.value,'');assert.equal(h.state.selectedTask.value,'');
 assert.match(h.state.message.value,/地图已保存.*2.*未创建路径/);assert.equal(h.record.samples.length,104);
});
test('真实104帧去重为2个定位点，同板子码不重复计点',()=>{
 const h=harness();assert.equal(vm.runInContext('capturePointCount.value',h.context),2);assert.equal(vm.runInContext('captureSampleCount.value',h.context),104);
 h.record.samples.push({tags:[{id:81,groupId:'B081'}]});assert.equal(vm.runInContext('capturePointCount.value',h.context),3);
});
test('无任务地图来自地图列表，不从任务捏造',()=>{
 const h=harness();assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(availableMaps.value)',h.context)),[{id:'route-less',name:'无路径地图'}]);
});
