#!/usr/bin/env python3
"""Project-scoped process supervision; status is process health, not ROS readiness.

Prefer transient user systemd units. Without a user manager, detach a supervisor
which restarts the existing foreground launcher. Never search/kill by node name.
"""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SERVICES = {
    'web': ('start.sh', 'qr-navigation-web.service', 'web/backend/src/server.ts'),
    'imu': ('start_imu.sh', 'qr-navigation-imu.service', 'scripts/run_serial_imu.py'),
    'vision': ('start_vision.sh', 'qr-navigation-vision.service', 'scripts/run_vision.py'),
    'fusion': ('start_fusion.sh', 'qr-navigation-fusion.service', 'scripts/run_fusion.py'),
    'localization': ('start_localization.sh', 'qr-navigation-localization.service', 'install/greenhouse_navigation/lib/greenhouse_navigation/localization'),
    'robot': ('start_robot.sh', 'qr-navigation-bridge.service', 'install/greenhouse_navigation/lib/greenhouse_navigation/navigation'),
    'draft-capture': ('start_draft_capture.sh', 'qr-draft-capture.service', 'install/greenhouse_navigation/lib/greenhouse_navigation/draft_capture'),
}


def read_json(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def identity(pid):
    """PID + kernel start ticks prevents stale/recycled PID signalling."""
    try:
        if int(pid) <= 1:
            return None
        proc = Path('/proc') / str(int(pid))
        if proc.stat().st_uid != os.getuid():
            return None
        fields = (proc / 'stat').read_text().rpartition(')')[2].split()
        if fields[0] == 'Z':
            return None
        return {'pid': int(pid), 'startTicks': fields[19]}
    except (OSError, ValueError, TypeError, IndexError):
        return None


def alive(record):
    return bool(record and identity(record.get('pid')) == record)


def send(record, sig):
    if alive(record):
        try:
            os.kill(record['pid'], sig)
        except ProcessLookupError:
            pass


class ServiceManager:
    def __init__(self, root=ROOT):
        self.root = Path(root).resolve()
        self.directory = self.root / 'logs/services'
        self.directory.mkdir(parents=True, exist_ok=True)
        self.restart_delay = max(.2, float(os.environ.get('QR_SERVICE_RESTART_SEC', '2')))
        self.stop_timeout = 10.
        self.detached = {}

    def paths(self, name):
        return self.directory / (name + '.desired.json'), self.directory / (name + '.json')

    @contextmanager
    def control_lock(self):
        with (self.directory / 'control.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def systemd_available(self):
        try:
            return subprocess.run(['systemctl', '--user', 'show-environment'], stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, timeout=3).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False

    def unit_info(self, name):
        unit = SERVICES[name][1]
        result = subprocess.run(['systemctl', '--user', 'show', unit, '--property=LoadState',
                                 '--property=WorkingDirectory', '--property=ActiveState', '--property=MainPID'],
                                capture_output=True, text=True, timeout=3)
        info = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if not info or (result.returncode and info.get('LoadState') != 'not-found'):
            raise RuntimeError('无法核验用户服务身份：' + unit)
        if info.get('LoadState') not in (None, 'not-found') and info.get('WorkingDirectory') != str(self.root):
            raise RuntimeError(unit + ' 属于其他目录或缺少目录身份，拒绝接管')
        return info

    def matches(self, name, pid):
        try:
            proc = Path('/proc') / str(pid)
            args = [a.decode() for a in (proc / 'cmdline').read_bytes().split(b'\0') if a]
            script, _, target = SERVICES[name]
            if not args:
                return False
            executable = Path(args[0]).name
            expected = str(self.root / target)
            if args[0] == expected:
                return True
            if executable.startswith('python') and len(args) > 1 and args[1] == expected:
                return True
            if executable in ('bash', 'sh') and len(args) > 2 and args[1] == str(self.root / 'scripts' / script):
                return args[2] in ('--foreground', '--service-child')
            return (name == 'web' and executable == 'node' and
                    (expected in args[1:] or (target in args[1:] and (proc / 'cwd').resolve() == self.root)))
        except (OSError, UnicodeError):
            return False

    def legacy_processes(self, name):
        # Only exact executable/script paths in this project, including old bare
        # processes without a PID file. No ROS/node-name or substring matching.
        return [record for entry in Path('/proc').iterdir() if entry.name.isdigit()
                and self.matches(name, int(entry.name)) and (record := identity(entry.name))]

    def status(self, name):
        desired, state_path = self.paths(name)
        state = read_json(state_path)
        enabled = read_json(desired).get('enabled', False)
        supervisor = state.get('supervisor')
        supervisor_alive = alive(supervisor)
        process_alive = alive(state.get('process'))
        if state.get('backend') == 'systemd-existing':
            supervisor_alive = process_alive
        if enabled and not supervisor_alive:
            phase = 'unmanaged' if self.legacy_processes(name) else 'supervisor-down'
        elif not enabled and not supervisor_alive:
            phase = 'unmanaged' if self.legacy_processes(name) else 'stopped'
        else:
            phase = state.get('state', 'starting')
            if phase == 'running' and not process_alive:
                phase = 'restarting'
        return {**state, 'service': name, 'root': str(self.root), 'enabled': enabled,
                'state': phase, 'supervisorAlive': supervisor_alive, 'processAlive': process_alive,
                'statusFile': str(state_path)}

    def snapshot(self):
        """One atomic file for read-only consumers; no socket/API is required."""
        with (self.directory / 'snapshot.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            atomic_json(self.root / 'logs/scan-services.json', {
                'root': str(self.root), 'updatedAt': time.time(), 'healthScope': 'process',
                'services': {name: self.status(name) for name in SERVICES},
            })

    def start(self, name, arguments=()):
        # This opt-in belongs to the manager, not the ROS launcher's arguments.
        # Every explicit start defaults to read-only; automatic restarts reuse
        # the durable setting regardless of the supervisor's inherited env.
        execution_enabled = '--enable-execution' in arguments
        if execution_enabled and name != 'robot':
            raise RuntimeError('--enable-execution仅支持start robot')
        configuration = {'arguments': [arg for arg in arguments if arg != '--enable-execution']}
        if name == 'robot':
            configuration['executionEnabled'] = execution_enabled
        desired, state_path = self.paths(name)
        with self.control_lock():
            use_systemd = self.systemd_available()
            unit = self.unit_info(name) if use_systemd else {}
            atomic_json(desired, {'enabled': True, **configuration})
            current = read_json(state_path)
            if alive(current.get('supervisor')) and self.supervisor_matches(name, current['supervisor']['pid']):
                return self.status(name)
            if unit.get('ActiveState') in ('active', 'activating', 'reloading'):
                # Already-managed legacy units are retained, never competing with
                # their restart policy. Deploy can stop/start to install our wrapper.
                process = identity(unit.get('MainPID'))
                atomic_json(state_path, {'service': name, 'root': str(self.root), 'backend': 'systemd-existing',
                                        'state': 'running', 'process': process, 'requiresMigration': True,
                                        'migrationReason': '旧unit入口可能递归调用新start脚本；部署需stop all后start.sh',
                                        'updatedAt': time.time()})
                return self.status(name)
            if use_systemd and unit.get('LoadState') not in (None, 'not-found'):
                # Old failed transient units otherwise retain their name and
                # prevent systemd-run from installing the supervised entrypoint.
                if unit.get('ActiveState') == 'failed':
                    subprocess.run(['systemctl', '--user', 'reset-failed', SERVICES[name][1]], check=True, timeout=3)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    unit = self.unit_info(name)
                    if unit.get('LoadState') == 'not-found':
                        break
                    time.sleep(.1)
                if unit.get('LoadState') != 'not-found':
                    raise RuntimeError(SERVICES[name][1] + ' 仍保留旧定义；请先停止并释放旧unit后迁移，未创建竞争服务')
            command = [sys.executable, str(self.root / 'scripts/service_manager.py'), '_supervise', name]
            logfile = self.root / 'logs' / ('web.log' if name == 'web' else name + '-service.log')
            if use_systemd:
                # Explicit start disables systemd's crash-loop rate limit. Our
                # supervisor uses bounded backoff; explicit stop never restarts.
                subprocess.run(['systemd-run', '--user', '--unit=' + SERVICES[name][1], '--collect',
                                '--property=WorkingDirectory=' + str(self.root),
                                '--property=Restart=on-failure', '--property=RestartSec=2',
                                '--property=StartLimitIntervalSec=0', '--property=KillMode=control-group',
                                '--property=KillSignal=SIGINT', '--property=TimeoutStopSec=15',
                                '--property=StandardOutput=append:' + str(logfile),
                                '--property=StandardError=append:' + str(logfile), *command], check=True,
                               stdout=subprocess.DEVNULL, timeout=10)
            else:
                with logfile.open('ab') as output:
                    self.detached[name] = subprocess.Popen(command, cwd=self.root, stdin=subprocess.DEVNULL, stdout=output,
                                                          stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                status = self.status(name)
                if status['supervisorAlive']:
                    return status
                time.sleep(.05)
            raise RuntimeError(name + ' 托管器未启动，请查看 ' + str(logfile))

    def stop(self, name):
        desired, state_path = self.paths(name)
        with self.control_lock():
            # Inspect ownership before making any change. The durable flag closes
            # the exit/restart race, including while a child is in preflight.
            unit = self.unit_info(name) if self.systemd_available() else {}
            atomic_json(desired, {**read_json(desired), 'enabled': False})
            current = read_json(state_path)
            supervisor = current.get('supervisor')
            if unit.get('LoadState') not in (None, 'not-found'):
                subprocess.run(['systemctl', '--user', 'stop', SERVICES[name][1]], check=True, timeout=20)
            elif alive(supervisor):
                if not self.supervisor_matches(name, supervisor['pid']):
                    raise RuntimeError('托管器PID身份不匹配，拒绝停止')
                send(supervisor, signal.SIGTERM)
            # Also handle old bare processes. Exact project paths + start ticks
            # prevent accidentally killing another project's sensor/ROS service.
            legacy = self.legacy_processes(name)
            for record in legacy:
                send(record, signal.SIGINT)
            deadline = time.monotonic() + self.stop_timeout
            while time.monotonic() < deadline:
                if not alive(supervisor) and not any(alive(p) for p in legacy):
                    break
                time.sleep(.05)
            if alive(supervisor) or any(alive(p) for p in legacy):
                raise RuntimeError(name + ' 停止超时；已禁用自动拉起，请检查进程')
            detached = self.detached.pop(name, None)
            if detached is not None:
                detached.wait(timeout=1)
            atomic_json(state_path, {**read_json(state_path), 'service': name, 'root': str(self.root),
                                    'state': 'stopped', 'process': None, 'supervisor': None,
                                    'updatedAt': time.time()})
            return self.status(name)

    def supervisor_matches(self, name, pid):
        try:
            args = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
            return len(args) >= 4 and args[1:4] == [str(self.root / 'scripts/service_manager.py').encode(), b'_supervise', name.encode()]
        except OSError:
            return False

    def supervise(self, name):
        desired, state_path = self.paths(name)
        with (self.directory / (name + '.lock')).open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0
            stopping = False
            def stop_signal(*_):
                nonlocal stopping
                stopping = True
            for sig in (signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, stop_signal)
            state = {'service': name, 'root': str(self.root), 'supervisor': identity(os.getpid()),
                     'backend': 'systemd' if os.environ.get('INVOCATION_ID') else 'subprocess',
                     'restartCount': 0, 'process': None, 'requiresMigration': False,
                     'state': 'starting', 'startedAt': time.time()}
            def publish(**updates):
                state.update(updates)
                state['updatedAt'] = time.time()
                atomic_json(state_path, state)
            def enabled():
                return not stopping and read_json(desired).get('enabled', False)
            def launch_configuration():
                settings = read_json(desired)
                return {'arguments': settings.get('arguments', []),
                        'executionEnabled': name == 'robot' and settings.get('executionEnabled') is True}
            publish()
            child = None
            failures = 0
            try:
                while enabled():
                    configuration = launch_configuration()
                    existing = self.legacy_processes(name)
                    adopted = bool(existing)
                    if existing:
                        process = existing[0]
                        private_group = self.private_group(process)
                    else:
                        script = self.root / 'scripts' / SERVICES[name][0]
                        argument = '--service-child' if name == 'web' else '--foreground'
                        env = os.environ.copy()
                        env['QR_SCAN_READ_ONLY'] = '0' if configuration['executionEnabled'] else '1'
                        # These services solve small matrices: inherited BLAS/OpenMP
                        # thread pools cost more CPU than the numerical work. Only
                        # override the launched service environment, never the host.
                        env['OPENBLAS_NUM_THREADS'] = '1'
                        env['OMP_NUM_THREADS'] = '1'
                        try:
                            child = subprocess.Popen(['/bin/bash', str(script), argument,
                                                      *configuration['arguments']],
                                                     cwd=self.root, env=env, start_new_session=True, close_fds=True)
                        except OSError as error:
                            publish(state='restarting', lastError=str(error), process=None)
                            self.snapshot()
                            self.wait_backoff(enabled, self.restart_delay, self.snapshot)
                            continue
                        process = identity(child.pid)
                    started = time.monotonic()
                    heartbeat = 0.
                    mode = ({'executionEnabled': None if adopted else configuration['executionEnabled']}
                            if name == 'robot' else {})
                    publish(state='running', process=process, adopted=adopted, **mode)
                    self.snapshot()
                    while (enabled() and launch_configuration() == configuration and
                           (alive(process) if adopted else child.poll() is None)):
                        if time.monotonic() - heartbeat >= 2:
                            publish()
                            self.snapshot()
                            heartbeat = time.monotonic()
                        time.sleep(.1)
                    if child is not None:
                        if child.poll() is None:
                            self.cleanup_child(child)
                        else:
                            # The parent may have died by SIGKILL; reclaim only its
                            # private process group before reopening camera/IMU.
                            self.cleanup_group(child.pid)
                        returncode = child.poll()
                        child = None
                    else:
                        returncode = None
                        if private_group:
                            self.cleanup_group(process['pid'])
                        elif not enabled():
                            send(process, signal.SIGINT)
                    if not enabled():
                        break
                    if launch_configuration() != configuration:
                        # Apply an explicit mode/argument change to an existing
                        # supervisor without counting it as a crash or backing off.
                        publish(state='starting', process=None)
                        continue
                    count = state['restartCount'] + 1
                    failures = 1 if time.monotonic() - started >= 30 else failures + 1
                    delay = min(30., self.restart_delay * 2 ** min(failures - 1, 4))
                    publish(state='restarting', process=None, restartCount=count,
                            lastExitCode=returncode, lastExitAt=time.time(), retryInSeconds=delay)
                    self.snapshot()
                    self.wait_backoff(enabled, delay, self.snapshot)
            finally:
                if child is not None:
                    self.cleanup_child(child)
                publish(state='stopped', process=None, supervisor=None)
                self.snapshot()
        return 0

    @staticmethod
    def private_group(record):
        # Adopt a private session only while its known parent identity is alive.
        # Existing terminal/process groups may contain unrelated services.
        if not alive(record):
            return False
        try:
            proc = Path('/proc') / str(record['pid'])
            fields = (proc / 'stat').read_text().rpartition(')')[2].split()
            return (proc.stat().st_uid == os.getuid() and fields[0] != 'Z' and
                    fields[19] == record['startTicks'] and
                    int(fields[2]) == record['pid'] and int(fields[3]) == record['pid'])
        except (OSError, ValueError, IndexError):
            return False

    @staticmethod
    def wait_backoff(enabled, seconds, heartbeat=lambda: None):
        deadline = time.monotonic() + seconds
        last = 0.
        while enabled() and time.monotonic() < deadline:
            if time.monotonic() - last >= 2:
                heartbeat()
                last = time.monotonic()
            time.sleep(.1)

    def cleanup_child(self, child):
        # Each spawned runner owns a new session. Signal its group rather than
        # leaving EKF/camera grandchildren holding the device after parent death.
        self.cleanup_group(child.pid, child)
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass

    @staticmethod
    def cleanup_group(pgid, child=None):
        def group_signal(sig):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                pass
        def live_members():
            for entry in Path('/proc').iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    fields = (entry / 'stat').read_text().rpartition(')')[2].split()
                    if fields[0] != 'Z' and int(fields[2]) == pgid and int(fields[3]) == pgid:
                        return True
                except (OSError, ValueError, IndexError):
                    continue
            return False
        group_signal(signal.SIGINT)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if child is not None:
                child.poll()
            if not live_members():
                return
            time.sleep(.1)
        group_signal(signal.SIGTERM)
        time.sleep(.2)
        group_signal(signal.SIGKILL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'status', '_supervise'])
    parser.add_argument('service', choices=[*SERVICES, 'all'])
    args, extra = parser.parse_known_args()
    if extra and args.action != 'start':
        parser.error('只有start接受传给前台启动器的参数')
    if '--enable-execution' in extra and (args.action != 'start' or args.service != 'robot'):
        parser.error('--enable-execution仅支持start robot')
    if args.action == '_supervise' and args.service == 'all':
        parser.error('_supervise必须指定单个服务')
    manager = ServiceManager()
    names = list(SERVICES) if args.service == 'all' else [args.service]
    if args.action == '_supervise':
        return manager.supervise(args.service)
    if args.action == 'stop':
        names.reverse()
    results = []
    errors = []
    for name in names:
        try:
            if args.action == 'start':
                result = manager.start(name, extra)
            elif args.action == 'stop':
                result = manager.stop(name)
            else:
                result = manager.status(name)
            results.append(result)
        except (RuntimeError, OSError, subprocess.SubprocessError) as error:
            errors.append({'service': name, 'error': str(error)})
    manager.snapshot()
    print(json.dumps({'services': results, 'errors': errors}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
