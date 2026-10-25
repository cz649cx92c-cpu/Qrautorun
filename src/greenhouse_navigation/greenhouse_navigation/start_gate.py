"""Start-gate evaluation for QR-interval navigation.

Pure functions (no ROS) so the real failure vectors can be unit-tested.

The start gate must:
* wait for a fresh, stable localization sample in the current map scope/epoch
  instead of judging the last pose captured before a bridge/fusion restart;
* measure the start offset as along-track / cross-track of the first segment,
  not plain Euclidean distance: a vehicle placed slightly ahead/behind the
  first QR along the route direction but laterally centred must be accepted;
* keep the existing lateral (max_cross_track_m) and heading
  (start_heading_tolerance_deg) safety gates;
* reject explicitly when no valid localization arrives within the timeout.
"""
import math

DEFAULT_AHEAD_M = 0.15
DEFAULT_BEHIND_M = 0.05
DEFAULT_STABLE_SAMPLES = 5
DEFAULT_JITTER_M = 0.01
DEFAULT_JITTER_DEG = 0.5
DEFAULT_WAIT_S = 12.0
SAMPLE_MAX_AGE_S = 0.6


def wrap(angle):
    return math.atan2(math.sin(angle), math.cos(angle))


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def pose_values(pose):
    """Normalize a ROS Pose-like object or a plain dict to {x, y, yaw}.

    Returns (normalized, error). ``error`` is a human-readable structured reason
    when the input type/fields cannot be used; callers must reject explicitly
    instead of indexing the object and crashing the navigation process.
    """
    if pose is None:
        return None, None
    if isinstance(pose, dict):
        values = (pose.get('x'), pose.get('y'), pose.get('yaw'))
    else:
        values = (getattr(pose, 'x', None), getattr(pose, 'y', None), getattr(pose, 'yaw', None))
    if not all(finite(value) for value in values):
        return None, f'不支持的起点位姿类型或字段：{type(pose).__name__}'
    return {'x': float(values[0]), 'y': float(values[1]), 'yaw': float(values[2])}, None


def normalize_pose(pose):
    """Return a normalized pose dict (or None for missing input)."""
    return pose_values(pose)[0]


def _first_segment(field, task):
    segments = (field or {}).get('motionSegments') or []
    if not segments:
        return None
    segment = segments[0]
    points = segment.get('points') or []
    if len(points) < 2:
        return None
    start = points[0]
    second = next((p for p in points[1:] if math.hypot(p['x'] - start['x'], p['y'] - start['y']) > 1e-9), points[-1])
    dx, dy = second['x'] - start['x'], second['y'] - start['y']
    length = math.hypot(dx, dy)
    if length <= 0:
        return None
    tx, ty = dx / length, dy / length
    if segment.get('direction') == 'reverse':
        tx, ty = -tx, -ty
    return {
        'segment': segment,
        'tagId': segment['fromId'],
        'start': {'x': start['x'], 'y': start['y']},
        'travel': (tx, ty),
        'heading': float(segment['bodyYaw']),
        'routeId': (task or {}).get('routeId') or '',
        'mapVersion': (task or {}).get('mapVersion'),
        'turnRequired': segment.get('strategy') == 'turn_forward' and segment.get('mode') == '4t4d',
    }


def first_segment_info(field, task):
    info = _first_segment(field, task)
    if info is None:
        return None
    return {key: value for key, value in info.items() if key != 'segment'}


def _metrics(pose, info):
    dx, dy = pose['x'] - info['start']['x'], pose['y'] - info['start']['y']
    tx, ty = info['travel']
    along = dx * tx + dy * ty
    cross = -dx * ty + dy * tx
    return {
        'alongM': along,
        'crossM': cross,
        'distanceM': math.hypot(dx, dy),
        'headingErrorDeg': math.degrees(wrap(pose['yaw'] - info['heading'])),
    }


