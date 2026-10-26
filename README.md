# QR 导航控制台

> **当前分支：`v8`**（代码提交 `1aea34f`，2026-10-25）
> 上一版本：`v7`（`700459c`）· 本分支相对 `v7` 的实际差异见下方「v8 改动」
> `main` 分支停留在 v2 代码基线，**不包含**本分支的任何功能。要使用本版本请切到 `v8`。
> 本页内容由一次**仅改 README** 的文档提交更新；分支最新 SHA 见 `git log -1`。

基于 AprilTag 多码定位板的现场扫描建图、正交路线设计与导航控制工程。前端 Vue 3 + TypeScript + Konva，Web 服务 Fastify，导航执行 ROS 2 / Python。

## v9 改动（相对 `v8` / `7d96cac`）— 2026-10-26

v9 **只新增后台诊断旁路**，不改任何控制数学、门限、EKF/IMU/地图/相机参数，不加前端面板或按钮。目的：让 QR 观测质量、融合实际 innovation、控制指令与故障快照可从日志复核，不再靠推断。

### 1. 专用诊断日志（不影响实时控制）
- 新增 `src/greenhouse_navigation/greenhouse_navigation/diag_log.py`：异步有界队列写 JSONL，单文件 20MB 滚动（保留 `.1`），会话总量上限 200MB 后停写并在同目录 `diag-alert.jsonl` 写 `sessionCapReached` 告警；队列满计 `dropped`、IO 失败计 `writeErrors`，**不向控制/视觉回调抛异常**；`QR_DIAG_DISABLE=1` 可整体关闭。
- 输出目录：`logs/diagnostics/measurement-v9/<会话时间>/`，与 9 分钟滚动覆盖的 `navigation.jsonl` 分离；不写数据库、无凭据。

### 2. 逐子码真实重投影 RMS（`vision.py` / `detector.py`）
- 在最优板解上对每个参与子码四角 `projectPoints` 后按 member 分组求 RMS，日志含：板 ID/referenceId、memberIds、逐码 RMS、被拒子码 ID（无投影数据标 `unavailable:noCorrespondence`）、整组 RMS、sigma/angleSigma、采集 stamp/接收时间。
- **不改变 PnP 求解、RANSAC、选解、权重、过滤及发布字典**；逐码 RMS 只进日志。

### 3. 融合 innovation 实际记录（`localization.py`）
- `correction_update` 增加只读 `audit` 参数（原数学逐行不变，单测与参考实现零容差同值）：记录 innovation dx/dy/dyaw、位置/航向/马氏门限、接受或拒绝的具体原因（`positionOver0.2` / `yawOver0.3rad` / `mahalanobisOver11.34` / `nonFiniteInput` / `nonPositiveCovariance`）、gain、后验协方差、实际 delta。
- `observe()` 旁路记录预测/观测/噪声、聚类丢弃数、早返回原因（`invalidMetaOrStale` / `noLocalTimeCoverage` / `noPriorEstimate` / `noQualifiedCandidate` / `consensusFilteredAll`）、mapId/version/epoch。
- **不改变更新行为与门限**；融合位姿不被替换成"独立 QR"。

### 4. 控制侧实况（`node.py` / `segment_execution.py`）
- `chassisFeedback`：15Hz 节流 + 异常帧全记（body/steer gear、四轮 `anglesRaw`、steerAngle、vx、unlock/estop/remote、headerStamp/接收时间）。
- `command`：记录 **mission.tick 输出**的 vx/vy/wz/mode 与同刻反馈快照。
- `modeMismatchDetail`：`move_command` 模式/轮角不匹配分支的故障前快照（gear/四轮角/steering/seq/headerStamp），**fault 触发行为零改动**。

### 5. 前端与 dist
- 前端**无新增面板/按钮/遥测 schema 变更**；本次一并提交 v8 遗留的 0.46 m × 0.36 m 车体图标已构建 dist（`web/frontend/dist/`）。

### 6. 测试与部署
- 新增 `tests/test_diag_log.py`（6/6）、`tests/test_diag_innovation.py`（6/6）、`tests/test_diag_vision_member_rms.py`（4/4）全绿。
- 相关回归：turn_recenter / boundary_centering / dead_reckoning / vision / correction / static_localization / motion_interface 全 OK；`test_segment_execution` 3 个与 `test_existing_chassis_feedback` 3 个失败为改动前基线既有，未修复。
- 部署只重启 vision/localization/robot 三个消费者（保持 executionEnabled）；web/fusion/imu 未动；build 为 symlink-install，未跑 colcon build。

