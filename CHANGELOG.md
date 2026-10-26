# 变更记录

## v9 — 2026-10-26

仅新增后台诊断旁路（不改控制数学/门限/EKF/IMU/地图/相机，不加前端面板）。详见 README「v9 改动」与 `logs/diagnostics/measurement-v9/`。

- 新增 `diag_log.py`：异步有界队列 JSONL，20MB 分片/200MB 会话上限 + `diag-alert.jsonl` 告警，队列满与 IO 失败只计数不抛出，`QR_DIAG_DISABLE=1` 可关。
- `vision.py`/`detector.py`：最优解上逐子码四角真实重投影 RMS、memberIds、被拒子码标记、整组 RMS 与 sigma/角度 sigma、采集/接收时间；求解与选解不变。
- `localization.py`：`correction_update` 只读 audit（innovation/门限/接受拒绝原因/gain/后验/delta），`observe()` 记录聚类丢弃与早返回原因；原更新行为与门限不变。
- `node.py`/`segment_execution.py`：`chassisFeedback`（15Hz+异常帧）、`command`（tick 输出）、`modeMismatchDetail`（fault 前快照）；fault 行为零改动。
- 测试新增：test_diag_log 6/6、test_diag_innovation 6/6、test_diag_vision_member_rms 4/4；回归 7 套 OK；既有失败 test_segment_execution 3、test_existing_chassis_feedback 3 未修复。
- 前端无新增面板；一并提交 v8 遗留的 0.46 m × 0.36 m 车体图标已构建 dist。
- 缺口：未采集最终 send 回执/四轮速度；16:20 第 7 段 FAULT 根因未证实（保护未改）。
- 已知问题（拟 v10）：DR 预测链三项——vy_raw 未换 SI、yaw_deg(deg/s)被当角增量、rebase/stale 用融合 pose stamp 判 QR 新鲜度。

## v8 — 2026-10-25

自用版界面、切图即生效、相机预览 180° 与时序标定解耦、二维码区间连续纠偏。详见 `docs/26_v8自用版与二维码间连续纠偏.md`。

- 自用版 UI：删除姓名字段、手填记录名/路径名、顶部流程图、作业概览与使用指南；保留地图/路径/点位/编辑/开始暂停停止。底层安全门一行未放宽。
- 删除「启用此地图」按钮：定位作用域跟随当前选中的 `mapId + mapVersion`，切图即重锚。新增 `GET /api/localization/scope` 与 `localizationScopeBlock/Phase`；`/api/navigation/start` 去掉人工 `mapApproval`，改为对所有 `routeMode` 校验 `mapId + mapVersion + poseAvailable`。旧 `/api/maps/confirm`、`/api/maps/accept` 保留兼容。
- 相机：`camera_preview.json` 支持 `rotate: 0|180`（180 = hflip+vflip，仅影响预览）；时序标定指纹改为只含采集/时间字段（device、分辨率、fps、曝光等），排除 rotate/hflip/vflip/preview，旧证据走 legacy 分支不重跑标定。修复旋转后 `captureTimestampVerified=false` 卡死导航门禁。
- 起点门禁 `start_gate.py`：等待当前地图/epoch 的新鲜稳定样本，起点偏差按第一段沿程/横向分解，保留横向与航向门限，超时明确拒绝。
- 转向残差标定 `turn_calibration.py`：只读 `calibration.db`，推导 `acceptance_deg`(≤2.5°) 与 `correction_tolerance_deg`(≤1.0°)，排除反向/无效试验，无分析时回退默认。
- 边界横向对中 `CENTER_ALIGN/MOVE/STOP`：停稳后相对下一段计算有符号 cross-track，≤2 cm 直接进段、2–5 cm 有限 crab 收敛、>5 cm 或发散/超时/质量差则 FAULT。结构化记录 start/end/delta/direction/travel/duration/decision。
- 二维码间 dead-reckoning：轮速 `vx/vy` + IMU yaw 积分得预测位姿与预测 cross-track，达 8 mm 触发低速有限 crab 提前纠偏；QR 重现时按 stamp 变化做 `dr_try_rebase`，仅接受同图/同 epoch/质量合格/时间戳有效，只重置 DR 锚点不瞬移控制位姿；残差连续超 5 cm 判发散停车。0.008 m 是控制目标，不是已实测精度。
- 诊断：`executionDiagnostics` 新增 `deadReckoning`（predictedPose/predictedCrossM/qrCorrectionResidual/correctionCount 等），`robot.ts` schema 同步；不新增用户按钮。
- 地图实时车体图标改按真实外形 0.46 m × 0.36 m 世界米制尺寸随缩放绘制（新增 `vehicleFootprintM` 显示常量），无固定像素下限/膨胀，保持 base_link 锚点与航向、长轴沿前进方向；`map.vehicle` 仍是规划/安全包络，0.46 m 不是轮距/轴距，底盘运动学未改。
- 测试：`npm test` 208/208；boundary-centering 11/11、dead-reckoning 11/11、timing calibration 10/10、office map reload 2/2；`tsc`/`vue-tsc` rc=0。`tests/test_segment_execution.py` 3 个既有失败（改动前基线同样失败）未修复。
- （v8 历史阶段注记，不代表 v9：当时未实车验证 DR 提前纠偏/>2 cm 边界对中/QR rebase 现场残差；当时 dist 为 20:32 构建产物、不含车体图标改动。v9 已补齐 0.46×0.36 m 车体图标 dist，并以实车 run-173600 复核末段；DR 三项缺陷仍在 v10 修复范围内。）

