# FlyingMouse Format 交接

更新时间：2026-08-21（编号注入加固：双轴代码审查 + 5 个回归测试）

## 2026-08-21：docx→MD 自动编号注入加固（code-review 双轴审查 + 修复）

- **背景**：对 746e3fd/5a68b08（范围 cd99b39..HEAD）做双轴代码审查（Standards + Spec 并行子代理），两轴独立收敛于同一结构弱点：编号注入用行级正则 `/^(#{1,6})\s+/` 在最终 md 上重认标题，对 fenced 代码块无感知。
- **修复（office-convert.js）**：
  1. 【硬伤】注入对 fenced 代码块无感知：围栏内 `#` 行被当标题注入并消耗对齐索引 → 围栏后编号整体错位。已抽纯函数 `injectHeadingPrefixes(markdown, prefixes)`（导出，可单测），加围栏状态机（``` 与 ```lang 均覆盖）。注：mammoth 1.12.0 实测无内置 pre 映射（"HTML Preformatted" 不产出 `<pre>`），当前管线产不出围栏——属防御性加固，单测锁定防将来任何 ``` 来源。
  2. 【硬伤】含 `'` 样式名排除不一致：styleMap 生成排除（选择器语法限制）但编号计算不排除 → 两数组长度不一 → 编号整体错位。统一谓词 `isHeadingStyleName()`（两处共用）+ `parseDocxStyles()` 共享 styles.xml 解析（消除两份重复实现）。
  3. 【硬伤】`%N` 展开统一用当前级 def.fmt → 混排格式错（如中文章号+decimal 节）。改为各级 %N 用各级自身 numFmt，引用未定义级别 decimal 兜底。
  4. chineseCounting n=0（引用未激活级别）输出「十」→ 改「零」。
  5. 死字段 `level` 移除（注入只消费 `.prefix`），`headingNumbers` 更名 `headingPrefixes`。
- **测试**：conversion.test.js 新增 5 例（通用 docx 构造器 `createNumberedDocx` 共用，取代逐用例 yazl 复制）：① 引号样式名一致性（管线）② 混排 numFmt + 未激活级别「零」（管线）③ 手打编号防重复注入（管线）④ injectHeadingPrefixes 围栏跳过 + 对齐保持（单测，```/```lang 双形态）⑤ 手打守卫 + 前缀耗尽（单测）。全量 504 = 500 过 + 4 skip + 0 fail。
- **待办（下一窗口）**：同 08-20 待办（本机现场验收 / 合规版 main 同步此修复 / 客户机实测验收）。

## 2026-08-20：docx→MD 自动编号丢失修复（WPS 多级编号，commit 746e3fd）+ 满血版重打

- **现象（用户 08-20 报告）**：WPS 生成的 docx 转 md 后「几点几没了」——标题层级编号（第 X 章 / 1.1 / 1.1.1 / 1） / （1））全部消失。
- **根因**：WPS/Word 标题编号是 numbering.xml 自动编号（numPr numId+ilvl → lvlText 模板渲染），不在标题文本里；mammoth 输出 hN 只保留文本 → 编号消失（标题样式修复 5a68b08 后暴露）。
- **修复（office-convert.js）**：`computeDocxHeadingNumbers(docxPath)` 解析 numbering/styles/document，按文档顺序重算标题编号前缀注入 md 标题行。计数器按 numId 分组 + lvlOverride startOverride + 低级别清零（Word 语义）；支持 decimal/罗马/中文计数；样式表记录全部样式（含无 numPr 的标准 heading，保持与 mammoth 输出 188 行严格对齐）；手打编号标题不重复注入。已导出。
- **验证**：FreeRTOS 样本 md 标题 188 行 vs 编号数组逐行对齐 188/188、0 失败；第 1 章…第 4 章 / 1.1 / 2.1.1 / 3.1.1.1 / 1） / （1） 全还原；图片外置不回归（0 data:image / 37 assets 引用）；conversion.test.js 全量 54 = 51 过 + 3 skip + 0 fail；新增回归用例「converts a DOCX with WPS auto-numbered headings to Markdown with number prefixes」。
- **满血版重打（2026-08-20 16:30）**：npm run dist 构建（v0.5.2 满血线）→ asar 四要素 ALL PASS（解锁模块全在 ncm/kgg/mflac/kgma/vpr/av3a、setupAutoUpdater 禁用、无 app-update.yml）→ robocopy 同步 D1/D2/桌面便携目录（三处 asar md5 `c938317af63f1e99a8d77c8effd510b7` 一致）→ 桌面 zip 重打（21154 条目 / 1.95GB / zip 内 asar md5 与源一致 / 无 yml）。**zip md5 `e05398f513901bc463dcd23fe99a9267` / sha256 `b61126924edc397e50385db0ff6d911a0dad22c80a5daa820ac6c09cc76a5536`**（覆盖 63115465 版本）。
- **★打包坑（electron-builder 43）**：即使 build.publish 已移除、`--publish never`，electron-builder 检测到 electron-updater 依赖仍会**自动生成** `resources/app-update.yml`（owner/repo 取自 GitHub 仓库信息）→ 满血版打包后必须删（本次已删，D1/D2/便携/zip 均无）。setupAutoUpdater return 已兜底（updater=null 不会检查），删 yml 是双保险。
- **待办（下一窗口）**：① 本机现场验收（打开 D1/D2 或桌面便携版转 FreeRTOS docx，编号应完整）；② 合规版 main 同步此修复（cherry-pick office-convert.js + 测试，随下版发布）；③ 客户机实测验收。

