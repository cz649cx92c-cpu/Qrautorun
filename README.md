# QR 导航控制台

基于 AprilTag 多码定位板的现场扫描建图、正交路线设计与导航控制工程。前端采用 Vue 3、TypeScript 和 Konva，Web 服务采用 Fastify，导航执行集成 ROS 2/Python。

## 功能

- 手柄示教扫描、地图整理、坐标确认与版本保存。
- 建图后可在地图上设计横平竖直路线，支持吸附、拖动、撤销、测距和任务同步。
- 商业化蓝白控制台、五步工作流、使用指南、统计卡片和高级诊断。
- 多码定位板 SVG/PDF、默认开启的 0.15 mm 中心十字对位线，以及 50 mm 校对尺。
- 相机实时预览、标定和导航运行状态。

## 启动

安装本项目依赖后运行：

```bash
npm ci
./scripts/start.sh
```

访问 `http://localhost:3080`。`scripts/start.sh` 会同时托管扫描相关服务；仅启动 Web 可使用 `./scripts/start.sh --foreground`。首次部署须按下方说明完成设备、ROS 环境及标定配置。仓库保留前端 `web/frontend/dist/`，修改前端后运行 `cd web/frontend && npm run build`。

开发验证：`npm test`；浏览器回归使用 `node_modules/.bin/playwright test --config tests/browser/ui-commercial.config.ts distance.spec.ts route-editor.spec.ts ui-restyle.spec.ts guide.spec.ts`。

## 版本

- **v1**：建图后正交路径编辑器、商业化控制台 UI、五步工作流、使用指南、PDF 中心十字对位线及对应单元/API/浏览器测试。
- **v2**：沿途定位组自动串联与逐码纠正；沿途 10 cm 内且可保持水平/垂直直线的中心成为节点，偏离码橙色标记并跳过，支持自动串码、节点/跳过数徽章和端点自动吸附。Python 运行时校验保持不变。

v2 发布验收：`npm test` 105 项全通过；路径编辑、测距、商业 UI/PDF 与指南 Playwright 共 27 项全通过（含 375px / 760px 窄屏）。

码间段始终为直线，每个串联码都是独立纠正节点。请按正交网格铺设，拐弯或折返处须有定位组。自动串码不会在两个码之间偷偷加入直角换向。长度、采样点数、航向及执行器限制仍有效。

定位板打印文件 `prints/` 当前不足 50 MB，随仓库保留。可用 `node --import tsx scripts/generate_batch_print.ts` 重新生成打印资料。

数据库、运行日志、依赖缓存、备份和 `config/bridge.key` 不入库；部署时需自行配置本机密钥。下面保留既有设备与运行说明。

---

# 温室 AprilTag 作物行导航

独立项目：`/home/orangepi/ugv/QRautorun/qr_navigation_ws`。

当前网页只保留一个现场流程：**贴二维码 → 原手柄遥控走一遍 → 完成扫描并生成地图 → 现场确认 → 按扫描路线导航**。详见[一次扫描后导航](docs/05_一次扫描后导航.md)。不需要先设计地图或逐张配置动作。打印文件与历史数据保留，原底盘、手柄与CAN程序没有修改。

**2026-10-15 已按用户要求开启同步二维码定位的实机导航测试。定位精度尚未实测，保留 `covariance_calibrated=false`，由 `synchronized_navigation_confirmed=true` 表示用户确认使用当前定位进行测试。执行许可通过 `service_manager.py start robot --enable-execution` 显式开启，是否发车由网页“开始导航”决定。**

## 多码定位组 PDF

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

源工程备份：`backups/20261009-103717/source-before-greenhouse.tar.gz` 与同目录SQLite备份；这只备份之前的新系统，不涉及修改原底盘。

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