def _tag_center(field, tag_id):
    for tag in (field or {}).get('tags') or []:
        if tag.get('id') == tag_id:
            return {'x': tag['x'], 'y': tag['y']}
    return None


def _stable_samples(samples, info, field, localization, config):
    limit = float(config.get('max_position_sigma_m', .03))
    jitter_m = float(config.get('start_stable_jitter_m', DEFAULT_JITTER_M))
    jitter_deg = float(config.get('start_stable_jitter_deg', DEFAULT_JITTER_DEG))
    count = int(config.get('start_gate_stable_samples', DEFAULT_STABLE_SAMPLES))
    recent = [s for s in samples or [] if finite(s.get('t'))]
    if not recent:
        return 0, None
    latest = max(recent, key=lambda s: s['t'])
    now = latest['t']
    window = [
        s for s in recent
        if now - s['t'] <= SAMPLE_MAX_AGE_S
        and s.get('mapId') == (field or {}).get('id')
        and s.get('mapVersion') == (localization or {}).get('mapVersion')
        and s.get('localEpoch') == (localization or {}).get('localEpoch')
        and finite(s.get('sigma')) and 0 < s.get('sigma') <= limit
        and finite(s.get('x')) and finite(s.get('y')) and finite(s.get('yaw'))
    ]
    window = window[-count:]
    if len(window) < count:
        return len(window), None
    xs = [s['x'] for s in window]
    ys = [s['y'] for s in window]
    yaws = [s['yaw'] for s in window]
    if max(xs) - min(xs) > jitter_m or max(ys) - min(ys) > jitter_m:
        return len(window), None
    if max(math.degrees(abs(wrap(y - yaws[0]))) for y in yaws) > jitter_deg:
        return len(window), None
    mean = {
        'x': sum(xs) / len(xs),
        'y': sum(ys) / len(ys),
        'yaw': math.atan2(sum(math.sin(y) for y in yaws), sum(math.cos(y) for y in yaws)),
    }
    return len(window), mean


