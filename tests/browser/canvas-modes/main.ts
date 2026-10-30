import {createApp,defineComponent,h,ref} from 'vue';
import MapCanvas from '../../../web/frontend/src/components/MapCanvas.vue';
import type {FieldMap,Point} from '../../../web/shared/model';

// 自包含夹具：只挂载 MapCanvas.vue。不加载 App.vue、不启动后端、不连 WebSocket、不写 DB。
// 右侧按钮通过 window.__setState 切换 tool / editable / panEnabled / drawMode，
// 组件 emit 的每个事件都记录到 window.__events，测试据此断言「选中/加点/拖动」。

declare global{interface Window{__events:string[];__setState?:(state:Record<string,unknown>)=>void}}
window.__events=[];

const map:FieldMap={
 schemaVersion:1,id:'canvas-mode-map',name:'交互夹具',frame:'map',family:'tag36h11',source:'survey',
 routeMode:'waypoints',coordinateStatus:'draft',rows:[],order:[],
 tags:[
  {id:0,x:0,y:0,angle:0,size:.08,rowId:'',kind:'waypoint',rules:[]},
  {id:1,x:.6,y:0,angle:0,size:.08,rowId:'',kind:'waypoint',rules:[]},
  {id:2,x:.6,y:.6,angle:0,size:.08,rowId:'',kind:'waypoint',rules:[]},
 ],
 zone:[{x:-.4,y:-.4},{x:1,y:-.4},{x:1,y:1},{x:-.4,y:1}],
 vehicle:{width:.4,length:.8,margin:.05},notes:'',
};

// 必须用 setup()+render 组合：函数式组件里的 ref 不会建立响应式依赖，
// 之前那样写会导致 __setState 改了 tool 但组件永不重渲染，模式断言全部超时。
const App=defineComponent({
 setup(){

 const tool=ref('select'),editable=ref(true),panEnabled=ref(false),drawMode=ref(false);
 const selected=ref<number[]>([]),drawing=ref<Point[]>([]),log=ref<string[]>([]);
 const push=(name:string,args:unknown[])=>{
  const line=`${name} ${JSON.stringify(args)}`;
  window.__events.push(line);
  log.value=[...log.value,line];
 };
 const record=(name:string)=>(...args:unknown[])=>push(name,args);
 const onSelect=(id:number,multi:boolean)=>{push('select',[id,multi]);selected.value=[id];};
 window.__setState=(state)=>{
  if('tool' in state)tool.value=String(state.tool);
  if('editable' in state)editable.value=!!state.editable;
  if('panEnabled' in state)panEnabled.value=!!state.panEnabled;
  if('drawMode' in state)drawMode.value=!!state.drawMode;
 };
 const button=(id:string,text:string,onClick:()=>void)=>h('button',{id,'data-testid':id,onClick,style:'font:12px monospace;padding:4px 6px'},text);
  return ()=>h('div',{style:'display:flex;gap:8px;align-items:stretch;width:100%;height:100%'},[
  h('div',{class:'canvas-wrap',style:'flex:1;min-width:0;height:100%'},[
   h(MapCanvas,{
    map,
    'selected':selected.value,
    'rowId':'',
    'tool':tool.value,
    'editable':editable.value,
    'drawing':drawing.value,
    'panEnabled':panEnabled.value,
    'drawMode':drawMode.value,
    'onSelect':onSelect,
    'onInspect':record('inspect'),
    'onBlank':(p:Point)=>{drawing.value=[...drawing.value,p];push('blank',[p]);},
    'onMove':record('move'),
    'onRow':record('row'),
    'onTagDetail':record('tagDetail'),
    'onDesignSelect':record('designSelect'),
    'onDesignMove':record('designMove'),
   }),
  ]),
  h('div',{style:'flex:0 0 250px;display:flex;flex-direction:column;gap:6px;min-height:0'},[
   h('div',{style:'display:flex;flex-wrap:wrap;gap:4px'},[
    button('set-tool-select','tool=select',()=>{tool.value='select';}),
    button('set-tool-pan','tool=pan',()=>{tool.value='pan';}),
    button('set-tool-measure','tool=measure',()=>{tool.value='measure';}),
    button('set-tool-route-design','tool=route-design',()=>{tool.value='route-design';}),
    button('set-editable-true','editable=true',()=>{editable.value=true;}),
    button('set-editable-false','editable=false',()=>{editable.value=false;}),
    button('set-pan-enabled-true','panEnabled=true',()=>{panEnabled.value=true;}),
    button('set-pan-enabled-false','panEnabled=false',()=>{panEnabled.value=false;}),
    button('set-draw-mode-true','drawMode=true',()=>{drawMode.value=true;}),
    button('set-draw-mode-false','drawMode=false',()=>{drawMode.value=false;}),
   ]),
   h('pre',{id:'event-log','data-testid':'event-log',style:'flex:1;min-height:0;margin:0;overflow:auto;background:#0f172a;color:#e2e8f0;padding:6px;font:11px monospace;white-space:pre-wrap'},log.value.join('\n')),
  ]),
 ]);
 },
});

createApp(App).mount('#harness');
