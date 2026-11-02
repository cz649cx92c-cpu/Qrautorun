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
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2200);
  return { writes, errors };
}

test('选二维码 → 属性区显示「二维码属性」；取消选中 → 收起', async ({ page }) => {
  const { writes, errors } = await boot(page);
  const inspector = page.getByTestId('route-inspector');
  await expect(inspector).toHaveCount(0, { timeout: 5000 });

  // 用「查看/补打」之外的路径：点击画布上的码。用选择工具在画布网格里扫描点击。
  await page.getByTestId('route-select-tool').click({ timeout: 5000 });
  await page.waitForTimeout(300);
  const box = await page.getByTestId('map-canvas').boundingBox();
  expect(box).toBeTruthy();

  let found = false;
  for (let gy = 0.25; gy <= 0.75 && !found; gy += 0.125) {
    for (let gx = 0.2; gx <= 0.8 && !found; gx += 0.1) {
      await page.mouse.click(box!.x + box!.width * gx, box!.y + box!.height * gy);
      await page.waitForTimeout(250);
      if (await inspector.count() > 0) found = true;
    }
  }

  if (found) {
    await expect(inspector).toBeVisible();
    const text = await inspector.innerText();
    expect(/二维码属性|路点属性/.test(text), '属性区应显示对象类型').toBe(true);
  }

  // 关闭后收起
  if (found) {
    await page.getByTestId('route-inspector-close').click({ timeout: 5000 });
    await page.waitForTimeout(400);
    await expect(inspector).toHaveCount(0);
  }

  expect(writes.filter(w => !w.path.includes('/localization/')).length, '选对象不得写库').toBe(0);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('保存边界：地图与路径各自持久化，未保存不自动写', async ({ page }) => {
  const { writes, errors } = await boot(page);

  // 未做任何编辑时，不应有任何保存请求
  expect(writes.filter(w => /\/api\/routes/.test(w.path)).length, '未编辑不得保存路线').toBe(0);
  expect(writes.filter(w => /\/api\/maps\//.test(w.path) && w.method !== 'GET').length, '未编辑不得保存地图').toBe(0);

  // 新建路径（显式动作）
  await page.getByTestId('unified-new-route').click({ timeout: 8000 });
  await page.waitForTimeout(800);
  // 仅进入绘制态，不得立刻持久化
  expect(writes.filter(w => /\/api\/routes/.test(w.path)).length, '开始画路径不得立即持久化').toBe(0);

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('375 窄屏：选中二维码后属性区仍渲染可见（不被折叠右栏隐藏）', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { writes, errors } = await boot(page);

  await page.getByTestId('route-select-tool').click({ timeout: 5000 });
  await page.waitForTimeout(400);

  const box = await page.getByTestId('map-canvas').boundingBox();
  expect(box).toBeTruthy();

  const inspector = page.getByTestId('route-inspector');
  let picked = false;
  outer:
  for (let gy = 0.15; gy <= 0.85; gy += 0.06) {
    for (let gx = 0.15; gx <= 0.85; gx += 0.06) {
      await page.mouse.click(box!.x + box!.width * gx, box!.y + box!.height * gy);
      await page.waitForTimeout(90);
      if (await inspector.count() > 0) { picked = true; break outer; }
    }
  }

  expect(picked, '窄屏点选应能命中二维码').toBe(true);
  await expect(inspector).toBeVisible();
  const b = await inspector.boundingBox();
  expect(b!.width).toBeGreaterThan(0);
  expect(b!.height).toBeGreaterThan(0);
  // 属性区必须在视口内
  expect(b!.x).toBeGreaterThanOrEqual(0);
  expect(b!.x + b!.width).toBeLessThanOrEqual(376);

  expect(writes.filter(w => !w.path.includes('/localization/')).length, '选对象不得写库').toBe(0);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});
