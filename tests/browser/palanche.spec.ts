import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {FieldMap} from '../../web/shared/model';
const snap=JSON.parse(readFileSync(new URL('./fixtures/office-route-ui2.snapshot.json',import.meta.url),'utf8')) as {map:FieldMap};

/**
 * 素材库拖入与路径编辑批量条的真实回归：
 * - 单点/阵列/直线拖入画布后，新建点的坐标必须与落点一致（阵列以落点为中心，直线从画布内进入点起）；
 * - 拖入后对象浮窗可见，能改尺寸/行列参数并真的写回；
 * - 路径编辑里框选多个码能出现批量条，并且批量操作只作用于选中集合。
 */
test.describe.configure({mode:'serial'});
test.use({viewport:{width:1440,height:900}});

const mapId = 'regress-palanche-map';
let current: any[] = [];
let currentGroups: any[] = [];
let writes: any[] = [];

const baseTags = [
 {id:24,rowId:'',x:1.0,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:26,rowId:'',x:1.5,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
 {id:30,rowId:'',x:2.0,y:1.0,angle:0,size:.06,kind:'waypoint',rules:[]},
];

async function boot(page: Page, tags: any[]) {
 current = tags.map(t => ({...t}));
 currentGroups = [];
 writes = [];
 const pageErrors: string[]=[];
 page.on('pageerror', e=>pageErrors.push(String(e.message)));
 (page as any).__pageErrors=pageErrors;
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
  if (path === '/api/maps' && method === 'GET') return json([{id: mapId, name: 'palette map', version: 1}]);
  if (path === '/api/maps/' + mapId && method === 'GET') return json({map: {...snap.map, id: mapId, name: 'palette map', routeMode: 'map-only', rows: [], motionSegments: undefined, order: [], groups: currentGroups, tags: current, zone: [{x: 0, y: 0}, {x: 4, y: 0}, {x: 4, y: 3}, {x: 0, y: 3}]}, version: 1, acceptance: null});
  if (path === '/api/maps' && method === 'POST') { current = body.map.tags.map((t: any) => ({...t})); return json({map: body.map, version: 1, acceptance: null}); }
  if (path.endsWith('/tags/update') && method === 'POST') { for (const e of body.edits ?? []) current = current.map(t => t.id === e.id ? {...t, ...e} : t); return json({map: {id: mapId, routeMode: 'map-only', rows: [], order: [], groups: [], tags: current, zone: []}, version: 1}); }
  if (path.endsWith('/tags/align') && method === 'POST') {
   const ids: number[] = body.ids ?? []; const picked = current.filter(t => ids.includes(t.id));
   if (picked.length) { const axis = body.mode === 'top' || body.mode === 'bottom' ? 'y' : 'x'; const v = picked[0][axis]; current = current.map(t => ids.includes(t.id) ? {...t, [axis]: v} : t); }
   return json({map: {id: mapId, routeMode: 'map-only', rows: [], order: [], groups: [], tags: current, zone: []}, version: 1});
  }
  if (path.endsWith('/tags') && method === 'DELETE') { const ids = new Set<number>(body.ids ?? []); current = current.filter(t => !ids.has(t.id)); return json({map: {id: mapId, routeMode: 'map-only', rows: [], order: [], groups: [], tags: current, zone: []}, version: 1}); }
  if (['/api/surveys', '/api/tasks', '/api/routes', '/api/boards', '/api/camera/calibration'].includes(path)) return json([]);
  if (path.endsWith('/tag-aliases')) return json({aliases: []});
  if (method !== 'GET') return json({ok: true});
  return json({});
 });
 await page.goto('/');
 await page.getByTitle('开始导航').click();
 await page.getByTestId('map-select').selectOption(mapId);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 // 素材库（点位与铺码）只在编辑器左栏里，必须先进入路径编辑。
 await page.getByTestId('nav-route-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 // 「点位与铺码」分组默认收起，素材库在它里面；先展开再拖。
 const tagsToggle=page.getByTestId('route-tools-group-toggle-tags');
 if(await tagsToggle.count()){
  if(!(await page.getByTestId('palette-single').isVisible().catch(()=>false)))await tagsToggle.click();
 }
 await expect(page.getByTestId('palette-single')).toBeVisible();
 await page.getByLabel('适应地图').click();
 await page.waitForTimeout(300);
}

