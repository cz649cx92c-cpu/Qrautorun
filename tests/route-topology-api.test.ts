/**
 * 路线拓扑接口：真实 HTTP、临时库。
 *
 * 这里要证明的边界有三条：
 *   1. 拓扑以**真实 tagId** 存取，独立于 points/motionSegments，删拓扑不删路径；
 *   2. 保存拓扑**不解锁实车执行**——`map-only` 地图照样被 423 拦住；
 *   3. 非法拓扑（未知码 / 断链 / 斜线 / 版本失配）一律被拒，且不会留下半成品。
 *
 * `createApp(tmpDb)` 走测试数据库分支：定位作用域门禁与启动延迟都不生效，
 * 也永远不会碰 maps/navigation.db，更不可能触发实车导航。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** 一行三码：Q0 (0,0) Q1 (0.6,0) Q2 (1.2,0)，全部水平共线，可直接编译。 */
const TAGS = {originX: 0, originY: 0, columns: 3, rows: 1, spacingXM: 0.6, spacingYM: 0.6, sizeM: 0.06};

async function withRoute(fn: (ctx: {
  call: (method: Method, url: string, body?: unknown) => Promise<{status: number; json: any}>;
  mapId: string;
  routeId: string;
  baseVersion: number;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'topology-'));
  const app = await createApp(join(dir, 'test.db'));
  const call = async (method: Method, url: string, body?: unknown) => {
    const res = await app.inject({
      method,
      url: '/api' + url,
      ...(body === undefined ? {} : {payload: body as object}),
    });
    let json: any = {};
    try {
      json = res.body ? JSON.parse(res.body) : {};
    } catch {
      json = {raw: res.body.slice(0, 200)};
    }
    return {status: res.statusCode, json};
  };
  try {
    const created = await call('POST', '/maps/new', {name: '拓扑冒烟', tagSizeMm: 60});
    assert.equal(created.status, 200, JSON.stringify(created.json).slice(0, 400));
    const mapId: string = created.json.id;
    const tags = await call('POST', `/maps/${mapId}/tags/grid`, {baseVersion: 1, ...TAGS});
    assert.equal(tags.status, 200, JSON.stringify(tags.json).slice(0, 400));
    // 0→1→2 的正交折线：三个码心直接连起来
    const designed = await call('POST', '/route/design', {
      mapId,
      baseVersion: tags.json.version ?? tags.json.map?.version ?? 2,
      points: [{x: 0, y: 0}, {x: 0.6, y: 0}, {x: 1.2, y: 0}],
      bodyYawDeg: 0,
      routeName: '拓扑冒烟路线',
    });
    assert.equal(designed.status, 200, JSON.stringify(designed.json).slice(0, 400));
    const routeId: string = designed.json.routeId ?? designed.json.route?.routeId;
    assert.equal(typeof routeId, 'string');
    const baseVersion: number = designed.json.mapVersion ?? designed.json.route?.mapVersion;
    assert.equal(typeof baseVersion, 'number');
    await fn({call, mapId, routeId, baseVersion});
  } finally {
    await app.close();
    rmSync(dir, {recursive: true, force: true});
  }
}

const edges = (...list: [number, number][]) => list.map(([fromId, toId], index) => ({
  fromId, toId, occurrence: 1, mode: '4t4d' as const, direction: 'forward' as const,
}));

test('拓扑：未保存时从 motionSegments 还原，而不是 404', async () => {
  await withRoute(async ({call, routeId}) => {
    const read = await call('GET', `/routes/${routeId}/topology`);
    assert.equal(read.status, 200, JSON.stringify(read.json).slice(0, 400));
    assert.equal(read.json.stored, false, '尚未保存过拓扑');
    assert.deepEqual(read.json.topology.edges.map((e: any) => [e.fromId, e.toId, e.occurrence]),
      [[0, 1, 1], [1, 2, 1]]);
    assert.ok(read.json.summary.length >= 2, JSON.stringify(read.json.summary));
    assert.ok(String(read.json.disclaimer).includes('不会解锁实车执行'));
  });
});

