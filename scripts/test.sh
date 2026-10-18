#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm run build
npm test
set +u
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
set -u
/usr/bin/python3 tests/test_navigation.py
/usr/bin/python3 tests/test_navigation_qr_coasting.py
/usr/bin/python3 tests/test_fusion.py
/usr/bin/python3 tests/test_mature_initialization.py
/usr/bin/python3 tests/test_can_health.py
/usr/bin/python3 tests/test_node_can_health.py
/usr/bin/python3 tests/test_motion_interface.py
/usr/bin/python3 tests/test_vision.py
/usr/bin/python3 tests/test_correction.py
/usr/bin/python3 tests/test_boards.py
/usr/bin/python3 tests/test_group_bridge.py
/usr/bin/python3 tests/test_draft_capture.py
/usr/bin/python3 tests/test_sensor_status.py
/usr/bin/python3 tests/test_service_manager.py
pdftoppm -r 150 -png logs/print-verification/tags.pdf logs/print-verification/pdf
/usr/bin/python3 scripts/verify_print.py
if [[ "${QR_BROWSER_TEST:-0}" == "1" ]]; then npx playwright test; fi