### 7. 明确缺口与已知问题（不夸大）
- **未采集**：最终 send 回执（CAN 层实际帧）与四轮速度字段——当前 `command` 是 tick 输出、`chassisFeedback` 无 wheels；因此"轮速是否反号 / 制动沿程分歧是否复现"仍不足以判定。
- **未根治**：2026-10-26 16:20 第 7 段“底盘模式或轮角反馈不匹配”FAULT 的真实根因未证实；v9 未去抖、未放宽容差、未屏蔽 FAULT，保护保持。
- **已知缺陷（拟在 v10 修复，本次 v9 未修）**：DR 预测链三项——(a) `dr_integrate` 与 jump 门限把 `vy_raw` 当 SI 用（应为 raw×0.1，`chassis_odometry`/`localization` 已按 SI）；(b) `yaw_deg` 实为底盘角速度 deg/s，却被当绝对角做 `yaw_deg-last_yaw_deg` 差分积分；(c) `dr_try_rebase`/`stale` 用融合 pose 的 header stamp 判 QR 新鲜度，QR 缺失时被融合 pose 不断刷新。
- 不声称精度优于 10 mm、不声称合规或替代外部实测；所有 mm 仍是相对规划线/地图的模型量。

## v8 改动（相对 `v7` / `700459c`）

48 个文件，`+3120 / −1871`。下面每一条都能在本分支的提交差异里逐项核对。

### 1. 自用版界面（去掉商业化流程）

QRautorun 是内部自用工具，v8 把商业化流程带来的必填项和大块说明区删掉：

- 删除「实验员 / 用户姓名」字段及其必填校验。
- 扫描记录名、路径名改为自动生成（`扫描-YYYYMMDD-HHmm`、`地图名+新路径`），不再手填。
- 删除顶部五步工作流条、右侧「作业概览」、整个「使用指南」页面。
- 保留：地图 / 路径选择与新建、二维码点位、编辑路径、开始 / 暂停 / 停止、错误提示。

**没有放宽任何底层安全门**，只是把「两步人工确认 + 大段说明」压成一行状态。涉及 `web/frontend/src/App.vue`、`tests/personal-ui-simple.test.ts`。

### 2. 切换地图即生效，删除「启用此地图」按钮

v7 的问题：定位作用域被「这张图的坐标是否已验收」卡死。`POST /api/localization/map` 对 `coordinateStatus=draft` 的地图直接 400，前端 watcher 又要求「已选任务 + accepted」才发请求，于是切到新扫的图后定位仍锚在旧图，界面只能显示「当前定位属于其他地图」并永久卡住。

v8 改为定位作用域跟随「当前选中的 `mapId + mapVersion`」：

- `web/backend/src/server.ts`
  - 新增纯函数 `localizationScopeBlock()` / `localizationScopePhase()`，
    phase 为 `unknown | switching | waiting-anchor | anchored`，导航放行与前端状态共用同一套口径。
  - `POST /api/localization/map` 允许切到 `draft` 地图（保留「小车静止」门），
    返回 `coordinateStatus / reviewed / switched`，审计日志标注「坐标来自扫描：未做人工验收」；
    内容未变时不写文件，避免抖动。
  - 新增 `GET /api/localization/scope`。
  - `/api/navigation/start` 去掉人工 `mapApproval` 门禁，改为对**所有** `routeMode` 校验
    `mapId + mapVersion + poseAvailable`，不匹配返回 423。
- `localization.py`：`reload_map` 接受 `draft` 并清空 history / estimate / covariance / anchor；
  `navigation_ready` 不再依赖 `coordinate_reviewed`（字段保留用于状态展示）。
- `scripts/start_localization.sh`：预检区分是否已验收，未验收仍可启动（否则重启即失去定位）。
- `App.vue`：删除「启用此地图」按钮与手动确认 UI，切图后立即设置作用域并触发既有切图重锚；
  新增「当前地图 · 名称 v版本」状态条；路径只能加载当前 `mapId + mapVersion` 的快照。

旧接口 `/api/maps/confirm`、`/api/maps/accept` 保留兼容，只是前端不再要求点击。

### 3. 相机预览 180° 与时序标定指纹解耦

v7 的问题：`camera_preview.json` 加上 `rotate: 180` 后，时序标定按**整文件 SHA256** 校验，
指纹失配导致 `captureTimestampVerified=false`，「实时标定相机观测」条件永久不 ready。
旋转只影响预览方向，不改变采集时间戳、分辨率或帧率。

v8：

- `timing_calibration.py` 新增采集配置指纹：只纳入影响采集与时序的字段
  （device、vendor/product、分辨率、fps、曝光/采集模式等），
  明确排除 `rotate / hflip / vflip / preview` 等纯显示字段；
  `camera_calibration.json`、`camera_extrinsics.json` 仍按严格整文件校验。
