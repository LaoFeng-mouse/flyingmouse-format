# FlyingMouse Format 交接

更新时间：2026-08-12（v0.3.5 审计修复后）

## 项目边界

- GitHub：<https://github.com/LaoFeng-mouse/flyingmouse-format>
- 当前 GitHub Release：<https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.3.5>
- 产品是原版鼠鼠 UI 的 FlyingMouse Format（飞鼠格式）；“鼠鼠打印”是另一个项目，本版没有修改。
- v0.3.5 使用同一源码生成 Windows 10/11、Windows 7 Legacy、macOS Apple Silicon 和 macOS Intel 四个安装包，不覆盖旧标签。

## v0.3.5 审计修复（2026-08-12，main 领先 v0.3.5 标签 6 个提交）

GPT 桌面端对已上传微软商店的 v0.3.5（标签 `075c56f`）做了 51 分钟全面审计，发现“测试全绿、用户仍转换失败”的真实缺陷。本地 agent 复现全部缺陷后修复并推送（`943411e` feat / `f872894` chore / `b0bd537` test / `b002a9c` docs）：

| 缺陷 | 修复 | 实测 |
|---|---|---|
| 扫描版 PDF→Word：500 + 错误文案错写“转 Excel” | 文案按目标区分；扫描版自动 OCR 回退生成可编辑 DOCX（`PDF_OCR_REQUIRED` 稳定错误码） | 扫描全能王 PDF→DOCX 200，正文段落完整 |
| BMP→PNG：sharp 0.35.3 不支持 BMP 输入，500 | 新增 `bmp-input.js` 纯 JS 解码器（24/32 位、1/4/8 位调色板、负高度；RLE 明确报错 `BMP_UNSUPPORTED_VARIANT`），接入全部图片目标 + 批量/ZIP 图片→PDF；只读文件头判断避免整读大图 | BMP→PNG/JPG/PDF 200，PNG 魔数校验 |
| XLSX→CSV：exceljs 预检读不了带命名空间前缀的 workbook.xml，500 | 预检降级为警告 `XLSX_CSV_PREVIEW_UNAVAILABLE`，不阻塞 LibreOffice 实际转换 | 带前缀 XLSX→CSV 200，内容正确 |
| PPTX→HTML：LO 的 pptx→html 导出过滤器只输出空页面框架，质量门禁 500 | 改 LO→PDF→pdfjs 文本提取生成可读 HTML；纯图片 PPT 明确报 `PRESENTATION_HTML_EMPTY` | PPTX→HTML 200，含页标题 |
| CSV→Markdown：假实现（输出原始 CSV） | `csvToMarkdown` 真解析成 Markdown 表格（表头/分隔行/单元格 `\|` 与换行转义，严格 CSV 解析） | 200，输出表格 |
| XML/YAML→JSON：假实现（`{"text":原文}` 包装） | `xml-json.js` 轻量 XML→JSON 解析器（属性 `@` 前缀、重复标签数组、CDATA）；YAML 用 js-yaml 真解析；失败报 `XML_JSON_PARSE_FAILED` / `YAML_JSON_PARSE_FAILED` | 200，输出解析结构 |
| HTML→DOCX：标题/列表被压成普通段落 | `convertTextToDocx` 识别 h1-h6（字号加粗）与 li（• 缩进）块级结构 | 200，docx 含 `w:sz 36` 标题与 2 个列表项 |
| PDF→Word 能力提示不准确 | README 中英文标注为“可编辑内容提取”，明确不保留图片/字体/颜色/页眉页脚/复杂版式 | — |

验证：修复后实测 21/21 通过（内容级断言）；本地全量 `node --test`（cmd 环境）279 项 = 277 通过、2 预期 skip（NCM/KGG 缺 fixture）、0 失败（含原 tar 假失败，cmd 环境 bsdtar 正常）；`test:ci` 232 项全过。新模块已登记 `build.files` 白名单，js-yaml@4.3.1 已同步 win7-package-lock.json。

## v0.3.5 新增

- PDF → Word（DOCX）：pdfjs 提取文本与表格，生成标准 OOXML（多列表格转 `<w:tbl>`、单列转段落），零新依赖（yazl 打包）。
- 视频 → GIF（ffmpeg palettegen/paletteuse，fps=10、宽度 ≤480）；WebP 动图 → GIF（sharp 保留帧数）。
- XLSX/XLSM → XLS 老版 Excel（LibreOffice MS Excel 97 过滤器，OLE2 输出）。
- ZIP → PDF：yauzl 惰性读取，仅合并图片类条目；拒绝含 `..` 的路径（防 zip-slip），文件名 sanitize + 序号前缀。
- PPT/WPS → PNG/JPG：LibreOffice 转 PDF → Poppler 逐页转图 → ZIP 打包。
- PDF 拆分/解密动作：PDF→PDF 时可选逐页拆分（ZIP）或输入密码解密（pdf-lib 原生）；加密因 pdf-lib 无加密 API 暂不可用，明确报错 `PDF_ENCRYPT_UNAVAILABLE`。
- PDF→Excel 扫描件 OCR 质量门禁：OCR 页面最低置信度 < 65% 时明确报错 `PDF_TABLE_OCR_LOW_QUALITY`（双语说明模糊/倾斜/阴影等原因），不再输出乱码表格。
- 无声视频转音频：探测音轨，无音轨时报 `MEDIA_NO_AUDIO_TRACK`（422，双语），不再回传原始 ffmpeg 错误。

