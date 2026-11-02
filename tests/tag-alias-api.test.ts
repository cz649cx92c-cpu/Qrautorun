/**
 * 二维码别名的持久化、隔离与安全边界（真实 HTTP，临时库）。
 *
 * 关键：`createApp(tmpDb)` 走的是「测试数据库」分支——定位作用域门禁与
 * 300ms 启动延迟都只为生产实例保留，所以这里既不会碰 maps/navigation.db，
 * 也不可能触发实车导航。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../web/backend/src/server';

async function withApp(fn: (ctx: {call: Function; ids: {a: string; b: string}}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'alias-'));
  const db = join(dir, 'test.db');
  const app = await createApp(db);
  type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
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
    const probeA = await call('POST', '/maps/new', {name: '别名冒烟A', tagSizeMm: 60});
    if (probeA.status !== 200) {
      throw new Error('maps/new 失败: ' + probeA.status + ' ' + JSON.stringify(probeA.json).slice(0, 400));
    }
    const a = probeA.json;
    const b = (await call('POST', '/maps/new', {name: '别名冒烟B', tagSizeMm: 60})).json;
    assert.equal(typeof a.id, 'string');
    assert.equal(typeof b.id, 'string');
    // 每张图两个真实点位，别名才有可挂的 tagId。
    for (const id of [a.id, b.id]) {
      const added = await call('POST', `/maps/${id}/tags/grid`, {
        baseVersion: 1,
        originX: 0, originY: 0,
        columns: 2, rows: 1,
        spacingXM: 0.6, spacingYM: 0.6,
        sizeM: 0.06,
      });
      assert.equal(added.status, 200, JSON.stringify(added.json));
    }
    await fn({call, ids: {a: a.id, b: b.id}});
  } finally {
    await app.close();
    rmSync(dir, {recursive: true, force: true});
  }
}

test('别名：空 → 写入 → 读回，且不改地图版本与点位', async () => {
  await withApp(async ({call, ids}) => {
    const empty = await call('GET', `/maps/${ids.a}/tag-aliases`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.aliases, []);

    const before = await call('GET', `/maps/${ids.a}`);
    const beforeVersion = before.json.version;
    const beforeTags = before.json.map.tags.length;

    const saved = await call('POST', `/maps/${ids.a}/tag-aliases`, {
      aliases: [{tagId: 0, name: '东头桩'}, {tagId: 1, name: '二号桩'}],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.changed, 2);

    const read = await call('GET', `/maps/${ids.a}/tag-aliases`);
    assert.deepEqual(read.json.aliases.map((x: any) => [x.tagId, x.name]),
      [[0, '东头桩'], [1, '二号桩']]);

    // 铁律：别名不动地图 body、不动版本号
    const after = await call('GET', `/maps/${ids.a}`);
    assert.equal(after.json.version, beforeVersion, '别名不得升地图版本');
    assert.equal(after.json.map.tags.length, beforeTags, '别名不得增删点位');
    assert.deepEqual(after.json.map.tags.map((t: any) => t.id), before.json.map.tags.map((t: any) => t.id),
      '别名不得改变真实 tagId');
  });
});

test('别名：同一 tagId 在不同地图下互不影响', async () => {
  await withApp(async ({call, ids}) => {
    await call('POST', `/maps/${ids.a}/tag-aliases`, {aliases: [{tagId: 0, name: '东头桩'}]});
    await call('POST', `/maps/${ids.b}/tag-aliases`, {aliases: [{tagId: 0, name: '西头桩'}]});
    const a = await call('GET', `/maps/${ids.a}/tag-aliases`);
    const b = await call('GET', `/maps/${ids.b}/tag-aliases`);
    assert.equal(a.json.aliases.find((x: any) => x.tagId === 0).name, '东头桩');
    assert.equal(b.json.aliases.find((x: any) => x.tagId === 0).name, '西头桩');
  });
});

test('别名：重名、冒充编号、不存在的 tagId 都必须被拒', async () => {
  await withApp(async ({call, ids}) => {
    const dup = await call('POST', `/maps/${ids.a}/tag-aliases`, {
      aliases: [{tagId: 0, name: '同名'}, {tagId: 1, name: '同名'}],
    });
    assert.equal(dup.status, 400);
    assert.ok(String(dup.json.error).includes('重复'), String(dup.json.error));

    const fakeId = await call('POST', `/maps/${ids.a}/tag-aliases`, {
      aliases: [{tagId: 0, name: 'Q012'}],
    });
    assert.equal(fakeId.status, 400, '名称不得冒充编号');

    const unknown = await call('POST', `/maps/${ids.a}/tag-aliases`, {
      aliases: [{tagId: 586, name: '不存在'}],
    });
    assert.equal(unknown.status, 400);
    assert.ok(String(unknown.json.error).includes('不在这张地图中'));
  });
});

test('别名：DELETE 清空，删除地图时级联清除', async () => {
  await withApp(async ({call, ids}) => {
    await call('POST', `/maps/${ids.a}/tag-aliases`, {aliases: [{tagId: 0, name: '甲'}]});
    const cleared = await call('DELETE', `/maps/${ids.a}/tag-aliases`);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.removed, 1);
    const after = await call('GET', `/maps/${ids.a}/tag-aliases`);
    assert.deepEqual(after.json.aliases, []);

    // 重新写一个，再删整张图，别名必须一起消失
    await call('POST', `/maps/${ids.a}/tag-aliases`, {aliases: [{tagId: 0, name: '乙'}]});
    const deleted = await call('DELETE', `/maps/${ids.a}`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
    const gone = await call('GET', `/maps/${ids.a}/tag-aliases`);
    assert.equal(gone.status, 404, '地图已删，别名端点应 404 而不是返回残留');
  });
});

test('别名：未知地图返回 404', async () => {
  await withApp(async ({call}) => {
    assert.equal((await call('GET', '/maps/__nope__/tag-aliases')).status, 404);
    assert.equal((await call('POST', '/maps/__nope__/tag-aliases', {aliases: []})).status, 404);
  });
});
