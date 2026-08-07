# FlyingMouse Format 交接说明

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
- 2026-08-06 微软商店上架：MSIX 包（electron-builder 26 `appx` target + 自签名 CodeSigning 证书手动签名，`signExecutable:false`）已上传 Partner Center（产品 9NJKN37CR6H）并提交认证（提交 1，审核中，预计 1-3 个工作日）。商店渠道由微软自动签名；GitHub 直下载渠道仍为未签名。填写模板与逐屏指引见 docs/微软商店上架清单.md。

## 交付产物

| 产物 | 路径 | SHA-256 |
|---|---|---|
| 免安装程序 | `dist\win-unpacked\FlyingMouse Format.exe` | `163FB2FA009BCEC9ADECE853FE55E2189E6B4BD49A7F9C672CF5DE9AA59C64A4` |
| NSIS 安装包 | `dist\FlyingMouse Format-Setup-0.1.0-x64.exe` | `7765A6950B572887D919207D9F2B95D99A23F27F27C32AF5734B42877ED32834` |
| 商店包（MSIX） | `dist\FlyingMouse Format-Setup-0.1.0-x64.appx`（副本曾名"上传商店用这个.appx"） | `093777C71B92458730DC5995ACC4A4C3FBC22B6A6C460ACD7A8C433B32982D20` |

2026-08-06 第三次重新打包（产品更名为 FlyingMouse Format 后）：新哈希已更新，且与 GitHub Release v0.1.0 资产 digest（sha256:7765a695...）一致。商店包哈希 093777C7... 与上传到 Partner Center 的 .appx 一致。重新打包会改变哈希，发布前必须重新计算并更新交付记录。

桌面快捷方式 `C:\Users\34615\Desktop\FlyingMouse Format.lnk` 指向 `dist\win-unpacked\FlyingMouse Format.exe`（2026-08-06 改名后曾重建、随后缺失，2026-08-07 手动重建；NSIS 安装器 `createDesktopShortcut: true` 正式安装时也会自动创建）。注意：应用本体尚未通过安装器正式安装（%LOCALAPPDATA%\Programs 无痕迹），桌面安装包副本已按用户要求删除，安装器在 `dist\FlyingMouse Format-Setup-0.1.0-x64.exe`。

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

1. EXE 和安装包均为 `NotSigned`。商店渠道已绕过该问题（微软自动签名）；GitHub 直下载与本地安装包仍无签名，正式对外分发仍需真实 Windows 代码签名证书。
2. ~~`npm audit --omit=dev` 报告漏洞~~ 已于 2026-08-06 归零（pdfjs-dist 6.x、sharp 0.35.3、exceljs 替换 xlsx、uuid 11.1.1 overrides）。今后依赖变更后需重新跑 audit 确认。
3. ~~PDF.js 缺少 canvas polyfill 警告~~ 已于 2026-08-06 迁移 pdfjs-dist 6.x 后消失（改用 @napi-rs/canvas，测试无警告）。
4. electron-builder 当前使用默认 Electron 程序图标；产品正式发布前应提供 `.ico` 并做桌面、任务栏和安装器视觉验证。
5. ~~目录当前不是 Git 仓库~~ 已于 2026-08-06 初始化并完成首次提交；`bin/` 引擎目录不入库，重装系统或换机前需单独备份 `bin/`。
6. 仓库已公开：https://github.com/LaoFeng-mouse/flyingmouse-format（GitHub 用户名已从 LI-2004-feng 改为 LaoFeng-mouse，提交作者统一为 LaoFeng；README 门面 + 10 个 topics + Release v0.1.0 均已就位）。当前 0 star，无 CI，搜索排名靠后属预期。
7. 微软商店认证审核中（2026-08-06 提交，产品 9NJKN37CR6H）：预计 1-3 个工作日；若打回需按认证报告修改并重传达标截图（现役达标截图：`C:\Users\34615\Desktop\FlyingMouseFormat-store-shot1.png`，1600x961）。隐私政策提交时用的是 raw.githubusercontent.com 链接（已 HTTP 200），GitHub Pages 正式链接尚未启用。

## 后续优先级

1. 等待微软商店认证结果（2026-08-06 提交，预计 1-3 个工作日）；打回则按认证报告修改并重提。
2. 配置正式应用图标（.ico）和代码签名证书，在干净 Windows 环境验证 SmartScreen、安装、卸载与快捷方式。
3. 开启 GitHub Pages 托管隐私政策（docs/privacy-policy.html），把商店列表里的隐私政策 URL 从 raw 链接换成 `https://laofeng-mouse.github.io/flyingmouse-format/privacy-policy.html`。
4. 完成签名构建后重新计算哈希，并更新本文件的交付产物表。
5. 依赖安全已归零；后续每次依赖变更后跑 `npm audit --omit=dev` 确认不回升。
6. 可选：定 License（如 MIT）并补 LICENSE 文件，让项目成为合规开源项目；配置 GitHub Actions 自动测试/打包 CI。
