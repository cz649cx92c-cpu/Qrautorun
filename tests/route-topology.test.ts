/**
 * 路线拓扑（稳定 tagId 有向图）的语义边界。
 *
 * 这些断言只证明一件事：拓扑是**真实 tagId 的有向经过关系**，几何只是渲染结果。
 * 任何一条失败都意味着「画完图就能跑」这类误解可能变成实车风险，或者旧路径
 * 的区间被静默丢弃/重排。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPOLOGY_DISCLAIMER,
  routeTopologySchema,
  topologyFromSegments,
  topologyToPoints,
  validateTopology,
  topologySummary,
  topologyDrift,
  topologyStrategyChoices,
  nextOccurrence,
  addEdge,
  removeEdge,
  reverseEdge,
  moveOccurrence,
  type RouteTopology,
  type TopologyTagCenter,
} from '../web/shared/route-topology';

/** 一行三码：Q0 (0,0) Q1 (0.6,0) Q2 (1.2,0)；Q5 在 Q0 正上方 (0,0.6)。 */
const centers: TopologyTagCenter[] = [
  {id: 0, x: 0, y: 0},
  {id: 1, x: 0.6, y: 0},
  {id: 2, x: 1.2, y: 0},
  {id: 5, x: 0, y: 0.6},
];

const seg = (fromId: number, toId: number, extra: Record<string, unknown> = {}) => ({
  fromId, toId, mode: '4t4d' as const, direction: 'forward' as const, ...extra,
});

const topo = (edges: RouteTopology['edges']): RouteTopology => ({
  nodes: [...new Set(edges.flatMap(e => [e.fromId, e.toId]))].map(tagId => ({tagId})),
  edges,
});

test('拓扑：免责声明写死「保存拓扑不解锁实车执行」', () => {
  assert.ok(TOPOLOGY_DISCLAIMER.includes('不会解锁实车执行'), TOPOLOGY_DISCLAIMER);
  assert.ok(TOPOLOGY_DISCLAIMER.includes('安全门'), TOPOLOGY_DISCLAIMER);
});

