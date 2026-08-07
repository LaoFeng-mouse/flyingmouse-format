# FlyingMouse Format 交接说明

更新日期：2026-08-06

## 当前状态

- Electron 已升级到 `43.1.0`。
- 导航、外链、IPC sender、下载 URL、重定向、renderer sandbox 和 CSP 已加固。
- 渲染器动态内容不再使用 `innerHTML`；当前页面视觉检查没有溢出、遮挡或缺失。
- 最终语法检查通过，自动测试为 `39/39`。
- 打包版已实际启动，窗口正常响应且日志出现 `Window finished loading`。
- Playwright 页面检查为 `0 error / 0 warning`；截图位于 `output/playwright/electron43-security-home.png`。
- 2026-08-06 安全与功能修复：音频文件不再暴露视频容器目标（mp4/webm/mkv/mov）；`/api/convert` 与 `/api/convert-images-to-pdf` 增加 Origin/Referer 跨站校验（403 拒绝非本地来源）；损坏 JSON 转换改为友好报错；`npm audit fix`（非 force）已将 multer 2.0.2→2.2.0、express 4.19.2→4.22.2，漏洞数从 8 降到 5；新增 4 个回归测试（音频目标、视频目标、跨站拒绝、本地放行）。
- 2026-08-06 依赖安全迁移完成：pdfjs-dist 3.11→6.2.108（ESM 动态 import 适配，`pdf.destroy`→`loadingTask.destroy`）、sharp 0.33.5→0.35.3（libvips CVE）、xlsx→exceljs 4.4.0（SheetJS 原型污染/ReDoS）、uuid 11.1.1 via overrides；`npm audit --omit=dev` 归零（0 vulnerabilities）；测试套件 25/25。
- 2026-08-06 初始化 Git 仓库并完成首次提交（commit `6883528`），纳入全部源码、测试与文档；`bin/`（FFmpeg/LibreOffice/Poppler/Tessdata 引擎）因体积庞大不入库，需单独备份。
- 2026-08-06 微软商店上架：MSIX 包（electron-builder 26 `appx` target + 自签名 CodeSigning 证书手动签名，`signExecutable:false`）已上传 Partner Center（产品 9NJKN37CR6H）并提交认证（提交 1，审核中，预计 1-3 个工作日）。商店渠道由微软自动签名；GitHub 直下载渠道仍为未签名。填写模板与逐屏指引见 docs/微软商店上架清单.md。
- 2026-08-07 工程基建：build/icon.png 鼠鼠图标（512x512 透明底，electron-builder 自动使用，下次打包生效）；MIT LICENSE；GitHub Actions CI 测试门禁（.github/workflows/ci.yml）；隐私政策正式 Pages URL 确认可用（https://laofeng-mouse.github.io/flyingmouse-format/docs/privacy-policy.html，HTTP 200）。
- 2026-08-07 格式扩展 v0.2.0（测试 39/39）：文本→PDF/DOCX（docx 纯 JS 生成）、Word↔Markdown（mammoth+turndown）、PDF 合并/拆分（pdf-lib，多选合并/单选拆单页 zip）、图片/动图→mp4/webm、音频新增 aac/opus/wma 输出、ZIP 压缩级别 0-9 可调并报告压缩前后尺寸；OCR 改进（PDF 渲染 300DPI + sharpen）。修复：便携版 LibreOffice 的 txt 导出过滤器不可用（docx→txt 改用 mammoth）、html→docx 不可用（文本→docx 全部改纯 JS 生成）；真实 Office 样本探测确认 docx→pdf/odt/rtf/html、xlsx/xls→pdf/ods/csv/html、pptx→pdf/odp/html 均可用。
- 2026-08-07 音乐格式支持 ncm+kgg（测试 41/41，真实文件验证通过）：ncm-format.js 支持官方网易云客户端标准 ncm（真实样本「国风堂,哦漏 - 知我」验证：CTENFDAM 头、keyLen@10、RC4 变种一次性 256 字节密钥流、CRC+5字节+封面跳过；含多布局回退）；kgg-format.js 支持酷狗 v5 KGG（真实样本「周杰伦-晴天」「杜宣达-指纹」验证：QMC2 加密，密钥读本机酷狗密钥库 %APPDATA%\KuGou8\KGMusicV3.db，AES-CBC 1024 字节分页解密 + sql.js 查 ShareFileItems；仅本机酷狗下载的歌曲可解）。新增依赖 sql.js（asarUnpack）。「VipSongsDownload 假 ncm」仍无法处理（自定义加密无算法）。合规约定：对外介绍一律不提此能力，文件名为中性 ncm-format.js/kgg-format.js。
- 2026-08-07 统一日志系统（测试 48/48）：新增 `logger.js`（INFO/WARN/ERROR 三级，写 `userData/debug.log`，纯 node 模式写 `%TEMP%\flyingmouse-format-debug.log`，`FLYINGMOUSE_LOG_FILE` 可覆盖；WARN/ERROR 镜像 stdout；日志文件超 1MB 自动截尾防膨胀）。server.js 记录启动（引擎路径）、每次转换请求（文件名/扩展名/类别/目标/大小）、成功、被拒请求、引擎 stderr（`Command failed: ...`）、未处理服务错误；electron-main.js 记录启动/窗口/退出/未捕获异常，并新增 `log-event` IPC（校验可信 sender）转发渲染进程错误；preload.js 暴露 `log(level, message)`；public/app.js 挂 window error / unhandledrejection 全局监听 + 批量转换失败逐文件上报。新增 tests/logger.test.js 7 项（写入格式/级别/stdout 镜像/静态接线断言/build.files 白名单）。排查用户报错：看 `%APPDATA%\FlyingMouse Format\debug.log` 尾部。