### v3 十组打印占号提示修复 — 2026-10-19

- 只读确认旧板 B000/B016/B032 连续使用 Q000–Q047，下一板 B049 使用 Q049–Q064。4×4 从0生成十组的步长16正确，但新 B048 会与已登记 B049 重叠；这是实际归属冲突，不是重打幂等失败。
- 将只读占号检查提前到预览计划，明确显示冲突及“使用可用编号”按钮，由用户确认后才修改表单起始号。当前登记状态下十组全新4×4可从Q113开始；不静默重排、不改旧板或地图任务。
- 保留下载时409及事务原子保护，相同码组原规格/尺寸可幂等重打。新增内存API与真实网页隔离回归：十页下载、同批重下、Q049真正冲突、SQL中途失败整批回滚、旧board/地图/任务原行不变及无空闲编号。

### v3 PDF 可见性修复 — 2026-10-19

- 真实网页默认为 2×2、140mm、3组、中心十字开启；组件不读取 localStorage。本轮新浏览器上下文 localStorage 为空，预览与下载参数一致，未将缓存作为根因。
- 浏览器实际点击下载并渲染复现：旧十字全长只有 1.85mm，默认预览约4.70px，180mm规格约3.62–3.78px，肉眼几乎看不清。旧单一4×4 HTTP内容流检查不能证明默认操作流可用。
- 将唯一整组十字沿两条中央白缝延长到8mm，仍为0.15mm黑线；逐子码完整tile（含静区）验证线条外包矩形不相交。奇数阵列无法安全居中，界面直接说明并提示偶数阵列。
- 新增真实3080网页的默认和2/3/4阵列100/140/180mm预览URL、请求响应、点击下载PDF及PNG渲染回归；全部API转发隔离内存HTTP服务，避免生产数据库写入。RED与GREEN证据位于logs/editor-ux-v3-pdf-e2e-red及logs/editor-ux-v3-pdf-e2e。

## v3 — 2026-10-19

- 修复编辑器点击后画布下移：第 8 点起偏离提示 DOM 增长推低画布 53–106 px，scrollTop 和 Konva position 未变化；全局提示出现也会改变工作区起点。改为恒高工具栏、默认关闭属性浮层、绝对定位消息，列表和属性仅一个滚动容器。
- 将原来占约三分之一屏幕的 280px/38dvh 编辑区收为桌面 52px、手机 96px。手机绘制/小手/撤销/保存/退出/属性六按钮均可见，属性开关不改变地图 client 尺寸。
- 编辑模式新增独立 Hand 小手按钮：真实左键拖图、切回绘制保持 pan/zoom/草稿；拖动光标 grab/grabbing 并清理状态。普通滚轮不缩放或串滚，Ctrl/Meta 滚轮和 +/−/适应视图可用。resize/watch 不隐式 fit。
- 移除扫描/导航页顶部五步条和地图版本显示；保留真实地图版本及 409 检查。
- 新增独立持久化 routes、事务/同图重名及跨图冲突保护、服务端单调 updated；新建、更新、另存语义分离。任务携带所选路线快照，导航重新校验区间/rowOrder、基准地图 digest、最新版本和验收。旧任务迁移不改 body/updated。
- 更正打印中心十字：每整组几何中心安全白缝只有一个黑十字，0.15mm；奇数阵列无安全中心空隙时跳过并提示。保留尺寸、50mm 尺、ACTUAL SIZE 和关闭参数兼容。
- 验证包括临时 DB 路线 A/B 隔离、跨图/重名/409/引用删除、旧库非破坏幂等迁移、任务快照及最新地图/验收/disabled 拒绝；机器人替身不连接实车。浏览器四尺寸连续 20 点、Hand 左拖、普通/Ctrl wheel、属性开关、悬浮 409、undo/save 和原 route-editor/distance/ui-restyle/guide 回归。原始数字以 release 日志为准，不复用 v1/v2 测试数字。
- 发布仅允许重启 qr-navigation-web 用户服务；独立读取 3080 index/引用 assets 比对 dist SHA-256、实际 HTTP PDF 渲染、旧地图/任务/验收逻辑摘要及远端 refs。IMU 支线不在本提交范围，不宣称全链切换完成。
