#!/usr/bin/env python3
"""Measure observed QR pose jitter while stationary; subscriptions only."""
import argparse
import json
import math
import os
import sqlite3
import statistics
import time
from pathlib import Path

from check_navigation_stationary import ROOT, EvidenceCollector, stationary_candidates


def pose_summary(samples):
    if len(samples) < 2:
        return {'frames': len(samples), 'reason': '连续有效板中心不足，不能统计稳定性'}
    xs, ys, yaws = ([s[k] for s in samples] for k in ('x', 'y', 'yawRad'))
    mx, my = statistics.mean(xs), statistics.mean(ys)
    yaw = math.atan2(sum(math.sin(a) for a in yaws), sum(math.cos(a) for a in yaws))
    deviations = [math.atan2(math.sin(a-yaw), math.cos(a-yaw)) for a in yaws]
    return {'frames': len(samples), 'mean': {'x': mx, 'y': my, 'yawDeg': math.degrees(yaw)},
            'observedJitter': {'xStdMm': statistics.pstdev(xs)*1000,
                              'yStdMm': statistics.pstdev(ys)*1000,
                              'yawStdDeg': math.degrees(statistics.pstdev(deviations)),
                              'xPeakToPeakMm': (max(xs)-min(xs))*1000,
                              'yPeakToPeakMm': (max(ys)-min(ys))*1000,
                              'yawPeakToPeakDeg': math.degrees(max(deviations)-min(deviations))},
            'meanVisibleMembers': statistics.mean(s['visibleMembers'] for s in samples),
            'maxReprojectionPx': max(s['reprojectionPx'] for s in samples),
            'meanReportedPositionSigmaM': statistics.mean(s['relativePositionSigmaM'] for s in samples),
            'note': '这些是观测抖动，不是地图或定位绝对误差；板移动、时间同步和系统偏差仍可能影响结果。'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--map-id', required=True)
    parser.add_argument('--seconds', type=float, default=12.)
    parser.add_argument('--output', type=Path, default=ROOT/'logs/navigation-stationary-pose.json')
    args = parser.parse_args()
    if not 2 <= args.seconds <= 60:
        parser.error('--seconds must be between 2 and 60')
    with sqlite3.connect('file:' + str(ROOT/'maps/navigation.db') + '?mode=ro', uri=True) as db:
        row = db.execute('SELECT version,body FROM versions WHERE map_id=? ORDER BY version DESC LIMIT 1',
                         (args.map_id,)).fetchone()
    if row is None:
        parser.error('地图不存在')
    field = json.loads(row[1])
    os.environ.setdefault('ROS_LOG_DIR', str(ROOT/'logs/ros'))
    import rclpy
    from rclpy.qos import qos_profile_sensor_data
    from std_msgs.msg import String
    from yhs_can_interfaces.msg import ChassisInfoFb
    rclpy.init()
    node = rclpy.create_node('qr_stationary_pose_stability')
    collector = EvidenceCollector(['/qr/tags/provisional'])
    samples, speeds, wheel_speeds, rejected = [], [], [], []

    def tags(message):
        now_ros, now = node.get_clock().now().nanoseconds/1e9, time.monotonic()
        collector.observe('/qr/tags/provisional', message, now_ros, now)
        entry = collector.snapshot(now_ros, now)['/qr/tags/provisional']
        candidates = stationary_candidates(field, entry)['candidates']
        if not candidates:
            rejected.append(now)
        relatives = {t.get('groupId'): t for t in entry.get('latest', {}).get('tags', [])}
        for candidate in candidates:
            relative = relatives[candidate['groupId']]
            candidate.update(visibleMembers=relative['visibleCount'],
                             reprojectionPx=relative.get('reprojectionPx', 0.))
            samples.append(candidate)

    def feedback(message):
        stamp = message.header.stamp.sec + message.header.stamp.nanosec/1e9
        if not 0 <= node.get_clock().now().nanoseconds/1e9-stamp <= .3:
            return
        speeds.append(math.hypot(message.ctrl_fb.ctrl_fb_x_linear, message.ctrl_fb.ctrl_fb_y_linear))
        wheel_speeds.extend(abs(v) for v in (message.lf_wheel_fb.lf_wheel_fb_velocity,
            message.rf_wheel_fb.rf_wheel_fb_velocity, message.lr_wheel_fb.lr_wheel_fb_velocity,
            message.rr_wheel_fb.rr_wheel_fb_velocity))

    try:
        subscriptions = [node.create_subscription(String, '/qr/tags/provisional', tags, qos_profile_sensor_data),
                         node.create_subscription(ChassisInfoFb, '/chassis_info_fb', feedback, qos_profile_sensor_data)]
        started = time.monotonic()
        while time.monotonic()-started < args.seconds:
            rclpy.spin_once(node, timeout_sec=.05)
        groups = {s['groupId'] for s in samples}
        report = {'readOnly': True, 'chassisCommandsSent': 0, 'usableForNavigation': False,
                  'mapId': field['id'], 'mapVersion': row[0], 'mapCoordinateStatus': field.get('coordinateStatus'),
                  'sampleSeconds': time.monotonic()-started, 'completedAt': time.time(),
                  'maxReportedBodySpeedMps': max(speeds) if speeds else None,
                  'maxReportedWheelSpeedMps': max(wheel_speeds) if wheel_speeds else None,
                  'groups': {g: pose_summary([s for s in samples if s['groupId']==g]) for g in sorted(groups)},
                  'rejectedFrames': len(rejected), 'samples': samples}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps({k: v for k, v in report.items() if k != 'samples'}, ensure_ascii=False))
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == '__main__':
    main()
