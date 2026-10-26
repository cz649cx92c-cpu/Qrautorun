"""v9 旁路诊断日志：异步有界队列写 JSONL 分片；超限/IO 失败只计数不抛出、不阻塞调用方。"""
import json
import os
import queue
import threading
import time

_DEFAULT_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                              '..', '..', '..', 'logs', 'diagnostics', 'measurement-v9'))
_registry = {}
_lock = threading.Lock()


class DiagLogger:
    def __init__(self, name, root=None, file_max_bytes=20 << 20, session_max_bytes=200 << 20,
                 queue_size=4000, flush_interval=1.0):
        self.name = name
        self.disabled = os.environ.get('QR_DIAG_DISABLE') == '1'
        self.dropped = 0
        self.write_errors = 0
        self.written = 0
        self.rotated = 0
        self.session_bytes = 0
        self.path = None
        self._closed = False
        if self.disabled:
            return
        base = root or os.environ.get('QR_DIAG_ROOT') or _DEFAULT_ROOT
        session = os.environ.get('QR_DIAG_SESSION') or time.strftime('%Y%m%dT%H%M%S')
        self.dir = os.path.join(base, session)
        try:
            os.makedirs(self.dir, exist_ok=True)
            self.path = os.path.join(self.dir, name + '.jsonl')
            self._file_max = file_max_bytes
            self._session_max = session_max_bytes
            self._flush_interval = flush_interval
            self._q = queue.Queue(maxsize=queue_size)
            self._fh = open(self.path, 'a', encoding='utf-8')
            self.session_bytes = self._fh.tell()
        except OSError:
            self.write_errors += 1
            self._fh = None
            self._closed = True
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def write(self, record):
        """非阻塞入队；队列满/会话停写计 dropped；永不抛出。"""
        if self.disabled:
            return
        if self._closed:
            self.dropped += 1
            return
        try:
            rec = dict(record)
            rec.setdefault('logTime', round(time.time(), 6))
            line = json.dumps(rec, ensure_ascii=False, separators=(',', ':'))
        except Exception:
            self.dropped += 1
            return
        try:
            self._q.put_nowait(line)
        except queue.Full:
            self.dropped += 1

    def stats(self):
        return {'logger': self.name, 'written': self.written, 'dropped': self.dropped,
                'writeErrors': self.write_errors, 'rotated': self.rotated,
                'sessionBytes': self.session_bytes, 'path': self.path, 'disabled': self.disabled,
                'closed': self._closed}

    def _alert(self, reason, detail):
        """会话上限/停写等可观测告警：直接追加到本会话 diag-alert.jsonl，失败只计数。"""
        try:
            with open(os.path.join(self.dir, 'diag-alert.jsonl'), 'a', encoding='utf-8') as f:
                f.write(json.dumps({'alert': reason, 'logger': self.name, 'logTime': round(time.time(), 6),
                                    'written': self.written, 'dropped': self.dropped, **detail},
                                   ensure_ascii=False, separators=(',', ':')) + '\n')
        except OSError:
            self.write_errors += 1

    def _rotate(self):
        try:
            self._fh.close()
            older = self.path + '.1'
            if os.path.exists(older):
                os.remove(older)
            os.replace(self.path, older)
            self.rotated += 1
            self._fh = open(self.path, 'a', encoding='utf-8')
        except OSError:
            self.write_errors += 1
            self._fh = None
            self._closed = True

    def _run(self):
        last_flush = time.monotonic()
        while True:
            try:
                line = self._q.get(timeout=0.2)
            except queue.Empty:
                if not self._closed and self._fh is not None and time.monotonic() - last_flush >= self._flush_interval:
                    try:
                        self._fh.flush()
                    except OSError:
                        self.write_errors += 1
                    last_flush = time.monotonic()
                continue
            if self._closed:
                self.dropped += 1
                continue
            try:
                self._fh.write(line + '\n')
                self.written += 1
                self.session_bytes += len(line) + 1
                if time.monotonic() - last_flush >= self._flush_interval:
                    self._fh.flush()
                    last_flush = time.monotonic()
                if self.session_bytes >= self._file_max:
                    self._rotate()
                if self.session_bytes >= self._session_max:
                    self._alert('sessionCapReached', {'sessionBytes': self.session_bytes})
                    try:
                        self._fh.flush()
                        self._fh.close()
                    except OSError:
                        self.write_errors += 1
                    self._closed = True   # 会话超限：停写保数据，dropped 继续累计
            except OSError:
                self.write_errors += 1    # IO 失败隔离：丢这一条，不抛出


def get(name):
    """同进程同名共享一个 logger。"""
    with _lock:
        logger = _registry.get(name)
        if logger is None:
            logger = DiagLogger(name)
            _registry[name] = logger
        return logger