- 旧证据继续走 `legacy-capture-spec` 分支，**不重跑**运动时序标定。
- `scripts/calibrate_motion_timing.py` 写入 `configurationCaptureSha256`。
- `web/backend/src/camera.ts` 新增 `cameraVideoOptions(rotate)`：
  `0 → -c:v copy`，`180 → -vf hflip,vflip`（只允许 0/180，其它角度会改变帧尺寸）。

### 4. 二维码区间执行链路

v7 的区间执行只有「到码停稳 → 确认档位 → 走下一段」。v8 补了起点判定、转向残差、
边界横向对中，以及二维码之间的连续估计。

**4.1 起点门禁**（新增 `start_gate.py`，纯函数、不依赖 ROS）

- 等待**当前地图、当前 epoch** 的新鲜稳定样本（默认 5 个样本、抖动 ≤10 mm / ≤0.5°）；
- 起点偏差按第一段的**沿程 / 横向**分解，而不是欧氏距离——车沿路线方向稍前/稍后但横向居中应当放行；
- 保留原有横向（`max_cross_track_m`）与航向门限；超时（默认 12 s）内无有效定位则明确拒绝。

**4.2 转向残差标定**（新增 `turn_calibration.py`）

只读打开 `calibration.db`（`mode=ro`，运行期绝不写标定库），从有效且方向一致的转向试验里
推导 `acceptance_deg`（默认 ≤2.5°）与 `correction_tolerance_deg`（默认 ≤1.0°）。
反向 / 不匹配 / 无效试验一律排除；无可用分析时回退固定默认值。

**4.3 边界横向对中**（`CENTER_ALIGN / CENTER_MOVE / CENTER_STOP`）

每个二维码停稳后，相对**下一段目标直线**计算有符号 cross-track：

| 条件 | 行为 |
| --- | --- |
| `abs(cross) ≤ 2 cm` | 直接进入下一段 |
| `2 cm < abs(cross) ≤ 5 cm` | 低速、有限 crab 对中，收敛到 ≤2 cm 后停稳再进下一段 |
| `abs(cross) > 5 cm`、方向发散、航向/速度异常、定位质量低、超时或距离窗口耗尽 | 明确 FAULT 停车 |

路线仍是横平竖直，不生成弧线，不把横移伪装成前进；第一段起点偏差不会混进后续区间。
结构记录 `centering.startCrossM / endCrossM / deltaCrossM / direction / command / travelM / durationS / decision`。

**4.4 二维码间 dead-reckoning**

每个直线 `MOVE` 区间建立 DR 状态，用底盘轮速 `vx/vy` 与 IMU `yaw/yaw_rate` 按时间积分，
实时得到预测位姿、预测有符号 cross-track 与航向误差，而不是只在 `END_STOP` 才算偏差。

- 预测横向偏差达到 `dr_correction_trigger_m`（默认 0.008 m）时进入 **DR 来源**的 `CENTER_*`，
  用已有 crab 能力低速有限纠偏；纠偏期间继续积分，否则预测偏差不会随实际横移收敛；
- 纠偏不改变目标里程，不生成弧线，不把横移伪装成前进；
- 二维码重新出现时按 pose stamp 变化调用 `dr_try_rebase()`：
  记录 QR 前最后一个 DR 位姿、QR 绝对位姿、横向/沿程/航向残差、校正前后值；
  只接受**当前地图 + 当前 epoch + 质量合格 + 时间戳有效**的 QR；
  跨地图 / epoch 变化 / sigma 超限 / 低质量 → `skipped_map_or_epoch` / `skipped_low_quality`，
  单帧低质量跳变不会被当成车辆偏移；
- 校正只重置 DR 锚点与误差状态（`pred / anchor_pose / anchor_stamp / anchor_cross`），
  **不瞬移控制位姿**；
- QR 与预测残差连续超硬限（默认 5 cm、连续 3 帧）→ 判定预测发散并 FAULT 停车。

相关参数（`node.py` 默认值，可在 `config/navigation.yaml` 覆盖）：
`dr_correction_enabled`、`dr_cross_target_m=.008`、`dr_correction_trigger_m=.008`、
`dr_correction_limit=2`、`dr_correction_travel_m=.05`、`dr_correction_min_remaining_m=.15`、
`dr_correction_min_stale_s=.25`、`dr_rebase_residual_limit_m=.05`、
`dr_rebase_max_sigma_m=.03`、`dr_divergence_frames=3`。

`0.008 m` 是**控制目标**，不是已达到的实车精度。

**4.5 诊断**

`execution_diagnostics.py` 新增结构化输出 `deadReckoning`
（`active / decision / predictedPose / predictedCrossM / predictedHeadingDeg / staleS /
anchorStamp / crossTrackTargetM / correctionCount / qrCorrectionResidual / corrections`），
继续输出 `centering`、`centeringHistory`、`turnExit`、`localizationJump`。
`web/backend/src/robot.ts` 的 zod schema 同步扩展，**不新增任何用户按钮**。

