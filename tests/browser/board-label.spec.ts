import { test, expect, type Page } from '@playwright/test';

// 真实工业布局：17 个定位板（board/group），板间中心距 1.04m，
// 每板 4x4 成员（板内 10cm）。B 编号是**板**的身份，不是成员码的。
const BOARDS = [
  { gid: 'B032', ref: 32 }, { gid: 'B096', ref: 96 }, { gid: 'B064', ref: 64 },
  { gid: 'B080', ref: 80 }, { gid: 'B016', ref: 16 }, { gid: 'B144', ref: 144 },
  { gid: 'B192', ref: 192 }, { gid: 'B240', ref: 240 }, { gid: 'B224', ref: 224 },
  { gid: 'B128', ref: 128 }, { gid: 'B176', ref: 176 }, { gid: 'B208', ref: 208 },
  { gid: 'B300', ref: 300 }, { gid: 'B048', ref: 48 }, { gid: 'B112', ref: 112 },
  { gid: 'B160', ref: 160 }, { gid: 'B272', ref: 272 },
];

const tags: any[] = [];
let id = 0;
BOARDS.forEach((b, idx) => {
  const bx = (idx % 5) * 1.04;
  const by = Math.floor(idx / 5) * 1.04;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      tags.push({
        id: id++, x: bx + (c - 1.5) * 0.10, y: by + (r - 1.5) * 0.10,
        angle: 0, size: .05, rowId: 'route', kind: 'waypoint', groupId: b.gid, rules: [],
      });
    }
  }
});
// 独立组 B032 已包含在 17 板中；再加一个无 groupId 的独立码用于对照
tags.push({ id: id++, x: 5.2, y: 0.2, angle: 0, size: .05, rowId: 'route', kind: 'waypoint', rules: [] });

const mkMap = () => ({
  schemaVersion: 1, id: 'ui-boards', name: '17板密集图', frame: 'map', family: 'tag36h11', source: 'manual',
  coordinateStatus: 'draft', routeMode: 'map-only', rows: [], order: [], tags,
  zone: [{ x: -1, y: -1 }, { x: 6, y: -1 }, { x: 6, y: 6 }, { x: -1, y: 6 }],
  vehicle: { width: 0.4, length: 0.8, margin: 0.05 }, notes: '',
});

async function boot(page: Page, view: 'nav' | 'edit') {
  const writes: any[] = [];
  const errors: string[] = [];
  page.on('pageerror', e => errors.push('PAGEERROR ' + String(e).slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });

  await page.routeWebSocket('**/ws', ws => ws.send(JSON.stringify({
    type: 'robot', status: { connected: true, state: 'IDLE', running: false, paused: false, pose: null,
      chassis: { connected: true }, sensors: {}, conditions: [], events: [],
      detector: { connected: true, positionReady: true, groups: [], reason: '' },
      mapping: { ready: true, quality: 'draft', localEpoch: 'ui', reason: '' } } })));
  await page.routeWebSocket('**/ws/camera', () => {});
  await page.route('**/api/**', async r => {
    const req = r.request(); const p = new URL(req.url()).pathname; const m = req.method().toUpperCase();
    if (['POST','PUT','PATCH','DELETE'].includes(m)) { writes.push({ method: m, path: p }); return r.fulfill({ json: { ok: true, mocked: true } }); }
    if (p === '/api/maps') return r.fulfill({ json: [{ id: 'ui-boards', name: '17板密集图', version: 1 }] });
    if (p.startsWith('/api/maps/')) {
      if (p.endsWith('/tag-aliases')) return r.fulfill({ json: { mapId: 'ui-boards', mapVersion: 1, aliases: [], disclaimer: 'x' } });
      return r.fulfill({ json: { map: mkMap(), version: 1, acceptance: { kind: 'office_test', accepted: true, digestValid: true } } });
    }
    if (p === '/api/routes') return r.fulfill({ json: [] });
    if (p === '/api/tasks') return r.fulfill({ json: [] });
    if (p === '/api/surveys' || p === '/api/boards') return r.fulfill({ json: [] });
    if (p === '/api/camera/status') return r.fulfill({ json: { running: false, present: false } });
    if (p.includes('/localization/')) return r.fulfill({ json: { phase: 'anchored' } });
    return r.fulfill({ json: {} });
  });

  await page.goto('/');
  await page.waitForTimeout(900);
  if (view === 'nav') {
    await page.locator('.sidebar').getByRole('button', { name: '开始导航', exact: true }).click();
    await page.waitForTimeout(1200);
    await page.getByTestId('map-select').selectOption('ui-boards').catch(() => {});
    await page.waitForTimeout(1800);
  } else {
    await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
    await page.waitForTimeout(2200);
  }
  return { writes, errors };
}

