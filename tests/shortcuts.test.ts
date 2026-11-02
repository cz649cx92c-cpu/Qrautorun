/**
 * useShortcuts 纯逻辑回归。
 *
 * 重点是三条容易出事故的约定：
 *   1) 输入框里按退格/方向键不能删除选中的路点；
 *   2) Ctrl+Y 与 Ctrl/Cmd+Shift+Z 都必须映射到 redo，而 Ctrl+Z 只能是 undo；
 *   3) 没被消费的组合键（Ctrl+C/V/L 等浏览器行为）必须返回 null，不能 preventDefault。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  NUDGE_STEPS_M,
  SHORTCUT_SPECS,
  TOOL_SHORTCUTS,
  isEditableTarget,
  isMiddlePanButton,
  isMultiSelectModifier,
  matchesShortcut,
  normalizeShortcutKey,
  nudgeDeltaFromKey,
  nudgeStepM,
  resolveShortcut,
  shortcutCheatSheet,
  useShortcuts,
  type KeyEventLike,
  type ShortcutSpec,
} from '../web/frontend/src/composables/useShortcuts';

const key = (patch: Partial<KeyEventLike> & {key: string}): KeyEventLike => ({...patch});

/** 假的目标元素：只实现被检测用到的形状。 */
function fakeTarget(tagName: string, attrs: Record<string, string> = {}, contentEditable = false) {
  const element = {
    tagName,
    isContentEditable: contentEditable,
    getAttribute: (name: string) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name]! : null),
  };
  return element as unknown as EventTarget;
}

test('按键归一化：单字符转小写、Spacebar/Esc 归一', () => {
  assert.equal(normalizeShortcutKey(key({key: 'Z'})), 'z');
  assert.equal(normalizeShortcutKey(key({key: 'z'})), 'z');
  assert.equal(normalizeShortcutKey(key({key: ' '})), ' ');
  assert.equal(normalizeShortcutKey(key({key: 'Spacebar'})), ' ');
  assert.equal(normalizeShortcutKey(key({key: 'Esc'})), 'escape');
  assert.equal(normalizeShortcutKey(key({key: 'Escape'})), 'escape');
  assert.equal(normalizeShortcutKey(key({key: 'ArrowLeft'})), 'arrowleft');
  assert.equal(normalizeShortcutKey(key({key: 'Delete'})), 'delete');
  assert.equal(normalizeShortcutKey(undefined), '');
  assert.equal(normalizeShortcutKey({} as KeyEventLike), '');
});

test('输入框 / textarea / select / contenteditable 内一律不触发快捷键', () => {
  const cases: unknown[] = [
    fakeTarget('INPUT'),
    fakeTarget('TEXTAREA'),
    fakeTarget('SELECT'),
    fakeTarget('OPTION'),
    fakeTarget('DIV', {}, true),
    fakeTarget('DIV', {contenteditable: 'true'}),
    fakeTarget('DIV', {contenteditable: ''}),
    fakeTarget('DIV', {role: 'textbox'}),
    fakeTarget('DIV', {'data-shortcuts-ignore': ''}),
  ];
  for (const target of cases) {
    assert.equal(isEditableTarget(target), true, `目标 ${JSON.stringify((target as {tagName?: string})?.tagName)} 应被视为可编辑`);
  }
  assert.equal(isEditableTarget(fakeTarget('DIV')), false);
  assert.equal(isEditableTarget(fakeTarget('BUTTON')), false);
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget(undefined), false);
  assert.equal(isEditableTarget('plain string'), false);
});

test('焦点在输入框时 useShortcuts 不回调、不 preventDefault', () => {
  let deleted = 0;
  const api = useShortcuts({onDelete: () => deleted++, target: null});
  const match = api.handleKeyDown(key({key: 'Backspace', target: fakeTarget('INPUT')}));
  assert.equal(match, null);
  assert.equal(deleted, 0, '在输入框里按退格绝不能删除选中的路点');
  assert.equal(api.handleKeyDown(key({key: 'z', ctrlKey: true, target: fakeTarget('TEXTAREA')})), null);
  assert.equal(api.handleKeyDown(key({key: 'ArrowLeft', target: fakeTarget('SELECT')})), null);
});