**4.6 转弯后轮子回正门禁（`TURN_RECENTER`）**

转向到位后**不直接前进**。`segment_execution.py` 的流程是
`TURN` →（yaw 进入容差且车停稳）`TURN_STOP` → `TURN_RECENTER`，在 `TURN_RECENTER` 阶段
**只发零速**，必须同时满足三条才切到 `MOVE`：

- 四轮转角回到直行角（4T4D 目标 0°，crab 段为目标轮角）且在 `angle_tolerance_deg`（默认 ±3°）内；
- 档位匹配：4T4D 要求 body/steering gear ∈ {5,6}，crab 段 ∈ {7,8}；
- 连续 `stable_feedback_samples`（默认 5）帧**新鲜**反馈都成立。

否则保持零速；超过 `mode_timeout_s`（默认 8 s）则结构化 FAULT，绝不在带大转角的情况下下发 `vx`。
诊断写入 `turnExit.recenter`：`status / targetAngleDeg / measuredAngleDeg / angleToleranceDeg / bodyGear / steeringGear / requiredSamples / stableSamples / elapsedS / timeoutS`。
「停稳 + yaw 到位」不等于轮子已回正，这一阶段就是补上这个缺口。

**4.7 历史实车记录（2026-10-22 现场日志，非本轮重跑）**

下面的数字来自当时读取的运行日志，**不是本次提交重跑的结果**，也不构成精度承诺：

- 20:54 的一次运行里边界对中真实触发：cross 由 2.6 cm 收敛到 1.7 cm，该次运行最大 cross 3.52 cm。
- 21:41:10–21:43:01 的一次完整运行：七段全部 4T4D、正常 FINISHED，段间最大横向偏差 15.8 mm；
  该次 5 次 `TURN_RECENTER` 全部以 5/5 稳定样本通过，等待 0.25–1.65 s。
- 二维码校正 / `rebase` 在日志中有记录；但 `qr_track` / rebase 计数**不等于**机械纠偏次数，
  DR 主动纠偏是否单独生效尚未逐次证实。
- 这两次是不同路线，**不能**把上面的差异归因为某一项改动带来的改善。

注意：`logs/navigation*.jsonl` 轮转很快，当前磁盘上只保留最近约十分钟的记录，
上述历史行已不在磁盘上，引用时以当时的读数为准。

### 5. 地图实时车体图标按真实外形绘制

v7 的实时车体直接用 `map.vehicle`（设计占位包络 `length 0.8 m × width 0.4 m`，还带 `margin`），
画出来比实车大一倍左右。

v8 在 `web/shared/model.ts` 新增**显示专用**常量 `vehicleFootprintM = {length:0.46,width:0.36}`，
`MapCanvas.vue` 按该米制尺寸乘世界单位（100 px/m）绘制，随地图缩放一起缩放：

- 没有固定像素下限、没有固定像素膨胀；
- 锚点仍是 `base_link`（矩形以 group 原点为中心），航向取 `yaw`，长轴沿本地 `+x`（前进方向）；
- 航向指示条终点收在车身轮廓内，描边不会把轮廓撑大；
- `map.vehicle` 仍是**规划 / 安全包络**（参与 `validate()` 的行宽余量与退出距离校验），两者故意分开；
  0.46 m 是整车外形长度，**不是轮距 / 轴距**，底盘运动学、定位、IMU、相机均未改动。

### 6. 测试与构建

| 项目 | 结果 | 日期 / 来源 |
| --- | --- | --- |
| `npm test`（`tests/run.ts`） | 208 / 208 通过 | 2026-10-25 本次提交前实测 |
| 新增 `tests/vehicle-icon-size.test.ts` | 7 例 | 2026-10-25 同上 |
| `tsc --noEmit` / `vue-tsc --noEmit` | rc=0 / rc=0 | 2026-10-25 |
| 隔离构建 | CSS 96.28 kB、JS 626.82 kB，Tailwind 工具类齐全 | 2026-10-25 |
| `tests/test_boundary_centering.py` | 11 / 11 | 2026-10-22 |
| `tests/test_dead_reckoning.py` | 11 / 11 | 2026-10-22 |
| `tests/test_timing_calibration.py` | 10 / 10 | 2026-10-22 |
| `tests/test_start_gate.py`、`test_turn_calibration.py`、`test_turn_recenter.py` | 通过 | 2026-10-21～22 |
| `tests/test_office_map_reload.py`（需 ROS 环境） | 2 / 2 | 2026-10-22 |
| Python 全量（历史记录） | 513 passed / 31 既有失败 | 2026-10-22，**非本次重跑** |

说明：

