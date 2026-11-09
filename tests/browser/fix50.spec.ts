import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FieldMap} from '../../web/shared/model';

/**
 * fix50 真实交互：
 * 1) 「开始导航」页只读：拖点不动、框选不出批量条、对象浮窗没有规格编辑块；
 * 2) 进路径编辑后同样的操作都能用；
 * 3) 批量条「定位组规格」卡在地图有定位组时就出现，勾「应用到全部」可一键改全部组。
 */
test.describe.configure({mode: 'serial'});
test.use({viewport: {width: 1440, height: 900}});

const snap = JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json', import.meta.url), 'utf8')) as {map: FieldMap};
const mapId = 'regress-fix50-map';
let current: any[] = [];
let groups: any[] = [];
let writes: any[] = [];

function makeGroups() {
 const mk = (ref: number) => ({
  id: 'B' + String(ref).padStart(3, '0'), referenceId: ref, gridSize: 2, sizeMm: 60, gapMm: 2,
  rows: 2, cols: 2, widthMm: 60, heightMm: 60,
  members: [0, 1, 2, 3].map(i => ({id: ref + i, x: 0, y: 0, angle: 0, size: 0.024})),
 });
 return [mk(0), mk(4)];
}

function makeTags() {
 const ids = [0, 1, 2, 3, 4, 5, 6, 7, 10];
 return ids.map((id, index) => ({
  id, rowId: '', x: 0.8 + (index % 3) * 0.4, y: 0.8 + Math.floor(index / 3) * 0.4,
  angle: 0, size: 0.06, kind: 'waypoint', rules: [],
  ...(id < 4 ? {groupId: 'B000'} : id < 8 ? {groupId: 'B004'} : {}),
 }));
}

