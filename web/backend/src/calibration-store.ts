/**
 * 融合标定存储：独立 SQLite 文件，绝不写入地图数据库（navigation.db）。
 *
 * 设计要点：
 * - 会话（session）绑定 mapId + mapVersion + mapDigest；版本内容变化后拒绝继续分析。
 * - 试验（trial）只有一条可以处于 recording；开始/结束带状态机与并发保护。
 * - 样本必须来自 ROS 桥接（带原始 stamp），前端不提供时间戳。
 * - 分析结果可保存；apply 只做 dry-run，不写运行配置。
 */
import Database from 'better-sqlite3';
import {randomBytes} from 'node:crypto';
import {dirname,join,resolve as resolvePath} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {
  analyzeSession,analysisCsv,analysisReport,calibrationSessionInputSchema,calibrationTrialInputSchema,
  rad,sampleKindSchema,tagCode,
  type AnalysisSample,type CalibrationSession,type CalibrationTrial,type ImuCalibrationInfo,type Pose2,type SampleKind,type SessionAnalysis,type TrialType,
} from '../../shared/calibration';

/** 地图标签位姿：angle 以度存储（与 shared/model.ts 一致），进入分析前统一转弧度。 */
export interface MapTagPose {id: number; x: number; y: number; angle: number}
export interface MapLookupResult {
  map: {id: string; name: string}; version: number; digest: string;
  tags?: MapTagPose[];
}

export interface CalibrationSessionSummary {
  id: string; mapId: string; mapVersion: number; mapName: string; tagA: number; tagB: number;
  baselineM: number; note: string; created: string; trialCount: number; analysisSaved: boolean; applied: boolean;
}

export interface CalibrationSampleRow {kind: SampleKind; stamp: number; trialId: string | null; body: Record<string, unknown>}

const SESSION_LIMIT = 500;
const SAMPLE_LIMIT = 400_000;

/** 旋转二维码解析结果：label 总能由 id 得到，pose 只有地图里真有这块码时才有值。 */
type TagResolver = (tagId: number | null) => {label: string | null; pose: Pose2 | null};

const rowToTrial = (row: any, resolveTag?: TagResolver): CalibrationTrial => {
  const rotationTagId = typeof row.rotation_tag_id === 'number' ? row.rotation_tag_id : null;
  const resolved = resolveTag ? resolveTag(rotationTagId) : {label: null, pose: null};
  return {
    id: row.id, sessionId: row.session_id, type: row.type as TrialType, angleDeg: row.angle_deg,
    rotationTagId, rotationTagLabel: resolved.label, rotationTagPose: resolved.pose,
    repetition: row.repetition, note: row.note, status: row.status,
    startedAt: row.started_at, endedAt: row.ended_at, startedStamp: row.started_stamp, endedStamp: row.ended_stamp,
  };
};

