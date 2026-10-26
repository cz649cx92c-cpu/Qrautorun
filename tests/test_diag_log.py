"""v9 诊断日志：写入/滚动/会话上限告警/丢弃/IO 隔离/禁用开关。"""
import json, os, sys, unittest, tempfile, time, queue
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/greenhouse_navigation'))
os.environ['QR_DIAG_DISABLE'] = '1'
from greenhouse_navigation.diag_log import DiagLogger
os.environ.pop('QR_DIAG_DISABLE', None)


class DiagLogChecks(unittest.TestCase):
    def test_write_and_flush(self):
        with tempfile.TemporaryDirectory() as d:
            lg = DiagLogger('t', root=d, file_max_bytes=1 << 20, session_max_bytes=1 << 20, flush_interval=0.05)
            for i in range(10):
                lg.write({'i': i})
            deadline = time.monotonic() + 2
            while lg.written < 10 and time.monotonic() < deadline:
                time.sleep(0.02)
            time.sleep(0.35)
            self.assertEqual(lg.written, 10)
            self.assertEqual(lg.dropped, 0)
            with open(lg.path, encoding='utf-8') as f:
                lines = [l.rstrip('\n') for l in f if l.strip()]
            self.assertEqual(len(lines), 10)
            self.assertEqual(json.loads(lines[0]).get('i'), 0)

    def test_rotation(self):
        with tempfile.TemporaryDirectory() as d:
            lg = DiagLogger('t', root=d, file_max_bytes=300, session_max_bytes=10 << 20, flush_interval=0.02)
            for i in range(10):
                lg.write({'payload': 'x' * 120})
            deadline = time.monotonic() + 2
            while lg.rotated < 1 and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertGreaterEqual(lg.rotated, 1)
            self.assertTrue(os.path.exists(lg.path + '.1'))

    def test_session_cap_stops_and_alerts(self):
        with tempfile.TemporaryDirectory() as d:
            lg = DiagLogger('t', root=d, file_max_bytes=1 << 20, session_max_bytes=250, flush_interval=0.02)
            for i in range(10):
                lg.write({'payload': 'x' * 120})
            deadline = time.monotonic() + 2
            while not lg._closed and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(lg._closed)
            alert = os.path.join(lg.dir, 'diag-alert.jsonl')
            self.assertTrue(os.path.exists(alert), '达到会话上限必须有可观测告警')
            with open(alert, encoding='utf-8') as f:
                rec = json.loads(f.readline())
            self.assertEqual(rec['alert'], 'sessionCapReached')
            n = lg.written
            lg.write({'late': 1})
            self.assertGreater(lg.dropped, 0)
            self.assertEqual(lg.written, n)   # 停写后不再增长，保留已采数据

    def test_queue_full_counts_dropped_no_block(self):
        with tempfile.TemporaryDirectory() as d:
            lg = DiagLogger('t', root=d, queue_size=2, flush_interval=10)
            lg._closed = True
            lg._fh = None
            lg._q = queue.Queue(maxsize=2)
            for i in range(5):
                lg.write({'i': i})
            self.assertGreaterEqual(lg.dropped, 3)

    def test_io_error_isolated(self):
        blocker = os.path.join(tempfile.gettempdir(), 'diag_block_file')
        open(blocker, 'w').close()
        try:
            lg = DiagLogger('t', root=os.path.join(blocker, 'x'))
            lg.write({'a': 1})
            self.assertGreaterEqual(lg.write_errors, 1)
        finally:
            os.remove(blocker)

    def test_disable_flag(self):
        os.environ['QR_DIAG_DISABLE'] = '1'
        try:
            with tempfile.TemporaryDirectory() as d:
                lg = DiagLogger('t', root=d)
                self.assertTrue(lg.disabled)
                lg.write({'a': 1})
                self.assertFalse(os.path.exists(os.path.join(d, 't.jsonl')))
        finally:
            os.environ.pop('QR_DIAG_DISABLE', None)


if __name__ == '__main__':
    unittest.main(verbosity=2)