async function boot(page: Page) {
 current = makeTags(); groups = makeGroups(); writes = [];
 await page.routeWebSocket('**/ws', ws => ws.send(JSON.stringify({type: 'robot', status: {connected: true, state: 'IDLE', running: false, paused: false, pose: null, chassis: {connected: true}, sensors: {}, conditions: [], detector: {connected: true, ids: [], groups: [], positionReady: false, reason: ''}, mapping: {ready: true}, events: [], trail: []}})));
 await page.route('**/api/**', async route => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const method = req.method();
  const body = req.postData() ? JSON.parse(req.postData()!) : null;
  const json = (v: any) => route.fulfill({status: 200, json: v});
  if (method !== 'GET') writes.push({method, path, body});
  if (path === '/api/camera/status') return json({running: true, present: true, frameAgeMs: 10, error: ''});
  if (path === '/api/robot/status') return json({connected: true, state: 'IDLE', running: false, paused: false, pose: null, chassis: {connected: true}, sensors: {}, conditions: [], detector: {connected: true, ids: [], groups: [], positionReady: false, reason: ''}, mapping: {ready: true}, events: [], trail: []});
  if (path === '/api/localization/map') return json({anchored: true, mapId});
  if (path === '/api/localization/scope') return json({phase: 'anchored'});
  if (path === '/api/maps' && method === 'GET') return json([{id: mapId, name: 'fix50', version: 1}]);
  if (path === '/api/maps/' + mapId && method === 'GET') return json({map: {...snap.map, id: mapId, name: 'fix50', routeMode: 'map-only', rows: [], motionSegments: undefined, order: [], groups, tags: current, zone: [{x: 0, y: 0}, {x: 4, y: 0}, {x: 4, y: 3}, {x: 0, y: 3}]}, version: 1, acceptance: null});
  if (path === '/api/maps' && method === 'POST') { current = body.map.tags.map((t: any) => ({...t})); return json({map: body.map, version: 1, acceptance: null}); }
  if (path.endsWith('/tags/update') && method === 'POST') {
   for (const e of body.edits ?? []) current = current.map(t => t.id === e.id ? {...t, ...e} : t);
   return json({map: {...snap.map, id: mapId, routeMode: 'map-only', rows: [], order: [], groups, tags: current, zone: []}, version: 1});
  }
  if (path.endsWith('/groups/spec-batch') && method === 'POST') {
   const rows = body.rows, cols = body.cols;
   const targetIds: string[] = body.groupIds ?? groups.map(g => g.id);
   groups = groups.map(g => targetIds.includes(g.id) ? {...g, rows, cols, gridSize: Math.max(rows, cols), members: Array.from({length: rows * cols}, (_, i) => ({id: g.referenceId + i, x: 0, y: 0, angle: 0, size: 0.024}))} : g);
   return json({map: {...snap.map, id: mapId, routeMode: 'map-only', rows: [], order: [], groups, tags: current, zone: []}, version: 1, changed: targetIds.length});
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
 await page.getByLabel('适应地图').click();
 await page.waitForTimeout(300);
}

/** 真正会改地图的写请求（加载时那条 /localization/map 不算）。 */
function mapWrites() {
 return writes.filter(w => w.method === 'POST' && (w.path === '/api/maps' || w.path.includes('/tags/') || w.path.includes('/groups/')));
}

async function tagPoint(page: Page, id: number) {
 return page.evaluate((tagId) => (window as any).__mapCanvasApi?.screenOfTag(tagId), id);
}

async function dragTag(page: Page, id: number, dx: number, dy: number) {
 const p = await tagPoint(page, id);
 expect(p).not.toBeNull();
 await page.mouse.move(p.x, p.y);
 await page.mouse.down();
 for (let i = 1; i <= 8; i++) await page.mouse.move(p.x + dx * i / 8, p.y + dy * i / 8);
 await page.mouse.up();
 await page.waitForTimeout(400);
}

async function boxSelect(page: Page, ids: number[]) {
 const points: any[] = [];
 for (const id of ids) points.push(await tagPoint(page, id));
 const left = Math.min(...points.map(p => p.x)) - 25;
 const right = Math.max(...points.map(p => p.x)) + 25;
 const top = Math.min(...points.map(p => p.y)) - 25;
 const bottom = Math.max(...points.map(p => p.y)) + 25;
 await page.mouse.move(right, bottom);
 await page.mouse.down();
 for (let i = 1; i <= 8; i++) await page.mouse.move(right + (left - right) * i / 8, bottom + (top - bottom) * i / 8);
 await page.mouse.up();
 await page.waitForTimeout(300);
}

test('开始导航：拖点不落库、框选不出批量条、浮窗不显示规格编辑', async ({page}) => {
 await boot(page);
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-canvas-editable', '0');
 const before = current.find(t => t.id === 10);
 await dragTag(page, 10, 60, 40);
 expect(mapWrites()).toEqual([]);
 expect(current.find(t => t.id === 10)).toEqual(before);

 await boxSelect(page, [10, 0]);
 await expect(page.getByTestId('box-batch-bar')).toHaveCount(0);

 const point = await tagPoint(page, 10);
 await page.mouse.click(point.x, point.y);
 await expect(page.getByTestId('object-inspector')).toBeVisible();
 await expect(page.getByTestId('object-tag-spec')).toHaveCount(0);
 await expect(page.getByTestId('object-x')).toBeDisabled();
});

test('进路径编辑后：拖点、框选、批量条都恢复', async ({page}) => {
 await boot(page);
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-canvas-editable', '1');
 const before = current.find(t => t.id === 10);
 await dragTag(page, 10, 60, 40);
 await expect.poll(() => mapWrites().length, {timeout: 8000}).toBeGreaterThan(0);
 // 拖动提交会走整图保存（POST /api/maps），也可能走 /tags/update；只要点位确实变了即可
 await expect.poll(() => current.find(t => t.id === 10).x, {timeout: 8000}).not.toBeCloseTo(before.x, 6);
 await boxSelect(page, [10, 0]);
 await expect(page.getByTestId('box-batch-bar')).toBeVisible();
});

test('工具栏里的「定位组 N×M」：勾全部可一键改所有定位组', async ({page}) => {
 await boot(page);
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 const spec = page.getByTestId('toolbar-group-spec');
 await expect(spec).toBeVisible();
 // 收起态只显示「定位组 3×3」；点开才展开行列/全部/批量改
 await expect(spec).toContainText('定位组');
 await page.getByTestId('toolbar-group-spec-toggle').click();
 await expect(page.getByTestId('toolbar-group-apply')).toBeVisible();
 // 默认只作用于“框选到的定位组中心”：没框选时按钮禁用
 await expect(page.getByTestId('toolbar-group-apply')).toBeDisabled();
 await page.getByTestId('toolbar-group-cols').selectOption('3');
 await page.getByTestId('toolbar-group-rows').selectOption('3');
 await page.getByTestId('toolbar-group-all').check();
 await expect(page.getByTestId('toolbar-group-apply')).toBeEnabled();
 await page.getByTestId('toolbar-group-apply').click();
 await expect.poll(() => writes.filter(w => w.path.endsWith('/groups/spec-batch')).length, {timeout: 8000}).toBe(1);
 const sent = writes.filter(w => w.path.endsWith('/groups/spec-batch')).at(-1)!;
 expect(sent.body.groupIds).toBeUndefined();
 expect(sent.body.rows).toBe(3);
 expect(sent.body.cols).toBe(3);
 expect(groups.every(g => g.rows === 3 && g.cols === 3 && g.members.length === 9)).toBe(true);
 // 批量条不再包含这张卡
 await boxSelect(page, [1, 2]);
 await expect(page.getByTestId('box-batch-bar')).toBeVisible();
 await expect(page.getByTestId('box-batch-group-spec')).toHaveCount(0);
});
