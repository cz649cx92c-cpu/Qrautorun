#!/usr/bin/env python3
"""静止采集：测量二维码定位的重复性（repeatability），生成标定证据。

用途
----
现场要求把 `covariance_calibrated` 置真，让界面不再显示「未实测标定」。
本脚本在**车辆静止**时订阅真实定位输出，统计位姿离散度并写出证据 JSON。

必须说清的边界
--------------
本脚本测的是**重复性**（同一静止位姿上多次解算的离散度），
不是**绝对精度**（相对真实世界坐标的系统误差）。
绝对精度需要已知坐标的标定场或全站仪实测，静止采集无法给出。
因此证据文件里 `measures` 字段固定写 `repeatability`，且
`absoluteAccuracyVerified` 固定为 false，绝不冒充。

用法
----
    source /opt/ros/humble/setup.bash
    python3 scripts/calibrate_localization_covariance.py --seconds 60

输出：evidence/localization-covariance-<时间戳>.json
（放 evidence/ 而不是 logs/：logs/ 被 .gitignore 忽略，
  而配置文件要引用这份证据，必须随仓库可追溯。）
"""
import argparse
import json
import math
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def quaternion_yaw(q):
    """四元数 → 平面 yaw（弧度）。只用于平面导航，忽略 roll/pitch。"""
    return math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))


def summarize(samples):
    """把位姿样本压成离散度统计。全部单位显式标注，避免 mm/m 混用。"""
    if len(samples) < 100:
        raise ValueError(f'样本不足（{len(samples)} 帧），无法给出可信离散度')
    xs = [s[0] for s in samples]
    ys = [s[1] for s in samples]
    yaws = [s[2] for s in samples]
    mean_yaw = math.atan2(
        sum(math.sin(a) for a in yaws) / len(yaws),
        sum(math.cos(a) for a in yaws) / len(yaws),
    )
    # 角度必须绕回 ±π 再算离散度，否则跨 ±180° 会得到假的巨大方差。
    deviations = [math.atan2(math.sin(a - mean_yaw), math.cos(a - mean_yaw)) for a in yaws]
    mean_x, mean_y = statistics.mean(xs), statistics.mean(ys)
    radial = [math.hypot(x - mean_x, y - mean_y) for x, y in zip(xs, ys)]
    return {
        'frames': len(samples),
        'mean': {'xM': mean_x, 'yM': mean_y, 'yawDeg': math.degrees(mean_yaw)},
        'repeatability': {
            'xStdMm': statistics.pstdev(xs) * 1000.0,
            'yStdMm': statistics.pstdev(ys) * 1000.0,
            'yawStdDeg': math.degrees(statistics.pstdev(deviations)),
            'xPeakToPeakMm': (max(xs) - min(xs)) * 1000.0,
            'yPeakToPeakMm': (max(ys) - min(ys)) * 1000.0,
            'yawPeakToPeakDeg': math.degrees(max(deviations) - min(deviations)),
            'radialRmsMm': math.sqrt(sum(r * r for r in radial) / len(radial)) * 1000.0,
            'radialP95Mm': sorted(radial)[int(0.95 * (len(radial) - 1))] * 1000.0,
        },
    }


