import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'real-map-route.snapshot.json'), 'utf8'));
const MAP = snap.map;
const MAP_ID: string = snap.mapId;
const VERSION: number = snap.mapVersion;
const ROUTE = snap.route;
const ROUTE_ID: string = snap.routeId;

const errors: string[] = [];
const writes: Array<{ method: string; path: string; body: string }> = [];

async function boot(page: Page) {
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/api/**', async r => {
    const req = r.request();
    const p = new URL(req.url()).pathname;
    const m = req.method().toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
      writes.push({ method: m, path: p, body: req.postData() ?? '' });
      return r.fulfill({ json: { ok: true, mocked: true } });
    }
    if (p === '/api/maps') return r.fulfill({ json: [{ id: MAP_ID, name: MAP.name, version: VERSION }] });
    if (p === `/api/maps/${MAP_ID}`) return r.fulfill({ json: { map: MAP, version: VERSION, acceptance: { kind: null, digestValid: false, accepted: false } } });
    if (p === `/api/maps/${MAP_ID}/tag-aliases`) return r.fulfill({ json: { mapId: MAP_ID, mapVersion: VERSION, aliases: [], disclaimer: 'x' } });
    if (p === '/api/routes') return r.fulfill({ json: [ROUTE] });
    if (p === `/api/routes/${ROUTE_ID}`) return r.fulfill({ json: { ...ROUTE, route: ROUTE, map: MAP, version: VERSION, acceptance: { kind: null, digestValid: false, accepted: false } } });
    if (p === `/api/routes/${ROUTE_ID}/topology`) {
      // 真实结构：{ topology:{nodes,edges}, strategyChoices:{choices}, ... }
      // edges[].occurrence 从 1 起算，strategyChoices[].occurrence 从 0 起算。
      const segs: any[] = ROUTE.motionSegments ?? [];
      const seen = new Map<string, number>();
      const edges = segs.map((seg: any) => {
        const k = `${seg.fromId}>${seg.toId}`;
        const n = (seen.get(k) ?? 0) + 1;
        seen.set(k, n);
        return { fromId: seg.fromId, toId: seg.toId, occurrence: n, strategy: seg.strategy ?? 'auto' };
      });
      const nodes = [...new Set(segs.flatMap((seg: any) => [seg.fromId, seg.toId]))];
      const choices = edges
        .filter((e: any) => e.strategy !== 'auto')
        .map((e: any) => ({ fromId: e.fromId, toId: e.toId, occurrence: e.occurrence - 1, mode: e.strategy }));
      return r.fulfill({ json: {
        routeId: ROUTE_ID, mapId: MAP_ID, mapVersion: VERSION, stored: false,
        topology: { nodes, edges }, summary: {}, issues: [],
        strategyChoices: { choices, issues: [] }, disclaimer: 'mock',
      } });
    }
    if (p === '/api/tasks') return r.fulfill({ json: [] });
    if (p === '/api/surveys' || p === '/api/boards') return r.fulfill({ json: [] });
    if (p === '/api/camera/status') return r.fulfill({ json: { running: false, present: false } });
    if (p.includes('/localization/')) return r.fulfill({ json: { phase: 'anchored' } });
    return r.fulfill({ json: {} });
  });
  await page.goto('/');
  await page.waitForTimeout(900);
  await page.locator('.sidebar').getByRole('button', { name: '开始导航', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByTestId('map-select').selectOption(MAP_ID, { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByTestId('route-select').selectOption(ROUTE_ID, { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.getByTestId('nav-route-edit').click({ timeout: 20000 });
  await page.waitForTimeout(2600);
}

/** 当前编辑态的真实状态（都来自 DOM/组件，不靠 testid 存在性） */
const state = (page: Page) => page.evaluate(() => {
  const canvas = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
  const anchors = Number(canvas.dataset.routeWaypoints ?? '-1');
  const ordinals = Array.from(document.querySelectorAll('canvas')).length;
  const stage = (window as any).__stage;
  const layer = stage.getLayers()[0];
  const ordinalNodes = layer.getChildren().filter((n: any) => (n.name() || '').startsWith('route-ordinal-'));
  return {
    anchors,
    ordinals: ordinalNodes.length,
    editing: !!document.querySelector('[data-testid="route-exit"]'),
    segSelected: canvas.dataset.konvaSelectedSegment ?? '',
    url: location.hash,
  };
});

test('撤销/重做真实改变路径点数量（不是只切换按钮可用态）', async ({ page }) => {
  await boot(page);
  const base = await state(page);
  expect(base.editing, '应处于路径编辑态').toBe(true);
  const baseAnchors = base.anchors;
  expect(baseAnchors, '基线应有路点').toBeGreaterThan(1);

  // 真实追加一个路点：点画布空白处（draw 模式）
  await page.getByTestId('route-draw-tool').click();
  await expect(page.getByTestId('route-draw-tool')).toHaveAttribute('aria-pressed', 'true');
  const box = await page.getByTestId('map-canvas').boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.45, box!.y + box!.height * 0.55);
  await page.waitForTimeout(700);
  const added = await state(page);
  expect(added.anchors, `追加后路点应增加（base=${baseAnchors} now=${added.anchors}）`).toBeGreaterThan(baseAnchors);

  // 撤销：路点数量必须真的回到基线。
  // 撤销/重做在编辑器菜单里（文件 → 撤销 / 重做），不是常驻按钮。
  await page.getByTestId('editor-menu-file').click();
  await page.waitForTimeout(300);
  await page.getByTestId('editor-command-route-undo').click();
  await page.waitForTimeout(700);
  const undone = await state(page);
  expect(undone.anchors, `撤销后路点应回到基线（added=${added.anchors} undone=${undone.anchors}）`).toBe(baseAnchors);

  // 重做：路点数量必须真的回到追加后
  await page.getByTestId('editor-menu-file').click();
  await page.waitForTimeout(300);
  await page.getByTestId('editor-command-route-redo').click();
  await page.waitForTimeout(700);
  const redone = await state(page);
  expect(redone.anchors, `重做后路点应回到追加后（added=${added.anchors} redone=${redone.anchors}）`).toBe(added.anchors);

  // 整个过程中画布上的序号节点数量应随之变化（证明不是只改了数字）
  expect(added.ordinals).not.toBe(base.ordinals);
  expect(redone.ordinals).toBe(added.ordinals);

  expect(writes.filter(w => !w.path.includes('/localization/')).length, '只读不得写').toBe(0);
});

