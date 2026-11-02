/**
 * usePanelLayout 纯逻辑回归。
 *
 * 这里只测「不依赖 Vue、不依赖 DOM」的部分：默认值、clamp、序列化/反序列化容错、
 * 窄屏降级、存储读写的失败兜底。这些函数是布局的唯一真源，App.vue / EditorShell.vue
 * 都只读它们的结果，因此这里红了就代表布局会越界或存储一坏就打不开编辑器。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PANEL_LAYOUT,
  LAYOUT_LIMITS,
  LAYOUT_STORAGE_KEY,
  LAYOUT_VERSION,
  NARROW_VIEWPORT_PX,
  applyResponsiveLayout,
  clampBottomHeight,
  clampLayout,
  clampRightFloatingWidth,
  clampSideWidth,
  coercePanelLayout,
  defaultPanelLayout,
  isNarrowViewport,
  layoutEquals,
  normalizeViewport,
  parsePanelLayout,
  readStoredPanelLayout,
  resolveEffectiveLayout,
  serializePanelLayout,
  writeStoredPanelLayout,
  type LayoutStorageLike,
  type PanelLayout,
} from '../web/frontend/src/composables/usePanelLayout';

const DESKTOP = {width: 1600, height: 1000};

function layout(patch: Partial<PanelLayout> = {}): PanelLayout {
  return {...defaultPanelLayout(), ...patch};
}

/** 内存版 localStorage，带失败注入能力。 */
function memoryStorage(initial: Record<string, string> = {}, options: {throwOnGet?: boolean; throwOnSet?: boolean} = {}): LayoutStorageLike & {data: Record<string, string>} {
  const data: Record<string, string> = {...initial};
  return {
    data,
    getItem(key: string) {
      if (options.throwOnGet) throw new Error('SecurityError: storage disabled');
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key]! : null;
    },
    setItem(key: string, value: string) {
      if (options.throwOnSet) throw new Error('QuotaExceededError');
      data[key] = value;
    },
    removeItem(key: string) {
      delete data[key];
    },
  };
}

test('默认布局紧凑且落在各自的上下限内', () => {
  const base = defaultPanelLayout();
  assert.deepEqual(base, {...DEFAULT_PANEL_LAYOUT});
  assert.ok(base.leftWidth >= LAYOUT_LIMITS.leftMin && base.leftWidth <= LAYOUT_LIMITS.leftMax);
  assert.ok(base.rightWidth >= LAYOUT_LIMITS.rightMin && base.rightWidth <= LAYOUT_LIMITS.rightMax);
  assert.ok(base.bottomHeight >= LAYOUT_LIMITS.bottomMin && base.bottomHeight <= LAYOUT_LIMITS.bottomMax);
  assert.equal(base.leftCollapsed, false);
  assert.equal(base.rightCollapsed, false);
  assert.equal(base.bottomCollapsed, false);
  assert.equal(base.rightFloating, false);
  // 默认值必须是副本，调用方改它不能污染常量。
  base.leftWidth = 999;
  assert.equal(DEFAULT_PANEL_LAYOUT.leftWidth, 280);
  assert.equal(defaultPanelLayout().leftWidth, 280);
  assert.equal(LAYOUT_STORAGE_KEY, 'qrautorun.editor.layout.v1');
});

test('视口缺失或非法时回落到桌面默认，不产生 NaN', () => {
  assert.deepEqual(normalizeViewport(undefined), {width: 1440, height: 900});
  assert.deepEqual(normalizeViewport({width: 0, height: 0}), {width: 1440, height: 900});
  assert.deepEqual(normalizeViewport({width: Number.NaN, height: -5}), {width: 1440, height: 900});
  assert.deepEqual(normalizeViewport({width: 1280, height: 800}), {width: 1280, height: 800});
});

