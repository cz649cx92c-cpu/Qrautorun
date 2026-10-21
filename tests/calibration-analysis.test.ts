/**
 * 融合标定纯分析测试：SE2、端点停稳配对、轮速/IMU 积分、零偏校正、延迟候选、统计与导出。
 * 不依赖 DOM、不发送任何运动、不写数据库。
 *
 * 关键回归点：现场 A/B 相距 >1 m，单目相机不可能同帧共视；
 * 因此主算法必须是“起点停稳看 A + 终点停稳看 B”的端点配对，而不是同帧双码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisCsv, analysisReport, analyzeSession, analyzeTrial, calibrationSessionInputSchema,
  calibrationTrialInputSchema, circularMean, compose, defaultStopWindowOptions, estimateVisualImuDelay,
  inverse, integrateFeedback, integrateImuYaw, outlierMask, pickEndpoint, relative, robotSampleBatchSchema,
  stats, visualRelativePoses, wrapPi,
  type CalibrationSession, type CalibrationTrial, type Pose2,
} from '../web/shared/calibration';

const TAG_A = 10, TAG_B = 11;
/** 地图里 A 在原点、B 在 +x 1.2 m（弧度制，与后端转换后一致）。 */
const mapTags: {tagA: Pose2; tagB: Pose2} = {tagA: {x: 0, y: 0, yaw: 0}, tagB: {x: 1.2, y: 0, yaw: 0}};

const trial = (overrides: Partial<CalibrationTrial> = {}): CalibrationTrial => ({
  id: 'trial-1', sessionId: 'cal-1', type: 'forward', angleDeg: null,
  rotationTagId: null, rotationTagLabel: null, rotationTagPose: null,
  repetition: 1, note: '',
  status: 'saved', startedAt: '2026-10-21T00:00:00.000Z', endedAt: '2026-10-21T00:00:05.000Z',
  startedStamp: 100, endedStamp: 104.1, ...overrides,
});
const session = (overrides: Partial<CalibrationSession> = {}): CalibrationSession => ({
  id: 'cal-1', mapId: 'map-1', mapVersion: 3, mapDigest: 'a'.repeat(64), tagA: TAG_A, tagB: TAG_B,
  baselineM: 1.2, baselineSource: 'external_baseline', note: '', created: '2026-10-21T00:00:00.000Z',
  trials: [], analysis: null, applied: false, ...overrides,
});

/** 起点停稳只看 A；终点停稳只看 B。 */
const seeA = (stamp: number, x = 0, y = 0, angle = 0) => ({
  stamp, frame: 'base_link', calibrated: true, synchronized: true, representation: 'board-centers',
  tags: [{id: TAG_A, x, y, angle, sigma: 0.01, angleSigma: 0.01, visibleCount: 10, reprojectionPx: 0.4}],
});
const seeB = (stamp: number, x = 0, y = 0, angle = 0) => ({
  stamp, frame: 'base_link', calibrated: true, synchronized: true, representation: 'board-centers',
  tags: [{id: TAG_B, x, y, angle, sigma: 0.01, angleSigma: 0.01, visibleCount: 10, reprojectionPx: 0.4}],
});
/** 同一帧同时看到 A 与 B（仅用于旧数据兼容测试）。 */
const seeBoth = (stamp: number) => ({
  stamp, frame: 'base_link', calibrated: true, synchronized: true, representation: 'board-centers',
  tags: [
    {id: TAG_A, x: 0, y: 0, angle: 0, sigma: 0.01, angleSigma: 0.01, visibleCount: 10, reprojectionPx: 0.4},
    {id: TAG_B, x: 1.2, y: 0, angle: 0, sigma: 0.01, angleSigma: 0.01, visibleCount: 10, reprojectionPx: 0.4},
  ],
});

/** 停 1 s → 走 2 s（0.5 m/s）→ 停 1 s。运动区间 101.05…103.05。 */
const feedback = () => {
  const rows: {stamp: number; vx: number; vy: number; wz: number}[] = [];
  for (let index = 0; index <= 20; index++) rows.push({stamp: 100 + index * 0.05, vx: 0, vy: 0, wz: 0});
  for (let index = 0; index <= 40; index++) rows.push({stamp: 101.05 + index * 0.05, vx: 0.5, vy: 0, wz: 0});
  for (let index = 0; index <= 20; index++) rows.push({stamp: 103.1 + index * 0.05, vx: 0, vy: 0, wz: 0});
  return rows;
};

const startObs = () => [seeA(100.2), seeA(100.3), seeA(100.4)];
const endObs = (x = 0, y = 0, angle = 0) => [seeB(103.2, x, y, angle), seeB(103.3, x, y, angle), seeB(103.4, x, y, angle)];

