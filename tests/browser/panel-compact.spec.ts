import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SNAP = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real-map-route.snapshot.json'), 'utf8'),
);
const MAP = SNAP.map, ROUTE = SNAP.route;
const MAP_ID: string = SNAP.mapId, VERSION: number = SNAP.mapVersion, ROUTE_ID: string = SNAP.routeId;

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
    if (p === '/api/maps') return r.fulfill({ json: [{ id: MAP_ID, name: MAP.name, version: VERSION }] });
    if (p === `/api/maps/${MAP_ID}`) return r.fulfill({ json: { map: MAP, version: VERSION, acceptance: { kind: null, digestValid: false, accepted: false } } });
    if (p === `/api/maps/${MAP_ID}/tag-aliases`) return r.fulfill({ json: { mapId: MAP_ID, mapVersion: VERSION, aliases: [], disclaimer: 'x' } });
    if (p === '/api/routes') return r.fulfill({ json: [ROUTE] });
    if (p === `/api/routes/${ROUTE_ID}`) return r.fulfill({ json: { ...ROUTE, route: ROUTE, map: MAP, version: VERSION, acceptance: { kind: null, digestValid: false, accepted: false } } });
    if (p === `/api/routes/${ROUTE_ID}/topology`) {
      return r.fulfill({ json: { routeId: ROUTE_ID, mapId: MAP_ID, mapVersion: VERSION, stored: false,
        topology: { nodes: [], edges: ROUTE.motionSegments.map((s: any) => ({ fromId: s.fromId, toId: s.toId, occurrence: 1, mode: s.mode, direction: s.direction })) },
        summary: [], issues: [], strategyChoices: { choices: [], issues: [] }, disclaimer: 'x' } });
    }
    if (p === '/api/tasks') return r.fulfill({ json: [] });
    if (p === '/api/surveys' || p === '/api/boards') return r.fulfill({ json: [] });
    if (p === '/api/camera/status') return r.fulfill({ json: { running: false, present: false } });
    if (p.includes('/localization/')) return r.fulfill({ json: { phase: 'anchored' } });
    return r.fulfill({ json: {} });
  });

  await page.goto('/');
  await page.waitForTimeout(900);
  // 必须先选中真实路线：拓扑面板只在 routeEditId 存在时渲染。
  await page.locator('.sidebar').getByRole('button', { name: '开始导航', exact: true }).click();
  await page.waitForTimeout(900);
  await page.getByTestId('map-select').selectOption(MAP_ID).catch(() => {});
  await page.waitForTimeout(1100);
  await page.getByTestId('route-select').selectOption(ROUTE_ID).catch(() => {});
  await page.waitForTimeout(900);
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2600);
  return { writes, errors };
}

