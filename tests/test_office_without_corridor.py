import unittest,math
import test_forward_only as fixtures

class OfficeWithoutCorridorTests(fixtures.ForwardOnlyTests):
    def harness(self):
        m,field,task,pose,h=super().harness()
        # Deliberately incompatible greenhouse metadata must not stop an office path.
        field['vehicle']={'width':4.,'length':8.,'margin':1.}
        field['rows'][0]['width']=.01;field['zone']=[]
        return m,field,task,pose,h

    def test_path_deviation_is_still_reported_as_navigation_error(self):
        m,field,task,pose,h=self.harness();m.start(field,task,pose);m.state='FORWARD'
        pose.x-=.10*math.sin(h);pose.y+=.10*math.cos(h)
        m.config['qr_interval_navigation']=False
        cmd=m.tick(pose,{'seq':1,'speed':0.},[],[],.05)
        self.assertEqual(cmd.vx,0.);self.assertEqual(m.state,'FAULT')
        self.assertIn('路径侧偏或航向偏差超限',m.events[0])

if __name__=='__main__':unittest.main(verbosity=2)
