# 路径二维码间距 Playwright 验收
新增 `tests/browser/route-distance-editor.spec.ts`，覆盖路径编辑入口、相邻二维码选择、中心欧氏距离 m/cm/mm 展示、目标距离预览以及保存请求中的 `distanceModel`/`spacingOverrides`。测试使用 Playwright route mock，不连接设备、不部署、不写生产数据库。当前未启动 Vite/API，未执行浏览器运行。