/** 原地转向：停 1 s → 以 π/2 rad/s 左转 1 s → 停 1 s（wz 是唯一的运动证据）。 */
const turnFeedback = () => {
  const rows: {stamp: number; vx: number; vy: number; wz: number}[] = [];
  for (let index = 0; index <= 20; index++) rows.push({stamp: 100 + index * 0.05, vx: 0, vy: 0, wz: 0});
  for (let index = 0; index < 20; index++) rows.push({stamp: 101.05 + index * 0.05, vx: 0, vy: 0, wz: Math.PI / 2});
  for (let index = 0; index <= 20; index++) rows.push({stamp: 102.1 + index * 0.05, vx: 0, vy: 0, wz: 0});
  return rows;
};
/** 转向时同一块码在 base_link 里转 -90°；起止各三帧。 */
const turnObs = () => [
  seeA(100.2), seeA(100.3), seeA(100.4),
  seeA(102.6, 0, 0, -Math.PI / 2), seeA(102.7, 0, 0, -Math.PI / 2), seeA(102.8, 0, 0, -Math.PI / 2),
];
/** IMU：非转向段只有零偏，转向段叠加 π/2（梯形积分正好 1.0 s → 90°）。 */
const turnImu = (biasGz = 0.011) => {
  const rows: {stamp: number; gx: number; gy: number; gz: number}[] = [];
  for (let index = 0; index <= 62; index++) {
    const stamp = 100 + index * 0.05;
    const turning = stamp >= 101.05 && stamp <= 102;
    rows.push({stamp, gx: 0, gy: 0, gz: biasGz + (turning ? Math.PI / 2 : 0)});
  }
  return rows;
};

test('SE2 复合/求逆与相对位姿自洽', () => {
  const a = {x: 1, y: -2, yaw: 0.7}, b = {x: -0.4, y: 1.3, yaw: -1.1};
  const composed = compose(a, b);
  const back = compose(inverse(a), composed);
  assert.ok(Math.abs(back.x - b.x) < 1e-12 && Math.abs(back.y - b.y) < 1e-12 && Math.abs(wrapPi(back.yaw - b.yaw)) < 1e-12);
  const rel = relative(a, b);
  assert.ok(Math.abs(wrapPi(rel.yaw - wrapPi(b.yaw - a.yaw))) < 1e-12);
});

test('统计与离群标记：均值/标准差正确，少量样本不标记离群', () => {
  const base = stats([1, 2, 3, 4])!;
  assert.equal(base.n, 4);
  assert.ok(Math.abs(base.mean - 2.5) < 1e-12 && Math.abs(base.median - 2.5) < 1e-12);
  assert.ok(Math.abs(base.std - Math.sqrt(5 / 3)) < 1e-12);
  assert.deepEqual(outlierMask([1, 2]), [false, false]);
  const mask = outlierMask([1, 1.01, 0.99, 1.02, 1.0, 4.2]);
  assert.equal(mask.filter(Boolean).length, 1);
  assert.equal(mask[5], true);
  assert.equal(circularMean([Math.PI - 0.01, -Math.PI + 0.01]), Math.PI, 'circular mean wraps across ±π');
});

test('端点停稳配对：A/B 从不共视，仍能算出视觉相对位姿与净位移', () => {
  const analysis = analyzeTrial({
    trial: trial(), observations: [...startObs(), ...endObs()], feedback: feedback(), imu: [], fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
  });
  assert.equal(analysis.stopPoint.counts.both, 0, '全程没有同帧双码');
  assert.equal(analysis.stopPoint.counts.seeA, 3);
  assert.equal(analysis.stopPoint.counts.seeB, 3);
  assert.equal(analysis.valid, true, String(analysis.invalidReason));
  assert.equal(analysis.stopPoint.start.selected, 3);
  assert.equal(analysis.stopPoint.end.selected, 3);
  assert.ok(Math.abs(analysis.visualNetDistance! - 1.2) < 1e-9, String(analysis.visualNetDistance));
  assert.ok(Math.abs(analysis.baselineResidual!) < 1e-9);
  assert.ok(Math.abs(analysis.visualRelativePose!.x - 1.2) < 1e-9);
  assert.ok(analysis.computable.some(item => item.includes('端点停稳配对')));
  assert.ok(analysis.assumptions.some(item => item.includes('没有一帧同时看到 A 与 B')));
  // 比例候选 = 轮速净位移 ÷ 视觉净位移，而不是 ÷ 外部基线
  assert.ok(Math.abs(analysis.candidates.forwardScale! - analysis.wheelNetDistance! / 1.2) < 1e-9);
  assert.ok(analysis.candidates.wheelVsBaselineRatio !== null, '仍保留一个“轮速÷基线”的独立校核值');
});

test('端点停稳配对：缺 A 或缺 B 都判无效并给出明确原因', () => {
  const noStart = analyzeTrial({
    trial: trial(), observations: endObs(), feedback: feedback(), imu: [], fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
  });
  assert.equal(noStart.valid, false);
  assert.match(noStart.invalidReason!, /^start_endpoint_/);
  assert.equal(noStart.visualNetDistance, null, '不能凭空造视觉位移');

  const noEnd = analyzeTrial({
    trial: trial(), observations: startObs(), feedback: feedback(), imu: [], fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
  });
  assert.equal(noEnd.valid, false);
  assert.match(noEnd.invalidReason!, /^end_endpoint_/);
  assert.equal(noEnd.visualRelativePose, null);
});

test('端点停稳配对：缺地图位姿时判无效，不用基线伪造视觉', () => {
  const analysis = analyzeTrial({
    trial: trial(), observations: [...startObs(), ...endObs()], feedback: feedback(), imu: [], fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2,
  });
  assert.equal(analysis.valid, false);
  assert.equal(analysis.invalidReason, 'missing_map_tag_pose');
  assert.equal(analysis.visualNetDistance, null);
});

