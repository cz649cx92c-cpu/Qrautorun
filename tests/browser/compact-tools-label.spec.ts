// 说明：标签/板组对齐的断言已移到 board-label.spec.ts，
// 使用真实「17 个定位板 × 4x4 成员 + 独立码」fixture，
// 避免把板内成员间距误当成板组间距。本文件只覆盖六按钮功能与布局。
import { test, expect, type Page } from '@playwright/test';

// 17 个定位组，每组 4x4=16 个成员（工业密集铺码），外加独立组。
const tags: any[] = [];
let id = 0;
const groups: string[] = [];
for (let g = 0; g < 17; g++) {
  const gx = (g % 5) * 1.6;
  const gy = Math.floor(g / 5) * 1.6;
  const gid = 'G' + String(g).padStart(3, '0');
  groups.push(gid);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      tags.push({
        id: id++,
        x: gx + c * 0.18,
        y: gy + r * 0.18,
        angle: 0, size: .08,
        rowId: 'route', kind: 'waypoint', groupId: gid, rules: [],
      });
    }
  }
}

const mkMap = () => ({
  schemaVersion: 1, id: 'ui-17g', name: '17组密集图', frame: 'map', family: 'tag36h11', source: 'manual',
  coordinateStatus: 'draft', routeMode: 'map-only', rows: [], order: [], tags,
  zone: [{ x: -2, y: -2 }, { x: 9, y: -2 }, { x: 9, y: 9 }, { x: -2, y: 9 }],
  vehicle: { width: 0.4, length: 0.8, margin: 0.05 }, notes: '',
});

async function boot(page: Page) {
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
    const req = r.request(); const p = new URL(req.url()).pathname; const m = req.method().toUpperCase();
    if (['POST','PUT','PATCH','DELETE'].includes(m)) { writes.push({ method: m, path: p }); return r.fulfill({ json: { ok: true, mocked: true } }); }
    if (p === '/api/maps') return r.fulfill({ json: [{ id: 'ui-17g', name: '17组密集图', version: 1 }] });
    if (p.startsWith('/api/maps/')) {
      if (p.endsWith('/tag-aliases')) return r.fulfill({ json: { mapId: 'ui-17g', mapVersion: 1, aliases: [], disclaimer: 'x' } });
      return r.fulfill({ json: { map: mkMap(), version: 1, acceptance: { kind: 'office_test', accepted: true, digestValid: true } } });
    }
    if (p === '/api/routes') return r.fulfill({ json: [] });
    if (p === '/api/tasks') return r.fulfill({ json: [] });
    if (p === '/api/surveys' || p === '/api/boards') return r.fulfill({ json: [] });
    if (p === '/api/camera/status') return r.fulfill({ json: { running: false, present: false } });
    if (p.includes('/localization/')) return r.fulfill({ json: { phase: 'anchored' } });
    return r.fulfill({ json: {} });
  });

  await page.goto('/');
  await page.waitForTimeout(900);
  return { writes, errors };
}

// 读取每个 tag 的实体屏幕中心与其标签 bbox，按真实 stage transform 对照
const measure = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
  const scale = Number(c.dataset.konvaScale);
  const sx = Number(c.dataset.konvaX);
  const sy = Number(c.dataset.konvaY);
  const box = c.getBoundingClientRect();
  const stage = (window as any).__stage;
  const out: any[] = [];
  if (!stage) return { error: 'no stage', scale, sx, sy };
  const layer = stage.getLayers()[0];
  layer.getChildren().forEach((node: any) => {
    const name: string = node.name() || '';
    if (!name.startsWith('tag-')) return;
    const tagId = Number(name.slice(4));
    if (!Number.isFinite(tagId)) return;
    // 实体中心：group 的世界坐标经 stage 变换到屏幕
    const gx = node.x(), gy = node.y();
    const entScreenX = box.x + sx + gx * scale;
    const entScreenY = box.y + sy + gy * scale;
    // 标签节点
    const lbl = node.findOne('.tag-label-' + tagId);
    if (!lbl) return;
    const lb = lbl.getClientRect({ relativeTo: stage });
    out.push({
      tagId,
      entityScreen: { x: Math.round(entScreenX), y: Math.round(entScreenY) },
      labelScreen: { x: Math.round(box.x + lb.x), y: Math.round(box.y + lb.y),
                     w: Math.round(lb.width), h: Math.round(lb.height) },
      labelVisible: lbl.visible(),
      offsetY: Math.round(lbl.y()),
    });
  });
  return { scale, sx, sy, count: out.length, items: out };
});