test('拓扑：严格 wire format，未知字段必须被拒', () => {
  assert.equal(routeTopologySchema.safeParse({
    nodes: [{tagId: 0}, {tagId: 1}],
    edges: [{fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'}],
  }).success, true);
  // 多一个字段 = 客户端 bug，不能静默裁掉
  assert.equal(routeTopologySchema.safeParse({
    nodes: [{tagId: 0}],
    edges: [{fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward', typo: 1}],
  }).success, false);
  // tagId 必须是 0–586 的真实编号
  assert.equal(routeTopologySchema.safeParse({
    nodes: [{tagId: 587}],
    edges: [{fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'}],
  }).success, false);
  assert.equal(routeTopologySchema.safeParse({nodes: [{tagId: 0}], edges: []}).success, false);
});

test('拓扑还原：按链序而不是数组序还原段顺序', () => {
  // 故意打乱数组顺序：真实链序是 0→1 → 1→2 → 2→5
  const restored = topologyFromSegments([seg(1, 2), seg(2, 5), seg(0, 1)]);
  assert.deepEqual(restored.topology.edges.map(e => [e.fromId, e.toId]), [
    [0, 1], [1, 2], [2, 5],
  ]);
  assert.deepEqual(restored.topology.nodes.map(n => n.tagId).sort((a, b) => a - b), [0, 1, 2, 5]);
  assert.equal(restored.issues.filter(i => i.severity === 'error').length, 0);
});

test('拓扑还原：同一对码重复经过按路线顺序编号 1..N', () => {
  const restored = topologyFromSegments([seg(0, 1), seg(1, 0), seg(0, 1)]);
  assert.deepEqual(restored.topology.edges.map(e => [e.fromId, e.toId, e.occurrence]), [
    [0, 1, 1],
    [1, 0, 1],
    [0, 1, 2],
  ]);
  // 首尾相接成环时保留全部区间，但要说清楚起点不唯一
  assert.ok(restored.issues.some(i => i.code === 'cyclic-chain'), JSON.stringify(restored.issues));
});

test('拓扑还原：断链只警告、绝不丢区间', () => {
  const restored = topologyFromSegments([seg(0, 1), seg(2, 5)]);
  assert.equal(restored.topology.edges.length, 2, '断链不得丢弃任何区间');
  assert.ok(restored.issues.some(i => i.code === 'broken-chain'));
});

test('拓扑还原：没有区间时明确报错，而不是给一个空图', () => {
  const restored = topologyFromSegments([]);
  assert.equal(restored.topology.edges.length, 0);
  assert.ok(restored.issues.some(i => i.severity === 'error' && i.code === 'empty-segments'));
});

test('拓扑校验：未知码、自环、断链、重复经过、编号跳号、斜线都必须拦住', () => {
  const ok = validateTopology(topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'},
    {fromId: 1, toId: 2, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]), centers);
  assert.equal(ok.errors.length, 0, JSON.stringify(ok.errors));

  const unknown = validateTopology(topo([
    {fromId: 0, toId: 9, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]), centers);
  assert.ok(unknown.errors.some(i => i.code === 'unknown-tag'), JSON.stringify(unknown.errors));

  const selfLoop = validateTopology(topo([
    {fromId: 0, toId: 0, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]), centers);
  assert.ok(selfLoop.errors.some(i => i.code === 'self-loop'));

  const broken = validateTopology(topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'},
    {fromId: 2, toId: 5, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]), centers);
  assert.ok(broken.errors.some(i => i.code === 'broken-chain'));

  const duplicate = validateTopology(topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'},
    {fromId: 1, toId: 0, occurrence: 1, mode: '4t4d', direction: 'forward'},
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'},
    {fromId: 1, toId: 2, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]), centers);
  assert.ok(duplicate.errors.some(i => i.code === 'duplicate-occurrence'), JSON.stringify(duplicate.errors));

  const gap = validateTopology(topo([
    {fromId: 0, toId: 1, occurrence: 2, mode: '4t4d', direction: 'forward'},
    {fromId: 1, toId: 2, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]), centers);
  assert.ok(gap.errors.some(i => i.code === 'occurrence-order'));

  // Q0→Q5 是竖直的（合法），Q1→Q5 既不同行也不同列（必须拒绝）
  const vertical = validateTopology(topo([
    {fromId: 0, toId: 5, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]), centers);
  assert.equal(vertical.errors.length, 0, JSON.stringify(vertical.errors));
  const diagonal = validateTopology(topo([
    {fromId: 1, toId: 5, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]), centers);
  assert.ok(diagonal.errors.some(i => i.code === 'diagonal-edge'), JSON.stringify(diagonal.errors));
});

test('拓扑校验：crab 只能配 lateral，中间点必须正交', () => {
  const bad = validateTopology(topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: 'crab', direction: 'forward'},
  ]), centers);
  assert.ok(bad.errors.some(i => i.code === 'mode-direction'));

  const crabOk = validateTopology(topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: 'crab', direction: 'lateral'},
  ]), centers);
  assert.equal(crabOk.errors.length, 0, JSON.stringify(crabOk.errors));

  const diagonalWaypoint = validateTopology(topo([
    {
      fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward',
      waypoints: [{x: 0.3, y: 0.3}],
    },
  ]), centers);
  assert.ok(diagonalWaypoint.errors.some(i => i.code === 'diagonal-waypoint'));

  const orthogonalWaypoint = validateTopology(topo([
    {
      fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward',
      waypoints: [{x: 0, y: 0.3}, {x: 0.6, y: 0.3}],
    },
  ]), centers);
  assert.equal(orthogonalWaypoint.errors.length, 0, JSON.stringify(orthogonalWaypoint.errors));
});

test('拓扑展平：真实码心 → 中间点 → 码心，缺码报错且绝不臆造坐标', () => {
  const flat = topologyToPoints(topo([
    {
      fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward',
      waypoints: [{x: 0, y: 0.3}, {x: 0.6, y: 0.3}],
    },
  ]), centers);
  assert.deepEqual(flat.points, [
    {x: 0, y: 0},
    {x: 0, y: 0.3},
    {x: 0.6, y: 0.3},
    {x: 0.6, y: 0},
  ]);
  assert.equal(flat.issues.length, 0);

  const missing = topologyToPoints(topo([
    {fromId: 0, toId: 9, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]), centers);
  assert.ok(missing.issues.some(i => i.code === 'missing-tag'));
  assert.deepEqual(missing.points, [{x: 0, y: 0}], '不得为不存在的码编造终点');
});

test('拓扑展平：连续重复点被折叠（含首尾相接的两段）', () => {
  const flat = topologyToPoints(topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'},
    {fromId: 1, toId: 2, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]), centers);
  assert.deepEqual(flat.points, [{x: 0, y: 0}, {x: 0.6, y: 0}, {x: 1.2, y: 0}]);
});

test('拓扑摘要：中文逐段说明，缺码时明确点名', () => {
  const lines = topologySummary(topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'},
    {fromId: 1, toId: 0, occurrence: 1, mode: '4t4d', direction: 'reverse'},
    {fromId: 0, toId: 1, occurrence: 2, mode: 'crab', direction: 'lateral'},
  ]), centers);
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.includes('Q0 → Q1'), lines[0]);
  assert.ok(lines[0]!.includes('0.60 m'), lines[0]);
  assert.ok(lines[1]!.includes('倒车'), lines[1]);
  assert.ok(lines[2]!.includes('第 2 次经过'), lines[2]);
  assert.ok(lines[2]!.includes('Crab'), lines[2]);

  const missing = topologySummary(topo([
    {fromId: 0, toId: 9, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]), centers);
  assert.ok(missing[0]!.includes('地图缺少 Q9'), missing[0]);
});