test('端点停稳配对：外部基线与视觉净位移不同 → 残差如实显示', () => {
  const analysis = analyzeTrial({
    trial: trial(), observations: [...startObs(), ...endObs()], feedback: feedback(), imu: [], fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.25, mapTags,
  });
  assert.equal(analysis.valid, true);
  assert.ok(Math.abs(analysis.visualNetDistance! - 1.2) < 1e-9);
  assert.ok(Math.abs(analysis.baselineResidual! + 0.05) < 1e-9, String(analysis.baselineResidual));
  assert.ok(Math.abs(analysis.stopPoint.baselineRatio! - 1.2 / 1.25) < 1e-9);
});

test('端点停稳配对：停稳证据不足（位置离散过大）判无效', () => {
  const wobbly = [seeA(100.2, 0, 0), seeA(100.3, 0.05, 0), seeA(100.4, -0.05, 0)];
  const analysis = analyzeTrial({
    trial: trial(), observations: [...wobbly, ...endObs()], feedback: feedback(), imu: [], fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
  });
  assert.equal(analysis.valid, false);
  assert.match(analysis.invalidReason!, /unstable_stop/);
});

test('端点停稳配对：没有底盘反馈就没有停稳证据，判无效', () => {
  const analysis = analyzeTrial({
    trial: trial(), observations: [...startObs(), ...endObs()], feedback: [], imu: [], fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
  });
  assert.equal(analysis.valid, false);
  assert.equal(analysis.invalidReason, 'no_feedback_stillness_evidence');
});

test('pickEndpoint：质量门限（可见数/σ/重投影）会筛掉低质量帧', () => {
  const observations = [
    seeA(100.2), seeA(100.3), seeA(100.4),
    {...seeA(100.5), tags: [{id: TAG_A, x: 0, y: 0, angle: 0, sigma: 0.01, visibleCount: 2, reprojectionPx: 0.4}]},
    {...seeA(100.6), tags: [{id: TAG_A, x: 0, y: 0, angle: 0, sigma: 0.09, visibleCount: 10, reprojectionPx: 0.4}]},
    {...seeA(100.7), tags: [{id: TAG_A, x: 0, y: 0, angle: 0, sigma: 0.01, visibleCount: 10, reprojectionPx: 3.5}]},
  ];
  const pick = pickEndpoint({observations, tagId: TAG_A, from: 100, to: 101});
  assert.equal(pick.candidates, 6);
  assert.equal(pick.qualified, 3);
  assert.equal(pick.rejected.lowVisibility, 1);
  assert.equal(pick.rejected.highSigma, 1);
  assert.equal(pick.rejected.highReprojection, 1);
  assert.equal(pick.selected, 3);
  assert.equal(pick.valid, true);
});

test('pickEndpoint：窗口内断流时取最长连续段，不跨缺口拼接', () => {
  const observations = [seeA(100.2), seeA(100.3), seeA(100.4), seeA(102.0), seeA(102.1), seeA(102.2), seeA(102.3)];
  const pick = pickEndpoint({observations, tagId: TAG_A, from: 100, to: 103});
  assert.equal(pick.candidates, 7);
  assert.equal(pick.qualified, 7);
  assert.equal(pick.selected, 4, '只取 102.0–102.3 这段连续观测');
  assert.equal(pick.stamps[0], 102);
  assert.equal(pick.valid, true);
});

test('轮速积分：前进 1.0 m、左转 90°（中间航向积分）', () => {
  const samples = [];
  for (let index = 0; index <= 100; index++) samples.push({stamp: 100 + index * 0.05, vx: 0.2, vy: 0, wz: 0});
  const straight = integrateFeedback(samples)!;
  assert.ok(Math.abs(straight.forwardM - 1.0) < 1e-9, String(straight.forwardM));
  assert.ok(Math.abs(straight.lateralM) < 1e-12);
  assert.ok(Math.abs(straight.yawChangeDeg) < 1e-9);
  assert.equal(straight.yawAvailable, false, 'wz 恒为 0 时轮速偏航不可用');
  assert.equal(straight.yawUnavailableReason, 'wz_all_zero');
  // 90°: ω=π/2 rad/s for 1 s
  const turning = [];
  for (let index = 0; index <= 20; index++) turning.push({stamp: 200 + index * 0.05, vx: 0, vy: 0, wz: Math.PI / 2});
  const turn = integrateFeedback(turning)!;
  assert.ok(Math.abs(turn.yawChangeDeg - 90) < 1e-6, String(turn.yawChangeDeg));
  assert.equal(turn.yawAvailable, true);
  // 断流 >0.3 s 被跳过并计数
  const gap = integrateFeedback([
    {stamp: 1, vx: 1, vy: 0, wz: 0}, {stamp: 1.05, vx: 1, vy: 0, wz: 0},
    {stamp: 2, vx: 1, vy: 0, wz: 0}, {stamp: 2.05, vx: 1, vy: 0, wz: 0},
  ])!;
  assert.equal(gap.gaps, 1);
  assert.ok(Math.abs(gap.forwardM - 0.1) < 1e-9);
});

