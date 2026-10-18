#!/usr/bin/env python3
"""Read-only navigation evidence: ROS subscriptions and HTTP GET only.

Run after sourcing ROS and this workspace. Never creates a chassis publisher,
loads the motion controller, starts a task, unlocks, or stops the vehicle.
"""
import argparse
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]
JSON_TOPICS = ('/qr/tags/observations', '/qr/tags/provisional', '/qr/fusion/status',
               '/qr/detector/status', '/qr/camera/status', '/qr/localization/status')
POSE_TOPICS = ('/qr/chassis/odom', '/qr/odometry/local', '/qr/odometry/provisional',
               '/qr/localization/pose', '/qr/localization/provisional', '/qr/localization/static_pose')
TOPIC_MAX_AGE = {'/qr/camera/status': 1., '/qr/detector/status': .5,
                 '/qr/fusion/status': .3, '/qr/localization/status': .3, '/odin1/imu': .5, '/chassis_info_fb': .3}


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def board_centers(payload):
    """Count actual geometrically accepted groups, not visible child IDs."""
    if (payload.get('frame') != 'base_link' or payload.get('calibrated') is not True
            or payload.get('representation') != 'board-centers'):
        return []
    tags, layouts = payload.get('tags'), payload.get('groupLayouts')
    if not isinstance(tags, list) or not isinstance(layouts, list):
        return []
    source = str(ROOT / 'src/greenhouse_navigation')
    if source not in sys.path:
        sys.path.insert(0, source)
    from greenhouse_navigation.board_geometry import validated_board_observations
    try:
        return [t for t in validated_board_observations(tags, layouts, layouts)
                if t.get('groupId') and 0 < t['sigma'] <= .05]
    except (ValueError, TypeError, KeyError, AttributeError):
        return []