## 待办（下一窗口，2026-08-14）

- ① **push 到 GitHub**：本地领先 origin/main 十几个提交（OCR 精准度 3 个 + PDF→Word 粘连降级 + KGG 自动搜索/剪枝/教程 + PDF 加密/解密/拆分 + 竖线阈值 + Office CRC + 合规 c6c6b04）。push 走代理 `HTTPS_PROXY=http://127.0.0.1:7897`
- ② **打包 + 打 tag + 发版**（等用户明确说）：发版前须补 qpdf 进 ci-engines-v1.json / restore-ci-engines.ps1 分发链（当前只进 package.json extraResources，CI 产物会缺 qpdf，加密/解密/拆分退化）
- ③ 酷我 KWM：算法已实现并实测，真实 3 首歌已转 MP3 放 Downloads（白兰的-得意的笑.mp3 / 田园-这些年在忙什么 (民谣版).mp3 / Zhen Zhen（半夏水玉）-目瑙纵歌.mp3）；revert 0774349 已恢复 v0.5.2 内容，等用户说上传再推
- ④ 真实 Win7 / Mac 物理设备验收
- ⑤ Partner Center 现场回读 v0.5.1 认证/发布状态 + Store listing 图标素材为鼠鼠（用户本人）
- ⑥ PyMuPDF AGPL 合规说明（docengine 引擎含 PyMuPDF，许可页附文本 + 源码链接）
- ⑦ 用户重启软件后实测：扫描全能王 PDF→DOCX（标题「购货合同」+ 正文正常）、KGG 本机下载歌解密

## 2026-08-14：OCR 精准度 + KGG 密钥库剪枝 + RAW 验收（本次窗口收尾）

### OCR 精准度（4 个 commit：7db69f6 / ad97770 / e09ef21 / f490c35）
- 根因链：泰文模型抢认中文 → 乱码；缩放 1600px 偏低 → 小字漏识别；渲染 DPI 300 上采样 → 大标题伪影误判。
- 修复：语言集 eng+chi_sim+tha → eng+chi_sim；缩放目标 1600→2480（≈300 DPI）；扫描版 OCR 渲染 DPI 300→200（贴合手机扫描件原始分辨率，再由缩放放大补偿）；PDF→Word docengine 输出单词粘连时自动降级 OCR（含测试）。
- 实测：扫描全能王合同首页 OCR 字符 1836→2220（+21%），标题「购货合同」+ 12 个产品名 + 材质列全对；全量 349 = 347 过 + 2 skip + 0 fail。

### KGG 密钥库（3 个 commit：cf98db8 / 716f301 / 641ef97）
- 自动搜索（跨平台递归定位 KGMusicV3.db）→ 剪枝（只深入 kugou/kgmusic/酷狗 与 macOS 沙盒通用层，MAX_VISITED 5000，避开全盘扫）→ 详细 4 步排查报错 + README 补 KGG 功能/密钥说明 + 新增 docs/酷狗KGG密钥库手动指定教程.md。
- styles.css .status-box 加 white-space:pre-line 让多行报错换行。

### 同步本地 + RAW 验收 + 清理
- 同步：两处安装目录（%LOCALAPPDATA%\Programs\FlyingMouse Format + C:\Users\34615\飞鼠格式\FlyingMouse Format）与 dist/win-unpacked 的 app.asar md5 一致（fbc07ee...），OCR + KGG 改动均已进包，无需重打。
- RAW：raw.pixls.us 下载真实 Nikon D750 NEF（6032×4032）走 convertImage 真实路径 NEF→JPG/PNG 成功，补齐待办「真实 RAW 样本验收」。
- 清理：50 个 scripts/tmp-*.js + .tmp-ocr-probe/ + .raw-samples/ + tmp-docx-dump.py + verify-*.js 全部删除，工作区干净。

### 并行会话冲突（合规任务，已处理）
- 另一窗口做「法律风险合规 5 项」（c6c6b04），期间误重写 package.json（删 scripts/devDependencies/build，已 git checkout 恢复）、把 index.html 写到根目录、留 scripts/pdf_text_check.js（后两个已删）。多窗口并行操作同一仓库易冲突，注意。

## 2026-08-14：PDF 加密/解密/分组拆分 + 扫描件竖线阈值修复（本次窗口收尾）

- **PDF 加密（qpdf 实现，替换原「不可用」占位）**：
  - 原 `convertPdf` 对 `pdfAction=encrypt` 直接抛 `PDF_ENCRYPT_UNAVAILABLE`（pdf-lib 无加密 API）。现改为 qpdf `--encrypt <pwd> <pwd> 256`（AES-256），空密码抛 `PDF_ENCRYPT_NO_PASSWORD`（422），qpdf 缺失仍抛 `PDF_ENCRYPT_UNAVAILABLE`。
  - 引擎注册：config.js 新增 `QPDF_PATH`（`FLYINGMOUSE_QPDF_PATH` env → resources/qpdf/bin/qpdf.exe → bin/qpdf/extracted/qpdf-12.4.0-msvc64/bin/qpdf.exe → 裸 qpdf）；package.json extraResources 把 `bin/qpdf/extracted/qpdf-12.4.0-msvc64` 打进安装包 `qpdf` 目录（上一窗口已加但没进 ci-engines 分发链，见「风险」）。
  - server.js `/api/convert`：PDF→PDF 加密/解密时输出单 `.pdf`（不走 .pdf.zip）；`PDF_ENCRYPT_NO_PASSWORD` 归入 422 客户端错误列表。