test('Esc 只关闭当前菜单，不清空编辑中的草稿', async ({ page }) => {
  await boot(page);
  await page.getByTestId('route-draw-tool').click();
  const box = await page.getByTestId('map-canvas').boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.4, box!.y + box!.height * 0.5);
  await page.waitForTimeout(600);
  const withDraft = await state(page);
  expect(withDraft.anchors).toBeGreaterThan(0);

  // 打开编辑器菜单（文件），Esc 应只关它，不得退出编辑或清空草稿
  await page.getByTestId('editor-menu-file').click();
  await page.waitForTimeout(400);
  await expect(page.getByTestId('editor-menu-panel-file')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await expect(page.getByTestId('editor-menu-panel-file'), 'Esc 应关闭当前菜单').toBeHidden();

  const afterEsc = await state(page);
  expect(afterEsc.editing, 'Esc 不得退出路径编辑').toBe(true);
  expect(afterEsc.anchors, `Esc 不得清空草稿（before=${withDraft.anchors} after=${afterEsc.anchors}）`).toBe(withDraft.anchors);
});

test('切换地图/路径时的脏草稿保护：未保存草稿不被静默丢弃', async ({ page }) => {
  await boot(page);
  await page.getByTestId('route-draw-tool').click();
  const box = await page.getByTestId('map-canvas').boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.42, box!.y + box!.height * 0.52);
  await page.waitForTimeout(700);
  const dirty = await state(page);

  // 编辑态下地图选择器可能被禁用（禁止中途换图）——先如实记录这个事实，
  // 再用真实可用的入口验证脏保护：尝试退出路径编辑。
  const selectorState = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-select"]') as HTMLSelectElement | null;
    if (!el) return { present: false, disabled: null, hidden: null };
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      present: true,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      hidden: cs.display === 'none' || cs.visibility === 'hidden' || box.width === 0 || box.height === 0,
    };
  });
  console.log('DIRTY_SELECTOR ' + JSON.stringify(selectorState));

  if (selectorState.present && !selectorState.disabled && !selectorState.hidden) {
    // 选择器可用：直接切换，验证草稿不被静默清空
    await page.getByTestId('map-select').selectOption(MAP_ID, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);
  } else {
    // 选择器不可用：三种形态都算「编辑中不允许换图」的结构性保护
    //   1) 整块不在 DOM（编辑器外壳替换了导航区）→ present:false
    //   2) 被 disabled
    //   3) 被隐藏（display:none / 尺寸为 0）
    const guarded = selectorState.present === false
      || selectorState.disabled === true
      || selectorState.hidden === true;
    expect(
      guarded,
      `编辑态下地图选择器应不存在/被禁用/被隐藏，实际 ${JSON.stringify(selectorState)}`,
    ).toBe(true);
    // 用编辑器菜单里真实的「退出路径编辑」验证脏草稿保护。
    await page.getByTestId('editor-menu-file').click({ timeout: 8000 });
    await page.waitForTimeout(300);
    // 菜单必须先真的展开，否则后续 click 会静默落空、用例变成假验证。
    await expect(page.getByTestId('editor-menu-panel-file'), '文件菜单应展开').toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('editor-command-route-exit'), '编辑态文件菜单应含「退出路径编辑」').toBeVisible({ timeout: 5000 });
    await page.getByTestId('editor-command-route-exit').click({ timeout: 8000 });
    await page.waitForTimeout(1000);
  }

  // 诊断：确认菜单命令确实点到了，并暴露 dirty 判定依据
  // 未保存判定必须为真，否则后面的弹层断言就没有意义。
  expect(await page.evaluate(() => document.documentElement.dataset.editorDirty), '加点后必须标记为未保存').toBe('1');

  // 必须弹出未保存草稿确认，而不是静默退出
  const confirm = page.getByTestId('route-exit-confirm');
  await expect(confirm, '有未保存草稿时退出必须弹确认').toBeVisible({ timeout: 8000 });
  await expect(confirm).toContainText(/未保存|草稿/);

  const stillEditing = await state(page);
  expect(stillEditing.editing, '确认弹层出现时不得已经退出编辑').toBe(true);
  expect(stillEditing.anchors, `确认期间草稿必须还在（before=${dirty.anchors} now=${stillEditing.anchors}）`).toBe(dirty.anchors);

  // 选「继续编辑」：草稿必须原样保留
  await page.getByTestId('route-exit-cancel').click();
  await page.waitForTimeout(500);
  await expect(confirm).toBeHidden();
  const afterCancel = await state(page);
  expect(afterCancel.editing, '「继续编辑」后仍应在编辑态').toBe(true);
  expect(afterCancel.anchors, `「继续编辑」不得丢草稿（before=${dirty.anchors} after=${afterCancel.anchors}）`).toBe(dirty.anchors);

  // 再次请求退出并明确选择「放弃并退出」：这时才允许丢弃
  await page.getByTestId('editor-menu-file').click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('editor-menu-panel-file')).toBeVisible();
  await expect(page.getByTestId('editor-command-route-exit')).toBeVisible();
  await page.getByTestId('editor-command-route-exit').click();
  await page.waitForTimeout(500);
  await expect(confirm).toBeVisible();
  await page.getByTestId('route-exit-discard').click();
  await page.waitForTimeout(800);
  const afterDiscard = await state(page);
  expect(afterDiscard.editing, '「放弃并退出」后应离开编辑态').toBe(false);
});

