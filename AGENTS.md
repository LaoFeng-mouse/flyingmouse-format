# AGENTS.md

## Project boundary

FlyingMouse Format（飞鼠格式）是 Windows Electron 离线文件转换器。主产品必须使用原版鼠鼠 UI；它与“鼠鼠打印”是两个独立项目，禁止跨项目修改或混合发布物。

当前主线：Electron 43、Windows 10/11 x64、鼠鼠 UI、中英文切换、批量转换、按源格式记忆目标格式、保存目录记忆、普通 NCM 与 Audio Vivid（AV3A）NCM。

## Source map

- `server.js`：Express 本地转换服务、能力检测、目标格式判断、上传与下载路由。
- `electron-main.js`：启动本地服务、创建窗口、设置打包引擎路径、保存 IPC。
- `electron-security.js`：导航、外链、下载和 IPC 的同源信任策略。
- `preload.js`：向渲染器暴露最小 IPC 接口。
- `public/index.html`、`public/styles.css`、`public/app.js`：鼠鼠 UI、批量队列、进度、状态与保存交互。
- `public/i18n.js`：`zh-CN` / `en-US` 语言状态与持久化。
- `public/conversion-preferences.js`：按规范化源扩展名记忆目标格式。
- `settings-store.js`：在 Electron `userData/settings.json` 中原子保存最近目录。
- `ncm-format.js`、`av3a-format.js`、`kgg-format.js`：专有音频容器处理。
- `logger.js`：主进程、服务端和渲染器共用的分级日志。
- `build/icon.png`：NSIS、EXE、任务栏和快捷方式的 512×512 鼠鼠图标；必须由 `public/assets/mouse-format/mouse-idle.png` 生成。
- `bin/`：本地转换引擎。除 `bin/avs3/` 外被 Git 忽略，换机时必须单独准备。

## Product invariants

- 保留鼠鼠品牌：页面必须包含 `mouseMascot` 和鼠鼠状态图；打包图标必须是鼠鼠，不得恢复闲鱼版橙色闪电或中性 UI。
- 鼠鼠状态覆盖上传、识别、普通转换、批量、OCR、PDF、成功与失败。
- 用户运行时文本使用 DOM API / `textContent`，禁止重新引入动态 `innerHTML`。
- 长文件名、错误和按钮文案必须可换行，避免窄窗口溢出。
- 批量转换只显示所有选中文件都支持的目标格式交集。
- 输出名称保留原文件 basename，包括中文和其他非 ASCII 字符。
- 单文件和批量保存均使用 Electron 对话框；只有成功保存后才更新最近目录。
- 目标格式按源扩展名分别记忆；用户修改后覆盖该源格式的默认目标。
- 首次语言跟随系统；手动选择 `zh-CN` 或 `en-US` 后使用 `flyingmouse.language.v1` 持久化。

## Conversion boundaries

- PDF → XLSX 是文本表格提取，不是扫描表格布局重建。
- PDF → PNG/JPG 使用 Poppler，并因多页输出 ZIP。
- 图片或扫描 PDF → TXT 使用 Tesseract OCR。
- 音频源不得暴露 MP4/WebM/MKV/MOV 等视频容器目标。
- NCM 只保证兼容 `music.163.com` 对应网易云音乐客户端生成的文件；其他网站的同扩展名变体不在范围内。
- AV3A NCM 通过 `av3a-format.js` 提取音轨、随包 AVS3 helper 解码为 WAV，再由 FFmpeg 转换。
- 商店材料不要宣传 DRM 绕过；README 可以中性说明官方客户端 NCM/Audio Vivid 兼容范围。

## Security boundaries

- Electron 必须保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 渲染器导航和 IPC sender 必须匹配本次启动的精确 `127.0.0.1` origin。
- 下载只允许同源 `/downloads/<id>`；外部打开只允许无凭证 HTTPS。
- 文件名进入路径前继续使用 `path.basename` 收敛。
- 本地安装包当前未签名；不得把证书、密码、令牌或私钥写入仓库。

## Runtime paths and diagnostics

Electron 启动时设置：

- `FLYINGMOUSE_RUNTIME_DIR`
- `FLYINGMOUSE_FFMPEG_PATH`
- `FLYINGMOUSE_AVS3_DECODER_PATH`
- `FLYINGMOUSE_LIBREOFFICE_PATH`
- `FLYINGMOUSE_LOG_FILE`

开发或测试还可覆盖 `FLYINGMOUSE_PDFTOPPM_PATH`、`FLYINGMOUSE_TESSDATA_PATH` 和 `PORT`。真实 AV3A 测试使用 `FLYINGMOUSE_AV3A_NCM_FIXTURES`。

桌面日志位于 `%APPDATA%\FlyingMouse Format\debug.log`。独立运行 `node server.js` 时默认写 `%TEMP%\flyingmouse-format-debug.log`。

## Commands

```powershell
npm install
npm run desktop
npm test
npm run test:ci
npm audit --omit=dev
npm run dist
```

沙箱限制 Node 子进程时可能出现 `spawn EPERM`；这不是转换代码失败。真实转换测试和打包应在普通 Windows PowerShell、cmd 或 CI 中运行。

完整本地测试依赖 `bin/` 引擎；GitHub Actions 只运行不依赖大型引擎的 `npm run test:ci`。

## Packaging and release

- `build.files` 是显式白名单；新增被服务端引用的根目录 JS 模块时必须同步加入。
- `extraResources` 必须包含 FFmpeg、AVS3、LibreOffice、Poppler、tessdata 和 Tesseract core。
- 保持 `signExecutable: false`，不要使用 `signAndEditExecutable: false`，后者会跳过图标嵌入。
- `npm run dist` 当前生成 NSIS 安装包和 `dist/win-unpacked`；不要假设 APPX 已同步生成。
- 发布前必须检查：完整测试、真实 AV3A 样本、`npm audit --omit=dev`、ASAR 文件、引擎资源、EXE 产品版本、安装包 SHA-256、鼠鼠内嵌图标、桌面快捷方式、GitHub 资产摘要。
- `dist/win-unpacked` 是本机开发/验收入口；公开交付使用 Release 安装包。
- GitHub remote：`https://github.com/LaoFeng-mouse/flyingmouse-format.git`。

## Documentation map

- `README.md`：面向用户的中英文介绍、下载与格式范围。
- `docs/ARCHITECTURE.md`：运行架构、状态和数据边界。
- `docs/RELEASE.md`：本机测试、打包、桌面同步与 GitHub 发布清单。
- `docs/HANDOFF.md`：当前可交接状态和剩余风险。
- `docs/privacy-policy.html`：面向用户和 Microsoft Store 的隐私政策。
- `docs/微软商店上架清单.md`、`docs/上架材料包.md`：商店渠道资料；外部审核状态必须写绝对日期并注明是否已现场复核。
