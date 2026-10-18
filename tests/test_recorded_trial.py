import unittest,math,copy
from greenhouse_navigation.control import Tracker,Pose,wrap
from greenhouse_navigation.segment_execution import validate_segments,inverse
from greenhouse_navigation.recorded_trial import LIMITS

class RecordedTrialTests(unittest.TestCase):
    def arc(self,radius=.2):
        points=[{'x':radius*math.sin(i*.06),'y':radius*(1-math.cos(i*.06))} for i in range(16)]
        tangent=lambda a,b:math.atan2(b['y']-a['y'],b['x']-a['x'])
        return dict(id='arc',fromId=0,toId=16,mode='4t4d',direction='forward',bodyYaw=tangent(*points[:2]),endYaw=tangent(*points[-2:]),wheelAngle=0,points=points,executionProfile=LIMITS['profile'])
    def test_trial_curves_are_explicit_and_legacy_limit_is_retained(self):
        s=self.arc();validate_segments([s]);validate_segments([inverse(s)])
        legacy=copy.deepcopy(s);legacy.pop('executionProfile')
        with self.assertRaisesRegex(ValueError,'曲率'):validate_segments([legacy])
        with self.assertRaisesRegex(ValueError,'曲率'):validate_segments([self.arc(.1)])
        bad=copy.deepcopy(s);bad['executionProfile']='anything'
        with self.assertRaisesRegex(ValueError,'执行配置'):validate_segments([bad])
    def test_long_sampled_adjacent_segments_keep_first_endpoint(self):
        def segment(start,end,first,last):
            return dict(id=str(first),fromId=first,toId=last,mode='4t4d',direction='forward',bodyYaw=0.,endYaw=0.,wheelAngle=0.,points=[{'x':start+(end-start)*i/4,'y':0.} for i in range(5)])
        validate_segments([segment(0.,.4,0,16),segment(.4,.8,16,32)])
    def test_trial_forward_reverse_obey_speed_acceleration_yaw_and_slew(self):
        for original in [self.arc(),self.arc(-.2)]:
            for s in [original,inverse(original)]:
                tracker=Tracker();p=s['points'][0];pose=Pose(p['x'],p['y'],s['bodyYaw']);prev_v=prev_w=0.;done=False
                for tick in range(3000):
                    fn=tracker.forward if s['direction']=='forward' else tracker.reverse
                    cmd,cross,heading,remaining,end=fn(pose,s['points'],.12,.05,profile=LIMITS['profile'])
                    if end<.025 and remaining<.035:done=True;break
                    self.assertLessEqual(abs(cmd.vx),LIMITS['maxSpeed']+1e-9)
                    self.assertLessEqual(abs(cmd.vx)-prev_v,LIMITS['acceleration']*.05+1e-9)
                    self.assertLessEqual(abs(cmd.yaw_rate),min(LIMITS['maxYawRate'],abs(cmd.vx)*LIMITS['maxCurvature'])+1e-9)
                    self.assertLessEqual(abs(cmd.yaw_rate-prev_w),LIMITS['yawAcceleration']*.05+1e-9)
                    self.assertLess(abs(cross),.05);self.assertLess(abs(heading),.15)
                    mid=pose.yaw+cmd.yaw_rate*.025;pose.x+=cmd.vx*.05*math.cos(mid);pose.y+=cmd.vx*.05*math.sin(mid);pose.yaw=wrap(pose.yaw+cmd.yaw_rate*.05)
                    prev_v=abs(cmd.vx);prev_w=cmd.yaw_rate
                self.assertTrue(done)
if __name__=='__main__':unittest.main()