- **PDF 解密改走 qpdf**：原 `convertPdfDecrypt` 用 pdf-lib `PDFDocument.load({password})`，**只支持 RC4/AES-128，解不开应用自己 qpdf 加密的 AES-256 输出**（往返断裂，实测 pdf-lib 抛「Input document is encrypted」）。现改为 qpdf `--password=<pwd> --decrypt`（注意 qpdf 要求 `--password=` 用等号，不能拆两个参数），qpdf 缺失回退 pdf-lib。
- **PDF 拆分细化**：`splitPdfToZip` 支持 `splitMode=page`（逐页）/ `splitMode=group`（每 N 页一组，`--split-pages=N`），qpdf 可用走 qpdf（快），缺失回退 pdf-lib 逐页。qpdf 输出命名统一补零（`page-N.pdf`→`page-001.pdf`，`page-N-M.pdf`→`page-001-002.pdf`），与 pdf-lib 回退命名一致，断言不因引擎而异。
- **前端 UI**：新增「拆分方式」下拉（逐页 / 每 N 页一组）+「每几页一组」输入框；密码框只在加密/解密显示，拆分方式只在拆分显示，分组输入框只在 group 显示；中英 i18n 齐全。
- **扫描件竖线阈值修复**：见待办 ③。根因：0.05 太激进，把单个字形的竖笔（约占页高 10%）当表格竖线，碎片化网格 → OCR 置信度 56% 触发 `PDF_TABLE_OCR_LOW_QUALITY`。0.20 是实测裕量点（真实扫描件竖线 32% > 0.20 > 字形竖笔 10.5%）。
- **测试**：conversion.test.js 新增加密成功（断言 /Encrypt 标记 + 无密码打不开）、空密码 422、解密往返（加密→解密→可读）；新增分组拆分（5 页 groupSize=2 → 3 组 page-001-002/003-004/005-005）；pdf-table-runtime.test.js 新增竖线阈值回归（32% 收、10% 滤）；ui-static.test.js 新增 pdfSplitMode/pdfGroupSize 双语断言。全量 344 = 342 过 + 2 skip + 0 fail。
- **风险（待解决）**：qpdf 引擎只进了 package.json extraResources，**尚未进 ci-engines-v1.json / scripts/restore-ci-engines.ps1 的目录列表**。CI 打包时 bin/qpdf 不会被恢复，extraResources 会引用不存在的路径 → 标准版安装包缺 qpdf，加密/解密/分组拆分在 CI 产物上会退化成 UNAVAILABLE 或 pdf-lib 逐页回退。发版前必须补：ci-engines-v1.json requiredFiles 加 qpdf、restore-ci-engines.ps1 目录列表加 "qpdf"、重新 tar.zst 打包并更新 sha256。

## 2026-08-14：GitHub 回滚 + Word→PDF CRC 修复

- **GitHub 回滚**：main 从 4520e21（含 v0.5.2 新内容）回滚到 0774349（= v0.5.1 发布内容 + 著作权标注 + release.yml notes 文件名修复）。v0.5.2 新功能（KWM 解密/空白页/文件夹命名 PDF/批量上限/中文文件名乱码修复/Agent 接入/诊断格式改进/Office 误报修复，共 16 个 v0.5.2 独有文件）已从 GitHub 移除；本地 git 历史完整保留全部 v0.5.2 代码，等用户说上传再推。
- **Word→PDF CRC 修复**（本次窗口，根因定位 + 实现 + 验证）：
  - 根因：用户《博物志》docx（微信传输，7.2MB）的 `word/media/` 图片用 store + data descriptor 打包，但 central directory 与 data descriptor 的 CRC 字段全写 0（生成工具未计算）。LibreOffice 严格校验 zip CRC 会整体拒绝加载（stderr `Error: source file could not be loaded`，exit 1），MS Word 容错所以能正常打开。此前被 `classifyExecutionError` 误判为 OFFICE_ENGINE_PROFILE_FAILED。
  - 修复：office-convert.js 新增 `findCrcBrokenZipEntries`（扫描 central directory，找 CRC=0 且 compSize>0 的 entry）+ `repairZipCrcIfNeeded`（读所有 entry + yazl 重打包重算 CRC，store/deflate 均保留原压缩方式），`convertWithLibreOffice` 转换前先调用（对所有 zip-based office 输入生效，非 zip 自动跳过）。
  - 验证：tests/office-crc-repair.test.js 3 项；全量 339 = 337 过 + 2 skip + 0 fail；《博物志》docx→pdf 端到端实测 40 页成功（原报 PROFILE_FAILED）。
  - 关联：office-engine.js 的 `classifyExecutionError` 正则收窄（上一窗口已做，工作树未提交）——把 soffice 正常噪音 `Could not find platform independent libraries` 里的 "profile" 字样误判 PROFILE_FAILED 的问题已收窄。


## v0.5.2 开发中（2026-08-14 会话）

### 已实现（已提交并推送 main）

