#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" != "--foreground" ]]; then
  exec /usr/bin/python3 "$qr_project_root/scripts/service_manager.py" start draft-capture "$@"
fi
shift
mkdir -p "$qr_project_root/logs/ros"
exec 9>"$qr_project_root/logs/draft-capture.lock"
if ! flock -n 9; then echo '草稿采集已运行'; exit 0; fi
set +u
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
source "$qr_project_root/install/setup.bash"
set -u
export ROS_LOG_DIR="$qr_project_root/logs/ros"
exec /usr/bin/python3 "$qr_project_root/install/greenhouse_navigation/lib/greenhouse_navigation/draft_capture"