test('IMU 积分：原始 z 与运行标定 bias 校正两条路径', () => {
  const samples = [];
  for (let index = 0; index <= 200; index++) samples.push({stamp: 300 + index * 0.05, gx: 0, gy: 0, gz: 0.011, ax: 0, ay: 0, az: 9.8});
  const raw = integrateImuYaw(samples)!;
  assert.equal(raw.projected, false);
  assert.ok(raw.yawChangeDeg > 5, String(raw.yawChangeDeg));
  const corrected = integrateImuYaw(samples, {bias: [0, 0, 0.011], up: [0, 0, 1]})!;
  assert.equal(corrected.projected, true);
  assert.ok(Math.abs(corrected.yawChangeDeg) < 1e-9, String(corrected.yawChangeDeg));

  // 分析层：bias 必须来自显式来源，并记录来源与值
  const analysis = analyzeTrial({
    trial: trial(), observations: [...startObs(), ...endObs()], feedback: feedback(), imu: samples, fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
    imuCalibration: {bias: [0, 0, 0.011], up: [0, 0, 1], source: 'test-snapshot', capturedAt: null, variance: null},
  });
  assert.ok(analysis.imuYawRaw! > 5);
  assert.ok(Math.abs(analysis.imuYawBiasCorrected!) < 1e-6);
  assert.equal(analysis.imuBias!.source, 'test-snapshot');
  assert.deepEqual(analysis.imuBias!.bias, [0, 0, 0.011]);

  // 没有 bias 时不得默认当 0，必须报缺数据
  const noBias = analyzeTrial({
    trial: trial(), observations: [...startObs(), ...endObs()], feedback: feedback(), imu: samples, fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
  });
  assert.equal(noBias.imuYawBiasCorrected, null);
  assert.equal(noBias.imuBias, null);
  assert.ok(noBias.missing.some(item => item.includes('IMU 零偏缺失')));
});

test('wz 全 0：轮速转角标记不可用，且不产出轮速转角比例', () => {
  const imu = [];
  for (let index = 0; index <= 20; index++) imu.push({stamp: 200 + index * 0.05, gx: 0, gy: 0, gz: Math.PI / 2, ax: 0, ay: 0, az: 9.8});
  const leftWheel = [];
  for (let index = 0; index <= 20; index++) leftWheel.push({stamp: 200 + index * 0.05, vx: 0, vy: 0, wz: 0});
  const left = analyzeTrial({
    trial: trial({type: 'left', angleDeg: 90}), observations: [], feedback: leftWheel, imu, fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
  });
  assert.equal(left.wheelYawStatus.available, false);
  assert.equal(left.candidates.wheelYawScale, null);
  assert.equal(left.candidates.turnErrorDeg!.wheelVsObserved, null);
  assert.ok(Math.abs(left.candidates.imuYawScale! - 1) < 1e-6);
  assert.ok(left.missing.some(item => item.includes('wheelYaw unavailable')));
});

test('fusion=0：不当作有效融合结果，明确标注未接入', () => {
  const analysis = analyzeTrial({
    trial: trial(), observations: [...startObs(), ...endObs()], feedback: feedback(), imu: [], fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
  });
  assert.equal(analysis.fusionStatus.state, 'not_integrated');
  assert.equal(analysis.fusionStatus.samples, 0);
  assert.ok(analysis.fusionStatus.message.includes('未接入'));
  assert.ok(analysis.missing.some(item => item.includes('未接入融合输出样本')));
});

test('旧同帧数据兼容：仍能读出同帧 A→B 基线，但主结果走停点配对', () => {
  const pairs = visualRelativePoses([seeBoth(100), seeBoth(100.1)], TAG_A, TAG_B);
  assert.equal(pairs.length, 2);
  const analysis = analyzeTrial({
    trial: trial(), observations: [seeBoth(100), seeBoth(100.1)], feedback: feedback(), imu: [], fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
  });
  assert.ok(analysis.visual, '旧口径字段仍保留');
  assert.equal(analysis.visual!.pairs, 2);
  assert.ok(Math.abs(analysis.visual!.baselineM!.mean - 1.2) < 1e-9);
  assert.ok(analysis.computable.some(item => item.includes('旧口径')));
});

test('延迟候选：直线行驶无角激励时不给数字，明确说明原因', () => {
  const imu = [];
  for (let index = 0; index <= 200; index++) imu.push({stamp: 300 + index * 0.05, gx: 0, gy: 0, gz: 0, ax: 0, ay: 0, az: 9.8});
  const analysis = analyzeTrial({
    trial: trial(), observations: [...startObs(), ...endObs()], feedback: feedback(), imu, fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
  });
  assert.equal(analysis.delay, null);
  assert.ok(analysis.timeOffsetUnavailableReason, '必须给出不可用原因');
});

