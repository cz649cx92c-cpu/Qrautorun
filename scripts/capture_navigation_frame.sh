#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set +u
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
set -u
exec /usr/bin/python3 "$qr_project_root/scripts/capture_navigation_frame.py"
