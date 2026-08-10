# FlyingMouse Format v0.3.4 交接

更新时间：2026-08-10

## 项目边界

- GitHub：<https://github.com/LaoFeng-mouse/flyingmouse-format>
- 当前 GitHub Release：<https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.3.4>
- 产品是原版鼠鼠 UI 的 FlyingMouse Format（飞鼠格式）；“鼠鼠打印”是另一个项目，本版没有修改。
- v0.3.4 使用同一源码生成 Windows 10/11、Windows 7 Legacy、macOS Apple Silicon 和 macOS Intel 四个安装包，不覆盖旧标签。

## v0.3.4 质量改进

- 资源保护：单图 50MP / 16384px、图片合并 PDF 总解码量 100MP、批量选择 2GB、PDF 500 页、OCR 100 页；Sharp 恢复像素保护并在 Raw Buffer 前预检。
- HTML / Office 到 Markdown 共用 ATX/Fenced Turndown；CSV 精确锁定 `csv-parse 5.6.0`，支持 BOM、转义引号和字段内换行。
- PDF 到 Excel 使用电子文字坐标、Poppler 页面渲染与 OCR blocks，支持有框/无框、多表、旋转、跨页、合并区域、低置信批注和 Raw 回退。扫描件、复杂表头及不规则合并区域仍可能不完整。
- 修复 OCR 高置信折扣、少数异价和合法合并区域被自动改写的问题，优先保证数据不被静默“纠正”。
- 改进 Markdown、HTML 表格、嵌套 JSON、动图静态化、透明图片转 JPG、XLSX 到 CSV 提示、NCM 元数据与封面保留。
- 保留按源格式记忆目标格式、保存路径记忆、中英文界面和鼠鼠 UI。

## GitHub v0.3.4 成品

| 平台 | 远端资产 | 字节 | SHA-256 |
|---|---|---:|---|
| Windows 10/11 x64 | `FlyingMouse.Format-Setup-0.3.4-x64.exe` | 551,347,778 | `7f30479b92d9050ccd2bff860d82fb5711a9dcfecd422f866f8dbdcb03e2b2e7` |
| Windows 7 SP1 x64 | `FlyingMouse.Format-Setup-0.3.4-win7-x64.exe` | 520,603,262 | `6b2de37ba8d12acd5c5096c8b0a530cc32f93e60e94a6e80e5bdaf892d0f4df9` |
| macOS Apple Silicon | `FlyingMouse.Format-Setup-0.3.4-mac-arm64.dmg` | 681,546,935 | `536c004425703d5b004d9b64035616adb7a602447c3a244fbac4babbf9151c3a` |
| macOS Intel | `FlyingMouse.Format-Setup-0.3.4-mac-x64.dmg` | 716,918,325 | `8458943d5469e3c0c143c7544a01b254ff1f73fc74319493c1abd5e86c2b7fe6` |

四个资产均为 `state=uploaded`，远端大小和 `sha256:` digest 已回读，与本地产物完全一致。Release 已公开、不是 prerelease，并已设为 Latest。

## 最终验证证据

- 合并提交和标签均指向 `e7a3508d451f301fc8ea113166cc67a16f304ae2`；PR：<https://github.com/LaoFeng-mouse/flyingmouse-format/pull/4>。
- PR CI `31387412438`：Windows、macOS arm64、macOS x64 三条代码/引擎门禁全部通过。
- 预发布全构建 `31387420825`：四个平台的真实转换、审计、构建、包检查和冒烟全部通过。
- 标签全构建 `31396373271`：239 项，237 通过、2 个预期 fixture skip、0 失败；根生产依赖审计 0 漏洞。
- Windows 10/11 与 Win7 安装包均成功构建；NSIS 外壳均为 PE32、目标 OS `4.0`。Win7 运行时继续固定 Electron `22.3.27`、Sharp `0.32.6`、PDF.js `2.16.105`、Turndown `7.2.0`，并在独立 staging 中执行运行时探针。
- macOS arm64/x64 均在原生 GitHub runner 恢复 SHA-256 锁定引擎，执行完整转换、生产审计、DMG 挂载/架构/包结构检查和 12 秒启动冒烟。
- 用户提供的 3 个真实 NCM/AV3A 样本均解密并转为可解码 MP3，Title/Artist/Album/Cover 可读，源文件哈希未变化；私有样本和临时解密文件未提交 GitHub。
- 用户提供的扫描 PDF 样本得分 85/95（89.47%），达到扫描 PDF 不低于 85% 的门槛；私有 PDF 和输出未提交 GitHub。

## 风险和未完成的外部验收

- Windows 安装包未签名，SmartScreen 可能提示；macOS DMG 未签名且未公证，Gatekeeper 可能提示。
- 自动化、PE 检查和当前 runner 冒烟不能冒充真实 Windows 7 SP1 x64 或真实 Mac 设备验收；两项物理设备验收仍待完成。
- NCM 仅保证网易云客户端 `music.163.com` 来源的标准文件；macOS 不支持依赖 Windows 专用解码器的 AV3A NCM。
- Microsoft Store 仍是 v0.3.3 Submission 2（ID `1152921505701615843`）。最后现场状态为 `Pre-processing in progress` / `In certification`；本轮没有上传 v0.3.4 商店包，也不能声称已经通过认证或公开发布。

发布流程见 [RELEASE.md](RELEASE.md)，代码结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。
