# AGENTS.md

## 当前工作入口

本目录是基于公开 main 0.7.10 整理的 0.8.1 R5 通用修复源码分支，包含 OFD、PDF、Excel、诊断与 CR2 修复。唯一现役状态入口为 [HANDOFF](docs/HANDOFF.md)，机制和证据分别进入架构及版本记录。不要继续在规则顶部堆叠各版本的“当前候选”。

- 现有安装器与此源码不等同；完整重建入口、Runtime、ASAR 后才能声明新包包含运行代码修改。
- 公开源码只提供普通音频转换；平台专用音乐模块、登录凭据接入和本地专用安装器不得进入本分支，参见 [分发与合规规范](docs/分发与合规规范.md)。
- 来源源码的历史测试和安装结果仅说明修复来源；公开变体的测试、构建、安装和发布状态分别核对，不能沿用为本分支验收。
- 私人原文件、账号数据、机器验证收据及旧快照留在原位置，不纳入 Git 导出。

## Project boundary

FlyingMouse Format（飞鼠格式）是 Windows Electron 离线文件转换器。主产品必须使用原版鼠鼠 UI；它与“鼠鼠打印”是两个独立项目，禁止跨项目修改或混合发布物。

当前技术栈：Electron 43、Windows 10/11 x64、鼠鼠 UI、中英文切换、批量转换、偏好与保存目录记忆。PDF 按原生/扫描内容分流，见 [架构](docs/ARCHITECTURE.md)；OFD 仅通过 `ofd-convert.js` 转 PDF，不走 LibreOffice。Windows 7 SP1 x64 只通过独立 staging 派生 Electron 22.3.27，禁止降低根 manifest 的主线依赖。当前候选与发布状态以 [现役交接](docs/HANDOFF.md) 为准，不能从源码版本推断已安装或已发布版本。

## Source map

- `server.js`：Express 本地转换服务、能力检测、目标格式判断、上传与下载路由。
- `electron-main.js`：启动本地服务、创建窗口、设置打包引擎路径、保存 IPC。
- `electron-security.js`：导航、外链、下载和 IPC 的同源信任策略。
- `preload.js`：向渲染器暴露最小 IPC 接口。
- `public/index.html`、`public/styles.css`、`public/app.js`：鼠鼠 UI、批量队列、进度、状态与保存交互。
- `public/i18n.js`：`zh-CN` / `en-US` 语言状态与持久化。
- `public/conversion-preferences.js`：按规范化源扩展名记忆目标格式。
- `settings-store.js`：在 Electron `userData/settings.json` 中原子保存最近目录。
- `office-readiness.js`、`store-engine-cache.js`、`store-engine-worker.js`：Office 准备状态、Store 可写缓存与后台验证。
- `desktop-shutdown.js`、`owned-tasks.js`：有界退出、所属进程/Worker 收尾及临时目录身份校验。Store 默认逻辑缓存根使用 `%LOCALAPPDATA%/FMF/e` 和短目录名以避免 AppData 重定向后的路径溢出；完整内容键校验不得因目录缩短而删减。
- `ocr.js`、`subtitles.js`：带质量/方向诊断的 OCR、多页 TIFF 和字幕时间轴转换。
- `resource-policy.js`：统一图片、批量、PDF 与 OCR 资源上限和稳定错误码。
- `text-conversion.js`：统一 ATX/Fenced Turndown 与严格 CSV 解析。
- `pdf-table-extractor.js` / `pdf-table-runtime.js` / `pdf-table.js`：PDF 表格模型与写出；`pdf-text-render-style.js` 保守识别描边强调，`xlsx-normal-font.js` 固定源表单列宽的 Normal 字体度量。
- `ofd-convert.js` / `ofd-renderer.js`：OFD → PDF 的本地维护解析/渲染与逐页 Poppler 可见性校验。仅转 PDF；缺失页面、资源及未实现内容明确拒绝，验证完成才发布结果。第三方来源及许可见 `third-party/ofd-to-pdf/`。
- `logger.js`：主进程、服务端和渲染器共用的分级日志。
- `win7-build-profile.js` / `scripts/build-win7.js`：派生并构建隔离的 Windows 7 manifest；根依赖不得被改写。
- `pe-metadata.js` / `scripts/inspect-pe.js`：读取 PE32/PE32+ 的目标 OS 版本，发布时检查解包应用 EXE。
- `build/icon.png`：NSIS、EXE、任务栏和快捷方式的 512×512 鼠鼠图标；必须由 `public/assets/mouse-format/mouse-idle.png` 生成。
- `bin/`：本地转换引擎。除 `bin/avs3/` 外被 Git 忽略，换机时必须单独准备。

## Product invariants

