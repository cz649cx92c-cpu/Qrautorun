#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Web must already be available for the shared camera runner.
qr_failed=0
for qr_service in imu robot vision fusion draft-capture; do
  qr_service_args=()
  if [[ "$qr_service" == "robot" ]]; then
    # Preserve an explicit permission granted earlier. A fresh installation and
    # unreadable configuration still start in read-only mode.
    qr_execution_mode="$(/usr/bin/python3 - "$qr_project_root/logs/services/robot.desired.json" <<'PY'
import json
import sys
from pathlib import Path
try:
    enabled = json.loads(Path(sys.argv[1]).read_text()).get('executionEnabled') is True
except (OSError, ValueError, AttributeError):
    enabled = False
print('enabled' if enabled else 'read-only')
PY
    )"
    if [[ "$qr_execution_mode" == "enabled" ]]; then
      qr_service_args+=(--enable-execution)
    fi
  fi
  if ! /usr/bin/python3 "$qr_project_root/scripts/service_manager.py" start "$qr_service" "${qr_service_args[@]}"; then
    qr_failed=1
  fi
done
exit "$qr_failed"
