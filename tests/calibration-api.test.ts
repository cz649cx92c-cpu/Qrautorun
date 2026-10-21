/**
 * 融合标定 API 测试：临时 SQLite、Fastify inject，不监听端口、不发运动命令。
 * 覆盖：会话/试验状态机、真实时间戳样本入库、分析/保存/导出、apply dry-run、
 * 重启后持久化与中断标记、跨会话保护、删除地图实验员字段后的旧数据兼容。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp,root} from '../web/backend/src/server';
import {Store} from '../web/backend/src/store';
import {RobotLink} from '../web/backend/src/robot';
import {defaults,generate,type FieldMap} from '../web/shared/model';

const bridgeKey = () => {
  const config = JSON.parse(readFileSync(resolve(root, 'config/web.json'), 'utf8'));
  return readFileSync(resolve(root, config.bridgeKeyFile), 'utf8').trim();
};
const headers = () => ({'x-bridge-key': bridgeKey()});
type App = Awaited<ReturnType<typeof createApp>>;

async function fixture(run: (app: App, store: Store, database: string, map: FieldMap) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'qr-calibration-api-'));
  const database = join(dir, 'test.db');
  const app = await createApp(database), store = new Store(database);
  const map: FieldMap = {...generate({...defaults, count: 1, length: 2, tagSpacing: 1, angle: 0}), id: 'calib-map', name: '标定地图', source: 'survey', captureQuality: 'verified'};
  try {
    const saved = await app.inject({method: 'POST', url: '/api/maps', payload: {map, baseVersion: 0}});
    assert.equal(saved.statusCode, 200, saved.body);
    await run(app, store, database, {...map, coordinateStatus: 'draft'});
  } finally {
    store.close();
    await app.close();
    rmSync(dir, {recursive: true, force: true});
  }
}

const sessionPayload = (map: FieldMap, overrides: Record<string, unknown> = {}) => ({
  mapId: map.id, mapVersion: 1, tagA: map.tags[0]!.id, tagB: map.tags[1]!.id, baselineM: 1.0, note: '标定', ...overrides,
});
const observation = (stamp: number, tags: {id: number; x: number; y: number; angle: number; sigma: number}[]) => ({
  kind: 'observation', stamp, frame: 'base_link', calibrated: true, synchronized: true, representation: 'board-centers', tags,
});
const imuSample = (stamp: number, gz = 0.2) => ({kind: 'imu', stamp, gx: 0, gy: 0, gz, ax: 0, ay: 0, az: 9.8});
const feedback = (stamp: number, vx = 0.1) => ({stamp, seq: Math.round(stamp * 100), receivedMonotonic: stamp, localEpoch: 'epoch', bodyGear: 6, steeringGear: 5, vx, vyRaw: 0, vy: 0, wz: 0, feedbackSource: 'chassis_info_fb_aggregate', feedbackAgeS: 0.005});

async function createSession(app: App, map: FieldMap, overrides: Record<string, unknown> = {}) {
  const response = await app.inject({method: 'POST', url: '/api/calibration/sessions', payload: sessionPayload(map, overrides)});
  assert.equal(response.statusCode, 200, response.body);
  return response.json().session as {id: string; tagA: number; tagB: number};
}
async function startTrial(app: App, sessionId: string, payload: Record<string, unknown>) {
  const response = await app.inject({method: 'POST', url: `/api/calibration/sessions/${sessionId}/trials`, payload});
  assert.equal(response.statusCode, 200, response.body);
  return response.json().trial as {
    id: string; repetition: number; status: string;
    rotationTagId: number | null; rotationTagLabel: string | null; rotationTagPose: {x: number; y: number; yaw: number} | null;
  };
}
const tagLabelOf = (id: number) => 'Q' + String(id).padStart(3, '0');

test('标定会话：地图版本校验、同码拒绝、列表与样本计数', async () => {
  await fixture(async (app, _store, _database, map) => {
    const missing = await app.inject({method: 'POST', url: '/api/calibration/sessions', payload: sessionPayload(map, {mapVersion: 9})});
    assert.equal(missing.statusCode, 404, missing.body);
    const same = await app.inject({method: 'POST', url: '/api/calibration/sessions', payload: sessionPayload(map, {tagB: map.tags[0]!.id})});
    assert.equal(same.statusCode, 400, same.body);
    const badBaseline = await app.inject({method: 'POST', url: '/api/calibration/sessions', payload: sessionPayload(map, {baselineM: 0.01})});
    assert.equal(badBaseline.statusCode, 400, badBaseline.body);
    const session = await createSession(app, map);
    const list = (await app.inject('/api/calibration/sessions')).json().sessions;
    assert.equal(list.length, 1);
    assert.equal(list[0].mapId, map.id);
    assert.equal(list[0].mapName, '标定地图');
    assert.equal(list[0].baselineM, 1);
    const detail = (await app.inject(`/api/calibration/sessions/${session.id}`)).json();
    assert.deepEqual(detail.sampleCounts, {observation: 0, feedback: 0, imu: 0, fusion: 0});
    assert.equal(detail.recording, null);
    const absent = await app.inject('/api/calibration/sessions/cal-missing');
    assert.equal(absent.statusCode, 404);
  });
});

test('试验状态机：同一时刻只允许一条录制、repetition 递增、角度规则、结束/中止', async () => {
  await fixture(async (app, _store, _database, map) => {
    const session = await createSession(app, map);
    const enqueued: string[] = [];
    const enqueue = RobotLink.prototype.enqueue;
    RobotLink.prototype.enqueue = function (type: string, payload: unknown) { enqueued.push(type); return enqueue.call(this, type as never, payload as never); };
    try {
      const invalidAngle = await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/trials`, payload: {type: 'left', angleDeg: -90}});
      assert.equal(invalidAngle.statusCode, 400, invalidAngle.body);
      const forwardWithoutAngle = await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/trials`, payload: {type: 'forward', angleDeg: 90}});
      assert.equal(forwardWithoutAngle.statusCode, 400);
      const first = await startTrial(app, session.id, {type: 'forward'});
      assert.equal(first.repetition, 1);
      assert.equal(first.status, 'recording');
      assert.equal(first.rotationTagId, null, '前进试验不需要旋转二维码');
      const concurrent = await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/trials`, payload: {type: 'reverse'}});
      assert.equal(concurrent.statusCode, 409, concurrent.body);
      assert.match(concurrent.body, /已有试验正在录制/);
      const stopped = await app.inject({method: 'POST', url: `/api/calibration/trials/${first.id}/stop`});
      assert.equal(stopped.statusCode, 200, stopped.body);
      assert.equal(stopped.json().trial.status, 'saved');
      assert.ok(stopped.json().trial.endedAt);
      const repeatedStop = await app.inject({method: 'POST', url: `/api/calibration/trials/${first.id}/stop`});
      assert.equal(repeatedStop.statusCode, 409);
      const second = await startTrial(app, session.id, {type: 'forward'});
      assert.equal(second.repetition, 2);
      const aborted = await app.inject({method: 'POST', url: `/api/calibration/trials/${second.id}/abort`});
      assert.equal(aborted.json().trial.status, 'aborted');
      const left = await startTrial(app, session.id, {type: 'left', angleDeg: 90, rotationTagId: map.tags[0]!.id});
      assert.equal(left.rotationTagId, map.tags[0]!.id);
      assert.equal(left.rotationTagLabel, tagLabelOf(map.tags[0]!.id), '读出试验时必须带二维码显示名');
      assert.ok(left.rotationTagPose, '读出试验时必须带旋转二维码在地图中的位姿');
      await app.inject({method: 'POST', url: `/api/calibration/trials/${left.id}/stop`});
      assert.equal(left.repetition, 1);
      // 只下发 calibration 上下文命令，绝不出现 start/stop/pause/resume 运动命令。
      assert.ok(enqueued.length >= 4);
      assert.deepEqual([...new Set(enqueued)], ['calibration']);
    } finally { RobotLink.prototype.enqueue = enqueue; }
  });
});

test('真实时间戳样本：观测/IMU 走桥接鉴权入口，反馈复用 motion-records，越权与错会话被拒绝', async () => {
  await fixture(async (app, _store, _database, map) => {
    const session = await createSession(app, map);
    const trial = await startTrial(app, session.id, {type: 'forward'});
    const tags = map.tags.slice(0, 2).map((tag, index) => ({id: tag.id, x: index === 0 ? 0 : 1.2, y: 0, angle: 0, sigma: 0.01, angleSigma: 0.01}));
    const samples = [observation(1000, tags), observation(1000.05, tags), imuSample(1000.01), imuSample(1000.06, 0.21)];
    const unauthorized = await app.inject({method: 'POST', url: '/api/robot/calibration/samples', payload: {sessionId: session.id, trialId: trial.id, samples}});
    assert.equal(unauthorized.statusCode, 401);
    const accepted = await app.inject({method: 'POST', url: '/api/robot/calibration/samples', headers: headers(), payload: {sessionId: session.id, trialId: trial.id, samples}});
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().stored, 4);
    const feedbackRecords = Array.from({length: 20}, (_, index) => feedback(1000 + index * 0.05, 0.12));
    const motion = await app.inject({method: 'POST', url: '/api/robot/motion-records', headers: headers(), payload: {records: feedbackRecords}});
    assert.equal(motion.statusCode, 200, motion.body);
    assert.equal(motion.json().stored, 20);
    const detail = (await app.inject(`/api/calibration/sessions/${session.id}`)).json();
    assert.deepEqual(detail.sampleCounts, {observation: 2, feedback: 20, imu: 2, fusion: 0});
    const stored = (await app.inject(`/api/calibration/sessions/${session.id}/samples?kind=observation`)).json().samples;
    assert.equal(stored.length, 2);
    assert.equal(stored[0].stamp, 1000, 'stamp 必须保留 ROS/后端原始值');
    await app.inject({method: 'POST', url: `/api/calibration/trials/${trial.id}/stop`});
    const afterStop = await app.inject({method: 'POST', url: '/api/robot/calibration/samples', headers: headers(), payload: {sessionId: session.id, trialId: trial.id, samples: [imuSample(1001)]}});
    assert.equal(afterStop.statusCode, 200);
    assert.equal(afterStop.json().stored, 0);
    assert.equal(afterStop.json().ignored, 'trial-not-recording');
    const otherSession = await createSession(app, map);
    const mismatch = await app.inject({method: 'POST', url: '/api/robot/calibration/samples', headers: headers(), payload: {sessionId: otherSession.id, trialId: trial.id, samples: [imuSample(1002)]}});
    assert.equal(mismatch.json().stored, 0);
  });
});

test('分析/保存/导出/apply：前端不进数据、比例候选带假设、apply 只 dry-run', async () => {
  await fixture(async (app, _store, _database, map) => {
    const session = await createSession(app, map);
    const forward = await startTrial(app, session.id, {type: 'forward'});
    const tagA = map.tags[0]!, tagB = map.tags[1]!;
    // 端点停稳配对夹具：起点停稳只看到 A，终点停稳只看到 B，全程没有任何一帧同时看到 A+B。
    const seeA = {id: tagA.id, x: 0, y: 0, angle: 0, sigma: 0.01, angleSigma: 0.01, visibleCount: 10, reprojectionPx: 0.4};
    const seeB = {id: tagB.id, x: 0, y: 0, angle: 0, sigma: 0.01, angleSigma: 0.01, visibleCount: 10, reprojectionPx: 0.4};
    const samples = [
      observation(1000.2, [seeA]), observation(1000.3, [seeA]), observation(1000.4, [seeA]),
      observation(1003.2, [seeB]), observation(1003.3, [seeB]), observation(1003.4, [seeB]),
      ...Array.from({length: 83}, (_, index) => imuSample(1000 + index * 0.05)),
    ];
    await app.inject({method: 'POST', url: '/api/robot/calibration/samples', headers: headers(), payload: {sessionId: session.id, trialId: forward.id, samples}});
    const records = [
      ...Array.from({length: 21}, (_, index) => feedback(1000 + index * 0.05, 0)),
      ...Array.from({length: 41}, (_, index) => feedback(1001.05 + index * 0.05, 0.5)),
      ...Array.from({length: 21}, (_, index) => feedback(1003.1 + index * 0.05, 0)),
    ];
    await app.inject({method: 'POST', url: '/api/robot/motion-records', headers: headers(), payload: {records}});
    await app.inject({method: 'POST', url: `/api/calibration/trials/${forward.id}/stop`});
    const empty = await createSession(app, map);
    const emptyAnalysis = (await app.inject({method: 'POST', url: `/api/calibration/sessions/${empty.id}/analyze`})).json().analysis;
    assert.equal(emptyAnalysis.trials.length, 0);
    assert.ok(emptyAnalysis.limitations.some((item: string) => item.includes('尚未保存任何试验')));
    assert.ok(emptyAnalysis.limitations.some((item: string) => item.includes('外部基线只用于独立校核')));
    const analyzed = await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/analyze`});
    assert.equal(analyzed.statusCode, 200, analyzed.body);
    const analysis = analyzed.json().analysis;
    assert.equal(analysis.tagA, session.tagA);
    assert.equal(analysis.baselineM, 1);
    assert.equal(analysis.baselineSource, 'external_baseline');
    assert.equal(analysis.sampleCounts.observation, 6, '起点 A 三帧 + 终点 B 三帧');
    const trial = analysis.trials[0];
    assert.equal(trial.stopPoint.counts.both, 0, '夹具里 A/B 从不共视');
    assert.equal(trial.stopPoint.counts.seeA, 3);
    assert.equal(trial.stopPoint.counts.seeB, 3);
    assert.equal(trial.valid, true, String(trial.invalidReason));
    assert.ok(Math.abs(trial.visualNetDistance - 1.0) < 0.02, String(trial.visualNetDistance));
    assert.ok(Math.abs(trial.baselineResidual) < 0.02, String(trial.baselineResidual));
    assert.ok(trial.candidates.forwardScale > 0.9, String(trial.candidates.forwardScale));
    assert.equal(trial.fusionStatus.state, 'not_integrated');
    assert.equal(trial.wheelYawStatus.available, false, 'wz 恒为 0 时轮速偏航必须标为不可用');
    assert.ok(trial.assumptions.some((item: string) => item.includes('外部基线只用于残差校核')));
    assert.ok(analysis.formulas.length >= 5);
    // 保存分析结果（与 apply 明确分开）
    const savedResponse = await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/analysis`, payload: {}});
    assert.equal(savedResponse.statusCode, 200, savedResponse.body);
    assert.equal(savedResponse.json().saved, true);
    const listed = (await app.inject('/api/calibration/sessions')).json().sessions.find((item: {id: string}) => item.id === session.id);
    assert.equal(listed.analysisSaved, true);
    assert.equal(listed.applied, false);
    const detail = (await app.inject(`/api/calibration/sessions/${session.id}`)).json();
    assert.ok(detail.session.analysis, '保存后的分析能重新读出');
    // 导出三种格式
    for (const [format, type, fragment] of [['json', 'application/json', '"sessionId"'], ['csv', 'text/csv', 'trialId,type'], ['report', 'text/markdown', '融合标定报告']] as const) {
      const exported = await app.inject(`/api/calibration/sessions/${session.id}/export?format=${format}`);
      assert.equal(exported.statusCode, 200, exported.body);
      assert.match(exported.headers['content-type'] as string, new RegExp(type));
      assert.match(exported.headers['content-disposition'] as string, new RegExp(session.id));
      assert.ok(exported.body.includes(fragment), format);
      // JSON/报告必须带 mapId；CSV 是逐试验表格，元数据在报告与 JSON 里。
      if (format !== 'csv') assert.ok(exported.body.includes(map.id), `导出必须带 mapId（${format}）`);
    }
    // apply 无确认 -> 400；有确认 -> dry-run，不写配置
    const noConfirm = await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/apply`, payload: {}});
    assert.equal(noConfirm.statusCode, 400);
    const dryRun = await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/apply`, payload: {confirm: true}});
    assert.equal(dryRun.statusCode, 200, dryRun.body);
    assert.equal(dryRun.json().applied, false);
    assert.match(dryRun.json().reason, /不会写入/);
    assert.ok(dryRun.json().proposed.forwardScale > 0.4);
    assert.ok('current' in dryRun.json());
    const capabilities = (await app.inject('/api/calibration/capabilities')).json();
    assert.equal(capabilities.applyEnabled, false);
    assert.equal(typeof capabilities.nodeRecorder.error, 'string');
  });
});

test('旋转二维码：前进拒绝该字段，转向缺失入库但分析判 rotation_tag_missing，带码则解析出位姿', async () => {
  await fixture(async (app, _store, _database, map) => {
    const session = await createSession(app, map);
    const rejected = await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/trials`, payload: {type: 'forward', rotationTagId: map.tags[0]!.id}});
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.match(rejected.body, /前进\/后退试验不接受旋转二维码/);

    const missing = await startTrial(app, session.id, {type: 'left', angleDeg: 90});
    assert.equal(missing.rotationTagId, null);
    assert.equal(missing.rotationTagLabel, null);
    await app.inject({method: 'POST', url: `/api/calibration/trials/${missing.id}/stop`});

    const tagged = await startTrial(app, session.id, {type: 'right', angleDeg: -90, rotationTagId: map.tags[1]!.id});
    assert.equal(tagged.rotationTagId, map.tags[1]!.id);
    assert.equal(tagged.rotationTagLabel, tagLabelOf(map.tags[1]!.id));
    assert.ok(tagged.rotationTagPose, '绑定地图里存在该码时必须给出位姿');
    await app.inject({method: 'POST', url: `/api/calibration/trials/${tagged.id}/stop`});

    const analysis = (await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/analyze`})).json().analysis;
    const missingTrial = analysis.trials.find((trial: {trialId: string}) => trial.trialId === missing.id);
    assert.equal(missingTrial.invalidReason, 'rotation_tag_missing');
    assert.equal(missingTrial.rotationDirection, 'left');
    assert.equal(missingTrial.targetAngleDeg, 90);
    assert.equal(missingTrial.visualRelativePose, null, '缺旋转二维码时不得用 A/B 配对冒充转向测量');
    const taggedTrial = analysis.trials.find((trial: {trialId: string}) => trial.trialId === tagged.id);
    assert.equal(taggedTrial.rotationTagId, map.tags[1]!.id);
    assert.equal(taggedTrial.rotationTagLabel, tagLabelOf(map.tags[1]!.id));
    assert.ok(taggedTrial.rotationTagPose, '分析结果必须带旋转二维码位姿');
    assert.equal(taggedTrial.rotationDirection, 'right');
    assert.equal(taggedTrial.targetAngleDeg, 90);
    assert.notEqual(taggedTrial.invalidReason, 'rotation_tag_missing', '已指定旋转二维码就不该报缺失');
    assert.equal(analysis.aggregate.turnTrialsMissingRotationTag, 1);
    assert.equal(analysis.aggregate.rotationTags.length, 1, '汇总里必须能看出在哪个码处转');
    assert.equal(analysis.aggregate.rotationTags[0].tagId, map.tags[1]!.id);
    assert.equal(analysis.aggregate.rotationTags[0].trials, 1, '记录过就要出现在汇总里（即便该次无效）');
    assert.equal(analysis.aggregate.rotationTags[0].validTrials, 0, '无效试验单独计数，不混进统计');
    const csv = (await app.inject(`/api/calibration/sessions/${session.id}/export?format=csv`)).body;
    assert.ok(csv.split('\n')[0]!.includes('rotationTagId'), 'CSV 必须带旋转二维码列');
    const report = (await app.inject(`/api/calibration/sessions/${session.id}/export?format=report`)).body;
    assert.ok(report.includes('旋转位置'), '报告必须写明在哪个二维码处转');
    assert.ok(report.includes(tagLabelOf(map.tags[1]!.id)), report.slice(0, 400));
    const json = (await app.inject(`/api/calibration/sessions/${session.id}/export?format=json`)).body;
    assert.ok(json.includes('rotationTagId'), 'JSON 必须带旋转二维码字段');
  });
});

test('重启持久化：会话/试验/样本/分析可恢复，录制中的试验标记 interrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qr-calibration-restart-'));
  const database = join(dir, 'test.db');
  const map: FieldMap = {...generate({...defaults, count: 1, length: 2, tagSpacing: 1, angle: 0}), id: 'restart-map', name: '重启地图', source: 'survey'};
  try {
    let app = await createApp(database);
    const saved = await app.inject({method: 'POST', url: '/api/maps', payload: {map, baseVersion: 0}});
    assert.equal(saved.statusCode, 200, saved.body);
    const session = await createSession(app, map);
    const done = await startTrial(app, session.id, {type: 'forward'});
    await app.inject({method: 'POST', url: '/api/robot/calibration/samples', headers: headers(), payload: {sessionId: session.id, trialId: done.id, samples: [observation(1000, map.tags.slice(0, 2).map((tag, index) => ({id: tag.id, x: index * 1.2, y: 0, angle: 0, sigma: 0.01})))]}});
    await app.inject({method: 'POST', url: `/api/calibration/trials/${done.id}/stop`});
    const dangling = await startTrial(app, session.id, {type: 'reverse'});
    await app.close();
    app = await createApp(database);
    try {
      const sessions = (await app.inject('/api/calibration/sessions')).json().sessions;
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, session.id);
      const detail = (await app.inject(`/api/calibration/sessions/${session.id}`)).json();
      assert.equal(detail.trials.length, 2);
      assert.equal(detail.trials.find((trial: {id: string}) => trial.id === done.id).status, 'saved');
      assert.equal(detail.trials.find((trial: {id: string}) => trial.id === dangling.id).status, 'interrupted');
      assert.equal(detail.sampleCounts.observation, 1);
      const analysis = (await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/analyze`})).json().analysis;
      assert.equal(analysis.trials.length, 2);
      assert.ok(analysis.trials.some((trial: {status: string; faults: string[]}) => trial.status === 'interrupted' && trial.faults.length > 0));
    } finally { await app.close(); }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('地图删除/版本保护：会话绑定版本被删除后分析 409，删除后新会话不受影响', async () => {
  await fixture(async (app, _store, _database, map) => {
    const session = await createSession(app, map);
    await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/trials`, payload: {type: 'forward'}});
    const deleted = await app.inject({method: 'DELETE', url: `/api/maps/${map.id}`});
    assert.equal(deleted.statusCode, 200, deleted.body);
    const analyzed = await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/analyze`});
    assert.equal(analyzed.statusCode, 409, analyzed.body);
    assert.match(analyzed.body, /地图版本已被删除|地图版本不存在/);
    const recreate = await app.inject({method: 'POST', url: '/api/maps', payload: {map, baseVersion: 0}});
    assert.equal(recreate.statusCode, 200);
    const fresh = await createSession(app, map);
    assert.notEqual(fresh.id, session.id);
  });
});

test('删除实验员姓名后：确认/实测接纳/朝向统一均可省略 operator，旧证据（无 operator）仍被接纳', async () => {
  await fixture(async (app, store, _database, map) => {
    const confirm = await app.inject({method: 'POST', url: '/api/maps/confirm', payload: {mapId: map.id, version: 1, confirm: true, updateTasks: false}});
    assert.equal(confirm.statusCode, 200, confirm.body);
    assert.equal(confirm.json().evidence.operator, '');
    assert.equal(confirm.json().version, 2);
    // 旧证据兼容：把最新版本证据替换成历史格式（没有 operator 字段）
    const evidence = {mapId: map.id, version: 2, confirm: true, updateTasks: false, kind: 'user_confirmation', acceptedVersion: 3, created: new Date().toISOString()};
    const latest = store.get(map.id)!;
    const targetVersion = latest.version + 1;
    const advanced = await app.inject({method: 'POST', url: '/api/maps/confirm', payload: {mapId: map.id, version: latest.version, confirm: true}});
    assert.equal(advanced.statusCode, 200, advanced.body);
    store.db.prepare('DELETE FROM acceptances WHERE map_id=? AND version=?').run(map.id, targetVersion);
    store.db.prepare('INSERT INTO acceptances VALUES(?,?,?,?)').run(map.id, targetVersion, store.digest(store.get(map.id)!.map), JSON.stringify({...evidence, acceptedVersion: targetVersion, version: targetVersion - 1}));
    const readBack = (await app.inject(`/api/maps/${map.id}`)).json();
    assert.deepEqual(readBack.acceptance, {kind: 'user_confirmation', digestValid: true, accepted: true});
    // 实测接纳（无需 operator）：用地图自身坐标当实测值，残差 0
    const measurements = map.tags.slice(0, 3).map(tag => ({id: tag.id, x: tag.x, y: tag.y}));
    const accepted = await app.inject({method: 'POST', url: '/api/maps/accept', payload: {mapId: map.id, version: readBack.version, measurements}});
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().evidence.operator, '');
    // 朝向统一（无需 operator）
    const unified = await app.inject({method: 'POST', url: '/api/maps/unify-angles', payload: {mapId: map.id, version: accepted.json().version, confirm: true}});
    assert.equal(unified.statusCode, 200, unified.body);
    assert.equal(unified.json().evidence.operator, '');
  });
});

test('清空会话试验：DELETE 需显式确认、只删本会话 trials/samples、清空 analysis、保留会话与地图', async () => {
  await fixture(async (app, _store, database, map) => {
    const session = await createSession(app, map);
    const sampleKinds = ['observation', 'feedback', 'imu'];
    for (let index = 0; index < 4; index += 1) {
      const trial = await startTrial(app, session.id, {type: 'forward'});
      const samples = [
        observation(1000 + index, map.tags.slice(0, 2).map((tag, order) => ({id: tag.id, x: order * 1, y: 0, angle: 0, sigma: 0.01}))),
        {kind: 'feedback', ...feedback(1000 + index)},
        imuSample(1000 + index),
      ];
      const posted = await app.inject({method: 'POST', url: '/api/robot/calibration/samples', headers: headers(), payload: {sessionId: session.id, trialId: trial.id, samples}});
      assert.equal(posted.statusCode, 200, posted.body);
      assert.equal(posted.json().stored, sampleKinds.length);
      // 与现场一致：3 条 saved、1 条 aborted
      const ended = await app.inject({method: 'POST', url: `/api/calibration/trials/${trial.id}/${index === 3 ? 'abort' : 'stop'}`});
      assert.equal(ended.statusCode, 200, ended.body);
    }
    const savedAnalysis = await app.inject({method: 'POST', url: `/api/calibration/sessions/${session.id}/analysis`, payload: {}});
    assert.equal(savedAnalysis.statusCode, 200, savedAnalysis.body);
    // 模拟历史上被应用过：清空后必须回到未应用（标定库是独立的 *-calibration.db）
    const calibrationDb = new Database(database.replace(/\.db$/i, '') + '-calibration.db');
    calibrationDb.prepare('UPDATE calibration_sessions SET applied=1 WHERE id=?').run(session.id);
    calibrationDb.close();

    // 另一个会话（不能受影响）
    const other = await createSession(app, map, {tagB: map.tags[2]!.id, baselineM: 1.4});
    const otherTrial = await startTrial(app, other.id, {type: 'reverse'});
    await app.inject({method: 'POST', url: '/api/robot/calibration/samples', headers: headers(), payload: {sessionId: other.id, trialId: otherTrial.id, samples: [{kind: 'feedback', ...feedback(2000)}, imuSample(2000), observation(2000, map.tags.slice(0, 2).map(tag => ({id: tag.id, x: 0, y: 0, angle: 0, sigma: 0.01})))]}});
    await app.inject({method: 'POST', url: `/api/calibration/trials/${otherTrial.id}/stop`});
    await app.inject({method: 'POST', url: `/api/calibration/sessions/${other.id}/analysis`, payload: {}});

    const before = (await app.inject(`/api/calibration/sessions/${session.id}`)).json();
    assert.equal(before.trials.length, 4);
    assert.deepEqual(before.sampleCounts, {observation: 4, feedback: 4, imu: 4, fusion: 0});
    const beforeList = (await app.inject('/api/calibration/sessions')).json().sessions as {id: string; trialCount: number; analysisSaved: boolean; applied: boolean}[];
    assert.equal(beforeList.find(item => item.id === session.id)!.trialCount, 4);
    assert.equal(beforeList.find(item => item.id === session.id)!.applied, true, '前置条件：该会话此时处于已应用状态');

    // 1) 无确认参数：400 且一条都不删
    const noConfirm = await app.inject({method: 'DELETE', url: `/api/calibration/sessions/${session.id}/trials`});
    assert.equal(noConfirm.statusCode, 400, noConfirm.body);
    assert.match(noConfirm.body, /confirm=clear-trials/);
    const wrongConfirm = await app.inject({method: 'DELETE', url: `/api/calibration/sessions/${session.id}/trials?confirm=1`});
    assert.equal(wrongConfirm.statusCode, 400, wrongConfirm.body);
    const untouched = (await app.inject(`/api/calibration/sessions/${session.id}`)).json();
    assert.equal(untouched.trials.length, 4, '未确认时不得删除任何试验');
    assert.deepEqual(untouched.sampleCounts, {observation: 4, feedback: 4, imu: 4, fusion: 0});
    assert.ok(untouched.session.analysis, '未确认时不得清空分析结果');

    // 2) 不存在会话：404
    const absent = await app.inject({method: 'DELETE', url: '/api/calibration/sessions/cal-missing/trials?confirm=clear-trials'});
    assert.equal(absent.statusCode, 404, absent.body);

    // 3) 正式清空：只删本会话 trials + samples，并清 analysis/applied
    const cleared = await app.inject({method: 'DELETE', url: `/api/calibration/sessions/${session.id}/trials?confirm=clear-trials`});
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(cleared.json(), {sessionId: session.id, deletedTrials: 4, deletedSamples: 12});

    const after = (await app.inject(`/api/calibration/sessions/${session.id}`)).json();
    assert.equal(after.trials.length, 0);
    assert.deepEqual(after.sampleCounts, {observation: 0, feedback: 0, imu: 0, fusion: 0});
    assert.equal(after.session.analysis, null, '清空后必须清掉 analysis，避免 0 次试验还挂着旧汇总');
    assert.equal(after.session.applied, false, '清空后必须回到未应用');
    // 会话配置/地图绑定/A·B/基线原样保留
    assert.equal(after.session.id, session.id);
    assert.equal(after.session.mapId, map.id);
    assert.equal(after.session.mapVersion, 1);
    assert.equal(after.session.tagA, map.tags[0]!.id);
    assert.equal(after.session.tagB, map.tags[1]!.id);
    assert.equal(after.session.baselineM, 1);
    assert.equal(after.session.note, '标定');
    const afterList = (await app.inject('/api/calibration/sessions')).json().sessions as {id: string; trialCount: number; analysisSaved: boolean; applied: boolean}[];
    const summary = afterList.find(item => item.id === session.id)!;
    assert.equal(summary.trialCount, 0);
    assert.equal(summary.analysisSaved, false);
    assert.equal(summary.applied, false);

    // 4) 其他会话与地图完全不受影响
    const otherAfter = (await app.inject(`/api/calibration/sessions/${other.id}`)).json();
    assert.equal(otherAfter.trials.length, 1, '其他会话的试验必须保留');
    assert.deepEqual(otherAfter.sampleCounts, {observation: 1, feedback: 1, imu: 1, fusion: 0});
    assert.ok(otherAfter.session.analysis, '其他会话的分析结果必须保留');
    assert.equal(otherAfter.session.baselineM, 1.4);
    const mapAfter = await app.inject(`/api/maps/${map.id}`);
    assert.equal(mapAfter.statusCode, 200);
    assert.equal(mapAfter.json().version, 1, '地图版本不得被清空操作改动');

    // 5) 幂等：再清一次返回 0/0
    const again = await app.inject({method: 'DELETE', url: `/api/calibration/sessions/${session.id}/trials?confirm=clear-trials`});
    assert.equal(again.statusCode, 200, again.body);
    assert.deepEqual(again.json(), {sessionId: session.id, deletedTrials: 0, deletedSamples: 0});

    // 6) 录制中：409 拒绝，且一条都不删
    const recording = await startTrial(app, other.id, {type: 'forward'});
    const refused = await app.inject({method: 'DELETE', url: `/api/calibration/sessions/${other.id}/trials?confirm=clear-trials`});
    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(refused.body, /正在录制/);
    const kept = (await app.inject(`/api/calibration/sessions/${other.id}`)).json();
    assert.equal(kept.trials.length, 2, '录制中拒绝时不得删掉任何试验');
    assert.equal(kept.trials.filter((trial: {status: string}) => trial.status === 'saved').length, 1);
    await app.inject({method: 'POST', url: `/api/calibration/trials/${recording.id}/abort`});
  });
});
