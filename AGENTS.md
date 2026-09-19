# 当前候选：0.7.9 稳定性修复

本分支保留公开功能版 0.7.5–0.7.8 修复，并继续 0.7.9 无响应恢复、退出清理及转换入口修复。当前验收边界见 [REPAIR-0.7.9.md](docs/REPAIR-0.7.9.md)；0.7.8 记录为历史基线。0.7.7 CAD 工作未纳入；本地音乐专用模块不在公开分支。源码同步不代表安装器发布或 Microsoft Store 认证。

Windows 构建使用 package.json 的构建配置，需先准备锁定引擎与 MSVC。完整重建 EXE/ASAR 后由 afterSign 附加原生入口。不得关闭 GPU 或渲染器沙箱、全局重置 ACL 或按 Unknown Account 名称批量删除权限。

# AGENTS.md

## Project boundary

FlyingMouse Format（飞鼠格式）是 Windows Electron 离线文件转换器。主产品必须使用原版鼠鼠 UI；它与“鼠鼠打印”是两个独立项目，禁止跨项目修改或混合发布物。

当前技术栈：Electron 43、Windows 10/11 x64、鼠鼠 UI、中英文切换、批量转换、偏好与保存目录记忆。PDF 按原生/扫描内容分流，见 [架构](docs/ARCHITECTURE.md)；OFD 仅通过 `ofd-convert.js` 转 PDF，不走 LibreOffice。Windows 7 SP1 x64 只通过独立 staging 派生 Electron 22.3.27，禁止降低根 manifest 的主线依赖。当前候选与发布状态以 [0.7.9 修复说明](docs/REPAIR-0.7.9.md) 为准，不能从源码版本推断已安装或已发布版本。

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
- 资源说明必须对应实现：普通图片/批量限制当前由 `resource-policy.js` 的 `LIMITS` 决定（现为 `Number.MAX_SAFE_INTEGER` 占位，不能宣称固定 50MP/2GB 防护）；高级结构识别使用 `STRUCTURED_PDF_LIMITS` 与 Python `DEFAULT_LIMITS`，含 500 页、单页 50MP、每批最多 8 页且累计 100MP（144 DPI）；JS 串行分批，500 页与输出/内容预算仍按整份 PDF 校验。不得宣称无限制或保证任意文件 1:1 还原；Sharp 不得使用 `limitInputPixels: false`。
- PDF → PNG/JPG 使用 Poppler，并因多页输出 ZIP。
- 图片或扫描 PDF → TXT 使用 Tesseract OCR；图片 DOCX/Markdown 与 PDF Markdown 需传递质量和重排版式提示。多页 TIFF 必须逐页识别，动画仅识别首帧时明确提示。
- SRT/VTT/ASS/SSA 互转及 TXT 导出保留时间轴和 Unicode；样式/位置/精度损失要提示，不能静默丢弃无法表示的绘图或事件。
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
- 发布前必须检查：完整测试、当前能力表中实际支持格式的真实转换样本、`npm audit --omit=dev`、ASAR 文件、引擎资源、EXE 产品版本、安装包 SHA-256、鼠鼠内嵌图标、桌面快捷方式、GitHub 资产摘要。AV3A 和平台加密音频不在当前输入能力表内；遗留 AVS3 资源或环境变量不能作为转换支持的证据，不得沿用已移除路径的 AV3A 发布门槛。
- `dist/win-unpacked` 是本机开发/验收入口；公开交付使用 Release 安装包。
- Win7 构建只允许使用 Node.js 18–22（推荐 22 LTS）和专用 `win7-package-lock.json` 经 `npm ci` 重建 `output/win7-stage/`；子进程必须绑定当前 Node，源码复制须兼容 Unicode 路径。产物写入精确的 `dist/FlyingMouse Format-Setup-<version>-win7-x64.exe`；脚本必须锁定 staging manifest/lockfile，校验本地 builder 与 `extraResources` 各自在允许根目录内的 canonical containment 并拒绝 reparse point；测试可以清理 staging，不得覆盖标准安装包或移动既有版本标签。
- Windows 7 发布证据必须同时记录：主线测试、staging 测试、内层 EXE PE 5.2、当前系统冒烟、旧依赖审计及“真实 Win7 设备待验收”。
- Win7 staging 测试由 `win7-build-profile.js` 过滤出能在 staging 自洽运行的文件；数量以当次日志为准。根专属真实引擎/打包管线测试由主线执行，不能把历史测试数量当成当前验收。
- GitHub remote：`https://github.com/LaoFeng-mouse/flyingmouse-format.git`。

## Documentation map

- `README.md`：面向用户的中英文介绍、下载与格式范围。
- `docs/ARCHITECTURE.md`：运行架构、状态和数据边界。
- `docs/RELEASE.md`：本机测试、打包、桌面同步与 GitHub 发布清单。
- `docs/HANDOFF.md`：恢复工作入口；候选状态与剩余风险指向 `docs/REPAIR-0.7.9.md`。
- `docs/privacy-policy.html`：面向用户和 Microsoft Store 的隐私政策。
- `docs/微软商店上架清单.md`、`docs/上架材料包.md`：商店渠道资料；外部审核状态必须写绝对日期并注明是否已现场复核。

## 著作权与许可（2026-08-14 起强制执行）

- 作者：牢蜂（LaoFeng）。所有公开发布物（README、Release、安装包、UI、诊断文件、商店材料）必须保留作者署名。
- 许可证为非商用：禁止销售、转卖、收费服务、电商平台倒卖、套壳换皮重新发布。LICENSE 已从 MIT 更换为非商用许可。
- 任何界面文案/文档新增作者信息时：作者=牢蜂，禁止商用表述为「仅供个人免费使用，禁止商业售卖/转卖/套壳」。
- 包内版本号、README 当前版本、当次 release notes、package-lock/win7-package-lock 必须与 package.json 同步；历史 release notes 保留所属版本，不能机械替换。发版前逐一核对。
