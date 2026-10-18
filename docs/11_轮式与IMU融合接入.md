# 现有底盘与 Odin IMU 融合

2026-10-13，已在本机接入真实 `/odom` 与 `/odin1/imu`，运行独立 ROS2 Humble `robot_localization` EKF。未修改原底盘、手柄或 Odin 原工程；未发送实际运动指令。

## 当前实际输出

默认路径：

```text
原底盘 /odom 前后速度 ── 输入协方差/模式/时效检查 ──┐
                                                    ├─ EKF → /qr/fusion/filtered
Odin /odin1/imu ── 静止零偏和重力轴估计 ── 竖直角速度 ─┘
                                                      ↓ 新鲜度与整段轨迹完整性门禁
                                          /qr/odometry/provisional
```

`/qr/odometry/provisional` 为启动时原点下的相对位置、相对朝向和速度，不是温室地图的绝对位姿。当前不能提供绝对北向，也不使用 Odin 的视觉、点云、SLAM 或视觉里程计。

`/qr/fusion/status` 报告数据源、接收次数、时效、校零证据、局部位置、相对朝向和协方差。网页设备状态对应显示“局部已融合 / 待标定”。正式地图位置仍只来自 `/qr/localization/pose`；没有全局定位时不绘制虚构车辆位置。

默认 `source: legacy`，仅用于前进、倒车和静止的只读接入验证。`mappingReady=false`、`lateralSupported=false`。`/qr/odometry/local` 虽有本工程发布端，但当前发布次数为零，未标定输出不会流入二维码采集/全局定位。

## IMU 与运动学处理

- 保留原始 IMU 的主机接收时间戳；不宣称设备与相机已完成硬件时间同步。
- 仅在底盘停放/空挡反馈、全部速度接近零、陀螺变化和加速度波动符合门限时，连续采集至少5秒，再估计三轴陀螺零偏和重力竖直方向。移动、数据间断、倒序及明显振动会重置采样。
- 平地二维运动下，以静止加速度均值确定竖直方向，将校零后的三轴陀螺投影为车体竖直轴角速度。该处理不需要猜测 IMU 水平安装朝向，也没有假装获得完整三轴外参。坡度变化、安装松动和温漂仍需实际检验。
- 不融合缺失的 IMU 姿态四元数，不积分加速度计算位置，不重复融合原 `/odom` 从同一速度累计出的旧位姿与旧角速度。
- 原 `/odom` 协方差全零不代表无误差。纵向速度采用明确的待验证噪声先验；IMU角速度采用静止样本统计方差及保守下限。它们不是实车厘米级精度的证明。
- 默认仅在正常4t4d/静止状态使用 `vy≈0` 运动学约束，较大的横向噪声允许滑移。该项不是从旧 `/odom` 获取了真实横向速度。
- 一旦检测到crab/横移模式，停止转发并使本段融合轨迹失效。传感器超时或时钟回退也使轨迹失效；恢复数据不会自动掩盖丢失的路段，需重新启动并校零。
- EKF关闭TF发布，且其预建TF端点隔离到本工程私有Topic，不争用原有 `odom→base_link`。

## 启动、停止与检查

需要原底盘控制已经独立运行；Odin仅IMU节点使用 `start_imu.sh` 独立启动。融合启动器先检查三个输入Topic各只有一个发布者，并拒绝争用已有的融合发布者。

```bash
cd /home/orangepi/ugv/QRautorun/qr_navigation_ws
./scripts/start_imu.sh        # 若已运行，不重复打开Odin
./scripts/start_fusion.sh     # 前台；保持车辆静止约5秒完成本次校零
./scripts/stop_fusion.sh      # 仅停止本工程融合，不停止原底盘或IMU
```

状态检查在另一个终端运行：

```bash
cd /home/orangepi/ugv/QRautorun/qr_navigation_ws
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
/usr/bin/python3 scripts/check_fusion.py
/usr/bin/python3 tests/test_fusion.py
/usr/bin/python3 tests/test_navigation.py
```

检查脚本只订阅，保存 `logs/fusion-check.json`。启停采用本工程PID、进程路径验证和文件锁；一方子进程退出时 supervisor 仅回收自己的另一方子进程。

## 修改文件

- `src/greenhouse_navigation/greenhouse_navigation/fusion.py`：静止校零、两路输入适配、模式与时效门禁、输出准入。
- `src/greenhouse_navigation/greenhouse_navigation/node.py`：将真实融合状态送入网页。
- `src/greenhouse_navigation/setup.py`、`package.xml`：融合可执行入口及robot_localization依赖。
- `config/fusion_inputs.yaml`、`config/ekf_provisional.yaml`：输入、校零、噪声先验、EKF融合掩码。
- `scripts/start_fusion.sh`、`run_fusion.py`、`stop_fusion.sh`、`check_fusion.py`：独立启停与真实数据检查。
- `tests/test_fusion.py`、`scripts/test.sh`：数学及失效门禁验证。

## 实际验证结果

- `colcon build --packages-select greenhouse_navigation --symlink-install`：通过。
- 10项融合单元检查、7项原导航检查：全部通过。单元输入仅验证算法，不作为车辆实测。
- 最后一次真实只读检查：10秒收到300帧融合输出，30.00Hz；同时收到3960帧投影后的IMU。校零使用1986帧、5.002秒，静止加速度模长9.805m/s²。
- 输出最新帧延迟约33ms（本机ROS消息年龄，非摄像头延迟）；各输入保持新鲜，输出有限值。
- 未标定 `/qr/odometry/local` 输出0帧；底盘命令发布者仍仅为 `official_fwmini_compat_bridge`。
- 完成独立停止/再次启动检查，停止融合没有停止原底盘与IMU。

这些结果证明接入、计算周期和门禁工作，不证明运动距离/停车精度。尚未进行实车运动误差测试。

## 下一步

1. 实测四个轮心位置、轮速与转角方向、倍率和字段独立时效，启用已有 `wheel_odometry`，覆盖前进、倒车与90°横移。
2. 采用 `source: wheels` 和 `/qr/wheel/odom` 替换旧输入；在真实证据支持下确认 `wheel_calibration_verified`、`noise_calibration_verified`、`imu_projection_verified` 后，才允许输出正式 `/qr/odometry/local`。掩码已支持vx/vy，IMU仍仅使用竖直角速度。
3. 接入经过标定与时间同步验证的多码相对位姿，以第一组二维码建立地图基准并持续纠偏。
4. 实测定距前進/倒车/横移、角度和漏码漂移；噪声参数与安全阈值依据实测调整，不直接将verified开关当作验收。

EKF掩码、速度约束与避免重复融合按 [robot_localization 官方说明](https://github.com/cra-ros-pkg/robot_localization/blob/humble-devel/doc/configuring_robot_localization.rst) 实现。
