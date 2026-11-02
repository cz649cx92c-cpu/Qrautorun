import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'real-map-route.snapshot.json'), 'utf8'));
const MAP = snap.map, MAP_ID: string = snap.mapId, VERSION: number = snap.mapVersion;
const ROUTE = snap.route, ROUTE_ID: string = snap.routeId;

const SHOTS = 'logs/final-shots';
mkdirSync(SHOTS, { recursive: true });

const viewports = [
  { width: 1910, height: 925, tag: '1910' },
  { width: 1440, height: 900, tag: '1440' },
  { width: 375, height: 812, tag: '375' },
];

/** 全 mutating API + WS 预拦截：任何写请求都记录并 mock，绝不触达生产。 */
async function boot(page: Page, tag: string) {
  const writes: Array<{ method: string; path: string }> = [];
  const wsUrls: string[] = [];
  page.on('websocket', ws => wsUrls.push(ws.url()));
  page.on('pageerror', e => { throw new Error(`pageerror[${tag}]: ${e}`); });

  await page.route('**/api/**', async r => {
    const req = r.request();
    const p = new URL(req.url()).pathname;
    const m = req.method().toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
      writes.push({ method: m, path: p });
      return r.fulfill({ json: { ok: true, mocked: true } });
    }
    if (p === '/api/maps') return r.fulfill({ json: [{ id: MAP_ID, name: MAP.name, version: VERSION }] });
    if (p === `/api/maps/${MAP_ID}`) return r.fulfill({ json: { map: MAP, version: VERSION, acceptance: { kind: null, digestValid: false, accepted: false } } });
    if (p === `/api/maps/${MAP_ID}/tag-aliases`) return r.fulfill({ json: { mapId: MAP_ID, mapVersion: VERSION, aliases: [], disclaimer: 'x' } });
    if (p === '/api/routes') return r.fulfill({ json: [ROUTE] });
    if (p === `/api/routes/${ROUTE_ID}`) return r.fulfill({ json: { ...ROUTE, route: ROUTE, map: MAP, version: VERSION, acceptance: { kind: null, digestValid: false, accepted: false } } });
    if (p === `/api/routes/${ROUTE_ID}/topology`) {
      const segs: any[] = ROUTE.motionSegments ?? [];
      const seen = new Map<string, number>();
      const edges = segs.map((s: any) => {
        const k = `${s.fromId}>${s.toId}`; const n = (seen.get(k) ?? 0) + 1; seen.set(k, n);
        return { fromId: s.fromId, toId: s.toId, occurrence: n, strategy: s.strategy ?? 'auto' };
      });
      const nodes = [...new Set(segs.flatMap((s: any) => [s.fromId, s.toId]))];
      return r.fulfill({ json: { routeId: ROUTE_ID, mapId: MAP_ID, mapVersion: VERSION, stored: false,
        topology: { nodes, edges }, summary: {}, issues: [],
        strategyChoices: { choices: [], issues: [] }, disclaimer: 'mock' } });
    }
    if (p === '/api/tasks') return r.fulfill({ json: [] });
    if (p === '/api/surveys' || p === '/api/boards') return r.fulfill({ json: [] });
    if (p === '/api/camera/status') return r.fulfill({ json: { running: false, present: false } });
    if (p.includes('/localization/')) return r.fulfill({ json: { phase: 'anchored' } });
    return r.fulfill({ json: {} });
  });

  // 兜底：任何非 GET 的 fetch/XHR 也拦下来（防 route 漏网）
  await page.addInitScript(() => {
    const orig = window.fetch;
    (window as any).__blockedWrites = [];
    window.fetch = (input: any, init?: any) => {
      const m = (init?.method ?? 'GET').toUpperCase();
      const u = typeof input === 'string' ? input : input?.url ?? '';
      if (m !== 'GET' && u.includes('/api/')) {
        (window as any).__blockedWrites.push(`${m} ${u}`);
        return Promise.resolve(new Response(JSON.stringify({ ok: true, mocked: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return orig(input, init);
    };
  });

  await page.goto('/');
  await page.waitForTimeout(900);
  await page.locator('.sidebar').getByRole('button', { name: '开始导航', exact: true }).click();
  await page.waitForTimeout(900);
  await page.getByTestId('map-select').selectOption(MAP_ID, { timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.getByTestId('route-select').selectOption(ROUTE_ID, { timeout: 20000 });
  await page.waitForTimeout(1400);
  return { writes, wsUrls };
}

const metrics = (page: Page) => page.evaluate(() => {
  const vis = (s: string) => {
    const e = document.querySelector(s);
    if (!e) return false;
    const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const stage = (window as any).__stage;
  const layer = stage?.getLayers?.()[0];
  const boxes: any[] = [];
  const push = (kind: string, node: any) => {
    if (!node.visible()) return;
    let bb: any; try { bb = node.getClientRect({ relativeTo: stage }); } catch { return; }
    const c = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
    const box = c.getBoundingClientRect();
    boxes.push({ kind, id: node.name(), x: box.x + bb.x, y: box.y + bb.y, w: bb.width, h: bb.height });
  };
  if (layer) {
    layer.getChildren().forEach((n: any) => {
      const nm = n.name() || '';
      if (nm.startsWith('tag-label-')) push('board', n);
      else if (nm.startsWith('segment-label-')) push('segment', n);
      else if (nm.startsWith('route-ordinal-')) push('ordinal', n);
      else if (nm.startsWith('tag-')) { const l = n.findOne('.tag-label-' + nm.slice(4)); if (l) push('board', l); }
    });
  }
  let collisions = 0; const pairs: string[] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!, b = boxes[j]!;
    const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ix > 1 && iy > 1) { collisions++; if (pairs.length < 6) pairs.push(`${a.id}|${b.id}`); }
  }
  const canvas = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
  const head = document.querySelector('[data-testid="route-steps-drag-handle"]') as HTMLElement | null;
  return {
    scale: Number(canvas?.dataset.konvaScale ?? '0'),
    topbarVisible: vis('.topbar'),
    editorBadge: document.querySelectorAll('.editor-mode-badge').length,
    panNote: document.querySelectorAll('[data-testid="editor-mode-pan-note"]').length,
    leftStepsBtn: document.querySelectorAll('[data-testid="route-panel-open-steps"], .route-steps-open-btn').length,
    triggers: document.querySelectorAll('[data-testid="route-steps-trigger"]').length,
    dockVisible: vis('[data-testid="route-steps-dock"]'),
    stepsHeadHeight: head ? Math.round(head.getBoundingClientRect().height) : -1,
    longCards: document.querySelectorAll('.route-segment-card, .route-step-detail-card').length,
    counts: {
      board: boxes.filter(b => b.kind === 'board').length,
      segment: boxes.filter(b => b.kind === 'segment').length,
      ordinal: boxes.filter(b => b.kind === 'ordinal').length,
    },
    collisions, pairs,
  };
});

for (const vp of viewports) {
  test(`新线上 bundle + 真实 12 段快照 @ ${vp.tag}：默认简洁/可展开/唯一入口/去重/无叠字`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const { writes, wsUrls } = await boot(page, vp.tag);

    // --- 导航视图（默认）---
    const nav = await metrics(page);
    await page.screenshot({ path: `${SHOTS}/${vp.tag}-01-navigate.png`, fullPage: false });
    console.log(`M_NAV_${vp.tag} ` + JSON.stringify(nav));

    // 顶部去重 + 左栏无重复步骤入口（导航态本就没有 steps trigger）
    expect(nav.topbarVisible, '导航页保留主标题（编辑态才隐藏）').toBe(true);
    expect(nav.leftStepsBtn, '左栏不得有重复步骤按钮').toBe(0);
    expect(nav.collisions, `导航视图可见标签必须零碰撞（${JSON.stringify(nav.pairs)}）`).toBe(0);
    expect(nav.counts.board, 'B 编号存在').toBeGreaterThan(0);

    // --- 进入路径编辑 ---
    await page.getByTestId('nav-route-edit').click({ timeout: 20000 });
    await page.waitForTimeout(2600);
    const edit = await metrics(page);
    await page.screenshot({ path: `${SHOTS}/${vp.tag}-02-edit.png`, fullPage: false });
    console.log(`M_EDIT_${vp.tag} ` + JSON.stringify(edit));

    expect(edit.topbarVisible, '编辑态不得有重复大标题').toBe(false);
    expect(edit.leftStepsBtn, '编辑态左栏不得有重复步骤按钮').toBe(0);
    expect(edit.triggers, '步骤入口必须唯一').toBeLessThanOrEqual(1);
    expect(edit.longCards, '默认不得常驻长详情卡').toBe(0);
    expect(edit.collisions, `编辑视图可见标签必须零碰撞（${JSON.stringify(edit.pairs)}）`).toBe(0);

    // --- 唯一入口可展开（38px 头 + 12 段数据）---
    await page.getByTestId('route-steps-trigger').click({ timeout: 10000 });
    await page.waitForTimeout(900);
    const open = await metrics(page);
    await page.screenshot({ path: `${SHOTS}/${vp.tag}-03-steps-open.png`, fullPage: false });
    console.log(`M_OPEN_${vp.tag} ` + JSON.stringify(open));
    expect(open.dockVisible, '步骤区可展开').toBe(true);
    expect(open.collisions, `展开步骤区后可见标签必须零碰撞（${JSON.stringify(open.pairs)}）`).toBe(0);
    expect(open.stepsHeadHeight, `步骤头应 38px（实际 ${open.stepsHeadHeight}）`).toBe(38);
    const rowCount = await page.locator('[data-testid="route-steps-dock"] tbody tr').count();
    const edgeCount = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="route-topology-edges"], .rt-edges');
      return el ? el.querySelectorAll('li').length : -1;
    });
    console.log(`M_ROWS_${vp.tag} ` + JSON.stringify({ rowCount, edgeCount }));
    expect(rowCount, '步骤表必须有真实行').toBeGreaterThan(1);

    // --- 低缩放 + 按需出现：必须在**导航视图**做 ---
    // 编辑视图的 canvasMap 有意丢弃 motionSegments（正交预览为准），那里没有段线，
    // 无法验证「选中某段 → 动作标签按需出现」。先确定地回到导航视图。
    // 退出编辑走**真实可见**入口：RouteEditorToolbar 的「退出」(data-testid=route-exit)。
    // 窄屏下 EditorShell 的 @media(max-width:760px){.editor-shell__menubar{display:none}}
    // 会把菜单条整行隐藏——那是设计，不是溢出，force click 也帮不了真实用户。
    // 这里同时记录该事实作为证据，并只依赖 toolbar 按钮（三个尺寸都可见）。
    const exitEvidence = await page.evaluate(() => {
      const menubar = document.querySelector('[data-testid="editor-shell-menubar"]');
      const menubarDisplay = menubar ? getComputedStyle(menubar).display : 'absent';
      const btn = document.querySelector('[data-testid="route-exit"]') as HTMLElement | null;
      let btnVisible = false;
      if (btn) {
        const b = btn.getBoundingClientRect(); const cs = getComputedStyle(btn);
        btnVisible = b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      }
      return { menubarDisplay, toolbarExitVisible: btnVisible };
    });
    console.log(`M_EXIT_ENTRY_${vp.tag} ` + JSON.stringify(exitEvidence));
    expect(exitEvidence.toolbarExitVisible, 'toolbar 的退出按钮必须可见可用').toBe(true);

    await page.getByTestId('route-exit').click({ timeout: 2000 });
    await page.waitForTimeout(500);
    const discardBtn = page.getByTestId('route-exit-discard');
    if (await discardBtn.isVisible().catch(() => false)) {
      await discardBtn.click({ timeout: 2000 });
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(900);
    // 必须真的回到导航视图，否则下面的段线断言毫无意义
    await expect(page.getByTestId('nav-route-edit'), '应已回到导航视图').toBeVisible({ timeout: 5000 });

    // 缩到「刚低于分层阈值 0.9」即停：这仍是真实的低缩放分层区间，
    // 又不会把 scale 压到 0.25——极端缩放下 tag 热区(32/scale)会放大到上百 world px，
    // 把点击从段线上抢走，测到的就不是「按需出现」而是热区吞点击。
    const zoomOut = page.getByRole('button', { name: '缩小地图' });
    for (let i = 0; i < 6; i++) {
      await zoomOut.click();
      await page.waitForTimeout(220);
      const cur = await page.evaluate(() => Number((document.querySelector('[data-testid="map-canvas"]') as HTMLElement).dataset.konvaScale ?? '0'));
      if (cur > 0 && cur < 0.85) break;
    }
    await page.waitForTimeout(700);
    const low = await metrics(page);
    console.log(`M_LOW_${vp.tag} ` + JSON.stringify(low));
    expect(low.scale, '必须真的缩小到分层区间').toBeLessThan(0.9);
    expect(low.scale, '不得缩到热区异常的极端尺度').toBeGreaterThan(0.3);
    expect(low.counts.segment, '低缩放时非选中段动作标签应隐藏').toBe(0);
    expect(low.collisions, '低缩放仍零碰撞').toBe(0);

    // 选中一段 → 该段动作标签按需出现（导航视图段线可点）。
    // 段是折线，取「画布内最长边」的中点，避免窄屏极低缩放下点到画布外或拐角落空。
    const clicked = await page.evaluate(() => {
      const stage = (window as any).__stage;
      const layer = stage.getLayers()[0];
      const c = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
      const box = c.getBoundingClientRect();
      const segs = layer.getChildren().filter((n: any) => {
        const nm = n.name() || '';
        return nm.startsWith('segment-') && !nm.startsWith('segment-label-');
      });
      let best: any = null;
      for (const seg of segs) {
        const pts = seg.points();
        for (let i = 0; i + 3 < pts.length; i += 2) {
          const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
          const len = Math.hypot(bx - ax, by - ay);
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          const sx = box.x + stage.x() + mx * stage.scaleX();
          const sy = box.y + stage.y() + my * stage.scaleY();
          const inside = sx > box.x + 10 && sx < box.x + box.width - 10 && sy > box.y + 10 && sy < box.y + box.height - 10;
          if (!inside) continue;
          if (!best || len > best.len) best = { len, x: sx, y: sy, name: seg.name() };
        }
      }
      return best;
    });
    expect(clicked, '导航视图画布内存在可点的段线').not.toBeNull();
    await page.mouse.click(clicked!.x, clicked!.y);
    await page.waitForTimeout(900);
    const selected = await metrics(page);
    await page.screenshot({ path: `${SHOTS}/${vp.tag}-04-segment-selected.png`, fullPage: false });
    console.log(`M_SELECTED_${vp.tag} ` + JSON.stringify(selected));
    expect(selected.counts.segment, '选中后该段动作标签必须出现').toBeGreaterThan(0);
    expect(selected.collisions, '选中后仍零碰撞').toBe(0);

    // --- 写拦截结论 ---
    const blocked = await page.evaluate(() => (window as any).__blockedWrites ?? []);
    console.log(`M_WRITES_${vp.tag} ` + JSON.stringify({ routeWrites: writes.length, fetchBlocked: blocked.length, wsUrls }));
    expect(blocked.length, '不得有真实写请求漏出').toBe(0);

    writeFileSync(`${SHOTS}/metrics-${vp.tag}.json`, JSON.stringify({ viewport: vp, nav, edit, open, low, selected, writes, blocked, wsUrls }, null, 2));
  });
}
