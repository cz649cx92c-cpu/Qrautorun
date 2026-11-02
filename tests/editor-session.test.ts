import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EDITOR_MODES,MODE_SPECS,canEnterMode,withTemporaryPan,resolveLegacyMode,modeDragPans,modeMutates,
} from '../web/shared/editor-modes';
import {UndoStack} from '../web/frontend/src/composables/useUndoStack';

test('模式表：选择/框选/测距/间距/点位编辑都不允许左键拖动平移画布',()=>{
 // 这是「平移常驻导致点选失效」的根治点：只有 pan 模式才平移。
 for(const mode of ['select','boxSelect','draw','connect','measure','spacing','tagEdit'] as const){
  assert.equal(modeDragPans(mode),false,`${mode} 不得平移画布`);
 }
 assert.equal(modeDragPans('pan'),true);
});

test('模式表：每个模式都有中文标签与完整声明',()=>{
 for(const mode of EDITOR_MODES){
  const spec=MODE_SPECS[mode];
  assert.equal(spec.mode,mode);
  assert.ok(spec.label.length>0,`${mode} 缺少标签`);
  assert.ok(Array.isArray(spec.conflictsWith));
  assert.equal(spec.conflictsWith.includes(mode),false,`${mode} 不能与自己互斥`);
 }
});

test('模式切换：冲突是双向判定的，被拒时给中文原因而不是静默',()=>{
 const blocked=canEnterMode('pan','tagEdit');
 assert.equal(blocked.ok,false);
 assert.ok(blocked.reason&&blocked.reason.length>0);
 // 反向也要拒
 assert.equal(canEnterMode('tagEdit','pan').ok,false);
 // 同一个模式切换是允许的（幂等）
 assert.equal(canEnterMode('select','select').ok,true);
 // 不冲突的一对必须允许：选择 → 测距
 assert.equal(canEnterMode('select','measure').ok,true);
});

test('临时平移：从任何模式进入都回到原模式，且不改变是否改数据',()=>{
 for(const mode of EDITOR_MODES){
  const {temporary,restore}=withTemporaryPan(mode);
  assert.equal(temporary,'pan');
  assert.equal(restore,mode);
  // 临时平移本身不改数据（pan.mutates=false），但恢复后的模式必须保持原来的 mutates，
  // 这样调用方在松手后才不会误判"当前操作不需要入撤销栈"。
  assert.equal(modeMutates(restore),modeMutates(mode),'松手后必须回到原模式的语义');
  assert.equal(modeMutates(temporary),false,'平移本身不改数据');
 }
});

test('旧布尔量推导：三种历史 bug 场景都返回安全模式',()=>{
 // bug 2：间距调整曾被算进 routeLocked，把路径编辑锁死 → 现在只应得到 tagEdit
 assert.equal(resolveLegacyMode({editingRoute:true,tagPositionEditing:true}),'tagEdit');
 // bug 3：铺码预览曾锁死路径编辑 → 现在只应得到 draw
 assert.equal(resolveLegacyMode({editingRoute:true,tagCreateEditing:true}),'draw');
 // bug 1：路径编辑里平移常驻 → 只有显式 routeTool==='pan' 才是 pan
 assert.equal(resolveLegacyMode({editingRoute:true,routeTool:'select'}),'select');
 assert.equal(resolveLegacyMode({editingRoute:true,routeTool:'pan'}),'pan');
 // 不在编辑路径时应为选择态，不受任何残留布尔量影响
 assert.equal(resolveLegacyMode({}),'select');
 assert.equal(resolveLegacyMode({measuring:true}),'measure');
});

test('撤销栈：一次操作一次撤销，容量裁剪最旧项',()=>{
 const stack=new UndoStack<{points:number[]}>({capacity:3,now:()=>0});
 stack.push('移动点位',{points:[0]});
 stack.push('移动点位',{points:[0,1]});
 stack.push('移动点位',{points:[0,1,2]});
 assert.equal(stack.depth,3);
 stack.push('移动点位',{points:[0,1,2,3]});
 assert.equal(stack.depth,3,'超过容量应裁剪');
 // 撤销两次后回到中间态
 // undo 弹的是栈顶（最近一次操作前的状态）：先拿到 [0,1,2,3]，再拿到 [0,1,2]
 const first=stack.undo({points:[9]});
 assert.deepEqual(first?.payload.points,[0,1,2,3]);
 const second=stack.undo({points:[9]});
 assert.deepEqual(second?.payload.points,[0,1,2]);
 // 裁剪后只剩 3 项，第三次 undo 应拿到被保留的最旧项 [0,1]
 const third=stack.undo({points:[9]});
 assert.deepEqual(third?.payload.points,[0,1]);
 assert.equal(stack.canUndo,false,'容量裁剪后只保留 3 步');
});

test('撤销栈：push 后的深拷贝隔离，redo 在新操作后被清空',()=>{
 const stack=new UndoStack<{points:{x:number}[]}>({now:()=>0});
 const payload={points:[{x:1}]};
 stack.push('改坐标',payload);
 payload.points[0]!.x=999; // 修改原对象
 const undone=stack.undo({points:[{x:999}]});
 assert.equal(undone?.payload.points[0]?.x,1,'栈内必须是快照');

 const redone=stack.redo({points:[{x:1}]});
 assert.deepEqual(redone?.payload.points,[{x:999}]);
 assert.equal(stack.canRedo,false);

 stack.push('新操作',{points:[{x:2}]});
 stack.undo({points:[{x:2}]});
 assert.equal(stack.canRedo,true);
 stack.push('新分支',{points:[{x:3}]});
 assert.equal(stack.canRedo,false,'新分支必须清空 redo');
});

test('撤销栈：空栈操作返回 null 而不是抛异常',()=>{
 const stack=new UndoStack<number>();
 assert.equal(stack.undo(0),null);
 assert.equal(stack.redo(0),null);
 assert.equal(stack.canUndo,false);
 assert.equal(stack.canRedo,false);
 assert.equal(stack.topLabel,null);
});
