"""v10 运行取证 RED→GREEN：5Hz motion 记录、目标点/欧氏距离、run 独立归档与分片。

覆盖：命令/决策/反馈同一条记录、目标 xy 与 distance_mm 主口径、segmentStop、
run 目录 meta/summary、分片轮转不丢本次 run、队列有界计数。
"""
import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/greenhouse_navigation'))


class BuildRecord(unittest.TestCase):
    def test_motion_record_has_full_chain(self):
        from greenhouse_navigation.run_log import build_motion_record
        rec = build_motion_record(
            t=100.5, seg=7, frm=129, to=113, phase='MOVE', mode='4t4d',
            cmd={'vx': .08, 'vy': 0., 'wz': -.02, 'rawWz': -.03, 'clampedWz': -.02,
                 'wheelAngle': 0.},
            pose={'x': -4.5, 'y': .6, 'yaw': 3.14, 'stamp': 100.4},
            target={'x': -4.58889405421765, 'y': .6121323759706345},
            cross=.012, heading=.01, remaining=.09,
            dr={'decision': 'steer_4t4d', 'refValid': True, 'refM': .012,
                'refReason': 'ok', 'episode': {'active': True, 'attempts': 1,
                                               'completed': 0, 'distance': .03},
                'predicted': {'x': -4.5, 'y': .61}, 'staleS': .8,
                'yawSourceOk': True, 'anchorValid': True},
            fb={'seq': 123, 'age': .01, 'bodyGear': 6, 'steerGear': 5,
                'angles': [0., 0., 0., 0.], 'steerAngle': 0., 'vx': .08,
                'vyRaw': 0., 'vyMps': 0., 'unlock': True, 'estop': False,
                'localX': 1., 'localY': 2., 'localYaw': .1, 'localStamp': 100.3,
                'localEpoch': 'E1'},
            source_stamp=100.4, qr={'sourceStamp': 100.2, 'correctionId': '0-1'},
            send={'sent': True, 'mode': '4t4d', 'vx': .08, 'vy': 0., 'wz': -.02})
        for key in ('t', 'seg', 'from', 'to', 'phase', 'mode', 'cmd', 'pose', 'target',
                    'distance_mm', 'cross', 'heading', 'remaining', 'dr', 'fb',
                    'sourceStamp', 'qr', 'send'):
            self.assertIn(key, rec)
        self.assertAlmostEqual(rec['distance_mm'],
                               1000 * math.hypot(-4.5 + 4.58889405421765, .6 - .6121323759706345),
                               places=1)
        self.assertEqual(rec['cmd']['vy'], 0.)
        self.assertEqual(rec['mode'], '4t4d')

    def test_segment_stop_record(self):
        from greenhouse_navigation.run_log import build_stop_record
        rec = build_stop_record(t=120., seg=7, to=113, pose={'x': -4.5797, 'y': .6052, 'yaw': 3.14},
                                target={'x': -4.58889405421765, 'y': .6121323759706345},
                                speed=0., state='FINISHED', samples=[0., 0., 0.], stamp=119.9)
        self.assertAlmostEqual(rec['distance_mm'], 11.5, delta=.2)
        self.assertEqual(rec['state'], 'FINISHED')
        self.assertEqual(rec['speed'], 0.)


class RunLogArchive(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='runlog-')

    def test_writes_meta_motion_shards_and_summary(self):
        from greenhouse_navigation.run_log import RunLog
        rl = RunLog(base_dir=self.dir, run_id='run-test', shard_bytes=2048, queue_size=1000)
        rl.start(meta={'taskId': 't1', 'routeId': 'r1', 'mapId': 'm', 'mapVersion': 5,
                       'targets': [{'seg': i, 'to': 100 + i, 'x': i * .1, 'y': 0.} for i in range(7)]})
        for i in range(120):
            rl.write_motion({'t': i * .2, 'seg': 1, 'distance_mm': float(i)})
        rl.stop_record({'seg': 1, 'to': 101, 'distance_mm': 9.9, 'state': 'FINISHED'})
        rl.close(summary={'completed': 7})
        files = sorted(os.listdir(os.path.join(self.dir, 'run-test')))
        shards = [f for f in files if f.startswith('motion-') and f.endswith('.jsonl')]
        self.assertGreaterEqual(len(shards), 2, '必须按大小分片且保留全部：%r' % files)
        n = 0
        for s in shards:
            for line in open(os.path.join(self.dir, 'run-test', s), encoding='utf-8'):
                json.loads(line); n += 1
        self.assertEqual(n, 120, '分片不得丢本次 run 记录')
        meta = json.load(open(os.path.join(self.dir, 'run-test', 'meta.json'), encoding='utf-8'))
        self.assertEqual(len(meta['targets']), 7)
        summary = json.load(open(os.path.join(self.dir, 'run-test', 'summary.json'), encoding='utf-8'))
        self.assertEqual(summary['completed'], 7)
        stops = [json.loads(l) for l in open(os.path.join(self.dir, 'run-test', 'stops.jsonl'), encoding='utf-8')]
        self.assertEqual(stops[0]['distance_mm'], 9.9)

    def test_bounded_queue_counts_drops(self):
        from greenhouse_navigation.run_log import RunLog
        rl = RunLog(base_dir=self.dir, run_id='run-drop', shard_bytes=1 << 20, queue_size=2)
        rl.start(meta={'taskId': 't'})
        rl._paused = True   # 模拟 IO 阻塞
        for i in range(10):
            rl.write_motion({'t': i})
        self.assertGreater(rl.dropped, 0, '队列有界必须计数丢弃，不能无限内存')
        rl._paused = False
        rl.close(summary={})


if __name__ == '__main__':
    unittest.main(verbosity=2)
