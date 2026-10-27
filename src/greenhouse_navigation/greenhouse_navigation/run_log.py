"""v10 运行取证：后台 JSONL 记录（有界队列 + IO 隔离 + 分片 + 独立 run 目录）。

不改变控制逻辑；只把 mission/segment 每 tick 的命令、决策、反馈、目标点与距离写入
logs/diagnostics/runs/<runId>/，供跑后精确复算。前端 schema 不变。
"""
import json
import math
import os
import queue
import threading
import time


def _f(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def build_motion_record(t, seg, frm, to, phase, mode, cmd, pose, target, cross, heading,
                        remaining, dr, fb, source_stamp, qr, send, endpoint_brake=None):
    """一条记录同时含实际命令、决策、反馈、位姿、目标点与欧氏距离（主口径）。"""
    px, py = _f(pose.get('x')), _f(pose.get('y'))
    tx, ty = _f(target.get('x')), _f(target.get('y'))
    dist = None
    if None not in (px, py, tx, ty):
        dist = round(1000. * math.hypot(px - tx, py - ty), 1)
    brake = {}
    if isinstance(endpoint_brake, dict):
        for k, v in endpoint_brake.items():
            brake[k] = _f(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v
    return {'t': round(float(t), 6), 'seg': seg, 'from': frm, 'to': to,
            'phase': phase, 'mode': mode,
            'cmd': {'vx': _f(cmd.get('vx')), 'vy': _f(cmd.get('vy')),
                    'wz': _f(cmd.get('wz')), 'rawWz': _f(cmd.get('rawWz')),
                    'clampedWz': _f(cmd.get('clampedWz')),
                    'wheelAngle': _f(cmd.get('wheelAngle'))},
            'pose': {'x': px, 'y': py, 'yaw': _f(pose.get('yaw')),
                     'stamp': _f(pose.get('stamp'))},
            'target': {'x': tx, 'y': ty},
            'distance_mm': dist, 'cross': _f(cross), 'heading': _f(heading),
            'remaining': _f(remaining),
            'dr': dr, 'fb': fb, 'sourceStamp': _f(source_stamp),
            'qr': qr, 'send': send,
            'endpointBrake': brake}


def build_stop_record(t, seg, to, pose, target, speed, state, samples, stamp):
    px, py = _f(pose.get('x')), _f(pose.get('y'))
    tx, ty = _f(target.get('x')), _f(target.get('y'))
    dist = None
    if None not in (px, py, tx, ty):
        dist = round(1000. * math.hypot(px - tx, py - ty), 1)
    return {'t': round(float(t), 6), 'seg': seg, 'to': to,
            'pose': {'x': px, 'y': py, 'yaw': _f(pose.get('yaw'))},
            'target': {'x': tx, 'y': ty}, 'distance_mm': dist,
            'speed': _f(speed), 'state': state,
            'zeroSamples': len(samples) if isinstance(samples, (list, tuple)) else int(samples or 0),
            'stamp': _f(stamp)}


class RunLog:
    """独立 run 目录 + 分片 JSONL；后台线程写，队列有界，阻塞时计数丢弃。"""

    def __init__(self, base_dir, run_id, shard_bytes=4 << 20, queue_size=20000):
        self.dir = os.path.join(base_dir, run_id)
        os.makedirs(self.dir, exist_ok=True)
        self.shard_bytes = int(shard_bytes)
        self.q = queue.Queue(maxsize=int(queue_size))
        self.dropped = 0
        self._paused = False
        self._closed = False
        self._shard = 0
        self._fh = None
        self._written = 0
        self._thread = threading.Thread(target=self._worker, name='run-log', daemon=True)
        self._thread.start()

    def start(self, meta):
        self._write_file('meta.json', json.dumps(meta, ensure_ascii=False, indent=1))
        self._open_shard()

    def _open_shard(self):
        if self._fh:
            self._fh.close()
        name = 'motion-%03d.jsonl' % self._shard
        self._shard += 1
        self._fh = open(os.path.join(self.dir, name), 'a', encoding='utf-8')
        self._written = 0

    def _write_file(self, name, text):
        tmp = os.path.join(self.dir, name + '.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(text)
        os.replace(tmp, os.path.join(self.dir, name))

    def write_motion(self, rec):
        if self._closed:
            return
        try:
            self.q.put_nowait(('motion', rec))
        except queue.Full:
            self.dropped += 1

    def stop_record(self, rec):
        if self._closed:
            return
        try:
            self.q.put_nowait(('stop', rec))
        except queue.Full:
            self.dropped += 1

    def _worker(self):
        while True:
            try:
                kind, rec = self.q.get(timeout=.2)
            except queue.Empty:
                if self._closed:
                    return
                continue
            if self._paused:
                # 模拟 IO 阻塞：不消费，队列满后由 put 侧计数丢弃
                time.sleep(.02)
                self.q.put((kind, rec))
                continue
            try:
                if kind == 'stop':
                    with open(os.path.join(self.dir, 'stops.jsonl'), 'a', encoding='utf-8') as f:
                        f.write(json.dumps(rec, ensure_ascii=False) + '\n')
                else:
                    line = json.dumps(rec, ensure_ascii=False) + '\n'
                    self._fh.write(line)
                    self._fh.flush()
                    self._written += len(line.encode('utf-8'))
                    if self._written >= self.shard_bytes:
                        self._open_shard()
            except Exception:
                self.dropped += 1

    def close(self, summary=None):
        while not self.q.empty():
            time.sleep(.01)
        if summary is not None:
            self._write_file('summary.json', json.dumps(summary, ensure_ascii=False, indent=1))
        self._closed = True
        self._thread.join(timeout=3)
        if self._fh:
            self._fh.close()
