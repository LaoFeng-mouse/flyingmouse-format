# AGENTS.md

## Project boundary

FlyingMouse Format（飞鼠格式）是 Windows Electron 离线文件转换器。主产品必须使用原版鼠鼠 UI；它与“鼠鼠打印”是两个独立项目，禁止跨项目修改或混合发布物。

当前主线：Electron 43、Windows 10/11 x64、鼠鼠 UI、中英文切换、批量转换、按源格式记忆目标格式、保存目录记忆、PDF→Word 版式还原（docengine）、PDF→Excel 表格提取（camelot）、视频编码选择（H.264/H.265/AV1）、OFD→PDF（ofd-convert.js，@miconvert/ofd-to-pdf，仅支持转 PDF 不走 LibreOffice）。Windows 7 SP1 x64 只通过独立 staging 派生 Electron 22.3.27 兼容包，禁止降低根 manifest 的主线依赖。

## Source map

- `server.js`：Express 本地转换服务、能力检测、目标格式判断、上传与下载路由。
- `electron-main.js`：启动本地服务、创建窗口、设置打包引擎路径、保存 IPC。
- `electron-security.js`：导航、外链、下载和 IPC 的同源信任策略。
- `preload.js`：向渲染器暴露最小 IPC 接口。
- `public/index.html`、`public/styles.css`、`public/app.js`：鼠鼠 UI、批量队列、进度、状态与保存交互。
- `public/i18n.js`：`zh-CN` / `en-US` 语言状态与持久化。
- `public/conversion-preferences.js`：按规范化源扩展名记忆目标格式。
- `settings-store.js`：在 Electron `userData/settings.json` 中原子保存最近目录。
- `resource-policy.js`：统一图片、批量、PDF 与 OCR 资源上限和稳定错误码。
- `text-conversion.js`：统一 ATX/Fenced Turndown 与严格 CSV 解析。
- `pdf-table-extractor.js` / `pdf-table-runtime.js`：复杂 PDF 表格几何识别、OCR 回退与工作簿模型。
- `ofd-convert.js`：OFD（国标 GB/T 33190）→ PDF，`@miconvert/ofd-to-pdf` 纯 JS 链路，仅支持转 PDF 不走 LibreOffice。
- `logger.js`：主进程、服务端和渲染器共用的分级日志。
- `win7-build-profile.js` / `scripts/build-win7.js`：派生并构建隔离的 Windows 7 manifest；根依赖不得被改写。
- `pe-metadata.js` / `scripts/inspect-pe.js`：读取 PE32/PE32+ 的目标 OS 版本，发布时检查解包应用 EXE。
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

- PDF → XLSX 是“智能表格提取”：优先 PDF.js 电子文字坐标，无有效文字时使用 Poppler + Tesseract blocks；支持有框/无框、多表、跨页续接、旋转、合并区域、低置信批注与 Raw 回退，但扫描件和复杂排版仍可能不完整。
- PDF → DOCX 优先用内置 docengine 引擎（spawn `bin/docengine/docengine.exe`，pdf2docx 打包）做版式还原（段落/表格/图片/字体）；引擎缺失或转换失败时回退到 PDF.js 文字提取。Windows 7 版不含该引擎（Python 3.12 不支持 Win7），始终回退文字提取；macOS 版同样不含（darwin 引擎仅 runtime/libreoffice/tessdata）。
- HTML / Office → Markdown 必须共用 ATX 标题、fenced 代码块的 Turndown helper；CSV 使用锁定的 `csv-parse 5.6.0`，禁止退回按换行拆分的简易解析器。
- 资源上限固定为：单图 50MP、单边 16384px、图片合并 PDF 总解码量 100MP、批量选择 2GB、PDF 不限页数（1:1 还原）、OCR 不限页数；Sharp 不得使用无约束 `limitInputPixels: false`。
- PDF → PNG/JPG 使用 Poppler，并因多页输出 ZIP。
- 图片或扫描 PDF → TXT 使用 Tesseract OCR。
- 音频源不得暴露 MP4/WebM/MKV/MOV 等视频容器目标。
- 音频仅支持普通格式（MP3/WAV/FLAC/AAC/OGG/OPUS/WMA），不支持任何音乐平台加密特殊格式（DRM 规避法律风险，公开版已移除解锁模块，见 docs/分发与合规规范.md）。