- `npm test` 的 208 项与 Python 全量（513 passed / 31 失败）是**不同测试阶段**，不能相加或互相替代。
- 本版本**不声称全部 Python 测试通过**：既有失败未统一清零，`tests/test_segment_execution.py` 等
  仍保留已知失败（后续核对时数量有变化，这里不再写易过时的精确数字）。
- 上表的 Python 单文件结果只在对应日期成立，本次提交没有重跑。

## 使用入口

| 入口 | 说明 |
| --- | --- |
| `http://<Pi-IP>:3080` | 主控制台；侧栏切换「扫描建图 / 导航 / 摄像头预览 / 定位标定」 |
| `?page=camera` | 直接打开摄像头预览（`?page=navigate` **无效**，只映射 camera/calibration） |
| `GET /api/localization/scope` | 新增，查询目标地图的定位作用域 phase |
| `python3 scripts/service_manager.py start robot --enable-execution` | 显式开启实体执行许可；不带该参数会把它覆盖为 false |

## 已知限制

- **dead-reckoning 主动纠偏未逐次证实**：代码、参数、诊断和单元测试就位，但 2026-10-22 的历史日志里
  没有能把「DR 来源纠偏」与「QR 校正」区分开的独立证据，`correctionCount` / rebase 计数
  不能当作机械纠偏次数。
- **边界对中只在一次运行里真实触发过**：历史日志 2.6 → 1.7 cm、该次最大 cross 3.52 cm；
  没有多次重复验证，也**没有超过 5 cm 的实测样本**。
- **QR rebase 残差只有单元测试 + 历史日志中的校正记录**，没有独立复现的现场样本。
- **Python 测试未统一清零**：历史全量 513 passed / 31 既有失败，本次未修复；详见第 6 节说明。
- 定位精度未标定（`covariance_calibrated=false`），导航依赖用户确认的同步二维码融合定位；
  本仓库不提供任何精度保证或合规认证，也不保证横向偏差 ≤10 mm。
- `web/frontend/dist/` 是 2026-10-22 20:32 的构建产物，**不包含**第 5 节的车体图标改动。

## 安装与启动

```bash
npm ci
./scripts/start.sh                 # 只启动 Web（http://localhost:3080）
./scripts/start.sh --foreground    # 前台调试
./scripts/stop.sh                  # 停止 Web
./scripts/start_robot.sh           # 托管 ROS2 反馈 / 状态机 / Web 桥，默认只读
./scripts/start_robot.sh --enable-execution   # 显式开启实机执行能力；仍需在网页点「开始导航」
./scripts/stop_robot.sh
```

仓库保留前端 `web/frontend/dist/`，修改前端后从**项目根**构建：

```bash
node_modules/.bin/vite build --config web/frontend/vite.config.ts
```

开发验证：`npm test`；浏览器回归 `npx playwright test`（配置见 `tests/browser/*.config.ts`）。

数据库、运行日志、依赖缓存、备份和 `config/bridge.key` 不入库；部署时需自行配置本机密钥。
下面保留既有设备与运行说明。

---

# 温室 AprilTag 作物行导航

独立项目：`/home/orangepi/ugv/QRautorun/qr_navigation_ws`。

当前网页只保留一个现场流程：**贴二维码 → 原手柄遥控走一遍 → 完成扫描并生成地图 → 现场确认 → 按扫描路线导航**。详见[一次扫描后导航](docs/05_一次扫描后导航.md)。不需要先设计地图或逐张配置动作。打印文件与历史数据保留，原底盘、手柄与CAN程序没有修改。

**2026-10-15 已按用户要求开启同步二维码定位的实机导航测试。定位精度尚未实测，保留 `covariance_calibrated=false`，由 `synchronized_navigation_confirmed=true` 表示用户确认使用当前定位进行测试。执行许可通过 `service_manager.py start robot --enable-execution` 显式开启，是否发车由网页“开始导航”决定。**

## 多码定位组 PDF

打印前会检查整批子码归属。若出现“Q049已属于B049”等提示，表示新分组与已登记定位板重叠；点击“使用可用编号”会将表单切换到足够容纳整批的空闲范围，不改已有定位板。预览不占号；同组重打需保持原起始子码编号、阵列规格和尺寸。不同组重复使用同一子码仍返回409，整批失败不会部分登记。

网页“二维码 PDF”选择组内1×1～6×6阵列、整组尺寸和组数，A4每页一整组。一个组对应一个导航节点，部分子码缺失时根据剩余成员恢复组中心；短暂漏检或单帧观测质量下降时依靠轮式里程计与IMU继续更新位置，融合定位过期、估计误差超限或连续漏检超时才停车。详见[多码组导航与整组打印](docs/07_多码组导航与整组打印.md)。

“摄像头预览 → 定位标定”可选择已打印定位板、专用AprilGrid板或黑白棋盘格。6×6专用板单独填写单码黑框尺寸、黑框之间的实际间距、码族和编号排列，不沿用导航PDF的固定间距，也不自动注册为导航地图节点。详见[专用标定板设置](docs/13_专用标定板与6乘6.md)。

