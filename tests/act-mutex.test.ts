import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';
import vm from 'node:vm';

/**
 * `act()` 的互斥语义。
 *
 * 背景（本轮真实改动引出的接线风险）：曾经用 `Promise.race([fn(), hardStop])`
 * 在 20 秒后把 `busy` 放掉，但 `fn()` 并没有被取消——它仍在后台跑。
 * 这时用户再点一次就会**第二次写**，出现「多阶段写并行 / 迟到回调覆写新状态」。
 *
 * 这里锁死三条不变量：
 *  1. 写操作（不传 timeoutMs）**不会**因为时间流逝自行解锁；
 *  2. 写操作只有 `fn` 真正 settle 之后才释放互斥，期间第二次调用必须被拒绝；
 *  3. 只读操作可以超时解锁，且超时后立刻可再次调用。
 */

const source = readFileSync(resolve('web/frontend/src/App.vue'), 'utf8');
const script = source.split('<script setup lang="ts">')[1]!.split('</script>')[0]!;
const ast = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functions = ast.statements
  .filter(s => ts.isFunctionDeclaration(s) && s.name?.text === 'act')
  .map(s => s.getText(ast))
  .join('\n');
const js = ts.transpileModule(functions, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;

function harness() {
  let now = 0, next = 0;
  const timers = new Map<number, {at: number; run: () => void}>();
  const context = vm.createContext({
    AbortController, Promise, Error, String, Math,
    busy: {value: false}, error: {value: ''}, message: {value: ''},
    setTimeout: (run: () => void, ms: number) => { const id = ++next; timers.set(id, {at: now + ms, run}); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  vm.runInContext(js, context);
  const advance = async (ms: number) => {
    const end = now + ms;
    while (true) {
      const entry = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      now = entry[1].at; timers.delete(entry[0]); entry[1].run();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    now = end;
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {context, advance};
}

test('写操作：绝不因为超时时间流逝而自行解锁', async () => {
  const h = harness();
  let finished = false;
  const pending = (h.context as any).act(async () => {
    // 模拟一个真实写操作：很久才返回
    await new Promise<void>(resolve => setTimeout(() => { finished = true; resolve(); }, 60000));
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal((h.context as any).busy.value, true, '写操作开始后必须持锁');

  // 推进到远超以前 20 秒硬超时的时间点
  await h.advance(25000);
  assert.equal((h.context as any).busy.value, true, '写操作未结束时不得解锁（以前 20s 就解锁了）');
  assert.equal(finished, false, '写操作本身不应被强行中止');

  // 此时再次调用必须被拒绝，绝不允许第二次写
  let secondRan = false;
  await (h.context as any).act(async () => { secondRan = true; });
  assert.equal(secondRan, false, '锁未释放时第二次写必须被拒绝');
  assert.match((h.context as any).message.value, /还在处理中/, '被拒绝必须给出可见提示，不能静默');

  // 让第一次写真正完成
  await h.advance(60000);
  await pending;
  assert.equal((h.context as any).busy.value, false, '写操作真正结束后必须解锁');
});

test('写操作：结束后才允许下一次写，不会并行', async () => {
  const h = harness();
  const order: string[] = [];
  const first = (h.context as any).act(async () => {
    order.push('first-start');
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
    order.push('first-end');
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const second = (h.context as any).act(async () => { order.push('second'); });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await h.advance(1000);
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end'], '第二次写不得插入到第一次写中间');
});

test('只读操作：可被 abort 中止并解锁，随后可再次调用', async () => {
  const h = harness();
  // 真实语义：只读操作的 fn 必须**响应 abort**（这是可确认取消的前提）。
  // 不响应 abort 的 fn 不属于「只读可超时」这一类——那是写操作，必须持锁到最后。
  let aborted = false;
  const task = (h.context as any).act(async (signal: AbortSignal) => {
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) { aborted = true; reject(new Error('已取消')); return; }
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('已取消')); }, {once: true});
    });
  }, {timeoutMs: 5000});
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal((h.context as any).busy.value, true);
  await h.advance(6000);
  await task;
  assert.equal(aborted, true, '超时必须真的把中止信号送到 fn 内部');
  assert.equal((h.context as any).busy.value, false, '可确认取消后必须解锁');

  let ran = false;
  await (h.context as any).act(async () => { ran = true; }, {timeoutMs: 5000});
  assert.equal(ran, true, '解锁后必须能立刻再次调用');
});
