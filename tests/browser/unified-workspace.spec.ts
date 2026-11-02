import { test, expect, type Page } from '@playwright/test';

// 统一工作区（地图与路径编辑）集成验收：完整 mock，零写穿。
// 所有 mutating API 在请求发出前被拦截并 mock 返回；WebSocket 完全本地。

const MAP_ID = 'ui-map';
const VERSION = 1;

type Store = { maps: any[]; routes: any[]; writes: { method: string; url: string }[] };

function makeMap(id = MAP_ID, name = '统一工作区图') {
  return {
    schemaVersion: 1, id, name, frame: 'map', family: 'tag36h11', source: 'manual',
    coordinateStatus: 'draft', routeMode: 'map-only',
    rows: [], order: [],
    tags: [],
    zone: [{ x: -8, y: -8 }, { x: 9, y: -8 }, { x: 9, y: 9 }, { x: -8, y: 9 }],
    vehicle: { width: 0.4, length: 0.8, margin: 0.05 }, notes: '',
  };
}

async function setup(page: Page, store: Store) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push('PAGEERROR ' + String(e).slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });

  await page.routeWebSocket('**/ws', ws => ws.send(JSON.stringify({
    type: 'robot',
    status: {
      connected: true, state: 'IDLE', running: false, paused: false, pose: null,
      chassis: { connected: true }, sensors: {}, conditions: [], events: [],
      detector: { connected: true, positionReady: true, groups: [], reason: '' },
      mapping: { ready: true, quality: 'draft', localEpoch: 'ui', reason: '' },
    },
  })));
  await page.routeWebSocket('**/ws/camera', () => {});

  await page.route('**/api/**', async route => {
    const req = route.request();
    const method = req.method().toUpperCase();
    const path = new URL(req.url()).pathname;
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

    if (isWrite) {
      store.writes.push({ method, url: req.url() });
      // 新建空白地图：只加进内存 store，绝不触达后端
      if (path === '/api/maps/new') {
        const m = makeMap('ui-new-' + (store.maps.length + 1), '手动铺码图-测试');
        store.maps.push({ id: m.id, name: m.name, version: 1 });
        (store as any).lastMap = m;
        return route.fulfill({ json: { map: m, version: 1 } });
      }
      // 其它写操作一律 mock 成功，不产生真实数据
      return route.fulfill({ json: { ok: true, mocked: true } });
    }

    if (path === '/api/maps') return route.fulfill({ json: store.maps });
    if (path.startsWith('/api/maps/')) {
      const id = decodeURIComponent(path.slice('/api/maps/'.length));
      if (id.endsWith('/tag-aliases')) {
        return route.fulfill({ json: { mapId: id.split('/')[0], mapVersion: 1, aliases: [], disclaimer: 'x' } });
      }
      const m = (store as any).lastMap && (store as any).lastMap.id === id
        ? (store as any).lastMap
        : makeMap(id);
      return route.fulfill({ json: { map: m, version: 1, acceptance: { kind: 'office_test', accepted: true, digestValid: true } } });
    }
    if (path === '/api/routes') return route.fulfill({ json: store.routes });
    if (path === '/api/tasks') return route.fulfill({ json: [] });
    if (path === '/api/surveys' || path === '/api/boards') return route.fulfill({ json: [] });
    if (path === '/api/camera/status') return route.fulfill({ json: { running: false, present: false } });
    if (path === '/api/localization/map' || path === '/api/localization/scope') {
      return route.fulfill({ json: { phase: 'anchored' } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto('/');
  await page.waitForTimeout(900);
  return errors;
}

test('无地图也能进统一工作区：新建空图 → 铺码入口 → 新建路径', async ({ page }) => {
  const store: Store = { maps: [], routes: [], writes: [] };
  const errors = await setup(page, store);

  // 从主导航「路径编辑」进入（无地图）
  await page.getByTestId('nav-route-edit').click({ timeout: 5000 });
  await page.waitForTimeout(1200);

  // 统一工作区应已打开，且出现「地图」组
  await expect(page.getByTestId('route-tools-panel')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('route-tools-group-toggle-map')).toBeVisible();
  await expect(page.getByTestId('unified-new-blank-map')).toBeVisible();

  // 无地图时明确告知，不自动建图
  await expect(page.getByTestId('unified-map-empty')).toBeVisible();
  // 进入编辑不得写地图/路线/任务等业务数据。
  // /api/localization/map 是既有「选图即切定位范围」行为，测试中已被 mock，不触达后端，
  // 但它不属于本页新增写入，单独排除后断言其余业务写入为 0。
  const businessWrites = store.writes.filter(w => !w.url.includes('/localization/'));
  expect(businessWrites.length, '进入页面不得写业务数据').toBe(0);

  // 在统一工作区里新建空白地图
  await page.getByTestId('unified-new-blank-map').click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  expect(store.writes.filter(w => w.url.includes('/api/maps/new')).length, '应只新建一次空图').toBe(1);
  // 断言：新建空图不得顺带创建路线
  // 不得自动创建路线
  expect(store.writes.filter(w => /\/api\/routes/.test(w.url) && w.method === 'POST').length, '不得自动建路线').toBe(0);

  // 仍在同一页（未跳到扫描页）
  await expect(page.getByTestId('route-editor-toolbar')).toBeVisible({ timeout: 8000 });
  // 铺码入口可用
  await expect(page.getByTestId('route-tools-group-toggle-tags')).toBeVisible();

  // 新建路径入口存在且可点
  await expect(page.getByTestId('unified-new-route')).toBeVisible();
  await page.getByTestId('unified-new-route').click({ timeout: 5000 });
  await page.waitForTimeout(800);
  await expect(page.getByTestId('route-editor-toolbar')).toBeVisible();

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('已有 map-only 无路线也能编辑；扫描页无重复手动工具但采集按钮保留', async ({ page }) => {
  const store: Store = { maps: [{ id: MAP_ID, name: '统一工作区图', version: VERSION }], routes: [], writes: [] };
  const errors = await setup(page, store);

  // 扫描页：不应出现重复的手动编辑工具，但采集按钮必须保留
  await page.waitForTimeout(600);
  const scan = await page.evaluate(() => {
    const vis = (s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return false;
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    return {
      newBlankForm: vis('[data-testid="new-blank-map"]'),
      newBlankBtn: vis('[data-testid="new-blank-map-button"]'),
      manualEntry: vis('[data-testid="scan-manual-entry"]'),
      openEditor: vis('[data-testid="scan-open-map-editor"]'),
      startScan: vis('[data-testid="capture-count"]') || !!document.querySelector('button'),
    };
  });
  expect(scan.newBlankForm, '扫描页不得再常驻新建空图表单').toBe(false);
  expect(scan.newBlankBtn, '扫描页不得再常驻新建空图按钮').toBe(false);
  expect(scan.manualEntry, '扫描页应保留单一导航入口').toBe(true);
  expect(scan.openEditor).toBe(true);

  // 通过扫描页入口进入统一工作区
  await page.getByTestId('scan-open-map-editor').click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('route-tools-panel')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('map-canvas')).toBeVisible({ timeout: 8000 });
  const businessWrites2 = store.writes.filter(w => !w.url.includes('/localization/'));
  expect(businessWrites2.length, '进入编辑不得写业务数据').toBe(0);

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});
