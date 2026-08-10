# FlyingMouse Format v0.3.3 交接

更新时间：2026-08-10

## 项目边界

- 本地原仓库：`D:\34615\飞鼠格式`
- GitHub：`https://github.com/LaoFeng-mouse/flyingmouse-format`
- 产品：原版鼠鼠 UI 的 FlyingMouse Format（飞鼠格式）；`鼠鼠打印` 是另一个项目，本版没有修改。
- v0.3.3 使用同一套源码分别生成 Electron 43 的 Windows 10/11 标准包和 Electron 22 的 Windows 7 Legacy 包，不覆盖 v0.3.2。

## v0.3.3 功能

- 单图 50MP / 16384px、图片合并 PDF 总解码量 100MP、批量 2GB、PDF 500 页、OCR 100 页；Sharp 不再取消像素保护。
- `/api/capabilities` 返回 `limits`；资源拒绝包含稳定 `errorCode` 和中英文消息。
- HTML / Office → Markdown 共用 ATX/Fenced Turndown；CSV 精确锁定 `csv-parse 5.6.0`，支持 BOM、转义引号和字段内换行。
- PDF → Excel（智能表格提取）支持电子文字坐标、扫描页 OCR、有框/无框表格、旋转、多表、跨页续接、合并区域、低置信批注和 Raw 回退。扫描件、复杂表头和不规则合并区域仍可能不完整。
- 鼠鼠 UI、按源格式记忆目标格式、保存路径记忆、中英文界面、NCM/AV3A 路径均保留。

## 标准 Windows 10/11 x64 成品

- 本地文件：`dist\FlyingMouse Format-Setup-0.3.3-x64.exe`
- 大小：548,633,801 字节
- SHA-256：`2823d680cb8573bb21cc3a9537c0f6983ee06c280def5d2877cff6c8738f041b`
- 内层应用 EXE ProductVersion：`0.3.3.0`（NSIS 安装器文件版本显示为 `0.3.3`）
- NSIS：PE32，目标 OS `4.0`
- ASAR SHA-256：`385107c8b9b15e24348b929ee0988168bffbd06987389b25f42a097d8334f030`
- 签名：`NotSigned`
- GitHub 资产：待 v0.3.3 Release 发布后回读补记。

## Windows 7 SP1 x64 Legacy 成品

- 本地文件：`dist\FlyingMouse Format-Setup-0.3.3-win7-x64.exe`
- 大小：517,687,142 字节
- SHA-256：`d06e8c3cf5a0acec204ed94e26ff4500923f5e448064c520e42b31f24682ef4a`
- 内层应用 EXE ProductVersion：`0.3.3.0`
- NSIS 外壳：PE32，目标 OS `4.0`；内层应用：PE32+，目标 OS `5.2`
- ASAR SHA-256：`8edd988a7543fd417070ac3d640199ff71c367a2df8e7c829f3d004452e06673`
- 运行时：Electron `22.3.27`、Sharp `0.32.6`、PDF.js `2.16.105`、Turndown `7.2.0`
- 签名：`NotSigned`
- GitHub 资产：待 v0.3.3 Release 发布后回读补记。

## 最终验证证据

- 主线 `npm test`：169 项，167 通过、2 个预期 fixture skip、0 失败；`npm run test:ci`：138/138。
- Node.js 22 Win7 staging：90/90；构建使用官方 `node-v22.17.1-win-x64.zip`（35,526,030 字节，SHA-256 `b1fdb5635ba860f6bf71474f2ca882459a582de49b1d869451e3ad188e3943eb`），归档与解压文件数均为 2,447，npm `10.9.2`。
- 固定 CI 引擎资产：`ci-engines-v1.tar.zst`，434,427,088 字节，SHA-256 `823980b5cb3de40b9013106264e02196f6f95d471a1bd3e78917de3e2d26f98a`；恢复脚本先验哈希再解包，并校验必需文件。
- 真实 NCM/AV3A：用户提供的 3 个样本均转换为可完整解码、ID3 可读的 MP3，源文件 SHA-256 未变化。
- 审计：根生产依赖 0 漏洞；Win7 staging 为 2 个 high、0 critical（PDF.js 与 Sharp 的 Legacy 风险）。PDF.js 保持 `isEvalSupported: false`；Win7 包仅建议离线处理可信文件。
- 标准包与 Win7 包的 ASAR 白名单、FFmpeg、LibreOffice、Poppler、Tesseract、AVS3 等资源均已核对。
- 两个最终 EXE 的内嵌鼠鼠图标均已提取和目视确认；图标文件 SHA-256 相同：`f1eae8e5b0117d9d526f2e3b2f447c3127a82cff79736ef74bed7312c719a5c6`。
- 当前 Windows 各持续冒烟 12 秒：标准包和 Win7 包均有 4 个精确同路径 Electron 进程响应，结束后残留为 0。
- 真实 Windows 7 SP1 x64 设备仍待验收；自动化、PE 5.2 和当前 Windows 冒烟不能冒充实机验收。

## 发布与风险

- 两个安装包均未签名，SmartScreen 可能提示未知发布者。
- NCM 仅保证兼容 `music.163.com` 对应网易云客户端生成的文件；其他同扩展名来源不在保证范围。
- GitHub v0.3.3 只有在固定引擎资产、Release workflow 和双安装包远端回读全部通过后才写成“已发布”。
- Microsoft Store 状态未在本轮实时登录 Partner Center 核验；商店材料不能声称已审核。

发布步骤见 [RELEASE.md](RELEASE.md)，代码结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。
