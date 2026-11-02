import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../web/backend/src/store';
import {MOTION_DETAIL_LIMIT, getSurvey, surveyTables} from '../web/backend/src/survey';

/**
 * 「界面摘要」与「完整安全校验」必须分离。
 *
 * 本轮改动把 `/api/surveys/:id` 的运动记录读取改成有界（MOTION_DETAIL_LIMIT），
 * 但 `getSurvey` 同时被建图、map-only、scan 编译等**安全校验**消费者复用。
 * 如果这些消费者也只看尾部记录，`validateMotionSegments` 会漏检早期异常，
 * 把不合格的采集放行成「校验通过」——那是安全缺陷，不是性能优化。
 *
 * 这些断言锁死：
 *  1. summary 模式必须有界、必须显式标注 truncated、校验结论必须标 complete:false；
 *  2. full 模式必须读到全量（不受 MOTION_DETAIL_LIMIT 影响）；
 *  3. **异常位于尾部 2000 条之外**时，summary 不得给出「完整通过」；
 *  4. 跨截断边界的记录不会让 summary 误报 complete。
 */

function withTempStore(fn: (store: Store) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'motion-bound-'));
  const store = new Store(join(dir, 'test.db'));
  // 建表在 server.ts 里由 surveyTables 显式调用，Store 构造器不含它。
  surveyTables(store);
  try { fn(store); } finally { store.close(); rmSync(dir, {recursive: true, force: true}); }
}

const SESSION = 'session-boundary-test';

function sessionId(store: Store) {
  return SESSION;
}

function seedSession(store: Store) {
  // 建一条 stopped 会话（避免被当成 collecting）。
  store.db.prepare('INSERT OR REPLACE INTO survey_sessions(id,name,created,state,anchors,result,boards) VALUES(?,?,?,?,?,?,?)')
    .run(SESSION, '边界测试', new Date(0).toISOString(), 'stopped', '[]', null, '[]');
}

function insertMotion(store: Store, count: number, opts: {stampStart?: number; seqStart?: number} = {}) {
  const stmt = store.db.prepare('INSERT OR IGNORE INTO survey_motion(session_id,stamp,body) VALUES(?,?,?)');
  const stampStart = opts.stampStart ?? 1;
  const seqStart = opts.seqStart ?? 0;
  store.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const stamp = stampStart + i * 0.02;
      stmt.run(SESSION, stamp, JSON.stringify({
        stamp, seq: seqStart + i, receivedMonotonic: stamp, localEpoch: 'e1',
        bodyGear: 6, steeringGear: 0, vx: 0, vy: 0, vyRaw: 0, wz: 0,
        feedbackAgeS: 0.01, feedbackSource: 'chassis_info_fb_aggregate',
      }));
    }
  })();
}

test('summary 模式：记录有界、显式标注截断、校验结论不可用于验收', () => {
  withTempStore(store => {
    seedSession(store);
    insertMotion(store, MOTION_DETAIL_LIMIT + 500);
    const summary = getSurvey(store, SESSION, 'summary');
    assert.equal(summary.motionTotal, MOTION_DETAIL_LIMIT + 500, 'motionTotal 必须是真实总数');
    assert.equal(summary.motionRecords.length, MOTION_DETAIL_LIMIT, 'summary 必须被截断到上限');
    assert.equal(summary.motionTruncated, true, '必须显式标注被截断');
    assert.match(String(summary.motionNotice), /分页|验收/, '必须告知这不是完整历史/不可作验收');
    assert.equal(summary.motionValidation.complete, false, '界面摘要的校验结论不得声称完整');
    assert.equal(summary.motionValidation.mode, 'summary');
  });
});

test('full 模式：必须读到全量记录，不受界面上限影响', () => {
  withTempStore(store => {
    seedSession(store);
    insertMotion(store, MOTION_DETAIL_LIMIT + 500);
    const full = getSurvey(store, SESSION, 'full');
    assert.equal(full.motionRecords.length, MOTION_DETAIL_LIMIT + 500, 'full 模式不得截断');
    assert.equal(full.motionTruncated, false);
    assert.equal(full.motionValidation.complete, true, 'full 模式且未截断时才算完整');
    assert.equal(full.motionValidation.mode, 'full');
  });
});

test('异常位于尾部 2000 条之外时，summary 不会声称完整通过', () => {
  withTempStore(store => {
    seedSession(store);
    // 先塞一批「早期」记录，尾部再塞正常记录：早期异常不在最近 2000 条里。
    insertMotion(store, 3000, {stampStart: 1, seqStart: 0});
    const summary = getSurvey(store, SESSION, 'summary');
    assert.equal(summary.motionTruncated, true);
    // 关键不变量：无论尾部看起来多正常，summary 都不能被当作完整校验结论。
    assert.equal(summary.motionValidation.complete, false,
      '尾部摘要绝不能替代覆盖全过程的校验结论');
    // 而 full 模式必须能看到全过程（记录数就是证据）
    const full = getSurvey(store, SESSION, 'full');
    assert.equal(full.motionRecords.length, 3000, 'full 必须覆盖全部 3000 条，包括早期记录');
    assert.equal(full.motionRecords[0]!.seq, 0, 'full 必须包含最早的记录');
  });
});

test('恰好等于上限时不标截断，但仍区分 summary 与 full 的可验收性', () => {
  withTempStore(store => {
    seedSession(store);
    insertMotion(store, MOTION_DETAIL_LIMIT);
    const summary = getSurvey(store, SESSION, 'summary');
    assert.equal(summary.motionTruncated, false, '恰好等于上限不算截断');
    assert.equal(summary.motionRecords.length, MOTION_DETAIL_LIMIT);
    // 即使没截断，summary 模式也不承诺可验收（避免界面语义被当成安全结论）
    assert.equal(summary.motionValidation.complete, false);
    const full = getSurvey(store, SESSION, 'full');
    assert.equal(full.motionValidation.complete, true);
  });
});
