import {test,expect,type Page} from '@playwright/test';

/**
 * 二维码 PDF 页面（PdfGenerator）的矩形规格真实回归。
 * 只 mock 网络，交互全部走真实 DOM：改列/行/整组宽高，断言发出去的
 * /api/boards/plan 载荷与图纸预览尺寸都跟着变，旧方形控件仍然等价。
 */
test.describe.configure({mode:'serial'});
test.use({viewport:{width:1280,height:800}});

let plans: any[] = [];
let optionsCalls = 0;

const gridOption = (size: number) => ({gridSize: size, minGroupSizeMm: Math.max(20, Math.ceil(size * 12.5 + (size - 1) * 2)), maxGroupSizeMm: 500, minChildSizeMm: 10, minWidthMm: 20, minHeightMm: 20});

async function boot(page: Page) {
 plans = [];
 optionsCalls = 0;
 page.on('pageerror', e => { throw e; });
 await page.routeWebSocket('**/ws', ws => ws.send(JSON.stringify({type: 'robot', status: {connected: true, state: 'IDLE', running: false, paused: false, pose: null, chassis: {connected: true}, sensors: {}, conditions: [], detector: {connected: true, ids: [], groups: [], positionReady: false, reason: ''}, mapping: {ready: true}, events: [], trail: []}})));
 await page.route('**/api/**', async route => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const method = req.method();
  const body = req.postData() ? JSON.parse(req.postData()!) : null;
  const json = (value: any, status = 200) => route.fulfill({status, json: value});
  if (path === '/api/camera/status') return json({running: true, present: true, frameAgeMs: 10, error: ''});
  if (path === '/api/robot/status') return json({connected: true, state: 'IDLE', running: false, paused: false, pose: null, chassis: {connected: true}, sensors: {}, conditions: [], detector: {connected: true, ids: [], groups: [], positionReady: false, reason: ''}, mapping: {ready: true}, events: [], trail: []});
  if (path === '/api/localization/map') return json({anchored: false});
  if (path === '/api/localization/scope') return json({});
  if (path === '/api/boards/options') { optionsCalls++; return json({family: 'tag36h11', paper: 'A4', minId: 0, maxId: 586, grids: [1, 2, 3, 4, 5, 6].map(gridOption)}); }
  if (path === '/api/boards/plan' && method === 'POST') {
   plans.push(body);
   const rows = Number(body.rows) || Number(body.gridSize) || 2;
   const cols = Number(body.cols) || Number(body.gridSize) || 2;
   const widthMm = Number(body.widthMm) || Number(body.groupSizeMm) || 60;
   const heightMm = Number(body.heightMm) || Number(body.groupSizeMm) || 60;
   const tileW = (widthMm - (cols - 1) * 2) / cols;
   const tileH = (heightMm - (rows - 1) * 2) / rows;
   const members = Array.from({length: rows * cols}, (_, i) => ({id: (body.startId || 0) + i, x: 0, y: 0, angle: 0, size: Math.min(tileW, tileH) / 1.25 / 1000}));
   const board = {id: 'B000', referenceId: body.startId || 0, gridSize: Math.max(rows, cols), sizeMm: Math.max(widthMm, heightMm), gapMm: 2, rows, cols, widthMm, heightMm, members};
   return json({groupCount: body.groupCount, memberCount: rows * cols * body.groupCount, pages: body.groupCount, childSizeMm: Math.min(tileW, tileH) / 1.25, minGroupSizeMm: 20, maxGroupSizeMm: 500, rows, cols, widthMm, heightMm, boards: [board], filename: `apriltag-boards-${rows}x${cols}-${widthMm}x${heightMm}mm.pdf`, centerCrosshairAvailable: true});
  }
  if (path === '/api/boards/preview.svg') return route.fulfill({status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm"/>'});
  if (['/api/maps', '/api/surveys', '/api/tasks', '/api/routes', '/api/boards'].includes(path)) return json([]);
  return json({});
 });
 await page.goto('/');
 await page.getByTitle('二维码 PDF').click();
 await expect(page.getByTestId('pdf-cols')).toBeVisible();
 await expect.poll(() => optionsCalls).toBeGreaterThan(0);
}

async function fill(page: Page, id: string, value: string) {
 const input = page.getByTestId(id);
 await input.fill(value);
 await input.blur();
}

test('矩形 2×3 / 120×80 发出真实 rows/cols/width/height 并驱动预览', async ({page}) => {
 await boot(page);
 await fill(page, 'pdf-cols', '3');
 await fill(page, 'pdf-rows', '2');
 await fill(page, 'pdf-width', '120');
 await fill(page, 'pdf-height', '80');
 await expect.poll(() => plans.filter(p => p.rows === 2 && p.cols === 3 && p.widthMm === 120 && p.heightMm === 80).length, {timeout: 8000}).toBeGreaterThan(0);
 const sent = plans.filter(p => p.rows === 2 && p.cols === 3 && p.widthMm === 120 && p.heightMm === 80).at(-1)!;
 expect(sent.gridSize).toBe(3);
 expect(sent.groupSizeMm).toBe(120);
 await expect(page.locator('.preview-toolbar')).toContainText('2 × 3 · 120 × 80 mm');
 await expect(page.locator('.board-preview img')).toHaveAttribute('src', /rows=2.*cols=3|cols=3.*rows=2/);
 await expect(page.locator('.board-preview img')).toHaveAttribute('src', /widthMm=120/);
 await expect(page.locator('.board-preview img')).toHaveAttribute('src', /heightMm=80/);
 await expect(page.locator('.pdf-summary')).toContainText('30.93');
});

test('1×N 与 N×1 合法', async ({page}) => {
 await boot(page);
 await fill(page, 'pdf-cols', '3');
 await fill(page, 'pdf-rows', '1');
 await fill(page, 'pdf-width', '120');
 await fill(page, 'pdf-height', '40');
 await expect.poll(() => plans.filter(p => p.rows === 1 && p.cols === 3 && p.widthMm === 120 && p.heightMm === 40).length, {timeout: 8000}).toBeGreaterThan(0);
 await fill(page, 'pdf-cols', '1');
 await fill(page, 'pdf-rows', '3');
 await fill(page, 'pdf-width', '40');
 await fill(page, 'pdf-height', '120');
 await expect.poll(() => plans.filter(p => p.rows === 3 && p.cols === 1 && p.widthMm === 40 && p.heightMm === 120).length, {timeout: 8000}).toBeGreaterThan(0);
 const sent = plans.filter(p => p.rows === 3 && p.cols === 1).at(-1)!;
 expect(sent.gridSize).toBe(3);
 expect(sent.groupSizeMm).toBe(120);
});

test('旧方形控件仍等价：2×2 + 整组 60', async ({page}) => {
 await boot(page);
 await page.getByRole('button', {name: '2 × 2'}).click();
 const sizeInput = page.locator('.pdf-controls label', {hasText: '整组尺寸'}).locator('input');
 await sizeInput.fill('60');
 await sizeInput.blur();
 await expect.poll(() => plans.filter(p => p.rows === 2 && p.cols === 2 && p.widthMm === 60 && p.heightMm === 60).length, {timeout: 8000}).toBeGreaterThan(0);
 await expect(page.locator('.preview-toolbar')).toContainText('2 × 2 · 60 × 60 mm');
});

test('非法整组宽在前端拦截，不发 plan 请求', async ({page}) => {
 await boot(page);
 await fill(page, 'pdf-cols', '2');
 await fill(page, 'pdf-rows', '2');
 await fill(page, 'pdf-width', '120');
 await fill(page, 'pdf-height', '120');
 await expect.poll(() => plans.length, {timeout: 8000}).toBeGreaterThan(0);
 const before = plans.length;
 await fill(page, 'pdf-width', '10');
 await expect(page.locator('.pdf-error')).toContainText('20–500');
 await page.waitForTimeout(400);
 expect(plans.length).toBe(before);
});
