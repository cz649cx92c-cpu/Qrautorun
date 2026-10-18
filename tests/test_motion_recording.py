import math
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as S
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src/greenhouse_navigation'))
from greenhouse_navigation.motion_recording import feedback_record

class MotionRecordingTests(unittest.TestCase):
 def msg(self,gear,vy):
  return S(header=S(stamp=S(sec=10,nanosec=500000000)),ctrl_fb=S(ctrl_fb_gear=gear,ctrl_fb_x_linear=-.1,ctrl_fb_y_linear=vy,ctrl_fb_z_angular=90.),steering_ctrl_fb=S(steering_ctrl_fb_gear=7))
 def test_feedback_units_and_provenance(self):
  r=feedback_record(self.msg(8,-.6),12,'epoch',123.)
  self.assertEqual(r['stamp'],10.5);self.assertEqual(r['seq'],12)
  self.assertEqual(r['bodyGear'],8);self.assertEqual(r['steeringGear'],7)
  self.assertAlmostEqual(r['vy'],-.06);self.assertEqual(r['vyRaw'],-.6)
  self.assertAlmostEqual(r['wz'],math.pi/2);self.assertEqual(r['localEpoch'],'epoch')
  self.assertEqual(r['feedbackSource'],'chassis_info_fb_aggregate')
 def test_unknown_gear_preserved_and_nonfinite_rejected(self):
  self.assertEqual(feedback_record(self.msg(7,0),1,'',2.)['bodyGear'],7)
  self.assertIsNone(feedback_record(self.msg(8,float('nan')),1,'epoch',2.))
