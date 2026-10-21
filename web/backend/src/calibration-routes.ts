/**
 * 融合标定 HTTP 路由。所有采集均为被动：不发送任何运动/解锁/导航命令；
 * 开始/结束试验只设置桥接节点的录音上下文（calibration 命令），并记录状态。
 */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {robotSampleBatchSchema} from '../../shared/calibration';
import type {CalibrationStore} from './calibration-store';
import type {RobotLink} from './robot';
import type {Store} from './store';

interface Deps {
  calibration: CalibrationStore;
  store: Store;
  robot: RobotLink;
  root: string;
  authorized: (req: {headers: Record<string, unknown>}) => void;
  log: (event: string) => void;
}

const idParams = z.object({id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)});
const trialParams = z.object({id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)});

export function registerCalibrationRoutes(app: FastifyInstance, deps: Deps) {
  const {calibration, robot, root, authorized, log} = deps;
  /** 最近一次发给桥接节点的 calibration 命令，用于判断旧节点是否支持录音。 */
  let lastCommand: {id: string; at: number} | null = null;

  const sessionOr404 = (id: string) => {
    const session = calibration.getSession(id);
    if (!session) throw Object.assign(new Error('标定会话不存在'), {statusCode: 404});
    return session;
  };

  const enqueueContext = (active: boolean, sessionId: string, trialId: string) => {
    try {
      const result = robot.enqueue('calibration', {active, sessionId, trialId});
      lastCommand = {id: result.commandId, at: Date.now()};
      return result.commandId;
    } catch (error) {
      // 录音是附加能力：桥接节点拒绝时不能让标定状态机失败，只记录原因。
      log('标定录音上下文下发失败：' + (error as Error).message);
      return null;
    }
  };

  app.get('/api/calibration/capabilities', () => {
    const capability = calibration.capabilities();
    let supported = true;
    let error = '';
    if (lastCommand) {
      const result = robot.commandResult(lastCommand.id);
      if (result && result.ok === false) {
        supported = false;
        error = result.message || '桥接节点拒绝标定录音命令';
      }
    }
    if (!capability.lastSampleAt) {
      error = error || '尚未收到标定样本：在页面开始一次记录后确认桥接节点已加载被动录音支持';
    }
    return {
      nodeRecorder: {supported, recording: capability.recording, lastSampleAt: capability.lastSampleAt, lastSampleKind: capability.lastSampleKind, error},
      applyEnabled: false,
      applyReason: '候选参数不会自动写入运行配置；需要人工评审后单独应用。',
    };
  });

  app.get('/api/calibration/sessions', () => ({sessions: calibration.listSessions()}));

  app.post('/api/calibration/sessions', req => {
    const session = calibration.createSession(req.body);
    log('新建融合标定会话 ' + session.id + '：地图 ' + session.mapId + ' v' + session.mapVersion + '，二维码 ' + session.tagA + '→' + session.tagB + '，外部基线 ' + session.baselineM + ' m');
    return {session};
  });

  app.get<{Params: {id: string}}>('/api/calibration/sessions/:id', req => {
    const session = sessionOr404(idParams.parse(req.params).id);
    return {
      session,
      trials: session.trials,
      sampleCounts: calibration.sampleCounts(session.id),
      recording: calibration.activeTrial(),
      capabilities: calibration.capabilities(),
    };
  });

  app.post<{Params: {id: string}}>('/api/calibration/sessions/:id/trials', req => {
    const sessionId = idParams.parse(req.params).id;
    sessionOr404(sessionId);
    const trial = calibration.createTrial(sessionId, req.body);
    const commandId = enqueueContext(true, sessionId, trial.id);
    log('开始标定试验 ' + trial.id + '：' + trial.type
      + (trial.angleDeg === null ? '' : ' ' + trial.angleDeg + '°')
      + (trial.rotationTagId === null ? '' : ' @' + (trial.rotationTagLabel ?? trial.rotationTagId))
      + ' #' + trial.repetition);
    return {trial, recording: {trialId: trial.id}, commandId};
  });

  // 清空会话试验：破坏性操作，必须显式带 confirm=clear-trials；缺参数一律 400 且不执行。
  // 只删本会话的 trials/samples，保留会话配置、地图绑定、A/B、baselineM；有录制中试验时 409。
  app.delete<{Params: {id: string}; Querystring: {confirm?: string}}>('/api/calibration/sessions/:id/trials', (req, reply) => {
    const sessionId = idParams.parse(req.params).id;
    if ((req.query?.confirm ?? '').trim() !== 'clear-trials') {
      reply.code(400);
      return {error: '清空试验需要显式确认参数 confirm=clear-trials'};
    }
    sessionOr404(sessionId);
    const result = calibration.clearSessionTrials(sessionId);
    log('清空融合标定会话试验 ' + sessionId + '：删除试验 ' + result.deletedTrials + ' 次、样本 ' + result.deletedSamples + ' 条');
    return result;
  });

  app.post<{Params: {id: string}}>('/api/calibration/trials/:id/stop', req => {
    const trialId = trialParams.parse(req.params).id;
    const trial = calibration.stopTrial(trialId, 'saved');
    enqueueContext(false, trial.sessionId, trial.id);
    log('结束标定试验 ' + trial.id + '（已保存）');
    return {trial};
  });

  app.post<{Params: {id: string}}>('/api/calibration/trials/:id/abort', req => {
    const trialId = trialParams.parse(req.params).id;
    const trial = calibration.stopTrial(trialId, 'aborted');
    enqueueContext(false, trial.sessionId, trial.id);
    log('中止标定试验 ' + trial.id);
    return {trial};
  });

  app.get<{Params: {id: string}; Querystring: {trialId?: string; kind?: string; limit?: string}}>('/api/calibration/sessions/:id/samples', req => {
    const sessionId = idParams.parse(req.params).id;
    sessionOr404(sessionId);
    const limit = req.query.limit === undefined ? 200 : z.coerce.number().int().min(1).max(2000).parse(req.query.limit);
    const kind = req.query.kind === undefined ? undefined : z.enum(['observation', 'feedback', 'imu', 'fusion']).parse(req.query.kind);
    return {samples: calibration.samples(sessionId, {trialId: req.query.trialId, kind, limit})};
  });

  app.post<{Params: {id: string}}>('/api/calibration/sessions/:id/analyze', req => {
    const sessionId = idParams.parse(req.params).id;
    const result = calibration.analyze(sessionId);
    log('融合标定分析（未保存） ' + sessionId);
    return {analysis: result.analysis};
  });

  app.post<{Params: {id: string}}>('/api/calibration/sessions/:id/analysis', req => {
    const sessionId = idParams.parse(req.params).id;
    const body = z.object({analysis: z.unknown().optional()}).strict().parse(req.body ?? {});
    const analysis = calibration.saveAnalysis(sessionId, body.analysis as never);
    log('保存融合标定分析 ' + sessionId);
    return {saved: true, analysis};
  });

  app.get<{Params: {id: string}; Querystring: {format?: string}}>('/api/calibration/sessions/:id/export', (req, reply) => {
    const sessionId = idParams.parse(req.params).id;
    const format = z.enum(['json', 'csv', 'report']).parse(req.query.format ?? 'json');
    const payload = calibration.exportPayload(sessionId, format);
    return reply.type(payload.contentType).header('Content-Disposition', `attachment; filename="${payload.filename}"`).send(payload.content);
  });

  app.post<{Params: {id: string}}>('/api/calibration/sessions/:id/apply', req => {
    const sessionId = idParams.parse(req.params).id;
    z.object({confirm: z.literal(true)}).strict().parse(req.body ?? {});
    const plan = calibration.applyPlan(sessionId, root);
    log('融合标定应用请求（dry-run，未写配置） ' + sessionId);
    return plan;
  });

  // ROS 桥接被动样本入口。只接受带原始 stamp 的样本；无录制中试验直接丢弃并说明原因。
  app.post('/api/robot/calibration/samples', req => {
    authorized(req);
    const batch = robotSampleBatchSchema.parse(req.body);
    const result = calibration.addSamples(batch.sessionId, batch.trialId, batch.samples);
    if (result.stored) log('接收标定样本 ' + result.stored + ' 条（' + batch.sessionId + '）');
    return result;
  });

  return {};
}
