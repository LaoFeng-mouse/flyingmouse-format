# 发布流程

## 发布前门禁

1. 确认 `package.json`、`package-lock.json`、`win7-package-lock.json` 和文档版本一致。
2. 确认 `build/icon.png` 与 `public/assets/mahiro-format/mahiro-avatar.png` 同源，并运行 Mahiro 图标回归。**商店 APPX 的 logo 另在 `build/appx/`（Square44x44Logo/Square150x150Logo/Wide310x150Logo/StoreLogo），必须同源 Mahiro 头像、不得残留橙色闪电或原版鼠鼠图标**——生成脚本 `scripts/gen-appx-logos.js` 会从 `build/icon.png` 派生 4 个 logo。
3. 确认 `public/assets/mahiro-format/ASSET-NOTICE.md` 随包保留，界面与商店材料不得把非官方同人主题描述成官方授权或合作。
4. 校验固定引擎 manifest 和 SHA-256；Windows 包含 FFmpeg、AVS3、LibreOffice、Poppler、Tesseract，macOS 使用对应原生架构引擎。
5. 运行完整 `npm test`、生产依赖审计、真实 NCM/AV3A 回归和 `git diff --check`。
6. PDF 智能表格固定样本必须满足：电子 PDF 单元格准确率不低于 95%，扫描 PDF 不低于 85%，表格数量、页签和明确合并区域 100% 正确。
7. 任一测试、审计、构建、架构、PE、包结构或安装包门禁失败，不得公开 Release。

## Windows 10/11 x64

```powershell
npm run dist
```

输出 `dist/Mahiro Format-Setup-<version>-x64.exe`。验收版本、哈希、ASAR 白名单、转换资源、Mahiro 图标、同人主题声明、PE 元数据和启动冒烟。

## Windows 7 SP1 x64 Legacy

```powershell
npm run dist:win7
```

- 仅允许 Node.js 18–22，推荐 Node.js 22 LTS；其他主版本在 staging 写入前 fail closed。
- 独立 profile 固定 Electron `22.3.27`、Sharp `0.32.6`、PDF.js `2.16.105`、Turndown `7.2.0`，并使用专用 `win7-package-lock.json` 和 `npm ci`。
- staging 固定为 `output/win7-stage/`；Unicode 安全复制并拒绝 reparse point、特殊文件和越界资源。
- npm 前后绑定 staging manifest/lock 原始字节和 SHA-256；本地 builder、extraResources 和运行时探针必须通过 containment 检查。
- Release 必须披露未签名、Electron 22 EOL、Legacy 风险和“真实 Windows 7 SP1 x64 设备待验收”。

## macOS

- Apple Silicon 与 Intel 使用不同的 SHA-256 锁定引擎，不得交叉打包或使用 Rosetta 掩盖错误架构。
- 两个原生 runner 都必须执行完整转换、生产审计、DMG 构建、挂载检查、Mach-O 架构检查和 12 秒启动冒烟。
- macOS DMG 当前未签名且未公证；Release 必须披露 Gatekeeper 风险和真实 Mac 设备待验收。
- 音频仅支持普通格式（MP3/WAV/FLAC/M4A/AAC/OGG/OPUS/WMA）；不支持任何音乐平台加密特殊格式。AV3A（Audio Vivid）是 Windows 专属能力，不得在 macOS 能力矩阵中宣传。

## v0.3.5 当前基线

- GitHub Release：<https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.3.5>，公开、非 prerelease、Latest。
- 标签提交：`075c56fb6179742e7e4a1fe672c228048fa140bf`。
- 标签工作流：`31411904123`，Windows、Win7、macOS arm64、macOS x64 全部通过。
- 测试：251 项，247 通过、3 个预期 skip、1 个本机 git-bash tar 假失败（CI 无此问题）、0 真实失败；根生产审计 0 漏洞。
- Windows 10/11：551,226,275 字节，SHA-256 `51f5355428e73447accc27192d7f1c4e38e223bd5df417dbc539397c780b516c`。
- Windows 7：520,619,411 字节，SHA-256 `88286352a9b9016c812db8800ff68cb4e6772bdb461c5220179bcef5c8cb110c`。
- macOS arm64：681,558,079 字节，SHA-256 `9a64f5107dd38593d5825bdda29f08e6de83e7e6dc075d55998a56887f4c93bc`。
- macOS x64：716,999,507 字节，SHA-256 `241e5c574ef5acaa61aca627b0daf3d97c07d169f5ee396784acc2befe672f34`。
- 本版新增：PDF→DOCX、视频→GIF、WebP 动图→GIF、XLSX→XLS、ZIP→PDF（图片合并，防 zip-slip）、PPT/WPS→PNG/JPG、PDF 拆分/解密、PDF→Excel 扫描件 OCR 低质量门禁（低置信度明确报错而非乱码产物）。
- 已知限制：PDF 加密暂不可用（缺加密引擎，明确报错 `PDF_ENCRYPT_UNAVAILABLE`）；拍照扫描件（透视/阴影）OCR 置信度过低时报错 `PDF_TABLE_OCR_LOW_QUALITY`；HEIC 输入依赖打包 sharp 解码能力（无真实样本实测）。

## GitHub 发布顺序

1. 发布并回读固定引擎资产，确认文件名、大小和 SHA-256。
2. 推送 `main`，创建新标签；不得移动或覆盖历史标签。
3. 等待标签 Release workflow 全部通过。
4. 先创建 Draft，上传四个平台安装包并回读远端大小与 digest。
5. 只有标签工作流全绿后才公开 Draft，并设为 Latest。
6. 再次回读 Release、标签指向、资产文件名、大小、SHA-256 和下载链接，并将证据写入 `HANDOFF.md`。

## Microsoft Store

商店渠道使用与标准 Windows 10/11 相同源码单独生成的 x64 APPX/MSIX；不得上传 NSIS，也不得提交 Win7 Legacy 包。上传验证、Certification 和公开 Publishing 是三个不同门槛，状态结论必须来自 Partner Center 现场回读。

当前商店仍为 v0.3.3 Submission 2（ID `1152921505701615843`），最后现场状态是 `Pre-processing in progress` / `In certification`。GitHub v0.3.4 发布不会自动更新 Microsoft Store；本轮未提交 v0.3.4 商店包。
