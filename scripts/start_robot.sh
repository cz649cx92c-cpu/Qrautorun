#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" != "--foreground" ]]; then
  exec /usr/bin/python3 "$qr_project_root/scripts/service_manager.py" start robot "$@"
fi
shift
cd "$qr_project_root"
mkdir -p logs/ros
exec 9>logs/robot.lock
if ! flock -n 9; then echo '本工程温室导航节点已经运行'; exit 0; fi
set +u
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
source "$qr_project_root/install/setup.bash"
set -u
export ROS_LOG_DIR="$qr_project_root/logs/ros"
# The manager consumes --enable-execution and supplies an explicit mode.
# A bare foreground invocation remains read-only.
qr_robot_args=(-p execution_enabled:=false)
if [[ "${QR_SCAN_READ_ONLY:-1}" == "0" ]]; then qr_robot_args=(-p execution_enabled:=true); fi
exec /usr/bin/python3 "$qr_project_root/install/greenhouse_navigation/lib/greenhouse_navigation/navigation" --ros-args --params-file "$qr_project_root/config/navigation.yaml" "${qr_robot_args[@]}"
