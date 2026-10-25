"""Offline evidence invalidation and known-delay recovery; no hardware access."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src/greenhouse_navigation'))
from greenhouse_navigation.timing_calibration import (capture_fingerprint,load_relative_timing,
                                                      timing_profile_matches)

class TimingEvidenceTests(unittest.TestCase):
    def test_relative_evidence_does_not_claim_hardware_trigger_and_is_bound_to_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            hashes={}
            for name in ['camera_calibration.json','camera_extrinsics.json','camera_preview.json']:
                p=root/name;p.write_text('{}');hashes[name]=hashlib.sha256(p.read_bytes()).hexdigest()
            raw=root/'motion.json';raw.write_text('{"realRecordFixture":true}')
            run={'eligibleFrames':30,'translationSpanM':.03,'otherRunDelayValidation':{'radialP95M':.001},
                 'source':str(raw),'sha256':hashlib.sha256(raw.read_bytes()).hexdigest(),'epoch':'first'}
            raw_second=root/'motion-second.json';raw_second.write_text('{"secondFixture":true}')
            run_second={**run,'source':str(raw_second),'sha256':hashlib.sha256(raw_second.read_bytes()).hexdigest(),'epoch':'second'}
            evidence={'schemaVersion':1,'relativeTimingVerified':True,'method':'ground_board_motion_to_local_odometry',
                      'rejectionReasons':[],'runs':[run,run_second],'appliedDelayS':.021,'delayUncertaintyS':.02,
                      'configurationSha256':hashes,'cameraProfile':{'width':1280,'height':720,'fps':30},
                      'timestampSource':'server_receive_minus_calibrated_relative_delay',
                      'hardwareExposureTimestampMeasured':False}
            p=root/'timing.json';p.write_text(json.dumps(evidence))
            verified=load_relative_timing(p,root,.021)
            self.assertTrue(verified['verified']);self.assertFalse(verified['hardwareExposureTimestampMeasured'])
            self.assertTrue(timing_profile_matches(verified,1280,720));self.assertFalse(timing_profile_matches(verified,640,480))
            self.assertFalse(load_relative_timing(p,root,.05)['verified'])
            raw.write_text('changed')
            self.assertFalse(load_relative_timing(p,root,.021)['verified'])

    def test_missing_and_malformed_evidence_fail_closed(self):
        self.assertFalse(load_relative_timing('',Path('/tmp'),.021)['verified'])
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'evidence.json';p.write_text('{')
            self.assertFalse(load_relative_timing(p,p.parent,.021)['verified'])
            p.write_text('{"schemaVersion":1,"relativeTimingVerified":true}')
            self.assertFalse(load_relative_timing(p,p.parent,.021)['verified'])

class PreviewRotationCompatibilityTests(unittest.TestCase):
    """rotate/hflip/vflip 只改变预览方向，不得让已确认的采集时序标定失效。"""

    def preview(self, rotate=0, **overrides):
        data = {'device': '/dev/v4l/by-id/usb-Generic_HBVCAM_Camera_200901010001-video-index0',
                'vendor': '0bda', 'product': '5846', 'name': 'HBVCAM', 'defaultProfile': '720p',
                'profiles': [{'id': '720p', 'label': '高清 720P', 'width': 1280, 'height': 720, 'fps': 30},
                             {'id': '480p', 'label': '流畅 480P', 'width': 640, 'height': 480, 'fps': 30}],
                'rotate': rotate}
        data.update(overrides)
        return data

    def write_evidence(self, root, capture_hashes=None):
        for name in ['camera_calibration.json', 'camera_extrinsics.json']:
            (root/name).write_text('{"calibrationVerified":true}', encoding='utf-8')
        (root/'camera_preview.json').write_text(json.dumps(self.preview(rotate=0), ensure_ascii=False), encoding='utf-8')
        hashes = {name: hashlib.sha256((root/name).read_bytes()).hexdigest()
                  for name in ['camera_calibration.json', 'camera_extrinsics.json', 'camera_preview.json']}
        first = root/'motion-first.json'; first.write_text('{"first":1}', encoding='utf-8')
        second = root/'motion-second.json'; second.write_text('{"second":1}', encoding='utf-8')
        def run(path, epoch):
            return {'eligibleFrames': 30, 'translationSpanM': .03,
                    'otherRunDelayValidation': {'radialP95M': .001},
                    'source': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                    'epoch': epoch}
        evidence = {'schemaVersion': 1, 'relativeTimingVerified': True,
                    'method': 'ground_board_motion_to_local_odometry', 'rejectionReasons': [],
                    'runs': [run(first, 'first'), run(second, 'second')],
                    'appliedDelayS': .021, 'delayUncertaintyS': .02,
                    'configurationSha256': hashes,
                    'cameraProfile': {'width': 1280, 'height': 720, 'fps': 30},
                    'timestampSource': 'server_receive_minus_calibrated_relative_delay',
                    'hardwareExposureTimestampMeasured': False}
        if capture_hashes is not None:
            evidence['configurationCaptureSha256'] = capture_hashes
        path = root/'timing.json'; path.write_text(json.dumps(evidence), encoding='utf-8')
        return path

    def test_legacy_evidence_accepts_preview_rotation_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.write_evidence(root)
            self.assertTrue(load_relative_timing(path, root, .021)['verified'])
            (root/'camera_preview.json').write_text(json.dumps(self.preview(rotate=180), ensure_ascii=False), encoding='utf-8')
            result = load_relative_timing(path, root, .021)
            self.assertTrue(result['verified'], result['reason'])
            self.assertEqual(result['captureBinding'], 'legacy-capture-spec')

    def test_legacy_evidence_still_rejects_resolution_and_fps_change(self):
        changes = ({'defaultProfile': '480p'},
                   {'profiles': [{'id': '720p', 'label': '高清 720P', 'width': 1280, 'height': 720, 'fps': 15}]},
                   {'device': 'not-a-v4l2-by-id-path'})
        for change in changes:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = self.write_evidence(root)
                self.assertTrue(load_relative_timing(path, root, .021)['verified'])
                (root/'camera_preview.json').write_text(
                    json.dumps(self.preview(rotate=180, **change), ensure_ascii=False), encoding='utf-8')
                self.assertFalse(load_relative_timing(path, root, .021)['verified'], change)

    def test_capture_fingerprint_ignores_rotation_but_pins_device_and_fps(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'camera_preview.json').write_text(json.dumps(self.preview(rotate=0), ensure_ascii=False), encoding='utf-8')
            recorded = capture_fingerprint(root/'camera_preview.json')
            path = self.write_evidence(root, capture_hashes={'camera_preview.json': recorded})
            self.assertTrue(load_relative_timing(path, root, .021)['verified'])
            (root/'camera_preview.json').write_text(json.dumps(self.preview(rotate=180), ensure_ascii=False), encoding='utf-8')
            result = load_relative_timing(path, root, .021)
            self.assertTrue(result['verified'], result['reason'])
            self.assertEqual(result['captureBinding'], 'capture-fields')
            changes = ({'device': '/dev/v4l/by-id/usb-Other_Camera_0001-video-index0'},
                       {'defaultProfile': '480p'},
                       {'profiles': [{'id': '720p', 'label': '高清 720P', 'width': 1280, 'height': 720, 'fps': 15}]})
            for change in changes:
                (root/'camera_preview.json').write_text(
                    json.dumps(self.preview(rotate=180, **change), ensure_ascii=False), encoding='utf-8')
                self.assertFalse(load_relative_timing(path, root, .021)['verified'], change)

    def test_capture_fingerprint_ignores_every_preview_only_field(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'camera_preview.json').write_text(json.dumps(self.preview(rotate=0), ensure_ascii=False), encoding='utf-8')
            baseline = capture_fingerprint(root/'camera_preview.json')
            for extra in ({'hflip': True}, {'vflip': True}, {'rotate': 180, 'hflip': True, 'vflip': True},
                          {'display': {'scale': 2}}):
                (root/'camera_preview.json').write_text(
                    json.dumps(self.preview(**extra), ensure_ascii=False), encoding='utf-8')
                self.assertEqual(capture_fingerprint(root/'camera_preview.json'), baseline, extra)

    def test_geometry_configuration_change_still_rejects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.write_evidence(root)
            self.assertTrue(load_relative_timing(path, root, .021)['verified'])
            for name in ['camera_extrinsics.json', 'camera_calibration.json']:
                (root/name).write_text('{"calibrationVerified":false}', encoding='utf-8')
                self.assertFalse(load_relative_timing(path, root, .021)['verified'], name)

class TimingMathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec=importlib.util.spec_from_file_location('motion_cal',Path(__file__).resolve().parents[1]/'scripts/calibrate_motion_timing.py')
        cls.cal=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.cal)

    def record(self,delay=.03,moving=True):
        def x(t):return .03*min(1.,max(0.,t-1.)) if moving else 0.
        odom=[{'stamp':1000+i*.02,'pose':[x(i*.02),0.,0.],'epoch':'one'} for i in range(201)]
        tags=[{'epoch':'one','data':{'stamp':1000+i*.05,'calibrated':True,
               'tags':[{'groupId':'B000','x':.1-x(i*.05-delay),'y':0.}]}} for i in range(8,72)]
        return {'samples':{'localOdom':odom,'tags':tags}}

    def test_recovers_known_delay_sign_without_adding_detector_latency(self):
        result=self.cal.fit(self.cal.prepare(self.record()))
        self.assertAlmostEqual(result['delayS'],.03,delta=.002)
        self.assertLess(result['rmsM'],.00002)

    def test_does_not_count_stationary_data_as_motion(self):
        data=self.cal.prepare(self.record(moving=False))
        self.assertEqual(data['translationSpanM'],0.)

    def test_epoch_and_reordered_odometry_are_rejected(self):
        record=self.record();record['samples']['localOdom'][50]['stamp']=1000.
        with self.assertRaises(ValueError):self.cal.prepare(record)
        record=self.record()
        for entry in record['samples']['tags']:entry['epoch']='other'
        with self.assertRaises(ValueError):self.cal.prepare(record)

if __name__=='__main__':unittest.main()