class EvidenceCollector:
    """Pure subscription bookkeeping; can be tested without importing ROS."""
    def __init__(self, topics):
        self.topics = {topic: {'messages': 0, 'freshMessages': 0,
                              'qualifiedMessages': 0, 'maxReceiveGapMs': 0.,
                              'maxStampGapMs': 0., 'stampRegressions': 0,
                              'maxAgeS': TOPIC_MAX_AGE.get(topic, .25)}
                       for topic in topics}

    def observe(self, topic, message, ros_now, received_now):
        entry = self.topics[topic]
        entry['messages'] += 1
        if 'lastReceived' in entry:
            entry['maxReceiveGapMs'] = max(entry['maxReceiveGapMs'],
                                          (received_now-entry['lastReceived'])*1000)
        entry['lastReceived'] = received_now
        entry['latestQualified'] = False
        entry.pop('lastStamp', None)
        if topic in JSON_TOPICS:
            try:
                payload = json.loads(message.data)
                if not isinstance(payload, dict):
                    raise ValueError('status must be an object')
            except (ValueError, TypeError):
                entry['invalidJson'] = entry.get('invalidJson', 0) + 1
                entry.pop('latest', None)
                return
            entry['latest'] = payload
            stamp = payload.get('stamp')
            if topic == '/qr/fusion/status':
                states = entry.setdefault('states', {})
                state = payload.get('state')
                state = state if isinstance(state, str) else 'unknown'
                states[state] = states.get(state, 0) + 1
                epoch = payload.get('epoch')
                if isinstance(epoch, str) and epoch and epoch not in entry.setdefault('epochs', []):
                    entry['epochs'].append(epoch)
            if topic.startswith('/qr/tags/'):
                centers = board_centers(payload)
                entry['boardCenterObservations'] = entry.get('boardCenterObservations', 0) + len(centers)
                entry['latestValidBoardCount'] = len(centers)
                entry['groupIds'] = sorted(set(entry.get('groupIds', [])) | {t['groupId'] for t in centers})
                qualified = bool(centers) and (topic == '/qr/tags/provisional'
                                              or payload.get('synchronized') is True)
            else:
                qualified = True
        else:
            stamp = message.header.stamp.sec + message.header.stamp.nanosec / 1e9
            qualified = True
            if topic in POSE_TOPICS:
                q = message.pose.pose.orientation
                p = message.pose.pose.position
                covariance = list(message.pose.covariance)
                expected_frame = 'map' if topic.startswith('/qr/localization/') else 'odom'
                qualified = (message.header.frame_id == expected_frame
                             and message.child_frame_id == 'base_link'
                             and all(finite(v) for v in [p.x, p.y, q.x, q.y, q.z, q.w] + covariance)
                             and abs(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w-1.) < .02
                             and len(covariance) == 36
                             and all(covariance[i] > 0 for i in (0, 7, 35)))
                entry['latest'] = {'frame': message.header.frame_id,
                                   'childFrame': message.child_frame_id}
                if qualified:
                    entry['latest'].update(x=p.x, y=p.y,
                        yaw=math.atan2(2*(q.w*q.z+q.x*q.y), 1-2*(q.y*q.y+q.z*q.z)),
                        positionSigmaM=math.sqrt(max(covariance[0], covariance[7])))
            elif topic == '/chassis_info_fb':
                fb = message.ctrl_fb
                speed = math.hypot(fb.ctrl_fb_x_linear, fb.ctrl_fb_y_linear)
                if finite(speed):
                    entry['maxReportedBodySpeedMps'] = max(entry.get('maxReportedBodySpeedMps', 0), speed)
                entry['latest'] = {'bodyGear': fb.ctrl_fb_gear,
                                   'steeringGear': message.steering_ctrl_fb.steering_ctrl_fb_gear,
                                   'unlock': message.io_fb.io_fb_unlock,
                                   'remoteControl': message.io_fb.io_fb_joypad_ctrl,
                                   'estop': message.io_fb.io_fb_estop}
        if finite(stamp):
            previous = entry.get('previousStamp')
            if previous is not None:
                delta = stamp-previous
                entry['maxStampGapMs'] = max(entry['maxStampGapMs'], max(0., delta)*1000)
                entry['stampRegressions'] += int(delta < 0.)
            entry['previousStamp'] = stamp
            entry['lastStamp'] = stamp
            fresh = 0 <= ros_now-stamp <= entry['maxAgeS']
            entry['freshMessages'] += int(fresh)
            entry['latestQualified'] = qualified and fresh
            entry['qualifiedMessages'] += int(entry['latestQualified'])

    def snapshot(self, ros_now, received_now):
        result = {}
        for topic, entry in self.topics.items():
            value = {k: v for k, v in entry.items() if k not in ('lastReceived', 'lastStamp', 'previousStamp')}
            last, stamp = entry.get('lastReceived'), entry.get('lastStamp')
            value['lastReceiveAgeMs'] = None if last is None else round((received_now-last)*1000, 3)
            value['latestStampAgeMs'] = None if stamp is None else round((ros_now-stamp)*1000, 3)
            value['freshNow'] = (last is not None and stamp is not None
                                 and 0 <= received_now-last <= entry['maxAgeS']
                                 and 0 <= ros_now-stamp <= entry['maxAgeS'])
            value['qualifiedNow'] = bool(value['freshNow'] and entry.get('latestQualified'))
            result[topic] = value
        return result


def formal_readiness(topics):
    def current(topic):
        entry = topics.get(topic, {})
        return entry.get('latest', {}) if entry.get('qualifiedNow') else {}

    camera, detector = current('/qr/camera/status'), current('/qr/detector/status')
    fusion = current('/qr/fusion/status')
    synchronized = topics.get('/qr/tags/observations', {}).get('qualifiedNow') is True
    local = topics.get('/qr/odometry/local', {}).get('qualifiedNow') is True
    pose = topics.get('/qr/localization/pose', {})
    return {
        'exposureTimestampVerified': camera.get('captureTimestampVerified') is True,
        'cameraCalibrated': camera.get('intrinsicsVerified') is True and camera.get('extrinsicsVerified') is True,
        'groundBoardPoseDetected': detector.get('positionReady') is True and finite(detector.get('validBoardCount')) and detector['validBoardCount'] > 0,
        'detectorLocalPoseSynchronized': detector.get('localPoseReady') is True,
        'formalSynchronizedBoardObservations': synchronized,
        'formalLocalPose': local,
        'fusionMappingReady': fusion.get('state') == 'FUSED' and fusion.get('mappingReady') is True,
        'formalGlobalPose': pose.get('qualifiedNow') is True,
        'formalGlobalPoseWithin3cm': pose.get('qualifiedNow') is True and pose.get('latest', {}).get('positionSigmaM', math.inf) <= .03,
        'note': '发布者存在、预览画面、草稿观测和局部草稿位姿均不代表正式定位；本报告不代表运动许可。',
    }