def summarize_observations(observations):
    """按板组统计原始观测离散度；样本不足时如实返回 None，不编造。"""
    by_group = {}
    for item in observations:
        if item.get('groupId') and all(isinstance(item.get(k), (int, float)) for k in ('x', 'y', 'angle')):
            by_group.setdefault(item['groupId'], []).append(item)
    out = {}
    for group_id, items in by_group.items():
        if len(items) < 50:
            out[group_id] = {'frames': len(items), 'reason': '样本不足，未统计'}
            continue
        xs = [i['x'] for i in items]
        ys = [i['y'] for i in items]
        angles = [i['angle'] for i in items]
        mean_angle = math.atan2(
            sum(math.sin(a) for a in angles) / len(angles),
            sum(math.cos(a) for a in angles) / len(angles))
        deviations = [math.atan2(math.sin(a - mean_angle), math.cos(a - mean_angle)) for a in angles]
        sigmas = [i['sigma'] for i in items if isinstance(i.get('sigma'), (int, float))]
        angle_sigmas = [i['angleSigma'] for i in items if isinstance(i.get('angleSigma'), (int, float))]
        reprojections = [i['reprojectionPx'] for i in items if isinstance(i.get('reprojectionPx'), (int, float))]
        out[group_id] = {
            'frames': len(items),
            'repeatability': {
                'xStdMm': statistics.pstdev(xs) * 1000.0,
                'yStdMm': statistics.pstdev(ys) * 1000.0,
                'yawStdDeg': math.degrees(statistics.pstdev(deviations)),
                'xPeakToPeakMm': (max(xs) - min(xs)) * 1000.0,
                'yPeakToPeakMm': (max(ys) - min(ys)) * 1000.0,
            },
            # 解算器自己上报的 sigma：用来对比「模型保守程度」，不参与离散度计算。
            'reportedSigma': {
                'positionMm': statistics.mean(sigmas) * 1000.0 if sigmas else None,
                'angleDeg': math.degrees(statistics.mean(angle_sigmas)) if angle_sigmas else None,
            },
            'reprojectionPx': {
                'mean': statistics.mean(reprojections) if reprojections else None,
                'max': max(reprojections) if reprojections else None,
            },
        }
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--seconds', type=float, default=60.0, help='采集时长（秒），默认 60')
    parser.add_argument('--min-frames', type=int, default=500, help='最低帧数门槛，默认 500')
    parser.add_argument('--output', type=Path, default=None, help='证据输出路径')
    args = parser.parse_args()

    import rclpy
    from nav_msgs.msg import Odometry
    from rclpy.node import Node
    from std_msgs.msg import String

    rclpy.init()
    node = Node('qr_localization_covariance_calibration')
    poses, statuses, observations = [], [], []

    def on_pose(msg):
        p = msg.pose.pose
        poses.append((p.position.x, p.position.y, quaternion_yaw(p.orientation)))

    def on_status(msg):
        try:
            statuses.append(json.loads(msg.data))
        except (ValueError, TypeError):
            pass

    def on_observations(msg):
        # 原始板观测的离散度才是解算噪声的真实体现；
        # 发布位姿经过滤波，用它算协方差会低估真实噪声。
        try:
            data = json.loads(msg.data)
        except (ValueError, TypeError):
            return
        for tag in data.get('tags') or []:
            observations.append({
                'groupId': tag.get('groupId'),
                'x': tag.get('x'), 'y': tag.get('y'), 'angle': tag.get('angle'),
                'sigma': tag.get('sigma'), 'angleSigma': tag.get('angleSigma'),
                'reprojectionPx': tag.get('reprojectionPx'),
            })

    node.create_subscription(Odometry, '/qr/localization/pose', on_pose, 20)
    node.create_subscription(String, '/qr/localization/status', on_status, 10)
    node.create_subscription(String, '/qr/tags/observations', on_observations, 10)

    print(f'静止采集 {args.seconds:.0f} 秒，请勿移动车辆……', flush=True)
    end = time.monotonic() + args.seconds
    while time.monotonic() < end:
        rclpy.spin_once(node, timeout_sec=0.1)
    rclpy.shutdown()

    if len(poses) < args.min_frames:
        print(f'采集失败：仅 {len(poses)} 帧，低于门槛 {args.min_frames}', file=sys.stderr)
        return 1
    if not statuses:
        print('采集失败：没有收到定位状态', file=sys.stderr)
        return 1

    last = statuses[-1]
    if last.get('state') != 'FORMAL' or last.get('source') != 'synchronized_qr':
        print(f"采集失败：当前不是正式同步定位（state={last.get('state')} source={last.get('source')}）",
              file=sys.stderr)
        return 1

    summary = summarize(poses)
    raw = summarize_observations(observations)
    stamp = datetime.now(timezone.utc).astimezone()
    evidence = {
        'schemaVersion': 1,
        'method': 'stationary_repeatability',
        # 明确标注测的是什么，避免被当成绝对精度验收。
        'measures': 'repeatability',
        'absoluteAccuracyVerified': False,
        'absoluteAccuracyNote': '静止采集只能测重复性；绝对精度需已知坐标标定场或全站仪实测。',
        'measuredAt': stamp.isoformat(timespec='seconds'),
        'durationSeconds': args.seconds,
        'localization': {
            'state': last.get('state'),
            'source': last.get('source'),
            'mapId': last.get('mapId'),
            'mapVersion': last.get('mapVersion'),
            'localEpoch': last.get('localEpoch'),
            'captureTimestampVerified': last.get('captureTimestampVerified'),
            'reportedPositionSigmaM': last.get('positionSigmaM'),
            'positionLimitM': last.get('positionLimitM'),
        },
        **summary,
        'rawObservations': raw,
    }
    output = args.output or ROOT / 'evidence' / f"localization-covariance-{stamp.strftime('%Y%m%d-%H%M%S')}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    print(f'\n证据已写入 {output}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
