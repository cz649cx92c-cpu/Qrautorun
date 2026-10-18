#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$qr_project_root"
mkdir -p logs
if [[ ! -f web/frontend/dist/index.html ]]; then npm run build; fi
if [[ "${1:-}" == "--service-child" || "${1:-}" == "--foreground" ]]; then
  exec 9>logs/web.lock
  if ! flock -n 9; then echo '地图工作台已经运行'; exit 0; fi
  exec node --import tsx "$qr_project_root/web/backend/src/server.ts"
fi
/usr/bin/python3 "$qr_project_root/scripts/service_manager.py" start web
qr_web_ready=0
for qr_attempt in {1..50}; do
  if curl --noproxy '*' -fsS --max-time 1 http://127.0.0.1:3080/api/health >/dev/null 2>&1; then
    qr_web_ready=1
    break
  fi
  sleep 0.2
done
if [[ "$qr_web_ready" == "0" ]]; then
  echo '网页尚未就绪，托管器会继续恢复，请查看 logs/web.log 或 service_manager.py status all' >&2
  exit 1
fi
# This also runs when Web already exists: a live Web PID is not sensor health.
bash "$qr_project_root/scripts/start_scan_services.sh"
echo '地图工作台与扫描服务已纳入托管：http://localhost:3080；ROS就绪状态请查看网页设备状态'