async function canvasBox(page: Page) {
 const box = await page.getByTestId('map-canvas').boundingBox();
 if (!box) throw new Error('canvas box missing');
 return box;
}

function segmentEntry(box:{x:number;y:number;width:number;height:number}, from:{x:number;y:number}, to:{x:number;y:number}){
 const dx=to.x-from.x, dy=to.y-from.y;
 const ts:number[]=[];
 if(dx!==0){
  ts.push((box.x-from.x)/dx, (box.x+box.width-from.x)/dx);
 }
 if(dy!==0){
  ts.push((box.y-from.y)/dy, (box.y+box.height-from.y)/dy);
 }
 const inside=(t:number)=>t>=0&&t<=1&&from.x+dx*t>=box.x-0.5&&from.x+dx*t<=box.x+box.width+0.5&&from.y+dy*t>=box.y-0.5&&from.y+dy*t<=box.y+box.height+0.5;
 const t=Math.min(...ts.filter(inside));
 return {x:from.x+dx*t, y:from.y+dy*t};
}
async function clientToWorld(page: Page, x: number, y: number) {
 const value = await page.evaluate(({x, y}) => (window as any).__mapCanvasApi?.clientToWorld(x, y), {x, y});
 if (!value) throw new Error('clientToWorld missing');
 return value as {x: number; y: number};
}
async function paletteDrop(page: Page, testid: string, target: {x: number; y: number}) {
 const item = await page.getByTestId(testid).boundingBox();
 if (!item) throw new Error(testid + ' box missing');
 const sx = item.x + item.width / 2, sy = item.y + item.height / 2;
 await page.mouse.move(sx, sy);
 await page.mouse.down();
 for (let i = 1; i <= 14; i++) await page.mouse.move(sx + (target.x - sx) * i / 14, sy + (target.y - sy) * i / 14);
 await page.mouse.up();
}

test('单个加码：落点=新建点坐标，拖入后可改尺寸并写回', async ({page}) => {
 await boot(page, []);
 const box = await canvasBox(page);
 const target = {x: box.x + box.width * 0.5, y: box.y + box.height * 0.45};
 const expected = await clientToWorld(page, target.x, target.y);
 await paletteDrop(page, 'palette-single', target);
 await expect.poll(() => current.length, {timeout: 8000}).toBe(1);
 const tag = current[0];
 expect(Math.abs(tag.x - expected.x)).toBeLessThanOrEqual(0.02);
 expect(Math.abs(tag.y - expected.y)).toBeLessThanOrEqual(0.02);
 await expect(page.getByTestId('object-inspector')).toBeVisible();
 await expect(page.getByTestId('object-inspector')).toContainText('Q' + String(tag.id).padStart(3, '0'));
 await page.getByTestId('object-tag-size').fill('80');
 await page.getByTestId('object-tag-size').blur();
 await expect.poll(() => current.find(t => t.id === tag.id)?.size, {timeout: 8000}).toBeCloseTo(0.08, 6);
});

test('阵列加码：以落点为中心、生成 12 点，浮窗可改列数并重算', async ({page}) => {
 await boot(page, []);
 const box = await canvasBox(page);
 const target = {x: box.x + box.width * 0.5, y: box.y + box.height * 0.5};
 const expected = await clientToWorld(page, target.x, target.y);
 await paletteDrop(page, 'palette-array', target);
 await expect.poll(() => current.length, {timeout: 8000}).toBe(12);
 const xs = current.map(t => t.x), ys = current.map(t => t.y);
 const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
 const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
 expect(Math.abs(centerX - expected.x)).toBeLessThanOrEqual(0.05);
 expect(Math.abs(centerY - expected.y)).toBeLessThanOrEqual(0.05);
 await expect(page.getByTestId('object-grid-params')).toBeVisible();
 await page.getByTestId('object-grid-columns').fill('5');
 await page.getByTestId('object-grid-columns').blur();
 await expect.poll(() => current.length, {timeout: 8000}).toBe(15);
});

