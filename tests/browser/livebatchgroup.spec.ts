import {test,expect} from '@playwright/test';

/**
 * 真实后端 E2E：把一张 4×4 的多定位组地图克隆成临时地图，
 * 然后在界面上把全部定位组一键改成 3×3，再改成 4×4，验证落库与持久化。
 * 只操作临时地图，结束后删除。
 */
/** 「点位与铺码」分组默认收起：用 aria-expanded 判断，绝不重复点成关闭。 */
async function revealPalette(page: any) {
 const toggle = page.getByTestId('route-tools-group-toggle-tags');
 if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
 await expect(toggle).toHaveAttribute('aria-expanded', 'true');
 await expect(page.getByTestId('palette-single')).toBeVisible();
}

test('批量改组规格：全部定位组 4×4 → 3×3 → 4×4（真实后端，临时地图）', async ({page}) => {
 const srcMap = 'design-6ee9ba81';
 let mapId = '';
 const errors: string[] = [];
 page.on('pageerror', e => errors.push(String(e.message)));
 try {
  await page.goto('/');
  mapId = await page.evaluate(async ({src, stamp}) => {
   const source = await (await fetch('/api/maps/' + src)).json();
   const id = 'design-selftest-ui' + stamp;
   const created = await fetch('/api/maps', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({map: {...source.map, id, name: 'selftest-ui-' + stamp}, baseVersion: 0})});
   const body = await created.json();
   if (!created.ok) throw new Error(JSON.stringify(body));
   return id;
  }, {src: srcMap, stamp: String(Date.now()).slice(-6)});

  const groupsOf = () => page.evaluate(async (id) => {
   const body = await (await fetch('/api/maps/' + id)).json();
   return body.map.groups.map((g: any) => ({id: g.id, rows: g.rows ?? g.gridSize, cols: g.cols ?? g.gridSize, members: g.members.length, sizeMm: g.sizeMm}));
  }, mapId);

  await page.goto('/');
  await page.getByTitle('开始导航').click();
  await page.getByTestId('map-select').selectOption(mapId);
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.getByTestId('nav-route-edit').click();
  await expect(page.getByTestId('route-editor')).toBeVisible();
  await page.getByTestId('route-tools-group-toggle-tags').click();
  await page.getByLabel('适应地图').click();
  await page.waitForTimeout(500);

  const before = await groupsOf();
  expect(before.length).toBeGreaterThan(1);
  expect(before.every(g => g.rows === 4 && g.cols === 4)).toBe(true);

  // 1) 选中一个定位组中心 → 码组规格卡 → 设成 3×3 → 全部定位组应用
  const centre = before[0];
  const centreTagId = Number(centre.id.slice(1));
  const point = await page.evaluate((id) => (window as any).__mapCanvasApi.screenOfTag(id), centreTagId);
  expect(point).not.toBeNull();
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId('object-group-apply-all')).toBeVisible();
  await page.getByTestId('object-group-grid').selectOption('3');
  await page.getByTestId('object-group-rows').selectOption('3');
  await page.getByTestId('object-group-apply-all').click();
  await expect.poll(async () => (await groupsOf()).every(g => g.rows === 3 && g.cols === 3 && g.members === 9), {timeout: 15000}).toBe(true);
  const after3 = await groupsOf();
  expect(after3.length).toBe(before.length);

  // 2) 重新加载后仍然是 3×3（真的落库了）
  await page.reload();
  await page.getByTitle('开始导航').click();
  await page.getByTestId('map-select').selectOption(mapId);
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.getByTestId('nav-route-edit').click();
  await page.getByTestId('route-tools-group-toggle-tags').click();
  await page.getByLabel('适应地图').click();
  await page.waitForTimeout(400);
  const reloaded = await groupsOf();
  expect(reloaded.every(g => g.rows === 3 && g.cols === 3)).toBe(true);

  // 3) 顶部工具栏里的批量入口：全部定位组 → 4×4
  await expect(page.getByTestId('toolbar-group-spec')).toBeVisible();
  await page.getByTestId('toolbar-group-spec-toggle').click();
  await page.getByTestId('toolbar-group-cols').selectOption('4');
  await page.getByTestId('toolbar-group-rows').selectOption('4');
  await page.getByTestId('toolbar-group-all').check();
  await page.getByTestId('toolbar-group-apply').click();
  await expect.poll(async () => (await groupsOf()).every(g => g.rows === 4 && g.cols === 4 && g.members === 16), {timeout: 15000}).toBe(true);
  expect(errors.filter(m => m.includes('before initialization'))).toEqual([]);
 } finally {
  if (mapId) {
   const status = await page.evaluate(async (id) => (await fetch('/api/maps/' + id, {method: 'DELETE'})).status, mapId).catch(() => 0);
   console.log('CLEANUP', mapId, status);
  }
 }
});
