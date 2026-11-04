> 当前版本 **0.8.3**：Windows 10/11 x64 公开完整版已发布。下载与验证记录见 [v0.8.3 Release](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.8.3) 和 [现役交接](docs/HANDOFF.md)。
> Current version: **0.8.3**, released for Windows 10/11 x64 (full build). See the [v0.8.3 Release](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.8.3) and [current handoff](docs/HANDOFF.md).

# FlyingMouse Format / 飞鼠格式

> 本次发布包含 ICO、普通媒体、电子书安全、依赖兼容和 PDF/OCR 长路径修复，保留 PDF/Word、OFD、Excel、CR2、资源预算与退出清理机制。此次提供 Windows 10/11 x64 完整版；Lite、Win7、macOS 和 Microsoft Store 包尚未构建或发布本版。

> A mouse-themed, offline Windows file converter. / 一款鼠鼠主题、可离线使用的 Windows 文件格式转换工具。

> **作者 Author：牢蜂（LaoFeng）**
>
> **⚠️ 非商用声明 Non-Commercial Notice：本软件仅供个人免费使用，禁止任何形式的商业售卖、转卖、套壳换皮重新发布（详见 [LICENSE](LICENSE)）。发现闲鱼/淘宝等渠道倒卖请告知作者，感谢！**

