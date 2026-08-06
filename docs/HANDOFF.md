# 飞鼠格式交接说明

更新日期：2026-08-06

## 当前状态

- Electron 已升级到 `43.1.0`。
- 导航、外链、IPC sender、下载 URL、重定向、renderer sandbox 和 CSP 已加固。
- 渲染器动态内容不再使用 `innerHTML`；当前页面视觉检查没有溢出、遮挡或缺失。
- 最终语法检查通过，自动测试为 `25/25`。
- 打包版已实际启动，窗口正常响应且日志出现 `Window finished loading`。
- Playwright 页面检查为 `0 error / 0 warning`；截图位于 `output/playwright/electron43-security-home.png`。
- 2026-08-06 安全与功能修复：音频文件不再暴露视频容器目标（mp4/webm/mkv/mov）；`/api/convert` 与 `/api/convert-images-to-pdf` 增加 Origin/Referer 跨站校验（403 拒绝非本地来源）；损坏 JSON 转换改为友好报错；`npm audit fix`（非 force）已将 multer 2.0.2→2.2.0、express 4.19.2→4.22.2，漏洞数从 8 降到 5；新增 4 个回归测试（音频目标、视频目标、跨站拒绝、本地放行）。
- 2026-08-06 依赖安全迁移完成：pdfjs-dist 3.11→6.2.108（ESM 动态 import 适配，`pdf.destroy`→`loadingTask.destroy`）、sharp 0.33.5→0.35.3（libvips CVE）、xlsx→exceljs 4.4.0（SheetJS 原型污染/ReDoS）、uuid 11.1.1 via overrides；`npm audit --omit=dev` 归零（0 vulnerabilities）；测试套件 25/25。
- 2026-08-06 初始化 Git 仓库并完成首次提交（commit `6883528`），纳入全部源码、测试与文档；`bin/`（FFmpeg/LibreOffice/Poppler/Tessdata 引擎）因体积庞大不入库，需单独备份。

## 交付产物

| 产物 | 路径 | SHA-256 |
|---|---|---|
| 免安装程序 | `dist\win-unpacked\飞鼠格式.exe` | `D39870A5DF13487556C4257415A80F0B55E0EA0EDDB505887CA4C7EDE69AE6FD` |
| NSIS 安装包 | `dist\飞鼠格式安装包-0.1.0-x64.exe` | `9BEB91F06FCE370332B2AD57A184D3CB06315FAD14A89F0ED5FCA8A61C7864A7` |

2026-08-06 重新打包（含安全与功能修复）：新哈希已更新；重新打包会改变哈希，发布前必须重新计算并更新交付记录。

桌面快捷方式 `C:\Users\34615\Desktop\飞鼠格式.lnk` 仍指向 `dist\win-unpacked\飞鼠格式.exe`，本轮没有重写快捷方式。

## 验证入口

```powershell
node --check server.js
node --check public\app.js
node --check electron-main.js
node --check electron-security.js
node --check preload.js
npm test
npm ls electron --depth=0
npm audit --omit=dev
```

打包命令与镜像环境变量见项目根目录 `README.md` 和 `AGENTS.md`。

## 未解决风险

1. EXE 和安装包均为 `NotSigned`。正式对外分发前需要真实 Windows 代码签名证书。
2. ~~`npm audit --omit=dev` 报告漏洞~~ 已于 2026-08-06 归零（pdfjs-dist 6.x、sharp 0.35.3、exceljs 替换 xlsx、uuid 11.1.1 overrides）。今后依赖变更后需重新跑 audit 确认。
3. PDF.js 在测试中仍提示缺少可选 `canvas` polyfill；现有 PDF/OCR 测试通过，但迁移 PDF.js 时应一并重新评估。
4. electron-builder 当前使用默认 Electron 程序图标；产品正式发布前应提供 `.ico` 并做桌面、任务栏和安装器视觉验证。
5. ~~目录当前不是 Git 仓库~~ 已于 2026-08-06 初始化并完成首次提交；`bin/` 引擎目录不入库，重装系统或换机前需单独备份 `bin/`。

## 后续优先级

1. 配置正式应用图标（.ico）和代码签名证书，在干净 Windows 环境验证 SmartScreen、安装、卸载与快捷方式。
2. 完成签名构建后重新计算哈希，并更新本文件的交付产物表。
3. 依赖安全已归零；后续每次依赖变更后跑 `npm audit --omit=dev` 确认不回升。
