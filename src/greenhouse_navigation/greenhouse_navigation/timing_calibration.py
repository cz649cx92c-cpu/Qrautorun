"""Validate recorded relative timing evidence before correcting image stamps."""
import hashlib
import json
import math
from pathlib import Path


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
        for name in ('camera_calibration.json', 'camera_extrinsics.json', 'camera_preview.json'):
            actual = hashlib.sha256((Path(config_root)/name).read_bytes()).hexdigest()
            if actual != data['configurationSha256'][name]:
                raise ValueError('时序标定使用的相机配置已变化：'+name)
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
        return {'verified': True, 'reason': '', 'method': data['method'],
                'source': data['timestampSource'], 'profile': profile,
                'delayS': measured, 'uncertaintyS': data['delayUncertaintyS'],
                'hardwareExposureTimestampMeasured': data.get('hardwareExposureTimestampMeasured') is True,
                'evidenceSha256': hashlib.sha256(raw).hexdigest()}
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        return {'verified': False, 'reason': '相对时间标定未通过：'+str(error)}


def timing_profile_matches(evidence, width, height):
    return bool(evidence.get('verified') and evidence.get('profile', {}).get('width') == width
                and evidence.get('profile', {}).get('height') == height)