- 保留鼠鼠品牌：页面必须包含 `mouseMascot` 和鼠鼠状态图；打包图标必须是鼠鼠，不得恢复闲鱼版橙色闪电或中性 UI。
- 鼠鼠状态覆盖上传、识别、普通转换、批量、OCR、PDF、成功与失败。
- 胸前 V/U 是默认合拢双手；动作姿态必须删除该 V/U，且只保留一对动作手。带已知胸前手部冲突的工坊场景图不得作为本项目正向参考或默认展示。UI 插件文件完整性验证不等于角色画法正确。
- 外观支持浅色、深色、随系统；尊重用户选择且不反色处理真实文档/图片内容。修改不能用固定工坊场景替代文件转换工作流。
- 用户运行时文本使用 DOM API / `textContent`，禁止重新引入动态 `innerHTML`。
- 长文件名、错误和按钮文案必须可换行，避免窄窗口溢出。
- 批量转换只显示所有选中文件都支持的目标格式交集。
- 输出名称保留原文件 basename，包括中文和其他非 ASCII 字符。
- 单文件和批量保存均使用 Electron 对话框；只有成功保存后才更新最近目录。
- 目标格式按源扩展名分别记忆；用户修改后覆盖该源格式的默认目标。
- 首次语言跟随系统；手动选择 `zh-CN` 或 `en-US` 后使用 `flyingmouse.language.v1` 持久化。

## Conversion boundaries

- PDF → DOCX/XLSX 先由 `pdf-classifier.js` 分类；扫描/混合页尝试 `docstructure`。DOCX 仅在 `pdf.js` 允许的错误码下回退 OCR 段落并提示版式损失；扫描 XLSX 不伪造成功或输出空表。
- 原生 PDF → DOCX 优先 `docengine` 并检查内容完整性，失败回退 PDF.js/OCR；原生 PDF → XLSX 使用 `pdf-table-extractor.js` 的文字坐标/表格模型。轻量版、Win7、macOS 的可用引擎不同，必须按能力检测呈现目标与降级说明。
- HTML / Office → Markdown 必须共用 ATX 标题、fenced 代码块的 Turndown helper；CSV 使用锁定的 `csv-parse 7.0.2`（修复已知原型处理问题），禁止退回按换行拆分的简易解析器。
- 资源说明必须对应实现：普通图片、合并图片和通用 PDF 页数由 `resource-policy.js` 按设备内存计算有限预算；上传由 `upload-budget.js` 按实际临时盘空间累计约束并保护输出余量。超额明确拒绝，不跳页、不自动降采样。高级结构识别使用 `STRUCTURED_PDF_LIMITS` 与 Python `DEFAULT_LIMITS`，含 500 页、单页 50MP、每批最多 8 页且累计 100MP（144 DPI）；JS 串行分批且限制同时运行的完整识别请求。不得宣称无限制或保证任意文件 1:1 还原；Sharp 不得使用 `limitInputPixels: false`。
- PDF → PNG/JPG 使用 Poppler，并因多页输出 ZIP。
- 图片或扫描 PDF → TXT 使用 Tesseract OCR；图片 DOCX/Markdown 与 PDF Markdown 需传递质量和重排版式提示。多页 TIFF 必须逐页识别，动画仅识别首帧时明确提示。
- SRT/VTT/ASS/SSA 互转及 TXT 导出保留时间轴和 Unicode；样式/位置/精度损失要提示，不能静默丢弃无法表示的绘图或事件。
- 音频源不得暴露 MP4/WebM/MKV/MOV 等视频容器目标。
- 仅支持普通音乐格式转换，不支持其他音乐平台的加密特殊格式。公开源码、构建白名单、CLI、HTTP 和 UI 必须保持相同边界，不能以运行时开关隐藏平台专用代码后公开。

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
npm run dist:lite
npm run dist:appx
node scripts/build-win7.js --prepare-only
npm run dist:win7
node scripts/inspect-pe.js "output/win7-stage/dist/win-unpacked/FlyingMouse Format.exe"
npm audit --omit=dev --prefix output\win7-stage
```

沙箱限制 Node 子进程时可能出现 `spawn EPERM`；这不是转换代码失败。真实转换测试和打包应在普通 Windows PowerShell、cmd 或 CI 中运行。

完整本地测试依赖外置引擎。`.github/workflows/ci.yml` 在 main push 或 PR 时恢复锁定引擎并运行 `npm test`；普通修复分支 push 不触发。`release.yml` 在 `v*` 标签或手动 dispatch 时进入构建/发布流程。引擎资产必须同时匹配 `ci-engines-v1.json` 与原生引擎锁；不要跳过锁校验。

## Packaging and release

- `build.files` 是显式白名单；新增被服务端引用的根目录 JS 模块时必须同步加入。
- Windows 完整版按 `package.json` 打包 FFmpeg、AVS3、LibreOffice、Poppler、tessdata、Pandoc、docengine 和 docstructure 等引擎；`windows-lite-profile.js` 仅移除高级 docstructure。Windows OCR core 保留在 `app.asar.unpacked/node_modules/tesseract.js-core`，不得另加一份重复资源；macOS 资源由自己的配置定义。
- 保持 `signExecutable: false`，不要使用 `signAndEditExecutable: false`，后者会跳过图标嵌入。
- `npm run dist` 当前生成 NSIS 安装包和 `dist/win-unpacked`；不要假设 APPX 已同步生成。
- Microsoft Store 使用同一鼠鼠 UI 源码单独构建的 Windows 10/11 x64 APPX/MSIX；不得上传 NSIS，也不得提交 Win7 Legacy 包。上传前必须校验 Identity、Publisher、版本、架构、包内模块、鼠鼠图标和 SHA-256。
- Partner Center 的“包验证通过”“认证通过”“公开发布”是不同状态；外部状态只能按现场回读结果和绝对日期记录，不能由本地构建或上传成功推断。
- Store settings 写入必须保留 `settings-store.js` 的 `EXDEV` 跨卷回退，同卷仍用原子 rename。
- Store Office 默认逻辑缓存路径为 `%LOCALAPPDATA%\FMF\e\lo-<32位内容摘要前缀>`，避免 AppData 重定向后路径过长；完整内容键与文件清单校验仍保留。先显示窗口，再在自有独立子进程复制、校验与验证。只有 Office 任务等待，失败要可诊断；仅复用与内容及验证收据相符的缓存。见 [架构](docs/ARCHITECTURE.md)。
- 改动包内内容后必须整体重建 EXE 与 ASAR（完整性哈希绑定），不能只替换 ASAR；签名包需重签名。源码说明更新不等于现有安装包已重建。见 [发布流程](docs/RELEASE.md)。
- Windows 10/11 x64 使用 `native/launcher.cpp` 兼容启动入口；`afterSign` 完成原 Electron EXE 的 ASAR 绑定后，将其改名为 `FlyingMouse Format Runtime.exe`，再安装主入口。禁止在 `afterPack` 提前替换。需要 MSVC x64/Windows SDK；Win7 派生禁用该 hook，macOS 跳过。Store 打包同时验证入口、Runtime、ASAR 和公开功能边界。
- 发布前必须检查：完整测试、当前能力表中实际支持格式的真实转换样本、`npm audit --omit=dev`、ASAR 文件、引擎资源、EXE 产品版本、安装包 SHA-256、鼠鼠内嵌图标、桌面快捷方式、GitHub 资产摘要。AV3A 不在当前输入能力表内；平台专用音乐只在本地渠道单独记录真实样本结果。遗留 AVS3 资源或环境变量不能作为转换支持的证据，不得沿用已移除路径的 AV3A 发布门槛。
- `dist/win-unpacked` 是本机开发/验收入口；公开交付使用 Release 安装包。
- Win7 构建只允许使用 Node.js 18–22（推荐 22 LTS）和专用 `win7-package-lock.json` 经 `npm ci` 重建 `output/win7-stage/`；子进程必须绑定当前 Node，源码复制须兼容 Unicode 路径。产物写入精确的 `dist/FlyingMouse Format-Setup-<version>-win7-x64.exe`；脚本必须锁定 staging manifest/lockfile，校验本地 builder 与 `extraResources` 各自在允许根目录内的 canonical containment 并拒绝 reparse point；测试可以清理 staging，不得覆盖标准安装包或移动既有版本标签。
- Windows 7 发布证据必须同时记录：主线测试、staging 测试、内层 EXE PE 5.2、当前系统冒烟、旧依赖审计及“真实 Win7 设备待验收”。
- Win7 staging 测试由 `win7-build-profile.js` 过滤出能在 staging 自洽运行的文件；数量以当次日志为准。根专属真实引擎/打包管线测试由主线执行，不能把历史测试数量当成当前验收。
- GitHub remote：`https://github.com/LaoFeng-mouse/flyingmouse-format.git`。