- **KWM 酷我音乐解密**（新增 kwm-format.js）：magic `yeelion-kuwo-tme`，0x18-0x1F 8 字节 key → u64 十进制 → 循环补 32 XOR `MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk` 生成 mask，数据区从 0x400 起逐字节 XOR；已注册 config.js + server.js 分发 + build.files/win7-profile 白名单；tests/kwm-format.test.js 9 项全过（含真实样本 fixture）；E2E kwm→mp3 200 返回可下载文件
- **批量上限修复**（server.js）：/api/convert-images-to-pdf 与 /api/merge-pdfs 的 upload.array("files", 100) → upload.array("files") 无上限（138 张图批量 JPG→PDF 的 "Unexpected field" 根因）；413 文案更新
- **Agent 接入修复**（agent-skill-installer.js）：copyDirectorySafe 从 fsp.cp 改为 readdir+readFile/writeFile 逐文件复制——**根因：打包后 skill 源在 app.asar（Electron 只读虚拟文件系统），asar 补丁不覆盖 fs.cp，安装必抛 ENOENT**。Electron 实测从已装版 asar 完整装到 ~/.codex/skills 并端到端跑通 CLI；新增回归测试
- **诊断格式改进**（diagnostics.js）：Convert 事件行不再整行抹成 [REDACTED_FILE]，只替换引号内文件名；文件头加 Author/License 行
- **文件夹命名 PDF**（public/ 三件套 + server.js）：drop 支持 webkitGetAsEntry 递归收集文件夹，新增「选择文件夹转 PDF」按钮（webkitdirectory input）；state.folderName 从 webkitRelativePath 首段取，/api/convert-images-to-pdf 接收 folderName 输出 `<文件夹名>.pdf`
- **著作权标注**：LICENSE 换非商用许可（中英双语）；README/AGENTS.md/UI author-line/cli.js help/diagnostics 全部标注作者（牢蜂）+ 禁止商用
- **Office 误报修复**（office-engine.js）：classifyExecutionError 正则收窄，stderr 含 "profile" 字样不再误判为 PROFILE_FAILED（《博物志》docx 事故根因）；新增回归测试
- **中文文件名乱码修复**（utils.js）：decodeUploadFileName 增加 GBK mojibake 解码（curl/命令行/微信传输场景，°×À¼µÄ → 白兰的）；UTF-8 mojibake 解码成功即返回不再二次转换；tests/utils.test.js 6 项
- **图片合并 PDF 插入空白页**（public/server/image）：队列每项「□+」插入空白页 + ✕ 删除，可与 ↑/↓ 排序组合；blanks 参数从后往前插入；纯白 A4 页（595×842pt）；E2E 3图+2空白页=5页验证通过；批量文件数无硬上限（取决于本地配置），前端「2GB」文案更新
- **release.yml 修复**：NOTES 文件名生成 `${var//./}` 误删 .md 扩展名点（v0.5.1 Release 显示 RELEASE.md 内容的根因），改为先对版本号去点
- 版本号 0.5.1 → 0.5.2（package.json/package-lock/win7-package-lock/README/release-notes-052.md 已建）

### 测试

- 全量 376 = 374 pass + 2 skip（NCM/KGG fixture 缺失属正常）+ 0 fail（2026-08-14 实测）
- 新增：kwm-format.test.js 9 项、agent-skill-installer 只读源回归 1 项、ui-static 3 项（文件夹入口 + 作者标注 + 空白页）、office-engine 误报回归 1 项、utils 6 项、conversion 空白页集成 1 项

## v0.5.1 已发布（2026-08-13 晚）

- **QQ 音乐登录教程弹窗**（bb0155c）：musicex 解密失败（MFLAC_EKEY_REQUIRED / MFLAC_EKEY_NETWORK）时前端自动弹出 7 步图文教程（登录 y.qq.com → F12 → Application → Cookie 列表 → 复制 qm_keyst/uin → 桌面新建 cookie 文件 → 重试），第 6 步「复制模板」按钮一键复制模板；6 张打码图解随包分发；中英文双语；ui-static 断言保护
- **psrf_qqmusic_key 兼容**（fdc4300）：loadQqMusicCredentials 接受新版扫码登录 cookie 名（旧版 qm_keyst / qqmusic_key 仍支持），mflac-format.test.js 加单测
- GitHub Release v0.5.1 已发布并设 Latest（六件套齐全，自动更新闭环：装 0.5.0 用户开软件自动收更新）；CI run 31700878539 四 job 全绿（Windows + mac x64 + mac arm64 + publish 云端发布）
- 本地安装包四件套：桌面 v0.5.1分发\（Win10/11 x64 646MB + win7 522MB + mac arm64 683MB + mac x64 719MB，与 Release 字节数一致），供 123 云盘分发
- 商店 APPX：dist/FlyingMouse Format-Setup-0.5.1-x64.appx（912,294,218 字节，0.5.1.0 / Identity 488B6338.354574AC174AD / x64 / 鼠鼠图标非橙色 / qqTutorialModal×7 + psrf×4 + AUDIO_UNLOCK_UNAVAILABLE_ON_STORE×1 / 引擎齐全），桌面副本 FlyingMouse-Format-Setup-0.5.1-x64.appx；Partner Center 上传待用户
- 验证：全量 336 = 334 pass + 2 skip + 0 fail；APPX 校验记录同 dist/ 校验脚本

