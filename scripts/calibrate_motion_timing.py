#!/usr/bin/env python3
"""Estimate effective receive-to-local-odometry delay from recorded motion.

Offline analysis only. A stationary ground board transformed through local
odometry should remain fixed. Fit delay separately to two actual motion runs,
then evaluate each run with the delay fitted on the other run. This estimates
relative host-clock alignment, not a hardware exposure-trigger measurement.
"""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares

ROOT = Path(__file__).resolve().parents[1]


def prepare(record, group_id='B000'):
    odom = record['samples']['localOdom']
    epochs = collections.Counter(v['epoch'] for v in odom if v.get('epoch'))
    if not epochs:
        raise ValueError('No local odometry epoch')
    epoch = epochs.most_common(1)[0][0]
    odom = [v for v in odom if v.get('epoch') == epoch]
    stamps = np.asarray([v['stamp'] for v in odom])
    pose = np.asarray([v['pose'] for v in odom])
    if len(stamps) < 20 or np.any(np.diff(stamps) <= 0):
        raise ValueError('Insufficient or non-monotonic odometry')
    pose[:, 2] = np.unwrap(pose[:, 2])
    rows = []
    for entry in record['samples']['tags']:
        data = entry['data']
        if entry.get('epoch') != epoch or data.get('calibrated') is not True:
            continue
        for tag in data.get('tags', []):
            if tag.get('groupId') == group_id:
                rows.append([data['stamp'], tag['x'], tag['y']])
    if not rows:
        raise ValueError('No board center observations')
    tags = np.asarray(rows)
    if not np.all(np.isfinite(tags)) or not np.all(np.isfinite(pose)):
        raise ValueError('Non-finite observations')
    # Every candidate (-150..200ms) uses exactly the same frames, no padding,
    # extrapolation, or comparisons across a feedback/odometry gap.
    valid = (tags[:, 0]-.2 > stamps[0]) & (tags[:, 0]+.15 < stamps[-1])
    for i, stamp in enumerate(tags[:, 0]):
        local_gaps = np.diff(stamps)[(stamps[:-1] < stamp+.15) & (stamps[1:] > stamp-.2)]
        if len(local_gaps) == 0 or np.any(local_gaps >= .1):
            valid[i] = False
    tags = tags[valid]
    if len(tags) < 20 or np.any(np.diff(tags[:, 0]) <= 0):
        raise ValueError('Insufficient covered, monotonic board observations')
    origin = stamps[0]
    stamps -= origin
    tags[:, 0] -= origin
    return {'epoch': epoch, 'stamps': stamps, 'poses': pose, 'tags': tags,
            'translationSpanM': float(np.ptp(tags[:, 1])),
            'maximumOdomGapS': float(np.max(np.diff(stamps)))}


def board_points(data, delay, scale=1.):
    stamps = data['tags'][:, 0] - delay
    poses = np.array([np.interp(stamps, data['stamps'], data['poses'][:, i]) for i in range(3)]).T
    c, s = np.cos(poses[:, 2]), np.sin(poses[:, 2])
    relative = data['tags'][:, 1:3]
    return scale*poses[:, :2] + np.array([c*relative[:, 0]-s*relative[:, 1],
                                        s*relative[:, 0]+c*relative[:, 1]]).T


def residual(data, params, scale_fit=False, indices=None):
    points = board_points(data, params[0], params[1] if scale_fit else 1.)
    if indices is not None:
        points = points[indices]
    center = np.asarray(params[2:4] if scale_fit else params[1:3])
    return (points-center).ravel()


def fit(data, scale_fit=False, indices=None):
    center = board_points(data, 0.).mean(axis=0)
    initial = [.02, 1., *center] if scale_fit else [.02, *center]
    lower = [-.15, .8, -np.inf, -np.inf] if scale_fit else [-.15, -np.inf, -np.inf]
    upper = [.2, 1.2, np.inf, np.inf] if scale_fit else [.2, np.inf, np.inf]
    result = least_squares(lambda p: residual(data, p, scale_fit, indices), initial,
                           bounds=(lower, upper), loss='soft_l1', f_scale=.0005)
    return {'delayS': float(result.x[0]),
            'scale': float(result.x[1]) if scale_fit else 1.,
            'center': result.x[2:4].tolist() if scale_fit else result.x[1:3].tolist(),
            'rmsM': float(np.sqrt(np.mean(residual(data, result.x, scale_fit)**2)))}


