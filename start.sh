#!/usr/bin/env bash
# Start QRautorun through its existing service manager.
set -euo pipefail
qr_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$qr_root"
if [[ "${1:-}" == "--check" ]]; then
  bash -n "$qr_root/scripts/start.sh"
  /usr/bin/python3 "$qr_root/scripts/service_manager.py" status all
  exit 0
fi
bash "$qr_root/scripts/start.sh"
/usr/bin/python3 "$qr_root/scripts/service_manager.py" start localization
printf '\nQRautorun started: http://localhost:3080/\n'
printf 'Logs: %s/logs/\n' "$qr_root"