def blocking_summary(readiness):
    reasons = {
        'exposureTimestampVerified': '相机仍使用接收时间，曝光时间/延迟未经验证，检测器不入队正式同步观测。',
        'cameraCalibrated': '当前相机内参或安装外参未验证，不能计算正式地面组位姿。',
        'groundBoardPoseDetected': '当前未获得通过组几何、地面安装和重投影校验的二维码板中心位姿；查看detector最新reason区分无码与识别失败。',
        'formalLocalPose': '未收到新鲜有效的/qr/odometry/local；局部provisional不被检测器/全局定位当作正式里程计。',
        'formalSynchronizedBoardObservations': '未收到有效已同步的/qr/tags/observations；需曝光时间与正式局部里程计覆盖同一观测时间。',
        'fusionMappingReady': '融合尚未获得正式建图准入；需wheels源及轮式、噪声、IMU投影实测验证。',
        'formalGlobalPose': '未收到新鲜有效的/qr/localization/pose；还需已验收地图锚定及covariance_calibrated，不可用草稿替代。',
        'formalGlobalPoseWithin3cm': '当前正式全局位姿缺失或位置标准差超过3cm。',
    }
    return [{'id': key, 'reason': reason} for key, reason in reasons.items()
            if readiness.get(key) is not True]


def stationary_candidates(field, provisional):
    """Map-relative board geometry only; no fusion, acceptance, or ROS output.

    Saved map angles are degrees, relative PnP angles are radians. This is the
    same inverse rigid transform used by absolute_tag_pose, kept ROS-free here.
    """
    result = {'mapId': field.get('id'), 'coordinateStatus': field.get('coordinateStatus'),
              'captureQuality': field.get('captureQuality'), 'diagnosticOnly': True,
              'usableForNavigation': False, 'candidates': [], 'reason': ''}
    payload = provisional.get('latest', {})
    if not provisional.get('qualifiedNow') or not board_centers(payload):
        result['reason'] = '当前未识别到新鲜有效的二维码板中心位姿；摆放地图中登记的B000后可进行静止坐标核对。'
        return result
    from greenhouse_navigation.board_geometry import validated_board_observations
    try:
        relative = validated_board_observations(payload['tags'], field.get('groups', []),
                                                 payload.get('groupLayouts', []))
        anchors = {t['id']: t for t in field.get('tags', []) if isinstance(t, dict)}
        for tag in relative:
            anchor = anchors.get(tag['id'])
            if (not tag.get('groupId') or anchor is None
                    or not all(finite(anchor.get(k)) for k in ('x', 'y', 'angle'))):
                continue
            yaw = math.radians(anchor['angle'])-tag['angle']
            yaw = math.atan2(math.sin(yaw), math.cos(yaw))
            c, s = math.cos(yaw), math.sin(yaw)
            result['candidates'].append({'groupId': tag['groupId'], 'referenceId': tag['id'],
                'stamp': payload['stamp'], 'x': anchor['x']-c*tag['x']+s*tag['y'],
                'y': anchor['y']-s*tag['x']-c*tag['y'], 'yawRad': yaw,
                'yawDeg': math.degrees(yaw), 'relativePositionSigmaM': tag['sigma'],
                'synchronized': payload.get('synchronized') is True})
    except (ValueError, TypeError, KeyError, AttributeError):
        result['reason'] = '地图或当前观测的二维码组布局无效，未计算候选位姿。'
        return result
    result['reason'] = ('仅用当前草稿观测与地图板中心计算静止候选坐标；未校正时间、融合里程计或证明地图/位姿精度。'
                        if result['candidates'] else '已识别板中心，但当前观测的组布局/逻辑ID与此地图不匹配。')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, default=12.)
    parser.add_argument('--output', type=Path, default=ROOT / 'logs/navigation-stationary.json')
    args = parser.parse_args()
    if not 1 <= args.seconds <= 60:
        parser.error('--seconds must be between 1 and 60')
    # Use a writable project directory without changing HOME or ROS settings.
    os.environ.setdefault('ROS_LOG_DIR', str(ROOT / 'logs/ros-stationary'))
    Path(os.environ['ROS_LOG_DIR']).mkdir(parents=True, exist_ok=True)
    # Keep --help and the pure diagnostic functions usable without ROS installed.
    import rclpy
    from nav_msgs.msg import Odometry
    from sensor_msgs.msg import Imu
    from std_msgs.msg import String
    from rclpy.qos import qos_profile_sensor_data
    from yhs_can_interfaces.msg import ChassisInfoFb
    opener = build_opener(ProxyHandler({}))

    def get(path):
        with opener.open('http://127.0.0.1:3080' + path, timeout=3) as response:
            return json.load(response)

    report = {'readOnly': True, 'chassisCommandsSent': 0, 'startedAt': time.time(),
              'topics': {}, 'sharedMotionSources': {}}
    for path in (Path('/home/orangepi/ugv/control/fw_mini_controller.py'),
                 Path('/home/orangepi/ugv/control/official_fwmini_compat.py'),
                 Path('/home/orangepi/ugv/autorunlida/plant_lidar_centerline_follower.py')):
        try:
            report['sharedMotionSources'][str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as error:
            report.setdefault('sourceErrors', {})[str(path)] = str(error)
    rclpy.init()
    node = rclpy.create_node('qr_navigation_stationary_check')
    specs = {
        '/chassis_info_fb': ChassisInfoFb, '/odin1/imu': Imu, '/odom': Odometry,
        '/qr/chassis/odom': Odometry,
        '/qr/odometry/local': Odometry, '/qr/odometry/provisional': Odometry,
        '/qr/localization/pose': Odometry, '/qr/localization/provisional': Odometry,
        '/qr/localization/static_pose': Odometry, '/qr/localization/status': String,
        '/qr/tags/observations': String,
        '/qr/tags/provisional': String, '/qr/fusion/status': String,
        '/qr/detector/status': String, '/qr/camera/status': String,
    }
    subscriptions = []
    collector = EvidenceCollector(specs)

    def observe(topic, message):
        collector.observe(topic, message, node.get_clock().now().nanoseconds / 1e9,
                          time.monotonic())

    try:
        for topic, msg_type in specs.items():
            subscriptions.append(node.create_subscription(msg_type, topic,
                lambda msg, t=topic: observe(t, msg), qos_profile_sensor_data))
        started = time.monotonic()
        while time.monotonic() - started < args.seconds:
            rclpy.spin_once(node, timeout_sec=.05)
        report['sampleSeconds'] = time.monotonic() - started
        report['topics'] = collector.snapshot(node.get_clock().now().nanoseconds / 1e9,
                                               time.monotonic())
        report['gapInterpretation'] = ('maxReceiveGapMs是采样节点回调间隔，包含观察者调度延迟；'
                                      'maxStampGapMs是消息时间戳间隔，二者不能直接等同于生产者或硬件故障。')
        report['formalLocalizationReadiness'] = formal_readiness(report['topics'])
        report['localizationBlockingSummary'] = blocking_summary(report['formalLocalizationReadiness'])
        for topic, entry in report['topics'].items():
            entry['publishers'] = [{'name': p.node_name, 'namespace': p.node_namespace}
                                   for p in node.get_publishers_info_by_topic(topic)]
        report['commandPublishers'] = {topic: [{'name': p.node_name, 'namespace': p.node_namespace}
            for p in node.get_publishers_info_by_topic(topic)]
            for topic in ('/ctrl_cmd', '/steering_ctrl_cmd', '/io_cmd')}
        # An unavailable web backend must not erase the ROS sampling evidence.
        for key, endpoint in (('robot', '/api/robot/status'), ('maps', '/api/maps')):
            try:
                report[key] = get(endpoint)
            except (OSError, ValueError, TypeError) as error:
                report.setdefault('httpErrors', {})[endpoint] = str(error)
        report['stationaryMapCandidates'] = []
        for field in report.get('maps', []):
            try:
                item = get('/api/maps/' + field['id'])
                data = item.get('map', item)
                field.update({key: data.get(key) for key in ('coordinateStatus', 'captureQuality')})
                report['stationaryMapCandidates'].append(stationary_candidates(
                    data, report['topics']['/qr/tags/provisional']))
            except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
                report.setdefault('httpErrors', {})['map:' + str(field)] = str(error)
        report['blockingConditions'] = [c for c in report.get('robot', {}).get('conditions', [])
                                         if c.get('ready') is not True]
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'report': str(args.output), 'readOnly': True,
                          'messages': {t: d['messages'] for t, d in report['topics'].items()},
                          'blockingConditions': report['blockingConditions'],
                          'localizationBlockingSummary': report['localizationBlockingSummary']}, ensure_ascii=False))
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == '__main__':
    main()
