"""Offline reverse pass-through regression; never imports ROS or publishes CAN."""
import math
import unittest
from test_v10_continuous_straight import ContinuousStraight, seg
from test_segment_execution import setup


class ReverseContinuity(ContinuousStraight):
    def fb(self, mode="4t4d", angle=0., speed=0.):
        feedback = super().fb(mode, angle, speed)
        feedback["speed"] = abs(speed)
        return feedback

    def route(self):
        return [seg((0, 0), (-.3, 0), 0, direction='reverse', body_yaw=0.),
                seg((-.3, 0), (-.6, 0), 1, direction='reverse', body_yaw=0.),
                seg((-.6, 0), (-.9, 0), 2, direction='reverse', body_yaw=0.)]

    def test_reverse_passes_two_codes_without_stop_or_direction_change(self):
        m, pose = setup(self.route())
        self.enter_move(m, pose)
        ex = m.segment_executor
        boundaries = []
        old_index = ex.index
        for _ in range(1600):
            cmd = self.tick(m, pose, speed=-.06 if ex.phase == 'MOVE' else 0.,
                            obs=[{'id': ex.segment['toId']}])
            if ex.index != old_index:
                boundaries.append((ex.index, cmd.vx, m.state))
                old_index = ex.index
            if ex.index < 2:
                self.assertEqual(ex.phase, 'MOVE')
                self.assertLess(cmd.vx, 0., str((m.events[:5], ex.exit_info, pose)))
                self.assertEqual(m.state, 'REVERSE')
                self.assertEqual(cmd.vy, 0.)
            pose.x += cmd.vx * .05
            pose.yaw += cmd.yaw_rate * .05
            self.assertNotEqual(m.state, 'FAULT', str(m.events[:5]))
            if ex.index == 2 and ex.phase == 'END_STOP':
                break
        else:
            self.fail('reverse route did not reach final braking')
        self.assertEqual([r[0] for r in boundaries], [1, 2])
        for _, speed, state in boundaries:
            self.assertLess(speed, -.04, 'speed must carry through, not restart from zero')
            self.assertEqual(state, 'REVERSE')
        self.assertEqual(len(ex.pass_log), 2)
        self.assertEqual(m.config['max_cross_track_m'], .05)

    def test_reverse_to_forward_must_stop(self):
        segments = self.route()[:1] + [seg((-.3, 0), (0, 0), 1, body_yaw=0.)]
        m, pose = setup(segments)
        self.assertNotEqual(m.segment_executor.next_action_kind(), 'same_straight')

    def test_reverse_to_lateral_must_stop(self):
        segments = self.route()[:1] + [seg((-.3, 0), (-.3, .3), 1,
                    mode='crab', direction='lateral', body_yaw=0.)]
        m, pose = setup(segments)
        self.assertEqual(m.segment_executor.next_action_kind(), 'lateral')

    def test_reverse_heading_wrap_is_continuous(self):
        segments = [seg((0, 0), (.3, 0), 0, direction='reverse', body_yaw=-math.pi),
                    seg((.3, 0), (.6, 0), 1, direction='reverse', body_yaw=math.pi)]
        m, pose = setup(segments)
        self.assertEqual(m.segment_executor.next_action_kind(), 'same_straight')

    def test_latest_office_route_boundaries(self):
        # Latest office return: Q016 -> Q080 -> Q064 -> Q096.
        points = [(1.8, 1.65), (1.2, 1.65), (.6, 1.65), (0., 1.65)]
        segments = [seg(points[i], points[i+1], i, direction='reverse', body_yaw=0.)
                    for i in range(3)]
        m, pose = setup(segments)
        for index in (0, 1):
            m.segment_executor.index = index
            self.assertEqual(m.segment_executor.next_action_kind(), 'same_straight')
        m.segment_executor.index = 2
        self.assertEqual(m.segment_executor.next_action_kind(), 'final')


if __name__ == '__main__':
    unittest.main()
