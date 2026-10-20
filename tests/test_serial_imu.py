import sys, unittest, math, struct, json, collections
from pathlib import Path
W=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(W/'scripts'))
from imu_protocol import Parser

def packet(kind,payload):
    b=b'\x7e\x23'+bytes([len(payload)+5,kind])+payload
    return b+bytes([sum(b)&255])

def motion(values=(8,-27,2063,0,-10,11,3763,542,3623)):
    return packet(4,struct.pack('<9h',*values))

class ParserTests(unittest.TestCase):
    def test_signed_si_and_no_orientation_mixing(self):
        frames=Parser().feed(motion((-32768,32767,2063,-32768,32767,11,1,2,3)),1.)
        self.assertEqual(len(frames),1)
        f=frames[0]
        self.assertEqual(f.kind,4)
        self.assertAlmostEqual(f.acceleration[0],-32768*16/32767*9.80665)
        self.assertAlmostEqual(f.acceleration[1],16*9.80665)
        self.assertAlmostEqual(f.acceleration[2],2063*16/32767*9.80665)
        self.assertAlmostEqual(f.angular_velocity[0],-32768*2000/32767*math.pi/180)
        self.assertAlmostEqual(f.angular_velocity[1],math.radians(2000))
        self.assertAlmostEqual(f.angular_velocity[2],11*2000/32767*math.pi/180)

class RobustnessTests(unittest.TestCase):
    def test_fragment_noise_checksum_length_type_resync(self):
        p=Parser();bad=bytearray(motion());bad[-1]^=1
        stream=b'noise'+b'\x7e\x23\xff\x04'+b'\x7e\x23\x17\x99'+bytes(bad)+motion()
        got=[]
        for i in range(0,len(stream),3):got+=p.feed(stream[i:i+3],1+i*.0001)
        self.assertEqual([f.kind for f in got],[4])
        self.assertGreater(p.errors['checksum'],0)
        self.assertGreater(p.errors['length_or_type'],0)
        self.assertLessEqual(len(p.buffer),64)
        p.feed(b'x'*100000,2.)
        self.assertLessEqual(len(p.buffer),64)
    def test_nan_and_metadata_never_motion(self):
        p=Parser()
        self.assertEqual(p.feed(packet(0x16,struct.pack('<4f',1,0,float('nan'),0)),1.),[])
        self.assertEqual(p.errors['nonfinite'],1)
        for kind,values in [(0x16,(1,0,0,0)),(0x26,(0,0,0)),(0x32,(1,25,100000,100000))]:
            f=p.feed(packet(kind,struct.pack('<'+'f'*len(values),*values)),1.)[0]
            self.assertFalse(f.acceleration);self.assertFalse(f.angular_velocity)
    def test_stale_fragment_and_complete_sample_rejected(self):
        p=Parser();raw=motion();p.feed(raw[:10],1.)
        self.assertFalse(p.feed(raw[10:],1.3))
        self.assertFalse(p.feed(raw,1.,now=2.))
        self.assertEqual(len(p.feed(raw,2.)),1)
    def test_real_402_frame_replay(self):
        evidence=json.loads((W/'logs/imu-replacement-20261019T104032-passive-evidence.json').read_text())
        counts=collections.Counter();samples=[]
        for w in evidence['windows']:
            p=Parser();data=bytes.fromhex(w['raw_hex'])
            for i in range(0,len(data),7):
                for f in p.feed(data[i:i+7],1+i*.000001):
                    counts[f.kind]+=1
                    if f.kind==4:samples.append(f)
            self.assertEqual(p.errors['checksum'],0)
        self.assertEqual(counts,{4:100,0x16:101,0x26:101,0x32:100})
        self.assertEqual(len(samples),100)
        self.assertTrue(all(9.7<math.hypot(*s.acceleration)<10.1 for s in samples))
        self.assertTrue(all(math.hypot(*s.angular_velocity)<.02 for s in samples))