## 网页与独立启停

浏览器：`http://192.168.101.212:3080`，同局域网电脑或平板打开。本机可使用 `http://localhost:3080`。设备IP改变时使用当前局域网地址。

“已保存扫描”已改为可搜索的记录管理窗口，显示时间、编号、定位组和帧数，支持打开、删除及删除确认。采集中和已生成地图的原始记录受到保护。详见[扫描记录管理](docs/08_扫描记录管理.md)。

已接通手柄直行扫描的点位草稿：页面增加“保存点位草稿”，使用已有底盘反馈与仅IMU连续定位，保留未验证时戳、定位原点和草稿来源。正式自主导航与横移仍需实测验证；详见[手柄扫描点位草稿](docs/18_手柄扫描点位草稿.md)。

“摄像头预览”已接入HBVCAM真实720P/30 FPS画面，支持十字线、原尺寸查看、全屏和照片。扫描建图开始后自动显示实时画面，可随时切回地图。直接打开 `http://192.168.101.212:3080/?page=camera`。详见[实时摄像头预览](docs/09_实时摄像头预览.md)。

```bash
cd /home/orangepi/ugv/QRautorun/qr_navigation_ws
./scripts/start.sh          # 只启动Web
./scripts/stop.sh           # 只停止Web
./scripts/start_robot.sh    # 托管真实ROS2反馈/状态机/Web桥，默认只读
./scripts/start_robot.sh --enable-execution  # 显式开启实机测试能力；仍需在网页点击开始
./scripts/stop_robot.sh     # 只停止本工程导航节点；也可前台Ctrl+C
```

Web默认在用户级systemd可用时使用 `qr-navigation-web.service` 托管，异常退出后自动重启；没有用户服务管理器时使用后台进程。`./scripts/stop.sh` 会停止本工程托管服务，`./scripts/start.sh --foreground` 保留前台调试方式。日志为 `logs/web.log`，状态可用 `systemctl --user status qr-navigation-web` 查看。当前托管服务为运行期服务，重启设备后执行启动脚本恢复。

本次已启动Web和默认不执行运动的ROS2导航桥。正式版没有自动运动预览。页面位置来自正式 `/qr/localization/pose`，或明确标注的静止二维码地图定位 `/qr/localization/static_pose`。没有有效定位数据时不绘制小车位置。静止定位只用于当前地图显示，不替代运动导航定位条件。底盘速度和四轮原始角度来自实际反馈。

源工程备份：曾放在 `backups/20261009-103717/`（`source-before-greenhouse.tar.gz` 与同目录 SQLite 备份）。
该本地备份已按用户要求于 2026-10-25 清理，源码与历史仍完整保留在 Git 中；原底盘未做任何修改。

## 整批生成与打印