// 逐 ID 读取：实体屏幕中心 vs 标签屏幕位置（用真实 stage 变换）
const measure = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
  const scale = Number(c.dataset.konvaScale);
  const sx = Number(c.dataset.konvaX), sy = Number(c.dataset.konvaY);
  const box = c.getBoundingClientRect();
  const stage = (window as any).__stage;
  if (!stage) return { error: 'no stage' };
  const layer = stage.getLayers()[0];
  // 先算每个板组的中心（成员均值，world px）
  const gAcc = new Map<string, { sx: number; sy: number; n: number }>();
  layer.getChildren().forEach((node: any) => {
    const nm: string = node.name() || '';
    if (!nm.startsWith('tag-')) return;
    const tid = Number(nm.slice(4));
    const meta = (window as any).__tagMeta?.[tid];
    if (!meta?.groupId) return;
    const acc = gAcc.get(meta.groupId) ?? { sx: 0, sy: 0, n: 0 };
    acc.sx += node.x(); acc.sy += node.y(); acc.n += 1;
    gAcc.set(meta.groupId, acc);
  });
  const groupCenterScreen = new Map<string, { x: number; y: number }>();
  for (const [gid, a] of gAcc) {
    groupCenterScreen.set(gid, {
      x: Math.round(box.x + sx + (a.sx / a.n) * scale),
      y: Math.round(box.y + sy + (a.sy / a.n) * scale),
    });
  }
  const rows: any[] = [];
  layer.getChildren().forEach((node: any) => {
    const name: string = node.name() || '';
    if (!name.startsWith('tag-')) return;
    const tid = Number(name.slice(4));
    if (!Number.isFinite(tid)) return;
    const lbl = node.findOne('.tag-label-' + tid);
    const gx = node.x(), gy = node.y();
    const ent = { x: Math.round(box.x + sx + gx * scale), y: Math.round(box.y + sy + gy * scale) };
    if (!lbl) { rows.push({ tagId: tid, hasLabel: false, ent }); return; }
    const abs = lbl.getAbsoluteTransform().point({ x: 0, y: 0 });
    const meta = (window as any).__tagMeta?.[tid];
    const gid: string | undefined = meta?.groupId;
    // 组标签的参照点是板中心；独立码用自身坐标。
    const refPt = gid && groupCenterScreen.has(gid) ? groupCenterScreen.get(gid)! : ent;
    rows.push({
      tagId: tid, hasLabel: true, text: lbl.text(), vis: lbl.visible(),
      groupId: gid ?? null,
      ent, ref: refPt,
      lbl: { x: Math.round(box.x + abs.x), y: Math.round(box.y + abs.y),
             w: Math.round(lbl.width() * scale), h: Math.round(lbl.height() * scale) },
      dY: Math.round(box.y + abs.y - refPt.y),
      // 水平方向用标签中心，避免因标签宽度不同而误判居中。
      dX: Math.round(box.x + abs.x + (lbl.width() * scale) / 2 - refPt.x),
    });
  });
  return { scale: Number(scale.toFixed(3)), count: rows.length, rows };
});

for (const view of ['nav', 'edit'] as const) {
  test(`${view} view：17 板每个 B 编号只有一个标签且紧贴板中心`, async ({ page }) => {
    const { errors } = await boot(page, view);
    const m = await measure(page);
    expect(m.error).toBeUndefined();

    const withLabel = m.rows.filter((r: any) => r.hasLabel);
    // 17 个板 + 1 个独立码 = 18 个标签（不是 272 个）
    expect(withLabel.length, '标签数应等于板组数+独立码，而非成员数').toBe(18);

    // 每个 B 编号只出现一次
    const texts = withLabel.map((r: any) => r.text).filter((t: string) => /^B\d{3}$/.test(t));
    expect(texts.length, '17 个板编号').toBe(17);
    expect(new Set(texts).size, 'B 编号不得重复').toBe(17);
    for (const g of ['B032', 'B096', 'B064', 'B080', 'B016', 'B144', 'B192', 'B240']) {
      expect(texts, `应包含 ${g}`).toContain(g);
    }

    // 每个标签相对自己板中心的偏移必须一致且有界（默认在实体正上方）
    const dys = withLabel.map((r: any) => r.dY);
    const spread = Math.max(...dys) - Math.min(...dys);
    expect(spread, `标签纵向偏移应稳定（dY: ${Math.min(...dys)}..${Math.max(...dys)}）`).toBeLessThanOrEqual(3);
    for (const r of withLabel) {
      expect(Math.abs(r.dX), `tag ${r.tagId} 标签应水平居中于实体`).toBeLessThanOrEqual(6);
      // 标签必须紧贴自己板中心：有界（不压到板内成员、也不飘走）。
      // 允许在中心正上方或轻微覆盖中心（4x4 板中心可能落在成员之间/成员上）。
      expect(Math.abs(r.dY), `tag ${r.tagId} 标签应紧贴板中心（|dY|=${Math.abs(r.dY)}）`).toBeLessThanOrEqual(24);
    }

    expect(errors.filter(e => !/404/.test(e))).toEqual([]);
  });
}

test('缩放 0.5/1/2 + 平移 + resize 后 B 标签仍紧贴各自板中心', async ({ page }) => {
  const { errors } = await boot(page, 'nav');

  const check = async (tag: string) => {
    const m = await measure(page);
    const withLabel = m.rows.filter((r: any) => r.hasLabel && r.vis);
    expect(withLabel.length, `${tag}: 稀疏板组标签应全部可见`).toBeGreaterThanOrEqual(17);
    const dys = withLabel.map((r: any) => r.dY);
    const spread = Math.max(...dys) - Math.min(...dys);
    expect(spread, `${tag}: dY 应稳定 (spread=${spread})`).toBeLessThanOrEqual(4);
    for (const r of withLabel) {
      expect(Math.abs(r.dX), `${tag}: tag ${r.tagId} 水平居中`).toBeLessThanOrEqual(8);
    }
  };

  await check('初始');

  const box = await page.getByTestId('map-canvas').boundingBox();
  // 缩小
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(700);
  await check('缩小后');

  // 放大
  await page.mouse.wheel(0, -800);
  await page.waitForTimeout(700);
  await check('放大后');

  // 平移
  await page.keyboard.down('Space');
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 70, box!.y + box!.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForTimeout(700);
  await check('平移后');

  // resize
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(900);
  await check('resize 后');

  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});
