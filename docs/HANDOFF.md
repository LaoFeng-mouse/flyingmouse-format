# 飞鼠格式交接说明

更新日期：2026-08-06

## 当前状态

- Electron 已升级到 `43.1.0`。
- 导航、外链、IPC sender、下载 URL、重定向、renderer sandbox 和 CSP 已加固。
- 渲染器动态内容不再使用 `innerHTML`；当前页面视觉检查没有溢出、遮挡或缺失。
- 最终语法检查通过，自动测试为 `24/24`。
- 打包版已实际启动，窗口正常响应且日志出现 `Window finished loading`。
- Playwright 页面检查为 `0 error / 0 warning`；截图位于 `output/playwright/electron43-security-home.png`。
- 2026-08-06 安全与功能修复：音频文件不再暴露视频容器目标（mp4/webm/mkv/mov）；`/api/convert` 与 `/api/convert-images-to-pdf` 增加 Origin/Referer 跨站校验（403 拒绝非本地来源）；损坏 JSON 转换改为友好报错；`npm audit fix`（非 force）已将 multer 2.0.2→2.2.0、express 4.19.2→4.22.2，漏洞数从 8 降到 5；新增 4 个回归测试（音频目标、视频目标、跨站拒绝、本地放行）。
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
2. `npm audit --omit=dev` 仍报告 5 个（4 high、1 critical）：`pdfjs-dist`（任意 JS 执行，需迁移 6.x）、`sharp`（libvips CVE，需升 0.35）、`tar` critical（经 `@mapbox/node-pre-gyp` → `sharp` 的间接依赖，随 sharp 升级解决）、`xlsx`（原型污染 + ReDoS，SheetJS 官方无修复）。PDF.js 6 与 SheetJS 替换属于转换引擎迁移，必须另立测试驱动任务处理，禁止直接运行 `npm audit fix --force`。
3. PDF.js 在测试中仍提示缺少可选 `canvas` polyfill；现有 PDF/OCR 测试通过，但迁移 PDF.js 时应一并重新评估。
4. electron-builder 当前使用默认 Electron 程序图标；产品正式发布前应提供 `.ico` 并做桌面、任务栏和安装器视觉验证。
5. ~~目录当前不是 Git 仓库~~ 已于 2026-08-06 初始化并完成首次提交；`bin/` 引擎目录不入库，重装系统或换机前需单独备份 `bin/`。

## 后续优先级

1. 建立依赖安全迁移计划：先迁移 PDF.js 6.x，再升级 sharp 0.35（连带解决 tar critical），最后替换或升级 SheetJS/xlsx。
2. 配置正式应用图标和代码签名，在干净 Windows 环境验证 SmartScreen、安装、卸载与快捷方式。
3. 完成签名构建后重新计算哈希，并更新本文件的交付产物表。