test('拓扑：保存后读回，且不改路径点数与版本', async () => {
  await withRoute(async ({call, routeId, baseVersion}) => {
    const before = await call('GET', `/routes/${routeId}`);
    const beforePoints = before.json.points.length;
    const beforeUpdated = before.json.updated;

    const saved = await call('PUT', `/routes/${routeId}/topology`, {
      baseVersion,
      topology: {
        nodes: [{tagId: 0}, {tagId: 1}, {tagId: 2}],
        edges: edges([0, 1], [1, 2], [2, 1], [1, 0]),
      },
      savePoints: false,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 500));
    assert.equal(saved.json.stored, true);
    assert.deepEqual(saved.json.topology.edges.map((e: any) => [e.fromId, e.toId, e.occurrence]), [
      [0, 1, 1], [1, 2, 1], [2, 1, 1], [1, 0, 1],
    ]);

    const read = await call('GET', `/routes/${routeId}/topology`);
    assert.equal(read.json.stored, true);
    assert.equal(read.json.topology.edges.length, 4);

    // savePoints:false 表示「只声明有向关系」，不得动已编译的折线
    const after = await call('GET', `/routes/${routeId}`);
    assert.equal(after.json.points.length, beforePoints, '只存拓扑不得改折线');
    assert.equal(after.json.updated, beforeUpdated, '只存拓扑不得改路径时间戳');
  });
});

test('拓扑：savePoints 复用编译安全门，斜线/未知码/断链/不可编译折返一律 400 且不留半成品', async () => {
  await withRoute(async ({call, routeId, baseVersion}) => {
    // 1) 中间点造成斜线：拓扑校验自己就该拒绝
    const diagonal = await call('PUT', `/routes/${routeId}/topology`, {
      baseVersion,
      topology: {
        nodes: [{tagId: 0}, {tagId: 2}],
        edges: [{
          fromId: 0, toId: 2, occurrence: 1, mode: '4t4d', direction: 'forward',
          waypoints: [{x: 0.6, y: 0.3}],
        }],
      },
      savePoints: true,
    });
    assert.equal(diagonal.status, 400, JSON.stringify(diagonal.json).slice(0, 500));
    assert.ok(String(diagonal.json.error).includes('水平'), String(diagonal.json.error));

    // 2) 未知码
    const unknown = await call('PUT', `/routes/${routeId}/topology`, {
      baseVersion,
      topology: {nodes: [{tagId: 0}, {tagId: 9}], edges: edges([0, 9])},
      savePoints: false,
    });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.json).slice(0, 500));

    // 3) 断链
    const broken = await call('PUT', `/routes/${routeId}/topology`, {
      baseVersion,
      topology: {nodes: [{tagId: 0}, {tagId: 1}, {tagId: 2}], edges: edges([0, 1], [2, 1])},
      savePoints: false,
    });
    assert.equal(broken.status, 400, JSON.stringify(broken.json).slice(0, 500));

    // 4) 正交但不可编译：绕行拐角没有定位码，必须由**现有编译器**拒绝，
    //    这正是「复用安全门」的证据——拓扑本身合法，编译不合法。
    const detour = await call('PUT', `/routes/${routeId}/topology`, {
      baseVersion,
      topology: {
        nodes: [{tagId: 0}, {tagId: 1}, {tagId: 2}],
        edges: [{
          fromId: 0, toId: 1, occurrence: 1, mode: '4t4d', direction: 'forward',
          waypoints: [{x: 0, y: 0.3}, {x: 0.6, y: 0.3}],
        }, {
          fromId: 1, toId: 2, occurrence: 1, mode: '4t4d', direction: 'forward',
        }],
      },
      savePoints: true,
    });
    assert.equal(detour.status, 400, JSON.stringify(detour.json).slice(0, 500));
    assert.ok(String(detour.json.error).includes('定位组'), String(detour.json.error));

    // 四次拒绝之后仍然没有存下任何拓扑，也没有改写路径折线
    const read = await call('GET', `/routes/${routeId}/topology`);
    assert.equal(read.json.stored, false, '被拒的写入不得落库');
    const route = await call('GET', `/routes/${routeId}`);
    assert.equal(route.json.points.length, 3, '被拒的写入不得改写折线');
  });
});