test('左栏段列表默认简洁：只显示起终点+重复经过，详情按需展开', async ({ page }) => {
  const { writes, errors } = await boot(page);

  // 打开拓扑组（若折叠）
  const toggle = page.getByTestId('route-tools-group-toggle-topology');
  if (await toggle.count()) {
    const expanded = await toggle.getAttribute('aria-expanded');
    if (expanded !== 'true') { await toggle.click(); await page.waitForTimeout(500); }
  }

  const info = await page.evaluate(() => {
    const vis = (s: string) => {
      const e = document.querySelector(s);
      if (!e) return false;
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const edges = document.querySelectorAll('[data-testid^="route-topology-edge-"]');
    const first = document.querySelector('[data-testid="route-topology-edge-0"]');
    return {
      edgeCount: edges.length,
      firstTitle: first ? (first.querySelector('b')?.textContent || '').trim() : null,
      firstOccurrence: first ? (first.querySelector('[data-testid="route-topology-occurrence-0"]')?.textContent || '').trim() : null,
      // 默认收起：模式 chip / 策略 select / 操作按钮不应可见
      modeChipVisible: !!document.querySelector('[data-testid="route-topology-meta-0"]') && vis('[data-testid="route-topology-meta-0"]'),
      strategyVisible: !!document.querySelector('[data-testid="route-topology-strategy-0"]') && vis('[data-testid="route-topology-strategy-0"]'),
      reverseVisible: !!document.querySelector('[data-testid="route-topology-reverse-0"]') && vis('[data-testid="route-topology-reverse-0"]'),
      expandVisible: vis('[data-testid="route-topology-expand-0"]'),
    };
  });

  console.log('EDGES ' + JSON.stringify(info));
  expect(info.edgeCount, '真实 12 段全部保留').toBe(12);
  expect(info.firstTitle, '默认仍显示起终点').toContain('→');
  expect(info.expandVisible, '有展开按钮').toBe(true);
  // 默认不常驻长详情
  expect(info.modeChipVisible, '默认不显示 4T4D/Crab 模式').toBe(false);
  expect(info.strategyVisible, '默认不显示策略选择').toBe(false);
  expect(info.reverseVisible, '默认不显示操作按钮').toBe(false);

  // 展开后详情出现
  await page.getByTestId('route-topology-expand-0').click({ timeout: 5000 });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const vis = (s: string) => {
      const e = document.querySelector(s);
      if (!e) return false;
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    return {
      mode: vis('[data-testid="route-topology-meta-0"]'),
      strategy: vis('[data-testid="route-topology-strategy-0"]'),
      reverse: vis('[data-testid="route-topology-reverse-0"]'),
    };
  });
  expect(after.mode, '展开后显示模式').toBe(true);
  expect(after.strategy, '展开后显示策略').toBe(true);
  expect(after.reverse, '展开后显示操作').toBe(true);

  expect(writes.filter(w => !w.path.includes('/localization/')).length, '不得写').toBe(0);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('步骤入口唯一：左栏无重复按钮，右侧 38px 步骤区是唯一开关', async ({ page }) => {
  const { errors } = await boot(page);

  const info = await page.evaluate(() => {
    const vis = (s: string) => {
      const e = document.querySelector(s);
      if (!e) return false;
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    return {
      leftStepsBtn: !!document.querySelector('[data-testid="route-panel-open-steps"]'),
      stepsGroup: !!document.querySelector('[data-testid="route-tools-group-toggle-steps"]'),
      trigger: vis('[data-testid="route-steps-trigger"]'),
      triggerCount: document.querySelectorAll('[data-testid="route-steps-trigger"]').length,
    };
  });

  expect(info.leftStepsBtn, '左栏重复步骤按钮已删除').toBe(false);
  expect(info.stepsGroup, '左栏步骤分组已删除').toBe(false);
  expect(info.trigger, '右侧步骤开关存在').toBe(true);
  expect(info.triggerCount, '步骤开关唯一').toBe(1);

  // 开关可用
  await page.getByTestId('route-steps-trigger').click({ timeout: 5000 });
  await page.waitForTimeout(700);
  await expect(page.getByTestId('route-steps-dock')).toBeVisible();
  const h = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="route-steps-drag-handle"]');
    return e ? Math.round(e.getBoundingClientRect().height) : null;
  });
  expect(h, '步骤头仍为 38px').toBe(38);

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('顶部精简 + 文案去重', async ({ page }) => {
  const { errors } = await boot(page);

  const info = await page.evaluate(() => {
    const vis = (s: string) => {
      const e = document.querySelector(s);
      if (!e) return false;
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const hint = document.querySelector('[data-testid="route-tool-hint"]');
    return {
      topbar: vis('.topbar'),
      editingBadge: document.body.innerText.includes('路径编辑中'),
      feedback: vis('[data-testid="command-feedback"]'),
      hintText: hint ? (hint.textContent || '').trim().replace(/\s+/g, ' ') : '',
    };
  });

  expect(info.topbar, '编辑态无常驻重复页头').toBe(false);
  expect(info.editingBadge, '无「路径编辑中」标签').toBe(false);
  expect(info.feedback, '无历史拒绝横幅').toBe(false);
  // 「选择」不应重复出现两次
  const selCount = (info.hintText.match(/选择/g) || []).length;
  expect(selCount, `工具提示不应重复「选择」（实际: ${info.hintText}）`).toBeLessThanOrEqual(1);

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});
