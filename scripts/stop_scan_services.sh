#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
qr_failed=0
for qr_service in draft-capture fusion vision robot imu; do
  if ! /usr/bin/python3 "$qr_project_root/scripts/service_manager.py" stop "$qr_service"; then
    qr_failed=1
  fi
done
exit "$qr_failed"
