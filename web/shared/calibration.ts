/**
 * 融合标定 / 运动标定：共享 schema + 纯分析函数。
 *
 * 设计约束（来自产品要求）：
 * 1. 试验员输入的两个二维码真实中心距离是**外部基线**，不是车辆实际行程；
 *    它只用于独立校核（baselineResidual），绝不冒充视觉位移或车辆行程。
 * 2. 前端绝不提供时间戳：所有样本都带 ROS/后端原始 stamp。
 * 3. 视觉位移采用**端点停稳配对**：起点停稳窗口取二维码 A，终点停稳窗口取二维码 B，
 *    通过地图中 A/B 的位姿把两端观测各自转成 base_link 在地图中的位姿，再求相对位姿。
 *    不再要求同一帧同时看到 A 与 B（现场 A/B 相距 >1 m，单目相机物理上无法同帧共视）。
 * 4. 分析结果必须区分：可计算结果、依赖假设、缺数据、无效原因。
 * 5. 任何候选参数都只做“建议/预览”，不自动写运行配置。
 */
import {z} from 'zod';

export const CALIBRATION_SCHEMA_VERSION = 4;

export const trialTypeSchema = z.enum(['forward', 'reverse', 'left', 'right']);
export type TrialType = z.infer<typeof trialTypeSchema>;
export const trialTypeLabels: Record<TrialType, string> = {
  forward: '前进', reverse: '后退', left: '左转', right: '右转',
};

/**
 * 转向的物理旋向。内部一律用带符号的 yaw（逆时针为正、顺时针为负，ROS/REP-103 约定），
 * 左转 = 逆时针 = 正，右转 = 顺时针 = 负。页面只在这里把符号翻译成人能读的旋向，
 * 避免「目标 90° / 实测 -88.63°」这种同一行正负混用被读成差 178°。
 */
export const rotationSenseLabels: Record<'left' | 'right', string> = {left: '逆时针', right: '顺时针'};

/**
 * 方向一致性门限（度）。转向的实测转角符号与目标方向相反、且幅度超过该门限时，
 * 判 invalid_reason = turn_direction_mismatch。门限取 30° 是为了只抓“整段转反了”，
 * 不把小的反向抖动（同向重复性 σ≈3°）当成方向错误。
 */
export const TURN_DIRECTION_MISMATCH_MIN_DEG = 30;

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const stampSchema = z.number().finite().nonnegative();

export const calibrationSessionInputSchema = z.object({
  mapId: idSchema,
  mapVersion: z.number().int().positive(),
  tagA: z.number().int().min(0).max(586),
  tagB: z.number().int().min(0).max(586),
  /** 外部基线：两块二维码板中心的真实距离（米）。不是车辆行程。 */
  baselineM: z.number().finite().min(0.05).max(20),
  note: z.string().trim().max(500).default(''),
}).strict().superRefine((value, ctx) => {
  if (value.tagA === value.tagB) ctx.addIssue({code: z.ZodIssueCode.custom, message: '二维码 A 与 B 不能相同'});
});

export const calibrationTrialInputSchema = z.object({
  type: trialTypeSchema,
  /** 转向试验的目标/观测角度（度，左正右负）；前进/后退必须为空。 */
  angleDeg: z.number().finite().min(-180).max(180).nullable().default(null),
  /**
   * 转向发生处的二维码 id（取自当前绑定地图）。
   * 前进/后退不适用，必须为空；转向试验缺失时不在这里拒绝（历史数据也要能读出来），
   * 由分析阶段给出 invalid_reason = rotation_tag_missing，绝不用 A/B 或基线去猜。
   */
  rotationTagId: z.number().int().min(0).max(586).nullable().default(null),
  note: z.string().trim().max(500).default(''),
}).strict().superRefine((value, ctx) => {
  if (value.type === 'forward' || value.type === 'reverse') {
    if (value.angleDeg !== null) ctx.addIssue({code: z.ZodIssueCode.custom, message: '前进/后退试验不接受转角'});
    if (value.rotationTagId !== null) ctx.addIssue({code: z.ZodIssueCode.custom, message: '前进/后退试验不接受旋转二维码'});
    return;
  }
  if (value.angleDeg === null || Math.abs(value.angleDeg) < 5) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: '转向试验必须填写观测角度（至少 5°）'});
  }
  if (value.type === 'left' && value.angleDeg! < 0) ctx.addIssue({code: z.ZodIssueCode.custom, message: '左转角度必须为正'});
  if (value.type === 'right' && value.angleDeg! > 0) ctx.addIssue({code: z.ZodIssueCode.custom, message: '右转角度必须为负'});
});

export const trialStatusSchema = z.enum(['recording', 'saved', 'aborted', 'interrupted']);
export type TrialStatus = z.infer<typeof trialStatusSchema>;

export interface CalibrationTrial {
  id: string;
  sessionId: string;
  type: TrialType;
  angleDeg: number | null;
  /** 转向发生处的二维码 id（取自绑定地图）；前进/后退为 null。 */
  rotationTagId: number | null;
  /** 旋转二维码显示名（如 Q113）；未指定时为 null。 */
  rotationTagLabel: string | null;
  /** 旋转二维码在地图中的位姿（弧度）；地图缺失或无此码时为 null。 */
  rotationTagPose: Pose2 | null;
  repetition: number;
  note: string;
  status: TrialStatus;
  startedAt: string;
  endedAt: string | null;
  startedStamp: number | null;
  endedStamp: number | null;
}

export interface CalibrationSession {
  id: string;
  mapId: string;
  mapVersion: number;
  mapDigest: string;
  tagA: number;
  tagB: number;
  baselineM: number;
  baselineSource: 'external_baseline';
  note: string;
  created: string;
  trials: CalibrationTrial[];
  analysis: SessionAnalysis | null;
  applied: boolean;
}

/** 样本形状（与 ROS 侧真实消息字段一致，绝不由前端生成时间）。 */
export interface CalibrationObservationSample {
  stamp: number;
  frame?: string;
  calibrated?: boolean;
  synchronized?: boolean;
  representation?: string;
  groupLayouts?: unknown[];
  tags: {
    id: number; x: number; y: number; angle: number; sigma: number; angleSigma?: number; groupId?: string;
    /** 以下字段来自真实后端观测，用于停稳窗口的质量门限；缺省时不做该项筛选。 */
    visibleCount?: number; detectedCount?: number; reprojectionPx?: number; size?: number;
  }[];
}
export interface CalibrationFeedbackSample {
  stamp: number;
  vx: number;
  vyRaw?: number;
  vy: number;
  wz: number;
  bodyGear?: number;
  steeringGear?: number;
  seq?: number;
  feedbackSource?: string;
}
export interface CalibrationImuSample {
  stamp: number;
  gx: number;
  gy: number;
  gz: number;
  ax?: number;
  ay?: number;
  az?: number;
}
export interface CalibrationFusionSample {
  stamp: number;
  state?: string;
  epoch?: string;
  ready?: boolean;
  mappingReady?: boolean;
  calibration?: {bias: number[]; up: number[]; variance: number} | null;
}

export const sampleKindSchema = z.enum(['observation', 'feedback', 'imu', 'fusion']);
export type SampleKind = z.infer<typeof sampleKindSchema>;

/** 已入库样本（分析输入）：原始 stamp 由 ROS/后端提供。 */
export interface AnalysisSample {kind: SampleKind; stamp: number; trialId: string | null; body: unknown}

export const robotSampleBatchSchema = z.object({
  sessionId: idSchema,
  trialId: idSchema.nullable().default(null),
  samples: z.array(z.object({
    kind: sampleKindSchema,
    stamp: stampSchema,
  }).passthrough()).min(1).max(400),
}).strict();

/** ---------- SE2 与统计 ---------- */
export interface Pose2 {x: number; y: number; yaw: number}
export const wrapPi = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
export const deg = (rad: number) => rad * 180 / Math.PI;
export const rad = (degree: number) => degree * Math.PI / 180;
/** 二维码显示名：Q113。前后端与报告共用同一套写法，避免出现 113 / Q113 混用。 */
export const tagCode = (id: number | null | undefined): string | null =>
  id === null || id === undefined || !Number.isFinite(id) ? null : 'Q' + String(id).padStart(3, '0');

/** 转向目标角的统一文案：右转 90°（顺时针）/ 左转 90°（逆时针）。目标角恒以正数呈现。 */
export function turnTargetPhrase(direction: 'left' | 'right' | null, targetAngleDeg: number | null): string {
  if (direction === null) return '—';
  const magnitude = targetAngleDeg === null || !Number.isFinite(targetAngleDeg) ? '—' : `${Math.abs(targetAngleDeg).toFixed(0)}°`;
  return `${trialTypeLabels[direction]} ${magnitude}（${rotationSenseLabels[direction]}）`;
}

/** 带符号的目标角（右负左正），与 measuredAngleDeg 同一约定；内部计算与 CSV 用。 */
export function signedTurnAngle(direction: 'left' | 'right' | null, targetAngleDeg: number | null): number | null {
  if (direction === null || targetAngleDeg === null || !Number.isFinite(targetAngleDeg)) return null;
  return direction === 'right' ? -Math.abs(targetAngleDeg) : Math.abs(targetAngleDeg);
}

/**
 * 方向一致性：目标方向与实测转角的符号是否相反。
 * 只有幅度超过 minDeg 才算“转反了”，小幅反向（<30°）留给误差统计去说明，不判无效。
 */
export function turnDirectionMismatch(direction: 'left' | 'right' | null, measuredAngleDeg: number | null, minDeg = TURN_DIRECTION_MISMATCH_MIN_DEG): boolean {
  if (direction === null || measuredAngleDeg === null || !Number.isFinite(measuredAngleDeg)) return false;
  if (!(Math.abs(measuredAngleDeg) > minDeg)) return false;
  return direction === 'right' ? measuredAngleDeg > 0 : measuredAngleDeg < 0;
}
export function inverse(p: Pose2): Pose2 {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  return {x: -c * p.x - s * p.y, y: s * p.x - c * p.y, yaw: wrapPi(-p.yaw)};
}
export function compose(a: Pose2, b: Pose2): Pose2 {
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  return {x: a.x + c * b.x - s * b.y, y: a.y + s * b.x + c * b.y, yaw: wrapPi(a.yaw + b.yaw)};
}
export const relative = (from: Pose2, to: Pose2) => compose(inverse(from), to);

