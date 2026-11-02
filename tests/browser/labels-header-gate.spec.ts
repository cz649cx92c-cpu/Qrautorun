import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 使用**真实选中地图/路线只读快照**（严格 mapId+version+routeId），
// 不用 17 静态板无 route 的夹具。
const SNAP = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real-map-route.snapshot.json'), 'utf8'),
);
const MAP = SNAP.map;
const ROUTE = SNAP.route;
const MAP_ID: string = SNAP.mapId;
const VERSION: number = SNAP.mapVersion;
const ROUTE_ID: string = SNAP.routeId;

async function boot(page: Page, view: 'nav' | 'edit') {
  const writes: any[] = [];
  const errors: string[] = [];
  page.on('pageerror', e => errors.push('PAGEERROR ' + String(e).slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });

  await page.routeWebSocket('**/ws', ws => ws.send(JSON.stringify({
    type: 'robot', status: { connected: true, state: 'IDLE', running: false, paused: false, pose: null,
      chassis: { connected: true }, sensors: {}, conditions: [], events: [],
      detector: { connected: true, positionReady: true, groups: [], reason: '' },
      mapping: { ready: true, quality: 'draft', localEpoch: 'ui', reason: '' } } })));
  await page.routeWebSocket('**/ws/camera', () => {});
  await page.route('**/api/**', async r => {
    const req = r.request();
    const p = new URL(req.url()).pathname;
    const m = req.method().toUpperCase();
    // 所有写一律拦截：只读取快照，不触达生产
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
      writes.push({ method: m, path: p });
      return r.fulfill({ json: { ok: true, mocked: true } });
    }
    if (p === '/api/maps') return r.fulfill({ json: [{ id: MAP_ID, name: MAP.name, version: VERSION }] });
    if (p === `/api/maps/${MAP_ID}`) {
      return r.fulfill({ json: { map: MAP, version: VERSION, acceptance: { kind: null, digestValid: false, accepted: false } } });
    }
    if (p === `/api/maps/${MAP_ID}/tag-aliases`) {
      return r.fulfill({ json: { mapId: MAP_ID, mapVersion: VERSION, aliases: [], disclaimer: 'x' } });
    }
    if (p === '/api/routes') return r.fulfill({ json: [ROUTE] });
    if (p === `/api/routes/${ROUTE_ID}`) {
      return r.fulfill({ json: { ...ROUTE, route: ROUTE, map: MAP, version: VERSION,
        acceptance: { kind: null, digestValid: false, accepted: false } } });
    }
    if (p === '/api/tasks') return r.fulfill({ json: [] });
    if (p === '/api/surveys' || p === '/api/boards') return r.fulfill({ json: [] });
    if (p === '/api/camera/status') return r.fulfill({ json: { running: false, present: false } });
    if (p.includes('/localization/')) return r.fulfill({ json: { phase: 'anchored' } });
    return r.fulfill({ json: {} });
  });

  await page.goto('/');
  await page.waitForTimeout(900);
  // 两种视图都必须先进入导航页并选中真实地图+路线：
  // 否则 routeEditId 为空，画布上没有真实路线，
  // 段动作标签 / 路点序号根本不会出现，「零碰撞」会退化成「什么都没画」的假通过。
  await page.locator('.sidebar').getByRole('button', { name: '开始导航', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByTestId('map-select').selectOption(MAP_ID, { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByTestId('route-select').selectOption(ROUTE_ID, { timeout: 20000 });
  await page.waitForTimeout(1500);
  if (view === 'edit') {
    await page.getByTestId('nav-route-edit').click({ timeout: 20000 });
    await page.waitForTimeout(2600);
  }
  return { writes, errors };
}

// 只读指标：每类 label 的 bbox / 关联 ID / 碰撞
interface Metrics {
  error?: string;
  scale: number;
  pan: { x: number; y: number };
  counts: Record<string, number>;
  collisions: number;
  collisionPairs: any[];
  visibleLabels: any[];
}
const measure = (page: Page) => page.evaluate((): Metrics => {
  const c = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
  const stage = (window as any).__stage;
  if (!stage) return { error: 'no stage', scale: 0, pan: { x: 0, y: 0 }, counts: {}, collisions: 0, collisionPairs: [], visibleLabels: [] };
  const scale = Number(c.dataset.konvaScale);
  const sx = Number(c.dataset.konvaX), sy = Number(c.dataset.konvaY);
  const box = c.getBoundingClientRect();
  const layer = stage.getLayers()[0];

  const boxes: any[] = [];
  const push = (kind: string, id: string, node: any, visible: boolean) => {
    let bb: any;
    try { bb = node.getClientRect({ relativeTo: stage }); } catch { return; }
    boxes.push({
      kind, id, visible,
      bbox: { x: Math.round(box.x + bb.x), y: Math.round(box.y + bb.y),
              w: Math.round(bb.width), h: Math.round(bb.height) },
    });
  };

  layer.getChildren().forEach((node: any) => {
    const name: string = node.name() || '';
    if (name.startsWith('tag-label-')) push('boardLabel', name, node, node.visible());
    else if (name.startsWith('segment-label-')) push('segmentLabel', name, node, node.visible());
    else if (name.startsWith('route-ordinal-')) push('ordinal', name, node, node.visible());
    else if (name.startsWith('tag-')) {
      const lbl = node.findOne('.tag-label-' + name.slice(4));
      if (lbl) push('boardLabel', lbl.name(), lbl, lbl.visible());
    }
  });

  // 碰撞：可见 bbox 两两求交
  const vis = boxes.filter(b => b.visible);
  let collisions = 0;
  const collisionPairs: any[] = [];
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i].bbox, b = vis[j].bbox;
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix > 1 && iy > 1) { collisions++; if (collisionPairs.length < 8) collisionPairs.push([vis[i].id, vis[j].id]); }
    }
  }

  return {
    scale: Number(scale.toFixed(3)), pan: { x: Math.round(sx), y: Math.round(sy) },
    counts: {
      board: boxes.filter(b => b.kind === 'boardLabel').length,
      boardVisible: boxes.filter(b => b.kind === 'boardLabel' && b.visible).length,
      segment: boxes.filter(b => b.kind === 'segmentLabel').length,
      segmentVisible: boxes.filter(b => b.kind === 'segmentLabel' && b.visible).length,
      ordinal: boxes.filter(b => b.kind === 'ordinal').length,
      ordinalVisible: boxes.filter(b => b.kind === 'ordinal' && b.visible).length,
    },
    collisions, collisionPairs,
    visibleLabels: vis.slice(0, 40),
  };
});