test('clampSideWidth 卡住左右最小/最大宽度', () => {
  assert.equal(clampSideWidth('left', 5, DESKTOP), LAYOUT_LIMITS.leftMin);
  assert.equal(clampSideWidth('left', 9999, DESKTOP), LAYOUT_LIMITS.leftMax);
  assert.equal(clampSideWidth('right', 5, DESKTOP), LAYOUT_LIMITS.rightMin);
  assert.equal(clampSideWidth('right', 9999, DESKTOP), LAYOUT_LIMITS.rightMax);
  assert.equal(clampSideWidth('left', Number.NaN, DESKTOP), LAYOUT_LIMITS.leftMin);
});

test('clampSideWidth 给画布留出 canvasMinWidth，窄屏优先压缩侧栏', () => {
  // 视口 900：另一侧 0 时左侧预算 = 900 - 0 - 360 = 540，仍受 leftMax(400) 限制。
  assert.equal(clampSideWidth('left', 400, {width: 900, height: 700}), 400);
  // 视口 700：预算 = 700 - 0 - 360 = 340 → 左侧最多 340。
  assert.equal(clampSideWidth('left', 400, {width: 700, height: 700}), 340);
  // 右侧已被占用 240 时左侧预算进一步缩小。
  assert.equal(clampSideWidth('left', 400, {width: 900, height: 700}, 240), 300);
  // 预算小于最小值时仍返回最小值（不能再小，否则按钮放不下）。
  assert.equal(clampSideWidth('left', 400, {width: 420, height: 700}, 300), LAYOUT_LIMITS.leftMin);
});

test('clampBottomHeight 给画布留出 canvasMinHeight', () => {
  assert.equal(clampBottomHeight(10, DESKTOP), LAYOUT_LIMITS.bottomMin);
  assert.equal(clampBottomHeight(9999, DESKTOP), LAYOUT_LIMITS.bottomMax);
  // 视口 600 高：预算 = 600 - 200 - 260 = 140 < bottomMax。
  assert.equal(clampBottomHeight(300, {width: 1600, height: 600}), 140);
  // 视口极矮时退回最小值而不是负数。
  assert.equal(clampBottomHeight(300, {width: 1600, height: 300}), LAYOUT_LIMITS.bottomMin);
});

test('clampRightFloatingWidth 只保证不越出视口', () => {
  assert.equal(clampRightFloatingWidth(10, DESKTOP), LAYOUT_LIMITS.floatingRightMinWidth);
  assert.equal(clampRightFloatingWidth(9999, DESKTOP), LAYOUT_LIMITS.floatingRightMaxWidth);
  // 视口 500：上限 = 500 - 48 = 452 → 仍小于 floatingRightMaxWidth(420)? 452 > 420，所以取 420。
  assert.equal(clampRightFloatingWidth(9999, {width: 500, height: 800}), LAYOUT_LIMITS.floatingRightMaxWidth);
  // 视口 380：上限 = 332，被下限 260 托住。
  assert.equal(clampRightFloatingWidth(9999, {width: 380, height: 800}), 332);
});

test('clampLayout 同时约束左右与底部，并保留折叠偏好', () => {
  const clamped = clampLayout(layout({leftWidth: 9000, rightWidth: 9000, bottomHeight: 9000, bottomCollapsed: true}), {width: 1300, height: 800});
  assert.ok(clamped.leftWidth <= LAYOUT_LIMITS.leftMax);
  assert.ok(clamped.rightWidth <= LAYOUT_LIMITS.rightMax);
  assert.ok(clamped.bottomHeight <= LAYOUT_LIMITS.bottomMax);
  assert.ok(clamped.leftWidth + clamped.rightWidth + LAYOUT_LIMITS.canvasMinWidth <= 1300, '左右两侧加画布最小宽度不得超过视口');
  assert.equal(clamped.bottomCollapsed, true, '折叠偏好不能被 clamp 抹掉');
});