test('拓扑策略：strategy 映射为 0-based occurrence 的编译选择，未知策略按自动处理', () => {
  const {choices, issues} = topologyStrategyChoices(topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward', strategy: 'reverse'},
    {fromId: 1, toId: 0, occurrence: 1, mode: '4t4d', direction: 'forward'},
    {fromId: 0, toId: 1, occurrence: 2, mode: '4t4d', direction: 'forward', strategy: 'left'},
  ]));
  assert.deepEqual(choices, [
    {fromId: 0, toId: 1, occurrence: 0, mode: 'reverse'},
    {fromId: 0, toId: 1, occurrence: 1, mode: 'left'},
  ]);
  assert.equal(issues.length, 0);

  const unknown = topologyStrategyChoices(topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward', strategy: 'teleport'},
  ]));
  assert.equal(unknown.choices.length, 0);
  assert.ok(unknown.issues.some(i => i.code === 'unknown-strategy'));
});

test('拓扑漂移：编译多拆的段、方向/模式变化都要报出来，不静默改口', () => {
  const declared = topo([
    {fromId: 0, toId: 2, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]);
  const actual = topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'},
    {fromId: 1, toId: 2, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]);
  const drift = topologyDrift(declared, actual);
  assert.ok(drift.some(i => i.code === 'edge-not-compiled'), JSON.stringify(drift));
  assert.equal(drift.filter(i => i.code === 'edge-split').length, 2);

  const same = topologyDrift(declared, declared);
  assert.equal(same.length, 0);
});

