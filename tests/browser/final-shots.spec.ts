import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'real-map-route.snapshot.json'), 'utf8'));
const MAP = snap.map, MAP_ID = snap.mapId, VERSION = snap.mapVersion, ROUTE = snap.route, ROUTE_ID = snap.routeId;

test('部署后最终界面截图：精简左栏 + 单一 38px 步骤区 + 无重复页头', async ({ page }) => {
  await page.route('**/api/**', async r => {
    const req = r.request(); const p = new URL(req.url()).pathname; const m = req.method().toUpperCase();
    if (['POST','PUT','PATCH','DELETE'].includes(m)) return r.fulfill({ json: { ok: true, mocked: true } });
    if (p === '/api/maps') return r.fulfill({ json: [{ id: MAP_ID, name: MAP.name, version: VERSION }] });
    if (p === `/api/maps/${MAP_ID}`) return r.fulfill({ json: { map: MAP, version: VERSION, acceptance: { kind: null, digestValid: false, accepted: false } } });
    if (p === `/api/maps/${MAP_ID}/tag-aliases`) return r.fulfill({ json: { mapId: MAP_ID, mapVersion: VERSION, aliases: [], disclaimer: 'x' } });
    if (p === '/api/routes') return r.fulfill({ json: [ROUTE] });
    if (p === `/api/routes/${ROUTE_ID}`) return r.fulfill({ json: { ...ROUTE, route: ROUTE, map: MAP, version: VERSION, acceptance: { kind: null, digestValid: false, accepted: false } } });
    if (p === '/api/tasks') return r.fulfill({ json: [] });
    if (p === '/api/surveys' || p === '/api/boards') return r.fulfill({ json: [] });
    if (p === '/api/camera/status') return r.fulfill({ json: { running: false, present: false } });
    if (p.includes('/localization/')) return r.fulfill({ json: { phase: 'anchored' } });
    return r.fulfill({ json: {} });
  });

  await page.goto('/');
  await page.waitForTimeout(900);
  await page.locator('.sidebar').getByRole('button', { name: '开始导航', exact: true }).click();
  await page.waitForTimeout(900);
  await page.getByTestId('map-select').selectOption(MAP_ID, { timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.getByTestId('route-select').selectOption(ROUTE_ID, { timeout: 20000 });
  await page.waitForTimeout(1400);

  mkdirSync('logs/final-shots', { recursive: true });
  await page.screenshot({ path: 'logs/final-shots/01-navigate.png', fullPage: false });

  // 进入路径编辑
  await page.getByTestId('nav-route-edit').click({ timeout: 20000 });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: 'logs/final-shots/02-edit.png', fullPage: false });

  // 打开唯一底部步骤区
  await page.getByTestId('route-steps-trigger').click({ timeout: 10000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'logs/final-shots/03-steps-open.png', fullPage: false });

  // 结构断言（部署版本上实测，不靠 testid 存在性）
  const info = await page.evaluate(() => {
    const vis = (sel: string) => {
      const e = document.querySelector(sel);
      if (!e) return false;
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const head = document.querySelector('[data-testid="route-steps-drag-handle"]') as HTMLElement | null;
    const rows = document.querySelectorAll('[data-testid="route-steps-dock"] tbody tr');
    const longCards = document.querySelectorAll('.route-segment-card, .route-step-detail-card').length;
    return {
      topbarVisible: vis('.topbar'),
      editingBadge: document.querySelectorAll('.editor-mode-badge').length,
      panNote: document.querySelectorAll('[data-testid="editor-mode-pan-note"]').length,
      fullWidthRejected: document.querySelectorAll('.command-feedback-banner, .command-feedback-full').length,
      leftStepsButton: document.querySelectorAll('[data-testid="open-route-steps"], .route-steps-open-btn').length,
      stepsHeadHeight: head ? Math.round(head.getBoundingClientRect().height) : -1,
      stepRows: rows.length,
      anchors: Number((document.querySelector('[data-testid="map-canvas"]') as HTMLElement).dataset.routeWaypoints ?? '-1'),
      longCards,
      triggers: document.querySelectorAll('[data-testid="route-steps-trigger"]').length,
      dock: !!document.querySelector('[data-testid="route-steps-dock"]'),
      canvasVisible: vis('[data-testid="map-canvas"]'),
    };
  });
  console.log('FINAL_UI ' + JSON.stringify(info));

  expect(info.canvasVisible, '画布可见').toBe(true);
  expect(info.stepsHeadHeight, `步骤区头部应为 38px（实际 ${info.stepsHeadHeight}）`).toBe(38);
  // 底部步骤表按**路点**计数（起点 + 每段一行），不是按 motionSegments 计数；
  // 12 段的存在性由 panel-compact 的拓扑 edgeCount 断言覆盖，这里只要求步骤表真实有行。
  expect(info.stepRows, `真实路线应有路点步骤行（实际 ${info.stepRows}）`).toBeGreaterThan(1);
  expect(info.anchors, `真实路线应有 10 个路点（实际 ${info.anchors}）`).toBe(10);
  expect(info.longCards, '默认不应常驻长详情卡').toBe(0);
  expect(info.leftStepsButton, '左栏不应再有重复步骤按钮').toBe(0);
  expect(info.topbarVisible, '编辑态不应出现重复大标题').toBe(false);
  expect(info.triggers, '步骤入口应唯一').toBeLessThanOrEqual(1);
});