test('clampLayout 在左栏折叠时把全部预算让给右栏', () => {
  const collapsedLeft = clampLayout(layout({leftCollapsed: true, rightWidth: 9999}), {width: 900, height: 800});
  assert.equal(collapsedLeft.leftCollapsed, true);
  assert.ok(collapsedLeft.rightWidth >= LAYOUT_LIMITS.rightMin);
  assert.ok(collapsedLeft.rightWidth + LAYOUT_LIMITS.canvasMinWidth <= 900);
});

test('宽度 < 1200px 强制收起右栏（响应式降级），更宽时恢复用户偏好', () => {
  assert.equal(NARROW_VIEWPORT_PX, 1200);
  assert.equal(isNarrowViewport({width: 1199, height: 800}), true);
  assert.equal(isNarrowViewport({width: 1200, height: 800}), false);

  const wide = resolveEffectiveLayout(layout({rightCollapsed: false}), {width: 1600, height: 900});
  assert.equal(wide.rightCollapsed, false);

  const narrow = resolveEffectiveLayout(layout({rightCollapsed: false}), {width: 1024, height: 768});
  assert.equal(narrow.rightCollapsed, true, '窄屏必须收起右栏，不能让侧栏把画布挤没');

  // 用户主动折叠的偏好不会被「降级」反向打开。
  const narrowUser = applyResponsiveLayout(layout({rightCollapsed: true}), {width: 800, height: 768});
  assert.equal(narrowUser.rightCollapsed, true);

  // 浮动模式不占宽度，只保留用户自己的折叠选择。
  const floating = applyResponsiveLayout(layout({rightFloating: true, rightCollapsed: false}), {width: 1024, height: 768});
  assert.equal(floating.rightCollapsed, false);
});

test('窄屏下降级后画布仍有可用宽度', () => {
  const view = {width: 1120, height: 760};
  const effective = resolveEffectiveLayout(layout({leftWidth: 400, rightWidth: 380}), view);
  const occupied = (effective.leftCollapsed ? 0 : effective.leftWidth) + (effective.rightCollapsed || effective.rightFloating ? 0 : effective.rightWidth);
  assert.ok(occupied + LAYOUT_LIMITS.canvasMinWidth <= view.width, `占用 ${occupied}px 后画布不足以保持 ${LAYOUT_LIMITS.canvasMinWidth}px`);
});

test('serialize/parse 往返一致', () => {
  const original = layout({leftWidth: 320, rightWidth: 260, bottomHeight: 240, leftCollapsed: true, rightFloating: true});
  const raw = serializePanelLayout(original);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, LAYOUT_VERSION);
  assert.equal(typeof raw, 'string');
  const restored = parsePanelLayout(raw, DESKTOP);
  assert.equal(restored.leftWidth, 320);
  assert.equal(restored.rightWidth, 260);
  assert.equal(restored.bottomHeight, 240);
  assert.equal(restored.leftCollapsed, true);
  assert.equal(restored.rightFloating, true);
});

test('坏 JSON / 空值回默认，不抛异常', () => {
  for (const raw of ['{', 'not json', 'null', '[]', '"string"', '123', '', '   ', undefined, null]) {
    const result = parsePanelLayout(raw as string | null | undefined, DESKTOP);
    assert.deepEqual(result, resolveEffectiveLayout(defaultPanelLayout(), DESKTOP), `输入 ${JSON.stringify(raw)} 应回默认`);
  }
});