test('转向试验：记录“在哪个二维码处转”，两端都取该码，实测角来自 IMU 零偏校正', () => {
  const analysis = analyzeTrial({
    trial: trial({
      type: 'left', angleDeg: 90, rotationTagId: TAG_A, rotationTagLabel: 'Q010', rotationTagPose: mapTags.tagA,
      startedStamp: 100, endedStamp: 103.1,
    }),
    observations: turnObs(), feedback: turnFeedback(), imu: turnImu(), fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2,
    mapTags: {...mapTags, byId: {[String(TAG_A)]: mapTags.tagA, [String(TAG_B)]: mapTags.tagB}},
    imuCalibration: {bias: [0, 0, 0.011], up: [0, 0, 1], source: 'test-snapshot', capturedAt: null, variance: null},
  });
  assert.equal(analysis.rotationTagId, TAG_A);
  assert.equal(analysis.rotationTagLabel, 'Q010');
  assert.deepEqual(analysis.rotationTagPose, mapTags.tagA);
  assert.equal(analysis.rotationDirection, 'left');
  assert.equal(analysis.targetAngleDeg, 90);
  assert.equal(analysis.stopPoint.pairing.kind, 'same_tag', '转向两端必须用同一块旋转二维码');
  assert.equal(analysis.stopPoint.pairing.startTagId, TAG_A);
  assert.equal(analysis.stopPoint.pairing.endTagId, TAG_A);
  assert.equal(analysis.valid, true, String(analysis.invalidReason));
  assert.equal(analysis.baselineResidual, null, '转向不给基线残差');
  assert.ok(Math.abs(analysis.stopPoint.visualYawDeg! - 90) < 1e-6, String(analysis.stopPoint.visualYawDeg));
  assert.equal(analysis.measuredAngleSource, 'imu_bias_corrected');
  assert.ok(Math.abs(analysis.measuredAngleDeg! - 90) < 1e-6, String(analysis.measuredAngleDeg));
  assert.ok(analysis.computable.some(item => item.includes('原地转向视觉配对')));
});

test('转向试验缺旋转二维码：判无效 rotation_tag_missing，不用 A/B 或基线猜', () => {
  const analysis = analyzeTrial({
    trial: trial({type: 'right', angleDeg: -90, startedStamp: 100, endedStamp: 103.1}),
    observations: turnObs(), feedback: turnFeedback(), imu: turnImu(), fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
    imuCalibration: {bias: [0, 0, 0.011], up: [0, 0, 1], source: 'test-snapshot', capturedAt: null, variance: null},
  });
  assert.equal(analysis.rotationTagId, null);
  assert.equal(analysis.rotationDirection, 'right');
  assert.equal(analysis.valid, false);
  assert.equal(analysis.invalidReason, 'rotation_tag_missing');
  assert.equal(analysis.visualRelativePose, null, '不能把 A/B 配对结果当成转向测量');
  assert.equal(analysis.visualNetDistance, null);
  assert.equal(analysis.baselineResidual, null);
  assert.ok(analysis.missing.some(item => item.includes('旋转二维码')));
});

test('旋转二维码不在绑定地图：rotation_tag_not_in_map，标签仍按 id 显示', () => {  const analysis = analyzeTrial({
    trial: trial({type: 'left', angleDeg: 90, rotationTagId: 999, startedStamp: 100, endedStamp: 103.1}),
    observations: turnObs(), feedback: turnFeedback(), imu: turnImu(), fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2,
    mapTags: {...mapTags, byId: {[String(TAG_A)]: mapTags.tagA, [String(TAG_B)]: mapTags.tagB}},
    imuCalibration: {bias: [0, 0, 0.011], up: [0, 0, 1], source: 'test-snapshot', capturedAt: null, variance: null},
  });
  assert.equal(analysis.rotationTagLabel, 'Q999');
  assert.equal(analysis.rotationTagPose, null);
  assert.equal(analysis.invalidReason, 'rotation_tag_not_in_map');
  assert.ok(analysis.measuredAngleDeg !== null, '角度测量照旧给出，但整条试验无效');
  assert.equal(analysis.visualRelativePose, null);
});

test('方向一致性：右转目标但实测为 +90°（逆时针）判 turn_direction_mismatch，原始数值全部保留', () => {
  const analysis = analyzeTrial({
    trial: trial({
      type: 'right', angleDeg: -90, rotationTagId: TAG_A, rotationTagLabel: 'Q010', rotationTagPose: mapTags.tagA,
      startedStamp: 100, endedStamp: 103.1,
    }),
    // 观测与 IMU 都是“机器人实际逆时针转了 90°”，只是这条试验被标成了右转。
    observations: turnObs(), feedback: turnFeedback(), imu: turnImu(), fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2,
    mapTags: {...mapTags, byId: {[String(TAG_A)]: mapTags.tagA, [String(TAG_B)]: mapTags.tagB}},
    imuCalibration: {bias: [0, 0, 0.011], up: [0, 0, 1], source: 'test-snapshot', capturedAt: null, variance: null},
  });
  assert.equal(analysis.rotationDirection, 'right');
  assert.equal(analysis.targetAngleDeg, 90, '目标角仍按绝对值 90 记录');
  assert.equal(analysis.signedTargetAngleDeg, -90, '带符号目标角：右转为负');
  assert.equal(analysis.targetAnglePhrase, '右转 90°（顺时针）', '目标角必须带旋向文案');
  assert.ok(Math.abs(analysis.measuredAngleDeg! - 90) < 1e-6, `实测值必须原样保留，不取绝对值也不改符号：${analysis.measuredAngleDeg}`);
  assert.equal(analysis.measuredAngleSource, 'imu_bias_corrected', '测量来源照旧记录');
  assert.ok(analysis.imuYawRaw !== null && analysis.imuYawBiasCorrected !== null, 'IMU 原始/校正值都要保留作证据');
  assert.equal(analysis.directionMismatch, true);
  assert.equal(analysis.valid, false);
  assert.equal(analysis.invalidReason, 'turn_direction_mismatch');
  assert.equal(analysis.excludedFromAggregate, true);
  assert.ok(analysis.faults.some(item => item.includes('现场实际转的是逆时针')), '必须写清现场实际转的是哪个方向');
});

