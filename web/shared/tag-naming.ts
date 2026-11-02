import {tagPositionLabel} from './map-tag-position';

/**
 * 二维码「名称」（现场别名）引擎。
 *
 * 为什么需要它：`Tag` 只有数字 `id`（真实 tag36h11 编号，打印在码上、写进地图、
 * 被导航/校验/打印全部按它索引）。现场说话的却是"这是 B04 号桩"，所以要一层
 * 只用于显示的别名。
 *
 * 铁律（本模块的存在意义就是守住它）：
 * - 名称**绝不**覆盖、替代或重写真实编号。任何 API、地图 body、路线/任务绑定
 *   仍然只认 `id`；展示时名称后面永远跟着真实编号：`B04 号桩 (Q012)`。
 * - 别名不进入 `mapSchema`，因此不改地图摘要、不改版本号、不影响旧路线与旧任务的
 *   摘要校验（见 server 里的独立表 tag_aliases）。这也意味着名称永远不会被
 *   `mapSchema.parse` 静默丢掉——它根本不在 map body 里。
 * - 校验只做"名称像不像人话"这一层：长度、空白、冒充编号、同名去重。
 *
 * 本文件是纯函数，不碰数据库、不碰网络、不修改入参。
 */

export interface TagAlias {
  /** 真实 tag36h11 编号，唯一键；名称永远挂在它下面。 */
  tagId: number;
  /** 现场可读名，已规范化（NFKC、折叠空白、去首尾空格）。 */
  name: string;
  /** ISO 时间戳，仅作审计。 */
  updated: string;
}

export interface TagAliasInput {tagId: number; name: string}
export interface TagAliasIssue {code: string; message: string; tagIds: number[]}
export type TagAliasChangeKind = 'added' | 'renamed' | 'removed' | 'unchanged';

export interface TagAliasChange {
  tagId: number;
  qrId: string;
  before: string | null;
  after: string | null;
  kind: TagAliasChangeKind;
}

export interface TagAliasPlan {
  /** 仅当校验无错且确有改动时为 true。 */
  ready: boolean;
  /** 规范化后的完整别名集合（按 tagId 升序）；保存时整表替换。 */
  aliases: TagAlias[];
  changes: TagAliasChange[];
  added: number[];
  renamed: number[];
  removed: number[];
  changedIds: number[];
  reasons: TagAliasIssue[];
  notes: TagAliasIssue[];
  disclaimer: string;
}

/** 别名集合的三种常见形态：数组、id→名称 的 Map，或干脆没有。 */
export type TagAliasLookup =
  | readonly TagAlias[]
  | ReadonlyMap<number, string>
  | ReadonlyArray<readonly [number, string]>
  | null
  | undefined;

export const TAG_ALIAS_MIN_LENGTH = 1;
export const TAG_ALIAS_MAX_LENGTH = 24;
export const TAG_ALIAS_ID_MIN = 0;
export const TAG_ALIAS_ID_MAX = 586;
export const TAG_ALIAS_DISCLAIMER = '名称只是现场别名：真正的 tag36h11 编号、坐标与朝向都不变，导航、打印与校验一律仍以编号为准。';
/** 长得像编号的名称一律拒绝：展示层已经会补真实编号，再冒充只会让人认错码。 */
export const TAG_ALIAS_RESERVED_PATTERN = /^(?:q\s*0*\d{1,3}|0*\d{1,3})$/i;

/** 与地图/打印件上的编号写法完全一致：Q + 三位补零。 */
export const tagQrId = (id: number): string => 'Q' + String(Math.trunc(id)).padStart(3, '0');

/** 规范化：NFKC（全角数字/字母归一到半角）+ 控制字符→空格 + 折叠连续空白 + 去首尾空格。 */
export function normalizeTagAliasName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 去重键：忽略大小写与多余空白，避免"B04 号桩"和"b04  号桩"同时存在。 */
export const tagAliasNameKey = (raw: unknown): string => normalizeTagAliasName(raw).toLowerCase();

export interface TagAliasNameCheck {ok: boolean; name: string; code: string; message: string}

/** 单个名称的校验。空名称不算错误——空名称表示"清除该码的名称"。 */
export function checkTagAliasName(raw: unknown): TagAliasNameCheck {
  const name = normalizeTagAliasName(raw);
  const length = [...name].length;
  if (length < TAG_ALIAS_MIN_LENGTH) {
    return {ok: false, name, code: 'empty-name', message: '名称不能为空或只有空格'};
  }
  if (length > TAG_ALIAS_MAX_LENGTH) {
    return {ok: false, name, code: 'name-too-long', message: `名称最多 ${TAG_ALIAS_MAX_LENGTH} 个字符（当前 ${length} 个）`};
  }
  if (TAG_ALIAS_RESERVED_PATTERN.test(name)) {
    return {ok: false, name, code: 'reserved-name', message: `「${name}」看起来像二维码编号；名称不能冒充编号，展示时会自动附带真实编号`};
  }
  return {ok: true, name, code: '', message: ''};
}

