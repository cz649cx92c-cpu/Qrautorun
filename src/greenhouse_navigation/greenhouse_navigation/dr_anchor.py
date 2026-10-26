"""v10 accepted-QR 锚事件：唯一可信 DR 重锚来源（纯数学，无 ROS 依赖）。

localization 在真正接受 QR 校正处构造事件；node 透传；segment 只在事件通过
scope/version/epoch/新鲜/correctionId 校验且能用同源局部里程对齐时重锚。
"""
import math


def wrap(a):
    return math.atan2(math.sin(a), math.cos(a))


def finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def mission_scope(mission):
    field = getattr(mission, 'field', None) or {}
    task = getattr(mission, 'task', None) or {}
    return {'mapId': field.get('id'), 'mapVersion': task.get('mapVersion')}


def build_anchor_event(kind, correction_id, source_stamp, map_id, map_version, local_epoch,
                       scope_generation, anchor_pose, sigma, local_ref, recv_mono,
                       posterior_stamp=None):
    post_stamp = float(local_ref[3]) if posterior_stamp is None else float(posterior_stamp)
    return {'kind': kind, 'correctionId': str(correction_id), 'sourceStamp': float(source_stamp),
            'recvMono': float(recv_mono), 'mapId': map_id, 'mapVersion': map_version,
            'localEpoch': local_epoch, 'scopeGeneration': scope_generation,
            'anchorPose': [float(anchor_pose[0]), float(anchor_pose[1]), float(anchor_pose[2])],
            'posteriorStamp': post_stamp,
            'sigma': max(.01, float(sigma)),
            'localRef': {'x': float(local_ref[0]), 'y': float(local_ref[1]),
                         'yaw': float(local_ref[2]), 'stamp': float(local_ref[3])}}


def anchor_event_ok(event, scope, now_mono, max_age=.5, current_epoch=None, last_correction_id=None):
    """返回 (ok, reason)。scope 必须同时匹配 mapId 与 mapVersion（真实字段，不靠回填）。"""
    if not isinstance(event, dict):
        return False, 'notEvent'
    for key in ('correctionId', 'sourceStamp', 'recvMono', 'mapId', 'localEpoch', 'anchorPose', 'localRef'):
        if key not in event:
            return False, 'missing:' + key
    if not finite(event['sourceStamp']) or not finite(event['recvMono']):
        return False, 'badTime'
    if last_correction_id is not None and str(event.get('correctionId')) == str(last_correction_id):
        return False, 'duplicateCorrection'
    post_stamp = event.get('posteriorStamp')
    ref0 = event.get('localRef') or {}
    if not finite(post_stamp) or not finite(ref0.get('stamp')) or abs(float(post_stamp) - float(ref0['stamp'])) > 1e-6:
        return False, 'posteriorStampMismatch'
    if scope.get('mapId') is not None and event.get('mapId') != scope['mapId']:
        return False, 'mapMismatch'
    if scope.get('mapVersion') is not None and event.get('mapVersion') != scope['mapVersion']:
        return False, 'versionMismatch'
    if current_epoch is not None and event.get('localEpoch') != current_epoch:
        return False, 'epochMismatch'
    recv = event.get('recvMonoLocal', event.get('recvMono'))
    if not finite(recv):
        return False, 'badRecvMono'
    age = now_mono - float(recv)
    if age < -.1 or age > max_age:
        return False, 'staleEvent'
    if not all(finite(v) for v in event['anchorPose'][:3]):
        return False, 'badPose'
    ref = event['localRef']
    if not all(finite(ref.get(k)) for k in ('x', 'y', 'yaw', 'stamp')):
        return False, 'badLocalRef'
    return True, 'ok'


def propagate_anchor(event, local_odom, max_dt=.6):
    """把事件时刻的全局后验位姿，用同源局部里程增量推到当前局部里程时刻。"""
    if not isinstance(local_odom, dict):
        return None, False, 'noLocalOdom'
    ref = event.get('localRef') or {}
    if not all(finite(ref.get(k)) for k in ('x', 'y', 'yaw', 'stamp')):
        return None, False, 'badLocalRef'
    for key in ('x', 'y', 'yaw', 'stamp'):
        if not finite(local_odom.get(key)):
            return None, False, 'badLocalOdom:' + key
    ev_epoch = event.get('localEpoch')
    lo_epoch = local_odom.get('epoch')
    if ev_epoch is not None and lo_epoch is not None and ev_epoch != lo_epoch:
        return None, False, 'epochMismatch'
    dt = float(local_odom['stamp']) - float(ref['stamp'])
    if dt < -.05 or dt > max_dt:
        return None, False, 'localGap'
    post_stamp = event.get('posteriorStamp')
    if not finite(post_stamp) or abs(float(post_stamp) - float(ref['stamp'])) > 1e-6:
        return None, False, 'posteriorStampMismatch'
    pose = [float(v) for v in event['anchorPose'][:3]]
    # 局部 odom 位移是世界(局部系)坐标差，必须先按 (anchorYaw - refYaw) 旋转到地图系，
    # 不能直接用 anchorYaw 旋转（只有 refYaw==0 时才偶然相等）。
    dx = float(local_odom['x']) - float(ref['x'])
    dy = float(local_odom['y']) - float(ref['y'])
    dyaw = wrap(float(local_odom['yaw']) - float(ref['yaw']))
    ang = wrap(pose[2] - float(ref['yaw']))
    c, s = math.cos(ang), math.sin(ang)
    pose[0] += c * dx - s * dy
    pose[1] += s * dx + c * dy
    pose[2] = wrap(pose[2] + dyaw)
    return pose, True, 'ok'


def build_localization_context(base, local_odom, qr_raw, qr_anchor):
    ctx = dict(base or {})
    ctx['localOdom'] = local_odom
    ctx['qrRaw'] = qr_raw
    ctx['qrAnchor'] = qr_anchor
    return ctx
