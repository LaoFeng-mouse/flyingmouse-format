# FlyingMouse Format 交接

更新时间：2026-08-20（v0.6.2 全平台发布完成——docx→MD 图片外置修复版，Windows 10/11 x64 + Windows 7 兼容版 + macOS arm64/x64 DMG）

## 当前状态

- **版本**：v0.6.2（合规版，部分格式已下架）。GitHub Release 已发布：https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.6.2（Latest，6 资产：win x64 标准版 + win7 兼容版 + mac arm64/x64 DMG + blockmap + latest.yml；win7 blockmap 未上传，win7 禁用自动更新无影响）
- **main**：HEAD 1a23bfd（bbe6fcf 修复 + 1a23bfd bump 0.6.2），已同步 origin/main；full-version 分支 = 满血版（含解锁模块，匿名，自留，本次桌面 zip 已重打）
- **CI**：Release validation run 32331084553 全绿（mac arm64/x64 + validate-and-build），云端 publish 自动发布 v0.6.2；latest.yml 校验通过（version 0.6.2 / url 连字符 / sha512 与 exe 一致）
- **本机**：D1/D2 仍为 v0.6.1（27ba6ce3）——docx→MD 修复尚未装到本机运行版，待用户决定是否升级；桌面满血版匿名 zip 已重打（含 docx→MD 修复，md5 1f335ccc1c4f2e614dae2c82bece7f97）
- **测试基线**：main 439 = 433 过 + 1 失败 + 5 跳过（唯一失败 = conversion.test.js「converts a PDF to DOCX」断言 `<w:tab/>` vs 引擎输出更优 `<w:tbl>`，v0.6.1 发布前已存在的本机 D1 引擎行为差异，与本次改动无关，CI 门禁不受影响）；full-version 497 = 493 过 + 0 失败 + 4 skip

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