test('matchesShortcut 精确匹配修饰键，不抢浏览器组合键', () => {
  const undo = SHORTCUT_SPECS.find(spec => spec.id === 'undo')!;
  assert.equal(matchesShortcut(key({key: 'z', ctrlKey: true}), undo), true);
  assert.equal(matchesShortcut(key({key: 'z', metaKey: true}), undo), true);
  assert.equal(matchesShortcut(key({key: 'z'}), undo), false, '裸 z 是工具切换，不是撤销');
  assert.equal(matchesShortcut(key({key: 'z', ctrlKey: true, shiftKey: true}), undo), false, 'Ctrl+Shift+Z 属于重做');

  const tool = SHORTCUT_SPECS.find(spec => spec.id === 'tool-select')!;
  assert.equal(matchesShortcut(key({key: 'v'}), tool), true);
  assert.equal(matchesShortcut(key({key: 'V', shiftKey: true}), tool), false, 'Shift+V 不能被当成工具切换');
  assert.equal(matchesShortcut(key({key: 'v', ctrlKey: true}), tool), false, 'Ctrl+V 必须留给浏览器粘贴');
  assert.equal(matchesShortcut(key({key: 'v', metaKey: true}), tool), false);
});

test('Ctrl+Y 与 Cmd/Ctrl+Shift+Z 都映射到 redo，Ctrl+Z 是 undo', () => {
  assert.equal(resolveShortcut(key({key: 'z', ctrlKey: true}))?.action, 'undo');
  assert.equal(resolveShortcut(key({key: 'z', metaKey: true}))?.action, 'undo');
  assert.equal(resolveShortcut(key({key: 'Z', ctrlKey: true, shiftKey: true}))?.action, 'redo');
  assert.equal(resolveShortcut(key({key: 'z', metaKey: true, shiftKey: true}))?.action, 'redo');
  assert.equal(resolveShortcut(key({key: 'y', ctrlKey: true}))?.action, 'redo');
  assert.equal(resolveShortcut(key({key: 'Y', ctrlKey: true}))?.action, 'redo');
  assert.equal(resolveShortcut(key({key: 'y', ctrlKey: true, shiftKey: true})), null, 'Ctrl+Shift+Y 未绑定');
  assert.equal(SHORTCUT_SPECS.filter(spec => spec.action === 'redo').length, 2, 'redo 至少要覆盖两种习惯');
});

test('工具快捷键 V/H/L/M/G 各自映射，且不带修饰键才生效', () => {
  assert.deepEqual(TOOL_SHORTCUTS, {v: 'select', h: 'pan', l: 'link', m: 'measure', g: 'spacing'});
  for (const [letter, tool] of Object.entries(TOOL_SHORTCUTS)) {
    const match = resolveShortcut(key({key: letter}));
    assert.equal(match?.action, 'tool');
    assert.equal(match?.tool, tool);
    assert.equal(resolveShortcut(key({key: letter, ctrlKey: true})), null, `Ctrl+${letter} 必须留给浏览器`);
  }
});

test('浏览器必需行为不被拦截：Ctrl+C / Ctrl+V / Ctrl+L / F5 / 裸字符', () => {
  for (const event of [
    key({key: 'c', ctrlKey: true}),
    key({key: 'v', ctrlKey: true}),
    key({key: 'l', ctrlKey: true}),
    key({key: 'a', ctrlKey: true}),
    key({key: 'F5'}),
    key({key: 'Tab'}),
    key({key: 'Enter'}),
    key({key: 'q'}),
  ]) {
    assert.equal(resolveShortcut(event), null, `${event.key} 不应被编辑器消费`);
  }
});