test('六按钮：不点不渲染长说明；点击直接进入对应功能', async ({ page }) => {
  const { writes, errors } = await boot(page);
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2200);

  // 六个按键都在
  for (const t of ['position', 'single', 'grid', 'line', 'table', 'spacing']) {
    const loc = page.getByTestId('map-tool-' + t);
    await loc.scrollIntoViewIfNeeded();
    await expect(loc).toBeVisible();
  }

  // 未点击时：不得渲染任何面板与长说明
  const before = await page.evaluate(() => {
    const vis = s => {
      const e = document.querySelector(s);
      if (!e) return false;
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    return {
      create: vis('[data-testid="map-tag-create"]'),
      table: vis('[data-testid="map-tag-table"]'),
      position: vis('[data-testid="tag-position-toggle"]'),
      spacing: vis('[data-testid="map-spacing-start"]'),
      hintCreate: vis('.tag-create-hint'),
      hintTable: vis('.tag-table-hint'),
    };
  });
  expect(before.create, '未点击不得渲染铺码面板').toBe(false);
  expect(before.table, '未点击不得渲染点位表').toBe(false);
  expect(before.hintCreate, '未点击不得渲染长说明').toBe(false);
  expect(before.hintTable, '未点击不得渲染长说明').toBe(false);

  // 点击「阵列铺码」→ 直接进入 grid 模式（不需要再点开始）
  await page.getByTestId('map-tool-grid').scrollIntoViewIfNeeded();
  await page.getByTestId('map-tool-grid').click({ timeout: 5000 });
  await page.waitForTimeout(900);
  const grid = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="map-tag-create"]') as HTMLElement | null;
    return e ? { active: e.dataset.active, mode: e.dataset.mode } : null;
  });
  expect(grid, '阵列铺码应直接打开铺码面板').not.toBeNull();
  expect(grid!.active, '应已激活（不需要二次点开始）').toBe('1');
  expect(grid!.mode, '应预选 grid 模式').toBe('grid');

  // 点击「单个加码」→ single 模式
  await page.getByTestId('map-tool-single').scrollIntoViewIfNeeded();
  await page.getByTestId('map-tool-single').click({ timeout: 5000 });
  await page.waitForTimeout(900);
  const single = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="map-tag-create"]') as HTMLElement | null;
    return e ? { active: e.dataset.active, mode: e.dataset.mode } : null;
  });
  expect(single!.active).toBe('1');
  expect(single!.mode).toBe('single');

  // 点击「点位表」→ 表格打开
  await page.getByTestId('map-tool-table').scrollIntoViewIfNeeded();
  await page.getByTestId('map-tool-table').click({ timeout: 5000 });
  await page.waitForTimeout(900);
  const table = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="map-tag-table"]') as HTMLElement | null;
    return e ? e.dataset.active : null;
  });
  expect(table, '点位表应直接打开').toBe('1');

  // 再次点击同一按钮 → 收起回紧凑组
  await page.getByTestId('map-tool-table').scrollIntoViewIfNeeded();
  await page.getByTestId('map-tool-table').click({ timeout: 5000 });
  await page.waitForTimeout(700);
  const closed = await page.evaluate(() => !!document.querySelector('[data-testid="map-tag-table"]'));
  expect(closed, '再次点击应收起').toBe(false);
  await expect(page.getByTestId('map-tool-compact')).toBeVisible();

  expect(writes.filter(w => !w.path.includes('/localization/')).length, '六按钮操作不得写库').toBe(0);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

for (const [w, h] of [[1440, 900], [375, 812]] as const) {
  test(`六按钮布局 ${w}x${h}：中心命中、无溢出、退出恢复`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    const { errors } = await boot(page);
    await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
    await page.waitForTimeout(2200);

    const ids = ['position', 'single', 'grid', 'line', 'table', 'spacing'];
    // 逐个滚入视口后再判断中心命中（左栏内部可滚动，视口外 elementFromPoint 返回 null）。
    const res: any[] = [];
    for (const id of ids) {
      const loc = page.getByTestId('map-tool-' + id);
      await loc.scrollIntoViewIfNeeded();
      await page.waitForTimeout(120);
      const one = await page.evaluate((tid) => {
        const e = document.querySelector(`[data-testid="map-tool-${tid}"]`) as HTMLElement | null;
        if (!e) return { id: tid, visible: false };
        const b = e.getBoundingClientRect();
        const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return {
          id: tid,
          visible: b.width > 0 && b.height > 0,
          self: top === e || e.contains(top),
          w: Math.round(b.width),
          right: Math.round(b.right),
          inViewport: b.top >= 0 && b.bottom <= window.innerHeight,
        };
      }, id);
      res.push(one);
    }
    const m = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      vw: window.innerWidth,
    }));

    expect(m.overflowX, `${w}x${h} 不得横向溢出`).toBeLessThanOrEqual(1);
    for (const r of res) {
      expect(r.visible, `${r.id} 应可见`).toBe(true);
      expect(r.inViewport, `${r.id} 应能滚入视口`).toBe(true);
      expect(r.self, `${r.id} 中心应命中自身`).toBe(true);
      expect(r.right, `${r.id} 不得超出视口`).toBeLessThanOrEqual(m.vw);
    }

    // 打开再退出 → 回到紧凑组
    await page.getByTestId('map-tool-grid').scrollIntoViewIfNeeded();
  await page.getByTestId('map-tool-grid').click({ timeout: 5000 });
    await page.waitForTimeout(700);
    await expect(page.getByTestId('map-tag-create')).toBeVisible();
    await page.getByTestId('map-tag-create-exit').click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(700);
    await expect(page.getByTestId('map-tool-compact')).toBeVisible();

    expect(errors.filter(e => !/404/.test(e))).toEqual([]);
  });
}
