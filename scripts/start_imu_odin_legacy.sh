#!/usr/bin/env bash
# Explicit manual legacy entry only; never an automatic fallback.
set -euo pipefail
if [[ "${1:-}" != "--explicit-legacy" ]]; then echo '需要明确 --explicit-legacy；禁止自动回退Odin' >&2; exit 2; fi
qr_legacy_root="/home/orangepi/ugv/QRautorun/qr_navigation_ws"
set +u
source /opt/ros/humble/setup.bash
source "$qr_legacy_root/install/setup.bash"
set -u
exec "$qr_legacy_root/install/odin_imu_adapter/lib/odin_imu_adapter/imu_only" --ros-args --params-file "$qr_legacy_root/config/imu_odin_legacy.yaml"