export interface Stats {n: number; mean: number; std: number; min: number; max: number; median: number; mad: number}
export function stats(values: number[]): Stats | null {
  const finite = values.filter(value => Number.isFinite(value));
  if (!finite.length) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance = finite.length > 1 ? finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (finite.length - 1) : 0;
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  const deviation = finite.map(value => Math.abs(value - median)).sort((a, b) => a - b);
  const mad = deviation.length % 2 ? deviation[(deviation.length - 1) / 2]! : (deviation[deviation.length / 2 - 1]! + deviation[deviation.length / 2]!) / 2;
  return {n: finite.length, mean, std: Math.sqrt(variance), min: sorted[0]!, max: sorted[sorted.length - 1]!, median, mad};
}
/** 用 median ± k·1.4826·MAD 标出离群，样本不足或 MAD=0 时不删点。 */
export function outlierMask(values: number[], k = 3.5): boolean[] {
  const base = stats(values);
  if (!base || base.n < 4) return values.map(() => false);
  const spread = 1.4826 * base.mad;
  if (!(spread > 0)) return values.map(() => false);
  return values.map(value => Math.abs(value - base.median) > k * spread);
}

export function circularMean(values: number[]): number | null {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  const sin = finite.reduce((sum, value) => sum + Math.sin(value), 0) / finite.length;
  const cos = finite.reduce((sum, value) => sum + Math.cos(value), 0) / finite.length;
  return Math.atan2(sin, cos);
}

const median = (values: number[]): number | null => stats(values)?.median ?? null;

/** ---------- 旧路径：同帧双码（仅用于旧数据兼容与延迟候选，不再作为主算法） ---------- */
export interface VisualPair {stamp: number; pose: Pose2; distanceM: number; bearingRad: number; nTags: number}
export function visualRelativePoses(observations: CalibrationObservationSample[], tagA: number, tagB: number): VisualPair[] {
  const result: VisualPair[] = [];
  for (const sample of observations) {
    if (!Number.isFinite(sample.stamp) || !Array.isArray(sample.tags)) continue;
    const a = sample.tags.find(tag => tag.id === tagA);
    const b = sample.tags.find(tag => tag.id === tagB);
    if (!a || !b) continue;
    if (![a.x, a.y, a.angle, b.x, b.y, b.angle].every(value => Number.isFinite(value))) continue;
    const pose = relative({x: a.x, y: a.y, yaw: a.angle}, {x: b.x, y: b.y, yaw: b.angle});
    result.push({stamp: sample.stamp, pose, distanceM: Math.hypot(pose.x, pose.y), bearingRad: Math.atan2(pose.y, pose.x), nTags: sample.tags.length});
  }
  return result.sort((x, y) => x.stamp - y.stamp);
}

/** ---------- 里程计积分 ---------- */
export interface WheelIntegral {
  startStamp: number; endStamp: number; durationS: number;
  /** 车体系纵向积分 ∫vx dt（旧口径，仅作对照）。 */
  forwardM: number; lateralM: number; travelM: number;
  /** 世界系积分得到的净位移与路径长（按中间航向积分）。 */
  netM: number; xM: number; yM: number;
  yawChangeRad: number; yawChangeDeg: number;
  /** wz 是否可用；wz 恒为 0 时轮速转角不可用，不得当作“转过的角度”。 */
  yawAvailable: boolean; yawUnavailableReason: string | null;
  samples: number; gaps: number; maxGapS: number;
}
export function integrateFeedback(samples: CalibrationFeedbackSample[]): WheelIntegral | null {
  const sorted = samples.filter(sample => Number.isFinite(sample.stamp) && Number.isFinite(sample.vx) && Number.isFinite(sample.vy) && Number.isFinite(sample.wz))
    .sort((a, b) => a.stamp - b.stamp);
  if (sorted.length < 2) return null;
  let x = 0, y = 0, yaw = 0, gaps = 0, maxGap = 0, forward = 0, lateral = 0, travel = 0;
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!, current = sorted[index]!;
    const dt = current.stamp - previous.stamp;
    if (!(dt > 0)) continue;
    if (dt > 0.3) { gaps++; continue; }
    maxGap = Math.max(maxGap, dt);
    const vx = (previous.vx + current.vx) / 2, vy = (previous.vy + current.vy) / 2, wz = (previous.wz + current.wz) / 2;
    const mid = yaw + wz * dt / 2;
    const dx = (vx * Math.cos(mid) - vy * Math.sin(mid)) * dt;
    const dy = (vx * Math.sin(mid) + vy * Math.cos(mid)) * dt;
    x += dx; y += dy; yaw = wrapPi(yaw + wz * dt);
    forward += vx * dt; lateral += vy * dt; travel += Math.hypot(dx, dy);
  }
  // wz 恒为 0 是“未提供轮速偏航”的特征，不是“没有转向”。
  const yawAvailable = sorted.some(sample => Math.abs(sample.wz) > 1e-9);
  return {
    startStamp: sorted[0]!.stamp, endStamp: sorted[sorted.length - 1]!.stamp,
    durationS: sorted[sorted.length - 1]!.stamp - sorted[0]!.stamp,
    forwardM: forward, lateralM: lateral, travelM: travel,
    netM: Math.hypot(x, y), xM: x, yM: y,
    yawChangeRad: yaw, yawChangeDeg: deg(yaw),
    yawAvailable, yawUnavailableReason: yawAvailable ? null : 'wz_all_zero',
    samples: sorted.length, gaps, maxGapS: maxGap,
  };
}

/** ---------- IMU yaw 积分 ---------- */
export interface ImuIntegral {
  startStamp: number; endStamp: number; durationS: number;
  yawChangeRad: number; yawChangeDeg: number;
  rateRadS: {stamp: number; rate: number}[];
  projected: boolean; samples: number; gaps: number;
}
export function integrateImuYaw(samples: CalibrationImuSample[], calibration?: {bias: number[]; up: number[]} | null): ImuIntegral | null {
  const usable = samples.filter(sample => Number.isFinite(sample.stamp) && [sample.gx, sample.gy, sample.gz].every(Number.isFinite))
    .sort((a, b) => a.stamp - b.stamp);
  if (usable.length < 2) return null;
  const bias = calibration && calibration.bias?.length === 3 ? calibration.bias : null;
  const up = calibration && calibration.up?.length === 3 ? calibration.up : null;
  const rates = usable.map(sample => {
    const gyro = [sample.gx, sample.gy, sample.gz];
    const rate = bias && up ? (gyro[0]! - bias[0]!) * up[0]! + (gyro[1]! - bias[1]!) * up[1]! + (gyro[2]! - bias[2]!) * up[2]! : sample.gz;
    return {stamp: sample.stamp, rate};
  });
  let yaw = 0, gaps = 0;
  for (let index = 1; index < rates.length; index++) {
    const dt = rates[index]!.stamp - rates[index - 1]!.stamp;
    if (!(dt > 0)) continue;
    if (dt > 0.3) { gaps++; continue; }
    yaw += (rates[index - 1]!.rate + rates[index]!.rate) / 2 * dt;
  }
  return {
    startStamp: usable[0]!.stamp, endStamp: usable[usable.length - 1]!.stamp,
    durationS: usable[usable.length - 1]!.stamp - usable[0]!.stamp,
    yawChangeRad: wrapPi(yaw), yawChangeDeg: deg(wrapPi(yaw)), rateRadS: rates,
    projected: !!(bias && up), samples: usable.length, gaps,
  };
}

/** 运行标定来源：必须显式记录从哪读到 bias，不允许默认当 0。 */
export interface ImuCalibrationInfo {
  bias: number[]; up: number[];
  source: string;
  capturedAt: string | null;
  variance: number | null;
}

/** ---------- 端点停稳配对（主算法） ---------- */
export interface StopWindowOptions {
  /** 判定“在动”的阈值。 */
  moveVxMps: number; moveVyMps: number; moveWzRadS: number;
  /** 停稳窗口在运动区间外的保护时间。 */
  guardS: number;
  /** 端点最少观测帧数与最短时间跨度。 */
  minSamples: number; minSpanS: number;
  /** 停稳一致性：位置离散度与朝向离散度上限。 */
  maxPositionSpreadM: number; maxYawSpreadDeg: number;
  /** 单帧质量门限。 */
  minVisibleCount: number; maxSigmaM: number; maxReprojectionPx: number;
  /** 窗口内允许的最大观测间隔。 */
  maxGapS: number;
}
export const defaultStopWindowOptions: StopWindowOptions = {
  moveVxMps: 0.01, moveVyMps: 0.01, moveWzRadS: 0.02,
  guardS: 0.05,
  minSamples: 3, minSpanS: 0.15,
  maxPositionSpreadM: 0.02, maxYawSpreadDeg: 2.0,
  minVisibleCount: 5, maxSigmaM: 0.02, maxReprojectionPx: 1.5,
  maxGapS: 0.6,
};

export interface EndpointPick {
  tagId: number;
  /** 窗口内该码的候选帧数（未过质量门限前）。 */
  candidates: number;
  /** 通过质量门限的帧数。 */
  qualified: number;
  /** 最终选中的帧数。 */
  selected: number;
  stamps: number[];
  pose: Pose2 | null;
  spreadM: number | null;
  spreadDeg: number | null;
  window: {from: number; to: number} | null;
  valid: boolean;
  invalidReason: string | null;
  rejected: {lowVisibility: number; highSigma: number; highReprojection: number; outliers: number};
}

const emptyPick = (tagId: number, reason: string, window: {from: number; to: number} | null = null): EndpointPick => ({
  tagId, candidates: 0, qualified: 0, selected: 0, stamps: [], pose: null,
  spreadM: null, spreadDeg: null, window, valid: false, invalidReason: reason,
  rejected: {lowVisibility: 0, highSigma: 0, highReprojection: 0, outliers: 0},
});

