"""融合标定录音：只切换被动采样上下文，绝不产生运动/解锁/导航命令。

用 object.__new__ 构造节点，故意不提供 motion/commands/mission 之外的状态：
若实现里误触运动接口，这里会直接 AttributeError。
"""
import sys
import types
import unittest
from pathlib import Path
from queue import Queue

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))

from greenhouse_navigation.node import GreenhouseNode  # noqa: E402


class CalibrationRecordingTests(unittest.TestCase):
    def make_node(self):
        node = object.__new__(GreenhouseNode)
        node.calibration_context = None
        node.calibration_last_context = None
        node.calibration_samples = Queue(maxsize=8)
        self.events = []
        node.mission = types.SimpleNamespace(log=lambda text: self.events.append(text))
        return node

    def test_start_switches_context_and_logs_without_touching_motion(self):
        node = self.make_node()
        node.apply_calibration_command({'active': True, 'sessionId': 'cal-1', 'trialId': 'trial-1'})
        self.assertEqual(node.calibration_context, {'sessionId': 'cal-1', 'trialId': 'trial-1'})
        self.assertEqual(node.calibration_last_context, {'sessionId': 'cal-1', 'trialId': 'trial-1'})
        self.assertTrue(any('不发送任何运动命令' in text for text in self.events), self.events)
        # 只切换上下文：不创建/调用命令队列与运动接口
        self.assertFalse(hasattr(node, 'commands'))
        self.assertFalse(hasattr(node, 'motion'))

    def test_stop_clears_context_but_keeps_flush_target(self):
        node = self.make_node()
        node.apply_calibration_command({'active': True, 'sessionId': 'cal-1', 'trialId': 'trial-1'})
        node.apply_calibration_command({'active': False, 'sessionId': 'cal-1', 'trialId': 'trial-1'})
        self.assertIsNone(node.calibration_context)
        self.assertEqual(node.calibration_last_context, {'sessionId': 'cal-1', 'trialId': 'trial-1'})
        self.assertFalse(hasattr(node, 'motion'))

    def test_restart_replaces_context(self):
        node = self.make_node()
        node.apply_calibration_command({'active': True, 'sessionId': 'cal-1', 'trialId': 'trial-1'})
        node.apply_calibration_command({'active': True, 'sessionId': 'cal-2', 'trialId': 'trial-2'})
        self.assertEqual(node.calibration_context, {'sessionId': 'cal-2', 'trialId': 'trial-2'})

    def test_invalid_payloads_are_rejected(self):
        node = self.make_node()
        # 空 dict 视为“停止/无上下文”，是合法命令；其余畸形负载必须拒绝。
        node.apply_calibration_command({})
        self.assertIsNone(node.calibration_context)
        for payload in (None, 'x', [], {'active': True}, {'active': True, 'sessionId': 'cal-1'},
                        {'active': True, 'sessionId': '', 'trialId': 'trial-1'},
                        {'active': True, 'sessionId': 'cal-1', 'trialId': 'x' * 200}):
            with self.assertRaises(ValueError):
                node.apply_calibration_command(payload)
        self.assertIsNone(node.calibration_context)


if __name__ == '__main__':
    unittest.main(verbosity=2)