test('拓扑：savePoints 成功后折线来自拓扑展平，区间数与段数一致', async () => {
  await withRoute(async ({call, routeId, baseVersion}) => {
    const saved = await call('PUT', `/routes/${routeId}/topology`, {
      baseVersion,
      topology: {
        nodes: [{tagId: 0}, {tagId: 1}, {tagId: 2}],
        edges: edges([0, 1], [1, 2]),
      },
      savePoints: true,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 600));
    // 折线由真实码心展平而来，坐标就是地图里的 tag 坐标
    assert.deepEqual(saved.json.points, [{x: 0, y: 0}, {x: 0.6, y: 0}, {x: 1.2, y: 0}]);
    assert.equal(saved.json.segments.length, 2, '两个拓扑段编译成两个运动区间');
    assert.deepEqual(saved.json.segments.map((s: any) => [s.fromId, s.toId]),
      [[0, 1], [1, 2]], '区间端点就是拓扑里的真实 tagId');

    const after = await call('GET', `/routes/${routeId}`);
    assert.deepEqual(after.json.points, saved.json.points, '折线已写进路径');
    assert.equal(after.json.mapVersion, baseVersion, '不得顺手升地图版本');
  });
});

test('拓扑：baseVersion 失配返回 409，不覆盖别人的拓扑', async () => {
  await withRoute(async ({call, routeId, baseVersion}) => {
    const stale = await call('PUT', `/routes/${routeId}/topology`, {
      baseVersion: baseVersion + 7,
      topology: {nodes: [{tagId: 0}, {tagId: 1}], edges: edges([0, 1])},
      savePoints: false,
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.json).slice(0, 400));
    assert.ok(String(stale.json.error).includes('版本'), String(stale.json.error));
  });
});

test('拓扑：删除拓扑只删图，路径本身仍在', async () => {
  await withRoute(async ({call, routeId, baseVersion}) => {
    await call('PUT', `/routes/${routeId}/topology`, {
      baseVersion,
      topology: {nodes: [{tagId: 0}, {tagId: 1}, {tagId: 2}], edges: edges([0, 1], [1, 2])},
      savePoints: false,
    });
    const removed = await call('DELETE', `/routes/${routeId}/topology`);
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(removed.json.removed, 1);

    const read = await call('GET', `/routes/${routeId}/topology`);
    assert.equal(read.json.stored, false, '删完回到「未保存」状态');
    assert.equal(read.json.topology.edges.length, 2, '仍然能从 motionSegments 还原');

    const route = await call('GET', `/routes/${routeId}`);
    assert.equal(route.status, 200, '删除拓扑不得删除路径');
    assert.equal(route.json.points.length, 3);
  });
});

test('拓扑：保存拓扑不解锁实车执行，导航启动仍被拒', async () => {
  await withRoute(async ({call, mapId, routeId, baseVersion}) => {
    await call('PUT', `/routes/${routeId}/topology`, {
      baseVersion,
      topology: {nodes: [{tagId: 0}, {tagId: 1}, {tagId: 2}], edges: edges([0, 1], [1, 2])},
      savePoints: true,
    });
    // 空 body 是安全的结构探针：不会发出任何运动指令。
    const start = await call('POST', '/navigation/start', {});
    assert.ok(start.status === 400 || start.status === 423, 'start 必须被拒: ' + start.status);
    assert.notEqual(start.status, 200, '保存拓扑绝不能让导航启动成功');
    assert.equal(typeof mapId, 'string');
  });
});

test('拓扑：未知路径 404，未知地图删除会级联清理拓扑', async () => {
  await withRoute(async ({call, mapId, routeId, baseVersion}) => {
    assert.equal((await call('GET', '/routes/route-does-not-exist/topology')).status, 404);
    assert.equal((await call('PUT', '/routes/route-does-not-exist/topology', {
      baseVersion, topology: {nodes: [{tagId: 0}, {tagId: 1}], edges: edges([0, 1])}, savePoints: false,
    })).status, 404);

    await call('PUT', `/routes/${routeId}/topology`, {
      baseVersion,
      topology: {nodes: [{tagId: 0}, {tagId: 1}, {tagId: 2}], edges: edges([0, 1], [1, 2])},
      savePoints: false,
    });
    const deleted = await call('DELETE', `/maps/${mapId}`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json).slice(0, 400));
    // 地图没了，路径与拓扑一起消失，不留悬空行
    assert.equal((await call('GET', `/routes/${routeId}/topology`)).status, 404);
  });
});