export function pickEndpoint(input: {
  observations: CalibrationObservationSample[];
  tagId: number;
  from: number;
  to: number;
  options?: Partial<StopWindowOptions>;
}): EndpointPick {
  const options = {...defaultStopWindowOptions, ...input.options};
  const window = {from: input.from, to: input.to};
  if (!(input.to > input.from)) return emptyPick(input.tagId, 'invalid_time_order', window);
  const rows: {stamp: number; tag: NonNullable<CalibrationObservationSample['tags']>[number]}[] = [];
  for (const sample of input.observations) {
    if (!Number.isFinite(sample.stamp) || sample.stamp < input.from || sample.stamp > input.to) continue;
    if (!Array.isArray(sample.tags)) continue;
    const tag = sample.tags.find(item => item.id === input.tagId);
    if (!tag) continue;
    if (![tag.x, tag.y, tag.angle].every(Number.isFinite)) continue;
    rows.push({stamp: sample.stamp, tag});
  }
  const pick = emptyPick(input.tagId, '', window);
  pick.candidates = rows.length;
  if (!rows.length) { pick.invalidReason = 'tag_not_observed'; return pick; }

  const rejected = {lowVisibility: 0, highSigma: 0, highReprojection: 0, outliers: 0};
  const qualified = rows.filter(row => {
    if (typeof row.tag.visibleCount === 'number' && row.tag.visibleCount < options.minVisibleCount) { rejected.lowVisibility++; return false; }
    if (typeof row.tag.sigma === 'number' && row.tag.sigma > options.maxSigmaM) { rejected.highSigma++; return false; }
    if (typeof row.tag.reprojectionPx === 'number' && row.tag.reprojectionPx > options.maxReprojectionPx) { rejected.highReprojection++; return false; }
    return true;
  });
  pick.rejected = rejected;
  pick.qualified = qualified.length;
  if (qualified.length < options.minSamples) { pick.invalidReason = 'insufficient_quality_samples'; return pick; }

  // 停稳窗口内允许出现观测断流（例如终点刚停车时 B 才重新进入视野）。
  // 按 maxGapS 切成连续段，取样本最多的一段作为停稳证据，而不是整段作废；
  // 绝不跨缺口拼接位姿。
  const runs: (typeof qualified)[] = [];
  let current: typeof qualified = [];
  for (const row of qualified) {
    if (current.length && row.stamp - current[current.length - 1]!.stamp > options.maxGapS) { runs.push(current); current = []; }
    current.push(row);
  }
  if (current.length) runs.push(current);
  runs.sort((a, b) => (b.length - a.length) || ((b[b.length - 1]!.stamp - b[0]!.stamp) - (a[a.length - 1]!.stamp - a[0]!.stamp)));
  const chosen = runs[0] ?? [];
  if (chosen.length < options.minSamples) { pick.invalidReason = 'insufficient_quality_samples'; return pick; }
  const span = chosen[chosen.length - 1]!.stamp - chosen[0]!.stamp;
  if (span < options.minSpanS) { pick.invalidReason = 'insufficient_span'; return pick; }

  // 用位置中位数做一次 MAD 剔除，避免把明显跳变的帧当成停稳证据。
  const xs = chosen.map(row => row.tag.x), ys = chosen.map(row => row.tag.y);
  const mx = median(xs)!, my = median(ys)!;
  const radial = chosen.map(row => Math.hypot(row.tag.x - mx, row.tag.y - my));
  const radialMedian = median(radial)!;
  const radialDeviation = radial.map(value => Math.abs(value - radialMedian));
  const mad = median(radialDeviation)!;
  const limit = mad > 0 ? 3.5 * 1.4826 * mad : Infinity;
  const kept = chosen.filter((_, index) => radial[index]! <= radialMedian + limit);
  rejected.outliers = chosen.length - kept.length;
  if (kept.length < options.minSamples) { pick.invalidReason = 'insufficient_after_outlier_rejection'; return pick; }

  const keptX = kept.map(row => row.tag.x), keptY = kept.map(row => row.tag.y);
  const sx = stats(keptX)!, sy = stats(keptY)!;
  const spreadM = Math.max(sx.std, sy.std);
  if (spreadM > options.maxPositionSpreadM) { pick.invalidReason = 'unstable_stop_position'; pick.spreadM = spreadM; return pick; }
  const yawMean = circularMean(kept.map(row => row.tag.angle))!;
  const yawDeviation = Math.max(...kept.map(row => Math.abs(deg(wrapPi(row.tag.angle - yawMean)))));
  if (yawDeviation > options.maxYawSpreadDeg) { pick.invalidReason = 'unstable_stop_yaw'; pick.spreadDeg = yawDeviation; return pick; }

  pick.selected = kept.length;
  pick.stamps = kept.map(row => Number(row.stamp.toFixed(3)));
  pick.pose = {x: median(keptX)!, y: median(keptY)!, yaw: yawMean};
  pick.spreadM = spreadM;
  pick.spreadDeg = yawDeviation;
  pick.valid = true;
  pick.invalidReason = null;
  return pick;
}

export interface StopPointResult {
  /** 端点选样统计：用于审计“为什么这几次试验没算出视觉位移”。seeA/seeB 始终指会话的 A/B。 */
  counts: {total: number; seeA: number; seeB: number; both: number; neither: number};
  /** 本次配对实际使用的端点二维码：前进/后退是 A→B；转向是同一个旋转二维码。 */
  pairing: {startTagId: number; endTagId: number; kind: 'a_to_b' | 'same_tag'};
  start: EndpointPick;
  end: EndpointPick;
  mapTags: {tagA: Pose2 | null; tagB: Pose2 | null; start: Pose2 | null; end: Pose2 | null};
  /** 起点/终点 base_link 在地图中的位姿。 */
  startPoseMap: Pose2 | null;
  endPoseMap: Pose2 | null;
  /** 终点相对起点的 base_link 相对位姿（视觉）。 */
  visualRelativePose: Pose2 | null;
  visualNetDistance: number | null;
  visualForwardM: number | null;
  visualLateralM: number | null;
  visualYawDeg: number | null;
  /** 外部基线残差；转向试验不适用（baselineM=null）时为 null。 */
  baselineResidualM: number | null;
  baselineRatio: number | null;
  motion: {startStamp: number | null; endStamp: number | null; stillnessSource: string};
  valid: boolean;
  invalidReason: string | null;
}

/**
 * 端点停稳配对：
 *   T_map_base(start) = T_map_startTag ∘ inv(T_base_startTag(start))
 *   T_map_base(end)   = T_map_endTag   ∘ inv(T_base_endTag(end))
 *   visualRelativePose = inv(T_map_base(start)) ∘ T_map_base(end)
 * 前进/后退：startTag=A、endTag=B，给的是位移；
 * 转向：startTag=endTag=旋转二维码，给的是原地转角（此时不给基线残差）。
 * 地图 tag 的 angle 以度存储，观测 angle 以弧度存储，这里统一换成弧度。
 */
export function analyzeStopPoint(input: {
  observations: CalibrationObservationSample[];
  feedback: CalibrationFeedbackSample[];
  /** 仅用于 seeA/seeB/both 审计统计（会话的 A/B）。 */
  tagA: number;
  tagB: number;
  /** 实际配对端点。 */
  startTagId: number;
  endTagId: number;
  /** 外部基线；转向试验传 null（不产生基线残差）。 */
  baselineM: number | null;
  trial: {startedStamp: number | null; endedStamp: number | null};
  mapTags?: {tagA: Pose2 | null; tagB: Pose2 | null; byId?: Record<string, Pose2 | null>};
  options?: Partial<StopWindowOptions>;
}): StopPointResult {
  const options = {...defaultStopWindowOptions, ...input.options};
  const observations = input.observations.filter(sample => Number.isFinite(sample.stamp)).sort((a, b) => a.stamp - b.stamp);
  const counts = {total: observations.length, seeA: 0, seeB: 0, both: 0, neither: 0};
  for (const sample of observations) {
    const ids = new Set((sample.tags ?? []).map(tag => tag.id));
    const a = ids.has(input.tagA), b = ids.has(input.tagB);
    if (a) counts.seeA++;
    if (b) counts.seeB++;
    if (a && b) counts.both++;
    if (!a && !b) counts.neither++;
  }
  const poseOf = (tagId: number): Pose2 | null => {
    const byId = input.mapTags?.byId;
    if (byId && Object.prototype.hasOwnProperty.call(byId, String(tagId))) return byId[String(tagId)] ?? null;
    if (tagId === input.tagA) return input.mapTags?.tagA ?? null;
    if (tagId === input.tagB) return input.mapTags?.tagB ?? null;
    return null;
  };
  const startTagPose = poseOf(input.startTagId), endTagPose = poseOf(input.endTagId);
  const mapTags = {tagA: input.mapTags?.tagA ?? null, tagB: input.mapTags?.tagB ?? null, start: startTagPose, end: endTagPose};
  const pairing = {
    startTagId: input.startTagId, endTagId: input.endTagId,
    kind: input.startTagId === input.endTagId ? 'same_tag' as const : 'a_to_b' as const,
  };
  const feedback = input.feedback.filter(sample => Number.isFinite(sample.stamp)).sort((a, b) => a.stamp - b.stamp);
  const moving = feedback.filter(sample => Math.abs(sample.vx) > options.moveVxMps || Math.abs(sample.vy) > options.moveVyMps || Math.abs(sample.wz) > options.moveWzRadS);
  const firstStamp = input.trial.startedStamp ?? (feedback[0]?.stamp ?? observations[0]?.stamp ?? null);
  const lastStamp = input.trial.endedStamp ?? (feedback.at(-1)?.stamp ?? observations.at(-1)?.stamp ?? null);
  const motionStart = moving.length ? moving[0]!.stamp : null;
  const motionEnd = moving.length ? moving[moving.length - 1]!.stamp : null;

  const base: StopPointResult = {
    counts, pairing,
    start: emptyPick(input.startTagId, 'no_stillness_window'), end: emptyPick(input.endTagId, 'no_stillness_window'), mapTags,
    startPoseMap: null, endPoseMap: null, visualRelativePose: null,
    visualNetDistance: null, visualForwardM: null, visualLateralM: null, visualYawDeg: null,
    baselineResidualM: null, baselineRatio: null,
    motion: {startStamp: motionStart, endStamp: motionEnd, stillnessSource: feedback.length ? 'feedback_velocity' : 'none'},
    valid: false, invalidReason: null,
  };
  if (firstStamp === null || lastStamp === null) { base.invalidReason = 'missing_trial_bounds'; return base; }
  if (!feedback.length) { base.invalidReason = 'no_feedback_stillness_evidence'; return base; }
  if (motionStart === null || motionEnd === null) { base.invalidReason = 'no_motion_detected'; return base; }
  if (!(lastStamp > firstStamp)) { base.invalidReason = 'invalid_time_order'; return base; }

  base.start = pickEndpoint({observations, tagId: input.startTagId, from: firstStamp, to: motionStart + options.guardS, options});
  base.end = pickEndpoint({observations, tagId: input.endTagId, from: motionEnd - options.guardS, to: lastStamp, options});

  if (!startTagPose || !endTagPose) { base.invalidReason = 'missing_map_tag_pose'; return base; }
  if (!base.start.valid) { base.invalidReason = 'start_endpoint_' + (base.start.invalidReason ?? 'invalid'); return base; }
  if (!base.end.valid) { base.invalidReason = 'end_endpoint_' + (base.end.invalidReason ?? 'invalid'); return base; }
  if (!(base.end.stamps[0]! > base.start.stamps.at(-1)!)) { base.invalidReason = 'endpoints_out_of_order'; return base; }

  base.startPoseMap = compose(startTagPose, inverse(base.start.pose!));
  base.endPoseMap = compose(endTagPose, inverse(base.end.pose!));
  const pose = relative(base.startPoseMap, base.endPoseMap);
  base.visualRelativePose = pose;
  base.visualNetDistance = Math.hypot(pose.x, pose.y);
  base.visualForwardM = pose.x;
  base.visualLateralM = pose.y;
  base.visualYawDeg = deg(pose.yaw);
  base.baselineResidualM = input.baselineM === null ? null : base.visualNetDistance - input.baselineM;
  base.baselineRatio = input.baselineM !== null && input.baselineM > 0 ? base.visualNetDistance / input.baselineM : null;
  base.valid = true;
  return base;
}

