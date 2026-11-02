import { test, expect, type Page } from '@playwright/test';

// 密集 industrial 多码 fixture：6×5=30 码，间距 0.18m
const tags: any[] = [];
for (let r = 0; r < 6; r++) {
  for (let c = 0; c < 5; c++) {
    tags.push({ id: r * 5 + c, x: c * 0.18, y: r * 0.18, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] });
  }
}
const mkMap = (id = 'ui-dense', name = '密集多码图') => ({
  schemaVersion: 1, id, name, frame: 'map', family: 'tag36h11', source: 'manual',
  coordinateStatus: 'draft', routeMode: 'map-only', rows: [], order: [], tags,
  zone: [{ x: -1, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 2 }, { x: -1, y: 2 }],
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
    if (['POST','PUT','PATCH','DELETE'].includes(m)) {
      writes.push({ method: m, path: p });
      return r.fulfill({ json: { ok: true, mocked: true } });
    }
    if (p === '/api/maps') return r.fulfill({ json: [{ id: 'ui-dense', name: '密集多码图', version: 1 }] });
    if (p.startsWith('/api/maps/')) {
      if (p.endsWith('/tag-aliases')) return r.fulfill({ json: { mapId: 'ui-dense', mapVersion: 1, aliases: [], disclaimer: 'x' } });
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

const vis = (page: Page, sel: string) => page.evaluate(s => {
  const e = document.querySelector(s) as HTMLElement | null;
  if (!e) return false;
  const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
}, sel);

test('扫描页：无编辑器外壳/菜单/palette/布局控件，业务按钮保留', async ({ page }) => {
  const { writes, errors } = await boot(page);
  await page.waitForTimeout(700);

  expect(await vis(page, '[data-testid="editor-menubar"]'), '扫描页不得有编辑器菜单').toBe(false);
  expect(await vis(page, '[data-testid="editor-tool-palette"]'), '扫描页不得有 palette').toBe(false);
  expect(await vis(page, '[data-testid="editor-layout-tools"]'), '扫描页不得有布局控件').toBe(false);
  expect(await vis(page, '[data-testid="route-inspector"]'), '扫描页不得有编辑属性栏').toBe(false);

  // 真实扫描业务必须保留
  expect(await vis(page, '[data-testid="capture-count"]'), '扫描页必须保留采集状态').toBe(true);
  expect(await page.locator('button', { hasText: '开始扫描' }).count(), '必须保留开始扫描').toBeGreaterThan(0);
  expect(await vis(page, '[data-testid="scan-manual-entry"]'), '扫描页保留单一去编辑入口').toBe(true);

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('导航页：无编辑器外壳/菜单/palette/布局控件，业务控件保留', async ({ page }) => {
  const { errors } = await boot(page);
  await page.locator('.sidebar').getByRole('button', { name: '开始导航', exact: true }).click();
  await page.waitForTimeout(1200);

  expect(await vis(page, '[data-testid="editor-menubar"]'), '导航页不得有编辑器菜单').toBe(false);
  expect(await vis(page, '[data-testid="editor-tool-palette"]'), '导航页不得有 palette').toBe(false);
  expect(await vis(page, '[data-testid="editor-layout-tools"]'), '导航页不得有布局控件').toBe(false);

  // 导航业务保留
  expect(await vis(page, '[data-testid="map-select"]'), '保留地图选择').toBe(true);
  expect(await vis(page, '[data-testid="route-select"]'), '保留路径选择').toBe(true);
  expect(await vis(page, '[data-testid="nav-open-map-editor"]'), '保留单一去编辑入口').toBe(true);
  // 不再提供编辑器式的空白建图
  expect(await page.locator('[data-testid="new-blank-map-button-nav"]').count(), '导航页不得再有新建空图').toBe(0);

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('路径编辑：菜单叠层在上、选项可点、Esc 收起', async ({ page }) => {
  const { writes, errors } = await boot(page);
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2200);

  // 编辑器能力完整
  expect(await vis(page, '[data-testid="editor-menubar"]')).toBe(true);
  expect(await vis(page, '[data-testid="route-editor-toolbar"]')).toBe(true);
  expect(await vis(page, '[data-testid="route-tools-panel"]')).toBe(true);
  expect(await vis(page, '[data-testid="editor-layout-tools"]')).toBe(true);

  await page.getByTestId('editor-menu-edit').click({ timeout: 5000 });
  await page.waitForTimeout(400);

  const panel = page.getByTestId('editor-menu-panel-edit');
  await expect(panel).toBeVisible();

  // 每个可见选项中心必须命中自身（不被工具条透出/遮挡）
  const hits = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="editor-menu-panel-edit"]');
    if (!p) return [];
    const items = Array.from(p.querySelectorAll('button'));
    return items.map(it => {
      const b = it.getBoundingClientRect();
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      const top = document.elementFromPoint(cx, cy);
      return {
        label: (it.textContent || '').trim().slice(0, 12),
        self: top === it || it.contains(top),
        topTag: top ? top.tagName + (top.getAttribute('data-testid') ? '[' + top.getAttribute('data-testid') + ']' : '') : 'none',
      };
    });
  });
  expect(hits.length).toBeGreaterThan(0);
  for (const h of hits) {
    expect(h.self, `菜单项「${h.label}」被 ${h.topTag} 遮挡`).toBe(true);
  }

  // Esc 收起
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await expect(panel).toHaveCount(0);

  // 外部点击收起
  await page.getByTestId('editor-menu-edit').click({ timeout: 5000 });
  await page.waitForTimeout(300);
  await expect(panel).toBeVisible();
  await page.mouse.click(900, 700);
  await page.waitForTimeout(400);
  await expect(panel).toHaveCount(0);

  expect(writes.filter(w => !w.path.includes('/localization/')).length, '菜单操作不得写').toBe(0);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('提示不互压：状态条与错误区互不覆盖画布点位', async ({ page }) => {
  const { errors } = await boot(page);
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2200);

  // 触发「新建路径」提示
  await page.getByTestId('unified-new-route').click({ timeout: 5000 });
  await page.waitForTimeout(800);

  const geo = await page.evaluate(() => {
    const r = (s: string) => {
      const e = document.querySelector(s) as HTMLElement | null;
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
               bottom: Math.round(b.bottom), right: Math.round(b.right) };
    };
    // 相邻（边贴边）不算覆盖；必须有真实交集面积才算。
    const overlaps = (a: any, b: any) => {
      if (!a || !b) return false;
      const ix = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      return ix > 1 && iy > 1;
    };
    const toast = r('[data-testid="route-toast"]');
    const hint = r('[data-testid="route-tool-hint"]');
    const canvas = r('[data-testid="map-canvas"]');
    return { toast, hint, canvas, toastHintOverlap: overlaps(toast, hint),
             toastCanvasOverlap: overlaps(toast, canvas) };
  });

  // 提示与工具意图条不得互压
  expect(geo.toastHintOverlap, '状态提示与工具意图条不得重叠').toBe(false);
  // 提示不得覆盖画布（原为 absolute 浮层）
  expect(geo.toastCanvasOverlap, '状态提示不得覆盖画布').toBe(false);
  if (geo.toast && geo.canvas) {
    expect(geo.toast.bottom, '状态提示底边不得进入画布区域').toBeLessThanOrEqual(geo.canvas.y + 1);
  }

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('密集多码：标签不叠字，选中仍可辨', async ({ page }) => {
  const { errors } = await boot(page);
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2200);

  const info = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
    return { visible: Number(c.dataset.canvasVisibleLabels), hidden: Number(c.dataset.canvasHiddenLabels),
             scale: c.dataset.canvasFitScale };
  });
  console.log('LABELS ' + JSON.stringify(info));

  // 所有码实体保留（30 个），标签按密度避让
  expect(info.visible + info.hidden, '所有码都应有标签决策记录').toBe(30);
  expect(info.visible, '密集时应保留可见标签').toBeGreaterThan(0);

  // 选中一个码后，其编号必须可辨
  await page.getByTestId('route-select-tool').click({ timeout: 5000 });
  await page.waitForTimeout(300);
  const box = await page.getByTestId('map-canvas').boundingBox();
  let picked = false;
  for (let gy = 0.2; gy <= 0.8 && !picked; gy += 0.1) {
    for (let gx = 0.2; gx <= 0.8 && !picked; gx += 0.1) {
      await page.mouse.click(box!.x + box!.width * gx, box!.y + box!.height * gy);
      await page.waitForTimeout(150);
      const sel = await page.evaluate(() => document.querySelector('[data-testid="map-canvas"]')?.getAttribute('data-canvas-selected'));
      if (sel && sel !== '') picked = true;
    }
  }
  expect(picked, '密集图也应能选中码').toBe(true);

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

for (const [w, h] of [[1910, 925], [1440, 900], [375, 812]] as const) {
  test(`布局 ${w}x${h}：无横向溢出，菜单与工具条不交错遮挡`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    const { errors } = await boot(page);
    await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
    await page.waitForTimeout(2200);

    const m = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      viewport: { width: innerWidth, height: innerHeight },
    }));
    expect(m.overflowX, `${w}x${h} 不得横向溢出`).toBeLessThanOrEqual(1);

    // 窄屏（<=760）按既有设计隐藏菜单条：这不是回归，跳过菜单断言。
    // 宽屏必须能打开菜单且选项可点。
    const menubarVisible = await page.evaluate(() => {
      const e = document.querySelector('[data-testid="editor-menubar"]') as HTMLElement | null;
      if (!e) return false;
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    });

    if (!menubarVisible) {
      expect(w, `${w}x${h} 窄屏隐藏菜单条是既有设计`).toBeLessThanOrEqual(760);
      expect(errors.filter(e => !/404/.test(e))).toEqual([]);
      return;
    }

    await page.getByTestId('editor-menu-edit').click({ timeout: 5000 });
    await page.waitForTimeout(400);

    const ok = await page.evaluate(() => {
      const p = document.querySelector('[data-testid="editor-menu-panel-edit"]');
      if (!p) return { visible: false, allSelf: false };
      const b = p.getBoundingClientRect();
      const items = Array.from(p.querySelectorAll('button'));
      const allSelf = items.every(it => {
        const r = it.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return top === it || it.contains(top);
      });
      return { visible: b.width > 0 && b.height > 0, allSelf };
    });
    expect(ok.visible, `${w}x${h} 菜单应可见`).toBe(true);
    expect(ok.allSelf, `${w}x${h} 菜单项不得被遮挡`).toBe(true);

    expect(errors.filter(e => !/404/.test(e))).toEqual([]);
  });
}
