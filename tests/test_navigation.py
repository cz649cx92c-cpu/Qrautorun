import math
import sys
import unittest
from pathlib import Path
import yaml
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'src/greenhouse_navigation'))
from greenhouse_navigation.control import Tracker,Pose
from greenhouse_navigation.odometry import wheel_twist
from greenhouse_navigation.mission import Mission
from greenhouse_navigation.localization import absolute_tag_pose
import importlib.util
spec=importlib.util.spec_from_file_location('survey',root/'scripts/survey_optimize.py');survey=importlib.util.module_from_spec(spec);spec.loader.exec_module(survey)


class NavigationChecks(unittest.TestCase):
    def test_reverse_feedback_signs(self):
        forward=[{'x':0.,'y':0.},{'x':2.,'y':0.}]
        pose=Pose(1.,.02,0.,.01)
        f,*_=Tracker().forward(pose,forward,.1,.05)
        r,*_=Tracker().reverse(pose,list(reversed(forward)),.1,.05)
        self.assertGreater(f.vx,0);self.assertLess(r.vx,0)
        self.assertLess(f.yaw_rate,0);self.assertGreater(r.yaw_rate,0)

    def test_lateral_wheel_geometry(self):
        positions=[(.3,.2),(.3,-.2),(-.3,.2),(-.3,-.2)]
        for speeds,angles,expected in [([.1]*4,[0.]*4,[.1,0.,0.]),([-.1]*4,[0.]*4,[-.1,0.,0.]),([.1]*4,[math.pi/2]*4,[0.,.1,0.])]:
            result,residual=wheel_twist(speeds,angles,positions)
            self.assertLess(residual,1e-6)
            for a,b in zip(result,expected):self.assertAlmostEqual(a,b,places=6)

    def test_no_motion_without_conditions(self):
        config=yaml.safe_load((root/'config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters']
        m=Mission(config);m.running=True
        cmd=m.tick(None,{},[],[{'id':'pose','label':'真实位姿','ready':False}],.05)
        self.assertEqual(cmd.vx,0.);self.assertEqual(cmd.vy,0.);self.assertEqual(m.state,'FAULT')

    def test_switch_requires_new_feedback_samples(self):
        config=yaml.safe_load((root/'config/navigation.yaml').read_text())['greenhouse_navigation']['ros__parameters'];m=Mission(config)
        feedback={'seq':1,'speed':0.,'angles':[90.]*4,'steering_gear':7}
        for _ in range(20):self.assertFalse(m.stable_feedback(feedback,90.,(7,8)))
        for n in range(2,6):feedback['seq']=n;ready=m.stable_feedback(feedback,90.,(7,8))
        self.assertTrue(ready)
        feedback['seq']=6;feedback['angles'][0]=85.;self.assertFalse(m.stable_feedback(feedback,90.,(7,8)))

    def test_camera_disabled_until_verified(self):
        config=yaml.safe_load((root/'config/camera_last.yaml').read_text())['qr_ground_detector']['ros__parameters']
        self.assertFalse(config['camera_calibration_verified'])
        from greenhouse_navigation.detector import rotation_from_quaternion
        from types import SimpleNamespace
        r=rotation_from_quaternion(SimpleNamespace(x=1.,y=0.,z=0.,w=0.))
        self.assertAlmostEqual(r[2,2],-1.)

    def test_marker_absolute_transform(self):
        result=absolute_tag_pose({'x':2.,'y':1.,'angle':90.},{'x':1.,'y':0.,'angle':math.pi/2})
        self.assertAlmostEqual(result[0],1.);self.assertAlmostEqual(result[1],1.);self.assertAlmostEqual(result[2],0.)

    def test_repeated_observations_optimization(self):
        tags=[{'id':0,'x':0.,'y':1.},{'id':1,'x':2.,'y':1.},{'id':2,'x':1.,'y':2.}];samples=[]
        # 这是数学算法单元输入，不接入运行系统，不声称实测数据。
        for i in range(6):
            x=i*.2;samples.append({'pose':{'x':x*1.03,'y':0.,'yaw':0.},'tags':[{'id':t['id'],'x':t['x']-x,'y':t['y'],'sigma':.02} for t in tags]})
        result=survey.optimize({'samples':samples,'anchors':tags[:2]})
        self.assertEqual(len(result['tags']),3);self.assertTrue(result['anchored']);self.assertLess(result['rmsM'],.02)
        self.assertTrue(all(t['count']==6 for t in result['tags']));self.assertEqual(result['coordinateStatus'],'draft')

if __name__=='__main__':unittest.main(verbosity=2)
