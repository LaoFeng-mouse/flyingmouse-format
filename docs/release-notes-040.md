## FlyingMouse Format v0.4.0

### 新增

- **相机 RAW 原片转换**：支持佳能 CR2/CR3/CRW、尼康 NEF、索尼 ARW、通用 DNG、富士 RAF、松下 RW2、奥林巴斯 ORF 等 18 种相机原片 → JPG/PNG/WebP/TIFF（内置 dcraw 解码，Windows 版，实验性；无 RAW 引擎时界面自动隐藏该格式）
- **QQ 音乐 .mgg 解密**：标准音质/流畅音质的 .mgg 加密音频可转 MP3/FLAC 等（QMC2 EncV2 变体，离线解密；无损/SQ 的 mflac musicex 变体仍需 QQ 音乐登录 cookie 在线换密钥）

### 修复

- WPS 生成的 docx 转 PDF 前先 roundtrip 修复（LibreOffice 静默截断只出前几页）
- csv/tsv→xlsx 不再依赖 LibreOffice（exceljs 自有实现，CI 无 LO 环境可用）
- win7-package-lock.json 重新生成 + URL 归一化（修复 CI win7 构建）
- 商店 APPX 图标从橙色闪电换回鼠鼠（NSIS 与商店包两套图标资源均已核对）

## 下载指南（按你的系统选，别下错）

| 你的系统 | 下载这个文件 |
|---|---|
| **Windows 10 / 11（64 位，绝大多数人）** | `FlyingMouse-Format-Setup-0.4.0-x64.exe` |
| Windows 7 SP1（64 位，老旧系统） | `FlyingMouse-Format-Setup-0.4.0-win7-x64.exe` |
| **macOS（Apple Silicon 芯片：M1/M2/M3/M4，2020 年及以后的 Mac）** | `FlyingMouse-Format-Setup-0.4.0-mac-arm64.dmg` |
| **macOS（Intel 芯片：2019 年及更早的 Mac）** | `FlyingMouse-Format-Setup-0.4.0-mac-x64.dmg` |

> 怎么判断 Mac 是哪种芯片：点左上角苹果菜单 →「关于本机」，看「芯片」一栏——显示「Apple M1/M2/M3/M4」选 arm64 包；显示「Intel Core …」选 x64 包。两个包都装不了选错了也没关系，Apple Silicon 也能运行 x64 包（Rosetta 转译），只是推荐用 arm64 原生版。
>
> ⚠️ 提示：
> - 默认选第一行 `x64.exe`（Windows 10/11 64 位）。只有确定自己是 Windows 7 才选第二行。
> - `latest.yml` 和 `*.blockmap` 是自动更新内部使用的文件，**不要手动下载**。
> - macOS 包未签名未公证，首次打开若被 Gatekeeper 拦截：右键图标 →「打开」。

### 已知限制

- Windows / macOS 安装包未签名（SmartScreen / Gatekeeper 可能提示）
- Windows 7 Legacy 包与 macOS 包未在真实物理设备验收（自动化门禁已过）
- musicex 变体（无损/SQ 音质）依赖 QQ 音乐登录凭据，仍标实验性
- 相机 RAW 为实验性支持，真实相机样张建议先试转一张确认效果
