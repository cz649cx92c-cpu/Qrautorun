#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$qr_project_root"

for qr_service in web imu vision fusion localization draft-capture; do
  /usr/bin/python3 scripts/service_manager.py start "$qr_service"
done
# The user explicitly enabled physical navigation. Startup restores permission,
# while the navigation state machine still starts IDLE with no queued mission.
/usr/bin/python3 scripts/service_manager.py start robot --enable-execution

/usr/bin/python3 - <<'PY'
import json
import subprocess
import time
from urllib.request import ProxyHandler, build_opener

opener = build_opener(ProxyHandler({}))
deadline = time.monotonic() + 35
last = {}
while time.monotonic() < deadline:
    result = subprocess.run(
        ['/usr/bin/python3', 'scripts/service_manager.py', 'status', 'all'],
        capture_output=True, text=True, timeout=8, check=True,
    )
    services = json.loads(result.stdout)['services']
    try:
        with opener.open('http://127.0.0.1:3080/api/robot/status', timeout=2) as response:
            last = json.load(response)
    except OSError:
        last = {}
    if all(service.get('processAlive') for service in services) and last.get('connected'):
        print(json.dumps({
            'servicesRunning': len(services),
            'bridgeConnected': True,
            'executionEnabled': next(
                (condition['ready'] for condition in last.get('conditions', [])
                 if condition['id'] == 'execution'), False),
            'state': last.get('state'),
        }))
        break
    time.sleep(1)
else:
    raise SystemExit('Service startup incomplete; inspect logs/*-service.log')
PY
