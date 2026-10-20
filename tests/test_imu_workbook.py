import sys,unittest,struct,json,ast,math,collections
from pathlib import Path
W=Path(__file__).resolve().parents[1];sys.path.insert(0,str(W/'scripts'))
from imu_protocol import Parser
def f(k,v,fmt):
 b=struct.pack(fmt,*v);b=b'\x7e\x23'+bytes([len(b)+5,k])+b
 return Parser().feed(b+bytes([sum(b)&255]),1.)[0]
class Semantic(unittest.TestCase):
 def test_signed_si_magnetic(self):
  a=f(4,[8,-27,2063,0,-10,11,3763,542,3623],'<9h')
  self.assertAlmostEqual(a.acceleration[2],9.878777526169621)
  self.assertAlmostEqual(a.angular_velocity[1],-.010652969463144807)
  self.assertEqual(a.fields['mag_raw'],(3763,542,3623))
 def test_wxyz_and_rpy(self):
  self.assertEqual(f(22,[1,0,0,0],'<4f').fields,{'w':1.,'x':0.,'y':0.,'z':0.})
  self.assertAlmostEqual(f(38,[.1,.2,.3],'<3f').fields['pitch_rad'],.2,places=6)
 def test_environment(self):
  self.assertEqual(f(50,[1,25,100000,100010],'<4f').fields,{'height_m':1.,'temperature_c':25.,'pressure_pa':100000.,'startup_reference_pa':100010.})
class Diagnostic(unittest.TestCase):
 def test_real_500_bins(self):
  from imu_diagnostics import code_bins
  r=json.loads((W/'logs/imu-replacement-calibration-statistics.json').read_text())
  v=[x['value'] for x in r['gyroAxis1ObservedValues'] for _ in range(x['count'])]
  d=code_bins([[0,y,0] for y in v])
  self.assertEqual(d['axes'][1]['codes'],{'-11':4,'-10':199,'0':297})
  self.assertAlmostEqual(d['axes'][1]['stdRadS'],r['gyroStd'][1])
  self.assertLess(d['maxRoundTripError'],1e-12)
  self.assertFalse(d['hardwareFaultEstablished'])
 def test_actual_noise_gate(self):
  import numpy as np
  source=(W/'src/greenhouse_navigation/greenhouse_navigation/fusion.py').read_text()
  c=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='StationaryCalibration')
  ns={'np':np,'math':math,'deque':collections.deque};exec(compile(ast.Module(body=[c],type_ignores=[]),'calibration','exec'),ns)
  cal=ns['StationaryCalibration']();self.assertEqual(cal.minimum,500);self.assertEqual(cal.duration,5.)
  r=json.loads((W/'logs/imu-replacement-calibration-statistics.json').read_text())
  v=[x['value'] for x in r['gyroAxis1ObservedValues'] for _ in range(x['count'])]
  for i,y in enumerate(v):cal.add(i*.04,[0,y,.0117],r['accelerationMean'],True)
  self.assertIsNone(cal.result);self.assertIn('0.005',cal.last_reason)
  self.assertEqual(cal.last_window_statistics['sampleCount'],500)
  self.assertGreater(cal.last_window_statistics['gyroStdRadS'][1],.005)

if __name__=='__main__':unittest.main()
