import { test, expect, type Page } from '@playwright/test';

const tags = [
  { id: 0, x: 0, y: 0, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] },
  { id: 1, x: 1, y: 0, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] },
  { id: 2, x: 1, y: 1, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] },
];
const mkMap = (id = 'ui-map') => ({
  schemaVersion: 1, id, name: '统一工作区图', frame: 'map', family: 'tag36h11', source: 'manual',
  coordinateStatus: 'draft', routeMode: 'map-only', rows: [], order: [], tags,
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
  return { writes, errors };
}

test('零写入：进入/浏览/选图/新建空图 全程不写后端', async ({ page }) => {
  const { writes, errors } = await boot(page);

  // 进入统一工作区（已有地图）
  // 基线：页面启动时自动选图会按既有导航契约同步一次 scope，这是原行为，不计入编辑态。
  const scopeBefore = writes.filter(w => w.path === '/api/localization/map').length;

  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  expect(writes.filter(w => !w.path.includes('/localization/')).length, '进入不得写业务数据').toBe(0);
  expect(
    writes.filter(w => w.path === '/api/localization/map').length - scopeBefore,
    '进入编辑工作区不得新增 scope 请求',
  ).toBe(0);

  // 新建空白地图：只允许 /maps/new 一次
  await page.getByTestId('unified-new-blank-map').click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  const newMapCalls = writes.filter(w => w.path === '/api/maps/new');
  expect(newMapCalls.length, '只新建一次空图').toBe(1);
  expect(
    writes.filter(w => w.path === '/api/localization/map').length - scopeBefore,
    '新建空图不得自动切定位',
  ).toBe(0);
  expect(writes.filter(w => /\/api\/routes/.test(w.path)).length, '不得自动建路线').toBe(0);

  // 新建后仍留在工作区：工具条/面板/画布都在
  await expect(page.getByTestId('route-editor-toolbar')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('route-tools-panel')).toBeVisible();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await expect(page.getByTestId('route-save')).toBeVisible();
  await expect(page.getByTestId('route-exit')).toBeVisible();

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('无 route 的地图模式可用；开始画路径是显式动作', async ({ page }) => {
  const { writes, errors } = await boot(page);
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2000);

  // 没有路线时：地图可操作（点位/铺码/测距入口可见）
  await expect(page.getByTestId('route-tools-group-toggle-tags')).toBeVisible();
  // 画布可交互
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  // 未点「新建路径」前，不应存在路线编辑态写入
  expect(writes.filter(w => /\/api\/routes/.test(w.path)).length).toBe(0);

  // 显式开始画路径
  await page.getByTestId('unified-new-route').click({ timeout: 8000 });
  await page.waitForTimeout(1000);
  // 点「新建路径」只是进入绘制态，不应立刻写库（保存才是持久化）
  expect(writes.filter(w => /\/api\/routes/.test(w.path) && w.method === 'POST').length,
    '开始画路径不得立刻持久化').toBe(0);

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('单一主入口：相同工具不重复出现', async ({ page }) => {
  const { errors } = await boot(page);
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2000);

  const dup = await page.evaluate(() => {
    const count = (sel: string) => {
      const all = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
      return all.filter(e => {
        const b = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      }).length;
    };
    return {
      // 编辑态左栏 palette 不应出现（与顶部工具条重复）
      palette: count('[data-testid="editor-tool-palette"]'),
      toolbar: count('[data-testid="route-editor-toolbar"]'),
      // 同一画布
      canvas: count('[data-testid="map-canvas"]'),
      // 地图选择只应有一个可见入口
      mapSelect: count('[data-testid="unified-map-select"]') + count('[data-testid="map-select"]'),
    };
  });

  expect(dup.palette, '编辑态不应保留重复的 palette 工具条').toBe(0);
  expect(dup.toolbar, '只应有一个顶部工具条').toBe(1);
  expect(dup.canvas, '只应有一个画布').toBe(1);
  expect(dup.mapSelect, '地图选择只应有一个可见入口').toBe(1);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});
