#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" != "--foreground" ]]; then
  exec /usr/bin/python3 "$qr_project_root/scripts/service_manager.py" start imu "$@"
fi
shift
exec 9>"$qr_project_root/logs/imu.lock"
if ! flock -n 9; then echo '本工程IMU已经运行'; exit 0; fi
set +u
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
source "$qr_project_root/install/setup.bash"
set -u
export PYTHONDONTWRITEBYTECODE=1
# Existing installed venv provides pyserial; no package installation.
qr_imu_python=/home/orangepi/venvs/py310/bin/python
"$qr_imu_python" -B - <<'CHECK'
import rclpy,time
rclpy.init(args=['--ros-args','--disable-external-lib-logs'])
node=rclpy.create_node('qr_serial_imu_start_check',enable_rosout=False,start_parameter_services=False)
try:
 end=time.monotonic()+1.
 while time.monotonic()<end:rclpy.spin_once(node,timeout_sec=.1)
 if node.count_publishers('/qr/imu/raw'):raise SystemExit('已有新IMU发布者，拒绝重复启动')
finally:node.destroy_node();rclpy.shutdown()
CHECK
exec "$qr_imu_python" -B "$qr_project_root/scripts/run_serial_imu.py" --ros-args --params-file "$qr_project_root/config/imu_only.yaml" --disable-external-lib-logs