## Security boundaries

- Electron 必须保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 渲染器导航和 IPC sender 必须匹配本次启动的精确 `127.0.0.1` origin。
- 下载只允许同源 `/downloads/<id>`；外部打开只允许无凭证 HTTPS。
- 文件名进入路径前继续使用 `path.basename` 收敛。
- 本地安装包当前未签名；不得把证书、密码、令牌或私钥写入仓库。
- PDF.js 必须只从当前应用自己的 `node_modules/pdfjs-dist` 加载；旧版入口回退不得借用父目录依赖，所有 `getDocument` 调用保持 `isEvalSupported: false`。

## Runtime paths and diagnostics

Electron 启动时设置：

- `FLYINGMOUSE_RUNTIME_DIR`
- `FLYINGMOUSE_FFMPEG_PATH`
- `FLYINGMOUSE_AVS3_DECODER_PATH`
- `FLYINGMOUSE_LIBREOFFICE_PATH`
- `FLYINGMOUSE_LOG_FILE`

开发或测试还可覆盖 `FLYINGMOUSE_PDFTOPPM_PATH`、`FLYINGMOUSE_TESSDATA_PATH` 和 `PORT`。

桌面日志位于 `%APPDATA%\FlyingMouse Format\debug.log`。独立运行 `node server.js` 时默认写 `%TEMP%\flyingmouse-format-debug.log`。

## Commands

```powershell
npm install
npm run desktop
npm test
npm run test:ci
npm audit --omit=dev
npm run dist
node scripts/build-win7.js --prepare-only
npm run dist:win7
node scripts/inspect-pe.js "output/win7-stage/dist/win-unpacked/FlyingMouse Format.exe"
npm audit --omit=dev --prefix output\win7-stage
```

沙箱限制 Node 子进程时可能出现 `spawn EPERM`；这不是转换代码失败。真实转换测试和打包应在普通 Windows PowerShell、cmd 或 CI 中运行。

完整本地测试依赖 `bin/` 引擎。Release workflow 会按 `ci-engines-v1.json` 校验 SHA-256、缓存并恢复固定引擎资产，执行 `npm test`、审计和标准/Win7 双构建，最后由 publish job 在云端自动创建 GitHub Release 并上传资产（本地不用下载 artifacts）；普通 CI 仍运行 `npm run test:ci`。

## Packaging and release

