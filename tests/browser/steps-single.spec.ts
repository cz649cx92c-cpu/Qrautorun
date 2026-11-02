import { test, expect, type Page } from '@playwright/test';

const tags: any[] = [];
for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
  tags.push({ id: r * 4 + c, x: c * 0.3, y: r * 0.3, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] });

const mkMap = () => ({
  schemaVersion: 1, id: 'ui-steps', name: '步骤测试图', frame: 'map', family: 'tag36h11', source: 'manual',
  coordinateStatus: 'draft', routeMode: 'map-only',
  rows: [{ id: 'route', name: 'r', width: .6, exitDistance: .8, start: { x: 0, y: 0 }, points: [{ x: 0.9, y: 0.9 }] }],
  order: ['route'], tags,
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
    if (['POST','PUT','PATCH','DELETE'].includes(m)) { writes.push({ method: m, path: p }); return r.fulfill({ json: { ok: true, mocked: true } }); }
    if (p === '/api/maps') return r.fulfill({ json: [{ id: 'ui-steps', name: '步骤测试图', version: 1 }] });
    if (p.startsWith('/api/maps/')) {
      if (p.endsWith('/tag-aliases')) return r.fulfill({ json: { mapId: 'ui-steps', mapVersion: 1, aliases: [], disclaimer: 'x' } });
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
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2200);
  return { writes, errors };
}

// 统计「路径步骤」主标题在可见区域出现的次数（只数真正可见的）
const countMainTitles = (page: Page) => page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('strong, .route-steps-drag-title')) as HTMLElement[];
  return all.filter(e => {
    const txt = (e.textContent || '').trim();
    if (!/^路径步骤\s*\d+/.test(txt)) return false;
    const b = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    if (b.width <= 0 || b.height <= 0) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    // 祖先也不可见则不算
    let n: HTMLElement | null = e;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      n = n.parentElement;
    }
    return true;
  }).length;
});

test('步骤区：收起只有 1 个主标题；展开后仍只有 1 个且表格可操作', async ({ page }) => {
  const { writes, errors } = await boot(page);

  // ---- 初始：收起 ----
  await expect(page.getByTestId('route-steps-trigger')).toBeVisible();
  expect(await countMainTitles(page), '收起态主标题恰好 1 个').toBe(1);

  // ---- 展开 ----
  await page.getByTestId('route-steps-trigger').click({ timeout: 5000 });
  await page.waitForTimeout(700);

  await expect(page.getByTestId('route-steps-dock')).toBeVisible();
  expect(await countMainTitles(page), '展开态主标题仍恰好 1 个').toBe(1);

  // trigger 在展开时不应再显示（不重复标题）
  const triggerVisible = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="route-steps-trigger"]') as HTMLElement | null;
    if (!e) return false;
    const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  });
  expect(triggerVisible, '展开后标题条不得与面板头同时显示').toBe(false);

  // 表格可操作：上移/下移/删除 按钮存在且可见
  const ops = await page.evaluate(() => {
    const vis = (el: HTMLElement | null) => {
      if (!el) return false;
      const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const btns = Array.from(document.querySelectorAll('.route-commands-ops button')) as HTMLElement[];
    return { count: btns.filter(vis).length, table: vis(document.querySelector('.route-commands-table') as HTMLElement) };
  });
  expect(ops.count, '操作按钮可见').toBeGreaterThanOrEqual(3);
  expect(ops.table, '表格可见').toBe(true);

  // ---- 调高度 ----
  const h1 = await page.evaluate(() => Math.round(document.querySelector('[data-testid="route-steps-popover"]')!.getBoundingClientRect().height));
  await page.getByTestId('route-steps-resize-bar').focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  const h2 = await page.evaluate(() => Math.round(document.querySelector('[data-testid="route-steps-popover"]')!.getBoundingClientRect().height));
  expect(h2, '高度应可调整').not.toBe(h1);

  // ---- 再收起（用标题头开关）----
  await page.getByTestId('route-steps-collapse').click({ timeout: 5000 });
  await page.waitForTimeout(600);
  expect(await countMainTitles(page), '再次收起后主标题恰好 1 个').toBe(1);
  await expect(page.getByTestId('route-steps-trigger')).toBeVisible();

  // ---- 关后画布可点 ----
  const box = await page.getByTestId('map-canvas').boundingBox();
  expect(box).toBeTruthy();
  const before = await page.evaluate(() => document.querySelector('[data-testid="map-canvas"]')!.getAttribute('data-canvas-selected'));
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => document.querySelector('[data-testid="map-canvas"]')!.getAttribute('data-canvas-selected'));
  // 画布可接收点击（选中态可能变也可能不变，但不应被步骤区遮挡）
  const hit = await page.evaluate(([x, y]) => {
    const t = document.elementFromPoint(x, y) as HTMLElement | null;
    return t ? t.closest('[data-testid="map-canvas"]') !== null : false;
  }, [box!.x + box!.width * 0.5, box!.y + box!.height * 0.5]);
  expect(hit, '收起后画布中心可点（不被步骤区遮挡）').toBe(true);

  expect(writes.filter(w => !w.path.includes('/localization/')).length, '步骤操作不得写库').toBe(0);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('步骤区：关闭 × 后画布可点且无重复标题', async ({ page }) => {
  const { errors } = await boot(page);
  await page.getByTestId('route-steps-trigger').click({ timeout: 5000 });
  await page.waitForTimeout(600);
  await expect(page.getByTestId('route-steps-dock')).toBeVisible();

  // 关闭
  await page.locator('[data-testid="route-steps-drag-handle"] button[aria-label="关闭路径步骤"]').click({ timeout: 5000 });
  await page.waitForTimeout(600);

  expect(await countMainTitles(page), '关闭后主标题恰好 1 个').toBe(1);

  const box = await page.getByTestId('map-canvas').boundingBox();
  const hit = await page.evaluate(([x, y]) => {
    const t = document.elementFromPoint(x, y) as HTMLElement | null;
    return t ? t.closest('[data-testid="map-canvas"]') !== null : false;
  }, [box!.x + box!.width * 0.5, box!.y + box!.height * 0.6]);
  expect(hit, '关闭后画布可点').toBe(true);

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});