## v0.4.1 发布状态（2026-08-13，已完成）

- **已发布并设 Latest**：https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.4.1
- 四平台资产齐全（六件套）：win x64 exe + blockmap + latest.yml（连字符命名，自动更新可用）/ win7 exe / mac-arm64 dmg / mac-x64 dmg；Release 说明含四平台下载指南（docs/release-notes-041.md）
- **新增功能**：
  - musicex 自动降档：原档（AIM 母带等）无在线密钥权限时，自动尝试 F0M(FLAC)/O4M(OGG)/M500(MP3) 档位从 QQ 官方 CDN 下载后解密转换（真实样本 XG-LEFT RIGHT E2E 通过）；全无权限明确报错
  - PDF 页数不设上限：移除 maxPdfPages/maxOcrPdfPages 与对应错误码，任意页数 1:1 转换
- **修复**：mac DMG 挂载检查卸载容错（release.yml trap 改 cleanup：hdiutil detach -force + 5 次重试 + 失败仅告警，v0.4.0/v0.4.1 实证的 Resource busy exit 16 不再导致发布失败）；APPX 商店 logo 换回鼠鼠
- **提交（已推送 main，tag v0.4.1 指向 18f8cdf + 后续 workflow 修复 162763a 在 main）**：df8a2e2（musicex 降档+PDF）/ 725596b（PDF 不限）/ 18f8cdf（bump 0.4.1）/ 162763a（mac 容错）
- **本机已升级 0.4.1**（%LOCALAPPDATA% + 项目目录副本 C:\Users\34615\飞鼠格式\FlyingMouse Format 两套 robocopy + 图标缓存刷新）
- **2026-08-13 会话调研结论（用户问过，避免重复排查）**：
  - **KGG 需要密钥是格式客观限制**：KGG v5 文件只有 audioHash（72B 处），ekey 不嵌入文件，存在酷狗客户端 KGMusicV3.db（%APPDATA%\KuGou8\）按 hash 查表；流密钥每首歌独立（本机两首歌实测不同），不能内置固定 key。对方转不了 = 没装酷狗/这歌不是本机酷狗下载的/库过期。与 mflac musicex 同类（密钥不在文件里），非 bug。用户已决定不做"脱离酷狗"方案。
  - **Word→PDF 反馈**：本机 0.4.1 普通 docx + WPS 风格 docx 转 PDF 均实测成功（%PDF 头正常）；外部反馈失败优先查：对方版本 < v0.3.8（WPS 修复 8d74720 未进包）、加密/损坏文件、杀软拦 soffice（OFFICE_ENGINE_MISSING/PROFILE_FAILED）。需对方版本号+错误文案+样本定位。
  - **商店图标两套资源**：build/icon.png（NSIS/EXE）与 build/appx/（商店 4 logo）独立；源码与 dist 0.4.1 APPX 包内均已是鼠鼠（PIL 像素判定橙比 0%）；商店仍显示橙色闪电 = Partner Center 上架的仍是旧包/Store listing 素材未同步，非代码问题。
- **商店 APPX**：dist/FlyingMouse Format-Setup-0.4.1-x64.appx 已构建并验证（0.4.1.0 / 鼠鼠 logo / dcraw / musicex 降档代码）；**用户已确认上传到 Partner Center（2026-08-13）**。注意：商店展示图标来自 Partner Center 的 Store listing 素材与包内 assets 是两套，若商店页面仍显示橙色闪电，需检查 Store listing 的 logo 素材是否同步为鼠鼠；认证/发布状态需现场回读。
- **待办（下一窗口）**：① Partner Center 现场回读 0.4.1 认证/发布状态 + 确认 Store listing 图标素材为鼠鼠；② 清理临时产物：output/.trash-ci-artifacts-040、output/.trash-ci-engines-check、output/.trash-release-upload*（均已确认无用，已移入 .trash-）、output/ci-artifacts-041（0.4.1 四平台发布证据，可留可删）、scripts/.trash-tmp/（75 个会话临时脚本）；③ 真实 RAW 样本验收（无真实相机样张）；④ 真实 Win7/Mac 物理设备验收

## v0.5.0 已发布（2026-08-13）

### 本次新增功能（已提交并发布）

- **KGMA 离线解密**（83a3cd5）：酷狗会员格式，16B 密钥内嵌文件头 offset 0x2c，纯离线可解（无需酷狗客户端/密钥库）
- **视频输出编码选择**（6c66f7b）：h264/h265/av1 可选，前端下拉（目标 mp4/mov/mkv 时显示）
- **检测更新入口默认隐藏**（eafd3a5）：updateButton 默认 hidden，有更新才亮出
- **PDF→Word 版式还原**（6c72c2d）：集成 pdf2docx（docengine convert），段落/表格/图片/字体还原
- **PDF→Excel 表格提取改用 camelot**（28587bb + 88c6fba）：标准表格 100% 还原，加质量门槛回退自研
- **.mmp4 支持**（89d6db7）：QQ 音乐 musicex 变体（D0M1 档位），尾部 musicex footer，走现有 musicex 解密链路
- **mac/win7 禁用自动更新**（16f6881）：mac 无 latest-mac.yml 检查必 404；win7 的 latest.yml 指向标准版（Electron 43）会坑 Win7 用户
- **商店版隐藏加密音频解锁入口**（5921971）：process.windowsStore 过滤 unlockAudioInputs（ncm/kgg/mflac/mgg/kgma/mmp4）+ 解密分发拒绝 AUDIO_UNLOCK_UNAVAILABLE_ON_STORE，降低 DRM 规避法律风险
- **Release 云端发布**（29d4936）：CI 构建完自动创建 Release + 上传（publish job），免本地下载（GitHub 对象存储直连/代理都只有 35-56KB/s）
- **报错反馈入口**（5d984ec）：转换失败提示 + 页脚展示反馈邮箱 3465177342@qq.com（不做 mailto/跳转，纯展示）