/** ---------- 时间延迟候选（视觉方位角速率 vs IMU 角速度） ---------- */
export interface DelayEstimate {delayS: number; correlation: number; pairs: number}
function correlateBearingRates(bearingRates: {stamp: number; rate: number}[], imuRates: {stamp: number; rate: number}[], range = {min: -0.3, max: 0.3, step: 0.005}): DelayEstimate | null {
  if (bearingRates.length < 6 || imuRates.length < 6) return null;
  const sampleRate = (table: {stamp: number; rate: number}[], stamp: number) => {
    let best: {stamp: number; rate: number} | null = null;
    let bestGap = Infinity;
    for (const row of table) {
      const gap = Math.abs(row.stamp - stamp);
      if (gap < bestGap) { bestGap = gap; best = row; }
    }
    return best && bestGap <= 0.06 ? best.rate : null;
  };
  let best: DelayEstimate | null = null;
  for (let delay = range.min; delay <= range.max + 1e-9; delay += range.step) {
    const xs: number[] = [], ys: number[] = [];
    for (const row of bearingRates) {
      const rate = sampleRate(imuRates, row.stamp - delay);
      if (rate === null) continue;
      xs.push(-row.rate); ys.push(rate);
    }
    if (xs.length < 6) continue;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let index = 0; index < xs.length; index++) { sxy += (xs[index]! - mx) * (ys[index]! - my); sxx += (xs[index]! - mx) ** 2; syy += (ys[index]! - my) ** 2; }
    if (!(sxx > 0) || !(syy > 0)) continue;
    const correlation = sxy / Math.sqrt(sxx * syy);
    if (!best || Math.abs(correlation) > Math.abs(best.correlation)) best = {delayS: Number(delay.toFixed(3)), correlation, pairs: xs.length};
  }
  return best && best.pairs >= 6 ? best : null;
}
export function estimateVisualImuDelay(pairs: VisualPair[], imuRates: {stamp: number; rate: number}[], range = {min: -0.3, max: 0.3, step: 0.005}): DelayEstimate | null {
  const bearingRates: {stamp: number; rate: number}[] = [];
  for (let index = 1; index < pairs.length; index++) {
    const dt = pairs[index]!.stamp - pairs[index - 1]!.stamp;
    if (!(dt > 0.005) || dt > 0.4) continue;
    bearingRates.push({stamp: (pairs[index]!.stamp + pairs[index - 1]!.stamp) / 2, rate: wrapPi(pairs[index]!.bearingRad - pairs[index - 1]!.bearingRad) / dt});
  }
  return correlateBearingRates(bearingRates, imuRates, range);
}

/**
 * 单码连续段延迟候选：A/B 不共视时，用同一码的最长连续观测段估计方位角速率。
 * 直线行驶时方位角几乎不变（无激励），此时返回 null 并说明原因，不硬凑数字。
 */
export interface SingleTagDelayResult {estimate: DelayEstimate | null; reason: string | null; tagId: number | null; samples: number; rateStd: number | null}
export function estimateSingleTagDelay(observations: CalibrationObservationSample[], tagIds: number[], imuRates: {stamp: number; rate: number}[]): SingleTagDelayResult {
  let best: {tagId: number; rows: {stamp: number; bearing: number}[]} | null = null;
  for (const tagId of tagIds) {
    let run: {stamp: number; bearing: number}[] = [];
    const flush = () => { if (run.length >= 8 && (!best || run.length > best.rows.length)) best = {tagId, rows: [...run]}; };
    for (const sample of [...observations].sort((a, b) => a.stamp - b.stamp)) {
      const tag = sample.tags?.find(item => item.id === tagId);
      if (!tag || ![tag.x, tag.y].every(Number.isFinite)) { flush(); run = []; continue; }
      if (run.length && sample.stamp - run.at(-1)!.stamp > 0.4) { flush(); run = []; }
      run.push({stamp: sample.stamp, bearing: Math.atan2(tag.y, tag.x)});
    }
    flush();
  }
  if (!best) return {estimate: null, reason: 'insufficient_continuous_segment', tagId: null, samples: 0, rateStd: null};
  const chosen: {tagId: number; rows: {stamp: number; bearing: number}[]} = best;
  const bearingRates: {stamp: number; rate: number}[] = [];
  for (let index = 1; index < chosen.rows.length; index++) {
    const dt = chosen.rows[index]!.stamp - chosen.rows[index - 1]!.stamp;
    if (!(dt > 0.005) || dt > 0.4) continue;
    bearingRates.push({stamp: (chosen.rows[index]!.stamp + chosen.rows[index - 1]!.stamp) / 2, rate: wrapPi(chosen.rows[index]!.bearing - chosen.rows[index - 1]!.bearing) / dt});
  }
  const rateStd = bearingRates.length > 2 ? stats(bearingRates.map(row => row.rate))!.std : null;
  if (rateStd === null || rateStd < 0.05) return {estimate: null, reason: 'no_angular_excitation', tagId: chosen.tagId, samples: chosen.rows.length, rateStd};
  const estimate = correlateBearingRates(bearingRates, imuRates);
  return {estimate, reason: estimate ? null : 'correlation_unavailable', tagId: chosen.tagId, samples: chosen.rows.length, rateStd};
}

/** ---------- 单次试验分析 ---------- */
export type MeasuredAngleSource = 'imu_bias_corrected' | 'wheel_wz' | 'visual_same_tag' | 'imu_raw';

export interface TrialAnalysis {
  trialId: string; type: TrialType; repetition: number; angleDeg: number | null; status: TrialStatus;
  /** 转向发生处的二维码：前进/后退为 null，不强制。 */
  rotationTagId: number | null;
  rotationTagLabel: string | null;
  rotationTagPose: Pose2 | null;
  /** 转向方向：由试验类型给出（left/right）；前进/后退为 null。 */
  rotationDirection: 'left' | 'right' | null;
  /** 目标转角（度，取录入角度的绝对值；方向见 rotationDirection）。 */
  targetAngleDeg: number | null;
  /** 带符号目标角（度，右负左正），与 measuredAngleDeg 同一约定；并列显示与 CSV 用。 */
  signedTargetAngleDeg: number | null;
  /** 目标角的可读文案：右转 90°（顺时针）；前进/后退为 null。 */
  targetAnglePhrase: string | null;
  /** 实测转角（度，带符号：左正右负）。 */
  measuredAngleDeg: number | null;
  /** 实测转角取自哪一路真实测量。 */
  measuredAngleSource: MeasuredAngleSource | null;
  /**
   * 方向一致性：目标方向与实测符号相反（幅度 > TURN_DIRECTION_MISMATCH_MIN_DEG）。
   * 为 true 时整条试验判无效并给出 turn_direction_mismatch，但所有原始数值原样保留，
   * 绝不清零、不取绝对值、不改符号——现场那次确实转反了，证据要留着。
   */
  directionMismatch: boolean;
  window: {startedAt: string; endedAt: string | null; durationS: number | null};
  sampleCounts: {observation: number; feedback: number; imu: number; fusion: number};
  stampRange: {first: number | null; last: number | null};
  /** 主结果：端点停稳配对。 */
  stopPoint: StopPointResult;
  visualRelativePose: Pose2 | null;
  visualNetDistance: number | null;
  baselineResidual: number | null;
  wheelNetDistance: number | null;
  wheelPathDistance: number | null;
  imuYawRaw: number | null;
  imuYawBiasCorrected: number | null;
  timeOffsetCandidate: {delayS: number; correlation: number; pairs: number; method: string} | null;
  timeOffsetUnavailableReason: string | null;
  imuBias: {bias: number[] | null; up: number[] | null; source: string; capturedAt: string | null} | null;
  wheelYawStatus: {available: boolean; reason: string | null};
  fusionStatus: {state: 'not_integrated' | 'present'; samples: number; message: string};
  valid: boolean;
  invalidReason: string | null;
  excludedFromAggregate: boolean;
  excludedReason: string | null;
  /** 旧口径（同帧双码）保留，仅用于旧数据兼容展示。 */
  visual: {pairs: number; baselineM: Stats | null; bearingDeg: Stats | null; meanPose: Pose2 | null} | null;
  visualVsBaseline: {ratio: number | null; deltaM: number | null} | null;
  wheel: WheelIntegral | null;
  imu: ImuIntegral | null;
  imuRaw: ImuIntegral | null;
  imuCorrected: ImuIntegral | null;
  delay: DelayEstimate | null;
  candidates: {
    forwardScale: number | null; lateralScale: number | null;
    /** 仅作独立校核：轮速净位移 ÷ 外部基线，不是标定值。 */
    wheelVsBaselineRatio: number | null;
    imuYawScale: number | null; wheelYawScale: number | null;
    turnErrorDeg: {wheelVsObserved: number | null; imuVsObserved: number | null; imuVsWheel: number | null} | null;
  };
  computable: string[];
  assumptions: string[];
  missing: string[];
  faults: string[];
}

export interface SessionAnalysis {
  schemaVersion: number;
  sessionId: string;
  mapId: string; mapVersion: number; mapDigest: string;
  tagA: number; tagB: number; baselineM: number; baselineSource: 'external_baseline';
  createdAt: string; analyzedAt: string;
  sampleCounts: {observation: number; feedback: number; imu: number; fusion: number};
  stampRange: {first: number | null; last: number | null};
  imuBias: {bias: number[] | null; up: number[] | null; source: string; capturedAt: string | null} | null;
  trials: TrialAnalysis[];
  aggregate: {
    validTrials: number; excluded: {trialId: string; reason: string}[];
    /** 有效的前进/后退试验数（位移类统计只取这一组）。 */
    linearTrials: number;
    /** 有效的转向试验数（角度类统计只取这一组）。 */
    turnTrials: number;
    /** 未指定旋转二维码的转向试验数（这些试验被判无效，不进入统计）。 */
    turnTrialsMissingRotationTag: number;
    /** 实测方向与目标方向相反（turn_direction_mismatch）的转向试验数，已排除出统计。 */
    turnTrialsDirectionMismatch: number;
    /** 转向试验用到的二维码统计：Q113 × 2 次（有效 2）。按全部转向试验计数，validTrials 单独给出。 */
    rotationTags: {tagId: number; label: string; trials: number; validTrials: number}[];
    forwardScale: Stats | null; lateralScale: number | null; imuYawScale: Stats | null;
    wheelYawScale: Stats | null; delayS: Stats | null; turnErrorDeg: Stats | null;
    targetAngleDeg: Stats | null; measuredAngleDeg: Stats | null;
    /** 实测转角的幅值 |measured|：左右转混在一起时，只有幅值均值有物理意义。 */
    measuredAngleMagnitudeDeg: Stats | null;
    visualBaselineM: Stats | null; visualBaselineRatio: Stats | null;
    visualNetDistance: Stats | null; baselineResidualM: Stats | null;
    outliers: {forwardScale: number[]; imuYawScale: number[]; turnErrorDeg: number[]};
  };
  limitations: string[];
  formulas: string[];
}

