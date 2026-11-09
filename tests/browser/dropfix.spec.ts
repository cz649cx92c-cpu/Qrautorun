import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FieldMap} from '../../web/shared/model';

/**
 * 拖入落点精度 + 不闪「只读」标：
 *  - 放大/平移后拖入，保存的世界坐标必须等于指针所在的世界坐标（≤2 mm）；
 *  - 渲染出来的点位屏幕位置必须落在松手点附近（≤6 px），不能因布局重排整体位移；
 *  - 保存期间不出现黄色「只读」标（route-tools-locked）。
 */
test.describe.configure({mode:'serial'});
test.use({viewport:{width:1440,height:900}});

const snap = JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json', import.meta.url), 'utf8')) as {map: FieldMap};
const mapId = 'regress-dropfix-map';
let current: any[] = [];
let writes: any[] = [];

async function boot(page: Page, running = false) {
 current = [];
 writes = [];
 const robotStatus = {connected: true, state: running ? 'NAVIGATING' : 'IDLE', running, paused: false, pose: null, chassis: {connected: true}, sensors: {}, conditions: [], detector: {connected: true, ids: [], groups: [], positionReady: false, reason: ''}, mapping: {ready: true}, events: [], trail: []};
 await page.routeWebSocket('**/ws', ws => ws.send(JSON.stringify({type: 'robot', status: robotStatus})));
 await page.route('**/api/**', async route => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const method = req.method();
  const body = req.postData() ? JSON.parse(req.postData()!) : null;
  const json = (value: any) => route.fulfill({status: 200, json: value});
  if (method !== 'GET') writes.push({method, path, body, at: Date.now()});
  if (path === '/api/camera/status') return json({running: true, present: true, frameAgeMs: 10, error: ''});
  if (path === '/api/robot/status') return json(robotStatus);
  if (path === '/api/localization/map') return json({anchored: true, mapId});
  if (path === '/api/localization/scope') return json({phase: 'anchored'});
  if (path === '/api/maps' && method === 'GET') return json([{id: mapId, name: 'drop map', version: 1}]);
  if (path === '/api/maps/' + mapId && method === 'GET') return json({map: {...snap.map, id: mapId, name: 'drop map', routeMode: 'map-only', rows: [], motionSegments: undefined, order: [], groups: [], tags: current, zone: [{x: 0, y: 0}, {x: 5, y: 0}, {x: 5, y: 4}, {x: 0, y: 4}]}, version: 1, acceptance: null});
  if (path === '/api/maps' && method === 'POST') {
   current = body.map.tags.map((t: any) => ({...t}));
   // 模拟真实后端保存耗时：让「保存中」这个状态真实存在
   await new Promise(resolve => setTimeout(resolve, 400));
   return json({map: body.map, version: 1, acceptance: null});
  }
  if (path.endsWith('/tags/update') && method === 'POST') { for (const e of body.edits ?? []) current = current.map(t => t.id === e.id ? {...t, ...e} : t); return json({map: {...snap.map, id: mapId, routeMode: 'map-only', rows: [], order: [], groups: [], tags: current, zone: []}, version: 1}); }
  if (['/api/surveys', '/api/tasks', '/api/routes', '/api/boards', '/api/camera/calibration'].includes(path)) return json([]);
  if (path.endsWith('/tag-aliases')) return json({aliases: []});
  if (method !== 'GET') return json({ok: true});
  return json({});
 });
 await page.goto('/');
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(mapId);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 if (!(await page.getByTestId('palette-single').isVisible().catch(() => false))) await page.getByTestId('route-tools-group-toggle-tags').click();
 await expect(page.getByTestId('palette-single')).toBeVisible();
 await page.getByLabel('适应地图').click();
 await page.waitForTimeout(300);
}