### 统一文档引擎 docengine
- pdf2docx + camelot 合并打包成一个 `docengine.exe`（bin/docengine/，270MB），共享 numpy/opencv/pandas（分开打包要 374MB）
- 子命令：`convert`（PDF→Word）+ `table`（PDF→Excel 表格，输出 JSON）
- win7/mac 排除（Python 3.12 不支持 Win7，回退纯 JS）
- **APPX 打包坑（已解决）**：python-docx 1.2.0 解包模板 `docx/templates/default-docx-template/` 含 `[Content_Types].xml`（方括号）/ `_rels`（下划线开头目录）/ `.rels`（点开头文件），makeappx 报 0x8007007b（文件名非法）。该目录运行时用不上（python-docx 用 default.docx zip），已删除。

### 发布状态
- GitHub Release v0.5.0 已发布（设 Latest，六件套：win x64 exe + blockmap + latest.yml + win7 exe + mac x64/arm64 dmg，自动更新可用）
- 商店 APPX `FlyingMouse Format-Setup-0.5.0-x64.appx`（911,251,499 字节）已构建并验证：0.5.0.0 / Identity 488B6338.354574AC174AD / x64 / docengine 含、default-docx-template 排除 / 商店版隐藏音频解锁。校验记录 docs/v0.5.0-商店上传校验.md。上传归用户本人（Partner Center）。
- 发布流程改为 CI 云端发布（publish job），以后发版本地不用再下载 artifacts。

### 待办（下一窗口）
- ① 酷我 KWM：算法调研到（kwm mask），待真实样本验证（本次跳过）
- ② 工程图纸大图无上限：用户已定完全放开，待实现（resource-policy 三道闸 + Sharp limitInputPixels）
- ③ KGMA 解密 FLAC 尾部 ~4B 残留清理：用户已定清理，待实现（convertKgma 重封）
- ④ PyMuPDF AGPL 合规说明（docengine 引擎含 PyMuPDF，需在许可页附文本 + 源码链接）
- ⑤ 123 云盘上传：已交由 Codex 接手（2026-08-13），本窗口不处理

## v0.4.0 发布状态（2026-08-13，已停止）

## 项目边界

- GitHub：<https://github.com/LaoFeng-mouse/flyingmouse-format>
- 当前 GitHub Release：<https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.5.0>
- 产品是原版鼠鼠 UI 的 FlyingMouse Format（飞鼠格式）；“鼠鼠打印”是另一个项目，本版没有修改。
- v0.3.5 使用同一源码生成 Windows 10/11、Windows 7 Legacy、macOS Apple Silicon 和 macOS Intel 四个安装包，不覆盖旧标签。

## server.js 拆分重构（2026-08-12，6 提交已推送，零功能变化）

将 2550 行单文件 server.js 拆分为 11 个域模块，主文件减到 680 行（只留路由/中间件/startServer）。**纯搬移零逻辑改动，全量测试与基线一致（296=294+2skip，重构后仍一致）**。

| 提交 | 内容 |
|---|---|
| d9d7b9c | refactor: 拆分 config/utils/media/zip-util 域（批1） |
| 96795cb | refactor: 拆分 image/ocr 域（批2） |
| 9e6223f | refactor: 拆分 pdfjs/pdf-table/pdf 域（批3） |
| 50281b6 | refactor: 拆分 text-docx/office-convert 域（批4） |
| be96b5a | refactor: server.js 改为 require 域模块并删除搬移函数（2550→680 行） |
| ed8f33a | test+chore: 打包白名单加入新域模块，静态断言指向新模块 |

- 新模块：config.js（引擎路径+格式常量）、utils.js（18 工具）、media.js（ffmpeg）、zip-util.js（zip 读写）、image.js（图片/PDF 拼图）、ocr.js（Tesseract）、pdfjs.js（PDF.js 加载）、pdf-table.js（表格提取）、pdf.js（PDF 转换全家桶）、text-docx.js（文本互转/DOCX/CSV 真实现）、office-convert.js（LibreOffice 转换）。
- 循环依赖处理：image⇄ocr、text-docx⇄office-convert、pdf⇄text-docx/office-convert 全部用「顶层单向 require + 函数内延迟 require」解决。
- 打包链同步：11 个新模块全部登记 package.json build.files + win7-build-profile.js REQUIRED_RUNTIME_FILES；白名单断言测试已加入新模块清单。
- 静态断言同步：logger Command failed→utils.js；PDF.js 加载→pdfjs.js；表格提取→pdf-table.js；OCR worker→ocr.js；OFFICE_CONVERSION_FAILED→office-convert.js。
- 效果：以后加新格式在对应域模块加函数即可，不再改主文件；各域独立可测。

## UI 版本号 + 检查更新（2026-08-12，3 提交已推送）