from imu_serial import Receiver, open_passive_port
class FakePort:
    def __init__(self):self.data=b'';self.closed=False;self.drops=0;self.fail=False;self.writes=0
    @property
    def in_waiting(self):
        if self.fail:raise OSError('disconnected')
        return len(self.data)
    def read(self,size):b,self.data=self.data[:size],self.data[size:];return b
    def reset_input_buffer(self):self.data=b'';self.drops+=1
    def close(self):self.closed=True
    def write(self,data):self.writes+=1;raise AssertionError('write forbidden')
class TransportTests(unittest.TestCase):
    def test_reconnect_drops_old_data_never_writes(self):
        ports=[]
        def factory(port,baud):
            p=FakePort();p.data=motion();ports.append(p);return p
        r=Receiver(factory=factory)
        self.assertEqual(r.poll(1.),[])
        self.assertEqual(ports[0].data,b'')
        ports[0].data=motion();self.assertEqual(len(r.poll(1.04)),1)
        ports[0].fail=True;self.assertEqual(r.poll(1.08),[])
        self.assertTrue(ports[0].closed);self.assertFalse(r.connected)
        self.assertEqual(r.poll(1.2),[]);self.assertEqual(len(ports),1)
        self.assertEqual(r.poll(2.1),[]);self.assertEqual(len(ports),2)
        self.assertTrue(r.connected);self.assertEqual(ports[1].data,b'')
        self.assertTrue(all(p.writes==0 for p in ports))
        r.close()
    def test_scheduler_stall_and_serial_backlog_drop(self):
        p=FakePort();r=Receiver(factory=lambda port,baud:p)
        r.poll(1.);p.data=motion()*30
        self.assertEqual(r.poll(1.04),[]);self.assertEqual(r.dropped_backlog,1)
        p.data=motion();self.assertEqual(r.poll(2.),[])
        self.assertEqual(r.dropped_stale,1)
        p.data=motion();self.assertEqual(len(r.poll(2.04)),1)
    def test_open_flags_before_open_and_forbidden_write(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        class FakeSerial:
            def __init__(self,**kw):self.kw=kw;self.is_open=False;self.fd=None
            def open(self):
                self.before_open=(self.dtr,self.rts);self.is_open=True
            def close(self):self.is_open=False
        with patch.dict(sys.modules,{'serial':SimpleNamespace(Serial=FakeSerial)}):
            p=open_passive_port('/dev/test',115200)
        self.assertEqual(p.before_open,(False,False))
        self.assertTrue(p.kw['exclusive']);self.assertEqual(p.kw['timeout'],0)
        self.assertFalse(p.kw['rtscts']);self.assertFalse(p.kw['dsrdtr']);self.assertFalse(p.kw['xonxoff'])
        with self.assertRaises(RuntimeError):p.write(b'anything')
        with self.assertRaises(RuntimeError):p.send_break()

class IntegrationBoundaryTests(unittest.TestCase):
    def test_default_source_is_serial_without_odin_fallback(self):
        for name in ['config/fusion_inputs.yaml','config/navigation.yaml','scripts/start_imu.sh','scripts/check_imu.py']:
            source=(W/name).read_text()
            self.assertNotIn('/odin1/imu',source,name)
        self.assertIn('imu_topic: /qr/imu/raw',(W/'config/fusion_inputs.yaml').read_text())
        self.assertIn('run_serial_imu.py',(W/'scripts/start_imu.sh').read_text())
        self.assertNotIn('imu_only"',(W/'scripts/start_imu.sh').read_text())
        self.assertIn("'imu_topic': '/qr/imu/raw'",(W/'src/greenhouse_navigation/greenhouse_navigation/fusion.py').read_text())
        self.assertIn("'imu_topic':'/qr/imu/raw'",(W/'src/greenhouse_navigation/greenhouse_navigation/node.py').read_text())
    def test_calibration_and_axis_verification_not_weakened(self):
        source=(W/'config/fusion_inputs.yaml').read_text()
        self.assertIn('calibration_duration_s: 5.0',source)
        self.assertIn('calibration_min_samples: 500',source)
        self.assertIn('imu_projection_verified: false',source)
        self.assertIn('mounting_direction_verified: false',(W/'config/imu_only.yaml').read_text())

if __name__=='__main__':unittest.main()