def evaluate_start_gate(field, task, pose, localization, fusion, pose_age_s, loc_age_s,
                        samples, config, elapsed_s=0.0):
    """Return {decision, message, diagnostics, pose}.

    decision: 'pass' | 'wait' | 'reject'. ``pose`` is the filtered pose to use
    for mission.start on pass.
    """
    info = _first_segment(field, task)
    config = config or {}
    localization = localization or {}
    fusion = fusion or {}
    pose, pose_error = pose_values(pose)
    cross_limit = float(config.get('max_cross_track_m', .05))
    heading_limit = float(config.get('start_heading_tolerance_deg', 15.))
    ahead_limit = float(config.get('start_ahead_tolerance_m', DEFAULT_AHEAD_M))
    behind_limit = float(config.get('start_behind_tolerance_m', DEFAULT_BEHIND_M))
    sigma_limit = float(config.get('max_position_sigma_m', .03))
    loc_timeout = float(config.get('localization_timeout_s', .25))
    wait_s = float(config.get('start_gate_timeout_s', DEFAULT_WAIT_S))
    stable_required = int(config.get('start_gate_stable_samples', DEFAULT_STABLE_SAMPLES))

    base = {
        'mapId': (field or {}).get('id'),
        'mapVersion': (task or {}).get('mapVersion'),
        'routeId': (task or {}).get('routeId') or (info or {}).get('routeId') or '',
        'firstTagId': None,
        'expectedPose': None,
        'actualPose': None,
        'distanceM': None,
        'alongM': None,
        'crossM': None,
        'headingErrorDeg': None,
        'localizationFresh': bool(
            finite(pose_age_s) and 0 <= pose_age_s <= loc_timeout
            and finite(loc_age_s) and 0 <= loc_age_s <= loc_timeout),
        'stableSamples': 0,
        'requiredStableSamples': stable_required,
        'localEpoch': localization.get('localEpoch'),
        'fusionEpoch': fusion.get('epoch'),
        'fusionState': fusion.get('state'),
        'positionSigmaM': localization.get('positionSigmaM'),
        'thresholds': {
            'aheadM': ahead_limit, 'behindM': behind_limit, 'crossM': cross_limit,
            'headingDeg': heading_limit, 'positionSigmaM': sigma_limit,
            'stableSamples': stable_required, 'waitS': wait_s,
        },
        'reason': '',
        'reasonCode': '',
        'finalDecision': 'wait',
        'elapsedS': round(float(elapsed_s), 3),
    }
    if info is not None:
        base['firstTagId'] = info['tagId']
        base['expectedPose'] = {'x': round(info['start']['x'], 6), 'y': round(info['start']['y'], 6),
                                'yawDeg': round(math.degrees(info['heading']), 3)}
    if pose is not None:
        base['actualPose'] = {'x': round(pose['x'], 6), 'y': round(pose['y'], 6),
                              'yawDeg': round(math.degrees(pose['yaw']), 3)}
        # Always expose the raw offset even while waiting: the old failure must be
        # diagnosable without waiting for a stable sample window.
        raw = _metrics(pose, info)
        base.update({'distanceM': round(raw['distanceM'], 4),
                     'alongM': round(raw['alongM'], 4),
                     'crossM': round(raw['crossM'], 4),
                     'headingErrorDeg': round(raw['headingErrorDeg'], 3)})

    def done(decision, code, message):
        base['finalDecision'] = decision
        base['reasonCode'] = code
        base['reason'] = message
        return {'decision': decision, 'message': message, 'diagnostics': base, 'pose': pose}

    if pose_error:
        return done('reject', 'invalid_pose_type', pose_error)
    if info is None:
        # Legacy waypoint routes keep their existing start checks in Mission.start.
        return done('pass', 'legacy_route', '非二维码区间路线，使用原有起点检查')

    # 1) map / route snapshot scope must match the selected field and localization map.
    if localization.get('mapId') and localization.get('mapId') != (field or {}).get('id'):
        return done('reject', 'map_scope_mismatch',
                    f"定位地图 {localization.get('mapId')} 与所选地图 {(field or {}).get('id')} 不一致；请先切换到当前地图定位")
    if base['mapVersion'] is not None and localization.get('mapVersion') is not None \
            and int(localization['mapVersion']) != int(base['mapVersion']):
        return done('reject', 'map_scope_mismatch',
                    f"定位地图版本 v{localization['mapVersion']} 与任务地图版本 v{base['mapVersion']} 不一致")
    tag_center = _tag_center(field, info['tagId'])
    if tag_center is None or math.hypot(tag_center['x'] - info['start']['x'], tag_center['y'] - info['start']['y']) > .03:
        return done('reject', 'route_snapshot_mismatch',
                    f"路线首段起点与地图二维码 Q{info['tagId']:03d} 中心不一致（路线快照可能过期）")

    # 2) localization must be fresh, in the current fusion epoch and inside the accuracy limit.
    if not base['localizationFresh']:
        return done('wait', 'localization_stale',
                    f"等待当前定位样本（位姿 {pose_age_s if pose_age_s is not None else '?'} s / 状态 {loc_age_s if loc_age_s is not None else '?'} s 前）")
    if localization.get('state') != 'FORMAL' or localization.get('poseAvailable') is not True:
        return done('wait', 'localization_not_formal',
                    f"定位尚未进入正式状态（当前 {localization.get('state')}）")
    if fusion.get('epoch') and base['localEpoch'] != fusion.get('epoch'):
        return done('wait', 'localization_epoch_stale',
                    f"定位原点 {base['localEpoch']} 与融合纪元 {fusion.get('epoch')} 不一致，等待重新锚定")
    sigma = localization.get('positionSigmaM')
    if not finite(sigma) or sigma > sigma_limit:
        return done('wait', 'position_sigma_high',
                    f"定位不确定度 {('%.1f cm' % (sigma * 100)) if finite(sigma) else '未知'} 超过起点允许 {sigma_limit * 100:.0f} cm，等待二维码重新校正")

    # 3) require a stable sample window in this map/epoch.
    stable_count, filtered = _stable_samples(samples, info, field, localization, config)
    base['stableSamples'] = stable_count
    if filtered is None:
        return done('wait', 'collecting_stable_samples',
                    f"等待稳定定位样本（{stable_count}/{stable_required}）")
    base['actualPose'] = {'x': round(filtered['x'], 6), 'y': round(filtered['y'], 6),
                          'yawDeg': round(math.degrees(filtered['yaw']), 3)}
    metrics = _metrics(filtered, info)
    base.update({key: round(value, 4) for key, value in metrics.items()})

    # 4) safety gates: lateral and heading unchanged; along-track has its own bounded corridor.
    wrong_lateral = abs(metrics['crossM']) > cross_limit
    wrong_ahead = metrics['alongM'] > ahead_limit
    wrong_behind = metrics['alongM'] < -behind_limit
    if wrong_lateral or wrong_ahead or wrong_behind:
        return done('reject', 'wrong_start_position',
                    f"起点偏差：沿路径 {metrics['alongM'] * 100:.1f} cm（允许前 {ahead_limit * 100:.0f} cm / 后 {behind_limit * 100:.0f} cm），"
                    f"横向 {metrics['crossM'] * 100:.1f} cm（允许 {cross_limit * 100:.0f} cm）；请把车放到 Q{info['tagId']:03d} 附近并对准首段方向")
    if not info.get('turnRequired') and abs(metrics['headingErrorDeg']) > heading_limit:
        return done('reject', 'wrong_start_heading',
                    f"起点航向偏差 {metrics['headingErrorDeg']:.1f}°（允许 {heading_limit:.0f}°）；请把车头对准首段方向")
    return done('pass', 'ok',
                f"起点通过：沿路径 {metrics['alongM'] * 100:.1f} cm、横向 {metrics['crossM'] * 100:.1f} cm、"
                f"航向差 {metrics['headingErrorDeg']:.1f}°，Q{info['tagId']:03d}")