export class CalibrationStore {
  db: Database.Database;
  constructor(
    path: string,
    private readonly mapLookup: (mapId: string, version: number) => MapLookupResult | null,
    /** 运行标定 bias/up 来源：必须显式提供并记录来源，缺失时分析会明确标注“缺数据”。 */
    private readonly imuBiasProvider?: () => ImuCalibrationInfo | null,
  ) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS calibration_sessions(
      id TEXT PRIMARY KEY, map_id TEXT NOT NULL, map_version INTEGER NOT NULL, map_name TEXT NOT NULL,
      map_digest TEXT NOT NULL, tag_a INTEGER NOT NULL, tag_b INTEGER NOT NULL, baseline_m REAL NOT NULL,
      baseline_source TEXT NOT NULL DEFAULT 'external_baseline', note TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL, analysis TEXT, analysis_at TEXT, applied INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS calibration_trials(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, angle_deg REAL, repetition INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
      started_stamp REAL, ended_stamp REAL);
      CREATE INDEX IF NOT EXISTS calibration_trials_session_idx ON calibration_trials(session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS calibration_single_recording ON calibration_trials(status) WHERE status='recording';
      CREATE TABLE IF NOT EXISTS calibration_samples(
      session_id TEXT NOT NULL, trial_id TEXT, kind TEXT NOT NULL, stamp REAL NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS calibration_samples_trial_idx ON calibration_samples(trial_id, kind, stamp);
      CREATE TABLE IF NOT EXISTS calibration_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // 既有 calibration.db 升级：只补列，绝不重建表、不动历史数据。
    const trialColumns = this.db.prepare('PRAGMA table_info(calibration_trials)').all() as {name: string}[];
    if (!trialColumns.some(column => column.name === 'rotation_tag_id')) {
      this.db.exec('ALTER TABLE calibration_trials ADD COLUMN rotation_tag_id INTEGER');
    }
    // 服务重启后，任何仍标记 recording 的试验都不可能再收到样本。
    this.db.prepare("UPDATE calibration_trials SET status='interrupted', ended_at=? WHERE status='recording'").run(new Date().toISOString());
  }

  close() { this.db.close(); }

  private digestOf(mapId: string, version: number) {
    const item = this.mapLookup(mapId, version);
    if (!item) throw Object.assign(new Error('标定绑定的地图版本不存在'), {statusCode: 404});
    return {map: item.map, version: item.version, digest: item.digest};
  }

  createSession(raw: unknown): CalibrationSession {
    const input = calibrationSessionInputSchema.parse(raw);
    const resolved = this.digestOf(input.mapId, input.mapVersion);
    const count = (this.db.prepare('SELECT COUNT(*) AS count FROM calibration_sessions').get() as {count: number}).count;
    if (count >= SESSION_LIMIT) throw Object.assign(new Error('标定会话数量已达上限，请先导出并删除旧会话'), {statusCode: 409});
    const id = 'cal-' + randomBytes(10).toString('hex');
    const created = new Date().toISOString();
    this.db.prepare(`INSERT INTO calibration_sessions(id,map_id,map_version,map_name,map_digest,tag_a,tag_b,baseline_m,baseline_source,note,created)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.mapId, input.mapVersion, resolved.map.name, resolved.digest, input.tagA, input.tagB, input.baselineM, 'external_baseline', input.note, created);
    return this.getSession(id)!;
  }

  listSessions(): CalibrationSessionSummary[] {
    const rows = this.db.prepare(`SELECT s.*,(SELECT COUNT(*) FROM calibration_trials t WHERE t.session_id=s.id) AS trial_count
      FROM calibration_sessions s ORDER BY s.created DESC`).all() as any[];
    return rows.map(row => ({
      id: row.id, mapId: row.map_id, mapVersion: row.map_version, mapName: row.map_name,
      tagA: row.tag_a, tagB: row.tag_b, baselineM: row.baseline_m, note: row.note, created: row.created,
      trialCount: row.trial_count, analysisSaved: !!row.analysis, applied: !!row.applied,
    }));
  }

  getSession(id: string): CalibrationSession | null {
    const row = this.db.prepare('SELECT * FROM calibration_sessions WHERE id=?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id, mapId: row.map_id, mapVersion: row.map_version, mapDigest: row.map_digest,
      tagA: row.tag_a, tagB: row.tag_b, baselineM: row.baseline_m, baselineSource: 'external_baseline',
      note: row.note, created: row.created, trials: this.trials(id),
      analysis: row.analysis ? JSON.parse(row.analysis) as SessionAnalysis : null, applied: !!row.applied,
    };
  }

  private requireSession(id: string): CalibrationSession {
    const session = this.getSession(id);
    if (!session) throw Object.assign(new Error('标定会话不存在'), {statusCode: 404});
    return session;
  }

  trials(sessionId: string): CalibrationTrial[] {
    const meta = this.db.prepare('SELECT map_id,map_version FROM calibration_sessions WHERE id=?').get(sessionId) as {map_id: string; map_version: number} | undefined;
    const item = meta ? this.mapLookup(meta.map_id, meta.map_version) : null;
    const resolveTag: TagResolver = tagId => {
      if (tagId === null) return {label: null, pose: null};
      const tag = item?.tags?.find(entry => entry.id === tagId);
      const pose = tag && [tag.x, tag.y, tag.angle].every(value => Number.isFinite(value))
        ? {x: tag.x, y: tag.y, yaw: rad(tag.angle)} : null;
      return {label: tagCode(tagId), pose};
    };
    return (this.db.prepare('SELECT * FROM calibration_trials WHERE session_id=? ORDER BY started_at ASC').all(sessionId) as any[])
      .map(row => rowToTrial(row, resolveTag));
  }

  activeTrial(): {trialId: string; sessionId: string} | null {
    const row = this.db.prepare("SELECT id,session_id FROM calibration_trials WHERE status='recording' LIMIT 1").get() as {id: string; session_id: string} | undefined;
    return row ? {trialId: row.id, sessionId: row.session_id} : null;
  }

  createTrial(sessionId: string, raw: unknown): CalibrationTrial {
    const session = this.requireSession(sessionId);
    this.assertDigest(session);
    const input = calibrationTrialInputSchema.parse(raw);
    if (this.activeTrial()) throw Object.assign(new Error('已有试验正在录制，请先结束当前试验'), {statusCode: 409});
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM calibration_trials WHERE status='recording'").get() as {count: number};
    if (active.count) throw Object.assign(new Error('已有试验正在录制，请先结束当前试验'), {statusCode: 409});
    const repetition = (this.db.prepare('SELECT COUNT(*) AS count FROM calibration_trials WHERE session_id=? AND type=?').get(sessionId, input.type) as {count: number}).count + 1;
    const id = 'trial-' + randomBytes(10).toString('hex');
    const startedAt = new Date().toISOString();
    try {
      this.db.prepare('INSERT INTO calibration_trials(id,session_id,type,angle_deg,rotation_tag_id,repetition,note,status,started_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, sessionId, input.type, input.angleDeg, input.rotationTagId, repetition, input.note, 'recording', startedAt);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw Object.assign(new Error('已有试验正在录制，请先结束当前试验'), {statusCode: 409});
      throw error;
    }
    return this.trials(sessionId).find(trial => trial.id === id)!;
  }

  stopTrial(trialId: string, status: 'saved' | 'aborted', endedStamp?: number | null): CalibrationTrial {
    const row = this.db.prepare('SELECT * FROM calibration_trials WHERE id=?').get(trialId) as any;
    if (!row) throw Object.assign(new Error('标定试验不存在'), {statusCode: 404});
    if (row.status !== 'recording') throw Object.assign(new Error('该试验不在录制状态'), {statusCode: 409});
    const endedAt = new Date().toISOString();
    this.db.prepare('UPDATE calibration_trials SET status=?, ended_at=?, ended_stamp=? WHERE id=?')
      .run(status, endedAt, endedStamp ?? null, trialId);
    return this.trials(row.session_id).find(trial => trial.id === trialId)!;
  }

  /**
   * 清空某个会话的全部试验与样本。
   * - 只动本会话的 calibration_trials / calibration_samples；
   * - 会话本身（地图绑定、A/B、baselineM、note）原样保留，applied 归零；
   * - analysis/analysis_at 一并清空，避免“0 次试验却还挂着旧汇总”；
   * - 有 recording 状态试验时 409 拒绝，绝不删到一半；整个操作在单个事务里。
   */
  clearSessionTrials(sessionId: string): {sessionId: string; deletedTrials: number; deletedSamples: number} {
    this.requireSession(sessionId);
    return this.db.transaction(() => {
      const recording = this.db.prepare("SELECT id FROM calibration_trials WHERE session_id=? AND status='recording'").get(sessionId) as {id: string} | undefined;
      if (recording) {
        throw Object.assign(new Error('该会话还有正在录制的试验（' + recording.id + '），请先结束或中止后再清空'), {statusCode: 409});
      }
      const deletedSamples = this.db.prepare('DELETE FROM calibration_samples WHERE session_id=?').run(sessionId).changes;
      const deletedTrials = this.db.prepare('DELETE FROM calibration_trials WHERE session_id=?').run(sessionId).changes;
      this.db.prepare('UPDATE calibration_sessions SET analysis=NULL, analysis_at=NULL, applied=0 WHERE id=?').run(sessionId);
      return {sessionId, deletedTrials, deletedSamples};
    })();
  }

  addSamples(sessionId: string, trialId: string | null, samples: {kind: string; stamp: number}[]): {stored: number; ignored: string} {
    const session = this.getSession(sessionId);
    if (!session) return {stored: 0, ignored: 'session-missing'};
    const active = this.activeTrial();
    const targetTrial = trialId ?? active?.trialId ?? null;
    if (!targetTrial) return {stored: 0, ignored: 'no-recording-trial'};
    if (active?.trialId !== targetTrial) return {stored: 0, ignored: 'trial-not-recording'};
    const trial = this.db.prepare('SELECT session_id FROM calibration_trials WHERE id=?').get(targetTrial) as {session_id: string} | undefined;
    if (!trial || trial.session_id !== sessionId) return {stored: 0, ignored: 'trial-session-mismatch'};
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM calibration_samples WHERE session_id=?').get(sessionId) as {count: number}).count;
    if (total >= SAMPLE_LIMIT) return {stored: 0, ignored: 'sample-limit'};
    const insert = this.db.prepare('INSERT INTO calibration_samples(session_id,trial_id,kind,stamp,body) VALUES(?,?,?,?,?)');
    let stored = 0;
    this.db.transaction(() => {
      for (const sample of samples) {
        const kind = sampleKindSchema.safeParse(sample.kind);
        if (!kind.success || !Number.isFinite(sample.stamp)) continue;
        insert.run(sessionId, targetTrial, kind.data, sample.stamp, JSON.stringify(sample));
        stored += 1;
      }
    })();
    this.db.prepare("INSERT INTO calibration_state(key,value) VALUES('lastSample',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({at: new Date().toISOString(), kind: samples.length ? samples[samples.length - 1]!.kind : ''}));
    return {stored, ignored: ''};
  }

  samples(sessionId: string, filter: {trialId?: string; kind?: string; limit?: number} = {}): CalibrationSampleRow[] {
    const clauses = ['session_id=?'];
    const values: unknown[] = [sessionId];
    if (filter.trialId) { clauses.push('trial_id=?'); values.push(filter.trialId); }
    if (filter.kind) { clauses.push('kind=?'); values.push(filter.kind); }
    const limit = Math.max(1, Math.min(2000, filter.limit ?? 200));
    const rows = this.db.prepare(`SELECT kind,stamp,trial_id,body FROM calibration_samples WHERE ${clauses.join(' AND ')} ORDER BY stamp ASC LIMIT ?`)
      .all(...values, limit) as any[];
    return rows.map(row => ({kind: row.kind as SampleKind, stamp: row.stamp, trialId: row.trial_id, body: JSON.parse(row.body)}));
  }

  analysisSamples(sessionId: string): AnalysisSample[] {
    const rows = this.db.prepare('SELECT kind,stamp,trial_id,body FROM calibration_samples WHERE session_id=? ORDER BY stamp ASC').all(sessionId) as any[];
    return rows.map(row => ({kind: row.kind as SampleKind, stamp: row.stamp, trialId: row.trial_id, body: JSON.parse(row.body)}));
  }

  sampleCounts(sessionId: string): Record<SampleKind, number> {
    const counts = {observation: 0, feedback: 0, imu: 0, fusion: 0} as Record<SampleKind, number>;
    for (const row of this.db.prepare('SELECT kind,COUNT(*) AS count FROM calibration_samples WHERE session_id=? GROUP BY kind').all(sessionId) as {kind: SampleKind; count: number}[]) counts[row.kind] = row.count;
    return counts;
  }

  private assertDigest(session: CalibrationSession) {
    const current = this.mapLookup(session.mapId, session.mapVersion);
    if (!current) throw Object.assign(new Error('标定会话绑定的地图版本已被删除'), {statusCode: 409});
    if (current.digest !== session.mapDigest) throw Object.assign(new Error('标定会话绑定的地图版本内容已变化，请新建会话'), {statusCode: 409});
  }

  /**
   * 从绑定地图版本读取 A/B 位姿，并额外给出 byId 全量位姿（转向试验要用旋转二维码）。
   * 地图里 angle 是度，分析统一用弧度。
   * 缺失时返回 null（而不是用 baselineM 造一个），让分析明确报 missing_map_tag_pose / rotation_tag_not_in_map。
   */
  private mapTagsFor(session: CalibrationSession): {tagA: Pose2 | null; tagB: Pose2 | null; byId: Record<string, Pose2 | null>} {
    const item = this.mapLookup(session.mapId, session.mapVersion);
    const toPose = (tag: MapTagPose | undefined): Pose2 | null => {
      if (!tag || ![tag.x, tag.y, tag.angle].every(value => Number.isFinite(value))) return null;
      return {x: tag.x, y: tag.y, yaw: rad(tag.angle)};
    };
    const byId: Record<string, Pose2 | null> = {};
    for (const tag of item?.tags ?? []) byId[String(tag.id)] = toPose(tag);
    return {
      tagA: toPose(item?.tags?.find(entry => entry.id === session.tagA)),
      tagB: toPose(item?.tags?.find(entry => entry.id === session.tagB)),
      byId,
    };
  }

  private imuCalibration(): ImuCalibrationInfo | null {
    try {
      return this.imuBiasProvider?.() ?? null;
    } catch {
      return null;
    }
  }

  analyze(sessionId: string): {session: CalibrationSession; analysis: SessionAnalysis} {
    const session = this.requireSession(sessionId);
    this.assertDigest(session);
    const analysis = analyzeSession({
      session,
      samples: this.analysisSamples(sessionId),
      mapTags: this.mapTagsFor(session),
      imuCalibration: this.imuCalibration(),
    });
    return {session, analysis};
  }

  saveAnalysis(sessionId: string, analysis?: SessionAnalysis): SessionAnalysis {
    const computed = analysis ?? this.analyze(sessionId).analysis;
    this.requireSession(sessionId);
    this.db.prepare('UPDATE calibration_sessions SET analysis=?, analysis_at=? WHERE id=?').run(JSON.stringify(computed), computed.analyzedAt, sessionId);
    return computed;
  }

  exportPayload(sessionId: string, format: 'json' | 'csv' | 'report'): {content: string; contentType: string; filename: string} {
    const session = this.requireSession(sessionId);
    const saved = session.analysis;
    const analysis = saved ?? this.analyze(sessionId).analysis;
    if (format === 'csv') return {content: analysisCsv(analysis), contentType: 'text/csv; charset=utf-8', filename: `${sessionId}.csv`};
    if (format === 'report') return {content: analysisReport(analysis), contentType: 'text/markdown; charset=utf-8', filename: `${sessionId}.md`};
    return {content: JSON.stringify({schemaVersion: 1, session: {...session, analysis: undefined}, analysis}, null, 2), contentType: 'application/json; charset=utf-8', filename: `${sessionId}.json`};
  }

  /** 只做 dry-run：给出候选值与当前运行参数差异，绝不写配置。 */
  applyPlan(sessionId: string, root: string) {
    const session = this.requireSession(sessionId);
    const analysis = session.analysis ?? this.analyze(sessionId).analysis;
    const readParam = (file: string, key: string): number | null => {
      try {
        const path = resolvePath(root, 'config', file);
        if (!existsSync(path)) return null;
        const match = new RegExp(`^\\s*${key}\\s*:\\s*([-+0-9.eE]+)`, 'm').exec(readFileSync(path, 'utf8'));
        return match ? Number(match[1]) : null;
      } catch { return null; }
    };
    const proposed = {
      forwardScale: analysis.aggregate.forwardScale?.mean ?? null,
      lateralScale: analysis.aggregate.lateralScale,
      imuYawScale: analysis.aggregate.imuYawScale?.mean ?? null,
      visualImuDelayS: analysis.aggregate.delayS?.mean ?? null,
    };
    const current = {
      wheelVelocitySigmaMps: readParam('fusion_inputs.yaml', 'wheel_velocity_sigma_mps'),
      lateralConstraintSigmaMps: readParam('fusion_inputs.yaml', 'lateral_constraint_sigma_mps'),
      captureDelayS: readParam('camera_stream.yaml', 'capture_delay_s'),
    };
    return {
      applied: false,
      reason: '本轮只提供候选值预览：不会写入 fusion_inputs.yaml / camera_stream.yaml / navigation.yaml，也未重启任何服务。落地需人工评审与单独维护窗口。',
      proposed, current, analysisSaved: !!session.analysis,
    };
  }

  capabilities(): {recording: boolean; lastSampleAt: string | null; lastSampleKind: string | null} {
    const row = this.db.prepare("SELECT value FROM calibration_state WHERE key='lastSample'").get() as {value: string} | undefined;
    const active = this.activeTrial();
    let last: {at: string; kind: string} | null = null;
    try { last = row ? JSON.parse(row.value) : null; } catch { last = null; }
    return {recording: !!active, lastSampleAt: last?.at ?? null, lastSampleKind: last?.kind ?? null};
  }
}

export const calibrationDatabasePath = (database: string | undefined, root: string, configured: string) => {
  if (!database) return join(dirname(resolvePath(root, configured)), 'calibration.db');
  if (database === ':memory:') return ':memory:';
  return database.replace(/\.db$/i, '') + '-calibration.db';
};

/**
 * 运行标定 bias/up 快照读取（只读）。
 * 优先读最新的运行标定快照文件；找不到就返回 null，让分析明确输出“IMU 零偏缺数据”，
 * 绝不在分析里默认把 bias 当 0。
 */
export function imuCalibrationFromSnapshot(root: string): ImuCalibrationInfo | null {
  const candidates = [
    join(root, 'logs/imu-calibration-latest.json'),
    join(root, 'logs/imu-replacement-calibration-statistics.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as any;
      const calibration = raw?.lastFusion?.calibration ?? raw?.calibration ?? raw;
      if (!calibration || !Array.isArray(calibration.bias) || calibration.bias.length !== 3) continue;
      if (!calibration.bias.every((value: unknown) => Number.isFinite(value))) continue;
      const up = Array.isArray(calibration.up) && calibration.up.length === 3 && calibration.up.every((value: unknown) => Number.isFinite(value))
        ? calibration.up : [0, 0, 1];
      const capturedAt = typeof calibration.stamp === 'number'
        ? new Date(calibration.stamp * 1000).toISOString()
        : (typeof raw?.time === 'string' ? raw.time : null);
      return {
        bias: calibration.bias.map(Number), up: up.map(Number), source: path, capturedAt,
        variance: typeof calibration.variance === 'number' ? calibration.variance : null,
      };
    } catch { continue; }
  }
  return null;
}