const meanOrNull = (values: number[]) => stats(values)?.mean ?? null;

export function analyzeTrial(input: {
  trial: CalibrationTrial;
  observations: CalibrationObservationSample[];
  feedback: CalibrationFeedbackSample[];
  imu: CalibrationImuSample[];
  fusion: CalibrationFusionSample[];
  tagA: number; tagB: number; baselineM: number;
  mapTags?: {tagA: Pose2 | null; tagB: Pose2 | null; byId?: Record<string, Pose2 | null>};
  imuCalibration?: ImuCalibrationInfo | null;
  options?: Partial<StopWindowOptions>;
}): TrialAnalysis {
  const {trial, observations, feedback, imu, fusion, tagA, tagB, baselineM} = input;
  const computable: string[] = [], assumptions: string[] = [], missing: string[] = [], faults: string[] = [];
  const isTurn = trial.type === 'left' || trial.type === 'right';
  const rotationDirection: 'left' | 'right' | null = trial.type === 'left' ? 'left' : trial.type === 'right' ? 'right' : null;
  const targetAngleDeg = isTurn && trial.angleDeg !== null ? Math.abs(trial.angleDeg) : null;
  // 同一行显示时目标角也走带符号约定（右负左正），与实测角同号，不再出现「+90 / −88.6」的假矛盾。
  const signedTargetAngleDeg = isTurn ? signedTurnAngle(rotationDirection, targetAngleDeg) : null;
  const targetAnglePhrase = isTurn ? turnTargetPhrase(rotationDirection, targetAngleDeg) : null;
  const rotationTagId = trial.rotationTagId ?? null;
  const rotationTagLabel = tagCode(rotationTagId);
  const rotationTagPose = rotationTagId === null ? null
    : (input.mapTags?.byId?.[String(rotationTagId)]
      ?? (rotationTagId === tagA ? input.mapTags?.tagA ?? null : rotationTagId === tagB ? input.mapTags?.tagB ?? null : null));

  // 端点配对：前进/后退走 A→B；转向两端都用旋转二维码（原地转向，起止都在同一块码前）。
  // 旋转二维码缺失时退回 A/B 只为保留审计统计，结果会在下面被显式判无效并清空，绝不当成测量。
  const stopPoint = analyzeStopPoint({
    observations, feedback, tagA, tagB,
    startTagId: isTurn ? (rotationTagId ?? tagA) : tagA,
    endTagId: isTurn ? (rotationTagId ?? tagB) : tagB,
    baselineM: isTurn ? null : baselineM,
    trial: {startedStamp: trial.startedStamp, endedStamp: trial.endedStamp},
    mapTags: input.mapTags, options: input.options,
  });
  const wheel = integrateFeedback(feedback);
  const legacyPairs = visualRelativePoses(observations, tagA, tagB);

  // IMU 零偏：本会话真实融合样本里的标定最贴近当次运行，优先；否则用显式提供的运行标定快照；都没有就不校正。
  const fromFusion = fusion.map(sample => sample.calibration)
    .filter((value): value is {bias: number[]; up: number[]; variance: number} => !!value && Array.isArray(value.bias) && Array.isArray(value.up))
    .at(-1) ?? null;
  const biasInfo: ImuCalibrationInfo | null = fromFusion
    ? {bias: fromFusion.bias, up: fromFusion.up, source: 'session_fusion_sample', capturedAt: null, variance: fromFusion.variance ?? null}
    : (input.imuCalibration ?? null);
  const imuRaw = integrateImuYaw(imu, null);
  const imuCorrected = biasInfo ? integrateImuYaw(imu, {bias: biasInfo.bias, up: biasInfo.up}) : null;
  const imuIntegral = imuCorrected ?? imuRaw;

  // 延迟候选：同帧旧数据优先；否则用单码连续段，无激励就明说。
  const legacyDelay = estimateVisualImuDelay(legacyPairs, imuIntegral?.rateRadS ?? []);
  const singleTag = legacyDelay ? null : estimateSingleTagDelay(observations, [tagA, tagB], imuIntegral?.rateRadS ?? []);
  const delay = legacyDelay ?? singleTag?.estimate ?? null;
  const delayMethod = legacyDelay ? 'same_frame_bearing_vs_imu' : (singleTag?.estimate ? 'single_tag_bearing_vs_imu' : null);
  const delayReason = delay ? null : (singleTag?.reason ?? 'insufficient_visual_rates');

  const stamps = [...observations, ...feedback, ...imu, ...fusion].map(sample => sample.stamp).filter(Number.isFinite);
  const stampRange = stamps.length ? {first: Math.min(...stamps), last: Math.max(...stamps)} : {first: null, last: null};

  const legacyBaseline = stats(legacyPairs.map(pair => pair.distanceM));
  const legacyBearing = stats(legacyPairs.map(pair => deg(pair.bearingRad)));
  const legacyMeanYaw = circularMean(legacyPairs.map(pair => pair.pose.yaw));
  const legacyMeanDistance = legacyBaseline?.mean ?? null;
  const visualVsBaseline = legacyMeanDistance !== null ? {ratio: legacyMeanDistance / baselineM, deltaM: legacyMeanDistance - baselineM} : null;

  // ---- 旋转位置：转向必须明确“在哪块二维码处转”，缺了就判无效，绝不猜 ----
  const rotationReason = !isTurn ? null
    : rotationTagId === null ? 'rotation_tag_missing'
      : rotationTagPose === null ? 'rotation_tag_not_in_map'
        : null;
  if (isTurn && rotationReason === 'rotation_tag_missing') {
    missing.push('转向试验缺少旋转二维码：没有记录“在哪个二维码处转向”，结果判为无效，不用 A/B 或外部基线去猜');
  } else if (isTurn && rotationReason === 'rotation_tag_not_in_map') {
    missing.push(`旋转二维码 ${rotationTagLabel ?? rotationTagId} 不在会话绑定的地图版本中：拿不到位姿，结果判为无效`);
  }
  if (isTurn && rotationReason !== null) {
    // 不保留任何“顺手算出来”的视觉量，避免被误读成测量结果。
    stopPoint.valid = false;
    stopPoint.invalidReason = rotationReason;
    stopPoint.visualRelativePose = null;
    stopPoint.visualNetDistance = null;
    stopPoint.visualForwardM = null;
    stopPoint.visualLateralM = null;
    stopPoint.visualYawDeg = null;
  }

  // 实测转角：优先 IMU 零偏校正 → 底盘 wz → 视觉同码配对 → IMU 原始（无零偏，需明确标注）。
  const measured: {value: number; source: MeasuredAngleSource} | null = !isTurn ? null
    : imuCorrected ? {value: imuCorrected.yawChangeDeg, source: 'imu_bias_corrected'}
      : (wheel && wheel.yawAvailable) ? {value: wheel.yawChangeDeg, source: 'wheel_wz'}
        : (stopPoint.valid && stopPoint.visualYawDeg !== null) ? {value: stopPoint.visualYawDeg, source: 'visual_same_tag'}
          : imuRaw ? {value: imuRaw.yawChangeDeg, source: 'imu_raw'} : null;

  // ---- 可计算 / 缺数据 / 假设 ----
  if (stopPoint.valid) {
    computable.push(isTurn
      ? `原地转向视觉配对（在 ${rotationTagLabel ?? '—'} 处，起点 ${stopPoint.start.selected} 帧 / 终点 ${stopPoint.end.selected} 帧）`
      : `端点停稳配对视觉位移（起点 A=${stopPoint.start.selected} 帧 / 终点 B=${stopPoint.end.selected} 帧）`);
    if (!isTurn) computable.push('视觉净位移与基线残差（外部基线仅作独立校核）');
  } else {
    missing.push(`${isTurn ? '原地转向视觉配对' : '端点停稳配对'}不可用：${stopPoint.invalidReason ?? 'unknown'}`);
  }
  if (isTurn && rotationTagLabel) {
    assumptions.push(`转向试验的端点配对两端都用旋转二维码 ${rotationTagLabel}；外部基线（A↔B ${baselineM} m）对转向不适用，因此不给基线残差`);
  }
  if (stopPoint.counts.both === 0 && stopPoint.counts.total) {
    assumptions.push(`本次 ${stopPoint.counts.total} 帧观测中没有一帧同时看到 A 与 B（A ${stopPoint.counts.seeA} 帧 / B ${stopPoint.counts.seeB} 帧），因此不使用同帧共视假设`);
  }
  if (wheel) computable.push('轮速/底盘反馈积分（vx, vy, wz）');
  else missing.push('没有足够的底盘反馈样本，无法积分车辆行程');
  if (wheel && !wheel.yawAvailable) missing.push('轮速偏航不可用：底盘反馈 wz 恒为 0，wheelYaw unavailable');
  if (imuCorrected) computable.push('IMU 竖直轴投影角速度积分（使用运行标定 bias/up）');
  else if (imuRaw) {
    computable.push('IMU 原始 z 轴角速度积分（未提供运行标定 bias/up）');
    missing.push('IMU 零偏缺失：没有运行标定 bias，imuYawBiasCorrected 不可用');
  } else missing.push('没有足够的 IMU 样本，无法积分转角');

  const fusionStatus = fusion.length
    ? {state: 'present' as const, samples: fusion.length, message: `融合样本 ${fusion.length} 条`}
    : {state: 'not_integrated' as const, samples: 0, message: '本次未接入融合输出样本（fusion=0），不能当作有效融合结果'};
  if (!fusion.length) missing.push(fusionStatus.message);

  if (wheel && wheel.gaps > 0) faults.push(`底盘反馈有 ${wheel.gaps} 处 >0.3 s 断流，已跳过该段`);
  if (imuRaw && imuRaw.gaps > 0) faults.push(`IMU 有 ${imuRaw.gaps} 处 >0.3 s 断流，已跳过该段`);
  if (trial.status === 'aborted') faults.push('试验被标记为中止，结果仅供参考');
  if (trial.status === 'interrupted') faults.push('采集过程中服务/节点中断，样本可能不完整');
  if (stopPoint.counts.total && stopPoint.counts.seeA + stopPoint.counts.seeB < stopPoint.counts.total) {
    faults.push(`${stopPoint.counts.neither} 帧观测既看不到 A 也看不到 B（视觉盲区）`);
  }

  // ---- 候选 ----
  let forwardScale: number | null = null;
  let lateralScale: number | null = null;
  let wheelVsBaselineRatio: number | null = null;
  let imuYawScale: number | null = null;
  let wheelYawScale: number | null = null;
  let turnErrorDeg: {wheelVsObserved: number | null; imuVsObserved: number | null; imuVsWheel: number | null} | null = null;

  if (trial.type === 'forward' || trial.type === 'reverse') {
    if (wheel && Math.abs(wheel.forwardM) > 0.05) {
      wheelVsBaselineRatio = wheel.netM / baselineM;
      if (stopPoint.valid && stopPoint.visualNetDistance && stopPoint.visualNetDistance > 0.05) {
        forwardScale = wheel.netM / stopPoint.visualNetDistance;
        computable.push('前进/后退比例候选 = 轮速净位移 ÷ 视觉净位移（端点停稳配对）');
        assumptions.push('视觉净位移由端点停稳配对给出；外部基线只用于残差校核，不参与比例计算');
      } else {
        missing.push('缺少有效视觉净位移，无法给出前进比例候选（外部基线不代替真实行程）');
        assumptions.push(`轮速净位移 ÷ 外部基线 = ${wheelVsBaselineRatio.toFixed(5)} 仅作独立校核，不是标定值`);
      }
    } else {
      missing.push('前进/后退试验需要车辆沿 A→B 基线行驶，当前轮速积分前进量不足');
    }
    if (wheel && Math.abs(wheel.lateralM) > 0.02) {
      lateralScale = wheel.lateralM / baselineM;
      computable.push('横向比例候选 = 轮速积分横向量 ÷ 外部基线（本次试验检测到横向运动）');
      assumptions.push('横向比例候选同样假设基线方向对应横向位移分量');
    }
  } else {
    const observed = trial.angleDeg;
    if (observed === null) missing.push('转向试验缺少观测角度，无法计算转角误差');
    if (wheel && wheel.yawAvailable && observed !== null && Math.abs(observed) >= 5) {
      wheelYawScale = wheel.yawChangeDeg / observed;
      computable.push('轮速转角比例候选 = 底盘 wz 积分角 ÷ 观测角');
    }
    if (imuIntegral && observed !== null && Math.abs(observed) >= 5) {
      imuYawScale = imuIntegral.yawChangeDeg / observed;
      computable.push('IMU 转角比例候选 = IMU 积分角 ÷ 观测角');
    }
    if (observed !== null) {
      turnErrorDeg = {
        wheelVsObserved: wheel && wheel.yawAvailable ? wheel.yawChangeDeg - observed : null,
        imuVsObserved: imuIntegral ? imuIntegral.yawChangeDeg - observed : null,
        imuVsWheel: wheel && wheel.yawAvailable && imuIntegral ? imuIntegral.yawChangeDeg - wheel.yawChangeDeg : null,
      };
      computable.push('转角误差（相对观测角、轮速与 IMU 互差）');
      assumptions.push('观测角由试验员输入或量角器读数；分析不声称它是绝对真值');
    }
    if (measured) computable.push(`实测转角 ${measured.value.toFixed(2)}°（来源 ${measured.source}）与目标「${targetAnglePhrase ?? '—'}」对比`);
    else missing.push('没有任何可用的角度测量（IMU / 底盘 wz / 视觉配对都缺），无法给出实测转角');
  }
  if (legacyPairs.length) {
    computable.push('旧口径同帧 A→B 视觉基线（仅用于旧数据兼容）');
  }
  // 方向一致性：只判“整段转反了”，原始数值一律保留，仅把它挡在统计之外。
  const directionMismatch = isTurn && turnDirectionMismatch(rotationDirection, measured?.value ?? null);
  if (directionMismatch && measured) {
    const actual = measured.value > 0 ? rotationSenseLabels.left : rotationSenseLabels.right;
    faults.push(`实测转角 ${measured.value.toFixed(2)}° 与目标「${targetAnglePhrase ?? '—'}」方向相反：现场实际转的是${actual}。判 turn_direction_mismatch，原始数值保留但不进入统计`);
  }

  // ---- 有效性 ----
  let invalidReason: string | null = null;
  if (trial.status === 'aborted') invalidReason = 'trial_aborted';
  else if (trial.status === 'interrupted') invalidReason = 'trial_interrupted';
  else if (trial.status === 'recording') invalidReason = 'trial_still_recording';
  else if (rotationReason !== null) invalidReason = rotationReason;
  // 方向反了与“没有角度测量”是两件事：先判方向，再判缺测量，两者都不进统计。
  else if (directionMismatch) invalidReason = 'turn_direction_mismatch';
  // 转向的硬性条件是“有旋转二维码 + 至少一路真实角度测量”；端点位移配对只对前进/后退是硬性条件。
  else if (isTurn) invalidReason = measured ? null : 'no_angle_measurement';
  else if (!stopPoint.valid) invalidReason = stopPoint.invalidReason ?? 'stop_point_invalid';
  const valid = invalidReason === null;
  const excludedReason = valid ? null : invalidReason;

  const counts = {observation: observations.length, feedback: feedback.length, imu: imu.length, fusion: fusion.length};
  return {
    trialId: trial.id, type: trial.type, repetition: trial.repetition, angleDeg: trial.angleDeg, status: trial.status,
    rotationTagId, rotationTagLabel, rotationTagPose,
    rotationDirection, targetAngleDeg,
    signedTargetAngleDeg, targetAnglePhrase,
    measuredAngleDeg: measured?.value ?? null,
    measuredAngleSource: measured?.source ?? null,
    directionMismatch,
    window: {startedAt: trial.startedAt, endedAt: trial.endedAt, durationS: wheel?.durationS ?? imuIntegral?.durationS ?? null},
    sampleCounts: counts, stampRange, stopPoint,
    visualRelativePose: stopPoint.visualRelativePose,
    visualNetDistance: stopPoint.visualNetDistance,
    baselineResidual: stopPoint.baselineResidualM,
    wheelNetDistance: wheel?.netM ?? null,
    wheelPathDistance: wheel?.travelM ?? null,
    imuYawRaw: imuRaw?.yawChangeDeg ?? null,
    imuYawBiasCorrected: imuCorrected?.yawChangeDeg ?? null,
    timeOffsetCandidate: delay ? {...delay, method: delayMethod!} : null,
    timeOffsetUnavailableReason: delayReason,
    imuBias: biasInfo ? {bias: biasInfo.bias, up: biasInfo.up, source: biasInfo.source, capturedAt: biasInfo.capturedAt} : null,
    wheelYawStatus: {available: wheel?.yawAvailable ?? false, reason: wheel?.yawUnavailableReason ?? 'no_feedback'},
    fusionStatus,
    valid, invalidReason, excludedFromAggregate: !valid, excludedReason,
    visual: legacyPairs.length ? {
      pairs: legacyPairs.length, baselineM: legacyBaseline, bearingDeg: legacyBearing,
      meanPose: legacyMeanDistance !== null && legacyMeanYaw !== null ? {
        x: legacyMeanDistance * Math.cos(circularMean(legacyPairs.map(pair => pair.bearingRad)) ?? 0),
        y: legacyMeanDistance * Math.sin(circularMean(legacyPairs.map(pair => pair.bearingRad)) ?? 0), yaw: legacyMeanYaw,
      } : null,
    } : null,
    visualVsBaseline,
    wheel, imu: imuIntegral, imuRaw, imuCorrected: imuCorrected, delay,
    candidates: {forwardScale, lateralScale, wheelVsBaselineRatio, imuYawScale, wheelYawScale, turnErrorDeg},
    computable, assumptions, missing, faults,
  };
}