test('方向一致性：同向不误判，小幅反向（<30°）也不判无效', () => {
  const imuCalibration = {bias: [0, 0, 0], up: [0, 0, 1], source: 'test-snapshot', capturedAt: null, variance: null};
  const tags = {...mapTags, byId: {[String(TAG_A)]: mapTags.tagA, [String(TAG_B)]: mapTags.tagB}};
  // 真的右转：IMU 与轮速都取负，实测 ≈ -90°。
  const rightImu = turnImu(0).map(row => ({...row, gz: -row.gz}));
  const rightFeedback = turnFeedback().map(row => ({...row, wz: -row.wz}));
  const right = analyzeTrial({
    trial: trial({type: 'right', angleDeg: -90, rotationTagId: TAG_A, startedStamp: 100, endedStamp: 103.1}),
    observations: turnObs(), feedback: rightFeedback, imu: rightImu, fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags: tags, imuCalibration,
  });
  assert.ok(right.measuredAngleDeg! < 0, String(right.measuredAngleDeg));
  assert.equal(right.directionMismatch, false, '右转实测为负不该判方向相反');
  assert.equal(right.valid, true, String(right.invalidReason));
  assert.equal(right.invalidReason, null);

  // 右转但只反向转了 20°：幅度没超过 30° 门限，交给误差统计说明，不判无效。
  const smallReverse = turnImu(0).map(row => ({...row, gz: row.gz === 0 ? 0 : 20 * Math.PI / 180}));
  const small = analyzeTrial({
    trial: trial({type: 'right', angleDeg: -90, rotationTagId: TAG_A, startedStamp: 100, endedStamp: 103.1}),
    observations: turnObs(), feedback: turnFeedback(), imu: smallReverse, fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags: tags, imuCalibration,
  });
  assert.ok(small.measuredAngleDeg! > 0 && small.measuredAngleDeg! < 30, String(small.measuredAngleDeg));
  assert.equal(small.directionMismatch, false, '小幅反向不该判 turn_direction_mismatch');
  assert.equal(small.valid, true, String(small.invalidReason));
});

test('会话汇总：turn_direction_mismatch 排除出转向统计，计数/限制/证据齐全', () => {
  const trials = [
    trial({
      id: 'trial-1', repetition: 1, type: 'left', angleDeg: 90,
      rotationTagId: TAG_A, rotationTagLabel: 'Q010', rotationTagPose: mapTags.tagA,
      startedStamp: 100, endedStamp: 103.1,
    }),
    trial({
      id: 'trial-2', repetition: 1, type: 'right', angleDeg: -90,
      rotationTagId: TAG_A, rotationTagLabel: 'Q010', rotationTagPose: mapTags.tagA,
      startedStamp: 200, endedStamp: 203.1,
    }),
  ];
  const samples: {kind: 'observation' | 'feedback' | 'imu'; stamp: number; trialId: string | null; body: unknown}[] = [];
  const shift = (row: {stamp: number}) => ({...row, stamp: row.stamp + 100});
  for (const row of turnFeedback()) samples.push({kind: 'feedback', stamp: row.stamp, trialId: 'trial-1', body: row});
  for (const row of turnObs()) samples.push({kind: 'observation', stamp: row.stamp, trialId: 'trial-1', body: row});
  for (const row of turnImu()) samples.push({kind: 'imu', stamp: row.stamp, trialId: 'trial-1', body: row});
  for (const row of turnFeedback()) samples.push({kind: 'feedback', stamp: row.stamp + 100, trialId: 'trial-2', body: shift(row)});
  for (const row of turnObs()) samples.push({kind: 'observation', stamp: row.stamp + 100, trialId: 'trial-2', body: shift(row)});
  for (const row of turnImu()) samples.push({kind: 'imu', stamp: row.stamp + 100, trialId: 'trial-2', body: shift(row)});
  const analysis = analyzeSession({
    session: session({trials}), samples,
    mapTags: {...mapTags, byId: {[String(TAG_A)]: mapTags.tagA, [String(TAG_B)]: mapTags.tagB}},
    imuCalibration: {bias: [0, 0, 0.011], up: [0, 0, 1], source: 'test-snapshot', capturedAt: null, variance: null},
  });
  assert.equal(analysis.aggregate.turnTrials, 1, '只有同向的左转进入转向统计');
  assert.equal(analysis.aggregate.turnTrialsDirectionMismatch, 1);
  assert.ok(analysis.aggregate.excluded.some(item => item.trialId === 'trial-2' && item.reason === 'turn_direction_mismatch'));
  assert.equal(analysis.aggregate.measuredAngleDeg?.n, 1, '反向试验不得进入实测转角均值');
  assert.equal(analysis.aggregate.imuYawScale?.n, 1, '反向试验不得进入 IMU 转角比例');
  assert.ok(analysis.limitations.some(item => item.includes('方向与目标方向相反')));
  // 证据保留：被排除的那条仍在 trials 里，实测值仍是原始的 +90。
  const reversed = analysis.trials.find(item => item.trialId === 'trial-2')!;
  assert.equal(reversed.directionMismatch, true);
  assert.ok(Math.abs(reversed.measuredAngleDeg! - 90) < 1e-6, String(reversed.measuredAngleDeg));
  const csvHeader = analysisCsv(analysis).split('\n')[0]!;
  for (const column of ['directionMismatch', 'signedTargetAngleDeg']) assert.ok(csvHeader.includes(column), column);
  const reversedRow = analysisCsv(analysis).split('\n').find(line => line.startsWith('trial-2'))!;
  assert.ok(reversedRow.includes(',turn_direction_mismatch,'), reversedRow);
  assert.ok(analysisReport(analysis).includes('turn_direction_mismatch'), '报告必须写明这条被排除的原因');
});

