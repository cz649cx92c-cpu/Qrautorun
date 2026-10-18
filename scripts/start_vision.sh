#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" != "--foreground" ]]; then
  exec /usr/bin/python3 "$qr_project_root/scripts/service_manager.py" start vision "$@"
fi
shift
cd "$qr_project_root"
mkdir -p logs/ros
exec 9>logs/vision.lock
if ! flock -n 9; then echo '本工程实时二维码识别已运行';exit 0;fi
set +u
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
source "$qr_project_root/install/setup.bash"
set -u
export ROS_LOG_DIR="$qr_project_root/logs/ros"
export PYTHONPATH="$qr_project_root/python_deps:${PYTHONPATH:-}"
exec /usr/bin/python3 "$qr_project_root/scripts/run_vision.py"