export function analyzeSession(input: {
  session: CalibrationSession;
  samples: AnalysisSample[];
  /** 地图中 A/B（以及 byId 全量）的位姿（弧度），由后端从绑定地图版本读取。 */
  mapTags?: {tagA: Pose2 | null; tagB: Pose2 | null; byId?: Record<string, Pose2 | null>};
  imuCalibration?: ImuCalibrationInfo | null;
  options?: Partial<StopWindowOptions>;
}): SessionAnalysis {
  const {session, samples} = input;
  const byTrial = new Map<string, {observation: CalibrationObservationSample[]; feedback: CalibrationFeedbackSample[]; imu: CalibrationImuSample[]; fusion: CalibrationFusionSample[]}>();
  for (const trial of session.trials) byTrial.set(trial.id, {observation: [], feedback: [], imu: [], fusion: []});
  for (const sample of samples) {
    const bucket = sample.trialId ? byTrial.get(sample.trialId) : undefined;
    if (!bucket) continue;
    const body = sample.body as Record<string, unknown>;
    if (sample.kind === 'observation') bucket.observation.push(body as unknown as CalibrationObservationSample);
    else if (sample.kind === 'feedback') bucket.feedback.push(body as unknown as CalibrationFeedbackSample);
    else if (sample.kind === 'imu') bucket.imu.push(body as unknown as CalibrationImuSample);
    else if (sample.kind === 'fusion') bucket.fusion.push(body as unknown as CalibrationFusionSample);
  }
  const trials = session.trials.map(trial => analyzeTrial({
    trial,
    observations: byTrial.get(trial.id)?.observation ?? [],
    feedback: byTrial.get(trial.id)?.feedback ?? [],
    imu: byTrial.get(trial.id)?.imu ?? [],
    fusion: byTrial.get(trial.id)?.fusion ?? [],
    tagA: session.tagA, tagB: session.tagB, baselineM: session.baselineM,
    mapTags: input.mapTags, imuCalibration: input.imuCalibration, options: input.options,
  }));
  // 统计只纳入有效试验；aborted / invalid 明确排除并给出原因。
  const validTrials = trials.filter(trial => trial.valid);
  const excluded = trials.filter(trial => !trial.valid).map(trial => ({trialId: trial.trialId, reason: trial.excludedReason ?? 'invalid'}));
  // 位移类统计只取前进/后退，角度类统计只取转向：两类的物理量不同，混在一起求均值没有意义。
  const linearTrials = validTrials.filter(trial => trial.type === 'forward' || trial.type === 'reverse');
  const turnTrials = validTrials.filter(trial => trial.type === 'left' || trial.type === 'right');
  const pick = (values: (number | null)[]) => values.filter((value): value is number => value !== null && Number.isFinite(value));
  const forwardScales = pick(linearTrials.map(trial => trial.candidates.forwardScale));
  const imuScales = pick(turnTrials.map(trial => trial.candidates.imuYawScale));
  const wheelScales = pick(turnTrials.map(trial => trial.candidates.wheelYawScale));
  const delays = pick(validTrials.map(trial => trial.delay?.delayS ?? null));
  const turnErrors = turnTrials.map(trial => trial.candidates.turnErrorDeg)
    .filter((value): value is NonNullable<TrialAnalysis['candidates']['turnErrorDeg']> => value !== null)
    .map(value => [value.imuVsObserved, value.wheelVsObserved]).flat().filter((value): value is number => value !== null && Number.isFinite(value));
  const visualBaselines = pick(linearTrials.map(trial => trial.visual?.baselineM?.mean ?? null));
  const visualRatios = pick(linearTrials.map(trial => trial.visualVsBaseline?.ratio ?? null));
  const visualNets = pick(linearTrials.map(trial => trial.visualNetDistance));
  const residuals = pick(linearTrials.map(trial => trial.baselineResidual));
  const measuredAngles = pick(turnTrials.map(trial => trial.measuredAngleDeg));
  const measuredMagnitudes = pick(turnTrials.map(trial => trial.measuredAngleDeg === null ? null : Math.abs(trial.measuredAngleDeg)));
  const targetAngles = pick(turnTrials.map(trial => trial.targetAngleDeg));
  // 旋转位置统计：转向试验必须在某块二维码处进行。这里按**全部**转向试验计数（含无效），
  // 否则一旦试验无效就看不到“在哪个码处转过”，但有效数单独给出，不与统计口径混淆。
  const rotationTagCounts = new Map<number, {trials: number; valid: number}>();
  for (const trial of trials) {
    if (trial.type !== 'left' && trial.type !== 'right') continue;
    if (trial.rotationTagId === null) continue;
    const entry = rotationTagCounts.get(trial.rotationTagId) ?? {trials: 0, valid: 0};
    entry.trials += 1;
    if (trial.valid) entry.valid += 1;
    rotationTagCounts.set(trial.rotationTagId, entry);
  }
  const rotationTags = [...rotationTagCounts.entries()].sort((a, b) => a[0] - b[0])
    .map(([tagId, entry]) => ({tagId, label: tagCode(tagId) ?? String(tagId), trials: entry.trials, validTrials: entry.valid}));
  const turnTrialsMissingRotationTag = trials.filter(trial => (trial.type === 'left' || trial.type === 'right') && trial.rotationTagId === null).length;
  const turnTrialsDirectionMismatch = trials.filter(trial => trial.directionMismatch).length;
  const outlier = (values: number[]) => values.filter((_, index) => outlierMask(values)[index]);
  const stamps = samples.map(sample => sample.stamp).filter(Number.isFinite);
  const counts = {observation: 0, feedback: 0, imu: 0, fusion: 0};
  for (const sample of samples) counts[sample.kind] += 1;
  const limitations: string[] = [];
  if (!session.trials.length) limitations.push('尚未保存任何试验');
  if (!counts.observation) limitations.push('没有二维码观测样本：检查 ROS 节点是否已加载标定录音支持并处于录制状态');
  if (!counts.feedback) limitations.push('没有底盘反馈样本：无法给出轮速比例');
  if (!counts.imu) limitations.push('没有 IMU 样本：无法给出 IMU 转角/延迟候选');
  if (!counts.fusion) limitations.push('本次没有融合输出样本（fusion=0）：融合链路未接入，不能当作有效融合结果');
  if (excluded.length) limitations.push(`已排除 ${excluded.length} 次无效/中止试验，不参与均值与标准差`);
  if (turnTrialsMissingRotationTag) limitations.push(`有 ${turnTrialsMissingRotationTag} 次转向试验没有指定旋转二维码，已判无效（不用 A/B 或基线推断）`);
  if (turnTrialsDirectionMismatch) limitations.push(`有 ${turnTrialsDirectionMismatch} 次转向试验的实测方向与目标方向相反（turn_direction_mismatch），已排除出转向统计；原始实测值与证据仍保留在每次试验明细里`);
  limitations.push('外部基线只用于独立校核（baselineResidual），不当作车辆真实行程');
  limitations.push('视觉位移采用端点停稳配对，不要求同帧同时看到 A 与 B');
  limitations.push('转向试验必须指定“在哪个二维码处转向”；起点与终点都取该二维码，位移类统计不纳入转向试验');
  limitations.push('所有候选参数仅为建议值；本轮不自动写入导航/IMU 运行配置');
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    sessionId: session.id, mapId: session.mapId, mapVersion: session.mapVersion, mapDigest: session.mapDigest,
    tagA: session.tagA, tagB: session.tagB, baselineM: session.baselineM, baselineSource: 'external_baseline',
    createdAt: session.created, analyzedAt: new Date().toISOString(),
    sampleCounts: counts,
    stampRange: stamps.length ? {first: Math.min(...stamps), last: Math.max(...stamps)} : {first: null, last: null},
    imuBias: input.imuCalibration
      ? {bias: input.imuCalibration.bias, up: input.imuCalibration.up, source: input.imuCalibration.source, capturedAt: input.imuCalibration.capturedAt}
      : null,
    trials,
    aggregate: {
      validTrials: validTrials.length, excluded,
      linearTrials: linearTrials.length, turnTrials: turnTrials.length,
      turnTrialsMissingRotationTag, rotationTags, turnTrialsDirectionMismatch,
      forwardScale: stats(forwardScales),
      lateralScale: meanOrNull(pick(linearTrials.map(trial => trial.candidates.lateralScale))),
      imuYawScale: stats(imuScales), wheelYawScale: stats(wheelScales),
      delayS: stats(delays), turnErrorDeg: stats(turnErrors),
      targetAngleDeg: stats(targetAngles), measuredAngleDeg: stats(measuredAngles),
      measuredAngleMagnitudeDeg: stats(measuredMagnitudes),
      visualBaselineM: stats(visualBaselines), visualBaselineRatio: stats(visualRatios),
      visualNetDistance: stats(visualNets), baselineResidualM: stats(residuals),
      outliers: {forwardScale: outlier(forwardScales), imuYawScale: outlier(imuScales), turnErrorDeg: outlier(turnErrors)},
    },
    limitations,
    formulas: [
      '端点停稳配对：T_map_base(start)=T_map_startTag·inv(T_base_startTag)，T_map_base(end)=T_map_endTag·inv(T_base_endTag)，相对位姿=inv(T_map_base(start))·T_map_base(end)',
      '前进/后退：startTag=A、endTag=B，给位移；转向：startTag=endTag=旋转二维码，给原地转角，此时不给基线残差',
      '视觉净位移=|t|；视觉前进/横向=相对位姿的 x/y；视觉转角=相对位姿 yaw',
      '基线残差 = 视觉净位移 − 外部基线；外部基线只作独立校核，不参与比例计算',
      '前进比例候选 = 轮速净位移 ÷ 视觉净位移（两者都是真实测量，才给出候选）',
      '轮速净位移 = |∫(vx,vy)dt|（中间航向积分）；路径长 = ∫|v|dt；wz 恒为 0 时轮速偏航标记为不可用',
      'IMU 转角 = ∫dot(gyro−bias, up)dt（使用运行标定 bias/up，并记录来源）；无 bias 时只给原始 ∫gz dt 并标注缺数据',
      '实测转角优先 IMU 零偏校正 → 底盘 wz → 视觉同码配对 → IMU 原始；目标角 = |录入角度|，方向由左/右转给出',
      `方向一致性：目标 right 且实测 > +${TURN_DIRECTION_MISMATCH_MIN_DEG}°，或目标 left 且实测 < −${TURN_DIRECTION_MISMATCH_MIN_DEG}°，判 turn_direction_mismatch（排除出统计，原始数值保留）；显示统一为「右转 90°（顺时针）/ 实测 −88.63°」`,
      '符号约定：内部 yaw 逆时针为正（ROS/REP-103），左转 = 正 = 逆时针，右转 = 负 = 顺时针；目标角与实测角并列时都按带符号呈现',
      '时间延迟候选：视觉方位角速率 −dθ/dt 与 IMU 角速度互相关，搜索 −0.3…0.3 s；直线段无角激励时不给数字',
    ],
  };
}

