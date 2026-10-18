#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
qr_service_root="$(systemctl --user show qr-distance-test.service --property=WorkingDirectory --value 2>/dev/null || true)"
if [[ -z "$qr_service_root" ]]; then
  echo '距离测试记录当前未运行'
  exit 0
fi
if [[ "$qr_service_root" != "$qr_project_root" ]]; then
  echo '记录服务属于其他工程，拒绝停止' >&2
  exit 1
fi
systemctl --user stop qr-distance-test.service
echo '距离测试记录已停止；原手柄、底盘、相机和IMU保持运行'
