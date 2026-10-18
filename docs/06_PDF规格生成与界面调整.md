# 二维码PDF规格生成与界面调整（历史）

此记录将规格误解为每页排版；当前已按用户纠正改为组内多码阵列，整组尺寸和导航支持以[多码组记录](07_多码组导航与整组打印.md)为准。

2026-10-13。按用户要求由两个智能体分别完成前端及后端，主代理整合、检查及部署。

网页：`http://192.168.110.98:3080`。左侧点击“二维码 PDF”。

## 功能

- 每页规格：1×1、2×2、3×3、4×4，对应每页1、4、9、16张。
- 自由调整每张标记的黑色外边界尺寸（毫米），保留完整白色静区。
- 设置生成数量和起始编号，编号不重复，ID范围0–586。
- 预览第一页，显示编号范围、每页数量及A4总页数。
- 点击“生成并下载 PDF”，只下载PDF，不产生ZIP，不要求先设计地图。
- 默认2×2、70mm黑边、16张、从Q000开始，共4页。
- 格子规格切换时，过大尺寸自动调整到该规格上限；手动输入超限值会明确报错，PDF不偷偷缩放。
- PDF编号在白色静区之外，编号字号4mm，尺寸标注2.5mm，每页附50mm标尺。

|每页规格|最大黑边尺寸|
|---|---:|
|1×1|148.8mm|
|2×2|72.8mm|
|3×3|47.466mm（页面以0.1mm步进）|
|4×4|34.8mm|

A4可用区190×252mm，每格预留图案静区与编号区域。打印选择A4、100%实际大小，关闭打印机额外的多页合一。先确认50mm标尺及黑边尺寸再批量打印。

标记仍采用导航使用的AprilTag tag36h11，图案仅编码ID，不保存控制命令。

## 界面

按钮、标签、输入框和状态为16px，页面标题28px，导航入口18px。按钮48px高，地图编号16px。已删除介绍、流程简述、帮助段落及多余说明，仅保留操作、参数、状态和错误。浏览器检查覆盖1440、1024、768及390px宽度。

## 修改文件

- `web/frontend/src/App.vue`：大字号简洁界面及新增入口。
- `web/frontend/src/components/PdfGenerator.vue`：独立PDF设置/预览/下载。
- `web/frontend/src/style.css`、`components/ui/Button.vue`：字体、点击尺寸及排版。
- `web/frontend/src/components/MapCanvas.vue`：地图字号，去掉使用说明。
- `web/backend/src/tags.ts`、`batch-print.ts`、`server.ts`：固定格子物理排版、规格上限、PDF导出接口。
- `tests/batch-print.test.ts`、`browser.spec.ts`：尺寸、数量、ID边界和真实浏览器PDF下载验证。

## 验证

- TypeScript/Vue生产构建。
- 10项领域/API检查，包括尺寸超限、编号越界拒绝和最后一页余量。
- PDF浏览器操作、下载扩展名、规格限制、无介绍段落、电脑/平板/手机排版检查。
- 四规格PDF逐页独立OpenCV检测：1×1 120mm 2张、2×2 70mm 5张、3×3 45mm 10张、4×4 30mm 17张。核对实际生成PDF中的ID唯一性和物理尺寸。

未做实物打印或摄像头现场读取测试。原底盘工程与控制协议没有修改，实体执行仍关闭。

## 启停与检查

```bash
cd /home/orangepi/ugv/QRautorun/qr_navigation_ws
./scripts/start.sh
./scripts/stop.sh
npm run build
npm test
PLAYWRIGHT_BROWSERS_PATH=/tmp/qr-playwright npx playwright test --grep '二维码PDF'
```
