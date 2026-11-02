import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'real-map-route.snapshot.json'), 'utf8'));
const MAP = snap.map, MAP_ID: string = snap.mapId, VERSION: number = snap.mapVersion;

test('单点铺码：画布 ghost 可拖动并把新中心回写到输入框', async ({ page }) => {
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

  // 进入手动建图（map-only 地图才有铺码面板）
  await page.locator('.sidebar').getByRole('button', { name: '开始导航', exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByTestId('map-select').selectOption(MAP_ID, { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByTestId('nav-open-map-editor').click({ timeout: 20000 });
  await page.waitForTimeout(2000);

  // 打开「单点」铺码
  await page.getByTestId('map-tool-single').click({ timeout: 10000 });
  await page.waitForTimeout(1200);

  const before = await page.evaluate(() => {
    const xs = document.querySelectorAll<HTMLInputElement>('input[type="number"]');
    const ghost = (window as any).__stage?.getLayers?.()[0]?.getChildren?.().find((n: any) => (n.name() || '') === 'ghost-tags');
    const dot = ghost?.getChildren?.().find((n: any) => (n.name() || '') === 'ghost-tag-0');
    return {
      ghostCount: ghost ? ghost.getChildren().length : -1,
      dotPos: dot ? { x: dot.x(), y: dot.y() } : null,
      draggable: dot ? dot.draggable() : null,
      listening: dot ? dot.listening() : null,
      inputs: Array.from(xs).slice(0, 6).map(i => i.value),
    };
  });
  console.log('GHOST_BEFORE ' + JSON.stringify(before));

  expect(before.ghostCount, '单点预览应出现 ghost').toBeGreaterThan(0);
  expect(before.dotPos, '存在 ghost 主锚点').not.toBeNull();
  expect(before.draggable, 'ghost 主锚点必须可拖动').toBe(true);
  expect(before.listening, 'ghost 主锚点必须可接收事件').toBe(true);

  // 真实拖拽：把主锚点拖动 120px
  const target = await page.evaluate(() => {
    const stage = (window as any).__stage;
    const layer = stage.getLayers()[0];
    const ghost = layer.getChildren().find((n: any) => (n.name() || '') === 'ghost-tags');
    const dot = ghost.getChildren().find((n: any) => (n.name() || '') === 'ghost-tag-0');
    const c = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
    const box = c.getBoundingClientRect();
    return { x: box.x + stage.x() + dot.x() * stage.scaleX(), y: box.y + stage.y() + dot.y() * stage.scaleY() };
  });
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 60, target.y + 60, { steps: 10 });
  await page.mouse.move(target.x + 120, target.y + 100, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(900);

  const after = await page.evaluate(() => {
    const xs = document.querySelectorAll<HTMLInputElement>('input[type="number"]');
    const ghost = (window as any).__stage?.getLayers?.()[0]?.getChildren?.().find((n: any) => (n.name() || '') === 'ghost-tags');
    const dot = ghost?.getChildren?.().find((n: any) => (n.name() || '') === 'ghost-tag-0');
    return {
      dotPos: dot ? { x: dot.x(), y: dot.y() } : null,
      inputs: Array.from(xs).slice(0, 6).map(i => i.value),
    };
  });
  console.log('GHOST_AFTER ' + JSON.stringify(after));

  const movedPx = Math.hypot(after.dotPos!.x - before.dotPos!.x, after.dotPos!.y - before.dotPos!.y);
  expect(movedPx, `ghost 必须真的被拖动（位移 ${movedPx.toFixed(1)}px）`).toBeGreaterThan(1);
  // 输入框必须跟着变（回写生效，不是只有预览动）
  expect(after.inputs.join(','), '拖动后中心坐标输入框必须同步更新').not.toBe(before.inputs.join(','));
  expect(writes.filter(w => !w.includes('/localization/')).length, '只读不得写').toBe(0);
});