test('前进/后退不要求旋转二维码：schema 拒绝多余字段，分析里一律不适用', () => {
  assert.equal(calibrationTrialInputSchema.safeParse({type: 'forward', rotationTagId: TAG_A}).success, false, '前进不接受旋转二维码');
  assert.equal(calibrationTrialInputSchema.safeParse({type: 'forward'}).success, true);
  assert.equal(calibrationTrialInputSchema.safeParse({type: 'left', angleDeg: 90, rotationTagId: TAG_A}).success, true);
  const analysis = analyzeTrial({
    trial: trial(), observations: [...startObs(), ...endObs()], feedback: feedback(), imu: [], fusion: [],
    tagA: TAG_A, tagB: TAG_B, baselineM: 1.2, mapTags,
  });
  assert.equal(analysis.rotationTagId, null);
  assert.equal(analysis.rotationDirection, null);
  assert.equal(analysis.targetAngleDeg, null);
  assert.equal(analysis.measuredAngleDeg, null);
  assert.equal(analysis.valid, true, String(analysis.invalidReason));
});

test('导出与汇总带旋转字段：rotationTagId/rotationDirection/targetAngleDeg/measuredAngleDeg', () => {
  const trials = [
    trial({id: 'trial-1', repetition: 1, startedStamp: 100, endedStamp: 104.1}),
    trial({
      id: 'trial-2', repetition: 1, type: 'left', angleDeg: 90,
      rotationTagId: TAG_A, rotationTagLabel: 'Q010', rotationTagPose: mapTags.tagA,
      startedStamp: 200, endedStamp: 203.1,
    }),
  ];
  const samples: {kind: 'observation' | 'feedback' | 'imu'; stamp: number; trialId: string | null; body: unknown}[] = [];
  for (const row of feedback()) samples.push({kind: 'feedback', stamp: row.stamp, trialId: 'trial-1', body: row});
  for (const row of startObs()) samples.push({kind: 'observation', stamp: row.stamp, trialId: 'trial-1', body: row});
  for (const row of endObs()) samples.push({kind: 'observation', stamp: row.stamp, trialId: 'trial-1', body: row});
  const shifted = (row: {stamp: number}) => ({...row, stamp: row.stamp + 100});
  for (const row of turnFeedback()) samples.push({kind: 'feedback', stamp: row.stamp + 100, trialId: 'trial-2', body: shifted(row)});
  for (const row of turnObs()) samples.push({kind: 'observation', stamp: row.stamp + 100, trialId: 'trial-2', body: shifted(row)});
  for (const row of turnImu()) samples.push({kind: 'imu', stamp: row.stamp + 100, trialId: 'trial-2', body: shifted(row)});
  const analysis = analyzeSession({
    session: session({trials}), samples,
    mapTags: {...mapTags, byId: {[String(TAG_A)]: mapTags.tagA, [String(TAG_B)]: mapTags.tagB}},
    imuCalibration: {bias: [0, 0, 0.011], up: [0, 0, 1], source: 'test-snapshot', capturedAt: null, variance: null},
  });
  assert.equal(analysis.aggregate.validTrials, 2);
  assert.equal(analysis.aggregate.linearTrials, 1, '位移统计只取前进/后退');
  assert.equal(analysis.aggregate.turnTrials, 1, '角度统计只取转向');
  assert.equal(analysis.aggregate.turnTrialsMissingRotationTag, 0);
  assert.deepEqual(analysis.aggregate.rotationTags, [{tagId: TAG_A, label: 'Q010', trials: 1, validTrials: 1}]);
  assert.equal(analysis.aggregate.measuredAngleDeg?.n, 1);
  assert.equal(analysis.aggregate.targetAngleDeg?.n, 1);
  assert.equal(analysis.aggregate.forwardScale?.n, 1, '转向不进入前进比例统计');
  const csv = analysisCsv(analysis);
  const header = csv.split('\n')[0]!;
  for (const column of ['rotationTagId', 'rotationTagLabel', 'rotationDirection', 'targetAngleDeg', 'measuredAngleDeg', 'measuredAngleSource']) {
    assert.ok(header.includes(column), column);
  }
  const turnRow = csv.split('\n').find(line => line.startsWith('trial-2'))!;
  assert.ok(turnRow.includes(',Q010,'), turnRow);
  assert.ok(turnRow.includes(',left,'), turnRow);
  const report = analysisReport(analysis);
  assert.ok(report.includes('在 Q010 处左转90°'), report.slice(0, 400));
  assert.ok(report.includes('旋转位置'), '报告必须写明在哪个二维码处转');
  assert.ok(report.includes('Q010 × 1'), '汇总必须按二维码聚合旋转位置');
  assert.ok(report.includes('不适用（前进/后退不要求）'), '前进试验不该被要求填旋转二维码');
});

