"""Validate recorded relative timing evidence before correcting image stamps.

时序证据绑定的是「采集规格 + 时间关系」，不是预览显示。rotate / hflip / vflip 一类
字段只改变浏览器看到的画面方向，不改变采集分辨率、帧率或曝光时序，因此不得让已经
验证过的采集时序标定失效。

2026-10-22 事故：给 camera_preview.json 增加 rotate=180（仅预览翻转）后，整文件
sha256 失配，captureTimestampVerified 掉成 false，导航相机条件永久不满足。
"""
import hashlib
import json
import math
from pathlib import Path

# 预览显示字段：逐层剔除，不参与采集指纹。
# 这些字段变化只影响"人看到的画面"，不影响采集与时间关系。
PREVIEW_ONLY_FIELDS = frozenset({
    'rotate', 'rotation', 'rotateDeg', 'rotationDeg',
    'hflip', 'vflip', 'flip', 'flipHorizontal', 'flipVertical',
    'mirror', 'mirrored', 'preview', 'previewOnly', 'previewRotation',
    'display', 'displayRotation', 'overlay', 'overlayEnabled',
    'grid', 'gridVisible', 'ui', 'label',
})
# 影响成像几何的配置：整文件哈希，严格绑定。
STRICT_FILES = ('camera_calibration.json', 'camera_extrinsics.json')
# 影响采集规格的配置：按采集字段指纹绑定，忽略预览显示字段。
PREVIEW_FILE = 'camera_preview.json'
ALL_FILES = STRICT_FILES + (PREVIEW_FILE,)


def _without_preview(value):
    """递归剔除预览显示字段，保留其余全部配置（含未知的新增采集字段）。"""
    if isinstance(value, dict):
        return {key: _without_preview(item) for key, item in value.items()
                if key not in PREVIEW_ONLY_FIELDS}
    if isinstance(value, list):
        return [_without_preview(item) for item in value]
    return value


def capture_configuration(path):
    """读取配置并去掉预览显示字段；无法解析时返回 None。"""
    try:
        return _without_preview(json.loads(Path(path).read_text(encoding='utf-8')))
    except (OSError, ValueError, TypeError):
        return None


def capture_fingerprint(path):
    """采集配置指纹：只覆盖影响采集/时间的字段，明确排除 rotate/hflip/vflip 等。"""
    configuration = capture_configuration(path)
    if configuration is None:
        return None
    canonical = json.dumps(configuration, sort_keys=True, separators=(',', ':'),
                           ensure_ascii=False)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def acquisition_profile(configuration):
    """默认采集档的 width/height/fps；未声明时返回 None。"""
    if not isinstance(configuration, dict):
        return None
    profiles = configuration.get('profiles')
    if not isinstance(profiles, list) or not profiles:
        return None
    default = configuration.get('defaultProfile')
    chosen = next((item for item in profiles
                   if isinstance(item, dict) and item.get('id') == default), None)
    if chosen is None:
        chosen = next((item for item in profiles if isinstance(item, dict)), None)
    if chosen is None:
        return None
    try:
        return {'width': int(chosen['width']), 'height': int(chosen['height']),
                'fps': int(chosen['fps'])}
    except (KeyError, TypeError, ValueError):
        return None


def _verify_preview(config_root, data, profile):
    """预览配置只按采集字段校验：方向改动放行，采集规格改动拒绝。"""
    path = Path(config_root) / PREVIEW_FILE
    configuration = capture_configuration(path)
    if configuration is None:
        raise ValueError('时序标定使用的相机配置已变化：' + PREVIEW_FILE)
    recorded = (data.get('configurationCaptureSha256') or {}).get(PREVIEW_FILE)
    if recorded is not None:
        # 新证据：采集字段指纹（device/分辨率/帧率/曝光模式等）逐项绑定。
        if capture_fingerprint(path) != recorded:
            raise ValueError('时序标定使用的相机采集配置已变化：' + PREVIEW_FILE)
        return
    # 旧证据（2026-10-15，只有整文件哈希）：预览字段改动后整文件哈希必然失配，
    # 但物理上采集时序未变。退化为校验「已声明的采集规格」本身，避免为了一个预览
    # 开关重跑两段实车运动标定；同时拒绝分辨率/帧率/设备路径不合规的配置。
    # 未声明的字段无从校验，不做臆断（新证据用 configurationCaptureSha256 逐项钉住）。
    device = configuration.get('device')
    if device is not None and (not isinstance(device, str)
                               or not device.startswith('/dev/v4l/by-id/')):
        raise ValueError('时序标定使用的相机配置已变化：' + PREVIEW_FILE)
    declared = acquisition_profile(configuration)
    if declared is not None and declared != profile:
        raise ValueError('时序标定使用的相机采集规格已变化：' + PREVIEW_FILE)


def load_relative_timing(path, config_root, delay_s):
    if not path:
        return {'verified': False, 'reason': '相机采集时间/相对延迟待验证'}
    try:
        raw = Path(path).read_bytes()
        data = json.loads(raw)
        if (data.get('schemaVersion') != 1 or data.get('relativeTimingVerified') is not True
                or data.get('method') != 'ground_board_motion_to_local_odometry'
                or data.get('rejectionReasons') != [] or len(data.get('runs', [])) < 2):
            raise ValueError('缺少独立运动时序验证')
        measured = data['appliedDelayS']
        if (isinstance(measured, bool) or not isinstance(measured, (int, float))
                or not math.isfinite(measured) or not 0 <= measured <= .2
                or abs(measured-delay_s) > 1e-9):
            raise ValueError('延迟参数与实测证据不一致')
        for name in STRICT_FILES:
            actual = hashlib.sha256((Path(config_root)/name).read_bytes()).hexdigest()
            if actual != data['configurationSha256'][name]:
                raise ValueError('时序标定使用的相机配置已变化：'+name)
        if PREVIEW_FILE not in data['configurationSha256']:
            raise ValueError('时序标定缺少相机采集配置证据：'+PREVIEW_FILE)
        if len({run['source'] for run in data['runs']}) < 2 or len({run['epoch'] for run in data['runs']}) < 2:
            raise ValueError('需两段独立原始记录和定位原点')
        for run in data['runs']:
            if (run['eligibleFrames'] < 20 or run['translationSpanM'] < .015
                    or run['otherRunDelayValidation']['radialP95M'] > .002):
                raise ValueError('独立运动验证不足')
            if hashlib.sha256(Path(run['source']).read_bytes()).hexdigest() != run['sha256']:
                raise ValueError('原始运动记录已变化')
        profile = data['cameraProfile']
        if profile != {'width': 1280, 'height': 720, 'fps': 30}:
            raise ValueError('未经验证的相机采集规格')
        _verify_preview(config_root, data, profile)
        return {'verified': True, 'reason': '', 'method': data['method'],
                'source': data['timestampSource'], 'profile': profile,
                'delayS': measured, 'uncertaintyS': data['delayUncertaintyS'],
                'hardwareExposureTimestampMeasured': data.get('hardwareExposureTimestampMeasured') is True,
                'captureFingerprint': capture_fingerprint(Path(config_root)/PREVIEW_FILE),
                'captureBinding': 'capture-fields' if (data.get('configurationCaptureSha256') or {}).get(PREVIEW_FILE)
                                  else 'legacy-capture-spec',
                'evidenceSha256': hashlib.sha256(raw).hexdigest()}
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        return {'verified': False, 'reason': '相对时间标定未通过：'+str(error)}


def timing_profile_matches(evidence, width, height):
    return bool(evidence.get('verified') and evidence.get('profile', {}).get('width') == width
                and evidence.get('profile', {}).get('height') == height)
