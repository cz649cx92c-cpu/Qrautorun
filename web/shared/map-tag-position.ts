import {mapSchema, validate, distance, type FieldMap, type Point} from './model';
import {boardSchema} from './boards';

/**
 * One operator-supplied position for an existing map point. `x`/`y` are absolute
 * map-frame metres; `angle` is the optional absolute heading in degrees. Only
 * existing tags can be edited: this never adds, removes or renumbers a point.
 */
export interface TagPositionEdit {id: number; x: number; y: number; angle?: number}
export interface TagPositionIssue {code: string; message: string; tagIds: number[]}
export interface TagPositionPoint {
  id: number;
  label: string;
  groupId: string | null;
  before: Point;
  after: Point;
  displacementM: number;
  angleBefore: number;
  angleAfter: number;
  angleChangeDeg: number;
  /** Number of printed members that move rigidly with this group centre (0 for a standalone tag). */
  rigidMemberCount: number;
}
export interface TagPositionPreview {
  /** True only when the candidate parses, validate() has no errors and something changed. */
  ready: boolean;
  /** Diagnostic candidate, null when it does not even parse. Never save without checking ready. */
  map: FieldMap | null;
  points: TagPositionPoint[];
  changedIds: number[];
  maxDisplacementM: number;
  maxAngleChangeDeg: number;
  reasons: TagPositionIssue[];
  /** Informational only; never blocks saving. */
  notes: TagPositionIssue[];
  disclaimer: string;
}

export const TAG_POSITION_DISCLAIMER = '点位调整为人工修正，不代表外部实测精度已验收。';
export const tagPositionLabel = (tag: {id: number; groupId?: string}) => tag.groupId ?? 'Q' + String(tag.id).padStart(3, '0');

const epsilon = 1e-9;
/** Wrap an absolute heading to (-180, 180]; a full turn is not a position change. */
export const normalizeTagAngle = (deg: number) => {
  if (!Number.isFinite(deg)) return deg;
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
};
const micro = (value: number) => Math.round(value * 1e6) / 1e6;
const angleMicro = (value: number) => Math.round(normalizeTagAngle(value) * 1e6) / 1e6;
const point = (p: Point): Point => ({x: p.x, y: p.y});

/**
 * Pure map-only position preview.
 *
 * The scan version is the immutable evidence: callers pass it as `source` and
 * receive a *new* candidate. Only the requested tag centres change; every
 * group's member layout is expressed relative to its centre and is carried
 * over untouched, so moving a group centre is a rigid translation and an
 * optional heading change is a rigid rotation of the whole board. The
 * candidate is re-parsed with `mapSchema` and checked with the same
 * `validate()` gate used by navigation; nothing is relaxed here.
 */
