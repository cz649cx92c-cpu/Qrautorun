import {test,expect,type Page} from '@playwright/test';

/** 导航页现在是只读的：所有点位/规格/批量操作都要先进「路径编辑」。幂等。 */
async function enterEditor(page: import('@playwright/test').Page) {
 if (await page.getByTestId('route-editor').isVisible().catch(() => false)) return;
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await page.waitForTimeout(250);
}

/**
 * 选中高亮的真实回归：读的是 Konva 节点自身的 fill/stroke（window.__mapCanvasApi.tagStyle），
 * 不是 DOM 类名。覆盖：点选高亮 → 切换后旧点恢复、新点高亮 → 点空白清除 → 拖动后仍高亮且坐标已保存。
 */
test.describe.configure({mode:'serial'});
test.use({viewport:{width:1280,height:800}});

const baseTags = [
 {id:24,rowId:'',x:1.0,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:26,rowId:'',x:1.4,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:30,rowId:'',x:1.0,y:1.6,angle:0,size:.06,kind:'waypoint',rules:[]},
];
const mapId = 'regress-highlight-map';
let current: any[] = [];
let writes: any[] = [];

async function boot(page: Page) {
 current = baseTags.map(t => ({...t}));
 writes = [];
 await page.routeWebSocket('**/ws', ws => ws.send(JSON.stringify({type: 'robot', status: {connected: true, state: 'IDLE', running: false, paused: false, pose: null, chassis: {connected: true}, sensors: {}, conditions: [], detector: {connected: true, ids: [], groups: [], positionReady: false, reason: ''}, mapping: {ready: true}, events: [], trail: []}})));
 await page.route('**/api/**', async route => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const method = req.method();
  const body = req.postData() ? JSON.parse(req.postData()!) : null;
  const json = (value: any) => route.fulfill({status: 200, json: value});
  if (method !== 'GET') writes.push({method, path, body});
  if (path === '/api/camera/status') return json({running: true, present: true, frameAgeMs: 10, error: ''});
  if (path === '/api/robot/status') return json({connected: true, state: 'IDLE', running: false, paused: false, pose: null, chassis: {connected: true}, sensors: {}, conditions: [], detector: {connected: true, ids: [], groups: [], positionReady: false, reason: ''}, mapping: {ready: true}, events: [], trail: []});
  if (path === '/api/localization/map') return json({anchored: true, mapId});
  if (path === '/api/localization/scope') return json({phase: 'anchored'});
  if (path === '/api/maps' && method === 'GET') return json([{id: mapId, name: 'highlight map', version: 1}]);
  if (path === '/api/maps/' + mapId && method === 'GET') return json({map: {id: mapId, name: 'highlight map', routeMode: 'map-only', rows: [], order: [], groups: [], tags: current, zone: [{x: 0, y: 0}, {x: 3, y: 0}, {x: 3, y: 3}, {x: 0, y: 3}]}, version: 1, acceptance: null});
  if (path === '/api/maps' && method === 'POST') { current = body.map.tags; return json({map: body.map, version: 1, acceptance: null}); }
  if (['/api/surveys', '/api/tasks', '/api/routes', '/api/boards', '/api/camera/calibration'].includes(path)) return json([]);
  if (path.endsWith('/tag-aliases')) return json({aliases: []});
  if (method !== 'GET') return json({ok: true});
  return json({});
 });
 await page.goto('/');
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(mapId);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await enterEditor(page);
 await page.getByLabel('适应地图').click();
 await page.waitForTimeout(300);
}

async function point(page: Page, id: number) {
 const value = await page.evaluate((tagId) => (window as any).__mapCanvasApi?.screenOfTag(tagId), id);
 if (!value) throw new Error(`screenOfTag(${id}) returned null`);
 return value as {x: number; y: number};
}
async function style(page: Page, id: number) {
 return page.evaluate((tagId) => (window as any).__mapCanvasApi?.tagStyle?.(tagId), id) as Promise<{fill: string; stroke: string; labelFill: string | null} | null>;
}
const HIGHLIGHT = '#2563a6';
const NORMAL = '#39444f';

