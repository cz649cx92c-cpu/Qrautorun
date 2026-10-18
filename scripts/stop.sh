#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Stop every scan service before Web; stop-all continues after individual errors.
exec /usr/bin/python3 "$qr_project_root/scripts/service_manager.py" stop all
