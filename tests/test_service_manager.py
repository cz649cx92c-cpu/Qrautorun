"""Isolated supervisor regression tests: only synthetic processes under /tmp."""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('service_manager', SOURCE / 'scripts/service_manager.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FallbackManager(module.ServiceManager):
    def systemd_available(self):
        return False


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='qr-supervisor-test-')
        self.root = Path(self.temporary.name)
        (self.root / 'scripts').mkdir()
        (self.root / 'logs').mkdir()
        shutil.copy(SOURCE / 'scripts/service_manager.py', self.root / 'scripts/service_manager.py')
        for name, (launcher, _, target) in module.SERVICES.items():
            target_path = self.root / target
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_text(f'''import os, signal, subprocess, sys, time
from pathlib import Path
root = Path({str(self.root)!r})
name = {name!r}
for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, lambda *_: sys.exit(0))
import json
(root / (name + '.' + str(os.getpid()) + '.environment.json')).write_text(json.dumps({{
    'readOnly': os.environ.get('QR_SCAN_READ_ONLY'),
    'openblas': os.environ.get('OPENBLAS_NUM_THREADS'),
    'omp': os.environ.get('OMP_NUM_THREADS'),
    'arguments': sys.argv[1:],
}}))
with (root / (name + '.launches')).open('a') as output:
    output.write(str(os.getpid()) + ':' + os.environ.get('QR_SCAN_READ_ONLY', '') + '\\n')
count = len((root / (name + '.launches')).read_text().splitlines())
modefile = root / (name + '.mode')
mode = modefile.read_text() if modefile.exists() else ''
if mode == 'always-crash' or (mode == 'crash-once' and count == 1): sys.exit(42)
if mode == 'exit-once' and count == 1: sys.exit(0)
if mode == 'grandchild':
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
    (root / (name + '.grandchild')).write_text(str(child.pid))
while True: time.sleep(.05)
''')
            (self.root / 'scripts' / launcher).write_text(f'''#!/bin/bash
set -euo pipefail
exec 9>{str(self.root / 'logs' / (name + '.lock'))!r}
flock -n 9 || exit 0
exec /usr/bin/python3 {str(target_path)!r} "$@"
''')
        self.manager = FallbackManager(self.root)
        self.environment = patch.dict(os.environ, {'QR_SERVICE_RESTART_SEC': '.2'})
        self.environment.start()
        self.manager.restart_delay = .2
        self.extra_processes = []

    def tearDown(self):
        for name in module.SERVICES:
            self.manager.stop(name)
        for process in self.extra_processes:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=3)
        self.environment.stop()
        self.temporary.cleanup()

    def wait_for(self, condition, timeout=6):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(.04)
        self.fail('Timed out; states: ' + repr({n: self.manager.status(n) for n in module.SERVICES}))

    def launches(self, name):
        path = self.root / (name + '.launches')
        return path.read_text().splitlines() if path.exists() else []

    def launch_environment(self, name, index=-1):
        pid = self.launches(name)[index].split(':')[0]
        return module.read_json(self.root / (name + '.' + pid + '.environment.json'))

    def start_ready(self, name='vision', arguments=()):
        self.manager.start(name, arguments)
        self.wait_for(lambda: len(self.launches(name)) >= 1 and self.manager.status(name)['processAlive'])
        return self.manager.status(name)

    def test_abnormal_and_clean_exit_both_restart(self):
        for mode in ('crash-once', 'exit-once'):
            with self.subTest(mode=mode):
                (self.root / 'vision.mode').write_text(mode)
                self.manager.start('vision')
                self.wait_for(lambda: len(self.launches('vision')) == 2)
                status = self.manager.status('vision')
                self.assertEqual(status['restartCount'], 1)
                self.assertEqual(status['lastExitCode'], 42 if mode == 'crash-once' else 0)
                self.manager.stop('vision')
                (self.root / 'vision.launches').unlink()

    def test_sigkill_of_service_is_recovered(self):
        before = self.start_ready()
        os.kill(before['process']['pid'], signal.SIGKILL)
        self.wait_for(lambda: len(self.launches('vision')) == 2)
        after = self.manager.status('vision')
        self.assertNotEqual(before['process'], after['process'])
        self.assertTrue(after['supervisorAlive'])

    def test_stop_disables_restart_in_running_and_backoff_states(self):
        for mode in ('', 'always-crash'):
            with self.subTest(mode=mode):
                (self.root / 'vision.mode').write_text(mode)
                self.manager.start('vision')
                self.wait_for(lambda: bool(self.launches('vision')))
                if mode:
                    self.wait_for(lambda: self.manager.status('vision')['state'] == 'restarting')
                self.manager.stop('vision')
                count = len(self.launches('vision'))
                time.sleep(.5)
                self.assertEqual(len(self.launches('vision')), count)
                self.assertEqual(self.manager.status('vision')['state'], 'stopped')
                self.assertFalse(self.manager.status('vision')['enabled'])
                (self.root / 'vision.launches').unlink()

    def test_concurrent_start_has_one_supervisor_and_one_runner(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.manager.start('imu'), range(4)))
        self.wait_for(lambda: bool(self.launches('imu')))
        self.assertEqual(len({r['supervisor']['pid'] for r in results}), 1)
        self.assertEqual(len(self.launches('imu')), 1)

    def test_adopts_existing_bare_process_without_duplicate(self):
        script = self.root / 'scripts/run_vision.py'
        process = subprocess.Popen(['/usr/bin/python3', str(script)], start_new_session=True)
        self.extra_processes.append(process)
        self.wait_for(lambda: bool(self.launches('vision')))
        state = self.manager.start('vision')
        self.wait_for(lambda: self.manager.status('vision').get('adopted'))
        self.assertEqual(self.manager.status('vision')['process']['pid'], process.pid)
        self.assertEqual(len(self.launches('vision')), 1)
        os.kill(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
        self.wait_for(lambda: len(self.launches('vision')) == 2)
        self.assertEqual(self.manager.status('vision')['supervisor'], state['supervisor'])

    def test_stale_pid_from_other_project_is_never_signalled(self):
        process = subprocess.Popen(['/usr/bin/python3', '-c', 'import time; time.sleep(120)'])
        self.extra_processes.append(process)
        (self.root / 'logs/vision.pid').write_text(str(process.pid))
        self.manager.stop('vision')
        self.assertIsNone(process.poll())
        before = module.identity(process.pid)
        self.assertFalse(module.alive({**before, 'startTicks': '0'}))

    def test_filename_argument_does_not_make_foreign_process_owned(self):
        process = subprocess.Popen(['/usr/bin/python3', '-c', 'import time; time.sleep(120)',
                                    str(self.root / 'scripts/run_vision.py')])
        self.extra_processes.append(process)
        self.assertFalse(self.manager.matches('vision', process.pid))
        self.manager.stop('vision')
        self.assertIsNone(process.poll())

    def test_private_group_requires_known_parent_start_time(self):
        process = subprocess.Popen(['/usr/bin/python3', '-c', 'import time; time.sleep(120)'], start_new_session=True)
        self.extra_processes.append(process)
        record = module.identity(process.pid)
        self.assertTrue(self.manager.private_group(record))
        self.assertFalse(self.manager.private_group({**record, 'startTicks': '0'}))
        self.assertFalse(self.manager.private_group(module.identity(os.getpid())))

    def test_runner_children_reclaimed_after_parent_crash(self):
        (self.root / 'vision.mode').write_text('grandchild')
        before = self.start_ready()
        self.wait_for(lambda: (self.root / 'vision.grandchild').exists())
        grandchild = module.identity(int((self.root / 'vision.grandchild').read_text()))
        os.kill(before['process']['pid'], signal.SIGKILL)
        self.wait_for(lambda: len(self.launches('vision')) == 2)
        self.assertFalse(module.alive(grandchild))

    def test_aggregate_state_is_written_and_refreshed(self):
        self.start_ready()
        snapshot = self.root / 'logs/scan-services.json'
        self.wait_for(lambda: module.read_json(snapshot).get('services', {}).get('vision', {}).get('processAlive'))
        first = module.read_json(snapshot)['updatedAt']
        self.wait_for(lambda: module.read_json(snapshot).get('updatedAt', 0) > first)
        self.manager.stop('vision')
        self.manager.snapshot()
        self.assertEqual(module.read_json(snapshot)['services']['vision']['state'], 'stopped')

    def test_robot_defaults_to_read_only_despite_parent_execution_environment(self):
        with patch.dict(os.environ, {'QR_SCAN_READ_ONLY': '0'}):
            self.start_ready('robot')
            self.assertEqual(self.launch_environment('robot')['readOnly'], '1')
            self.assertFalse(module.read_json(self.manager.paths('robot')[0])['executionEnabled'])
            self.assertFalse(self.manager.status('robot')['executionEnabled'])
            self.assertEqual(os.environ['QR_SCAN_READ_ONLY'], '0')

    def test_robot_execution_survives_supervisor_and_child_restarts(self):
        with patch.dict(os.environ, {'QR_SCAN_READ_ONLY': '1'}):
            before = self.start_ready('robot', ['--enable-execution', '--fixture-argument'])
            settings = module.read_json(self.manager.paths('robot')[0])
            self.assertTrue(settings['executionEnabled'])
            self.assertEqual(settings['arguments'], ['--fixture-argument'])
            self.assertEqual(self.launch_environment('robot')['readOnly'], '0')
            self.assertEqual(self.launch_environment('robot')['arguments'],
                             ['--foreground', '--fixture-argument'])
            # Restart the isolated supervisor without issuing another start:
            # its launch mode must come from disk, not flags or the parent env.
            supervisor = self.manager.detached.pop('robot')
            supervisor.terminate()
            supervisor.wait(timeout=5)
            self.assertTrue(module.read_json(self.manager.paths('robot')[0])['enabled'])
            process = subprocess.Popen(['/usr/bin/python3', str(self.root / 'scripts/service_manager.py'),
                                        '_supervise', 'robot'], cwd=self.root, start_new_session=True)
            self.extra_processes.append(process)
            self.wait_for(lambda: len(self.launches('robot')) == 2 and
                          self.manager.status('robot')['processAlive'])
            after = self.manager.status('robot')
            self.assertNotEqual(before['supervisor'], after['supervisor'])
            self.assertTrue(after['executionEnabled'])
            self.assertEqual(self.launch_environment('robot')['readOnly'], '0')
            os.kill(after['process']['pid'], signal.SIGKILL)
            self.wait_for(lambda: len(self.launches('robot')) == 3 and
                          self.manager.status('robot')['processAlive'])
            self.assertEqual(self.launch_environment('robot')['readOnly'], '0')
            self.assertEqual(os.environ['QR_SCAN_READ_ONLY'], '1')

    def test_explicit_start_applies_mode_change_to_running_robot(self):
        before = self.start_ready('robot')
        self.manager.start('robot', ['--enable-execution'])
        self.wait_for(lambda: len(self.launches('robot')) == 2 and
                      self.manager.status('robot').get('executionEnabled') is True)
        self.assertEqual(self.launch_environment('robot')['readOnly'], '0')
        # Omitting the opt-in on a new explicit start resets to the safe default.
        self.manager.start('robot')
        self.wait_for(lambda: len(self.launches('robot')) == 3 and
                      self.manager.status('robot').get('executionEnabled') is False)
        self.assertEqual(self.launch_environment('robot')['readOnly'], '1')
        self.assertEqual(self.manager.status('robot')['supervisor'], before['supervisor'])
        self.assertEqual(self.manager.status('robot')['restartCount'], 0)

    def test_old_robot_desired_file_defaults_to_read_only(self):
        with patch.dict(os.environ, {'QR_SCAN_READ_ONLY': '0'}):
            # State written by older managers has no explicit execution mode.
            module.atomic_json(self.manager.paths('robot')[0], {'enabled': True, 'arguments': []})
            process = subprocess.Popen(['/usr/bin/python3', str(self.root / 'scripts/service_manager.py'),
                                        '_supervise', 'robot'], cwd=self.root, start_new_session=True)
            self.extra_processes.append(process)
            self.wait_for(lambda: bool(self.launches('robot')))
            self.assertEqual(self.launch_environment('robot')['readOnly'], '1')

    def test_stop_retains_mode_but_new_start_requires_explicit_opt_in(self):
        self.start_ready('robot', ['--enable-execution'])
        self.manager.stop('robot')
        settings = module.read_json(self.manager.paths('robot')[0])
        self.assertFalse(settings['enabled'])
        self.assertTrue(settings['executionEnabled'])
        with patch.dict(os.environ, {'QR_SCAN_READ_ONLY': '0'}):
            self.manager.start('robot')
            self.wait_for(lambda: len(self.launches('robot')) == 2)
            self.assertEqual(self.launch_environment('robot')['readOnly'], '1')

    def test_execution_opt_in_is_only_accepted_for_robot(self):
        with self.assertRaisesRegex(RuntimeError, 'start robot'):
            self.manager.start('vision', ['--enable-execution'])
        self.assertFalse(self.manager.paths('vision')[0].exists())
        result = subprocess.run(['/usr/bin/python3', str(self.root / 'scripts/service_manager.py'),
                                 'start', 'all', '--enable-execution'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('start robot', result.stderr)
        self.assertFalse(any(self.manager.paths(name)[0].exists() for name in module.SERVICES))

    def test_service_children_override_blas_threads_without_changing_parent(self):
        with patch.dict(os.environ, {'OPENBLAS_NUM_THREADS': '8', 'OMP_NUM_THREADS': '16'}):
            for name in module.SERVICES:
                with self.subTest(service=name):
                    self.start_ready(name)
                    environment = self.launch_environment(name)
                    self.assertEqual(environment['openblas'], '1')
                    self.assertEqual(environment['omp'], '1')
            self.assertEqual(os.environ['OPENBLAS_NUM_THREADS'], '8')
            self.assertEqual(os.environ['OMP_NUM_THREADS'], '16')

    def test_rejects_foreign_systemd_working_directory(self):
        result = subprocess.CompletedProcess([], 0, stdout='LoadState=loaded\nWorkingDirectory=/other-project\nActiveState=active\nMainPID=123\n')
        with patch.object(module.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, '其他目录'):
                self.manager.unit_info('imu')
        self.assertFalse(self.manager.paths('imu')[0].exists())

    def test_existing_systemd_unit_is_retained_and_stop_disables_it(self):
        process = subprocess.Popen(['/usr/bin/python3', '-c', 'import time; time.sleep(120)'])
        self.extra_processes.append(process)
        self.manager.systemd_available = lambda: True
        self.manager.unit_info = lambda _: {'LoadState': 'loaded', 'ActiveState': 'active', 'MainPID': str(process.pid)}
        with patch.object(module.subprocess, 'run') as run:
            state = self.manager.start('robot')
            self.assertEqual(state['backend'], 'systemd-existing')
            self.assertTrue(state['requiresMigration'])
            run.assert_not_called()
        def stop_unit(command, **kwargs):
            self.assertEqual(command, ['systemctl', '--user', 'stop', 'qr-navigation-bridge.service'])
            self.assertFalse(module.read_json(self.manager.paths('robot')[0])['enabled'])
            process.terminate()
            process.wait(timeout=3)
        with patch.object(module.subprocess, 'run', side_effect=stop_unit):
            self.assertEqual(self.manager.stop('robot')['state'], 'stopped')
        self.manager = FallbackManager(self.root)

    def test_failed_transient_unit_is_released_before_new_systemd_run(self):
        self.manager.systemd_available = lambda: True
        information = iter([{'LoadState': 'loaded', 'ActiveState': 'failed'}, {'LoadState': 'not-found'}])
        self.manager.unit_info = lambda _: next(information)
        self.manager.status = lambda name: {'service': name, 'supervisorAlive': True}
        calls = []
        with patch.object(module.subprocess, 'run', side_effect=lambda command, **kw: calls.append(command)):
            self.manager.start('fusion')
        self.assertEqual(calls[0], ['systemctl', '--user', 'reset-failed', 'qr-navigation-fusion.service'])
        self.assertEqual(calls[1][0], 'systemd-run')
        self.manager = FallbackManager(self.root)

    def test_systemd_launch_has_restart_and_group_cleanup_properties(self):
        calls = []
        self.manager.systemd_available = lambda: True
        self.manager.unit_info = lambda _: {'LoadState': 'not-found'}
        self.manager.status = lambda name: {'service': name, 'supervisorAlive': True}
        with patch.object(module.subprocess, 'run', side_effect=lambda args, **kw: calls.append(args)):
            self.manager.start('fusion')
        command = calls[0]
        self.assertIn('--property=Restart=on-failure', command)
        self.assertIn('--property=KillMode=control-group', command)
        self.assertIn('--property=StartLimitIntervalSec=0', command)
        self.assertIn('_supervise', command)
        # Restore teardown's safe manager; no real systemd command ever ran.
        self.manager = FallbackManager(self.root)

    def test_existing_web_does_not_skip_scan_start_and_foreground_is_leaf(self):
        shutil.copy(SOURCE / 'scripts/start.sh', self.root / 'scripts/start.sh')
        shutil.copy(SOURCE / 'scripts/start_scan_services.sh', self.root / 'scripts/start_scan_services.sh')
        (self.root / 'web/frontend/dist').mkdir(parents=True)
        (self.root / 'web/frontend/dist/index.html').write_text('fixture')
        # Record commands in a stub, so this script integration test cannot touch
        # any actual service or ROS environment.
        (self.root / 'scripts/service_manager.py').write_text('''import sys
from pathlib import Path
p = Path(__file__).resolve().parents[1] / 'calls'
with p.open('a') as out: out.write(' '.join(sys.argv[1:]) + '\\n')
''')
        fake_bin = self.root / 'bin'
        fake_bin.mkdir()
        for name, code in {'curl': 'exit 0', 'node': 'exit 0'}.items():
            path = fake_bin / name
            path.write_text('#!/bin/bash\n' + code + '\n')
            path.chmod(0o755)
        (self.root / 'logs/web.pid').write_text(str(os.getpid()))
        env = {**os.environ, 'PATH': str(fake_bin) + ':' + os.environ['PATH']}
        subprocess.run(['bash', str(self.root / 'scripts/start.sh')], env=env, check=True, capture_output=True)
        self.assertEqual((self.root / 'calls').read_text().splitlines(),
                         ['start web', 'start imu', 'start robot', 'start vision', 'start fusion', 'start draft-capture'])
        (self.root / 'calls').unlink()
        subprocess.run(['bash', str(self.root / 'scripts/start.sh'), '--foreground'], env=env, check=True, capture_output=True)
        self.assertFalse((self.root / 'calls').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