test('版本不匹配或字段缺失/类型不对时回默认或单字段兜底', () => {
  const versionMismatch = JSON.stringify({version: 99, leftWidth: 300, rightWidth: 260});
  assert.deepEqual(parsePanelLayout(versionMismatch, DESKTOP), resolveEffectiveLayout(defaultPanelLayout(), DESKTOP));

  const missingVersion = JSON.stringify({leftWidth: 300});
  assert.deepEqual(parsePanelLayout(missingVersion, DESKTOP), resolveEffectiveLayout(defaultPanelLayout(), DESKTOP));

  const partial = JSON.stringify({version: LAYOUT_VERSION, leftWidth: 300, rightCollapsed: 'yes', bottomHeight: Number.MAX_VALUE});
  const partialResult = parsePanelLayout(partial, DESKTOP);
  assert.equal(partialResult.leftWidth, 300, '合法字段要保留');
  assert.equal(partialResult.rightWidth, DEFAULT_PANEL_LAYOUT.rightWidth, '缺失字段回默认');
  assert.equal(partialResult.rightCollapsed, false, '类型不对的布尔回默认');
  assert.ok(partialResult.bottomHeight <= LAYOUT_LIMITS.bottomMax, '越界数值必须被 clamp');

  // NaN / Infinity 在 JSON 里会变成 null，也必须回默认。
  const withNulls = JSON.stringify({version: LAYOUT_VERSION, leftWidth: null, rightWidth: '280'});
  const nullResult = parsePanelLayout(withNulls, DESKTOP);
  assert.equal(nullResult.leftWidth, DEFAULT_PANEL_LAYOUT.leftWidth);
  assert.equal(nullResult.rightWidth, DEFAULT_PANEL_LAYOUT.rightWidth);
});

test('coercePanelLayout 只接受当前版本的对象', () => {
  assert.deepEqual(coercePanelLayout(null), defaultPanelLayout());
  assert.deepEqual(coercePanelLayout([1, 2, 3]), defaultPanelLayout());
  assert.deepEqual(coercePanelLayout({version: LAYOUT_VERSION}), defaultPanelLayout());
  const custom = coercePanelLayout({version: LAYOUT_VERSION, leftWidth: 300}, layout({rightWidth: 260}));
  assert.equal(custom.leftWidth, 300);
  assert.equal(custom.rightWidth, 260, '未提供的字段继承 base');
});

test('存储读取：缺值返回 null，坏值返回默认，读失败返回 null', () => {
  assert.equal(readStoredPanelLayout(memoryStorage(), DESKTOP), null);
  assert.equal(readStoredPanelLayout(null, DESKTOP), null);
  assert.equal(readStoredPanelLayout(memoryStorage({}, {throwOnGet: true}), DESKTOP), null);

  const broken = memoryStorage({[LAYOUT_STORAGE_KEY]: '{oops'});
  assert.deepEqual(readStoredPanelLayout(broken, DESKTOP), resolveEffectiveLayout(defaultPanelLayout(), DESKTOP));

  const good = memoryStorage({[LAYOUT_STORAGE_KEY]: serializePanelLayout(layout({leftWidth: 330}))});
  assert.equal(readStoredPanelLayout(good, DESKTOP)?.leftWidth, 330);
});

test('存储写入：配额满/禁用时返回 false 而不是抛异常', () => {
  const store = memoryStorage();
  assert.equal(writeStoredPanelLayout(store, layout({leftWidth: 310})), true);
  assert.equal(JSON.parse(store.data[LAYOUT_STORAGE_KEY]!).leftWidth, 310);
  assert.equal(writeStoredPanelLayout(memoryStorage({}, {throwOnSet: true}), layout()), false);
  assert.equal(writeStoredPanelLayout(null, layout()), false);
  // 自定义键名同样生效，避免多实例互相覆盖。
  const custom = memoryStorage();
  assert.equal(writeStoredPanelLayout(custom, layout(), 'qrautorun.editor.layout.test'), true);
  assert.ok(custom.data['qrautorun.editor.layout.test']);
});

test('layoutEquals 用于避免无意义的重绘/写入', () => {
  const a = layout();
  assert.equal(layoutEquals(a, layout()), true);
  assert.equal(layoutEquals(a, layout({leftWidth: 281})), false);
  assert.equal(layoutEquals(a, layout({bottomCollapsed: true})), false);
});
