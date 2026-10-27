"""二维码观测质量的「迟滞 + 有界保持」决策层（v11）。

问题：二维码观测质量（sigma / RMS / 成员数）会先低后高、再下降。若直接把每次
观测都喂给融合层，质量下降时较差的新观测会覆盖此前已确认的高质量结果；但若
永久锁存旧观测，又会在地图/epoch 变更或车辆真的动了之后继续用过期信息。

本模块只做**决策**，不碰 EKF、不改观测数值、不冻结位姿：
  * 只从观测本身读质量（sigma/angleSigma/成员数），绝不看预测位姿去"美化"质量；
  * 已锁定高质量观测时，质量下降的观测默认 **hold**（保留旧观测继续用正常
    里程计预测），只有满足下列任一条件才放行/失效：
      - 连续下降帧数超过 ``qr_quality_hold_frames``
      - 保持时长超过 ``qr_quality_max_hold_s``
      - 与当前预测位姿的创新超过 ``qr_quality_hard_innovation_m``（硬门）
  * 硬门创新既不放行低质量观测、也不盲目沿用旧观测，而是交给上层的
    innovation/异常保护拒绝或进入安全状态；
  * epoch / mapVersion / sourceStamp / 重复帧的校验在迟滞之前，任何一条不满足
    都直接拒绝并清空保持，绝不因"迟滞"绕过；
  * 保持到期后丢弃旧观测，回到正常「拒绝 / 等待重锚」流程。

注意：这里不是"取单个最高置信度码"，而是对**时间序列上的质量变化**做迟滞，
因此能同时容纳"先低后高"和"高后短时下降"两种真实序列。
"""
import math

# 保守默认值：由现有配置约束推导，不放松既有安全门。
#   max_innovation_m 现为 0.2 → 硬门取 0.10（更严，绝不更宽松）
#   stable_feedback_samples 为 5 → 保持帧数取 6（略大于一次停稳确认窗口）
#   停稳确认超时 mode_timeout_s=8s → 保持时长取 1.5s（远小于超时）
DEFAULT_PARAMS = {
    'qr_quality_degrade_ratio': 1.5,      # 恶化到 1.5 倍 sigma 才算"质量下降"
    'qr_quality_hold_frames': 6,          # 连续下降帧数上限
    'qr_quality_max_hold_s': 1.5,         # 最大保持时长
    'qr_quality_hard_innovation_m': .10,  # 硬创新门（比 max_innovation_m=0.2 更严）
    'qr_quality_min_sigma_m': .001,       # 质量下限保护，避免除零
}


def observation_quality(tag):
    """只从观测字段读质量；不修改入参，不参考预测位姿。"""
    sigma = tag.get('sigma')
    if not isinstance(sigma, (int, float)) or isinstance(sigma, bool) or not math.isfinite(sigma):
        sigma = tag.get('sigmaM')
    if not isinstance(sigma, (int, float)) or isinstance(sigma, bool) or not math.isfinite(sigma):
        sigma = float('inf')
    angle = tag.get('angleSigma', tag.get('angleSigmaRad'))
    if not isinstance(angle, (int, float)) or isinstance(angle, bool) or not math.isfinite(angle):
        angle = float('inf')
    members = tag.get('memberIds')
    if isinstance(members, (list, tuple)):
        members = len(members)
    elif not isinstance(members, int) or isinstance(members, bool):
        members = tag.get('members', 0)
        if not isinstance(members, int) or isinstance(members, bool):
            members = 0
    return {'sigmaM': float(sigma), 'angleSigmaRad': float(angle), 'members': int(members)}


def _worse_than(candidate, held, ratio):
    """候选质量是否明显差于已锁定的高质量（sigma 变大即变差）。"""
    if held is None:
        return False
    hs = held['sigmaM']
    cs = candidate['sigmaM']
    if not math.isfinite(cs):
        return True
    if not math.isfinite(hs):
        return False
    return cs > hs * ratio


def _innovation(pose, predicted):
    if pose is None or predicted is None:
        return 0.
    try:
        dx = float(pose[0]) - float(predicted[0])
        dy = float(pose[1]) - float(predicted[1])
        da = float(pose[2]) - float(predicted[2]) if len(pose) > 2 and len(predicted) > 2 else 0.
    except (TypeError, ValueError, IndexError):
        return 0.
    if not all(math.isfinite(v) for v in (dx, dy, da)):
        return 0.
    return math.hypot(dx, dy)