test('拓扑编辑：新增段自动编号，自环与模式不一致被拒且不改原对象', () => {
  const base = topo([{fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'}]);
  const frozen = JSON.parse(JSON.stringify(base));

  const added = addEdge(base, {fromId: 1, toId: 0, mode: '4t4d', direction: 'reverse'});
  assert.deepEqual(added.topology.edges.map(e => [e.fromId, e.toId, e.occurrence]), [
    [0, 1, 1], [1, 0, 1],
  ]);
  assert.equal(added.issues.length, 0);

  const second = addEdge(added.topology, {fromId: 0, toId: 1, mode: '4t4d', direction: 'forward'});
  assert.deepEqual(second.topology.edges.map(e => e.occurrence), [1, 1, 2]);
  assert.equal(nextOccurrence(added.topology, 0, 1), 2);

  assert.ok(addEdge(base, {fromId: 0, toId: 0, mode: '4t4d', direction: 'forward'})
    .issues.some(i => i.code === 'self-loop'));
  assert.ok(addEdge(base, {fromId: 0, toId: 1, mode: 'crab', direction: 'forward'})
    .issues.some(i => i.code === 'mode-direction'));
  // 跳号：已有第 1 次却硬要第 2 次以外的号
  assert.ok(addEdge(added.topology, {fromId: 0, toId: 1, occurrence: 5, mode: '4t4d', direction: 'forward'})
    .issues.some(i => i.code === 'duplicate-occurrence'));

  assert.deepEqual(base, frozen, '纯函数不得修改入参');
});

test('拓扑编辑：删除中间那一次经过会重编号并明确告知', () => {
  const base = topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'},
    {fromId: 1, toId: 0, occurrence: 1, mode: '4t4d', direction: 'reverse'},
    {fromId: 0, toId: 1, occurrence: 2, mode: '4t4d', direction: 'forward'},
  ]);
  const removed = removeEdge(base, 0, 1, 1);
  assert.deepEqual(removed.topology.edges.map(e => [e.fromId, e.toId, e.occurrence]), [
    [1, 0, 1], [0, 1, 1],
  ]);
  assert.ok(removed.issues.some(i => i.code === 'renumbered'));
  assert.ok(removeEdge(base, 0, 1, 9).issues.some(i => i.code === 'not-found'));
  // 删掉最后一段：没有「后一段」，不得因为读 undefined 而抛异常
  const tail = removeEdge(base, 0, 1, 2);
  assert.deepEqual(tail.topology.edges.map(e => [e.fromId, e.toId, e.occurrence]), [
    [0, 1, 1], [1, 0, 1],
  ]);
  // 删掉唯一一段：结果为空图，仍然不抛
  const only = topo([{fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'}]);
  assert.equal(removeEdge(only, 0, 1, 1).topology.edges.length, 0);
});

test('拓扑编辑：反向交换端点与方向，横移保持 lateral，断链只警告', () => {
  const base = topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward'},
    {fromId: 1, toId: 2, occurrence: 1, mode: '4t4d', direction: 'forward'},
  ]);
  const reversed = reverseEdge(base, 0, 1, 1);
  assert.deepEqual(reversed.topology.edges[0], {
    fromId: 1, toId: 0, occurrence: 1, mode: '4t4d', direction: 'reverse',
  });
  assert.ok(reversed.issues.some(i => i.code === 'broken-chain'), '反向必然断开链，必须说出来');

  const lateral = reverseEdge(topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: 'crab', direction: 'lateral'},
  ]), 0, 1, 1);
  assert.equal(lateral.topology.edges[0]!.direction, 'lateral');
  assert.equal(lateral.topology.edges[0]!.mode, 'crab');
});

test('拓扑编辑：交换同一对码的经过次序，编号始终连续', () => {
  const base = topo([
    {fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward', strategy: 'reverse'},
    {fromId: 1, toId: 0, occurrence: 1, mode: '4t4d', direction: 'reverse'},
    {fromId: 0, toId: 1, occurrence: 2, mode: '4t4d', direction: 'forward', strategy: 'left'},
  ]);
  const moved = moveOccurrence(base, 0, 1, 1, 2);
  assert.equal(moved.topology.edges.length, 3, '移动只是换次序，不增删段');
  // 槽位不变、编号始终 1..N 按路线顺序递增；被移动那一段的策略跟着它走，
  // 因为策略描述的就是这一次通过。
  assert.deepEqual(moved.topology.edges.map(e => [e.fromId, e.toId, e.occurrence]), [
    [0, 1, 1], [1, 0, 1], [0, 1, 2],
  ]);
  assert.deepEqual(moved.topology.edges.map(e => e.strategy), ['left', undefined, 'reverse']);
  const renumbered = validateTopology(moved.topology, centers);
  assert.equal(renumbered.errors.length, 0, JSON.stringify(renumbered.errors));
  assert.ok(moveOccurrence(base, 0, 1, 1, 9).issues.some(i => i.code === 'not-found'));
});