## 交付产物

| 产物 | 路径 | SHA-256 |
|---|---|---|
| 免安装程序 | `dist\win-unpacked\FlyingMouse Format.exe` | `CD82228ED54C0049C5883FAFBCD75854D9F75CEEF2ABA459825F1C87C1EF0982` |
| NSIS 安装包 | `dist\FlyingMouse Format-Setup-0.2.1-x64.exe` | `1DEC82457297EB7275FBAB79155487C2F5550E5A4A5EDC3C748884DDCBB34F69` |
| 商店包（MSIX，仍为 v0.1.0） | `dist\FlyingMouse Format-Setup-0.1.0-x64.appx`（副本曾名"上传商店用这个.appx"） | `093777C71B92458730DC5995ACC4A4C3FBC22B6A6C460ACD7A8C433B32982D20` |

2026-08-07 v0.2.1 打包完成（打赏窗 + 图标嵌入修复 + 专有音频模块改名 ncm-format.js/kgg-format.js；新哈希已更新，冒烟测试通过）。图标修复要点：win 配置须用 `signExecutable:false` 而非 `signAndEditExecutable:false`（后者连图标都不嵌入，v0.2.0 因此桌面图标未更新）；打包后需重建桌面快捷方式并 ie4uinit -show 刷新图标缓存。商店包仍是 v0.1.0（商店审核中的提交未变）。重新打包会改变哈希，发布前必须重新计算并更新交付记录。

桌面快捷方式 `C:\Users\34615\Desktop\FlyingMouse Format.lnk` 指向 `dist\win-unpacked\FlyingMouse Format.exe`（2026-08-06 改名后曾重建、随后缺失，2026-08-07 手动重建；NSIS 安装器 `createDesktopShortcut: true` 正式安装时也会自动创建）。注意：应用本体尚未通过安装器正式安装（%LOCALAPPDATA%\Programs 无痕迹），桌面安装包副本已按用户要求删除，安装器在 `dist\FlyingMouse Format-Setup-0.2.1-x64.exe`。

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
4. ~~electron-builder 使用默认图标~~ 已于 v0.2.1 解决（`signExecutable:false` 保留图标嵌入，鼠鼠图标已生效；桌面/任务栏视觉验证待正式安装后补）。
5. ~~目录当前不是 Git 仓库~~ 已于 2026-08-06 初始化并完成首次提交；`bin/` 引擎目录不入库，重装系统或换机前需单独备份 `bin/`。
6. 仓库已公开：https://github.com/LaoFeng-mouse/flyingmouse-format（提交作者统一为 LaoFeng；README 门面 + 10 个 topics + Release v0.1.0/v0.2.0/v0.2.1 已发布；CI 门禁 .github/workflows/ci.yml 绿色；截至 2026-08-07 约 29 star）。
7. 微软商店认证审核中（2026-08-06 提交，产品 9NJKN37CR6H）：预计 1-3 个工作日；若打回需按认证报告修改并重传达标截图（现役达标截图：`C:\Users\34615\Desktop\FlyingMouseFormat-store-shot1.png`，1600x961）。隐私政策提交 1 用的是 raw 链接；正式 Pages URL 已确认可用（https://laofeng-mouse.github.io/flyingmouse-format/docs/privacy-policy.html），下次提交换成正式链接。

## 后续优先级

1. 等待微软商店认证结果（2026-08-06 提交，预计 1-3 个工作日）；打回则按认证报告修改并重提。
2. ~~ncm/kgg 音乐解密~~（已完成 2026-08-07，真实样本验证 41/41）：ncm 需官方网易云客户端标准文件；kgg 需本机酷狗密钥库。遗留：kgg 仅支持 v5（mode=5），旧版/概念版待样本；VipSongsDownload 假 ncm 无解（自定义加密）。
3. 下次商店提交时把隐私政策 URL 换成正式 Pages 链接：https://laofeng-mouse.github.io/flyingmouse-format/docs/privacy-policy.html（已 200，raw 链接仍可继续用）。
4. ~~打包 v0.2.0~~（已完成 2026-08-07：build/icon.png 图标生效 + 全部新格式；新哈希已更新到交付产物表；桌面/任务栏视觉验证未做，待正式安装后补）。
5. 依赖安全已归零；后续每次依赖变更后跑 `npm audit --omit=dev` 确认不回升。
6. 可选：补转换过程截图（商店推荐 4 张，现 1 张）；配置 GitHub Actions 自动打包（CI 已配测试门禁 .github/workflows/ci.yml）。
