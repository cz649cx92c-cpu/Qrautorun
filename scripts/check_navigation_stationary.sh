#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$qr_project_root"
set +u
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
source "$qr_project_root/install/setup.bash"
set -u
export ROS_LOG_DIR="$qr_project_root/logs/ros"
exec /usr/bin/python3 "$qr_project_root/scripts/check_navigation_stationary.py" "$@"
