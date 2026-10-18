# Odin 仅 IMU 接入

2026-10-13，按用户要求，仅使用现有 Odin 的原始 IMU，不使用其视觉、RGB、深度、点云、SLAM或视觉里程计。

## 实现与接口

- 新建独立ROS2包 `src/odin_imu_adapter`，复用 `/home/orangepi/ugv/ros2_ws/src/odin_ros_driver` 的SDK ARM静态库和API头文件。
- SDK来源和SHA256记录在`vendor/PROVENANCE.json`，保留原许可证。原Odin工程、CAN驱动和手柄程序未修改。
- 使用 `LIDAR_MODE_RAW`，仅开启 `LIDAR_DT_RAW_IMU`。SDK启动会重新设置流开关，所以启动后再次关闭RGB、DTOF、SLAM点云和里程计流。
- 仅发布 `/odin1/imu`（`sensor_msgs/msg/Imu`）和 `/qr/imu/status`（数据流审计），以及ROS标准日志/参数事件。
- `packetRates`的1/3/4/5/7/8/9为图像、深度和SLAM数据，实测均为零；2为IMU。6是SDK设备状态，10是SDK时钟协议包，均被丢弃，不用于视觉或定位。
- 网页桥从`config/navigation.yaml`订阅`/odin1/imu`，现在网页显示IMU在线。实体执行许可保持false。

## 数据定义

沿用原驱动轴转换：ROS x=SDK y、ROS y=−SDK x、ROS z=SDK z，倍率默认1，配置在`config/imu_only.yaml`。

仅提供加速度和角速度，不计算绝对航向。`orientation_covariance[0]=-1`表示姿态不可用；角速度和加速度协方差全零表示未知。时间戳使用主机接收时间，设备原始时间戳保留在审计消息。

安装外参、单位、零偏、噪声和采样时间对齐仍需现场确认。本次没有启用EKF、全局定位或实车自动行驶。

## 启动、停止、检查

```bash
cd /home/orangepi/ugv/QRautorun/qr_navigation_ws
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
colcon build --packages-select odin_imu_adapter --symlink-install
./scripts/start_imu.sh       # 前台运行，只启动IMU
./scripts/stop_imu.sh        # 另一个终端，仅停止本工程IMU
./scripts/start_robot.sh    # 只读网页桥，不调用原Odin完整导航
export ROS_LOG_DIR=/home/orangepi/ugv/QRautorun/qr_navigation_ws/logs/ros
/usr/bin/python3 scripts/check_imu.py
```

启动通过独占锁和现有驱动/发布者检查避免设备抢占。停止验证进程路径，只停止本工程IMU。原`odinauto.sh`会启动导航并解锁底盘，因此未调用。

## 实际验证

- 新ROS2包编译通过，SDK副本与原文件SHA256一致。
- 连续8秒收到3175帧，约396.73Hz；全部数据为有限值，末帧主机时间戳年龄约2.42ms。
- 图像、深度、SLAM点云、SLAM里程计和扩展数据流实测速率全部为零。
- 无图像、点云、Odin里程计、TF或底盘命令发布者。
- 独立停止后SDK完成清理，PID删除，退出码0；已重新启动恢复采集。
- 实测记录：`logs/imu-only-check.json`。静态检查不替代安装标定和导航验证。

此版SDK在已完成deinit后重复运行进程静态析构会异常终止。新适配器先显式停止采集、清理SDK、删除PID并关闭ROS，再直接退出进程，避免重复析构。没有修改SDK或原驱动。