export function analysisCsv(analysis: SessionAnalysis): string {
  const header = ['trialId', 'type', 'repetition', 'status', 'valid', 'invalidReason', 'directionMismatch', 'angleDeg', 'rotationTagId', 'rotationTagLabel', 'rotationDirection', 'targetAngleDeg', 'signedTargetAngleDeg', 'measuredAngleDeg', 'measuredAngleSource', 'visualNetDistance', 'visualForwardM', 'visualYawDeg', 'baselineResidualM', 'baselineRatio', 'wheelNetDistance', 'wheelPathDistance', 'wheelYawAvailable', 'imuYawRaw', 'imuYawBiasCorrected', 'delayS', 'forwardScale', 'wheelVsBaselineRatio', 'imuYawScale', 'wheelYawScale', 'turnErrorWheelVsObserved', 'turnErrorImuVsObserved', 'fusionSamples', 'seeA', 'seeB', 'both', 'observations', 'feedback', 'imuSamples'];
  const rows = analysis.trials.map(trial => [
    trial.trialId, trial.type, trial.repetition, trial.status, trial.valid ? 'true' : 'false', trial.invalidReason ?? '',
    trial.directionMismatch ? 'true' : 'false',
    trial.angleDeg ?? '',
    trial.rotationTagId ?? '', trial.rotationTagLabel ?? '', trial.rotationDirection ?? '',
    trial.targetAngleDeg?.toFixed(2) ?? '', trial.signedTargetAngleDeg?.toFixed(2) ?? '',
    trial.measuredAngleDeg?.toFixed(4) ?? '', trial.measuredAngleSource ?? '',
    trial.visualNetDistance?.toFixed(6) ?? '', trial.stopPoint.visualForwardM?.toFixed(6) ?? '',
    trial.stopPoint.visualYawDeg?.toFixed(4) ?? '',
    trial.baselineResidual?.toFixed(6) ?? '', trial.stopPoint.baselineRatio?.toFixed(6) ?? '',
    trial.wheelNetDistance?.toFixed(6) ?? '', trial.wheelPathDistance?.toFixed(6) ?? '',
    trial.wheelYawStatus.available ? 'true' : 'false',
    trial.imuYawRaw?.toFixed(4) ?? '', trial.imuYawBiasCorrected?.toFixed(4) ?? '',
    trial.delay?.delayS?.toString() ?? '', trial.candidates.forwardScale?.toFixed(6) ?? '',
    trial.candidates.wheelVsBaselineRatio?.toFixed(6) ?? '',
    trial.candidates.imuYawScale?.toFixed(6) ?? '', trial.candidates.wheelYawScale?.toFixed(6) ?? '',
    trial.candidates.turnErrorDeg?.wheelVsObserved?.toFixed(4) ?? '',
    trial.candidates.turnErrorDeg?.imuVsObserved?.toFixed(4) ?? '',
    trial.sampleCounts.fusion, trial.stopPoint.counts.seeA, trial.stopPoint.counts.seeB, trial.stopPoint.counts.both,
    trial.sampleCounts.observation, trial.sampleCounts.feedback, trial.sampleCounts.imu,
  ]);
  return [header, ...rows].map(row => row.map(cell => typeof cell === 'string' && /[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : String(cell)).join(',')).join('\n') + '\n';
}

export function analysisReport(analysis: SessionAnalysis): string {
  const lines: string[] = [];
  const f = (value: number | null | undefined, digits = 3) => value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
  lines.push('# 融合标定报告', '');
  lines.push(`- mapId: ${analysis.mapId}`);
  lines.push(`- mapVersion: ${analysis.mapVersion}`);
  lines.push(`- mapDigest: ${analysis.mapDigest}`);
  lines.push(`- 二维码 A/B: ${analysis.tagA} / ${analysis.tagB}`);
  lines.push(`- 外部基线: ${analysis.baselineM} m（${analysis.baselineSource}，只作独立校核，不是车辆实际行程）`);
  lines.push(`- 创建时间: ${analysis.createdAt}`);
  lines.push(`- 分析时间: ${analysis.analyzedAt}`);
  lines.push(`- 时间戳范围: ${analysis.stampRange.first ?? '—'} … ${analysis.stampRange.last ?? '—'}`);
  lines.push(`- 样本数: observation=${analysis.sampleCounts.observation} feedback=${analysis.sampleCounts.feedback} imu=${analysis.sampleCounts.imu} fusion=${analysis.sampleCounts.fusion}`);
  lines.push(`- IMU 运行标定: ${analysis.imuBias ? `bias=[${analysis.imuBias.bias?.map(value => value.toFixed(6)).join(', ')}] 来源=${analysis.imuBias.source}` : '缺数据（未找到运行标定 bias）'}`);
  lines.push('', '## 汇总');
  const agg = analysis.aggregate;
  lines.push(`- 有效试验: ${agg.validTrials} / ${analysis.trials.length}（前进/后退 ${agg.linearTrials}，转向 ${agg.turnTrials}）`);
  for (const item of agg.excluded) lines.push(`  - 排除 ${item.trialId}: ${item.reason}`);
  lines.push(`- 旋转位置: ${agg.rotationTags.length ? agg.rotationTags.map(item => `${item.label} × ${item.trials} 次（有效 ${item.validTrials}）`).join('、') : '—'}${agg.turnTrialsMissingRotationTag ? `（另有 ${agg.turnTrialsMissingRotationTag} 次转向缺旋转二维码）` : ''}${agg.turnTrialsDirectionMismatch ? `（另有 ${agg.turnTrialsDirectionMismatch} 次转向实测方向与目标相反，已排除）` : ''}`);
  lines.push(`- 目标转角: ${f(agg.targetAngleDeg?.mean, 2)}°（n=${agg.targetAngleDeg?.n ?? 0}；带符号约定右负左正，均值按绝对值统计）`);
  lines.push(`- 实测转角: ${f(agg.measuredAngleDeg?.mean, 2)}°（n=${agg.measuredAngleDeg?.n ?? 0}, σ=${f(agg.measuredAngleDeg?.std, 2)}；带符号，左右混算时看下一条）`);
  lines.push(`- 实测转角幅值: ${f(agg.measuredAngleMagnitudeDeg?.mean, 2)}°（n=${agg.measuredAngleMagnitudeDeg?.n ?? 0}, σ=${f(agg.measuredAngleMagnitudeDeg?.std, 2)}；|实测|，左右转都为正）`);
  lines.push(`- 前进/后退比例候选: ${f(agg.forwardScale?.mean, 4)}（n=${agg.forwardScale?.n ?? 0}, σ=${f(agg.forwardScale?.std, 4)}）`);
  lines.push(`- 视觉净位移: ${f(agg.visualNetDistance?.mean, 4)} m（n=${agg.visualNetDistance?.n ?? 0}）`);
  lines.push(`- 基线残差: ${f(agg.baselineResidualM?.mean, 4)} m（n=${agg.baselineResidualM?.n ?? 0}）`);
  lines.push(`- 横向比例候选: ${f(agg.lateralScale, 4)}`);
  lines.push(`- IMU 转角比例候选: ${f(agg.imuYawScale?.mean, 4)}（n=${agg.imuYawScale?.n ?? 0}）`);
  lines.push(`- 轮速转角比例候选: ${f(agg.wheelYawScale?.mean, 4)}（n=${agg.wheelYawScale?.n ?? 0}）`);
  lines.push(`- 时间延迟候选: ${f(agg.delayS?.mean, 4)} s（n=${agg.delayS?.n ?? 0}）`);
  lines.push(`- 转角误差: ${f(agg.turnErrorDeg?.mean, 2)}°（n=${agg.turnErrorDeg?.n ?? 0}）`);
  lines.push('', '## 每次试验');
  for (const trial of analysis.trials) {
    lines.push(`### ${trialTypeLabels[trial.type]} #${trial.repetition}（${trial.trialId}）`);
    lines.push(`- 状态: ${trial.status}；有效: ${trial.valid ? '是' : '否（' + (trial.invalidReason ?? 'unknown') + '）'}；角度: ${trial.angleDeg ?? '—'}°；时长: ${f(trial.window.durationS, 2)} s`);
    const isTurnTrial = trial.type === 'left' || trial.type === 'right';
    lines.push(`- 旋转位置: ${trial.rotationTagId === null
      ? (isTurnTrial ? '缺数据（未指定旋转二维码，结果无效）' : '不适用（前进/后退不要求）')
      : `在 ${trial.rotationTagLabel ?? tagCode(trial.rotationTagId)} 处${trialTypeLabels[trial.type]}${f(trial.targetAngleDeg, 0)}°`}`);
    lines.push(`- 目标 / 实测转角: 目标「${trial.targetAnglePhrase ?? (isTurnTrial ? turnTargetPhrase(trial.rotationDirection, trial.targetAngleDeg) : '—')}」 / 实测 ${f(trial.measuredAngleDeg, 2)}°（来源 ${trial.measuredAngleSource ?? '缺数据'}）；目标带符号 ${f(trial.signedTargetAngleDeg, 2)}°，与实测同号约定${trial.directionMismatch ? '；**方向相反，已判 turn_direction_mismatch**' : ''}`);
    const sp = trial.stopPoint;
    lines.push(`- 端点配对: ${sp.pairing.kind === 'same_tag' ? `同一个旋转二维码 ${tagCode(sp.pairing.startTagId)}（原地转向）` : `${tagCode(sp.pairing.startTagId)} → ${tagCode(sp.pairing.endTagId)}`}`);
    lines.push(`- 端点观测: 总 ${sp.counts.total} 帧；A ${sp.counts.seeA} 帧 / B ${sp.counts.seeB} 帧 / 同帧双码 ${sp.counts.both} 帧`);
    lines.push(`- 起点 ${sp.pairing.kind === 'same_tag' ? '' : 'A '}${tagCode(sp.pairing.startTagId)}: 候选 ${sp.start.candidates} / 合格 ${sp.start.qualified} / 选中 ${sp.start.selected}，stamps=${sp.start.stamps.join(',') || '—'}，无效原因=${sp.start.invalidReason ?? '—'}`);
    lines.push(`- 终点 ${sp.pairing.kind === 'same_tag' ? '' : 'B '}${tagCode(sp.pairing.endTagId)}: 候选 ${sp.end.candidates} / 合格 ${sp.end.qualified} / 选中 ${sp.end.selected}，stamps=${sp.end.stamps.join(',') || '—'}，无效原因=${sp.end.invalidReason ?? '—'}`);
    lines.push(`- 视觉相对位姿: ${trial.visualRelativePose ? `x=${f(trial.visualRelativePose.x, 4)} y=${f(trial.visualRelativePose.y, 4)} yaw=${f(deg(trial.visualRelativePose.yaw), 2)}°` : '缺数据'}`);
    lines.push(`- 视觉净位移: ${f(trial.visualNetDistance, 4)} m；基线残差: ${trial.baselineResidual === null ? '不适用（转向不给基线残差）' : f(trial.baselineResidual, 4) + ' m'}`);
    lines.push(`- 轮速净位移/路径长: ${f(trial.wheelNetDistance, 4)} / ${f(trial.wheelPathDistance, 4)} m；轮速偏航: ${trial.wheelYawStatus.available ? '可用' : '不可用（' + (trial.wheelYawStatus.reason ?? '') + '）'}`);
    lines.push(`- IMU 转角: 原始 ${f(trial.imuYawRaw, 2)}° / 零偏校正 ${f(trial.imuYawBiasCorrected, 2)}°`);
    lines.push(`- 融合: ${trial.fusionStatus.message}`);
    lines.push(`- 候选: 前进比例 ${f(trial.candidates.forwardScale, 4)}；轮速÷基线校核 ${f(trial.candidates.wheelVsBaselineRatio, 4)}；IMU 转角比例 ${f(trial.candidates.imuYawScale, 4)}；轮速转角比例 ${f(trial.candidates.wheelYawScale, 4)}`);
    if (trial.delay) lines.push(`- 延迟候选: ${trial.delay.delayS} s（r=${trial.delay.correlation.toFixed(2)}, n=${trial.delay.pairs}, ${trial.timeOffsetCandidate?.method}）`);
    else lines.push(`- 延迟候选: 缺数据（${trial.timeOffsetUnavailableReason ?? 'unknown'}）`);
    for (const item of trial.missing) lines.push(`- 缺数据: ${item}`);
    for (const item of trial.assumptions) lines.push(`- 假设: ${item}`);
    for (const item of trial.faults) lines.push(`- 异常: ${item}`);
  }
  lines.push('', '## 公式');
  for (const formula of analysis.formulas) lines.push(`- ${formula}`);
  lines.push('', '## 限制');
  for (const item of analysis.limitations) lines.push(`- ${item}`);
  lines.push('', '## 应用状态', '- 未应用：本报告不修改导航/IMU 运行配置。');
  return lines.join('\n') + '\n';
}