def evaluate_delay(data, delay):
    points = board_points(data, delay)
    center = np.median(points, axis=0)
    radial = np.linalg.norm(points-center, axis=1)
    return {'coordinateRmsM': float(np.sqrt(np.mean((points-center)**2))),
            'radialP95M': float(np.quantile(radial, .95))}


def analyze(paths):
    runs, parsed = [], []
    for path in paths:
        raw = json.loads(path.read_text())
        data = prepare(raw)
        fixed, scale = fit(data), fit(data, True)
        frames = []
        for offset in range(3):
            train = np.arange(len(data['tags'])) % 3 != offset
            test = ~train
            train_fit = fit(data, indices=train)
            params = [train_fit['delayS'], *train_fit['center']]
            frames.append({'delayS': train_fit['delayS'],
                           'heldOutCoordinateRmsM': float(np.sqrt(np.mean(residual(data, params, indices=test)**2)))})
        run = {'source': str(path.resolve()), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
               'epoch': data['epoch'], 'boardGroup': 'B000', 'eligibleFrames': len(data['tags']),
               'translationSpanM': data['translationSpanM'], 'maximumOdomGapS': data['maximumOdomGapS'],
               'fixedScaleFit': fixed, 'scaleSensitivityFit': scale, 'interleavedHoldout': frames,
               'speedMaximumMps': max(abs(s['vx']) for s in raw['samples']['feedback']),
               'experimentOutcome': raw.get('outcome'), 'experimentStopReason': raw.get('error')}
        runs.append(run)
        parsed.append(data)
    if len(runs) < 2:
        raise ValueError('Two independent motion records are required')
    delay = float(np.mean([r['fixedScaleFit']['delayS'] for r in runs]))
    delay = round(delay, 3)
    for i, run in enumerate(runs):
        other_delay = runs[(i+1) % len(runs)]['fixedScaleFit']['delayS']
        run['otherRunDelayValidation'] = {'delayS': other_delay, **evaluate_delay(parsed[i], other_delay)}
        run['appliedDelayValidation'] = {'delayS': delay, **evaluate_delay(parsed[i], delay)}
        run['zeroDelayBaseline'] = evaluate_delay(parsed[i], 0.)
    reasons = []
    if not 0. <= delay <= .2:
        reasons.append('Delay falls outside the supported correction range')
    if max(r['fixedScaleFit']['delayS'] for r in runs)-min(r['fixedScaleFit']['delayS'] for r in runs) > .03:
        reasons.append('Independent delay estimates disagree by more than 30ms')
    for run in runs:
        if run['translationSpanM'] < .015:
            reasons.append('Motion span below 15mm')
        if abs(run['scaleSensitivityFit']['delayS']-run['fixedScaleFit']['delayS']) > .02:
            reasons.append('Delay is too sensitive to odometry scale')
        if abs(run['scaleSensitivityFit']['scale']-1.) > .05:
            reasons.append('Visual/odometry scale disagreement exceeds 5%')
        if run['otherRunDelayValidation']['radialP95M'] > .002:
            reasons.append('Independent validation residual exceeds 2mm')
        if run['appliedDelayValidation']['coordinateRmsM'] > run['zeroDelayBaseline']['coordinateRmsM']:
            reasons.append('Correction did not improve the recorded motion alignment')
    hashes = {name: hashlib.sha256((ROOT/'config'/name).read_bytes()).hexdigest()
              for name in ['camera_calibration.json', 'camera_extrinsics.json', 'camera_preview.json']}
    return {'schemaVersion': 1, 'method': 'ground_board_motion_to_local_odometry',
            'timestampSource': 'server_receive_minus_calibrated_relative_delay',
            'relativeTimingVerified': not reasons, 'hardwareExposureTimestampMeasured': False,
            'appliedDelayS': delay, 'delayUncertaintyS': .02,
            'reference': '/qr/odometry/local, host ROS clock',
            'cameraProfile': {'width': 1280, 'height': 720, 'fps': 30},
            'configurationSha256': hashes, 'runs': runs, 'rejectionReasons': reasons,
            'validatedMaximumObservedSpeedMps': max(r['speedMaximumMps'] for r in runs),
            'notes': ['Calibration estimates the effective relative offset of the existing camera and local-odometry pipeline.',
                      'This does not measure a hardware exposure trigger, absolute map accuracy or navigation covariance.',
                      'Source trials stopped early on interlocks; only their recorded, covered motion frames are used.',
                      'Do not add detector processing time: frame headers already preserve the image timestamp.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('records', nargs='+', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT/'logs/camera-relative-timing-calibration-20261015.json')
    args = parser.parse_args()
    report = analyze(args.records)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['relativeTimingVerified'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
