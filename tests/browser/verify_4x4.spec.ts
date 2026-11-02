import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const MAP_ID = 'design-6ee9ba81';
const ROUTE_ID = 'route-70a449029bed7a56bfc48e5f';

test('迁移后：画布显示 17 块 4×4 板名，路线仍在', async ({ page }) => {
  // 只读：拦截所有写请求
  const writes: string[] = [];
  await page.route('**/api/**', async r => {
    const req = r.request();
    const p = new URL(req.url()).pathname;
    const m = req.method().toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) { writes.push(`${m} ${p}`); return r.fulfill({ json: { ok: true, mocked: true } }); }
    return r.continue();
  });
  await page.setViewportSize({ width: 1910, height: 925 });
  await page.goto('/');
  await page.waitForTimeout(900);
  await page.locator('.sidebar').getByRole('button', { name: '开始导航', exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByTestId('map-select').selectOption(MAP_ID, { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.getByTestId('route-select').selectOption(ROUTE_ID, { timeout: 20000 });
  await page.waitForTimeout(1800);
  // 等标签真正渲染出来（避免读到重建前的空数组）
  await page.waitForFunction(() => {
    const stage = (window as any).__stage;
    const layer = stage?.getLayers?.()[0];
    if (!layer) return false;
    let n = 0;
    const walk = (x: any) => { if ((x.name() || '').startsWith('tag-label-') && x.visible()) n++; x.getChildren?.().forEach(walk); };
    layer.getChildren().forEach(walk);
    return n >= 10;
  }, null, { timeout: 15000 });

  mkdirSync('logs/4x4-shots', { recursive: true });
  await page.screenshot({ path: 'logs/4x4-shots/01-navigate.png', fullPage: false });

  const info = await page.evaluate(() => {
    const stage = (window as any).__stage;
    const layer = stage.getLayers()[0];
    const labels: string[] = [];
    const walk = (n: any) => {
      const nm = n.name() || '';
      if (nm.startsWith('tag-label-') && n.visible()) labels.push(n.text());
      n.getChildren?.().forEach(walk);
    };
    layer.getChildren().forEach(walk);
    const canvas = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
    return {
      labels: labels.sort(),
      segments: canvas.dataset.konvaRouteSegments,
      tags: canvas.dataset.konvaTags,
      routeWaypoints: canvas.dataset.routeWaypoints,
    };
  });
  console.log('MIGRATED_UI ' + JSON.stringify(info, null, 1));

  // 17 块板名必须出现
  const expected = ['B016','B032','B064','B080','B096','B112','B128','B144','B160','B176','B192','B208','B224','B240','B272','B300','B316'];
  for (const name of expected) {
    expect(info.labels, `画布必须显示板名 ${name}`).toContain(name);
  }
  // 旧的 Q000 式标签不应再是主标签
  expect(info.labels.some(l => /^Q\d{3}$/.test(l)), '不应再显示 Q### 单码名').toBe(false);
  // 路线仍在
  expect(Number(info.segments), '12+ 段路线仍在').toBeGreaterThanOrEqual(12);
  // 应用自身会发定位相关 POST（正常遥测）；这里只断言没有业务写入。
  const businessWrites = writes.filter(w => !w.includes('/localization/'));
  console.log('BUSINESS_WRITES ' + JSON.stringify(businessWrites));
  expect(businessWrites.length, '本次验证不得产生业务写入').toBe(0);

  await page.getByTestId('nav-route-edit').click({ timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'logs/4x4-shots/02-edit.png', fullPage: false });
});