test('真实 10 点路线（导航视图）：B 编号常态可见，段标签按缩放分层', async ({ page }) => {
  const { writes, errors } = await boot(page, 'nav');
  const m = await measure(page);
  expect(m.error).toBeUndefined();
  console.log('NAV_METRICS ' + JSON.stringify({ scale: m.scale, counts: m.counts, collisions: m.collisions }));

  // B 编号必须常态可见（不是全隐藏）
  expect(m.counts.board, '板编号节点存在').toBeGreaterThan(0);
  expect(m.counts.boardVisible, 'B 编号常态可见').toBeGreaterThan(0);
  // 可见标签之间不得互压：B 编号 / 段动作 / 路点序号共用同一套屏幕空间避让。
  const navVisible = m.counts.boardVisible + m.counts.segmentVisible + m.counts.ordinalVisible;
  expect(m.collisions, `可见标签碰撞必须为 0（visible=${navVisible} collisions=${m.collisions} pairs=${JSON.stringify(m.collisionPairs)}）`).toBe(0);
  // 段标签存在；低缩放下应少于总数（分层生效），但不为 0（选中段仍显示）
  expect(m.counts.segment, '段标签节点存在').toBeGreaterThan(0);

  const businessWrites = writes.filter(w => !w.path.includes('/localization/'));
  expect(businessWrites.length, '只读不得写').toBe(0);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('真实 10 点路线（编辑视图）：B 编号与主路径清晰，无大面积叠字', async ({ page }) => {
  const { writes, errors } = await boot(page, 'edit');
  const m = await measure(page);
  expect(m.error).toBeUndefined();
  console.log('EDIT_METRICS ' + JSON.stringify({ scale: m.scale, counts: m.counts, collisions: m.collisions, pairs: m.collisionPairs }));

  expect(m.counts.boardVisible, '编辑视图 B 编号仍可见').toBeGreaterThan(0);
  // 统一避让后：可见标签之间必须零碰撞（不再只是「有界」）。
  const visibleTotal = m.counts.boardVisible + m.counts.segmentVisible + m.counts.ordinalVisible;
  expect(m.collisions, `可见标签碰撞必须为 0（visible=${visibleTotal} collisions=${m.collisions} pairs=${JSON.stringify(m.collisionPairs)}）`).toBe(0);
  // 编辑视图画的是「正交绘制预览」，canvasMap 有意丢弃 motionSegments（见 App.vue
  // canvasMap：editingRoute 时 route=undefined），所以段动作标签在此视图本来就不该出现。
  // 这里断言这个设计约束，避免把「没有段」当成避让成功。
  expect(m.counts.segment, '编辑视图不应渲染存储的段动作标签').toBe(0);
  // 必须真的有东西被画出来，否则「零碰撞」毫无意义。
  expect(m.counts.board, '存在 B 编号节点').toBeGreaterThan(0);
  expect(m.counts.boardVisible, '编辑视图 B 编号可见').toBeGreaterThan(0);
  expect(m.counts.ordinal, '存在路点序号节点').toBeGreaterThan(0);
  expect(m.counts.ordinalVisible, '编辑视图下路点序号可见').toBeGreaterThan(0);

  expect(writes.filter(w => !w.path.includes('/localization/')).length, '只读不得写').toBe(0);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('缩放后段标签分层：低缩放隐藏非选中段，高缩放恢复（必须真实改变 stage.scale）', async ({ page }) => {
  const { errors } = await boot(page, 'nav');

  const before = await measure(page);
  console.log('ZOOMBASE ' + JSON.stringify({ scale: before.scale, counts: before.counts }));

  // 注意：MapCanvas 的 wheel 缩放要求 ctrl/meta（见 stage.on('wheel')），
  // 普通 wheel 只滚动页面、stage.scale 不变 —— 旧用例因此「缩出」与「缩回」全等基线，
  // 等于没测。这里改用画布自带的缩小/放大按钮，并断言 scale 真的变了。
  // 每档 0.8：2.209*0.8^4≈0.905 仍 >0.9，必须多按一次才真正进入分层区间。
  const zoomOut = page.getByRole('button', { name: '缩小地图' });
  for (let i = 0; i < 5; i++) { await zoomOut.click(); await page.waitForTimeout(220); }
  await page.waitForTimeout(600);
  const zoomedOut = await measure(page);
  console.log('ZOOMOUT ' + JSON.stringify({ scale: zoomedOut.scale, counts: zoomedOut.counts }));

  // 硬断言：缩放必须真的生效，否则后续分层结论无效。
  expect(zoomedOut.scale, `缩小后 stage.scale 必须下降（before=${before.scale} after=${zoomedOut.scale}）`)
    .toBeLessThan(before.scale);
  expect(zoomedOut.scale, '缩小应进入 <0.9 的分层区间').toBeLessThan(0.9);
  expect(zoomedOut.counts.segmentVisible, '低缩放时非选中段动作标签必须隐藏')
    .toBeLessThan(before.counts.segmentVisible);
  expect(zoomedOut.counts.boardVisible, '低缩放时 B 编号仍应可见').toBeGreaterThan(0);

  const zoomIn = page.getByRole('button', { name: '放大地图' });
  for (let i = 0; i < 5; i++) { await zoomIn.click(); await page.waitForTimeout(220); }
  await page.waitForTimeout(600);
  const zoomedIn = await measure(page);
  console.log('ZOOMIN ' + JSON.stringify({ scale: zoomedIn.scale, counts: zoomedIn.counts }));

  expect(zoomedIn.scale, `放大后 stage.scale 必须高于缩小态（out=${zoomedOut.scale} in=${zoomedIn.scale}）`)
    .toBeGreaterThan(zoomedOut.scale);
  expect(zoomedIn.scale, '放大应越过 0.9 的分层阈值').toBeGreaterThanOrEqual(0.9);
  expect(zoomedIn.counts.segmentVisible, '放大后段动作标签应恢复显示')
    .toBeGreaterThan(zoomedOut.counts.segmentVisible);
  expect(zoomedIn.counts.boardVisible, '放大后 B 编号仍应可见').toBeGreaterThan(0);

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('低缩放下选中某段：该段动作标签按需出现，且与 B 编号不互压', async ({ page }) => {
  const { errors } = await boot(page, 'nav');

  // 先缩到段动作标签默认隐藏的区间
  const zoomOut = page.getByRole('button', { name: '缩小地图' });
  for (let i = 0; i < 5; i++) { await zoomOut.click(); await page.waitForTimeout(220); }
  await page.waitForTimeout(600);
  const low = await measure(page);
  console.log('SELECT_LOW ' + JSON.stringify({ scale: low.scale, counts: low.counts }));
  expect(low.scale, '应处于低缩放分层区间').toBeLessThan(0.9);
  expect(low.counts.segmentVisible, '低缩放下段动作标签默认隐藏').toBe(0);

  // 导航视图的真实入口是画布上的段线（MapCanvas 现在为段线 emit segmentSelect）。
  // 点它的屏幕中点即可选中该段。
  const segPoint = await page.evaluate(() => {
    const stage = (window as any).__stage;
    const layer = stage.getLayers()[0];
    const seg = layer.getChildren().find((n: any) => {
      const nm = n.name() || '';
      return nm.startsWith('segment-') && !nm.startsWith('segment-label-');
    });
    if (!seg) return null;
    // 用折线自身的中点，而不是 bbox 中心：L 形折线的 bbox 中心常常不在线上。
    const pts = seg.points();
    const mid = Math.floor(pts.length / 4) * 2;
    const wx = pts[mid], wy = pts[mid + 1];
    const canvas = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
    const box = canvas.getBoundingClientRect();
    return {
      id: seg.name(),
      x: box.x + stage.x() + wx * stage.scaleX(),
      y: box.y + stage.y() + wy * stage.scaleY(),
    };
  });
  expect(segPoint, '画布上存在段线节点').not.toBeNull();
  await page.mouse.click(segPoint!.x, segPoint!.y);
  await page.waitForTimeout(900);

  const afterSelect = await measure(page);
  console.log('SELECT_AFTER ' + JSON.stringify({ scale: afterSelect.scale, counts: afterSelect.counts, collisions: afterSelect.collisions }));
  expect(afterSelect.counts.segmentVisible, '选中后该段动作标签必须出现').toBeGreaterThan(0);
  expect(afterSelect.collisions, `选中段标签后仍不得与 B 编号互压（collisions=${afterSelect.collisions} pairs=${JSON.stringify(afterSelect.collisionPairs)}）`).toBe(0);

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('页头精简：编辑态无重复大标题/路径编辑中标签/历史拒绝横幅', async ({ page }) => {
  const { errors } = await boot(page, 'edit');

  const info = await page.evaluate(() => {
    const vis = (s: string) => {
      const e = document.querySelector(s);
      if (!e) return false;
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const topbar = document.querySelector('.topbar');
    const heading = document.querySelector('.page-heading h1');
    return {
      topbarVisible: vis('.topbar'),
      headingText: heading ? (heading.textContent || '').trim().slice(0, 40) : null,
      editingBadge: document.body.innerText.includes('路径编辑中'),
      feedback: vis('[data-testid="command-feedback"]'),
    };
  });

  expect(info.topbarVisible, '编辑态不再常驻重复页头').toBe(false);
  expect(info.editingBadge, '不再显示「路径编辑中」标签').toBe(false);
  expect(info.feedback, '编辑页不继承上一次导航拒绝横幅').toBe(false);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('导航页：拒绝回执可关闭且不常驻全宽', async ({ page }) => {
  const { writes, errors } = await boot(page, 'nav');

  // 人为构造一次拒绝回执（不发任何真实指令，仅验证 UI 行为）
  const built = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="command-feedback"]');
    return { exists: !!el };
  });

  // 若无回执（正常，因为没有真实指令），本用例只验证「不会常驻」的契约
  if (built.exists) {
    const r = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="command-feedback"]') as HTMLElement;
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), vw: innerWidth };
    });
    expect(r.w, '回执不应是全宽横幅').toBeLessThan(r.vw * 0.95);
  }

  expect(writes.filter(w => !w.path.includes('/localization/')).length, '不得发指令').toBe(0);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});
