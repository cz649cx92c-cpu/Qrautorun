"""Offline sensor telemetry: no node construction, ROS spin, or hardware writes."""
import sys
import unittest
import copy
import json
import math
import queue
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'src/greenhouse_navigation'))
from greenhouse_navigation.node import GreenhouseNode


class SensorStatusTests(unittest.TestCase):
    def harness(self):
        return SimpleNamespace(
            detector=None, detector_received=0., imu_received=0.,
            fusion=None, fusion_received=0., mapping=None, mapping_received=0.,
            pose=None, pose_received=0., config={'imu_topic': ''},
            get_clock=lambda:SimpleNamespace(now=lambda:SimpleNamespace(nanoseconds=10_000_000_000)))

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
        h.mapping_observation={'stamp':9.9,'localEpoch':'formal-origin'};h.observation_received=9.9
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
            h.mapping_observation={'stamp':9.9,'localEpoch':'formal-origin'};h.observation_received=9.9;setattr(h,stale,9.)
            self.assertFalse(self.status(h)['mapping']['ready'])

    def formal_harness(self):
        h=self.harness();self.ready(h)
        h.fusion.update(state='FUSED',ready=True,mappingReady=True,epoch='formal-origin')
        h.detector.update(calibrated=True,captureTimestampVerified=True,localPoseReady=False,
            reason='局部轮式/IMU融合位姿未验证，扫描尚未就绪')
        h.mapping.update(ready=False,reason='已切换正式融合，请使用正式观测')
        h.observation_received=9.9
        h.mapping_observation={'stamp':9.9,'localEpoch':'formal-origin'}
        return h

    def test_delayed_formal_dispatch_is_not_blocked_by_current_image_interpolation(self):
        h=self.formal_harness()
        result=self.status(h)
        self.assertFalse(h.detector['localPoseReady'])
        self.assertTrue(result['mapping']['ready'])
        self.assertEqual(result['mapping']['quality'],'verified')
        self.assertEqual(result['sensors']['camera'],'定位观测已同步')
        self.assertEqual(result['detector']['reason'],'')

    def test_formal_mapping_stale_future_epoch_and_missing_evidence_remain_blocked(self):
        cases=[('receive-stale',lambda h:setattr(h,'observation_received',9.)),
            ('receive-future',lambda h:setattr(h,'observation_received',11.)),
            ('stamp-stale',lambda h:h.mapping_observation.update(stamp=9.)),
            ('stamp-future',lambda h:h.mapping_observation.update(stamp=11.)),
            ('stamp-nan',lambda h:h.mapping_observation.update(stamp=math.nan)),
            ('old-epoch',lambda h:h.mapping_observation.update(localEpoch='old-origin')),
            ('missing-epoch',lambda h:h.mapping_observation.update(localEpoch='')),
            ('missing-evidence',lambda h:setattr(h,'mapping_observation',None)),
            ('fusion-stale',lambda h:setattr(h,'fusion_received',9.)),
            ('detector-stale',lambda h:setattr(h,'detector_received',9.)),
            ('fusion-invalid',lambda h:h.fusion.update(state='INVALID',ready=False)),
            ('fusion-not-ready',lambda h:h.fusion.update(ready=False)),
            ('mapping-not-ready',lambda h:h.fusion.update(mappingReady=False)),
            ('capture-unverified',lambda h:h.detector.update(captureTimestampVerified=False))]
        for label,change in cases:
            with self.subTest(case=label):
                h=self.formal_harness();change(h)
                self.assertFalse(self.status(h)['mapping']['ready'])

    def test_only_accepted_synchronized_local_pose_records_mapping_evidence(self):
        payload={'frame':'base_link','calibrated':True,'synchronized':True,'stamp':9.9,
            'tags':[{'id':113,'x':0.,'y':0.,'angle':0.,'sigma':.01}],
            'localPose':{'x':0.,'y':0.,'yaw':0.},'localPoseSynchronized':True,
            'localEpoch':'formal-origin'}
        cases=[None,{'synchronized':False},{'calibrated':False},
            {'frame':'map'},{'stamp':9.},{'stamp':11.},
            {'localPoseSynchronized':False},{'localEpoch':''},{'tags':[]},
            {'localPose':{'x':math.nan,'y':0.,'yaw':0.}},
            {'localPose':{'x':True,'y':0.,'yaw':0.}}]
        for change in cases:
            with self.subTest(change=change):
                h=self.formal_harness();h.mapping_observation=None;h.active_boards=[]
                h.mission=SimpleNamespace(running=False,log=lambda message:None)
                h.survey=queue.Queue()
                packet=copy.deepcopy(payload);packet.update(change or {})
                with patch('greenhouse_navigation.node.time.monotonic',return_value=9.9):
                    GreenhouseNode.observation_cb(h,SimpleNamespace(data=json.dumps(packet)))
                if change is None:
                    self.assertEqual(h.mapping_observation,{'stamp':9.9,'localEpoch':'formal-origin'})
                    self.assertEqual(h.survey.qsize(),1)
                    sample=h.survey.get_nowait()
                    self.assertTrue(sample['synchronized']);self.assertTrue(sample['calibrated'])
                    self.assertEqual(sample['localEpoch'],'formal-origin')
                else:self.assertIsNone(h.mapping_observation)

    def test_new_unsynchronized_local_pose_cannot_reuse_previous_mapping_evidence(self):
        h=self.formal_harness();h.active_boards=[]
        h.mission=SimpleNamespace(running=False,log=lambda message:None);h.survey=queue.Queue()
        packet={'frame':'base_link','calibrated':True,'synchronized':True,'stamp':9.9,
            'tags':[{'id':113,'x':0.,'y':0.,'angle':0.,'sigma':.01}],
            'localPose':{'x':0.,'y':0.,'yaw':0.},'localPoseSynchronized':False,
            'localEpoch':'formal-origin'}
        GreenhouseNode.observation_cb(h,SimpleNamespace(data=json.dumps(packet)))
        self.assertIsNone(h.mapping_observation);self.assertTrue(h.survey.empty())
        self.assertFalse(self.status(h)['mapping']['ready'])

    def test_actual_field_snapshot_replay_green(self):
        path=Path(__file__).resolve().parents[1]/'logs/mapping-blocker-20261019/passive.json'
        if not path.exists():self.skipTest('现场诊断 fixture 不随仓库分发')
        topics=json.loads(path.read_text())['topics'];formal=topics['/qr/tags/observations']
        self.assertGreater(formal['count'],0);self.assertLess(formal['ageMs']['max'],250.)
        obs=formal['latest'];fusion=topics['/qr/fusion/status']['latest']
        for flag in ('calibrated','synchronized','localPoseSynchronized'):self.assertIs(obs[flag],True)
        self.assertEqual(obs['localEpoch'],fusion['epoch'])
        h=self.formal_harness();h.detector=topics['/qr/detector/status']['latest']
        h.fusion=fusion;h.mapping=topics['/qr/draft/status']['latest']
        h.mapping_observation={'stamp':obs['stamp'],'localEpoch':obs['localEpoch']}
        h.get_clock=lambda:SimpleNamespace(now=lambda:SimpleNamespace(nanoseconds=int((obs['stamp']+.1)*1e9)))
        self.assertFalse(h.detector['localPoseReady']);self.assertTrue(self.status(h)['mapping']['ready'])


if __name__=='__main__': unittest.main(verbosity=2)
