import { test, expect, type Page } from '@playwright/test';

// 定位 scope 契约回归：
// 1) 统一编辑工作区（editingRoute）内选图 → 零 /localization/map 请求
// 2) 普通导航页选图 → 确实请求正式 scope 接口（恢复既有契约，不改后端）

const tags = [
  { id: 0, x: 0, y: 0, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] },
  { id: 1, x: 1, y: 0, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] },
];
const mkMap = (id: string, name: string) => ({
  schemaVersion: 1, id, name, frame: 'map', family: 'tag36h11', source: 'manual',
  coordinateStatus: 'draft', routeMode: 'map-only', rows: [], order: [], tags,
  zone: [{ x: -8, y: -8 }, { x: 9, y: -8 }, { x: 9, y: 9 }, { x: -8, y: 9 }],
  vehicle: { width: 0.4, length: 0.8, margin: 0.05 }, notes: '',
});

const MAPS = [
  { id: 'ui-map-a', name: '地图 A', version: 1 },
  { id: 'ui-map-b', name: '地图 B', version: 1 },
];

async function boot(page: Page) {
  const writes: { method: string; path: string; body: string }[] = [];
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
      writes.push({ method: m, path: p, body: (req.postData() || '').slice(0, 200) });
      if (p === '/api/maps/new') return route.fulfill({ json: { map: mkMap('ui-new', '新建图'), version: 1 } });
      if (p === '/api/localization/map') return route.fulfill({ json: { ok: true, phase: 'switching' } });
      return route.fulfill({ json: { ok: true, mocked: true } });
    }
    if (p === '/api/maps') return route.fulfill({ json: MAPS });
    if (p.startsWith('/api/maps/')) {
      if (p.endsWith('/tag-aliases')) return route.fulfill({ json: { mapId: 'x', mapVersion: 1, aliases: [], disclaimer: 'x' } });
      const id = decodeURIComponent(p.slice('/api/maps/'.length));
      const found = MAPS.find(x => x.id === id);
      return route.fulfill({ json: {
        map: mkMap(id, found?.name ?? id), version: 1,
        acceptance: { kind: 'office_test', accepted: true, digestValid: true } } });
    }
    if (p === '/api/routes') return route.fulfill({ json: [] });
    if (p === '/api/tasks') return route.fulfill({ json: [] });
    if (p === '/api/surveys' || p === '/api/boards') return route.fulfill({ json: [] });
    if (p === '/api/camera/status') return route.fulfill({ json: { running: false, present: false } });
    if (p === '/api/localization/scope') return route.fulfill({ json: { phase: 'anchored' } });
    if (p.startsWith('/api/localization/')) return route.fulfill({ json: { phase: 'anchored' } });
    return route.fulfill({ json: {} });
  });

  await page.goto('/');
  await page.waitForTimeout(900);
  return { writes, errors };
}

const scopeCalls = (w: { path: string }[]) => w.filter(x => x.path === '/api/localization/map');

test('统一编辑工作区内选图 → 零 scope 请求', async ({ page }) => {
  const { writes, errors } = await boot(page);

  // 进入统一工作区
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  const before = scopeCalls(writes).length;

  // 在工作区内切换地图（unified-map-select）
  await page.getByTestId('unified-map-select').selectOption('ui-map-b');
  await page.waitForTimeout(1500);

  expect(scopeCalls(writes).length - before, '编辑工作区内选图不得触发 scope 请求').toBe(0);
  // 工作区仍可用
  await expect(page.getByTestId('route-tools-panel')).toBeVisible();
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('普通导航页选图 → 确实请求正式 scope 接口', async ({ page }) => {
  const { writes, errors } = await boot(page);

  // 进入「开始导航」页（非编辑工作区）
  await page.locator('.sidebar').getByRole('button', { name: '开始导航', exact: true }).click();
  await page.waitForTimeout(1200);

  const before = scopeCalls(writes).length;
  // 导航页选图
  await page.getByTestId('map-select').selectOption('ui-map-b');
  await page.waitForTimeout(1800);

  const after = scopeCalls(writes);
  expect(after.length - before, '导航页选图必须触发 scope 请求').toBeGreaterThan(0);

  // 请求体必须带 mapId/version，且是 POST /localization/map（正式接口）
  const last = after[after.length - 1];
  expect(last.method).toBe('POST');
  expect(last.path).toBe('/api/localization/map');
  expect(last.body).toContain('ui-map-b');

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});
