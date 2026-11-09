import {test,expect,type Page} from '@playwright/test';

/** 导航页现在是只读的：所有点位/规格/批量操作都要先进「路径编辑」。幂等。 */
async function enterEditor(page: import('@playwright/test').Page) {
 if (await page.getByTestId('route-editor').isVisible().catch(() => false)) return;
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await page.waitForTimeout(250);
}
import {readFileSync} from 'node:fs';
import type {FieldMap} from '../../web/shared/model';

/**
 * 框选批量条的三条真实要求：
 * 1) 停靠在右侧，不再压住地图中心；
 * 2) 不再有整段说明文字；
 * 3) 「批量改规格」：默认值=当前尺寸时点了不报错、不发请求；改了才提交，且只提交变化的 id。
 */
test.describe.configure({mode:'serial'});
test.use({viewport:{width:1440,height:900}});

const snap = JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json', import.meta.url), 'utf8')) as {map: FieldMap};
const mapId = 'regress-fix48-map';
let current: any[] = [];
let writes: any[] = [];
const baseTags = [
 {id:24,rowId:'',x:1.0,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:26,rowId:'',x:1.5,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:30,rowId:'',x:2.0,y:1.0,angle:0,size:.08,kind:'waypoint',rules:[]},
];

async function boot(page: Page) {
 current = baseTags.map(t => ({...t}));
 writes = [];
 await page.routeWebSocket('**/ws', ws => ws.send(JSON.stringify({type: 'robot', status: {connected: true, state: 'IDLE', running: false, paused: false, pose: null, chassis: {connected: true}, sensors: {}, conditions: [], detector: {connected: true, ids: [], groups: [], positionReady: false, reason: ''}, mapping: {ready: true}, events: [], trail: []}})));
 await page.route('**/api/**', async route => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const method = req.method();
  const body = req.postData() ? JSON.parse(req.postData()!) : null;
  const json = (value: any, status = 200) => route.fulfill({status, json: value});
  if (method !== 'GET') writes.push({method, path, body});
  if (path === '/api/camera/status') return json({running: true, present: true, frameAgeMs: 10, error: ''});
  if (path === '/api/robot/status') return json({connected: true, state: 'IDLE', running: false, paused: false, pose: null, chassis: {connected: true}, sensors: {}, conditions: [], detector: {connected: true, ids: [], groups: [], positionReady: false, reason: ''}, mapping: {ready: true}, events: [], trail: []});
  if (path === '/api/localization/map') return json({anchored: true, mapId});
  if (path === '/api/localization/scope') return json({phase: 'anchored'});
  if (path === '/api/maps' && method === 'GET') return json([{id: mapId, name: 'fix48', version: 1}]);
  if (path === '/api/maps/' + mapId && method === 'GET') return json({map: {...snap.map, id: mapId, name: 'fix48', routeMode: 'map-only', rows: [], motionSegments: undefined, order: [], groups: [], tags: current, zone: [{x: 0, y: 0}, {x: 4, y: 0}, {x: 4, y: 3}, {x: 0, y: 3}]}, version: 1, acceptance: null});
  if (path === '/api/maps' && method === 'POST') { current = body.map.tags.map((t: any) => ({...t})); return json({map: body.map, version: 1, acceptance: null}); }
  if (path.endsWith('/tags/update') && method === 'POST') {
   for (const e of body.edits ?? []) current = current.map(t => t.id === e.id ? {...t, ...e} : t);
   return json({map: {...snap.map, id: mapId, routeMode: 'map-only', rows: [], order: [], groups: [], tags: current, zone: []}, version: 1});
  }
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
 await page.waitForTimeout(350);
}

async function boxSelect(page: Page, ids: number[]) {
 const points: {x: number; y: number}[] = [];
 for (const id of ids) {
  const p = await page.evaluate((tagId) => (window as any).__mapCanvasApi?.screenOfTag(tagId), id);
  if (!p) throw new Error('screenOfTag null for ' + id);
  points.push(p);
 }
 const left = Math.min(...points.map(p => p.x)) - 30, right = Math.max(...points.map(p => p.x)) + 30;
 const top = Math.min(...points.map(p => p.y)) - 30, bottom = Math.max(...points.map(p => p.y)) + 30;
 await page.mouse.move(right, bottom);
 await page.mouse.down();
 for (let i = 1; i <= 10; i++) await page.mouse.move(right + (left - right) * i / 10, bottom + (top - bottom) * i / 10);
 await page.mouse.up();
 await expect(page.getByTestId('box-batch-bar')).toBeVisible();
}

test('批量条停靠右侧，不压住地图中心', async ({page}) => {
 await boot(page);
 await boxSelect(page, [24, 26]);
 const bar = await page.getByTestId('box-batch-bar').boundingBox();
 const canvas = (await page.getByTestId('map-canvas').boundingBox())!;
 expect(bar).not.toBeNull();
 // 右侧：左边缘在视口 60% 之后
 expect(bar!.x).toBeGreaterThan(1440 * 0.6);
 // 不压地图中心：画布中心点不在浮层内
 const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
 const covers = cx > bar!.x && cx < bar!.x + bar!.width && cy > bar!.y && cy < bar!.y + bar!.height;
 expect(covers).toBe(false);
 // 也不再顶在顶部居中
 expect(Math.abs((bar!.x + bar!.width / 2) - 720)).toBeGreaterThan(120);
 // 固定在画布右上角：贴画布上沿与右沿，且在顶部工具栏（保存/退出）下方，不遮挡它们
 expect(bar!.y).toBeLessThan(canvas.y + 40);
 expect(bar!.y).toBeGreaterThan(canvas.y);
 expect(bar!.x + bar!.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
 expect(bar!.x).toBeGreaterThan(canvas.x + canvas.width - 400);
 for (const id of ['route-save', 'route-exit']) {
  const btn = await page.getByTestId(id).boundingBox();
  if (!btn) continue;
  const overlaps = bar!.x < btn.x + btn.width && bar!.x + bar!.width > btn.x && bar!.y < btn.y + btn.height && bar!.y + bar!.height > btn.y;
  expect(overlaps, id + ' 不能被批量条盖住').toBe(false);
 }
});

test('批量条不再有大段说明文字', async ({page}) => {
 await boot(page);
 await boxSelect(page, [24, 26]);
 const text = await page.getByTestId('box-batch-bar').innerText();
 for (const banned of ['服务端固定起点', '重排以选中点左上角为原点', '单行/单列用上面的', '二维阵列按横/纵向间距', '从最左一个开始，按这个间距重排']) {
  expect(text).not.toContain(banned);
 }
 expect(text).toContain('已选 2');
});

test('默认规格=当前尺寸时，点“批量改规格”不报错也不发请求', async ({page}) => {
 await boot(page);
 await boxSelect(page, [24, 26]);
 // 24/26 都是 60 mm：默认值应当自动等于 60
 await expect(page.getByTestId('box-batch-size')).toHaveValue('60');
 const before = writes.length;
 await page.getByTestId('box-batch-size').blur();
 await page.getByTestId('box-batch-apply-size').click();
 await page.waitForTimeout(600);
 expect(writes.slice(before).filter(w => w.path.endsWith('/tags/update'))).toEqual([]);
 // 提示语可见（不是 400 报错）
 const bodyText = await page.locator('body').innerText();
 expect(bodyText).toContain('无需修改');
 expect(bodyText).not.toContain('没有可保存的改动');
});

test('改到 80 mm 时只提交实际变化的 id，并写回', async ({page}) => {
 await boot(page);
 await boxSelect(page, [24, 26]);
 await page.getByTestId('box-batch-size').fill('80');
 await page.getByTestId('box-batch-size').blur();
 await page.getByTestId('box-batch-apply-size').click();
 await expect.poll(() => writes.filter(w => w.path.endsWith('/tags/update')).length, {timeout: 8000}).toBe(1);
 const sent = writes.filter(w => w.path.endsWith('/tags/update')).at(-1)!;
 expect(sent.body.edits.map((e: any) => e.id).sort((a: number, b: number) => a - b)).toEqual([24, 26]);
 for (const id of [24, 26]) expect(current.find(t => t.id === id).size).toBeCloseTo(0.08, 6);
});

test('混合尺寸：只提交需要改的那一个，不误改已经是目标尺寸的点', async ({page}) => {
 await boot(page);
 await boxSelect(page, [24, 26, 30]);
 // 30 是 80 mm，24/26 是 60 mm；把目标设成 80 → 只应改 24 和 26
 await expect(page.getByTestId('box-batch-size')).toHaveValue('60');
 await page.getByTestId('box-batch-size').fill('80');
 await page.getByTestId('box-batch-size').blur();
 await page.getByTestId('box-batch-apply-size').click();
 await expect.poll(() => writes.filter(w => w.path.endsWith('/tags/update')).length, {timeout: 8000}).toBe(1);
 const sent = writes.filter(w => w.path.endsWith('/tags/update')).at(-1)!;
 expect(sent.body.edits.map((e: any) => e.id).sort((a: number, b: number) => a - b)).toEqual([24, 26]);
 const untouched = writes.filter(w => w.path.endsWith('/tags/update')).flatMap((w: any) => w.body.edits.map((e: any) => e.id));
 expect(untouched).not.toContain(30);
});