test('Delete / Backspace / Esc / 方向键 / 空格被消费且需要 preventDefault', () => {
  for (const name of ['Delete', 'Backspace', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ']) {
    const match = resolveShortcut(key({key: name}));
    assert.ok(match, `${name} 应命中快捷键表`);
    assert.equal(match!.preventDefault, true, `${name} 命中后必须 preventDefault`);
  }
  // 撤销/重做/工具切换不需要阻止默认行为。
  assert.equal(resolveShortcut(key({key: 'z', ctrlKey: true}))?.preventDefault, false);
  assert.equal(resolveShortcut(key({key: 'v'}))?.preventDefault, false);
});

test('方向键步长：普通 1cm、Shift 10cm、Alt 1mm', () => {
  assert.equal(NUDGE_STEPS_M.normal, 0.01);
  assert.equal(NUDGE_STEPS_M.coarse, 0.1);
  assert.equal(NUDGE_STEPS_M.fine, 0.001);

  assert.equal(nudgeStepM(key({key: 'ArrowRight'})), 0.01);
  assert.equal(nudgeStepM(key({key: 'ArrowRight', shiftKey: true})), 0.1);
  assert.equal(nudgeStepM(key({key: 'ArrowRight', altKey: true})), 0.001);
  assert.equal(nudgeStepM(key({key: 'ArrowRight', shiftKey: true, altKey: true})), 0.001, 'Alt 更精细，应优先');

  assert.deepEqual(nudgeDeltaFromKey(key({key: 'ArrowLeft', shiftKey: true})), {dx: -0.1, dy: 0, stepM: 0.1, stepCm: 10});
  assert.deepEqual(nudgeDeltaFromKey(key({key: 'ArrowUp', altKey: true})), {dx: 0, dy: -0.001, stepM: 0.001, stepCm: 0.1});
  assert.equal(nudgeDeltaFromKey(key({key: 'v'})), null);
});

test('Shift/Ctrl/Cmd 点击识别为多选，中键识别为平移', () => {
  assert.equal(isMultiSelectModifier({shiftKey: true}), true);
  assert.equal(isMultiSelectModifier({ctrlKey: true}), true);
  assert.equal(isMultiSelectModifier({metaKey: true}), true);
  assert.equal(isMultiSelectModifier({}), false);
  assert.equal(isMultiSelectModifier(null), false);
  assert.equal(isMiddlePanButton({button: 1}), true);
  assert.equal(isMiddlePanButton({button: 0}), false);
  assert.equal(isMiddlePanButton(null), false);
});

test('useShortcuts 分发动作，并忽略长按重复（撤销/删除）', () => {
  const calls: string[] = [];
  const nudges: number[] = [];
  const tools: string[] = [];
  const pans: boolean[] = [];
  const api = useShortcuts({
    target: null,
    onUndo: () => calls.push('undo'),
    onRedo: () => calls.push('redo'),
    onDelete: () => calls.push('delete'),
    onEscape: () => calls.push('escape'),
    onNudge: delta => nudges.push(delta.dx + delta.dy),
    onToolChange: tool => tools.push(tool),
    onTemporaryPan: active => pans.push(active),
  });

  api.handleKeyDown(key({key: 'z', ctrlKey: true}));
  api.handleKeyDown(key({key: 'z', ctrlKey: true, shiftKey: true}));
  api.handleKeyDown(key({key: 'y', ctrlKey: true}));
  api.handleKeyDown(key({key: 'Delete'}));
  api.handleKeyDown(key({key: 'Escape'}));
  api.handleKeyDown(key({key: 'ArrowRight', shiftKey: true}));
  api.handleKeyDown(key({key: 'v'}));

  assert.deepEqual(calls, ['undo', 'redo', 'redo', 'delete', 'escape']);
  assert.deepEqual(nudges, [0.1]);
  assert.deepEqual(tools, ['select']);

  // Alt/Shift 是步长修饰键，方向键在任意步长修饰组合下都要命中。
  api.handleKeyDown(key({key: 'ArrowLeft', altKey: true}));
  api.handleKeyDown(key({key: 'ArrowUp'}));
  api.handleKeyDown(key({key: 'ArrowDown', shiftKey: true, altKey: true}));
  assert.deepEqual(nudges, [0.1, -0.001, -0.01, 0.001]);
  assert.equal(resolveShortcut(key({key: 'ArrowRight', ctrlKey: true})), null, 'Ctrl+方向键留给浏览器/系统');

  // 长按重复不能连环删。
  const before = calls.length;
  api.handleKeyDown(key({key: 'Delete', repeat: true}));
  assert.equal(calls.length, before, 'Delete 的长按重复应被忽略');
  api.handleKeyDown(key({key: 'z', ctrlKey: true, repeat: true}));
  assert.equal(calls.length, before, '撤销的长按重复应被忽略');

  // 空格按下/松开成对，重复按下不重复回调。
  api.handleKeyDown(key({key: ' '}));
  api.handleKeyDown(key({key: ' '}));
  assert.equal(api.isTemporaryPanActive(), true);
  api.handleKeyUp(key({key: ' '}));
  assert.deepEqual(pans, [true, false]);

  // 失焦必须复位临时平移。
  api.handleKeyDown(key({key: ' '}));
  api.releaseTemporaryPan();
  assert.equal(api.isTemporaryPanActive(), false);
});

test('enabled=false / shouldIgnore 时不消费任何按键', () => {
  let called = 0;
  const disabled = useShortcuts({target: null, enabled: false, onDelete: () => called++});
  assert.equal(disabled.handleKeyDown(key({key: 'Delete'})), null);
  assert.equal(called, 0);

  const ignored = useShortcuts({target: null, onDelete: () => called++, shouldIgnore: event => event.key === 'Delete'});
  assert.equal(ignored.handleKeyDown(key({key: 'Delete'})), null);
  assert.equal(called, 0);
});

test('自定义 specs 可以替换默认表，matchesShortcut 与 resolveShortcut 共用同一套语义', () => {
  const specs: ShortcutSpec[] = [{id: 'custom', action: 'escape', key: 'q', mod: true, label: '自定义'}];
  assert.equal(resolveShortcut(key({key: 'q', ctrlKey: true}), specs)?.action, 'escape');
  assert.equal(resolveShortcut(key({key: 'q'}), specs), null);
  assert.equal(resolveShortcut(key({key: 'Escape'}), specs), null, '替换表后默认表不再生效');
});

test('快捷键表无重复绑定，且 cheat sheet 能渲染出每个组合', () => {
  const ids = SHORTCUT_SPECS.map(spec => spec.id);
  assert.equal(new Set(ids).size, ids.length, '快捷键 id 必须唯一');
  // 同一 (key, 修饰键) 组合不能同时绑定给两个动作。
  const signatures = SHORTCUT_SPECS.map(spec =>
    [spec.key, spec.mod ? 'mod' : '', spec.ctrl ? 'ctrl' : '', spec.meta ? 'meta' : '', spec.shift ? 'shift' : '', spec.alt ? 'alt' : ''].join('|'),
  );
  assert.equal(new Set(signatures).size, signatures.length, '不允许同一个组合绑定两个动作');

  const sheet = shortcutCheatSheet();
  assert.equal(sheet.length, SHORTCUT_SPECS.length);
  assert.ok(sheet.some(row => row.keys === 'Ctrl/Cmd+Z'));
  assert.ok(sheet.some(row => row.keys === 'Ctrl+Y'));
  assert.ok(sheet.some(row => row.keys === 'Ctrl/Cmd+Shift+Z'));
  assert.ok(sheet.some(row => row.keys === 'Space'));
});
