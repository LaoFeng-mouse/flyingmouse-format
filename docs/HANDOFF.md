# FlyingMouse Format 交接

更新时间：2026-08-21（编号注入加固：双轴代码审查 + 5 个回归测试）

## 2026-08-21：docx→MD 自动编号注入加固（code-review 双轴审查 + 修复，cherry-pick 94e2aa4）

- **背景**：对 746e3fd/5a68b08（范围 cd99b39..HEAD）做双轴代码审查（Standards + Spec 并行子代理），两轴独立收敛于同一结构弱点：编号注入用行级正则 `/^(#{1,6})\s+/` 在最终 md 上重认标题，对 fenced 代码块无感知。
- **修复（office-convert.js）**：
  1. 【硬伤】注入对 fenced 代码块无感知：围栏内 `#` 行被当标题注入并消耗对齐索引 → 围栏后编号整体错位。已抽纯函数 `injectHeadingPrefixes(markdown, prefixes)`（导出，可单测），加围栏状态机（``` 与 ```lang 均覆盖）。注：mammoth 1.12.0 实测无内置 pre 映射（"HTML Preformatted" 不产出 `<pre>`），当前管线产不出围栏——属防御性加固，单测锁定防将来任何 ``` 来源。
  2. 【硬伤】含 `'` 样式名排除不一致：styleMap 生成排除（选择器语法限制）但编号计算不排除 → 两数组长度不一 → 编号整体错位。统一谓词 `isHeadingStyleName()`（两处共用）+ `parseDocxStyles()` 共享 styles.xml 解析（消除两份重复实现）。
  3. 【硬伤】`%N` 展开统一用当前级 def.fmt → 混排格式错（如中文章号+decimal 节）。改为各级 %N 用各级自身 numFmt，引用未定义级别 decimal 兜底。
  4. chineseCounting n=0（引用未激活级别）输出「十」→ 改「零」。
  5. 死字段 `level` 移除（注入只消费 `.prefix`），`headingNumbers` 更名 `headingPrefixes`。
- **测试**：conversion.test.js 新增 5 例（通用 docx 构造器 `createNumberedDocx` 共用，取代逐用例 yazl 复制）：① 引号样式名一致性（管线）② 混排 numFmt + 未激活级别「零」（管线）③ 手打编号防重复注入（管线）④ injectHeadingPrefixes 围栏跳过 + 对齐保持（单测，```/```lang 双形态）⑤ 手打守卫 + 前缀耗尽（单测）。full-version 全量 504 = 500 过 + 4 skip + 0 fail；main 全量见下方「当前状态·测试基线」。
- **待办（下一窗口）**：① 本机现场验收（转 FreeRTOS docx 编号完整）② 客户机实测验收（main 同步已随本次完成）。

## 2026-08-21（补充）：新格式接入核查 + PyMuPDF AGPL 合规（合规版文档同步）

- **PyMuPDF AGPL-3.0**：docs/privacy-policy.html §3 第三方组件 + README License 段附许可说明与源码链接（docengine 含 PyMuPDF，按 AGPL 提供源码获取途径）。
- **新格式接入核查（满血版，结果已记录在 full-version HANDOFF）**：mmp4 修复（musicex apiFilename 白名单补 mmp4/mflac2，抽 normalizeApiFilename 纯函数 + 6 断言单测）；KWM/mmp4/mgg2 部署验证（三处 asar md5 c938317a 均含 kwm-format×3/mmp4×2）。合规版按设计不含解锁格式，不受影响。

## 当前状态

