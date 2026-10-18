#!/usr/bin/env bash
# 只订阅并记录原底盘/IMU反馈；不发送运动、解锁或模式切换指令。
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$qr_project_root"
qr_record_path="${1:?需要指定本工程测试记录目录}"
if [[ "$qr_record_path" != "$qr_project_root/logs/motion-tests/"*"/rosbag" ]]; then
  echo '记录路径必须位于本工程 logs/motion-tests 下' >&2
  exit 1
fi
set +u
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
source "$qr_project_root/install/setup.bash"
set -u
export ROS_LOG_DIR="$qr_project_root/logs/ros"
exec /opt/ros/humble/bin/ros2 bag record -s sqlite3 --max-cache-size 1048576 \
  -o "$qr_record_path" \
  /chassis_info_fb /odom /odin1/imu /qr/imu/status \
  /qr/camera/status /qr/detector/status /qr/tags/provisional \
  /qr/fusion/status /qr/wheel/odom /ctrl_cmd /steering_ctrl_cmd