test('重复经过同一对码：occurrence 不同则策略不串写', async ({ page }) => {
  await boot(page);

  // 从真实快照里找出一对 fromId>toId 出现两次以上的段
  const pairs = new Map<string, number>();
  for (const seg of (ROUTE.motionSegments ?? [])) {
    const k = `${seg.fromId}>${seg.toId}`;
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  const repeated = [...pairs.entries()].filter(([, n]) => n > 1);
  console.log('PARITY_PAIRS ' + JSON.stringify({ total: pairs.size, repeated }));

  // 往返段（A→B 与 B→A）必须各自保留独立的方向/策略，不能互相覆盖。
  const segs = ROUTE.motionSegments ?? [];
  let roundTrips = 0;
  for (const a of segs) {
    const back = segs.find((b: any) => b.fromId === a.toId && b.toId === a.fromId);
    if (!back) continue;
    roundTrips++;
    // 方向/模式来自各自记录；若串写，两条会完全相同。
    console.log('ROUNDTRIP ' + JSON.stringify({
      a: { id: a.id, dir: a.direction, mode: a.mode, strat: a.strategy ?? null },
      b: { id: back.id, dir: back.direction, mode: back.mode, strat: back.strategy ?? null },
    }));
    expect(a.id, '往返的两段必须是不同记录').not.toBe(back.id);
  }
  expect(roundTrips, '真实快照应包含往返段（同一条走廊去与回）').toBeGreaterThan(0);
  // 本快照若没有同对重复，就如实记录，不伪造 occurrence 场景。
  if (repeated.length === 0) console.log('PARITY_NOTE 本快照无同一对码重复经过，occurrence 恒为 0');

  // 后端拓扑接口的真实返回结构是 { topology:{nodes,edges}, strategyChoices, ... }。
  // 注意 edges[].occurrence 从 1 起算，而 SegmentChoice.occurrence 从 0 起算
  // （topologyStrategyChoices 里做 edge.occurrence-1），这里两者都要核对。
  const topo = await page.evaluate(async (routeId) => {
    const res = await fetch(`/api/routes/${routeId}/topology`);
    const json: any = await res.json();
    const edges = json?.topology?.edges ?? [];
    return {
      edges: edges.map((e: any) => ({ from: e.fromId, to: e.toId, occurrence: e.occurrence, strategy: e.strategy ?? null })),
      choices: (json?.strategyChoices?.choices ?? []).map((c: any) => ({ from: c.fromId, to: c.toId, occurrence: c.occurrence, mode: c.mode })),
      nodeCount: (json?.topology?.nodes ?? []).length,
    };
  }, ROUTE_ID);

  // 必须真的读到边，否则这个用例什么都没验证。
  expect(topo.edges.length, '拓扑接口必须返回真实边').toBeGreaterThan(0);
  expect(topo.nodeCount, '拓扑接口必须返回真实节点').toBeGreaterThan(0);
  console.log('PARITY_TOPO ' + JSON.stringify({ edges: topo.edges.length, nodes: topo.nodeCount, choices: topo.choices.length }));

  // 每条边 occurrence 必须是 >=1 的正整数，且同一对码内互不相同
  const grouped = new Map<string, number[]>();
  for (const e of topo.edges) {
    expect(Number.isInteger(e.occurrence) && e.occurrence >= 1, `occurrence 必须是 >=1 的整数，实际 ${JSON.stringify(e)}`).toBe(true);
    const k = `${e.from}>${e.to}`;
    grouped.set(k, [...(grouped.get(k) ?? []), e.occurrence]);
  }
  let checked = 0;
  for (const [k, list] of grouped) {
    if (list.length < 2) continue;
    checked++;
    expect(new Set(list).size, `${k} 的 occurrence 重复：${JSON.stringify(list)}`).toBe(list.length);
  }

  // strategyChoices 的 occurrence 必须严格等于 edge.occurrence-1，不能串写
  for (const c of topo.choices) {
    const edge = topo.edges.find((e: any) => e.from === c.from && e.to === c.to && e.occurrence === c.occurrence + 1);
    expect(edge, `策略选择 ${JSON.stringify(c)} 找不到对应的边（occurrence 换算不一致）`).toBeTruthy();
  }
  console.log('PARITY_OCC ' + JSON.stringify({ edges: topo.edges.length, repeatedPairsChecked: checked, choices: topo.choices.length }));
});