async function drop(page: Page, tx: number, ty: number) {
 const item = (await page.getByTestId('palette-single').boundingBox())!;
 const sx = item.x + item.width / 2, sy = item.y + item.height / 2;
 await page.mouse.move(sx, sy);
 await page.mouse.down();
 for (let i = 1; i <= 14; i++) await page.mouse.move(sx + (tx - sx) * i / 14, sy + (ty - sy) * i / 14);
 await page.mouse.up();
}

test('放大后拖入：保存坐标=指针世界坐标，渲染位置贴着松手点', async ({page}) => {
 await boot(page);
 await page.getByLabel('放大地图').click();
 await page.getByLabel('放大地图').click();
 await page.waitForTimeout(250);
 const box = (await page.getByTestId('map-canvas').boundingBox())!;
 const target = {x: box.x + box.width * 0.58, y: box.y + box.height * 0.46};
 const expected = await page.evaluate(({x, y}) => (window as any).__mapCanvasApi.clientToWorld(x, y), target);
 await drop(page, target.x, target.y);
 await expect.poll(() => current.length, {timeout: 10000}).toBe(1);
 expect(Math.abs(current[0].x - expected.x)).toBeLessThanOrEqual(0.002);
 expect(Math.abs(current[0].y - expected.y)).toBeLessThanOrEqual(0.002);
 await expect.poll(async () => !!(await page.evaluate((id) => (window as any).__mapCanvasApi.screenOfTag(id), current[0].id)), {timeout: 8000}).toBe(true);
 const rendered = await page.evaluate((id) => (window as any).__mapCanvasApi.screenOfTag(id), current[0].id);
 expect(Math.hypot(rendered.x - target.x, rendered.y - target.y)).toBeLessThanOrEqual(6);
});

test('平移+缩小后拖入：仍然贴着松手点', async ({page}) => {
 await boot(page);
 await page.getByLabel('缩小地图').click();
 await page.waitForTimeout(200);
 const box = (await page.getByTestId('map-canvas').boundingBox())!;
 const target = {x: box.x + box.width * 0.34, y: box.y + box.height * 0.62};
 const expected = await page.evaluate(({x, y}) => (window as any).__mapCanvasApi.clientToWorld(x, y), target);
 await drop(page, target.x, target.y);
 await expect.poll(() => current.length, {timeout: 10000}).toBe(1);
 expect(Math.abs(current[0].x - expected.x)).toBeLessThanOrEqual(0.002);
 expect(Math.abs(current[0].y - expected.y)).toBeLessThanOrEqual(0.002);
 await expect.poll(async () => !!(await page.evaluate((id) => (window as any).__mapCanvasApi.screenOfTag(id), current[0].id)), {timeout: 8000}).toBe(true);
 const rendered = await page.evaluate((id) => (window as any).__mapCanvasApi.screenOfTag(id), current[0].id);
 expect(Math.hypot(rendered.x - target.x, rendered.y - target.y)).toBeLessThanOrEqual(6);
});

test('连续拖入 3 个点：每个都贴着自己的落点，不累积漂移', async ({page}) => {
 await boot(page);
 await page.getByLabel('放大地图').click();
 await page.waitForTimeout(200);
 const box = (await page.getByTestId('map-canvas').boundingBox())!;
 const targets = [
  {x: box.x + box.width * 0.30, y: box.y + box.height * 0.30},
  {x: box.x + box.width * 0.55, y: box.y + box.height * 0.50},
  {x: box.x + box.width * 0.75, y: box.y + box.height * 0.70},
 ];
 const expected: {x: number; y: number}[] = [];
 for (const target of targets) {
  expected.push(await page.evaluate(({x, y}) => (window as any).__mapCanvasApi.clientToWorld(x, y), target));
  const before = current.length;
  await drop(page, target.x, target.y);
  await expect.poll(() => current.length, {timeout: 10000}).toBe(before + 1);
  await page.waitForTimeout(250);
 }
 for (let i = 0; i < targets.length; i++) {
  expect(Math.abs(current[i].x - expected[i]!.x)).toBeLessThanOrEqual(0.002);
  expect(Math.abs(current[i].y - expected[i]!.y)).toBeLessThanOrEqual(0.002);
  await expect.poll(async () => !!(await page.evaluate((id) => (window as any).__mapCanvasApi.screenOfTag(id), current[i].id)), {timeout: 8000}).toBe(true);
  const rendered = await page.evaluate((id) => (window as any).__mapCanvasApi.screenOfTag(id), current[i].id);
  expect(Math.hypot(rendered.x - targets[i]!.x, rendered.y - targets[i]!.y)).toBeLessThanOrEqual(6);
 }
});