- **版本**：v0.6.4（合规版，部分格式已下架）。GitHub Release 已发布：https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.6.4（Latest，6 资产：win x64 标准版 + win7 兼容版 + mac arm64/x64 DMG + blockmap + latest.yml；**v0.6.1/v0.6.2/v0.6.3 已删除**）。v0.6.4 = docx→MD WPS 自动编号恢复（第 X 章 / 1.1 / 1.1.1）
- **main**：HEAD e11a6c4（39cb807 自动编号 cherry-pick + ea69e16 bump 0.6.4 + e11a6c4 lockfile 修复），已同步 origin/main；full-version 分支 = 满血版（含解锁模块，匿名，自留，桌面 zip e05398f5 版已重打，asar c938317a）
- **CI**：v0.6.4 Release validation run 32371415753 全绿（mac arm64/x64 + validate-and-build + Publish 4 jobs）；门禁 ci.yml run 32363687947 全绿（3m30s）
- **★lockfile 坑（v0.6.4 CI 卡住根因，已修 e11a6c4）**：package-lock/win7-package-lock 里 negotiator-0.6.4 integrity 记录错误（+EUsqGPLsM...，实测 tarball 为 myRT3...）→ npm ci EINTEGRITY。已修正 + 主 lockfile 486 处 npmmirror→npmjs（lockfile 锁官方源，镜像勿写入）。本机 npm ci 全量通过。
- **发布流程备忘**：release.yml 按 `v*` tag 触发——push main 只跑 ci.yml 门禁，**打 tag + push 才触发 Release validation + 云端 Publish**。
- **本机**：D1/D2/桌面便携为满血版 asar `c938317af63f1e99a8d77c8effd510b7`（含图片外置 + 大纲恢复 + WPS 自动编号 + 解锁模块 + 自动更新禁用）；桌面满血版匿名 zip md5 `e05398f513901bc463dcd23fe99a9267` / sha256 `b61126924edc397e50385db0ff6d911a0dad22c80a5daa820ac6c09cc76a5536`；旧版本清理：GitHub v0.6.1-0.6.3 全删、本机 dist NSIS 0.5.2 删、测试样本全清
- **CI 门禁修复（2026-08-20）**：ci.yml Windows test job 原无引擎恢复（跑 test:ci），conversion.test.js 的 video→GIF/XLSX→XLS/PDF→DOCX 等真实转换测试无引擎缺失保护 → ffmpeg/libreoffice ENOENT 假失败，每次 main push 发失败邮件。已升级为与 release.yml 一致的引擎恢复序列（restore-ci-engines.ps1 + docstructure 校验/探针 + Thai OCR 暂存）+ npm test 全量（commit 6b63220）；验证 run 32338579299 三 job 全绿（Windows test 16 步、mac×2 11 步）。
- **本机**：D1/D2 已升级为满血版 c938317a（2026-08-20 最新，含 WPS 自动编号修复，UI 版本号显示满血线 0.5.2）
- **测试基线**：full-version 504 = 500 过 + 4 skip + 0 fail（含 08-21 新增 5 例）。main 948876d = 94e2aa4 内容一致（office-convert.js 逐字节相同，cherry-pick 干净落地；injectHeadingPrefixes 单测在 main 上实测通过）；⚠️ 本 worktree（C:\appx-build）bin/ 仅有 avs3，缺 libreoffice/poppler/ffmpeg/tessdata/docengine 等引擎 → 全量转换测试在此环境全部 400（环境问题非代码问题，CI 门禁不受影响）；完整门禁以 CI 或主 worktree 为准

## 最近完成的修复（v0.6.1 → v0.6.2）

- **docx→MD 图片外置**（本次核心）：Word 含大量截图转 MD 时图片 base64 内嵌成超长单行（实测 37 图 / 单行 263KB / md 3.3MB），Typora 报「文件过大」拒渲染。修复：对最终 md 统一 externalizeMarkdownImages（正则收集 data:image base64 → 解码写 `<下载名>.assets/image-N.ext` → md 引用改相对路径），mammoth 1.12.0 convertImage 选项实测失效已绕开；实测 FreeRTOS 样本 37 图全外置、md 3.3MB→89KB、最长行 263,960→1,092、Typora 正常打开
- 配套接线：electron-security.js resolveTrustedDownloadUrl 放行 /downloads/<id>/asset/<name>（原正则拒绝 asset URL → sidecar 拷图静默失败）；server.js asset 路由防穿越；electron-main.js downloadAssetsToMdSidecar；保存流程 md+`.assets/` 文件夹一并保存
- 已知限制：用户保存时若改文件名（≠downloadName），assets 目录名会错位（默认保存名一致时无影响）

## 待办（下一窗口）

