# FlyingMouse Format 交接

更新时间：2026-08-12（v0.3.6 构建）

## 项目边界

- GitHub：<https://github.com/LaoFeng-mouse/flyingmouse-format>
- 当前 GitHub Release：<https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.3.5>
- 产品是原版鼠鼠 UI 的 FlyingMouse Format（飞鼠格式）；“鼠鼠打印”是另一个项目，本版没有修改。
- v0.3.5 使用同一源码生成 Windows 10/11、Windows 7 Legacy、macOS Apple Silicon 和 macOS Intel 四个安装包，不覆盖旧标签。

## v0.3.6 新增与修复（2026-08-12，用户反馈清单）

| 项 | 处理 | 状态 |
|---|---|---|
| HEIC/HEIF 转 JPG 失败 | sharp 的 libheif 只编译了 AV1，解不了 HEVC 像素；改为入口用打包内置 ffmpeg（hevc 解码器）转 PNG 再走 sharp 链路（与 BMP 中转同模式），单图与批量/ZIP 图片→PDF 全覆盖 | 实测 sample.heic→JPG/PNG/WebP/PDF 全 200 |
| mflac 无法转 mp3 | 新增 `mflac-format.js` 支持三类变体：QMC2 v1（尾部 keyLen+key 离线解密）、QTag（内嵌 ekey）、musicex（新版，需 QQ 音乐登录凭据在线 GetEVkey 换密钥，复用 kgg-format.js 的 ekeyDecrypt/createQMC2 原语）；错误码 MFLAC_DECRYPT_FAILED / MFLAC_EKEY_REQUIRED / MFLAC_EKEY_NETWORK 归入 422；cookie 默认读桌面 QQ音乐_登录cookie.txt（FLYINGMOUSE_QQ_COOKIE 可覆盖） | 真实样本双通过：任然-无人之岛（flac 4:45）+ doa-英雄（flac 3:21）→ 转 MP3 全链路 PASS；musicex 依赖在线凭据（104003=凭据过期），仍标实验性 |
| txt/mobi 等电子书 | 新增 `ebook.js`：txt/md/html→EPUB（yazl 纯生成，mimetype stored）；EPUB→TXT/MD（spine 解析）；MOBI→EPUB/TXT/MD（PDB+PalmDOC 解析，实验性） | Gutenberg alice.epub/mobi 实测通过 |
| 图片合并 PDF 无法控制顺序 | 批量图片→PDF 队列加 ↑/↓ 排序按钮（三数组同步 swap，PDF 页序=队列顺序） | UI 完成 |
| ncm 转 mp3 日文乱码 | 根因：ncm 路径被强制 `-id3v2_version 3`（UTF-16），部分播放器读乱；改为与全局一致的 v2.4（UTF-8） | 实验验证 v2.4 标签 UTF-8 无损 |
| 任务栏图标黑边 | build/icon.png 透明区域 RGB 是黑的；透明像素 RGB 置白（177,379 像素），黑色透明残留归零 | 需重打包+刷图标缓存生效 |
| 软件内存太大 | 实测 idle 约 372MB（主进程 142MB），Electron 43 正常水平，无泄漏；转换峰值来自引擎进程（按需启动） | 已给数据，无明显可优化点 |
| PDF 转 Excel 乱 | 造跨页/无框/多列复杂表格样本实测提取正常（P001 14 行 + P002 跨页续接）；拍照扫描件是 OCR 能力极限（已明确报错） | 需用户真实文件定位具体"乱" |
| CSV/TSV 转换全部 500（假成功） | **实测发现**：LibreOffice headless 对分隔文本（csv/tsv）导入是假成功——exit 0 但零输出，原 csv/tsv→xlsx/xls/ods/pdf/html/epub 全部报 500。改为自有实现：csv/tsv→xlsx 用 exceljs 生成真工作表、→html 自生成 HTML 表格、→pdf 自生成 HTML 走 LO html→pdf（可靠管线）、→epub 走文本转 EPUB；tsv 归一化为逗号 CSV 复用同管线；UI 隐藏 xls/ods 避免 500 | csv/tsv→xlsx 单元格级断言、epub mimetype、pdf %PDF 头全过 |
| txt/md/log→JSON 仍是 {"text":原文} 包装 | v0.3.5 审计修了 XML/YAML，漏了无结构文本；加 TEXT_JSON_WRAPPED 警告明确告知（不再静默假装解析） | 警告断言通过 |
| PDF/PPT→PNG/JPG 模糊 | pdftoppm 只渲染 150 DPI（A4 1240px 宽）；提到 300 DPI（2480px，打印级，单页仅 52KB） | 已改，PDF→png 测试通过 |
| 稳定错误码 500 | PDF_ENCRYPT_UNAVAILABLE / PRESENTATION_HTML_EMPTY / BMP_UNSUPPORTED_VARIANT / JSON_CSV_PATH_COLLISION / PDF_TABLE_OCR_LOW_QUALITY 归入 422 客户端错误 | 加密断言 500→422 更新 |
| 视频→GIF 模糊 | 宽度 480→720、fps 10→12、palettegen stats_mode=diff + sierra2_4a 抖动（实测 720x406/12.5fps，1 秒仅 210KB） | 已改 |
| WebP 二次压缩损伤 | 静态+动图 quality 80→90 | 已改 |
| 内存占用大 | 禁用硬件加速（省 GPU 进程 40-80MB）+ 限制主进程 V8 堆 1GB（转换走原生模块不受影响） | 待重打包实测 |
| 测试基建 | conversion.test.js 拆分解压从 tar 改为 yauzl（git-bash GNU tar 把 C:\ 当远程主机假失败，导致全量偶发失败） | 全量 296 = 294 过 + 2 skip |