class QrQualityHysteresis:
    """有界保持 + 迟滞的质量决策器。

    上层用法：``update(quality, pose, scope, source_stamp, now)``；
    返回 dict 里的 ``accept`` 决定是否把该观测交给融合/锚更新，
    ``decision`` / ``qualityState`` 等字段直接进日志。
    """

    def __init__(self, params=None):
        self.p = dict(DEFAULT_PARAMS)
        if params:
            self.p.update({k: v for k, v in params.items() if k in DEFAULT_PARAMS})
        self.held = None            # 已锁定的高质量观测质量
        self.held_pose = None       # 锁定时的位姿（仅供诊断，不用来冻结）
        self.held_since = None      # 最后一次确认高质量的时刻
        self.hold_frames = 0
        self.hold_since = None
        self.last_stamp = None
        self.scope = None

    # -- 内部 -------------------------------------------------------------
    def _reset(self):
        self.held = None
        self.held_pose = None
        self.hold_frames = 0
        self.hold_since = None

    def _result(self, decision, accept, quality, pose, predicted, innovation,
                scope, source_stamp, reason=''):
        return {
            'decision': decision,
            'accept': bool(accept),
            'qualityState': ('accepted_anchor' if accept else
                             'held_observation' if decision == 'hold' else
                             'expired' if decision == 'holdExpired' else
                             'innovationGate' if decision == 'rejectInnovation' else
                             'rejected'),
            'candidateQuality': dict(quality) if quality else {},
            'heldQuality': dict(self.held) if self.held else {},
            'holdFrames': self.hold_frames,
            'holdAge': (0. if self.hold_since is None else round(self.hold_age, 4)),
            'holdReason': reason,
            'innovation': round(float(innovation), 6),
            'posePrediction': 'odometry',
            'sourceStamp': source_stamp,
            'scope': dict(scope) if isinstance(scope, dict) else {},
            'pose': list(pose) if pose is not None else None,
        }

    @property
    def hold_age(self):
        return 0. if self.hold_since is None else max(0., self._now - self.hold_since)

    # -- 主入口 -----------------------------------------------------------
    def update(self, quality, pose, scope, source_stamp, now, predicted=None):
        self._now = float(now)
        quality = dict(quality or {})
        scope = scope if isinstance(scope, dict) else {}

        # 1) scope / epoch 校验先于迟滞：任何不匹配都清空保持，不得绕过。
        if self.scope is not None and (
                scope.get('mapId') != self.scope.get('mapId')
                or scope.get('mapVersion') != self.scope.get('mapVersion')
                or scope.get('localEpoch') != self.scope.get('localEpoch')):
            self._reset()
            self.scope = dict(scope)
            self.last_stamp = source_stamp
            return self._result('rejectScope', False, quality, pose, predicted, 0.,
                                scope, source_stamp, 'scopeChanged')
        self.scope = dict(scope)

        # 2) 重复帧 / 倒序帧：不得被迟滞绕过。
        if source_stamp is not None and self.last_stamp is not None:
            if float(source_stamp) == float(self.last_stamp):
                return self._result('duplicate', False, quality, pose, predicted, 0.,
                                    scope, source_stamp, 'duplicateStamp')
            if float(source_stamp) < float(self.last_stamp):
                return self._result('staleStamp', False, quality, pose, predicted, 0.,
                                    scope, source_stamp, 'olderStamp')
        self.last_stamp = source_stamp

        # 3) 尚无锁定时：任何合格观测都可建立锁定（不存在"高质量"可比）。
        if self.held is None:
            self.held = dict(quality)
            self.held_pose = list(pose) if pose is not None else None
            self.held_since = self._now
            self.hold_frames = 0
            self.hold_since = None
            return self._result('firstLock', True, quality, pose, predicted, 0.,
                                scope, source_stamp, 'firstLock')

        innovation = _innovation(pose, predicted if predicted is not None else self.held_pose)

        # 4) 硬创新门：明显位姿变化不得盲目沿用旧观测，也不放行低质量观测。
        if innovation > float(self.p['qr_quality_hard_innovation_m']):
            self._reset()
            return self._result('rejectInnovation', False, quality, pose, predicted,
                                innovation, scope, source_stamp, 'hardInnovation')

        # 5) 质量未下降（或明显更好）：直接接受并刷新锁定。
        ratio = float(self.p['qr_quality_degrade_ratio'])
        if not _worse_than(quality, self.held, ratio):
            self.held = dict(quality)
            self.held_pose = list(pose) if pose is not None else None
            self.held_since = self._now
            self.hold_frames = 0
            self.hold_since = None
            return self._result('qualityOk', True, quality, pose, predicted,
                                innovation, scope, source_stamp, 'qualityAcceptable')

        # 6) 质量下降：进入有界保持，保留上一高质量观测，继续用正常里程计预测。
        if self.hold_since is None:
            # 保持时长从「最后一次确认高质量」起算，而不是从本次下降帧起算，
            # 否则单帧下降永远算 0 秒、最大保持时长形同失效。
            self.hold_since = self.held_since if self.held_since is not None else self._now
            self.hold_frames = 0
        self.hold_frames += 1
        too_many = self.hold_frames > int(self.p['qr_quality_hold_frames'])
        too_long = (self._now - self.hold_since) > float(self.p['qr_quality_max_hold_s'])
        if too_many or too_long:
            reason = 'holdFramesExceeded' if too_many else 'holdAgeExceeded'
            self._reset()
            return self._result('holdExpired', False, quality, pose, predicted,
                                innovation, scope, source_stamp, reason)
        return self._result('hold', False, quality, pose, predicted, innovation,
                            scope, source_stamp, 'qualityDegraded')
