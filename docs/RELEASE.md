# 发布流程

## 发布前门禁

1. 确认 `package.json`、`package-lock.json`、`win7-package-lock.json` 和文档版本一致。
2. 确认 `build/icon.png` 仍由鼠鼠资源生成，并运行图标回归。
3. 校验固定引擎 manifest 和 SHA-256；Windows 包含 FFmpeg、AVS3、LibreOffice、Poppler、Tesseract，macOS 使用对应原生架构引擎。
4. 运行完整 `npm test`、生产依赖审计、真实 NCM/AV3A 回归和 `git diff --check`。
5. PDF 智能表格固定样本必须满足：电子 PDF 单元格准确率不低于 95%，扫描 PDF 不低于 85%，表格数量、页签和明确合并区域 100% 正确。
6. 任一测试、审计、构建、架构、PE、包结构或安装包门禁失败，不得公开 Release。

## Windows 10/11 x64

```powershell
npm run dist
```

输出 `dist/FlyingMouse Format-Setup-<version>-x64.exe`。验收版本、哈希、ASAR 白名单、转换资源、鼠鼠图标、PE 元数据和启动冒烟。

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
- 标准 NCM 可用；AV3A NCM 是 Windows 专属能力，不得在 macOS 能力矩阵中宣传。

## v0.3.4 当前基线

- GitHub Release：<https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.3.4>，公开、非 prerelease、Latest。
- 标签提交：`e7a3508d451f301fc8ea113166cc67a16f304ae2`。
- 标签工作流：`31396373271`，Windows、Win7、macOS arm64、macOS x64 全部通过。
- 测试：239 项，237 通过、2 个预期 fixture skip、0 失败；根生产审计 0 漏洞。
- Windows 10/11：551,347,778 字节，SHA-256 `7f30479b92d9050ccd2bff860d82fb5711a9dcfecd422f866f8dbdcb03e2b2e7`。
- Windows 7：520,603,262 字节，SHA-256 `6b2de37ba8d12acd5c5096c8b0a530cc32f93e60e94a6e80e5bdaf892d0f4df9`。
- macOS arm64：681,546,935 字节，SHA-256 `536c004425703d5b004d9b64035616adb7a602447c3a244fbac4babbf9151c3a`。
- macOS x64：716,918,325 字节，SHA-256 `8458943d5469e3c0c143c7544a01b254ff1f73fc74319493c1abd5e86c2b7fe6`。

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
