#!/usr/bin/env bash
set -euo pipefail
qr_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" != "--foreground" ]]; then
  exec /usr/bin/python3 "$qr_project_root/scripts/service_manager.py" start localization "$@"
fi
shift
cd "$qr_project_root"
mkdir -p logs/ros
qr_noise_config="$(realpath "${2:-$qr_project_root/config/global_localization.yaml}")"
qr_map_file="$(/usr/bin/python3 - "$qr_noise_config" "${1:-}" <<'PY'
import hashlib,json,sqlite3,sys,yaml
from pathlib import Path
root=Path.cwd()
p=yaml.safe_load(Path(sys.argv[1]).read_text())['qr_global_localization']['ros__parameters']
path=Path(sys.argv[2] or p.get('map_file','')).resolve()
if not path.is_file():raise SystemExit('需要已接纳地图JSON')
m=json.loads(path.read_text());m=m.get('map',m)
if m.get('coordinateStatus')!='reviewed':raise SystemExit('地图未接纳')
if p.get('local_odom_topic')!='/qr/odometry/local':raise SystemExit('必须使用本工程局部融合')
if p.get('publish_tf') is not False:raise SystemExit('当前定位服务不发布TF')
# 静止模式仍保留原始采集质量，核对真实地图版本及接纳证据。
web=json.loads((root/'config/web.json').read_text())
db=sqlite3.connect((root/web['database']).resolve().as_uri()+'?mode=ro',uri=True)
try:
    row=db.execute('SELECT version,body FROM versions WHERE map_id=? ORDER BY version DESC LIMIT 1',(m['id'],)).fetchone()
    if not row or json.loads(row[1])!=m:raise SystemExit('定位文件与当前地图版本不一致')
    proof=db.execute('SELECT digest,body FROM acceptances WHERE map_id=? AND version=?',(m['id'],row[0])).fetchone()
    if not proof or proof[0]!=hashlib.sha256(row[1].encode()).hexdigest():raise SystemExit('地图接纳证据缺失或摘要失效')
    evidence=json.loads(proof[1])
    if m.get('captureQuality')=='draft' and not (evidence.get('kind')=='user_confirmation' and evidence.get('confirm') is True and evidence.get('acceptedVersion')==row[0]):raise SystemExit('草稿地图需要有效用户确认')
finally:db.close()
print(path)
PY
)"
exec 9>logs/localization.lock
if ! flock -n 9;then echo '本工程二维码地图定位已运行';exit 0;fi
set +u
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
source "$qr_project_root/install/setup.bash"
set -u
export ROS_LOG_DIR="$qr_project_root/logs/ros"
/usr/bin/python3 - <<'PY'
import time,rclpy
rclpy.init();n=rclpy.create_node('qr_localization_preflight')
try:
    end=time.monotonic()+1.5
    while time.monotonic()<end:rclpy.spin_once(n,timeout_sec=.1)
    topics=('/qr/localization/pose','/qr/localization/provisional','/qr/localization/static_pose','/qr/localization/status')
    conflicts=[topic for topic in topics if n.count_publishers(topic)]
    if conflicts:raise SystemExit('已有地图定位发布者，拒绝争用：'+','.join(conflicts))
finally:n.destroy_node();rclpy.try_shutdown()
PY
export QR_LOCALIZATION_PID_FILE="$qr_project_root/logs/localization.pid"
exec /usr/bin/python3 "$qr_project_root/install/greenhouse_navigation/lib/greenhouse_navigation/localization" --ros-args --params-file "$qr_noise_config" -p map_file:="$qr_map_file"