| 提交 | 内容 |
|---|---|
| 11fd74b | feat: UI 显示版本号 + 检查更新按钮与状态（标题栏显示 app.getVersion；顶部检查更新按钮手动触发 electron-updater；启动静默检查一次；状态推送已是最新/发现新版下载中/已下载重启生效/检查失败，中英文；开发环境与商店版自动隐藏降级） |
| 4dc1cdb | fix: 版本号与检查更新 IPC handler 补 assertTrustedIpc 同源校验（get-app-version / check-for-updates 遗漏渲染进程信任边界校验，与项目其他 IPC handler 安全基线对齐） |
| f8f0d9d | test: 新增 IPC handler 信任边界静态断言（扫描全部 ipcMain.handle，逐个断言含 assertTrustedIpc(event)，防止未来新增 handler 漏校验） |

- 清理：删除仓库根目录冗余 index.html（与 public/index.html 一致但零引用，server.js 只服务 public/）。
- 验证：全量 297 = 295 过 + 2 skip（新增 1 个 IPC 断言），0 失败。
- 注：push 走代理（HTTPS_PROXY=http://127.0.0.1:7897）成功；直连 GitHub 报 Connection reset。

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

## v0.4.0 发布状态（2026-08-12，进行中）

- **新增功能**：
  - 相机 RAW 原片（CR2/CR3/NEF/ARW/DNG 等 18 种）→ JPG/PNG/WebP/TIFF（dcraw 解码，Windows 实验性，无引擎自动隐藏）。输入先复制到临时目录再解码（本机 dcraw 不支持 -O，实测报 Unknown option；避免只读源目录失败与残留）。
  - QQ 音乐 .mgg 解密（QMC2 EncV2 变体，离线）→ MP3/FLAC 等。移植 unlock-music qmc_key.ts 标准腾讯 TEA；真实样本《周杰伦-对不起.mgg》E2E：mgg → OggS → MP3 3:45 通过。
- **修复**：win7 打包白名单补 mflac-format.js（v0.3.6 历史遗漏，win7 包缺失该模块）；APPX 商店 logo 换回鼠鼠（f2d054d）。
- **CI 引擎 bundle 更新**：ci-engines-v1.tar.zst 重打加入 dcraw（新 sha256 d7d76009...，435,605,266 字节，已上传 Release ci-engines-v1 并回读验证）；ci-engines-v1.json 同步。
- **提交（已推送 main + tag v0.4.0）**：f2d054d（APPX logo）/ fa9c5a4（feat mgg+RAW）/ ae3dcde（bump 0.4.0）/ 2d9dafe（win7 白名单）。tag v0.4.0 指向 2d9dafe。
- **验证**：全量 310 过 + 2 skip；转换矩阵 16/16；NSIS 包 16/16 校验（RAW/mgg 代码 + dcraw 引擎 + sha512 配对）。
- **Release workflow 31605192995**（tag v0.4.0 触发）：validate-and-build + mac arm64/x64 三个 job 进行中。
- **待办（下一窗口）**：① CI 跑完下载 artifact（win/win7/mac-arm64/mac-x64）→ gh release upload 到 v0.4.0 Release（命名配对：win7 用原名、mac DMG 原名）；② Release notes 用 docs/release-notes-040.md（四平台下载指南已写好），公开设 Latest；③ 商店 APPX 0.4.0 上传 Partner Center（用户本人操作，含包内鼠鼠 logo 校验）；④ 本机升级 0.4.0（两套目录 + 图标缓存）；⑤ 清理临时脚本 scripts/tmp-* 与 output/ci-engines-check/（含 434MB 旧 bundle 下载）；⑥ 真实 RAW 样本验收（本机无真实相机样张，dcraw 解码路径仅伪样本测试 + 引擎存在性验证）。

## v0.3.9 发布状态（2026-08-12，进行中）

- **背景**：v0.3.8 发布后发现两个 CI 问题，需要 bump 0.3.9 重新发版：
  - **csv/tsv→xlsx 在 CI 无 LO 环境 400**（f6d3765）：targetsForExt 里 xlsx 只来自 spreadsheetTargets（依赖 tools.libreoffice），而 csv/tsv 的 xlsx 实际走 exceljs 自有实现，不依赖 LO。CI（windows-latest 无 LO）跑 test:ci 时 text-conversion-integration 挂 2 项。修复：csv/tsv 分支补 `targets.add("xlsx")`。本机有 LO 所以之前没暴露。
  - **win7 构建 npm ci 失败**（根因 c9ef37c）：tmp-sync-win7-updater.js 复制 electron-updater 闭包时把 win7 lock 顶层 jsonfile/universalify/semver/fs-extra 覆盖成 main 的版本，npm ci 报 Missing: fs-extra@8.1.0 等。修复链：1709d94（补闭包）→ 55a2655（以 0.3.6 为基准重建）→ c4b969f（并行窗口用 npm 官方重新生成）→ 4734839（URL 归一化回 npmjs——npm 重新生成时 registry 是 npmmirror，CI 下载会超时）。
  - 最终 win7 lock = npm 官方重新生成（顶层 jsonfile@4.0.0/universalify@0.1.2/semver@6.3.1/fs-extra@8.1.0，electron-updater@6.8.9，URL 全 npmjs）。win7 测试 27 个全过。
