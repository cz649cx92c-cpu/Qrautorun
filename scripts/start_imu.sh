#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" != "--foreground" ]]; then
  exec /usr/bin/python3 "$qr_project_root/scripts/service_manager.py" start imu "$@"
fi
shift
cd "$qr_project_root"
mkdir -p logs/ros
qr_imu_binary="$qr_project_root/install/odin_imu_adapter/lib/odin_imu_adapter/imu_only"
if [[ ! -x "$qr_imu_binary" ]]; then echo '请先编译：colcon build --packages-select odin_imu_adapter --symlink-install' >&2;exit 1;fi
exec 9>"$qr_project_root/logs/imu.lock"
if ! flock -n 9;then echo '本工程IMU已经运行';exit 0;fi
set +u
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
source "$qr_project_root/install/setup.bash"
set -u
export ROS_LOG_DIR="$qr_project_root/logs/ros"
/usr/bin/python3 - <<'PY'
from pathlib import Path
import rclpy,time
for path in Path('/proc').iterdir():
 if not path.name.isdigit():continue
 try:
  args=(path/'cmdline').read_bytes().split(b'\0')
  if args and Path(args[0].decode()).name=='host_sdk_sample':raise SystemExit('已有Odin完整驱动正在运行，请先由其所属工程停止；本脚本不抢占设备')
 except (OSError,UnicodeError):pass
rclpy.init();node=rclpy.create_node('qr_imu_start_check');end=time.monotonic()+1
while time.monotonic()<end:rclpy.spin_once(node,timeout_sec=.1)
publishers=node.count_publishers('/odin1/imu');node.destroy_node();rclpy.shutdown()
if publishers:raise SystemExit('已有/odin1/imu发布者，请复用现有数据，不重复打开设备')
PY
exec "$qr_imu_binary" --ros-args --params-file "$qr_project_root/config/imu_only.yaml"
