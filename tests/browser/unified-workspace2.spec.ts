import { test, expect, type Page } from '@playwright/test';

const MAP_ID = 'ui-map';
const tags = [
  { id: 0, x: 0, y: 0, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] },
  { id: 1, x: 1, y: 0, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] },
  { id: 2, x: 1, y: 1, angle: 0, size: .08, rowId: 'route', kind: 'waypoint', rules: [] },
];

function makeMap(id = MAP_ID) {
  return {
    schemaVersion: 1, id, name: '统一工作区图', frame: 'map', family: 'tag36h11', source: 'manual',
    coordinateStatus: 'draft', routeMode: 'map-only',
    rows: [], order: [], tags,
    zone: [{ x: -8, y: -8 }, { x: 9, y: -8 }, { x: 9, y: 9 }, { x: -8, y: 9 }],
    vehicle: { width: 0.4, length: 0.8, margin: 0.05 }, notes: '',
  };
}

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
    if (['POST','PUT','PATCH','DELETE'].includes(m)) {
      writes.push({ method: m, path: p });
      if (p === '/api/maps/new') return route.fulfill({ json: { map: makeMap('ui-new-1'), version: 1 } });
      return route.fulfill({ json: { ok: true, mocked: true } });
    }
    if (p === '/api/maps') return route.fulfill({ json: [{ id: MAP_ID, name: '统一工作区图', version: 1 }] });
    if (p.startsWith('/api/maps/')) {
      if (p.endsWith('/tag-aliases')) return route.fulfill({ json: { mapId: MAP_ID, mapVersion: 1, aliases: [], disclaimer: 'x' } });
      const id = decodeURIComponent(p.slice('/api/maps/'.length));
      return route.fulfill({ json: { map: makeMap(id), version: 1, acceptance: { kind: 'office_test', accepted: true, digestValid: true } } });
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
  await page.getByTestId('nav-route-edit').click({ timeout: 5000 });
  await page.waitForTimeout(2000);
  return { writes, errors };
}

test('编辑态：选择/平移/加点不退化', async ({ page }) => {
  const { writes, errors } = await boot(page);

  const canvas = page.getByTestId('map-canvas');
  const badge = page.getByTestId('editor-mode-badge');
  await expect(canvas).toBeVisible({ timeout: 8000 });

  // 编辑态画布 tool 恒为 route-design；真实工具态看 editor-mode-badge 的 data-mode。
  await expect(canvas).toHaveAttribute('data-canvas-tool', 'route-design');

  // 选择：拖动不平移
  await page.getByTestId('route-select-tool').click({ timeout: 5000 });
  await page.waitForTimeout(300);
  await expect(badge).toHaveAttribute('data-mode', 'select');
  await expect(canvas).toHaveAttribute('data-canvas-mode', 'select');

  // 平移：拖动平移画布
  await page.getByTestId('route-pan-tool').click({ timeout: 5000 });
  await page.waitForTimeout(300);
  await expect(badge).toHaveAttribute('data-mode', 'pan');
  await expect(canvas).toHaveAttribute('data-canvas-mode', 'pan');

  // 加点：可创建，但拖动不平移（dragPansCanvas=false → canvasMode 仍 select）
  await page.getByTestId('route-draw-tool').click({ timeout: 5000 });
  await page.waitForTimeout(300);
  await expect(badge).toHaveAttribute('data-mode', 'draw');
  await expect(canvas).toHaveAttribute('data-canvas-mode', 'select');

  // 回到选择
  await page.getByTestId('route-select-tool').click({ timeout: 5000 });
  await page.waitForTimeout(300);
  await expect(badge).toHaveAttribute('data-mode', 'select');

  const businessWrites = writes.filter(w => !w.path.includes('/localization/'));
  expect(businessWrites.length, '切工具不得写数据').toBe(0);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

for (const [w, h] of [[1440, 900], [375, 812]] as const) {
  test(`真实 DOM 度量 ${w}x${h}：工具可见且无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    const { writes, errors } = await boot(page);

    const m = await page.evaluate(() => {
      const g = (s: string) => {
        const e = document.querySelector(s) as HTMLElement | null;
        if (!e) return null;
        const b = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
                 right: Math.round(b.right), bottom: Math.round(b.bottom),
                 visible: b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        overflowX: document.documentElement.scrollWidth - innerWidth,
        panel: g('[data-testid="route-tools-panel"]'),
        mapGroup: g('[data-testid="route-tools-group-toggle-map"]'),
        mapSelect: g('[data-testid="unified-map-select"]'),
        newBlank: g('[data-testid="unified-new-blank-map"]'),
        tagsGroup: g('[data-testid="route-tools-group-toggle-tags"]'),
        newRoute: g('[data-testid="unified-new-route"]'),
        toolbar: g('[data-testid="route-editor-toolbar"]'),
        canvas: g('[data-testid="map-canvas"]'),
        save: g('[data-testid="route-save"]'),
        exit: g('[data-testid="route-exit"]'),
      };
    });

    expect(m.overflowX, `${w}x${h} 不得横向溢出`).toBeLessThanOrEqual(1);
    expect(m.panel?.visible, '工具面板可见').toBe(true);
    expect(m.mapGroup?.visible, '地图组可见').toBe(true);
    expect(m.newRoute?.visible, '新建路径入口可见').toBe(true);
    expect(m.canvas?.visible, '画布可见').toBe(true);
    expect(m.save?.visible, '保存可见').toBe(true);
    expect(m.exit?.visible, '退出可见').toBe(true);
    // 保存/退出必须在视口内
    expect(m.save!.right).toBeLessThanOrEqual(w);
    expect(m.save!.x).toBeGreaterThanOrEqual(0);
    expect(m.exit!.right).toBeLessThanOrEqual(w);

    const businessWrites = writes.filter(x => !x.path.includes('/localization/'));
    expect(businessWrites.length, '只读度量不得写数据').toBe(0);
    expect(errors.filter(e => !/404/.test(e))).toEqual([]);

    console.log(`METRICS_${w}x${h} ` + JSON.stringify(m));
  });
}
