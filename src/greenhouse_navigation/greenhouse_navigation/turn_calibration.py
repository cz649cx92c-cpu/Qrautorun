"""Read-only loader for the latest valid calibration turn statistics.

The navigation runtime must never write calibration data. This module opens
``calibration.db`` with ``mode=ro`` and derives only two bounded controller
inputs from valid, direction-consistent turn trials:

* ``acceptance_deg``           normal turn completion residual target (<= 2.5 deg)
* ``correction_tolerance_deg`` stricter residual target for corrective micro-turns

If no usable analysis exists the fixed defaults are returned. Reversed /
mismatched / invalid trials are excluded so the last known bad right turn can
never become a control target.
"""
import json
import math
import sqlite3
from pathlib import Path

DEFAULT_ACCEPTANCE_DEG = 2.5
DEFAULT_CORRECTION_TOLERANCE_DEG = 1.0
MAX_ERROR_DEG = 15.0
MAX_STD_DEG = 5.0
MISMATCH_MIN_DEG = 30.0


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _defaults(reason):
    return {
        'applied': False,
        'reason': reason,
        'acceptanceDeg': DEFAULT_ACCEPTANCE_DEG,
        'correctionToleranceDeg': DEFAULT_CORRECTION_TOLERANCE_DEG,
    }


def _analysis_errors(analysis):
    errors = []
    used = []
    for trial in analysis.get('trials') or []:
        kind = trial.get('type')
        measured = trial.get('measuredAngleDeg')
        if kind not in ('left', 'right') or not _finite(measured):
            continue
        if trial.get('valid') is False:
            continue
        target = trial.get('targetAngleDeg')
        if not _finite(target):
            target = trial.get('signedTargetAngleDeg')
        target_abs = abs(float(target)) if _finite(target) else 90.0
        signed_target = target_abs if kind == 'left' else -target_abs
        mismatch = trial.get('directionMismatch')
        if mismatch is None:
            mismatch = abs(measured) > MISMATCH_MIN_DEG and (
                (kind == 'right' and measured > 0) or (kind == 'left' and measured < 0))
        if mismatch:
            continue
        error = measured - signed_target
        if abs(error) > MAX_ERROR_DEG:
            continue
        errors.append(error)
        used.append(trial.get('trialId'))
    return errors, used


def load_turn_calibration(database_path=None, calibration_path=None):
    """Load the newest calibration analysis read-only.

    ``database_path`` follows the web side convention: ``<db dir>/calibration.db``.
    ``calibration_path`` may be supplied explicitly (tests / deployment override).
    """
    if calibration_path is not None:
        db = Path(calibration_path)
    elif database_path:
        db = Path(database_path).with_name('calibration.db')
    else:
        return _defaults('未提供标定数据库路径')
    if not db.exists():
        return _defaults('calibration.db 不存在')
    try:
        con = sqlite3.connect(f'file:{db.as_posix()}?mode=ro', uri=True, timeout=2)
        con.row_factory = sqlite3.Row
        try:
            row = con.execute(
                "SELECT id, analysis_at, analysis FROM calibration_sessions "
                "WHERE analysis IS NOT NULL AND length(analysis)>0 "
                "ORDER BY analysis_at DESC LIMIT 1").fetchone()
        finally:
            con.close()
    except Exception as exc:  # noqa: BLE001 - diagnostics must never break navigation
        return _defaults('读取标定分析失败：' + str(exc)[:80])
    if not row:
        return _defaults('尚无已保存的标定分析')
    try:
        analysis = json.loads(row['analysis'])
    except (TypeError, ValueError):
        return _defaults('标定分析 JSON 无法解析')
    errors, used = _analysis_errors(analysis)
    if len(errors) < 3:
        return _defaults(f'有效转向样本不足（{len(errors)} < 3）')
    mean = sum(errors) / len(errors)
    std = math.sqrt(sum((error - mean) ** 2 for error in errors) / len(errors))
    if std > MAX_STD_DEG:
        return _defaults(f'有效转向误差散布过大（σ={std:.2f}°）')
    acceptance = min(DEFAULT_ACCEPTANCE_DEG, max(1.5, 2.0 * std))
    correction = min(acceptance, max(0.8, 0.5 * std))
    return {
        'applied': True,
        'reason': '',
        'sessionId': row['id'],
        'analyzedAt': row['analysis_at'],
        'validTurns': len(errors),
        'meanErrorDeg': round(mean, 4),
        'stdDeg': round(std, 4),
        'acceptanceDeg': round(acceptance, 4),
        'correctionToleranceDeg': round(correction, 4),
        'trialIds': used[:20],
    }