def segment_start_check(pose, segment, config):
    """SegmentExecutor.start double-check with the same along/cross geometry."""
    config = config or {}
    cross_limit = float(config.get('max_cross_track_m', .05))
    heading_limit = float(config.get('start_heading_tolerance_deg', 15.))
    ahead_limit = float(config.get('start_ahead_tolerance_m', DEFAULT_AHEAD_M))
    behind_limit = float(config.get('start_behind_tolerance_m', DEFAULT_BEHIND_M))
    points = segment.get('points') or []
    start = points[0]
    second = next((p for p in points[1:] if math.hypot(p['x'] - start['x'], p['y'] - start['y']) > 1e-9), points[-1])
    dx, dy = second['x'] - start['x'], second['y'] - start['y']
    length = math.hypot(dx, dy)
    tx, ty = dx / length, dy / length
    if segment.get('direction') == 'reverse':
        tx, ty = -tx, -ty
    along = (pose.x - start['x']) * tx + (pose.y - start['y']) * ty
    cross = -(pose.x - start['x']) * ty + (pose.y - start['y']) * tx
    heading = math.degrees(wrap(pose.yaw - float(segment['bodyYaw'])))
    turn_required = segment.get('strategy') == 'turn_forward' and segment.get('mode') == '4t4d'
    heading_ok = turn_required or abs(heading) <= heading_limit
    ok = abs(cross) <= cross_limit and -behind_limit <= along <= ahead_limit and heading_ok
    return {'ok': ok, 'alongM': along, 'crossM': cross, 'headingErrorDeg': heading,
            'message': (f"起点偏差：沿路径 {along * 100:.1f} cm（允许前 {ahead_limit * 100:.0f} cm / 后 {behind_limit * 100:.0f} cm），"
                        f"横向 {cross * 100:.1f} cm（允许 {cross_limit * 100:.0f} cm），航向差 {heading:.1f}°（允许 {heading_limit:.0f}°）")}