/** 把任意形态的别名集合收敛成 id → 名称 的 Map（名称已规范化，空名不出现在表里）。 */
export function aliasMap(aliases?: TagAliasLookup): Map<number, string> {
  const map = new Map<number, string>();
  if (!aliases) return map;
  if (aliases instanceof Map) {
    for (const [tagId, name] of aliases) {
      const normalized = normalizeTagAliasName(name);
      if (normalized) map.set(tagId, normalized);
    }
    return map;
  }
  for (const alias of aliases as readonly (TagAlias | readonly [number, string])[]) {
    // 支持两种输入形态：对象数组（数据库/接口原样）与 [id, name] 元组。
    // Array.isArray 无法把 readonly 元组从联合类型里收窄，这里显式判别。
    const isTuple = Array.isArray(alias);
    const tagId = isTuple ? Number((alias as readonly [number, string])[0]) : (alias as TagAlias).tagId;
    const rawName = isTuple ? (alias as readonly [number, string])[1] : (alias as TagAlias).name;
    if (!Number.isInteger(tagId)) continue;
    const normalized = normalizeTagAliasName(rawName);
    if (normalized) map.set(tagId, normalized);
  }
  return map;
}

/** 该码的别名，没有则为 null（绝不返回编号本身——编号是 id，不是名称）。 */
export function aliasNameFor(tagId: number, aliases?: TagAliasLookup): string | null {
  return aliasMap(aliases).get(tagId) ?? null;
}

export interface TagLabelParts {
  /** 真实编号，永远是唯一标识。 */
  qrId: string;
  /** 现场别名，没有则为 null。 */
  name: string | null;
  /** 无别名时的默认标签，与 `tagPositionLabel` 完全一致（组中心显示板号）。 */
  fallback: string;
  /** 唯一给界面用的展示串：有别名 `B04 号桩 (Q012)`，没有别名与旧标签一模一样。 */
  label: string;
}

/** 拆开展示串，方便表格把"名称"和"真实编号"分成两列、绝不让名称顶替编号。 */
export function resolveTagLabelParts(tag: {id: number; groupId?: string}, aliases?: TagAliasLookup): TagLabelParts {
  const qrId = tagQrId(tag.id);
  const name = aliasNameFor(tag.id, aliases);
  const fallback = tagPositionLabel(tag);
  return {qrId, name, fallback, label: name ? `${name} (${qrId})` : fallback};
}

/**
 * 展示标签。有别名 → `名称 (Q012)`；没有别名 → 与既有 `tagPositionLabel` 完全
 * 一致（Q012，组中心为板号），所以给未命名的地图加这个能力不会改变任何现有显示。
 */
export function resolveTagLabel(tag: {id: number; groupId?: string}, aliases?: TagAliasLookup): string {
  return resolveTagLabelParts(tag, aliases).label;
}

/**
 * 名称改动预览。纯函数：不写库，`now` 显式传入以便测试可复现。
 *
 * `incoming` 是**逐条覆盖**的补丁：列出且 `name` 非空的码设置名称，列出但 `name`
 * 为空的码清除名称，**没有列出的码保持原名称**——这样一次只改一个码的界面调用
 * 不可能把别人刚命名的码静默清空。指向已不在图中的码的旧别名会被一并清掉
 * （stale 剪枝），并在 notes 里说明。
 */