test('会话汇总：只统计有效试验，aborted/invalid 排除并给出原因', () => {
  const trials = [
    trial({id: 'trial-1', repetition: 1, startedStamp: 100, endedStamp: 104.1}),
    trial({id: 'trial-2', repetition: 2, startedStamp: 110, endedStamp: 114.1}),
    trial({id: 'trial-3', repetition: 3, status: 'aborted', startedStamp: 120, endedStamp: 124.1}),
  ];
  const samples: {kind: 'observation' | 'feedback' | 'imu' | 'fusion'; stamp: number; trialId: string | null; body: unknown}[] = [];
  for (const [index, id] of ['trial-1', 'trial-2', 'trial-3'].entries()) {
    const base = index * 10;
    for (const row of feedback()) samples.push({kind: 'feedback', stamp: row.stamp + base, trialId: id, body: {...row, stamp: row.stamp + base}});
    for (const row of startObs()) samples.push({kind: 'observation', stamp: row.stamp + base, trialId: id, body: {...row, stamp: row.stamp + base}});
    for (const row of endObs()) samples.push({kind: 'observation', stamp: row.stamp + base, trialId: id, body: {...row, stamp: row.stamp + base}});
  }
  const analysis = analyzeSession({session: session({trials}), samples, mapTags});
  assert.equal(analysis.trials.length, 3);
  assert.equal(analysis.aggregate.validTrials, 2);
  assert.equal(analysis.aggregate.excluded.length, 1);
  assert.equal(analysis.aggregate.excluded[0]!.trialId, 'trial-3');
  assert.equal(analysis.aggregate.excluded[0]!.reason, 'trial_aborted');
  assert.equal(analysis.aggregate.forwardScale!.n, 2, 'aborted 不进入统计');
  assert.ok(analysis.limitations.some(item => item.includes('已排除 1 次无效/中止试验')));
  assert.ok(analysis.formulas.some(item => item.includes('端点停稳配对')));
});

test('导出：CSV 带新列，报告带端点选样与无效原因', () => {
  const trials = [trial({id: 'trial-1', repetition: 1})];
  const samples: {kind: 'observation' | 'feedback'; stamp: number; trialId: string | null; body: unknown}[] = [];
  for (const row of feedback()) samples.push({kind: 'feedback', stamp: row.stamp, trialId: 'trial-1', body: row});
  for (const row of startObs()) samples.push({kind: 'observation', stamp: row.stamp, trialId: 'trial-1', body: row});
  for (const row of endObs()) samples.push({kind: 'observation', stamp: row.stamp, trialId: 'trial-1', body: row});
  const analysis = analyzeSession({session: session({trials}), samples, mapTags});
  const csv = analysisCsv(analysis);
  assert.ok(csv.startsWith('trialId,type,repetition'), csv.slice(0, 60));
  for (const column of ['visualNetDistance', 'baselineResidualM', 'wheelYawAvailable', 'imuYawBiasCorrected', 'seeA', 'seeB', 'both']) {
    assert.ok(csv.split('\n')[0]!.includes(column), column);
  }
  const report = analysisReport(analysis);
  for (const fragment of ['融合标定报告', 'mapId: map-1', '二维码 A/B: 10 / 11', '外部基线', '端点观测', '起点 A', '终点 B', '视觉相对位姿', '未应用']) {
    assert.ok(report.includes(fragment), fragment);
  }
});

test('schema：拒绝同码、非法角度、非标定样本批次', () => {
  assert.equal(calibrationSessionInputSchema.safeParse({mapId: 'm', mapVersion: 1, tagA: 5, tagB: 5, baselineM: 1}).success, false);
  assert.equal(calibrationSessionInputSchema.safeParse({mapId: 'm', mapVersion: 1, tagA: 5, tagB: 6, baselineM: 0.001}).success, false);
  assert.equal(calibrationSessionInputSchema.safeParse({mapId: 'm', mapVersion: 1, tagA: 5, tagB: 6, baselineM: 1}).success, true);
  assert.equal(calibrationTrialInputSchema.safeParse({type: 'forward', angleDeg: 90}).success, false);
  assert.equal(calibrationTrialInputSchema.safeParse({type: 'left', angleDeg: null}).success, false);
  assert.equal(calibrationTrialInputSchema.safeParse({type: 'left', angleDeg: -90}).success, false);
  assert.equal(calibrationTrialInputSchema.safeParse({type: 'right', angleDeg: -90}).success, true);
  assert.equal(calibrationTrialInputSchema.safeParse({type: 'forward'}).success, true);
  assert.equal(robotSampleBatchSchema.safeParse({sessionId: 'cal-1', trialId: 'trial-1', samples: [{kind: 'imu', stamp: 1, gx: 0, gy: 0, gz: 0}]}).success, true);
  assert.equal(robotSampleBatchSchema.safeParse({sessionId: 'cal-1', samples: []}).success, false);
  assert.ok(defaultStopWindowOptions.minSamples >= 3);
});
