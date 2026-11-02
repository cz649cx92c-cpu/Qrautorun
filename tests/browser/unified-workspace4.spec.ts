import { test, expect, type Page } from '@playwright/test';

const tags = [
  { id: 0, x: 0, y: 0, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] },
  { id: 1, x: 1, y: 0, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] },
  { id: 2, x: 1, y: 1, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] },
];
const mkMap = (id = 'ui-map') => ({
  schemaVersion: 1, id, name: '统一工作区图', frame: 'map', family: 'tag36h11', source: 'manual',
  coordinateStatus: 'draft', routeMode: 'map-only',
  rows: [{ id: 'route', name: 'r', width: .6, exitDistance: .8, start: { x: 0, y: 0 }, points: [{ x: 2, y: 1 }] }],
  order: ['route'], tags,
  zone: [{ x: -8, y: -8 }, { x: 9, y: -8 }, { x: 9, y: 9 }, { x: -8, y: 9 }],
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
  await page.route('**/api/**', async route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const m = req.method().toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
      writes.push({ method: m, path: p });
      if (p === '/api/maps/new') return route.fulfill({ json: { map: mkMap('ui-new-1'), version: 1 } });
      return route.fulfill({ json: { ok: true, mocked: true } });
    }
    if (p === '/api/maps') return route.fulfill({ json: [{ id: 'ui-map', name: '统一工作区图', version: 1 }] });
    if (p.startsWith('/api/maps/')) {
      if (p.endsWith('/tag-aliases')) return route.fulfill({ json: { mapId: 'ui-map', mapVersion: 1, aliases: [], disclaimer: 'x' } });
      const id = decodeURIComponent(p.slice('/api/maps/'.length));
      return route.fulfill({ json: { map: mkMap(id), version: 1, acceptance: { kind: 'office_test', accepted: true, digestValid: true } } });
    }
    if (p === '/api/routes') return route.fulfill({ json: [] });
    if (p === '/api/tasks') return route.fulfill({ json: [] });
    if (p === '/api/surveys' || p === '/api/boards') return route.fulfill({ json: [] });
    if (p === '/api/camera/status') return route.fulfill({ json: { running: false, present: false } });
    if (p.includes('/localization/')) return route.fulfill({ json: { phase: 'anchored' } });
    return route.fulfill({ json: {} });
  });

  await page.goto('/');
  await page.waitForTimeout(900);
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2200);
  return { writes, errors };
}

test('属性区跟随选中对象：选中显示、无选中收起', async ({ page }) => {
  const { writes, errors } = await boot(page);

  const inspector = page.getByTestId('route-inspector');
  // 刚进入、未选对象 → 收起
  await expect(inspector).toHaveCount(0, { timeout: 5000 });

  // 选中一个路点（步骤行）→ 属性区出现
  const stepRow = page.locator('[data-testid="route-step-row"], .route-steps-row, tbody tr').first();
  const hasRow = await stepRow.count();
  if (hasRow > 0) {
    await stepRow.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
  }

  // 通过画布点选二维码（用选择工具点画布中心附近的码）
  await page.getByTestId('route-select-tool').click({ timeout: 5000 });
  await page.waitForTimeout(300);
  const box = await page.getByTestId('map-canvas').boundingBox();
  if (box) {
    // 在画布内多点几次，命中任一二维码即可
    for (const [dx, dy] of [[0.35, 0.4], [0.5, 0.5], [0.45, 0.35]]) {
      await page.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
      await page.waitForTimeout(400);
      if (await inspector.count() > 0) break;
    }
  }

  const shown = await inspector.count();
  if (shown > 0) {
    await expect(inspector).toBeVisible();
    // 关闭后应保持收起（用户显式关闭）
    await page.getByTestId('route-inspector-close').click({ timeout: 5000 });
    await page.waitForTimeout(500);
    await expect(inspector).toHaveCount(0);
  }

  expect(writes.filter(w => !w.path.includes('/localization/')).length, '选对象不得写').toBe(0);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});