## Documentation map

- `README.md`：面向用户的中英文介绍、下载与格式范围。
- `docs/ARCHITECTURE.md`：运行架构、状态和数据边界。
- `docs/RELEASE.md`：本机测试、打包、桌面同步与 GitHub 发布清单。
- `docs/HANDOFF.md`：唯一现役状态、交付入口及下一步；版本修复记录保留所属日期，不替代此入口。
- `docs/privacy-policy.html`：面向用户和 Microsoft Store 的隐私政策。
- `docs/微软商店上架清单.md`、`docs/上架材料包.md`：商店渠道资料；外部审核状态必须写绝对日期并注明是否已现场复核。

## 著作权与许可（2026-08-14 起强制执行）

- 作者：牢蜂（LaoFeng）。所有公开发布物（README、Release、安装包、UI、诊断文件、商店材料）必须保留作者署名。
- 许可证为非商用：禁止销售、转卖、收费服务、电商平台倒卖、套壳换皮重新发布。LICENSE 已从 MIT 更换为非商用许可。
- 任何界面文案/文档新增作者信息时：作者=牢蜂，禁止商用表述为「仅供个人免费使用，禁止商业售卖/转卖/套壳」。
- 包内版本号、README 当前版本、当次 release notes、package-lock/win7-package-lock 必须与 package.json 同步；历史 release notes 保留所属版本，不能机械替换。发版前逐一核对。
