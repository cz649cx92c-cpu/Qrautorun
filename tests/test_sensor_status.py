"""Offline sensor telemetry: no node construction, ROS spin, or hardware writes."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'src/greenhouse_navigation'))
from greenhouse_navigation.node import GreenhouseNode


class SensorStatusTests(unittest.TestCase):
    def harness(self):
        return SimpleNamespace(
            detector=None, detector_received=0., imu_received=0.,
            fusion=None, fusion_received=0., mapping=None, mapping_received=0.,
            pose=None, pose_received=0., config={'imu_topic': ''})

    def status(self, h):
        return GreenhouseNode.sensor_status(h, 10., {
            'camera': '最后接入', 'imu': '未接入', 'odom': '离线', 'localization': '未就绪'})

    def ready(self, h):
        h.detector={'positionReady': True, 'detectedIds': [0],
                    'visibleGroups': [{'id': 'B000', 'visible': 1, 'total': 4}]}
        h.detector_received=9.9
        h.fusion={'state': 'PROVISIONAL', 'ready': True, 'source': 'legacy',
                  'agesMs': {'imu': 5., 'feedback': 5.}}
        h.fusion_received=9.9
        h.mapping={'ready': True, 'reason': '', 'localEpoch': 'new-origin'}
        h.mapping_received=9.9

    def test_missing_detector_is_distinct_from_camera_hardware(self):
        result=self.status(self.harness())
        self.assertFalse(result['detector']['connected'])
        self.assertIn('识别服务心跳', result['sensors']['camera'])
        self.assertIn('预览画面不代表', result['detector']['reason'])
        self.assertNotIn('未接入', result['sensors']['camera'])
        self.assertFalse(result['mapping']['ready'])

    def test_detector_timeout_clears_visible_groups_and_pose_readiness(self):
        h=self.harness();self.ready(h);h.detector_received=9.
        result=self.status(h)
        self.assertEqual(result['detector']['groups'], [])
        self.assertFalse(result['detector']['positionReady'])
        self.assertIn('超时', result['detector']['reason'])
        self.assertFalse(result['mapping']['ready'])

    def test_fusion_imu_is_online_without_a_direct_imu_subscription(self):
        h=self.harness();self.ready(h)
        result=self.status(h)
        self.assertEqual(result['sensors']['imu'], '在线（融合输入）')
        self.assertTrue(result['mapping']['ready'])
        self.assertEqual(result['mapping']['localEpoch'], 'new-origin')

    def test_imu_timeout_and_absent_input_have_specific_status(self):
        h=self.harness();self.ready(h)
        for age, expected in [(500., 'IMU数据超时'), (None, '等待IMU数据'), (-1., 'IMU数据超时'), (float('nan'), 'IMU数据超时')]:
            with self.subTest(age=age):
                h.fusion['agesMs']['imu']=age
                self.assertIn(expected, self.status(h)['sensors']['imu'])

    def test_direct_imu_freshness_then_timeout(self):
        h=self.harness();h.imu_received=9.9
        self.assertEqual(self.status(h)['sensors']['imu'], '在线')
        h.imu_received=9.
        self.assertIn('IMU数据超时', self.status(h)['sensors']['imu'])

    def test_invalid_fusion_overrides_old_pose_and_preserves_cause(self):
        h=self.harness();self.ready(h);h.pose=object();h.pose_received=9.9
        h.fusion.update(state='INVALID', ready=False, reason='运动模式不支持，需轮式横移标定并重新初始化')
        result=self.status(h)
        self.assertIn('保持静止', result['sensors']['localization'])
        self.assertIn('运动模式不支持', result['mapping']['reason'])
        self.assertIn('等待自动恢复', result['mapping']['reason'])
        self.assertNotIn('重启', result['mapping']['reason'])
        self.assertFalse(result['mapping']['ready'])

    def test_sensor_gap_reason_removes_manual_restart_advice(self):
        h=self.harness();self.ready(h)
        h.fusion.update(state='INVALID', ready=False, reason='传感器观测中断，需重启融合')
        reason=self.status(h)['mapping']['reason']
        self.assertIn('传感器观测中断', reason)
        self.assertIn('自动恢复', reason)
        self.assertNotIn('重启', reason)

    def test_stale_fusion_cannot_claim_imu_or_odometry_online(self):
        h=self.harness();self.ready(h);h.fusion_received=9.
        result=self.status(h)
        self.assertNotIn('在线', result['sensors']['imu'])
        self.assertEqual(result['sensors']['odom'], '离线')
        self.assertIn('融合服务心跳超时', result['mapping']['reason'])
        self.assertFalse(result['mapping']['ready'])

    def test_stale_mapping_cannot_report_old_origin_as_current(self):
        h=self.harness();self.ready(h);h.mapping_received=9.
        result=self.status(h)
        self.assertFalse(result['mapping']['ready'])
        self.assertEqual(result['mapping']['localEpoch'], '')
        self.assertIn('草稿采集服务心跳超时', result['mapping']['reason'])

    def test_no_visible_board_does_not_disable_capture_service(self):
        h=self.harness();self.ready(h)
        h.detector={'positionReady': False, 'calibrated': True, 'reason': '画面内没有注册定位组'}
        result=self.status(h)
        self.assertTrue(result['mapping']['ready'])
        self.assertEqual(result['sensors']['camera'], '已标定 / 未见定位组')
        self.assertEqual(result['detector']['reason'], '画面内没有注册定位组')

    def test_formal_capture_supersedes_intentionally_stopped_draft(self):
        h=self.harness();self.ready(h)
        h.fusion.update(state='FUSED',ready=True,mappingReady=True,epoch='formal-origin')
        h.detector.update(captureTimestampVerified=True,localPoseReady=True)
        h.mapping.update(ready=False,reason='已切换正式融合，请使用正式观测',localEpoch='old-draft-origin')
        h.observation_received=9.9
        result=self.status(h)['mapping']
        self.assertTrue(result['ready']);self.assertEqual(result['quality'],'verified')
        self.assertEqual(result['localEpoch'],'formal-origin');self.assertEqual(result['reason'],'')
        h.observation_received=9.
        result=self.status(h)['mapping']
        self.assertFalse(result['ready']);self.assertIn('正式同步定位观测',result['reason'])

    def test_formal_capture_still_requires_fresh_detector_and_fusion(self):
        for stale in ['fusion_received','detector_received']:
            h=self.harness();self.ready(h)
            h.fusion.update(state='FUSED',ready=True,mappingReady=True,epoch='formal-origin')
            h.detector.update(captureTimestampVerified=True,localPoseReady=True)
            h.mapping.update(ready=False,reason='已切换正式融合，请使用正式观测')
            h.observation_received=9.9;setattr(h,stale,9.)
            self.assertFalse(self.status(h)['mapping']['ready'])


if __name__=='__main__': unittest.main(verbosity=2)
