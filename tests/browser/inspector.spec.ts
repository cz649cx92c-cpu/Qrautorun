import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'real-map-route.snapshot.json'), 'utf8'));
const MAP = snap.map, MAP_ID: string = snap.mapId, VERSION: number = snap.mapVersion;

test('路点属性面板：标签与数值分两列，且能真正收起', async ({ page }) => {
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
  await page.getByTestId('unified-new-route').click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.getByTestId('route-draw-tool').click({ timeout: 15000 });
  await page.waitForTimeout(500);

  // 加两个点，使属性面板出现
  const tagPoint = (idx: number) => page.evaluate((i) => {
    const stage = (window as any).__stage;
    const layer = stage.getLayers()[0];
    const gs = layer.getChildren().filter((n: any) => (n.name() || '').startsWith('tag-') && !(n.name() || '').startsWith('tag-label-'));
    const g = gs[i]; if (!g) return null;
    const c = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
    const box = c.getBoundingClientRect();
    return { x: box.x + stage.x() + g.x() * stage.scaleX(), y: box.y + stage.y() + g.y() * stage.scaleY() };
  }, idx);
  const a = await tagPoint(0), b = await tagPoint(5);
  await page.mouse.click(a!.x, a!.y); await page.waitForTimeout(500);
  await page.mouse.click(b!.x, b!.y); await page.waitForTimeout(800);

  mkdirSync('logs/inspector-shots', { recursive: true });
  await page.screenshot({ path: 'logs/inspector-shots/01-open.png', fullPage: false });

  // 1) 布局：dt 与 dd 必须在同一行（纵向中心接近、dd 在 dt 右侧）
  const layout = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.route-inspector-rows > div'));
    return rows.map(r => {
      const dt = r.querySelector('dt')!.getBoundingClientRect();
      const dd = r.querySelector('dd')!.getBoundingClientRect();
      return {
        label: r.querySelector('dt')!.textContent?.trim(),
        dtRight: Math.round(dt.right), ddLeft: Math.round(dd.left),
        dtTop: Math.round(dt.top), ddTop: Math.round(dd.top),
        overlapX: Math.round(Math.min(dt.right, dd.right) - Math.max(dt.left, dd.left)),
      };
    });
  });
  console.log('INSPECTOR_ROWS ' + JSON.stringify(layout));
  expect(layout.length, '应有属性行').toBeGreaterThan(0);
  for (const row of layout) {
    expect(row.ddLeft, `「${row.label}」数值必须在标签右侧，不能压在同一列`).toBeGreaterThanOrEqual(row.dtRight - 1);
    expect(Math.abs(row.ddTop - row.dtTop), `「${row.label}」标签与数值应在同一行`).toBeLessThan(12);
    expect(row.overlapX, `「${row.label}」标签与数值不得水平重叠`).toBeLessThanOrEqual(0);
  }

  // 2) 面板当前可见
  await expect(page.getByTestId('route-inspector')).toBeVisible({ timeout: 5000 });

  // 3) 点「关闭」→ 面板必须真的消失，右栏也必须收起
  await page.getByTestId('route-inspector-close').click({ timeout: 5000 });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => {
    const insp = document.querySelector('[data-testid="route-inspector"]') as HTMLElement | null;
    const right = document.querySelector('[data-testid="editor-shell-inspector"]') as HTMLElement | null;
    const vis = (el: HTMLElement | null) => {
      if (!el) return false;
      const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    return { inspectorVisible: vis(insp), rightColumnVisible: vis(right), rightDisplay: right ? getComputedStyle(right).display : 'absent' };
  });
  console.log('AFTER_CLOSE ' + JSON.stringify(after));
  await page.screenshot({ path: 'logs/inspector-shots/02-closed.png', fullPage: false });
  expect(after.inspectorVisible, '关闭后面板必须消失').toBe(false);
  expect(after.rightColumnVisible, `关闭后右栏必须收起（display=${after.rightDisplay}）`).toBe(false);

  // 4) 再点一次路点应能重新打开（关闭不是永久禁用）
  await page.mouse.click(a!.x, a!.y); await page.waitForTimeout(700);
  const reopened = await page.evaluate(() => {
    const insp = document.querySelector('[data-testid="route-inspector"]') as HTMLElement | null;
    if (!insp) return false;
    const b = insp.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  });
  console.log('REOPENED ' + JSON.stringify({ reopened }));
  expect(reopened, '重新选中对象后属性应再次出现').toBe(true);

  expect(writes.filter(w => !w.includes('/localization/')).length, '只读不得写').toBe(0);
});