- **mac/win7 资产缺失原因（用户问）**：release.yml 只把构建产物存为 CI artifacts，不会自动传 GitHub Release——需手动下载 artifact 再 gh release upload；win7 则因上述 lock 问题构建失败。v0.3.9 的 Release workflow 跑通后需手动上传四平台资产。
- **mac x64 DMG smoke 偶发失败**：上次 Release workflow 的 mac x64 "Mount and inspect DMG" 步骤在最后 smoke test 失败（app 启动 12 秒内退出，`kill -0` 失败），arm64 同步骤成功——疑似 runner 无 GUI 会话偶发；DMG 本身构建/挂载/file/codesign 都过。artifact 因 smoke 失败未上传。
- **本机 0.3.9 win x64 已打包验证**：11 域模块 + WPS 修复 + csv xlsx 修复进包，版本 0.3.9.0，sha512 配对，已上传 v0.3.9 Release（draft）。
- tag v0.3.9 指向 4734839（= origin/main），Release workflow 已触发最终验证。
- **待办（下一窗口）**：① Release workflow v0.3.9 跑完后下载 artifact（win/win7/mac-arm64/mac-x64）→ gh release upload 四平台资产（win7 exe + mac DMG，注意命名配对）；② 公开 Release 设 Latest；③ 商店 APPX 0.3.9 构建 + Partner Center 覆盖旧 0.3.7/0.3.8（用户本人操作）；④ 本机升级 0.3.9（两套目录 + 图标缓存）。

## v0.3.8 发布状态（2026-08-12）

- **背景**：并行窗口在 WPS 修复前发布过 v0.3.7（exe 551,483,714 字节，下载 60 次，tag 指向 ecc7b79 不含修复）。为让已装旧 v0.3.7 的用户能收到自动更新，**bump 到 0.3.8 重新打包发布**（同版本号不会触发 electron-updater）。
- 提交（全部已推送 main）：8d74720（WPS 修复）/ c37fb33（HANDOFF 结案）/ 8771e12（0.3.7 lock 同步）/ a05280a（release-update.sh blockmap 配对修复）/ c13c8f4（0.3.8 bump）。
- **release-update.sh blockmap 配对修复（a05280a）**：原 `ls dist/*.blockmap | head -1` 会因 dist 残留旧版本 blockmap 按字母序取错（0.3.6 排 0.3.7 前），改为精确匹配 `dist/FlyingMouse Format-Setup-${VERSION}-x64.exe.blockmap`。
- 产物（dist/）：`FlyingMouse Format-Setup-0.3.8-x64.exe` 551,484,192 字节；blockmap 569,400；latest.yml（version 0.3.8，sha512 `IysrBxRWy5+uXN8MUbHQ22fGbOzzEtVMCcA2bb9pPf4d4rrASsJAFInwXqsR4bV5YwRlmDGcoXXbgas3Pu6beg==` 与 exe 实测一致）。
- 打包验证：11 域模块全部进 asar、WPS 修复（docxNeedsPdfRepair）进包、引擎资源（soffice.com/ffmpeg/pdftoppm/tessdata）齐全、EXE FileVersion 0.3.8 / ProductVersion 0.3.8.0。
- tag `v0.3.8` 已推送（指向 c13c8f4）；Release 已创建，上传 exe+blockmap+latest.yml 中。
- **待办（下一窗口）**：① 商店 APPX 0.3.8 构建 + Partner Center 覆盖旧 0.3.7（用户本人操作）；② 本机升级两套目录（快捷方式指向项目目录副本 C:\Users\34615\飞鼠格式\FlyingMouse Format\，另有 %LOCALAPPDATA%\Programs\FlyingMouse Format）；③ 本机自动更新 pending 里已下载的旧 0.3.7 安装包清理（用户打开软件时会装旧版，需留意）。

## v0.3.7 待办（2026-08-12 记录）

- ① **~~用户反馈：PDF 27 页论文只转出前 7 页~~（已定位并修复，提交 8d74720）**。根因不是代码页数门禁，而是 **WPS 生成的 docx**：document.xml 含 wpsCustomData 命名空间 + 134 个 OMML 公式 + 153 个交叉引用域，LibreOffice 的 **PDF 导出**在正文约 27% 处静默截断（exit 0 但只输出前 7 页，txt/html 导出不受影响）。修复：`office-convert.js` 在 docx→pdf 前探测 wpsCustomData / 公式+域组合，命中则先经 LO roundtrip（docx→docx）规范化修复再导出 PDF。实测真实论文样本：修复后 28 页完整（修复前 7 页）。**zip 解析用手动实现（fs+zlib 解析 central directory），不用 yauzl**——微信传输的 docx 会让 yauzl openReadStream 卡在 end 事件不触发（2026-08-12 实测，普通 zip 正常）。新增 tests/office-wps-repair.test.js 4 个单测；全量 301 = 299 过 + 2 skip。
- ② server.js 拆分后新增格式验证：新域模块（image/ocr/pdf/text-docx/office-convert）的打包态路径解析已由测试覆盖，但未做真实打包冒烟（win7 staging 需 Node 18-22 环境）；v0.3.7 构建时需确认 11 个新模块进 asar 且引擎路径正常。
- ③ 半自动发布脚本（3325253）首次实际使用验收：打包→上传→设 Latest 闭环走一遍，确认与手动流程产物一致。

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