test('点选/切换/空白清除的选中高亮来自真实节点样式', async ({page}) => {
 await boot(page);
 expect(await style(page, 24)).toMatchObject({fill: NORMAL});
 const p24 = await point(page, 24);
 await page.mouse.click(p24.x, p24.y);
 await expect.poll(async () => (await style(page, 24))?.fill).toBe(HIGHLIGHT);
 await expect(page.getByTestId('object-inspector')).toBeVisible();
 const p26 = await point(page, 26);
 await page.mouse.click(p26.x, p26.y);
 await expect.poll(async () => (await style(page, 26))?.fill).toBe(HIGHLIGHT);
 await expect.poll(async () => (await style(page, 24))?.fill).toBe(NORMAL);
 await expect(page.getByTestId('object-inspector')).toContainText('Q026');
 const box = (await page.getByTestId('map-canvas').boundingBox())!;
 await page.mouse.click(box.x + 20, box.y + box.height - 20);
 await expect.poll(async () => (await style(page, 26))?.fill).toBe(NORMAL);
 await expect(page.getByTestId('object-inspector')).toHaveCount(0);
});

test('拖动后仍保持高亮、坐标已保存且不回弹', async ({page}) => {
 await boot(page);
 const p = await point(page, 30);
 await page.mouse.click(p.x, p.y);
 await expect.poll(async () => (await style(page, 30))?.fill).toBe(HIGHLIGHT);
 const before = { ...current.find(t => t.id === 30) };
 const from = await point(page, 30);
 await page.mouse.move(from.x, from.y);
 await page.mouse.down();
 for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + 60 * i / 8, from.y - 40 * i / 8);
 await page.mouse.up();
 await expect.poll(() => current.find(t => t.id === 30).x - before.x, {timeout: 8000}).toBeGreaterThan(0.05);
 await expect.poll(async () => (await style(page, 30))?.fill).toBe(HIGHLIGHT);
 expect(writes.some(w => w.method === 'POST' && w.path === '/api/maps')).toBe(true);
});

test('路径编辑里点/拖二维码：有高亮、有属性浮窗、能移动并保存', async ({page}) => {
 await boot(page);
 // 用户实际场景：进入「路径编辑」后仍然要点位编辑。
 await enterEditor(page);
 await expect(page.getByTestId('route-editor')).toBeVisible();
 const p24 = await point(page, 24);
 await page.mouse.click(p24.x, p24.y);
 await expect(page.getByTestId('object-inspector')).toBeVisible();
 await expect(page.getByTestId('object-inspector')).toContainText('Q024');
 await expect.poll(async () => (await style(page, 24))?.fill).toBe(HIGHLIGHT);
 await expect(page.getByTestId('route-inspector')).toHaveCount(0);
 const before = { ...current.find(t => t.id === 24) };
 const from = await point(page, 24);
 await page.mouse.move(from.x, from.y);
 await page.mouse.down();
 for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + 60 * i / 8, from.y - 40 * i / 8);
 await page.mouse.up();
 await expect.poll(() => current.find(t => t.id === 24).x - before.x, {timeout: 8000}).toBeGreaterThan(0.05);
 await expect.poll(async () => (await style(page, 24))?.fill).toBe(HIGHLIGHT);
 // 框选多个码：全部高亮（而不是只高亮第一个）
 const a = await point(page, 26), b = await point(page, 30);
 await page.mouse.move(Math.min(a.x, b.x) - 30, Math.min(a.y, b.y) - 30);
 await page.mouse.down();
 for (let i = 1; i <= 8; i++) await page.mouse.move((Math.min(a.x, b.x) - 30) + (Math.max(a.x, b.x) - Math.min(a.x, b.x) + 60) * i / 8, (Math.min(a.y, b.y) - 30) + (Math.max(a.y, b.y) - Math.min(a.y, b.y) + 60) * i / 8);
 await page.mouse.up();
 const selected = await page.locator('[data-testid="map-canvas"]').getAttribute('data-canvas-selected');
 const ids = (selected ?? '').split(',').filter(Boolean).map(Number);
 expect(ids.length).toBeGreaterThanOrEqual(2);
 for (const id of ids) await expect.poll(async () => (await style(page, id))?.fill).toBe(HIGHLIGHT);
});
