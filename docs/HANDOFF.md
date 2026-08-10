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
- 大小：548,634,899 字节
- SHA-256：`3f812a515d9ab899929d1a5d42c7ac0903ad7baab65690bef719757aa51bec79`
- 内层应用 EXE ProductVersion：`0.3.3.0`（NSIS 安装器文件版本显示为 `0.3.3`）
- NSIS：PE32，目标 OS `4.0`
- 内层应用 EXE SHA-256：`883e0ebded950327481797ed7ac452e1c34f3fcbc636cce3af35c4f043ac727a`
- ASAR SHA-256：`bcef5a6d72bb7f30e2b60e07f267da5f15322febb100e8a2581f4b9dfeafb28d`
- 签名：`NotSigned`
- GitHub 资产：`FlyingMouse.Format-Setup-0.3.3-x64.exe`，远端大小与 digest 已回读一致。

## Windows 7 SP1 x64 Legacy 成品

- 本地文件：`dist\FlyingMouse Format-Setup-0.3.3-win7-x64.exe`
- 大小：517,688,135 字节
- SHA-256：`ee04bb1a22f56036d47f2ad98f6a20513c2430e619b98eec1ef098d52579726a`
- 内层应用 EXE ProductVersion：`0.3.3.0`
- NSIS 外壳：PE32，目标 OS `4.0`；内层应用：PE32+，目标 OS `5.2`
- 内层应用 EXE SHA-256：`ebfd1b8fa368b060a8fbd486254e1a8ecdfacad47d1badffa71f2507b777ab01`
- ASAR SHA-256：`418f91f71c30c7603b6dae057c03ebe8cf2d4a28fbc821d7752cdab33e9a2c3e`
- 运行时：Electron `22.3.27`、Sharp `0.32.6`、PDF.js `2.16.105`、Turndown `7.2.0`
- 签名：`NotSigned`
- GitHub 资产：`FlyingMouse.Format-Setup-0.3.3-win7-x64.exe`，远端大小与 digest 已回读一致。

## 最终验证证据

- 主线 `npm test`：169 项，167 通过、2 个预期 fixture skip、0 失败；`npm run test:ci`：138/138。
- Node.js 22 Win7 staging：90/90；构建使用官方 `node-v22.17.1-win-x64.zip`（35,526,030 字节，SHA-256 `b1fdb5635ba860f6bf71474f2ca882459a582de49b1d869451e3ad188e3943eb`），归档与解压文件数均为 2,447，npm `10.9.2`。
- 固定 CI 引擎资产：`ci-engines-v1.tar.zst`，434,427,088 字节，SHA-256 `823980b5cb3de40b9013106264e02196f6f95d471a1bd3e78917de3e2d26f98a`；恢复脚本先验哈希再解包，并校验必需文件。
- 真实 NCM/AV3A：用户提供的 3 个样本均转换为可完整解码、ID3 可读的 MP3，源文件 SHA-256 未变化。
- 审计：根生产依赖 0 漏洞；Win7 staging 为 2 个 high、0 critical（PDF.js 与 Sharp 的 Legacy 风险）。PDF.js 保持 `isEvalSupported: false`；Win7 包仅建议离线处理可信文件。
- 标准包与 Win7 包的 ASAR 白名单、FFmpeg、LibreOffice、Poppler、Tesseract、AVS3 等资源均已核对。
- 两个最终 EXE 的内嵌鼠鼠图标均已提取和目视确认；图标文件 SHA-256 相同：`f1eae8e5b0117d9d526f2e3b2f447c3127a82cff79736ef74bed7312c719a5c6`。
- 当前 Windows 各持续冒烟 12 秒：标准包和 Win7 包均有 4 个精确同路径 Electron 进程响应，结束后残留为 0。
- GitHub Release validation `31350567825`：11 分 56 秒完成，完整转换、审计、标准包、Win7 包、PE 检查和 artifact 上传全部通过。
- 真实 Windows 7 SP1 x64 设备仍待验收；自动化、PE 5.2 和当前 Windows 冒烟不能冒充实机验收。

## 发布与风险

- 两个安装包均未签名，SmartScreen 可能提示未知发布者。
- NCM 仅保证兼容 `music.163.com` 对应网易云客户端生成的文件；其他同扩展名来源不在保证范围。
- GitHub v0.3.3 已发布为 Latest：`https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.3.3`；两个资产均为 `state=uploaded`，远端大小与 `sha256:` digest 已回读一致。
- Microsoft Store 状态未在本轮实时登录 Partner Center 核验；商店材料不能声称已审核。

发布步骤见 [RELEASE.md](RELEASE.md)，代码结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。