[![Release](https://img.shields.io/github/v/release/LaoFeng-mouse/flyingmouse-format?color=e95f6d)](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/latest)
![CI](https://github.com/LaoFeng-mouse/flyingmouse-format/actions/workflows/ci.yml/badge.svg)
![Platform](https://img.shields.io/badge/Release-Windows%2010%2F11%20x64-0078D6)
![License](https://img.shields.io/badge/License-Non--Commercial-e95f6d)

[下载最新版 / Download](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/latest) · [问题反馈 / Issues](https://github.com/LaoFeng-mouse/flyingmouse-format/issues)

![FlyingMouse Format mouse UI](public/assets/screenshots/home.png)

## 中文

### 主要功能

- 鼠鼠原版界面：鼠鼠会跟随上传、识别、批量、OCR、转换成功或失败切换状态。
- 本地离线转换：构建使用 FFmpeg、LibreOffice、Poppler、Tesseract 和 Pandoc 文档引擎；AV3A 不在当前支持范围内。
- 支持图片、文本、Word/WPS、Excel/WPS、PPT/WPS、PDF、音频、视频和 ZIP。
- 音频转换：支持 MP3 / WAV / FLAC / M4A / AAC / OGG / OPUS / WMA 等普通格式互转。仅支持普通音乐格式转换，不支持其他音乐平台的加密特殊格式。
- 视频编码选择：转视频时可选 H.264 / H.265 / AV1 编码（目标 mp4/mov/mkv 时显示）。
- 操作记忆：按“源文件格式”分别记住上次选择的目标格式；重新修改后，新选择会成为该源格式的默认值。
- 路径记忆：记住上次保存目录，下次保存时自动从该目录开始。
- 中文/English 界面：首次启动跟随系统语言，手动选择后会记住设置。
- 外观：可选择浅色、深色或跟随系统；切换系统外观时自动更新，选择会保存。
- Markdown → Word/PDF：保留标题、表格、嵌套列表、代码原文及可编辑 Word 公式；缺失图片或不支持的原始内容会提示。Win7 Legacy 未捆绑新版 Pandoc，因此不提供这两个目标。
- 批量转换：显示逐文件进度、结果和失败原因，并可单独保存或保存全部。
- 结果预览：转换完成后可在侧边抽屉预览图片、PDF、文本、音频和视频；窄窗口自动切换为底部面板。
- CLI 与 Agent 接入：命令行覆盖能力查询、目标查询、单个/批量转换、图片合并 PDF 和 PDF 合并；应用内可把配套 skill 一键接入现有 Codex、Claude 或通用 Agent 目录。
- 转换质量：HTML / Office 转 Markdown 保留标题、列表和代码块；CSV 支持 BOM、转义引号和字段内换行。
- PDF → Excel（智能表格提取）：支持电子文字坐标、扫描页 OCR、有框/无框表格、多表、跨页续接、合并单元格、低置信度批注与 Raw 回退。
- PDF → Word：Windows 10/11 优先使用版式引擎，检查文字覆盖后再接受结果；旋转文字和碎片正文可重建为可编辑段落，混合扫描页逐页处理。降级重建和 OCR 会显示说明；复杂多栏、图片定位和扫描标点不能保证与原 PDF 完全一致。
- PDF 拆分 / 加密 / 解密：PDF 可逐页拆分或每 N 页一组（打包 ZIP），也可用密码加密（AES-256）或解密（需原密码）。
- 电子书：txt/md/html → EPUB；EPUB → TXT/Markdown/HTML，以及有 LibreOffice 时转 PDF/DOCX。读取按章节目录排序，缺章、缺图、加密及不支持的 MOBI 压缩会明确失败；复杂 CSS 版式会简化。
- 图片合并 PDF 支持调整顺序：多张图片转 PDF 前可在队列中上移/下移，PDF 页序跟随队列顺序。
- HEIC/HEIF 图片可转换为 JPG/PNG/WebP 等（内置 ffmpeg 解码）。
- ICO 图标可转换为 PNG/JPG/WebP 等；PNG/JPG/WebP/SVG/BMP 等图片可生成多尺寸 ICO（16–256 像素，按原图大小选择档位）。保留透明背景、按比例补边，小图不强行放大。读取现代 PNG 图标和常见未压缩位图图标，取最大尺寸；不支持的编码或损坏文件会明确报错。
- TGA 图片可转换为 PNG/JPG/WebP 等（内置 ffmpeg 解码，实验性）。
- 相机 RAW 原片（CR2/CR3/NEF/ARW/DNG 等）可转换为 JPG/PNG/WebP/TIFF 等（Windows 版，实验性；CR2 使用 LibRaw，其余 RAW 使用 dcraw）。
- 资源保护：普通转换受引擎能力和机器内存约束；高级 PDF 结构识别限制为 500 页、单页 5000 万像素、每批最多 8 页且累计 1 亿像素（144 DPI）；整份超过单批预算时自动串行分批，仍保留总页数和全局输出预算，超限会明确提示。解码合法性与产物完整性校验保留。

> **渠道与使用范围：仅支持普通音乐格式转换，不支持其他音乐平台的加密特殊格式。请支持正版音乐，尊重创作者。音频版权归原作者/唱片公司，本工具与各音乐平台无任何关联。仅供个人免费使用，禁止商业售卖、转卖和套壳。**

### 快速开始

2026-11-04 发布的 Windows 完整版已完成入口、Runtime 和 ASAR 整体重建，完整测试 **1,368 通过、0 失败、11 条件跳过**，生产与全量 npm 审计均为 0 告警；17 组实际界面场景及安装包载荷校验通过。范围与限制见[现役交接](docs/HANDOFF.md)。

1. 在 [v0.8.3 Release](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.8.3) 下载 v0.8.3 对应系统的安装包：本次提供 [Windows 10/11 x64 完整版](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/download/v0.8.3/FlyingMouse-Format-Setup-0.8.3-x64.exe)。可用同页的 `SHA256SUMS.txt` 校验下载。
2. 安装并启动 FlyingMouse Format。
3. 拖入文件，选择目标格式并开始转换。
4. 选择保存位置；软件会记住目标格式与保存目录。

从源码运行：

主线要求 **Node.js 22.13.0 或更新版本**。在独立物理目录中执行 `npm ci`，安装结束会自动核验并应用四份已记录的兼容补丁，构建前再次检查；补丁内容与上游许可证见 [依赖补丁说明](third-party/dependency-patches/NOTICE.md)。Windows 7 使用独立环境与锁文件。

> 源码仓库不包含体积较大的 FFmpeg、LibreOffice、Poppler 和 Tesseract 资源；普通用户请直接下载 Release 安装包。开发者从源码运行完整转换功能前，需要自行准备 `bin/` 下的引擎资源。

Windows 10/11 x64 的 CR2 引擎另用 `npm run restore:libraw` 恢复。脚本从锁定的 LibRaw 与微软官方归档下载、校验 SHA-256 并解包到 `bin/libraw`，不会运行系统安装器。完整构建和验证步骤见 [发布流程](docs/RELEASE.md)。

```powershell
npm ci
npm run desktop
```

命令行示例：

```powershell
node cli.js capabilities --json
node cli.js targets example.pdf --json
node cli.js convert input.docx --to pdf --output output.pdf --json
node cli.js convert a.png b.png --to webp --output-dir converted --json
node cli.js images-to-pdf 1.jpg 2.jpg --output album.pdf --json
node cli.js merge-pdfs a.pdf b.pdf --output merged.pdf --json
```

安装版也可直接调用应用入口：macOS 使用 `FlyingMouse Format.app/Contents/MacOS/FlyingMouse Format --cli ...`，Windows 使用 `FlyingMouse Format.exe --cli ...`。在软件顶部点击“接入 Agent”，会检索已存在的 `~/.codex/skills`、`~/.claude/skills`、`~/.agents/skills`（Windows 对应用户目录）并在确认后安装或更新 skill；不会自动创建未安装产品的目录。

通用测试与打包命令（不会因阅读本文自动执行）：

```powershell
npm test
npm run dist
```

### Windows 版本选择

- **Windows 10 / 11 x64（完整版，已发布）**：构建文件为 `FlyingMouse Format-Setup-0.8.3-x64.exe`，公开下载名为 `FlyingMouse-Format-Setup-0.8.3-x64.exe`；仅将名称中的空格换为连字符，安装器字节相同。使用 Electron 43、Sharp 0.35 和 PDF.js 6，包含高级扫描表格引擎。
- **Windows 10 / 11 x64（轻量版）**：构建目标为 `FlyingMouse Format-Lite-Setup-0.8.3-x64.exe`，保留常用转换与 OCR；高级扫描表格需要完整版。本次未构建或发布轻量版。
- **Windows 7 SP1 x64（兼容版）**：构建文件为 `FlyingMouse Format-Setup-0.8.3-win7-x64.exe`。它使用同一源码和鼠鼠 UI，但在独立环境固定 Electron 22.3.27、Sharp 0.32.6 与 PDF.js 2.16.105；本轮尚未构建。

Windows 7 兼容版是 Legacy 构建，不会降低标准版依赖。其 Electron 22 已停止上游安全维护，并包含无法在 Windows 7 上直接升级的已知依赖风险；PDF.js 动态代码执行已通过 `isEvalSupported: false` 缓解，但仍只建议离线处理可信文件。v0.8.3 的验收进度以修复记录为准；Win7 构建及真实 Windows 7 SP1 x64 设备仍待验收。Windows 安装包均未签名，SmartScreen 可能提示。

### macOS 版本选择

- **Apple Silicon（M1 及更新）**：构建目标 `FlyingMouse Format-Setup-0.8.3-mac-arm64.dmg`。
- **Intel Mac**：构建目标 `FlyingMouse Format-Setup-0.8.3-mac-x64.dmg`。

macOS 构建目标为 macOS 11 及更新版本，未签名且未公证，可能触发 Gatekeeper。本次源码的 macOS x64/arm64 引擎与代码 CI 已通过，但两个架构均未构建或发布 v0.8.3 安装包，真实 Mac 设备仍待验收；CI 不能替代安装包与设备验收。

Win7 Legacy 构建命令：

```powershell
npm run dist:win7
```

Win7 staging 使用专用 `win7-package-lock.json` 和 `npm ci` 重建；推荐使用 Node.js 22 LTS（构建脚本接受 18–22，其他主版本会在改动 staging 前拒绝）。构建脚本会绑定子进程到当前 Node、以 Unicode 安全方式复制源码、锁定 staging manifest/lockfile，并校验本地 builder 与打包资源没有越过各自允许的根目录或经过 junction/符号链接。

仅需检查 staging 时可运行 `node scripts/build-win7.js --prepare-only`；它不会打包。完整构建会重新准备 staging。

## English

### Highlights

- Original mouse UI with animated state changes for upload, detection, batch work, OCR, success, and errors.
- Local audio/document processing with bundled conversion engines. AV3A is not supported.
- Converts images, text, Word/WPS, Excel/WPS, PPT/WPS, PDF, audio, video, and ZIP files.
- Ordinary audio conversion: MP3 / WAV / FLAC / M4A / AAC / OGG / OPUS / WMA. Encrypted proprietary music-platform formats are not supported.
- Video codec selection: H.264 / H.265 / AV1 for video conversion (shown when targeting mp4/mov/mkv).
- Remembers the chosen target separately for each source extension. Changing it replaces that extension's default.
- Remembers the last save directory for the next save dialog.
- Chinese and English UI. The first launch follows the system language; a manual choice is remembered.
- Batch conversion with per-file progress, results, error details, individual save, and Save All.
- Result previews for images, PDFs, text, audio, and video in a responsive side drawer / bottom sheet.
- A complete CLI plus one-click Agent skill installation for existing Codex, Claude, and generic Agent skill directories.
- Higher-quality text conversion: structural HTML/Office Markdown plus standards-compliant quoted and multiline CSV parsing.
- PDF → Excel smart table extraction for digital text and scanned pages, including multiple tables, continued pages, merged cells, confidence notes, and Raw fallback.
- PDF → Word: Windows 10/11 first uses docengine and validates content coverage; permitted failures may fall back to structured extraction or editable OCR text with fidelity warnings. Engine availability depends on the build; exact layout is not guaranteed.
- PDF split / encrypt / decrypt: split a PDF per page or into groups of N pages (packed as a ZIP), or password-protect it (AES-256) and decrypt it (requires the original password).
- E-books: txt/md/html → EPUB (generated locally); EPUB → TXT/Markdown; MOBI → EPUB/TXT/Markdown (MOBI parsing is experimental; complex layouts may be incomplete).
- Image-to-PDF ordering: when merging multiple images into a PDF, reorder items with up/down controls before converting; PDF page order follows the queue.
- HEIC/HEIF images convert to JPG/PNG/WebP and more (built-in ffmpeg decoding).
- ICO icons convert to PNG/JPG/WebP and more. PNG/JPG/WebP/SVG/BMP images produce multi-size ICOs (16–256 px, selected for the source size), preserving transparency and proportions without enlarging small images. Modern PNG and common uncompressed bitmap icons use the largest frame; unsupported or damaged data is rejected.
- TGA images convert to PNG/JPG/WebP and more (built-in ffmpeg decoding, experimental).
- Camera RAW files (CR2/CR3/NEF/ARW/DNG, etc.) convert to JPG/PNG/WebP/TIFF and more (Windows build, experimental; LibRaw for CR2 and dcraw for other RAW files).
- Resource safeguards: ordinary conversions depend on engine capacity and available memory. Advanced PDF structure recognition is limited to 500 pages, 50 megapixels per page, and 8 pages and 100 megapixels per batch at 144 DPI; larger documents are processed in serial batches while document-wide page and output budgets remain enforced. Decode-validity and output-integrity checks remain.

> **Build scope: ordinary audio conversion only; encrypted proprietary music-platform formats are not supported. Please support artists and respect copyright. Audio copyrights belong to their respective artists/labels; this tool is not affiliated with any music platform. Free for personal use only; commercial resale or repackaging is prohibited.**

### Quick start

The Windows full build released on November 4, 2026 has a rebuilt launcher, Runtime and ASAR. Validation recorded **1,368 passing tests, zero failures and 11 conditional skips**, zero production/full npm audit findings, 17 GUI scenarios, and verified installer payloads. See the [current handoff](docs/HANDOFF.md) for scope and limitations.

1. Download the [Windows 10/11 x64 full installer](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/download/v0.8.3/FlyingMouse-Format-Setup-0.8.3-x64.exe) from [v0.8.3 Release](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.8.3). Verify it with the accompanying `SHA256SUMS.txt` if desired. This release does not include new Lite, Win7, macOS or Microsoft Store packages.
2. Install and launch FlyingMouse Format.
3. Drop in files, choose a target, and convert.
4. Choose a save location. The app remembers both the target preference and save folder.

> The source repository excludes the large FFmpeg, LibreOffice, Poppler, and Tesseract bundles. Regular users should install the Release build. Developers need to provide the corresponding resources under `bin/` for the complete conversion feature set.

The main development environment requires **Node.js 22.13.0 or newer**. Run `npm ci` in a physical project directory: installation verifies and applies four documented compatibility patches, and packaging verifies them again. See the [patch notice](third-party/dependency-patches/NOTICE.md) for changes and upstream licenses. Win7 keeps its separate environment and lockfile.

CLI examples:

```powershell
node cli.js capabilities --json
node cli.js targets example.pdf --json
node cli.js convert input.docx --to pdf --output output.pdf --json
node cli.js convert a.png b.png --to webp --output-dir converted --json
node cli.js images-to-pdf 1.jpg 2.jpg --output album.pdf --json
node cli.js merge-pdfs a.pdf b.pdf --output merged.pdf --json
```

Packaged builds accept the same commands after `--cli`: use `FlyingMouse Format.app/Contents/MacOS/FlyingMouse Format --cli ...` on macOS or `FlyingMouse Format.exe --cli ...` on Windows. “Connect to Agent” discovers existing Codex, Claude, and generic Agent skill directories and installs the bundled lightweight wrapper after confirmation.

### Choose a Windows build

- **Windows 10 / 11 x64 (full, released):** the build output is `FlyingMouse Format-Setup-0.8.3-x64.exe`; the public download is named `FlyingMouse-Format-Setup-0.8.3-x64.exe`. Only the space in the name is replaced with a hyphen; installer bytes are identical. Includes Electron 43, Sharp 0.35, PDF.js 6, and the advanced scanned-table engine.
- **Windows 10 / 11 x64 (lite):** the build target is `FlyingMouse Format-Lite-Setup-0.8.3-x64.exe`, retaining common conversions and OCR; advanced scanned tables require the full build. No v0.8.3 Lite package has been built or released.
- **Windows 7 SP1 x64 (compatibility build):** the output would be `FlyingMouse Format-Setup-0.8.3-win7-x64.exe`, derived from the same source and mouse UI with Electron 22.3.27, Sharp 0.32.6, and PDF.js 2.16.105 pinned in isolation. This candidate has not been built for Win7.

The Windows 7 package is a Legacy build and does not downgrade the standard build. Electron 22 no longer receives upstream security maintenance, and other known legacy dependency risks cannot be upgraded without dropping Windows 7. PDF.js dynamic evaluation is disabled as a mitigation, but this build should remain offline and process trusted files only. See the [current handoff](docs/HANDOFF.md) for this source branch's validation; Win7 builds and physical Windows 7 SP1 x64 acceptance remain pending. The published Windows installer is unsigned and may trigger SmartScreen.

### Choose a macOS build

- **Apple Silicon (M1 or newer):** build target `FlyingMouse Format-Setup-0.8.3-mac-arm64.dmg`.
- **Intel Mac:** build target `FlyingMouse Format-Setup-0.8.3-mac-x64.dmg`.

macOS builds target macOS 11 or newer and are unsigned and unnotarized, so Gatekeeper may warn. This source passed macOS x64/arm64 engine and code CI, but neither v0.8.3 macOS installer has been built or released. Physical Mac acceptance remains pending; CI does not replace package or device validation.

Win7 Legacy build command:

```powershell
npm run dist:win7
```

The Win7 staging tree is rebuilt with its dedicated `win7-package-lock.json` via `npm ci`. Node.js 22 LTS is recommended (host majors 18–22 are accepted; other majors fail before staging changes). The script binds child processes to the active Node, copies sources safely on Unicode paths, binds the staged manifest/lockfile, and rejects local builder or packaged resources that escape their allowed roots or traverse junctions/symlinks.

Use `node scripts/build-win7.js --prepare-only` only to inspect staging without packaging. A complete build prepares staging again.

## Supported formats / 支持格式

| Category / 类别 | Input / 输入 | Output / 输出 |
|---|---|---|
| Images / 图片 | jpg, png, webp, avif, tiff, gif, bmp, svg, ico, tga, heic, heif, cr2, cr3, crw, nef, arw, dng, raf, rw2, orf, pef, srw, 3fr, erf, fff, iiq, kdc, mef, mrw, x3f | png, jpg, webp, avif, tiff, gif (动图), ico (16–256 px), pdf, txt (OCR), mp4, webm |
| Text / 文本 | txt, md, html, json, csv, log, xml, yaml | txt, md, html, json, csv, pdf, docx, epub |
| E-book / 电子书 | epub, mobi | txt, md, epub (mobi→epub 实验性) |
| Word/WPS | doc, docx, odt, rtf, wps, wpt, wpd | pdf, docx, odt, rtf, txt, html, md |
| OFD | ofd | pdf；支持基本文字、PNG/JPEG 图片和矢量路径；复杂签章、裁剪等未实现内容明确报错，逐页检查意外空白 / basic text, PNG/JPEG and paths; unsupported content is rejected and unexpected blank pages are checked |
| Excel/WPS | xls, xlsx, xlsm, ods, csv, tsv, et, ett | pdf, xlsx, xls, ods, csv, html |
| PPT/WPS | ppt, pptx, odp, dps, dpt | pdf, pptx, odp, html, png, jpg (逐页转图 zip) |
| PDF | pdf | xlsx, docx, txt, html, png, jpg, split/解密 PDF |
| Audio / 音频 | mp3, wav, flac, m4a, aac, ogg, opus, wma | mp3, wav, flac, m4a, ogg, aac, opus, wma |
| Video / 视频 | mp4, mov, mkv, webm, avi, m4v, wmv, flv | mp4, webm, mkv, mov, gif, mp3, wav, flac, m4a, ogg, aac, opus, wma |
| ZIP / 压缩包 | zip | pdf (图片合并) |
| Any file / 任意文件 | any | zip |

## Privacy and security / 隐私与安全

- Audio and document files are processed locally. This public source does not access music-platform credentials or key stores. / 音频和文档在本机处理；公开源码不访问音乐平台凭据或密钥库。
- Electron uses context isolation, sandboxing, restricted navigation, and a local-only random port. / Electron 使用上下文隔离、沙箱、导航限制和仅本机可访问的随机端口。
- The Windows installer is currently unsigned, so SmartScreen may show a warning. / 当前 Windows 安装包尚未签名，SmartScreen 可能显示提示。
- [Privacy policy / 隐私政策](docs/privacy-policy.html)

## License / 许可证

**非商用许可 Non-Commercial License** — 作者：牢蜂（LaoFeng）。

- 允许个人免费使用与传播（须保留作者署名与本协议）。
- **禁止商业用途**：禁止销售、转卖、收费提供服务、在电商平台（闲鱼/淘宝/拼多多等）倒卖。
- **禁止套壳换皮**：禁止对本软件改名、换肤、重新打包后冒充自有产品发布。
- 二次开发公开发布须显著标注原作者，并遵守同样的非商用限制。
- 内置第三方组件遵循各自许可证。
- 内置 docengine 文档引擎含 **PyMuPDF**（AGPL-3.0）：许可文本与源码获取见 [PyMuPDF 官方仓库](https://github.com/pymupdf/PyMuPDF)，本软件的完整源码与许可证汇总见 [GitHub Issues](https://github.com/LaoFeng-mouse/flyingmouse-format/issues)（按 AGPL 要求提供源码获取途径）。

完整条款见 [LICENSE](LICENSE)。/ Full terms in [LICENSE](LICENSE).

发现任何渠道倒卖本软件，欢迎通过 GitHub Issues 联系作者举报。

## Support / 支持

FlyingMouse Format is free, offline, and has no ads. If it helped you, you can buy Mouse a dried fish — completely optional. / 飞鼠格式免费、离线、无广告。如果它帮到了你，欢迎请鼠鼠吃根小鱼干，纯自愿。

![WeChat payment QR / 微信收款码](public/assets/sponsor-qr.jpg)
