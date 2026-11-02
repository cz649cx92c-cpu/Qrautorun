import { test, expect, type Page } from '@playwright/test';

const tags: any[] = [];
let id = 0;
for (let g = 0; g < 17; g++) {
  const gx = (g % 5) * 1.6;
  const gy = Math.floor(g / 5) * 1.6;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    tags.push({ id: id++, x: gx + c * 0.18, y: gy + r * 0.18, angle: 0, size: .08,
      rowId: 'route', kind: 'waypoint', groupId: 'G' + String(g).padStart(3, '0'), rules: [] });
  }
}
const mkMap = () => ({
  schemaVersion: 1, id: 'ui-17g', name: '17组密集图', frame: 'map', family: 'tag36h11', source: 'manual',
  coordinateStatus: 'draft', routeMode: 'map-only',
  rows: [{ id: 'route', name: 'r', width: .6, exitDistance: .8, start: { x: 0, y: 0 }, points: [{ x: 1.0, y: 1.0 }] }],
  order: ['route'], tags,
  zone: [{ x: -2, y: -2 }, { x: 9, y: -2 }, { x: 9, y: 9 }, { x: -2, y: 9 }],
  vehicle: { width: 0.4, length: 0.8, margin: 0.05 }, notes: '',
});

async function boot(page: Page) {
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
    if (p === '/api/maps') return r.fulfill({ json: [{ id: 'ui-17g', name: '17组密集图', version: 1 }] });
    if (p.startsWith('/api/maps/')) {
      if (p.endsWith('/tag-aliases')) return r.fulfill({ json: { mapId: 'ui-17g', mapVersion: 1, aliases: [], disclaimer: 'x' } });
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
  await page.getByTestId('nav-route-edit').click({ timeout: 8000 });
  await page.waitForTimeout(2200);
  return { writes, errors };
}

for (const [w, h] of [[1440, 900], [375, 812]] as const) {
  test(`步骤头部单行 ${w}x${h}：控件同排、高度紧凑、中心可点`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    const { writes, errors } = await boot(page);

    // 展开步骤
    await page.getByTestId('route-steps-trigger').click({ timeout: 5000 });
    await page.waitForTimeout(800);
    await expect(page.getByTestId('route-steps-dock')).toBeVisible();

    const m = await page.evaluate(() => {
      const head = document.querySelector('[data-testid="route-steps-drag-handle"]') as HTMLElement | null;
      const hb = head?.getBoundingClientRect();
      const rectOf = (el: Element | null) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
                 bottom: Math.round(b.bottom), right: Math.round(b.right), cy: Math.round(b.y + b.height / 2) };
      };
      const ops = Array.from(document.querySelectorAll('[data-testid="route-steps-drag-handle"] .route-commands-ops button')) as HTMLElement[];
      const hits = ops.map(b => {
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { label: (b.textContent || '').trim().slice(0, 8), self: top === b || b.contains(top),
                 cy: Math.round(r.y + r.height / 2) };
      });
      const closeBtn = head?.querySelector('.route-steps-close') as HTMLElement | null;
      const collapseBtn = document.querySelector('[data-testid="route-steps-collapse"]') as HTMLElement | null;
      const badge = document.querySelector('[data-testid="route-steps-badge"]') as HTMLElement | null;
      const table = document.querySelector('.route-commands-table') as HTMLElement | null;
      return {
        head: rectOf(head),
        headHeight: hb ? Math.round(hb.height) : null,
        ops: hits,
        close: rectOf(closeBtn),
        collapse: rectOf(collapseBtn),
        badge: rectOf(badge),
        table: rectOf(table),
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
      };
    });

    // 高度紧凑：桌面 36-44px；窄屏允许略高但仍须单行（<=52）
    expect(m.headHeight, `${w}x${h} 头部应紧凑单行`).not.toBeNull();
    if (w >= 1440) {
      expect(m.headHeight!, '桌面头部高度应在 36-44px').toBeGreaterThanOrEqual(34);
      expect(m.headHeight!, '桌面头部高度应在 36-44px').toBeLessThanOrEqual(46);
    } else {
      expect(m.headHeight!, '窄屏头部仍应单行').toBeLessThanOrEqual(54);
    }

    // 所有控件中心 y 必须落在同一行（与头部中心差 <= 8px）
    const cys = [m.collapse?.cy, m.badge?.cy, m.close?.cy, ...m.ops.map(o => o.cy)].filter(v => typeof v === 'number') as number[];
    expect(cys.length).toBeGreaterThanOrEqual(4);
    const spread = Math.max(...cys) - Math.min(...cys);
    expect(spread, `所有头部控件应在同一行（y 跨度 ${spread}）`).toBeLessThanOrEqual(10);

    // 操作按钮中心命中自身
    for (const o of m.ops) {
      expect(o.self, `「${o.label}」中心应命中自身`).toBe(true);
    }

    // 表头紧接头部下方
    if (m.table && m.head) {
      expect(m.table.y, '表格应紧接头部下方').toBeLessThanOrEqual(m.head.bottom + 4);
    }

    expect(m.overflowX, '不得横向溢出').toBeLessThanOrEqual(1);

    // 标题恰好 1 个（展开态）
    const titles = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('strong, .route-steps-drag-title')) as HTMLElement[];
      return all.filter(e => {
        const t = (e.textContent || '').trim();
        if (!/^路径步骤\s*\d+/.test(t)) return false;
        const b = e.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) return false;
        let n: HTMLElement | null = e;
        while (n && n !== document.body) {
          const s = getComputedStyle(n);
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          n = n.parentElement;
        }
        return true;
      }).length;
    });
    expect(titles, '展开态主标题恰好 1').toBe(1);

    // 收起后仍恰好 1
    await page.getByTestId('route-steps-collapse').click({ timeout: 5000 });
    await page.waitForTimeout(600);
    const titlesAfter = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('strong, .route-steps-drag-title')) as HTMLElement[];
      return all.filter(e => {
        const t = (e.textContent || '').trim();
        if (!/^路径步骤\s*\d+/.test(t)) return false;
        const b = e.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) return false;
        let n: HTMLElement | null = e;
        while (n && n !== document.body) {
          const s = getComputedStyle(n);
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          n = n.parentElement;
        }
        return true;
      }).length;
    });
    expect(titlesAfter, '收起态主标题恰好 1').toBe(1);

    expect(writes.filter(x => !x.path.includes('/localization/')).length, '步骤操作不得写库').toBe(0);
    expect(errors.filter(e => !/404/.test(e))).toEqual([]);
  });
}