验证：本地全量 296 项 = 294 通过、2 预期 skip（NCM/KGG 缺 fixture）、0 失败；`test:ci` 240 项全过。新模块已登记 build.files（ebook.js / mflac-format.js / bmp-input.js / xml-json.js）。

## v0.3.6 发布状态（2026-08-12）

- 本机已升级 0.3.6.0（win-unpacked 拷贝法，FileVersion 0.3.6 / ProductVersion 0.3.6.0，图标缓存已刷）。软件未运行时替换。
- tag `v0.3.6` 指向 `c9ef37c`（含自动更新）；Release workflow `31564182693` 三 job 全绿。
- **NSIS 版自动更新已上线**：electron-updater@6.8.9 + build.publish GitHub provider；electron-main.js setupAutoUpdater（打包环境且非商店版时静默检查/自动下载/退出安装）；latest.yml + blockmap 已传 Release；商店版跳过（商店自行更新）。
- Release `v0.3.6` 已公开、非 draft、非 prerelease、Latest；资产 6 个：
  | 资产 | 字节 | SHA-256 |
  |---|---|---|
  | FlyingMouse-Format-Setup-0.3.6-x64.exe | 551,481,995 | `4e81c5dbf65637753a553a60483ff77ac40e0d214d54c56ec5e2c10d979bd429` |
  | FlyingMouse-Format-Setup-0.3.6-x64.exe.blockmap | 569,949 | —（自动更新差量） |
  | latest.yml | 373 | —（自动更新元数据） |
  | FlyingMouse.Format-Setup-0.3.6-win7-x64.exe | 520,578,060 | `98d60368d8240eba82448b6a5cee4dd1d38c1bd1170285057f5249a5ad644ee3` |
  | FlyingMouse.Format-Setup-0.3.6-mac-arm64.dmg | 681,853,883 | `ae6acd9100ddcd9c06160ba298d57521b593b37926b7dc84bb1861c8fbb04d00` |
  | FlyingMouse.Format-Setup-0.3.6-mac-x64.dmg | 717,266,776 | `a644ce71714c6b2e1d8d20026a80bc76e1101a7f8bb8e5d034f0ef0dc7ed891a` |
- 商店 APPX `FlyingMouse Format-Setup-0.3.6-x64.appx`（781,295,280 字节，SHA-256 `4f627586440cdf3c598659a6938f72d0333e4a093fa5c845adafb54e1404e792`）已构建并校验（Identity `488B6338.354574AC174AD` / x64 / 0.3.6.0 / 引擎资源齐全），校验记录 docs/v0.3.6-商店上传校验.md。
- **待办（下一窗口）**：① 微软商店 Partner Center 上传 APPX（用户本人操作：新提交→上传包→发布信息→提交认证），回读现场状态；② macOS 自动更新补 zip 资产（electron-updater 在 mac 需 zip；当前 DMG 仅支持完整下载）；③ 清理临时脚本 scripts/tmp-* 与 /tmp/fm-rel36（含损坏重试产物 mac-x64.bad.* / win.zip 等）。

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
