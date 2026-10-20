import unittest,sys,json
from pathlib import Path
from types import SimpleNamespace
W=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(W/'src/greenhouse_navigation'));sys.path.insert(0,str(W/'scripts'))
from greenhouse_navigation.node import GreenhouseNode
from greenhouse_navigation.imu_source_health import SerialSourceHealth
import service_manager

class MaintenanceTests(unittest.TestCase):
    def test_maintenance_never_fetches_queued_commands(self):
        calls=[];h=SimpleNamespace(config={'maintenance_mode':True})
        self.assertEqual(GreenhouseNode.fetch_task_commands(h,lambda url:calls.append(url)),[])
        self.assertEqual(calls,[])
    def test_maintenance_rejects_direct_start_even_if_caller_claims_all_gates(self):
        h=SimpleNamespace(config={'maintenance_mode':True},pending_start=None,mission=SimpleNamespace(running=False))
        with self.assertRaisesRegex(ValueError,'维护'):GreenhouseNode.request_start(h,{},[])
    def test_serial_service_identity_matches_new_driver(self):
        self.assertEqual(service_manager.SERVICES['imu'][2],'scripts/run_serial_imu.py')
    def test_launcher_has_explicit_readonly_maintenance_override(self):
        s=(W/'scripts/start_robot.sh').read_text()
        self.assertIn('--imu-maintenance',s);self.assertIn('maintenance_mode:=true',s)
        self.assertIn('execution_enabled:=false',s)
    def test_navigation_line_endings_and_topic_only(self):
        p=W/'config/navigation.yaml';b=p.read_bytes()
        self.assertEqual(b.count(b'\r\n'),b.count(b'\n'))
        self.assertIn(b'imu_topic: "/qr/imu/raw"',b)

class SourceHealthTests(unittest.TestCase):
    def status(self,**updates):
        d={'source':'Yahboom serial','protocol':'7e23-sum8','port':'/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0','baud':115200,'connected':True,'online':True,'payloadBytesSent':0,'connections':1,'disconnects':0,'received':100}
        d.update(updates);return d
    def test_missing_wrong_and_offline_source_not_healthy(self):
        h=SerialSourceHealth();self.assertFalse(h.fresh(1.))
        self.assertFalse(h.observe(self.status(source='Odin'),1.)[0])
        self.assertFalse(h.observe(self.status(online=False),1.)[0])
        self.assertTrue(h.observe(self.status(),1.)[0]);self.assertTrue(h.fresh(2.))
        self.assertFalse(h.fresh(4.))
    def test_reconnect_restart_and_heartbeat_gap_invalidate_calibration_identity(self):
        h=SerialSourceHealth();self.assertEqual(h.observe(self.status(),1.),(True,False))
        self.assertEqual(h.observe(self.status(received=110),2.),(True,False))
        self.assertEqual(h.observe(self.status(connections=2,received=111),3.),(True,True))
        self.assertEqual(h.observe(self.status(connections=2,received=1),4.),(True,True))
        self.assertEqual(h.observe(self.status(connections=2,received=10),8.),(True,True))
    def test_bad_status_and_counter_never_restore_health(self):
        h=SerialSourceHealth()
        for change in [dict(baud=9600),dict(payloadBytesSent=1),dict(connections=None),dict(received=-1),dict(port='/dev/ttyACM0')]:
            self.assertFalse(h.observe(self.status(**change),1.)[0])

class CalibrationIdentityTests(unittest.TestCase):
    def test_connection_change_invalidates_old_bias_and_stops_output(self):
        from greenhouse_navigation.fusion import FusionInputs,StationaryCalibration
        from std_msgs.msg import String
        h=SimpleNamespace(source_health=SerialSourceHealth(),now=lambda:2.,calibration=StationaryCalibration(),invalid_reason='',session_active=lambda:True)
        h.calibration.result={'bias':[1.,2.,3.]};h.calibration.samples.append('old')
        status=SourceHealthTests().status()
        h.source_health.observe(status,1.)
        status['connections']=2
        FusionInputs.imu_source_cb(h,String(data=json.dumps(status)))
        self.assertIn('旧校零作废',h.invalid_reason);self.assertFalse(h.calibration.samples)
    def test_25hz_still_requires_500_samples_not_just_five_seconds(self):
        from greenhouse_navigation.fusion import StationaryCalibration
        c=StationaryCalibration()
        for i in range(499):self.assertIsNone(c.add(i*.04,[0.,0.,.01],[0.,0.,9.81],True))
        result=c.add(499*.04,[0.,0.,.01],[0.,0.,9.81],True)
        self.assertEqual(result['sampleCount'],500);self.assertAlmostEqual(result['durationS'],19.96)

if __name__=='__main__':unittest.main()
