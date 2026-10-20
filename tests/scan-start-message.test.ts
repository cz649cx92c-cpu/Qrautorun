import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

const source=readFileSync(new URL('../web/frontend/src/App.vue',import.meta.url),'utf8').split('<script setup lang="ts">')[1]!.split('</script>')[0]!;
const ast=ts.createSourceFile('App.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const wanted=new Set(['scanWaitReasons','act','start','pollSession']);
const statements=ast.statements.filter(s=>ts.isFunctionDeclaration(s)&&!!s.name&&wanted.has(s.name.text)||ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>wanted.has(d.name.getText(ast))));
assert.equal(statements.length,4,'必须运行实际网页启动、轮询及状态计算');
const code=ts.transpileModule(statements.map(s=>s.getText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function harness(mappingReady:boolean){
 const record={id:'mock-scanning',state:'collecting',samples:[] as unknown[],counts:{}};
 const state={busy:{value:false},error:{value:''},message:{value:''},boards:{value:[{id:'B113'}]},name:{value:'扫描提示回归'},scanView:{value:'map'},session:{value:null as typeof record|null},sessions:{value:[]},bridgeOnline:{value:true},robot:{value:{detector:{connected:true,positionReady:true},sensors:{imu:'在线'},mapping:{ready:mappingReady,reason:mappingReady?'':'等待新鲜的正式同步定位观测'}}},originChanged:{value:false},page:{value:'scan'}};
 const calls:string[]=[];
 const context=vm.createContext({...state,computed:(fn:()=>unknown)=>({get value(){return fn();}}),recoveryReason:(s:string)=>s,closed:false,polling:false,sessionEpoch:0,selectSession:(value:typeof record)=>state.session.value=value,refresh:async()=>{},api:async(path:string)=>{calls.push(path);if(path==='/survey/start')return {...record,samples:[]};if(path==='/surveys/'+record.id)return {...record};if(path==='/surveys')return [record];throw new Error('Unexpected isolated API '+path);}});
 vm.runInContext(code,context);
 return {state,record,calls,context,reasons:()=>JSON.parse(vm.runInContext('JSON.stringify(scanWaitReasons.value)',context))};
}
for(const readyAtStart of [true,false])test('启动时'+(readyAtStart?'首帧未到':'同步未就绪')+'；104帧到达后不保留旧等待toast',async()=>{
 const h=harness(readyAtStart);await vm.runInContext('start()',h.context);
 assert.ok(h.reasons().length);h.record.samples=Array.from({length:104},()=>({pose:{x:0,y:0,yaw:0}}));
 h.state.robot.value.mapping={ready:true,reason:''};await vm.runInContext('pollSession()',h.context);
 assert.equal(h.state.session.value?.samples.length,104);assert.deepEqual(h.reasons(),[]);
 assert.doesNotMatch(h.state.message.value,/等待|首帧|同步/,'顶部启动toast不能保留已经失效的实时等待原因');
 assert.deepEqual(h.calls,['/survey/start','/surveys/mock-scanning']);
});
test('已有样本时后续观测中断仍保留实时原因，启动toast不替代实时状态',async()=>{
 const h=harness(false);await vm.runInContext('start()',h.context);
 h.record.samples=Array.from({length:104},()=>({pose:{x:0,y:0,yaw:0}}));await vm.runInContext('pollSession()',h.context);
 assert.equal(h.state.session.value?.samples.length,104);assert.deepEqual(h.reasons(),['等待新鲜的正式同步定位观测']);
 assert.doesNotMatch(h.state.message.value,/等待|首帧|同步/);
});
test('扫描停止的结果提示仍由轮询更新，保留原扫描样本',async()=>{
 const h=harness(true);await vm.runInContext('start()',h.context);
 h.record.samples=Array.from({length:104},()=>({pose:{x:0,y:0,yaw:0}}));h.record.state='stopped';await vm.runInContext('pollSession()',h.context);
 assert.equal(h.state.message.value,'本次扫描已保存，路径和定位组已保留');assert.equal(h.state.session.value?.samples.length,104);
});
