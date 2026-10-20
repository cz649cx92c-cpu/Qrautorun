# 串口IMU资料对照与接入状态
来源：父会话读取用户文件 /opt/hermes/home/imu资料/通信协议/通信协议.xlsx；Pi未直接读该工作簿。
下列行号均为父会话read_file文本行，不是Excel真实行号。
| 文本行 | 内容 | 实现/边界 |
|---|---|---|
| 8–11 | 帧格式 | 7E23，无尾，length含全帧，小端，SUM8从头累加至校验前。 |
| 79 | 默认25Hz | 可设10–100Hz；本轮不改设备配置。 |
| 81–84 | 04/17hex=23 | 9个signed int16，ACCELxyz/GYROxyz/MAGxyz。 |
| 81–84 | ACCEL | raw×16/32767 g，再×9.80665为m/s²，含重力。 |
| 81–84 | GYRO | raw×2000/32767×π/180 rad/s，不套Odin或芯片寄存器比例。 |
| 81–84 | MAG | 比例800/32767，磁单位未写，保留raw，不标Tesla。 |
| 86–90 | 16/15hex=21 | 4个小端float：Q0w/Q1x/Q2y/Q3z。 |
| 92–96 | 26/11hex=17 | 3个float RPY，rad；四元数表头错标。 |
| 98–103 | 32/15hex=21 | 相对开机高度m、温度°C、气压Pa、开机参考Pa；仅10轴，表头错标。 |
| 26–34 | 校准70 | 参数01/5F，reply81/70/01成功；00会清零，本轮不发送。未来工具须默认dry-run及另行静止审批。 |
| 50 | 温度校准 | length07与下标至7矛盾，不使用、不猜帧。 |
芯片边界依据用户提供ICM-42670-P DS000451 rev1摘要，Pi未直接读PDF。
p10：±2000/1000/500/250dps对应16.4/32.8/65.5/131LSB；p11加速度±16/8/4/2g，均是芯片寄存器范围。
不能用1/16.4替换整板串口2000/32767；固件可能已缩放。
p10 noise0.007deg/s/sqrtHz、100Hz RMS0.07deg/s仅typical，不保证当前模块std。
p56芯片可25Hz ODR，但串口25Hz不证明chipODR；p23 AAF/LPF、p58滤波配置未知，不猜不写。
p36封装轴/pin1不能推导PCB/车体轴；p10 30ms、p55 on45ms、p39 off后20ms不保证整板温漂收敛。
设备by-id usb-1a86_USB_Serial-if00-port0→ttyUSB0，115200 8N1。CH340不代表IMU型号。
ROS /qr/imu/raw为真实三轴SI、imu_link、新接收时间；orientation_covariance[0]=-1，不混姿态帧。
13:09真实graph/参数：fusion supervisor、fusion inputs、navigation均订阅新raw；Odin无pub/sub。
这是消费者切源，不能等同整链可用：此前CALIBRATING无imu_input/filtered，不能直接导航。
13:11真实500样本19.9697秒：Y std0.00524266559rad/s略超0.005，其余幅值/加速度/时戳门通过。
同窗口ROS SI反算Y bins为-11×4、-10×199、0×297；反算不是串口重抓。
1LSB约0.0010653rad/s，0/-10跳变约0.010653，不能简单归为均匀1LSB量化；历史hex另为独立时段。
校验/signed/小端/SI一致，不能仅凭此区分振动、固有噪声、预热或固件死区，不判硬件故障。
500样本/5秒/.005/.15及原幅值时效门不变，不暗滤波；来源变化不沿用旧bias。
重力up不证明yaw方向，安装/方向/projection verified保持false。
导航维护execution_enabled=false、maintenance_mode=true，不拉任务队列/拒绝start；磁盘execution原值不改。
人工先固定模块、拍安装轴照片，车辆保持无运动许可，静止约25秒重采；仍超门则比较振动/固定/预热条件。
可安全手持且不牵线时，保持安装朝向/Z朝上，从上看逆时针转模块约30°核投影正号，再固定原位重采500；不能安全操作则只提供照片。
普通只读消费者恢复须另行审批stop robot/start robot；实体许可须再授权、查持久队列及全部安全门，不热set冒充切源。
本轮不恢复运动、不自动verified、不发串口/校准/速度/IO/解锁，不动地图DB/mission/segment。
证据：logs/imu-replacement-calibration-statistics.json、consumer-reload.json；本次测试见workbook-tdd.log。
新现场报告是否生成以真实文件与时间为准，不承诺尚未生成的结果。

现场补充：2026-10-19T13:35:53+0800；新500样本率=24.99Hz；gyro轴std=[0.0, 0.0053442226453371995, 0.0008827552147001364]；融合=CALIBRATING；完整数据流=False；证据logs/imu-replacement-workbook-live.json。维护禁用与方向未验证继续保留。
