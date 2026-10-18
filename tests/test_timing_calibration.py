"""Offline evidence invalidation and known-delay recovery; no hardware access."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src/greenhouse_navigation'))
from greenhouse_navigation.timing_calibration import load_relative_timing,timing_profile_matches

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