test('直线铺码：从画布内进入点起画，不再从画布外远处的素材库起点开始', async ({page}) => {
 await boot(page, []);
 const box = await canvasBox(page);
 const target = {x: box.x + box.width * 0.72, y: box.y + box.height * 0.35};
 const item = (await page.getByTestId('palette-line').boundingBox())!;
 const start = {x: item.x + item.width / 2, y: item.y + item.height / 2};
 // 真实指针是离散采样：App 记录的是“第一个落在画布内的 move 采样点”，
 // 因此测试也按同样的 14 步采样算出期望入画点（而不是几何交点）。
 let entryScreen = segmentEntry(box, start, target);
 for(let i=1;i<=14;i++){
  const px=start.x+(target.x-start.x)*i/14, py=start.y+(target.y-start.y)*i/14;
  if(px>=box.x&&px<=box.x+box.width&&py>=box.y&&py<=box.y+box.height){entryScreen={x:px,y:py};break;}
 }
 const entry = await clientToWorld(page, entryScreen.x, entryScreen.y);
 await paletteDrop(page, 'palette-line', target);
 await expect.poll(() => current.length, {timeout: 8000}).toBeGreaterThanOrEqual(2);
 const first = [...current].sort((a, b) => Math.hypot(a.x - entry.x, a.y - entry.y) - Math.hypot(b.x - entry.x, b.y - entry.y))[0];
 expect(Math.hypot(first.x - entry.x, first.y - entry.y)).toBeLessThanOrEqual(0.1);
 const axisX = current.every(t => Math.abs(t.y - current[0].y) < 1e-6);
 const axisY = current.every(t => Math.abs(t.x - current[0].x) < 1e-6);
 expect(axisX || axisY).toBe(true);
 await expect(page.getByTestId('object-line-params')).toBeVisible();
});

test('路径编辑里框选多个码：批量条出现且只作用于选中集合', async ({page}) => {
 await boot(page, baseTags);
 await page.waitForTimeout(200);
 const a = await page.evaluate((id) => (window as any).__mapCanvasApi?.screenOfTag(id), 24);
 const b = await page.evaluate((id) => (window as any).__mapCanvasApi?.screenOfTag(id), 30);
 if (!a || !b) throw new Error('screenOfTag null');
 await page.mouse.move(Math.min(a.x, b.x) - 30, Math.min(a.y, b.y) - 30);
 await page.mouse.down();
 for (let i = 1; i <= 10; i++) await page.mouse.move(Math.min(a.x, b.x) - 30 + (Math.max(a.x, b.x) - Math.min(a.x, b.x) + 60) * i / 10, Math.min(a.y, b.y) - 30 + 60 * i / 10);
 await page.mouse.up();
 await expect(page.getByTestId('box-batch-bar')).toBeVisible();
 await expect(page.getByTestId('box-batch-bar')).toContainText('已选 3');
 const before = current.map(t => ({...t}));
 await page.getByTestId('box-batch-align-row').click();
 await expect.poll(() => writes.some(w => w.path.endsWith('/tags/align')), {timeout: 8000}).toBe(true);
 const alignWrite = writes.filter(w => w.path.endsWith('/tags/align')).at(-1)!;
 expect([...alignWrite.body.ids].sort((x: number, y: number) => x - y)).toEqual([24, 26, 30]);
 for (const tag of current) expect(tag.y).toBeCloseTo(current[0].y, 9);
 expect(before.find(t => t.id === 30)!.x).toBeCloseTo(current.find(t => t.id === 30)!.x, 9);
});

test('路径编辑里拖入单个加码：落点正确、对象浮窗可见、可改尺寸', async ({page}) => {
 await boot(page, []);
 await page.waitForTimeout(200);
 const box = await canvasBox(page);
 const target = {x: box.x + box.width * 0.55, y: box.y + box.height * 0.5};
 const expected = await clientToWorld(page, target.x, target.y);
 await paletteDrop(page, 'palette-single', target);
 await expect.poll(() => current.length, {timeout: 8000}).toBe(1);
 expect(Math.abs(current[0].x - expected.x)).toBeLessThanOrEqual(0.02);
 expect(Math.abs(current[0].y - expected.y)).toBeLessThanOrEqual(0.02);
 await expect(page.getByTestId('object-inspector')).toBeVisible();
 await page.getByTestId('object-tag-size').fill('90');
 await page.getByTestId('object-tag-size').blur();
 await expect.poll(() => current[0].size, {timeout: 8000}).toBeCloseTo(0.09, 6);
});
