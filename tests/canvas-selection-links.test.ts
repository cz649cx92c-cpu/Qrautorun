/**
 * 画布框选与连线的纯逻辑边界。
 *
 * 这些断言保护的是「画布交互语义」本身：框选从右下往左上拉也要命中、空框不许
 * 变成全选、连线不许自环、同一对码重复连线必须被拒并提示改用「第 N 次经过」。
 * 任何一条失败都意味着用户在图上的操作会得到与预期不符的结果。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  BOX_SELECT_MIN_SPAN,
  normalizeRect,
  isMeaningfulBox,
  pointsInRect,
  applyBoxSelection,
  applyClickSelection,
  toggleSelection,
  selectAll,
  clearSelection,
  type SelectionPoint,
} from '../web/frontend/src/composables/useCanvasSelection';
import {
  IDLE_LINK,
  beginLink,
  previewLink,
  cancelLink,
  resolveLink,
  previewSegment,
  linkCursor,
} from '../web/frontend/src/composables/useCanvasLinks';

const points: SelectionPoint[] = [
  {id: 0, x: 0, y: 0},
  {id: 1, x: 1, y: 0},
  {id: 2, x: 1, y: 1},
  {id: 5, x: 0, y: 0.6},
];

test('框选：矩形归一化，从右下往左上拉也得到正宽高', () => {
  const rect = normalizeRect({x: 1.2, y: 1.2}, {x: -0.2, y: -0.2});
  assert.deepEqual(rect, {x: -0.2, y: -0.2, width: 1.4, height: 1.4});
  const same = normalizeRect({x: 0.5, y: 0.5}, {x: 0.5, y: 0.5});
  assert.deepEqual(same, {x: 0.5, y: 0.5, width: 0, height: 0});
});

test('框选：拖动太小时视为单击，不产生选择', () => {
  const tiny = normalizeRect({x: 0.5, y: 0.5}, {x: 0.5 + BOX_SELECT_MIN_SPAN / 4, y: 0.5});
  assert.equal(isMeaningfulBox(tiny), false);
  assert.deepEqual(pointsInRect(points, tiny), [], '空框绝不能变成全选');
  const enough = normalizeRect({x: 0, y: 0}, {x: BOX_SELECT_MIN_SPAN, y: 0});
  assert.equal(isMeaningfulBox(enough), true);
});

test('框选：命中用点中心，边界上的点算命中', () => {
  // 覆盖 Q0 与 Q5（x=0 那一列），不含 Q1/Q2
  const column = normalizeRect({x: -0.1, y: -0.1}, {x: 0.1, y: 0.7});
  assert.deepEqual(pointsInRect(points, column), [0, 5]);
  // 恰好压在 Q1 中心：边界包含
  const onEdge = normalizeRect({x: 0.5, y: -0.5}, {x: 1, y: 0.5});
  assert.deepEqual(pointsInRect(points, onEdge), [1]);
  // 全图
  const all = normalizeRect({x: -1, y: -1}, {x: 2, y: 2});
  assert.deepEqual(pointsInRect(points, all), [0, 1, 2, 5]);
});

test('框选：替换与 Shift 加选语义', () => {
  assert.deepEqual(applyBoxSelection([9], [0, 1]), [0, 1], '默认替换');
  assert.deepEqual(applyBoxSelection([9], [0, 1], true), [9, 0, 1], 'Shift 并集');
  assert.deepEqual(applyBoxSelection([9], [], false), [], '空框清空选择');
  assert.deepEqual(applyBoxSelection([9], [], true), [9], 'Shift + 空框保持原选择');
  // 去重：命中集合里重复的 id 不会重复出现
  assert.deepEqual(applyBoxSelection([], [0, 0, 1]), [0, 1]);
});

test('点选：单选 / Shift 加选 / Shift 减选 / 切换', () => {
  assert.deepEqual(applyClickSelection([3, 4], 7), [7]);
  assert.deepEqual(applyClickSelection([3], 7, true), [3, 7]);
  assert.deepEqual(applyClickSelection([3, 7], 7, true), [3], 'Shift 点已选 = 减选');
  assert.deepEqual(toggleSelection([3, 7], 3), [7]);
  assert.deepEqual(toggleSelection([3], 3), []);
  assert.deepEqual(toggleSelection([], 4), [4]);
});

test('全选与清空', () => {
  assert.deepEqual(selectAll(points), [0, 1, 2, 5]);
  assert.deepEqual(clearSelection(), []);
});

test('连线：idle → from-selected → previewing → 提交后回到 idle', () => {
  assert.deepEqual(IDLE_LINK, {phase: 'idle', fromId: null, toId: null});
  let state = beginLink(0);
  assert.equal(state.phase, 'from-selected');
  assert.equal(state.fromId, 0);
  state = previewLink(state, 1);
  assert.equal(state.phase, 'previewing');
  assert.equal(state.toId, 1);
  const result = resolveLink(state, 1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.candidate, {fromId: 0, toId: 1});
  assert.equal(result.next.phase, 'idle', '提交后必须回到 idle，否则下一次点击会误连');
  assert.deepEqual(cancelLink(), IDLE_LINK);
});

test('连线：自环必须被拒，且不改变状态', () => {
  const state = previewLink(beginLink(2), 2);
  const result = resolveLink(state, 2);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.rejection.code, 'self-loop');
  assert.ok(result.rejection.message.includes('Q2'), result.rejection.message);
  assert.ok(result.rejection.message.includes('自环'), result.rejection.message);
  assert.equal(result.next.fromId, 2, '被拒后起点要保留，用户可以直接改点终点');
});

test('连线：已存在的同向边被拒，并指引改用「第 N 次经过」', () => {
  const state = beginLink(0);
  const result = resolveLink(state, 1, [{fromId: 0, toId: 1}]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.rejection.code, 'duplicate-link');
  assert.ok(result.rejection.message.includes('已经存在'), result.rejection.message);
  assert.ok(result.rejection.message.includes('第 2 次经过'), result.rejection.message);
  // 反向边不算重复：Q1→Q0 是另一条有向边
  const reverse = resolveLink(beginLink(1), 0, [{fromId: 0, toId: 1}]);
  assert.equal(reverse.ok, true);
});

test('连线：没有起点时点击终点给出明确提示', () => {
  const result = resolveLink(IDLE_LINK, 3);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.rejection.code, 'no-source');
  assert.ok(result.rejection.message.includes('起点'), result.rejection.message);
});

test('连线预览：起点取真实码心，终点优先吸附到候选码', () => {
  const centers = new Map([
    [0, {x: 0, y: 0}],
    [1, {x: 1, y: 0}],
  ]);
  assert.equal(previewSegment(IDLE_LINK, centers, {x: 0.5, y: 0.5}), null);
  // 起点存在，终点跟指针
  assert.deepEqual(previewSegment(beginLink(0), centers, {x: 0.4, y: 0.3}), {
    from: {x: 0, y: 0},
    to: {x: 0.4, y: 0.3},
  });
  // 候选终点存在时吸附到码心，而不是指针
  const snapped = previewSegment(previewLink(beginLink(0), 1), centers, {x: 0.9, y: 0.1});
  assert.deepEqual(snapped, {from: {x: 0, y: 0}, to: {x: 1, y: 0}});
  // 起点在地图上不存在时不给预览线（绝不臆造坐标）
  assert.equal(previewSegment(beginLink(9), centers, {x: 1, y: 1}), null);
});

test('连线光标：连线中必须是 crosshair', () => {
  assert.equal(linkCursor(IDLE_LINK), 'default');
  assert.equal(linkCursor(beginLink(0)), 'crosshair');
  assert.equal(linkCursor(previewLink(beginLink(0), 1)), 'crosshair');
});