test('保存过程中不出现黄色「只读」标', async ({page}) => {
 await boot(page);
 const box = (await page.getByTestId('map-canvas').boundingBox())!;
 const target = {x: box.x + box.width * 0.5, y: box.y + box.height * 0.5};
 const seen: {visible: boolean; text: string; at: number}[] = [];
 let stop = false;
 const poll = (async () => {
  while (!stop) {
   const badge = page.getByTestId('route-tools-locked');
   const visible = await badge.isVisible().catch(() => false);
   if (visible) seen.push({visible, text: (await badge.innerText().catch(() => '')).trim(), at: Date.now()});
   await page.waitForTimeout(40);
  }
 })();
 await drop(page, target.x, target.y);
 await expect.poll(() => current.length, {timeout: 10000}).toBe(1);
 await page.waitForTimeout(1200);
 stop = true;
 await poll;
 expect(writes.some(w => w.method === 'POST' && w.path === '/api/maps')).toBe(true);
 expect(seen).toEqual([]);
});

test('机器人运行中（真实只读）仍然显示只读标', async ({page}) => {
 // 运行时产品会禁用选图，所以先用 IDLE 进编辑器，再推一条 running=true 的遥测。
 current = []; writes = [];
 const idle = {connected: true, state: 'IDLE', running: false, paused: false, pose: null, chassis: {connected: true}, sensors: {}, conditions: [], detector: {connected: true, ids: [], groups: [], positionReady: false, reason: ''}, mapping: {ready: true}, events: [], trail: []};
 let wsRoute: any = null;
 await page.routeWebSocket('**/ws', ws => { wsRoute = ws; ws.send(JSON.stringify({type: 'robot', status: idle})); });
 await page.route('**/api/**', async route => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const json = (value: any) => route.fulfill({status: 200, json: value});
  if (path === '/api/camera/status') return json({running: true, present: true, frameAgeMs: 10, error: ''});
  if (path === '/api/robot/status') return json(idle);
  if (path === '/api/localization/map') return json({anchored: true, mapId});
  if (path === '/api/localization/scope') return json({phase: 'anchored'});
  if (path === '/api/maps' && req.method() === 'GET') return json([{id: mapId, name: 'drop map', version: 1}]);
  if (path === '/api/maps/' + mapId && req.method() === 'GET') return json({map: {...snap.map, id: mapId, name: 'drop map', routeMode: 'map-only', rows: [], motionSegments: undefined, order: [], groups: [], tags: [], zone: [{x: 0, y: 0}, {x: 5, y: 0}, {x: 5, y: 4}, {x: 0, y: 4}]}, version: 1, acceptance: null});
  if (['/api/surveys', '/api/tasks', '/api/routes', '/api/boards', '/api/camera/calibration'].includes(path)) return json([]);
  if (path.endsWith('/tag-aliases')) return json({aliases: []});
  return json({});
 });
 await page.goto('/');
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(mapId);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await expect(page.getByTestId('route-tools-locked')).toHaveCount(0);
 expect(wsRoute).not.toBeNull();
 wsRoute.send(JSON.stringify({type: 'robot', status: {...idle, state: 'NAVIGATING', running: true}}));
 await expect(page.getByTestId('route-tools-locked')).toBeVisible();
 await expect(page.getByTestId('route-tools-locked')).toHaveText('只读');
});
