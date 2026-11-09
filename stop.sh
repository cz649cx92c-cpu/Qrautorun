#!/usr/bin/env bash
# Stop only QRautorun services using their existing graceful shutdown path.
set -euo pipefail
qr_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$qr_root"
if [[ "${1:-}" == "--check" ]]; then
  bash -n "$qr_root/scripts/stop.sh"
  /usr/bin/python3 "$qr_root/scripts/service_manager.py" status all
  exit 0
fi
bash "$qr_root/scripts/stop.sh"
printf '\nQRautorun stopped. Run the start script to open it again.\n'