export function previewTagAliases(
  tags: ReadonlyArray<{id: number; groupId?: string}>,
  incoming: readonly TagAliasInput[],
  existing: readonly TagAlias[] = [],
  now: string = new Date().toISOString(),
): TagAliasPlan {
  const reasons: TagAliasIssue[] = [];
  const notes: TagAliasIssue[] = [];
  const addReason = (code: string, message: string, tagIds: number[] = []) => {
    reasons.push({code, message, tagIds: [...new Set(tagIds)].sort((a, b) => a - b)});
  };
  const addNote = (code: string, message: string, tagIds: number[] = []) => {
    notes.push({code, message, tagIds: [...new Set(tagIds)].sort((a, b) => a - b)});
  };

  const byId = new Map(tags.map(tag => [tag.id, tag]));
  const previous = new Map(existing.map(alias => [alias.tagId, normalizeTagAliasName(alias.name)]));
  for (const [tagId, name] of previous) if (!name) previous.delete(tagId);

  // 1) 校验提交集合
  const submitted = new Map<number, string>();
  const seen = new Set<number>();
  const nameKeys = new Map<string, {name: string; tagIds: number[]}>();
  for (const entry of incoming) {
    const tagId = Number(entry.tagId);
    if (!Number.isInteger(tagId) || tagId < TAG_ALIAS_ID_MIN || tagId > TAG_ALIAS_ID_MAX) {
      addReason('invalid-tag-id', `二维码编号必须是 ${TAG_ALIAS_ID_MIN}–${TAG_ALIAS_ID_MAX} 的整数（收到 ${String(entry?.tagId)}）`);
      continue;
    }
    if (seen.has(tagId)) {
      addReason('duplicate-alias-tag', `${tagQrId(tagId)} 的名称被重复提交`, [tagId]);
      continue;
    }
    seen.add(tagId);
    if (!byId.has(tagId)) {
      addReason('unknown-tag', `${tagQrId(tagId)} 不在这张地图中，不能给它起名`, [tagId]);
      continue;
    }
    if (normalizeTagAliasName(entry.name) === '') {
      // 空名称 = 清除该码的名称（不是错误）。
      submitted.set(tagId, '');
      continue;
    }
    const check = checkTagAliasName(entry.name);
    if (!check.ok) {
      addReason(check.code, `${tagQrId(tagId)}：${check.message}`, [tagId]);
      continue;
    }
    submitted.set(tagId, check.name);
    const key = tagAliasNameKey(check.name);
    const bucket = nameKeys.get(key);
    if (bucket) bucket.tagIds.push(tagId);
    else nameKeys.set(key, {name: check.name, tagIds: [tagId]});
  }
  for (const {name, tagIds} of nameKeys.values()) {
    if (tagIds.length > 1) {
      addReason('duplicate-name',
        `名称「${name}」被 ${tagIds.length} 个二维码同时使用（${tagIds.map(tagQrId).join('、')}），同一个名字只能对应一个码`,
        tagIds);
    }
  }

  // 2) 结果集合：旧别名打底 → 提交集合覆盖 → 清掉图上不存在的码
  const result = new Map<number, TagAlias>();
  for (const [tagId, name] of previous) {
    if (!byId.has(tagId)) continue;
    result.set(tagId, {tagId, name, updated: existing.find(alias => alias.tagId === tagId)?.updated ?? now});
  }
  for (const [tagId, name] of submitted) {
    const before = previous.get(tagId) ?? null;
    if (name === '') { result.delete(tagId); continue; }
    result.set(tagId, {tagId, name, updated: before === name ? (existing.find(alias => alias.tagId === tagId)?.updated ?? now) : now});
  }
  const aliases = [...result.values()].sort((a, b) => a.tagId - b.tagId);

  // 3) 逐点 diff（含被清掉的 stale 旧别名，服务端据此删行）
  const changes: TagAliasChange[] = [];
  const touched = new Set<number>([...previous.keys(), ...submitted.keys()]);
  for (const tagId of [...touched].sort((a, b) => a - b)) {
    const before = previous.get(tagId) ?? null;
    const after = result.get(tagId)?.name ?? null;
    if (before === null && after === null) continue;
    const kind: TagAliasChangeKind = before === null ? 'added' : after === null ? 'removed' : before === after ? 'unchanged' : 'renamed';
    changes.push({tagId, qrId: tagQrId(tagId), before, after, kind});
  }
  const changed = changes.filter(change => change.kind !== 'unchanged');
  if (!changed.length) addReason('no-changes', '名称与当前完全一致，没有可保存的改动');
  if (changed.length) addNote('id-immutable', '名称只是别名：本次保存不改动任何二维码的真实编号、坐标、朝向，也不改地图版本号', changed.map(change => change.tagId));

  const plan: TagAliasPlan = {
    ready: reasons.length === 0 && changed.length > 0,
    aliases,
    changes,
    added: changed.filter(change => change.kind === 'added').map(change => change.tagId),
    renamed: changed.filter(change => change.kind === 'renamed').map(change => change.tagId),
    removed: changed.filter(change => change.kind === 'removed').map(change => change.tagId),
    changedIds: changed.map(change => change.tagId),
    reasons,
    notes,
    disclaimer: TAG_ALIAS_DISCLAIMER,
  };
  const stale = existing.filter(alias => !byId.has(alias.tagId));
  if (stale.length) addNote('stale-alias', `${stale.length} 条名称指向已不在图中的二维码（${stale.map(alias => tagQrId(alias.tagId)).join('、')}），保存时一并清除`, stale.map(alias => alias.tagId));
  return plan;
}