- ① v0.6.1 Release 是否下架（Latest 已自动切到 v0.6.2，旧版保留可作降级通道）——用户决策
- ② 本机 D1/D2 是否升级到 v0.6.2（docx→MD 修复装到本机运行版）
- ③ 满血版桌面目录/zip 是否同步分发（zip md5 1f335ccc1c4f2e614dae2c82bece7f97）
- ④ Partner Center 微软商店：v0.5.1 认证状态现场回读；商店是否跟进 v0.6.2
- ⑤ 清理：scripts/tmp-verify-full-repack.py、scripts/tmp-verify-zip-final.py（未跟踪临时脚本）、%TEMP% 验证脚本、dist/win-unpacked.old-0817（若存在）

## 最近完成的修复（v0.6.0 → v0.6.1）

- 合规阉割：移除 NCM/KGG/mflac 等音乐平台加密格式解锁 + 自动更新；公开版仅支持普通格式（README/AGENTS/docs/分发与合规规范.md 已同步）；GitHub 版保留打赏，内部版匿名
- 单词书分类修复：pdf-classifier 多数派判定（scanned 占比 <20% 按 native 走 docengine），修「单词之间：低频词.pdf」PARSE_FAILED
- PDF 引擎（docengine.exe md5 1d2d12e6）：页眉/页脚擦除（含罗马页码）、标题独立成段、封面标签/值分行、目录/文献独立、表单检测收紧（FORM_ROW_X_GAP=40/FORM_SHORT_MAX=20/图注排除）、RawPage 离群检测加同行伙伴检查（修 1101 缺「二维码」）
- ICO 增强：PNG→ICO 尺寸自适应（小源图不再上采样模糊）+ extractAllFrames 多帧提取
- CI 全平台打通过程修复（11 轮）：manifest repository OWNER、docstructure lock 重建、bin/avs3 入库兼容、probe 退出码 20 + stderr 捕获（bash + set +e）、mac /var 符号链接（trustedRoot/isTrustedEntry realpath 自洽）、测试硬编码本机路径、8.3 短名（realpathSync.native）、ZIP 时间戳确定性

## 待办（下一窗口）

- ① **AppX/MSIX 打包未完成**：C:\appx-build 已备好（证书 flyingmouse-code.pfx/openssl2 空密码、AppxManifest MinVersion 17763、Logo 资产已生成）；卡 MakeAppx 0x8007007b——已二分定位到 docengine/_internal/docx/templates/default-docx-template（含 [Content_Types].xml / _rels 保留名），移走嫌疑文件后仍失败，需继续逐文件定位或用 -v verbose 观察；或从包排除 docx/templates 验证引擎运行依赖。打包成功后 signtool 签名
- ② 真实 Win7 / Mac 物理设备验收（Win7 兼容版 + mac DMG 均已发布但未真机实测）
- ③ Partner Center 微软商店上架：v0.5.1 认证/发布状态现场回读；v0.6.1 是否走商店（APPX 未成是前置）
- ④ PyMuPDF AGPL 合规说明（docengine 含 PyMuPDF，许可页附文本 + 源码链接）
- ⑤ 评定表模板 97.2% 缺 7 字（表格 cell 类，与 1101 不同根因，未排查）
- ⑥ 清理：bin/ 备份目录（docengine.bak-* ×3 + docengine.old + docstructure.bad-old-005744 ≈ 4G）、cert/（AppX 证书密钥，勿入库）、C:\appx-build（AppX 收尾后删）

## 已知约定

- GitHub remote：https://github.com/LaoFeng-mouse/flyingmouse-format.git；gh 账号 LI-2004-feng
- 公开发布物署名「牢蜂（LaoFeng）」，非商用（禁止销售/转卖/套壳）；对外措辞「部分格式已下架/合规版」，禁「阉割/破解/解锁/VIP」
- 引擎 env（测试/转换必需）：FLYINGMOUSE_FFMPEG_PATH / LIBREOFFICE / PDFTOPPM / TESSDATA 指向 D1 resources
- Win7 构建需 Node 18–22（本机已备 C:\Users\34615\.tools\node-v22.14.0-win-x64）
- 多窗口并行操作同一仓库易冲突（曾致 package.json 被误重写）；发现文件莫名被改先怀疑并行会话