- `build.files` 是显式白名单；新增被服务端引用的根目录 JS 模块时必须同步加入。
- `extraResources` 必须包含 FFmpeg、AVS3、LibreOffice、Poppler、tessdata、Tesseract core 和 docengine（PDF→Word/Excel 文档引擎，Windows 标准版专用；win7 版与 macOS 排除，回退纯 JS）。
- 保持 `signExecutable: false`，不要使用 `signAndEditExecutable: false`，后者会跳过图标嵌入。
- `npm run dist` 当前生成 NSIS 安装包和 `dist/win-unpacked`；不要假设 APPX 已同步生成。
- Microsoft Store 使用同一鼠鼠 UI 源码单独构建的 Windows 10/11 x64 APPX/MSIX；不得上传 NSIS，也不得提交 Win7 Legacy 包。上传前必须校验 Identity、Publisher、版本、架构、包内模块、鼠鼠图标和 SHA-256。
- Partner Center 的“包验证通过”“认证通过”“公开发布”是不同状态；外部状态只能按现场回读结果和绝对日期记录，不能由本地构建或上传成功推断。
- **商店 MSIX 两个代码级坑（2026-08-28 修复，commit 468d7db，勿回退）**：
  - Settings 原子写：Store AppContainer 把 `%APPDATA%\Roaming` 重定向到 `AppData\Local\Packages`，`fs.rename` 跨此边界抛 `EXDEV`（装完即“用不了”）。`writeSettings` 必须对 `EXDEV` 降级为 `copyFile + rm`；同卷仍保留原子 `rename`。见 skill flyingmouse-format `references/settings-exdev-cross-device-rename.md`。
  - LibreOffice 引擎：Store 装在只读 `WindowsApps`，LibreOfficePortable 无法在只读安装目录初始化（“安装无法完成”→ Word/Excel/PPT→PDF 失效）。`process.windowsStore` 为真时把引擎一次性复制到 `%LOCALAPPDATA%\FlyingMouseFormat\engines\libreoffice` 并改指 `FLYINGMOUSE_LIBREOFFICE_PATH`；非商店版零开销。见 `references/libreoffice-msix-readonly-install.md`。
  - 改了 app 代码后**必须整体重建 win-unpacked**（electron-builder 把 `app.asar` 完整性哈希烧进 exe），不能只外科替换 asar；signed 包需重签名。见 `references/appx-rebuild-and-store-upload.md`。
- 发布前必须检查：完整测试、真实 AV3A 样本、`npm audit --omit=dev`、ASAR 文件、引擎资源、EXE 产品版本、安装包 SHA-256、鼠鼠内嵌图标、桌面快捷方式、GitHub 资产摘要。
- `dist/win-unpacked` 是本机开发/验收入口；公开交付使用 Release 安装包。
- Win7 构建只允许使用 Node.js 18–22（推荐 22 LTS）和专用 `win7-package-lock.json` 经 `npm ci` 重建 `output/win7-stage/`；子进程必须绑定当前 Node，源码复制须兼容 Unicode 路径。产物写入精确的 `dist/FlyingMouse Format-Setup-<version>-win7-x64.exe`；脚本必须锁定 staging manifest/lockfile，校验本地 builder 与 `extraResources` 各自在允许根目录内的 canonical containment 并拒绝 reparse point；测试可以清理 staging，不得覆盖标准安装包或移动既有版本标签。
- Windows 7 发布证据必须同时记录：主线测试、staging 测试、内层 EXE PE 5.2、当前系统冒烟、旧依赖审计及“真实 Win7 设备待验收”。
- Win7 staging 测试只运行能在 staging 内自洽执行的 90 项；根专属真实引擎/打包管线测试由主线执行，不得把根测试文件复制进 staging 后制造假失败。
- GitHub remote：`https://github.com/LaoFeng-mouse/flyingmouse-format.git`。

## Documentation map

- `README.md`：面向用户的中英文介绍、下载与格式范围。
- `docs/ARCHITECTURE.md`：运行架构、状态和数据边界。
- `docs/RELEASE.md`：本机测试、打包、桌面同步与 GitHub 发布清单。
- `docs/HANDOFF.md`：当前可交接状态和剩余风险。
- `docs/privacy-policy.html`：面向用户和 Microsoft Store 的隐私政策。
- `docs/微软商店上架清单.md`、`docs/上架材料包.md`：商店渠道资料；外部审核状态必须写绝对日期并注明是否已现场复核。

## 著作权与许可（2026-08-14 起强制执行）

- 作者：牢蜂（LaoFeng）。所有公开发布物（README、Release、安装包、UI、诊断文件、商店材料）必须保留作者署名。
- 许可证为非商用：禁止销售、转卖、收费服务、电商平台倒卖、套壳换皮重新发布。LICENSE 已从 MIT 更换为非商用许可。
- 任何界面文案/文档新增作者信息时：作者=牢蜂，禁止商用表述为「仅供个人免费使用，禁止商业售卖/转卖/套壳」。
- 包内版本号、README 版本号、release notes、package-lock/win7-package-lock 版本号必须与 package.json 同步，发版前逐一核对。