export function previewTagPositions(source: FieldMap, edits: readonly TagPositionEdit[]): TagPositionPreview {
  const disclaimer = TAG_POSITION_DISCLAIMER;
  const result: TagPositionPreview = {
    ready: false, map: null, points: [], changedIds: [], maxDisplacementM: 0, maxAngleChangeDeg: 0,
    reasons: [], notes: [], disclaimer,
  };
  const addReason = (code: string, message: string, tagIds: number[] = []) => {
    result.reasons.push({code, message, tagIds: [...new Set(tagIds)].sort((a, b) => a - b)});
  };
  const addNote = (code: string, message: string, tagIds: number[] = []) => {
    result.notes.push({code, message, tagIds: [...new Set(tagIds)].sort((a, b) => a - b)});
  };
  const parsedSource = mapSchema.safeParse(source);
  if (!parsedSource.success) {
    addReason('invalid-source', parsedSource.error.issues.map(issue => issue.message).join('；'));
    return result;
  }
  const base = parsedSource.data;
  if (base.routeMode !== 'map-only') {
    addReason('unsupported-route-mode', '二维码位置调整仅适用于尚未创建路径的定位码地图；已包含路径的地图请保留旧版本并新建扫描');
    return result;
  }
  const seen = new Set<number>();
  for (const edit of edits) {
    if (seen.has(edit.id)) addReason('duplicate-edit', `Q${edit.id} 的位置被重复提交`, [edit.id]);
    seen.add(edit.id);
  }
  const candidate: FieldMap = {
    ...base,
    // A manually corrected position must never inherit a previous coordinate acceptance.
    coordinateStatus: 'draft',
    tags: base.tags.map(tag => ({...tag})),
  };
  const editById = new Map(edits.map(edit => [edit.id, edit]));
  const points: TagPositionPoint[] = [];
  for (const edit of edits) {
    const before = base.tags.find(tag => tag.id === edit.id);
    const after = candidate.tags.find(tag => tag.id === edit.id);
    if (!before || !after) {
      addReason('unknown-tag', `Q${edit.id} 不在这张地图中`, [edit.id]);
      continue;
    }
    if (!Number.isFinite(edit.x) || !Number.isFinite(edit.y) || (edit.angle !== undefined && !Number.isFinite(edit.angle))) {
      addReason('invalid-coordinate', `${tagPositionLabel(before)} 的新坐标或朝向不是有限数值`, [edit.id]);
      continue;
    }
    after.x = micro(edit.x);
    after.y = micro(edit.y);
    if (edit.angle !== undefined) after.angle = angleMicro(edit.angle);
    // 重复提交当前坐标不能被 1e-6 m 取整“放大”成一次改动：位移/朝向差不超过
    // 取整分辨率时保留库中原值，避免把无操作保存成新地图版本。
    if (Math.abs(after.x - before.x) <= 1e-6 && Math.abs(after.y - before.y) <= 1e-6) { after.x = before.x; after.y = before.y; }
    if (edit.angle !== undefined && Math.abs(normalizeTagAngle(after.angle - before.angle)) <= 1e-6) after.angle = before.angle;
    const group = before.groupId ? base.groups?.find(item => item.id === before.groupId) : undefined;
    if (before.groupId && !group) addReason('missing-group', `${tagPositionLabel(before)} 缺少定位组定义`, [edit.id]);
    if (group) {
      // Member offsets are relative to the centre; re-parsing the untouched board proves the
      // printed layout is still exact, i.e. the translation/rotation is rigid.
      const check = boardSchema.safeParse(group);
      if (!check.success) addReason('invalid-group', `定位组 ${group.id} 成员几何不合法，不能移动组中心`, [edit.id]);
      const rotated = Math.abs(normalizeTagAngle(after.angle - before.angle)) > epsilon;
      addNote('rigid-group', `${tagPositionLabel(before)}：整组 ${group.members.length} 个成员随组中心刚性${rotated ? '平移+旋转' : '平移'}，成员相对布局未改变`, [edit.id]);
    }
    const displacementM = distance(before, after);
    const angleChangeDeg = normalizeTagAngle(after.angle - before.angle);
    points.push({
      id: before.id,
      label: tagPositionLabel(before),
      groupId: before.groupId ?? null,
      before: point(before),
      after: point(after),
      displacementM,
      angleBefore: before.angle,
      angleAfter: after.angle,
      angleChangeDeg,
      rigidMemberCount: group?.members.length ?? 0,
    });
  }
  result.points = points.sort((a, b) => a.id - b.id);
  result.changedIds = points
    .filter(item => item.displacementM > 1e-6 || Math.abs(item.angleChangeDeg) > 1e-6)
    .map(item => item.id);
  result.maxDisplacementM = points.reduce((max, item) => Math.max(max, item.displacementM), 0);
  result.maxAngleChangeDeg = points.reduce((max, item) => Math.max(max, Math.abs(item.angleChangeDeg)), 0);
  if (editById.size === 0) addReason('no-changes', '尚未调整任何二维码位置');
  else if (!result.changedIds.length) addReason('no-changes', '新坐标与当前版本完全相同，没有可保存的改动');
  if (JSON.stringify(candidate.groups ?? null) !== JSON.stringify(base.groups ?? null)) addReason('groups-modified', '定位组定义不得在点位调整中改变');

  const parsed = mapSchema.safeParse(candidate);
  if (!parsed.success) {
    addReason('invalid-map', parsed.error.issues.map(issue => issue.message).join('；'));
  } else {
    result.map = parsed.data;
    const validation = validate(parsed.data);
    for (const message of validation.errors) addReason('invalid-geometry', message);
    for (const message of validation.warnings) addNote('warning', message);
    addNote('version-semantics', '保存将生成新的地图版本；旧版本、旧路线和旧任务的绑定保持不变');
    if (result.maxDisplacementM > .05) addNote('large-displacement', `最大中心位移 ${(result.maxDisplacementM * 100).toFixed(1)} cm，请目视确认预览`, result.changedIds);
  }
  result.ready = result.reasons.length === 0 && result.changedIds.length > 0 && result.map !== null;
  return result;
}