## GitHub v0.3.5 成品

| 平台 | 远端资产 | 字节 | SHA-256 |
|---|---|---:|---|
| Windows 10/11 x64 | `FlyingMouse.Format-Setup-0.3.5-x64.exe` | 551,226,275 | `51f5355428e73447accc27192d7f1c4e38e223bd5df417dbc539397c780b516c` |
| Windows 7 SP1 x64 | `FlyingMouse.Format-Setup-0.3.5-win7-x64.exe` | 520,619,411 | `88286352a9b9016c812db8800ff68cb4e6772bdb461c5220179bcef5c8cb110c` |
| macOS Apple Silicon | `FlyingMouse.Format-Setup-0.3.5-mac-arm64.dmg` | 681,558,079 | `9a64f5107dd38593d5825bdda29f08e6de83e7e6dc075d55998a56887f4c93bc` |
| macOS Intel | `FlyingMouse.Format-Setup-0.3.5-mac-x64.dmg` | 716,999,507 | `241e5c574ef5acaa61aca627b0daf3d97c07d169f5ee396784acc2befe672f34` |

四个资产均已在 Release 回读（名称/大小一致，非 draft、非 prerelease、Latest）。标签 v0.3.5 指向 `075c56fb6179742e7e4a1fe672c228048fa140bf`；main 领先标签两个提交：`bdbbf75`（docs: record v0.3.5 release evidence）、`1f3fa4c`（fix: silent-video audio track 友好报错）——**音轨修复不在 v0.3.5 安装包内，随下版发布**。

## 最终验证证据

- CI `31411191151`（push main）：Windows、macOS arm64、macOS x64 三条门禁全部通过。
- 标签 Release workflow `31411904123`：四平台真实转换、审计、构建、包检查和冒烟全部通过；产出 win7 x64 与 macOS 两个 DMG（本地只构建标准 x64）。
- 本地全量 `node --test`：251 项 = 247 通过、3 个预期 skip、1 个本机 git-bash tar 假失败（`tar: Cannot connect to C:`，CI Windows runner 无此问题）、0 真实失败；根生产依赖审计 0 漏洞。
- 逐功能审查：8 个新格式功能全部过审，无 P0/P1；ZIP 防 zip-slip、密码仅本地处理、稳定错误码（`PDF_TABLE_OCR_LOW_QUALITY` / `PDF_ENCRYPT_UNAVAILABLE` / `MEDIA_NO_AUDIO_TRACK`）。
- 组合实测 9 项（静态图→gif、png→avif、avif→jpg、动图→jpg 压平、视频→gif、无声/有声视频→音频、未知扩展名→zip、未知→pdf 拒绝）全部符合预期。
- conversion 测试 41 项 = 38 通过 + 1 tar 假失败 + 2 skip（含无声视频 422 回归）。
- Windows x64 安装包 NSIS 外壳 PE32、目标 OS `4.0`；本机已装 0.3.5.0（win-unpacked 拷贝法；NSIS 静默 `/S` 在本机卡死并删旧目录，属本机环境坑）。

## 风险和未完成的外部验收

- Windows 安装包未签名，SmartScreen 可能提示；macOS DMG 未签名且未公证，Gatekeeper 可能提示。
- 自动化、PE 检查和当前 runner 冒烟不能冒充真实 Windows 7 SP1 x64 或真实 Mac 设备验收；两项物理设备验收仍待完成。
- NCM 仅保证网易云客户端 `music.163.com` 来源的标准文件；macOS 不支持依赖 Windows 专用解码器的 AV3A NCM。
- 拍照扫描件（透视/阴影）OCR 是 Tesseract 能力极限：低置信度会明确报错而非乱码（PDF→XLSX 有置信度门禁；PDF→DOCX/TXT/HTML 走 OCR 回退时识别不出会明确报错）；如需此类转出，需换 PaddleOCR 级引擎（工程量大，下版再议）。
- HEIC/HEIF 输入依赖打包 sharp 的解码能力，仍标注为实验性；无真实样本实测（本机 sharp 无 heif 编码器，解码器存在性待真实样本确认）。
- 本机安装的 0.3.5.0 不含审计修复与 `1f3fa4c` 音轨修复；需下版打包（v0.3.6）或重打包更新。
- Microsoft Store 仍是 v0.3.3 Submission 2（ID `1152921505701615843`）。最后现场状态为 `Pre-processing in progress` / `In certification`；本轮没有上传 v0.3.5 商店包，也不能声称已经通过认证或公开发布。v0.3.5 审计缺陷已修复但尚未重新打包/提交商店；是否撤回当前认证、改发 v0.3.6 待用户决策。

发布流程见 [RELEASE.md](RELEASE.md)，代码结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。
