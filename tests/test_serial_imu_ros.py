"""Message-contract tests: no ROS node, hardware or motion publishers created."""
import sys,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from builtin_interfaces.msg import Time
from sensor_msgs.msg import Imu
W=Path(__file__).resolve().parents[1];sys.path.insert(0,str(W/'scripts'))
from imu_protocol import Frame
from run_serial_imu import SerialImu

class RosMessageTests(unittest.TestCase):
    def target(self,received=100.,stamp=100000000000):
        published=[]
        frame=Frame(4,(),received,(.1,-.2,9.8),(.001,-.002,.003))
        target=SimpleNamespace(config={'max_age_s':.25,'frame_id':'imu_link'},
            receiver=SimpleNamespace(poll=lambda now:[frame],dropped_stale=0),
            publisher=SimpleNamespace(publish=published.append),last_stamp=0,last_at=None,received=0,
            get_clock=lambda:SimpleNamespace(now=lambda:SimpleNamespace(nanoseconds=stamp,to_msg=lambda:Time(sec=100))))
        return target,published
    def test_real_motion_contract_without_orientation_or_fabricated_precision(self):
        target,published=self.target()
        with patch('run_serial_imu.time.monotonic',return_value=100.):SerialImu.tick(target)
        self.assertEqual(len(published),1);m=published[0]
        self.assertEqual(m.header.frame_id,'imu_link');self.assertEqual(m.header.stamp.sec,100)
        self.assertEqual((m.linear_acceleration.x,m.linear_acceleration.y,m.linear_acceleration.z),(.1,-.2,9.8))
        self.assertEqual((m.angular_velocity.x,m.angular_velocity.y,m.angular_velocity.z),(.001,-.002,.003))
        self.assertEqual(m.orientation_covariance[0],-1.)
        self.assertEqual(list(m.angular_velocity_covariance),[0.]*9)
        self.assertEqual(list(m.linear_acceleration_covariance),[0.]*9)
        self.assertEqual(m.orientation,Imu().orientation)  # untouched ROS default; covariance=-1 declares unavailable
    def test_expired_motion_is_not_retimestamped_as_new(self):
        target,published=self.target(received=99.)
        with patch('run_serial_imu.time.monotonic',return_value=100.):SerialImu.tick(target)
        self.assertEqual(published,[]);self.assertEqual(target.receiver.dropped_stale,1)
    def test_ros_clock_rollback_does_not_publish_duplicate_or_older_stamp(self):
        target,published=self.target();target.last_stamp=100000000001
        with patch('run_serial_imu.time.monotonic',return_value=100.):SerialImu.tick(target)
        self.assertEqual(published,[]);self.assertEqual(target.receiver.dropped_stale,1)
if __name__=='__main__':unittest.main()
