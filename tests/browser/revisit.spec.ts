import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'real-map-route.snapshot.json'), 'utf8'));
const MAP = snap.map, MAP_ID: string = snap.mapId, VERSION: number = snap.mapVersion;

test('路径编辑：同一二维码可以重复铺设（A→B→A）', async ({ page }) => {
  const writes: string[] = [];
  await page.route('**/api/**', async r => {
    const req = r.request(); const p = new URL(req.url()).pathname; const m = req.method().toUpperCase();
    if (['POST','PUT','PATCH','DELETE'].includes(m)) { writes.push(`${m} ${p}`); return r.fulfill({ json: { ok: true, mocked: true } }); }
    if (p === '/api/maps') return r.fulfill({ json: [{ id: MAP_ID, name: MAP.name, version: VERSION }] });
    if (p === `/api/maps/${MAP_ID}`) return r.fulfill({ json: { map: MAP, version: VERSION, acceptance: { kind: null, digestValid: false, accepted: false } } });
    if (p === `/api/maps/${MAP_ID}/tag-aliases`) return r.fulfill({ json: { mapId: MAP_ID, mapVersion: VERSION, aliases: [], disclaimer: 'x' } });
    if (p === '/api/routes') return r.fulfill({ json: [] });
    if (p === '/api/tasks') return r.fulfill({ json: [] });
    if (p === '/api/surveys' || p === '/api/boards') return r.fulfill({ json: [] });
    if (p === '/api/camera/status') return r.fulfill({ json: { running: false, present: false } });
    if (p.includes('/localization/')) return r.fulfill({ json: { phase: 'anchored' } });
    return r.fulfill({ json: {} });
  });
  await page.setViewportSize({ width: 1910, height: 925 });
  await page.goto('/');
  await page.waitForTimeout(900);
  await page.locator('.sidebar').getByRole('button', { name: '开始导航', exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByTestId('map-select').selectOption(MAP_ID, { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByTestId('nav-open-map-editor').click({ timeout: 20000 });
  await page.waitForTimeout(2000);
  // 进入路径编辑：真实入口 testid=new-route（按钮含图标，exact 名称匹配会失败）
  const newRoute = page.getByTestId('unified-new-route');
  await newRoute.waitFor({ state: 'visible', timeout: 15000 });
  await newRoute.click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  // 切到「加点」
  await page.getByTestId('route-draw-tool').click({ timeout: 15000 });
  await expect(page.getByTestId('route-draw-tool')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(600);

  const tagPoint = (idx: number) => page.evaluate((i) => {
    const stage = (window as any).__stage;
    const layer = stage.getLayers()[0];
    const groups = layer.getChildren().filter((n: any) => (n.name() || '').startsWith('tag-') && !(n.name() || '').startsWith('tag-label-'));
    const g = groups[i];
    if (!g) return null;
    const c = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
    const box = c.getBoundingClientRect();
    return { id: g.name(), x: box.x + stage.x() + g.x() * stage.scaleX(), y: box.y + stage.y() + g.y() * stage.scaleY() };
  }, idx);

  const anchors = () => page.evaluate(() => Number((document.querySelector('[data-testid="map-canvas"]') as HTMLElement).dataset.routeWaypoints ?? '-1'));

  const a1 = await tagPoint(0);
  const b1 = await tagPoint(5);
  expect(a1).not.toBeNull(); expect(b1).not.toBeNull();

  // A → B → A（重复经过 A）
  await page.mouse.click(a1!.x, a1!.y); await page.waitForTimeout(500);
  const n1 = await anchors();
  await page.mouse.click(b1!.x, b1!.y); await page.waitForTimeout(500);
  const n2 = await anchors();
  await page.mouse.click(a1!.x, a1!.y); await page.waitForTimeout(500);
  const n3 = await anchors();

  console.log('REVISIT ' + JSON.stringify({ a1: a1!.id, b1: b1!.id, afterA: n1, afterB: n2, afterA2: n3 }));
  expect(n1, '第一次点 A 应加入路点').toBeGreaterThan(0);
  expect(n2, '点 B 应再加一个').toBe(n1 + 1);
  expect(n3, `重复点 A 应再加一个（A→B→A），实际 ${n1}→${n2}→${n3}`).toBe(n2 + 1);
  expect(writes.filter(w => !w.includes('/localization/')).length, '只读不得写').toBe(0);
});