网页左侧 **批量打印**：支持当前地图全部标记、指定ID范围与全部587个编号。默认80mm黑边、A4每页4张，全部码族147页；可直接打开 [全部标记PDF](http://192.168.110.98:3080/api/print/all.pdf)。打印选择A4、单面、全部页面、100%实际大小；先检查50mm标尺再整批打印。

已生成文件在`prints/apriltags-Q000-Q586-80mm-packed.pdf`和同名ZIP。完整包附每个编号SVG及CSV清单，地图模式附JSON快照和铺设图。详见[批量打印说明](docs/04_批量生成与打印.md)。

```bash
node --import tsx scripts/generate_batch_print.ts --start 0 --end 586 --size-mm 80
```

## 历史功能说明（当前网页已收敛为一次示教扫描）

### 先设计温室布局，再铺标记

1. 地图设计设置作物行数量、长度、中心间距、60cm通道、二维码间距/黑边尺寸、首行坐标/方向、整车退出距离和作业顺序。
2. 点击生成，编辑控制点、标记位置/安装角、所属行、入口/行尾/整车退出点与入口外换行区。地图坐标米制，角度逆时针度制。
3. 前进与倒车使用同一中心线，倒车使用反向点序、独立控制器和负速度；横移连接只能在入口外且车体朝向保持不变。
4. 支持自由路线、标记拖动、Shift多选、批量坐标/属性、动作编辑、撤销重做。重新生成某一行标记会替换该行编号/动作，保存与重印不改编号。
5. 校验并保存，SQLite创建版本，支持历史回滚为新版本、并发版本冲突和JSON导入导出。
6. 批量导出PDF、SVG ZIP、CSV铺设清单、SVG铺设图。官方tag36h11，ID 0–586。标记黑色外边界是设定尺寸，带白色静区图案宽为1.25倍。打印100%实际尺寸，测50mm校对尺；安装角度按打印向右的+X相对地图+X逆时针旋转。
7. 在右侧“温室地图实测验收”填写至少3个真实标记坐标和测量人员，标记间最大基线需≥1m、地图误差≤3cm。保存验收证据与地图哈希，不允许导入的reviewed字段替代验收证据。

### 先铺标记，再现场采集

1. 打开“现场采集”，开始记录、停止保存、选择历史记录或继续已有记录。
2. 摄像头最后接入前，记录保持0观测，不生成假数据；可以导入已有真实同步观测JSON。
3. 真实观测必须包含采集时间、局部轮式/IMU位姿和车体系标记相对位姿，并标明标定与同步已完成。使用里程计增量，而不是把首次里程计坐标固定成地图真值。
4. 系统按ID合并，统计次数、已观测/未观测标记；设置已知基准点，运行鲁棒非线性优化，同时估计轨迹和标记位置，报告每个标记次数、残差与整体残差。
5. 两个不同基准点用于世界方向与位置约束；优化仍生成draft，必须实测验收。生成地图草稿后在地图设计中补齐作物行、退出点、安装角与换行区。
6. 每段最大500组同步观测，支持保存中断记录。不是完整大规模SLAM系统，不使用RTK/雷达/点云地图。

真实观测文件结构：

```json
{"samples":[{"stamp":1791514300.0,"pose":{"x":0.0,"y":0.0,"yaw":0.0},"tags":[{"id":0,"x":0.05,"y":0.0,"angle":0.0,"sigma":0.02}],"calibrated":true,"synchronized":true}]}
```

该结构示例仅说明接口，不能当测量记录导入正式地图。yaw/相对angle为弧度，地图tag.angle为度。基准点编辑格式：`[{"id":0,"x":0,"y":0},{"id":1,"x":2,"y":0}]`。

## 正式任务与真实导航

任务编辑保存独立任务：任务标识、地图ID/版本、作业行顺序、前进/倒车/横移速度和行尾等待。标记动作仍只保存在Orange Pi配置中，图案只编码ID。选择任务后加载绑定地图。

导航监控显示真实底盘速度/档位/四轮原始角度、实时定位、IMU与标记状态、导航状态、ROS2安全条件和日志。开始、暂停、继续、停止请求通过Node桥送至ROS2状态机，网页不直接发布电机指令。

状态机已实现IDLE、INITIALIZING、FORWARD、ROW_END、REVERSE、ROW_EXIT、SWITCH_TO_LATERAL、LATERAL_SHIFT、SWITCH_TO_ACKERMANN、NEXT_ROW、FINISHED、FAULT。模式切换要求停稳、新序号反馈连续多样本到位、超时故障；单纯等待时间不会算到位。倒车有单独控制器，横移使用四轮90°及车体横向速度。

动作检查ID、行、方向、状态、实际位置、任务标识和任务内去重。自定义作业请求发布 `/qr/tasks/job_request`，外部作业设备需另接执行者；此处没有虚构农业作业设备接口。

实际执行同时检查：地图验收哈希、任务版本、原控制Topic独占、底盘及时反馈、真实融合位姿与误差、IMU时效、标记漏检超时、通道整车包络、四轮到位、人工接管、急停、看门狗等。当前原兼容桥仍在发布指令，新的自动系统不接管它。没有独立障碍物检测/自动避障。

配置：`config/navigation.yaml`。不要仅把verified标志改成true就当验收完成；这些项需要真实标定与现场记录支持。

## 定位模块

现已将原底盘 `/odom` 前后速度与 Odin `/odin1/imu` 竖直轴角速度接入独立只读EKF。真实输出30Hz，网页显示“局部已融合 / 待标定”。启动 `./scripts/start_fusion.sh`，停止 `./scripts/stop_fusion.sh`；启用时车辆需静止约5秒完成校零。默认输出 `/qr/odometry/provisional`，不会流入正式建图或导航；检测到横移/数据中断会使本段轨迹失效。详见[轮式与IMU融合接入](docs/11_轮式与IMU融合接入.md)。

- 四轮里程计 `greenhouse_navigation.odometry`：独立根据四轮轮速、轮角和实测轮心位置，求body vx、vy、wz，支持负轮速和90°横移；不会采用旧 `/odom` 的vy=0，也不擅改原反馈倍率。
- 局部EKF：已安装ROS2 Humble robot_localization；当前 `config/ekf_provisional.yaml` 与 `config/fusion_inputs.yaml` 融合原底盘反馈的前后、横向速度和校零后的 IMU 角速度；只读适配修正原横向字段单位，现成运动模块不变。完整四轮定位仍需真实标定，原 `config/ekf_local.yaml` 为待验收的全局定位启动流程配置。
- 全局校正 `greenhouse_navigation.localization`：按观测时间插值、补偿检测延迟、地图标记绝对校正、创新门限/多标记异常过滤；输出 `/qr/localization/pose`；默认 `publish_tf=false` 不发布 map→odom。`enable_stationary_anchor=true` 时，真实连续静止且融合就绪可用已登记板中心的接收时戳观测建立地图位姿，输出 `/qr/localization/static_pose` 与状态。噪声/协方差待实测，默认 `covariance_calibrated=false` 不发布可用于运动的正式全局位姿；用户明确要求实机测试时，可由独立的 `synchronized_navigation_confirmed=true` 允许已同步位姿用于导航，状态保留精度未实测及用户确认依据。静止接收时间锚定不会因此变成运动定位。

```bash
# 只在轮式/IMU标定和地图验收完成后使用；没有相机锚定则不会产生全局位姿
./scripts/start_localization.sh 已验收地图.json 实测定位噪声.yaml
```

二维码地图定位由本工程服务托管器管理，复用 `/qr/odometry/local`，不重复创建 EKF 或占用局部融合发布者。启动时只读核对地图最新版本与接纳证据。静止锚定使用 `/qr/tags/provisional`，正式运动路径仍使用 `/qr/tags/observations`。定位噪声文件对应 `qr_global_localization`；默认协方差未标定时只发布全局预览。所有默认wheel角/速度符号与轮心位置为未配置值，未验证不会发布正式里程计。

## 摄像头最后接入

HBVCAM已接入共享实时视频和ROS检测，实测识别B016全部16个子码、持续15Hz；右侧“当前画面”显示组内可见数量。“摄像头预览 → 定位标定”可直接采集多码板照片、计算并独立验证内参、保存实测安装参数。镜头高度预填140mm，近似居中的偏移尚未代替实测。缺少内参/精确外参/图像同步与轮式标定时，只显示识别状态，不生成正式地图定位。详见[二维码位置校正与相机标定](docs/12_二维码位置校正与相机标定.md)。

Odin已按用户要求仅接入IMU：`/odin1/imu`，实测约397Hz，网页显示在线；不启用Odin视觉、点云、SLAM或视觉里程计。独立启停：`./scripts/start_imu.sh` / `./scripts/stop_imu.sh`。详见[Odin仅IMU接入](docs/10_Odin仅IMU接入.md)。

现已复用网页HBVCAM单次采集共享流，没有修改UVC驱动或开启Odin视觉；仍需完成曝光/补光、图像时间戳、相机内参及base_link→camera_optical外参验证。

已准备订阅式AprilTag检测模块：真实Image+CameraInfo、灰度检测、真实尺寸solvePnP、重投影过滤、地面法向过滤、TF安装外参和局部里程计同步。不自行猜测 `/dev/video0`。尺寸不同时可用map_file加载每个ID的实际尺寸，采集模式的默认尺寸由打印配置指定。

标定工具从实拍棋盘照片读取：

```bash
/usr/bin/python3 scripts/calibrate_camera.py 照片目录 --columns 9 --rows 6 --square-m 0.025 --output config/camera_calibration.json
# 相机与TF确认完毕、实际标定验证后再运行；当前不启动
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
source install/setup.bash
ros2 run greenhouse_navigation detector --ros-args --params-file config/camera_last.yaml
```

默认camera_calibration_verified=false。标准CameraInfo与TF应由最后接入的实际相机驱动/标定配置提供，不把示例参数当真实标定。

## 编译与软件质量检查

已删除用户可见的模拟测试功能；开发验证保留编译、单元/API、打印识别和浏览器检查。

```bash
npm ci
npm run build
source /opt/ros/humble/setup.bash
source /home/orangepi/ugv/install/setup.bash
colcon build --packages-select greenhouse_navigation chassis_adapter --symlink-install
./scripts/test.sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/qr-playwright npx playwright test
```

`tests/test_navigation.py`中的数学输入仅供算法单元检查，不进入导航运行系统，不冒充实车测试。现场采集API的单元数据也只保存在内存数据库中。

技术栈：Vue3+TypeScript/Vite/Tailwind、shadcn-vue源码组件模式/reka-ui、Lucide、Konva；Node.js+TypeScript/Fastify/WebSocket/SQLite；ROS2 Humble/rclpy/Python/OpenCV/robot_localization/scipy。

详细新交付文件、测试与待确认硬件项见 `docs/03_温室正式工作台交付.md`。历史第一/第二阶段报告留作检查证据，第二阶段模拟说明不再代表当前运行系统。

开源：官方AprilRobotics tag36h11码本许可证保留于web/assets/tag36h11.c；中文字体NotoSansCJKsc及SIL OFL保留于web/frontend/public/fonts。EKF参数按官方Humble robot_localization说明配置：https://github.com/cra-ros-pkg/robot_localization/blob/humble-devel/params/ekf.yaml。
