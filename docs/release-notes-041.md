## FlyingMouse Format v0.4.1

### 新增

- **QQ 音乐 mflac/mgg 自动降档转换**：遇到母带档（AIM 等）无在线密钥权限的文件，自动改用同一首歌你账号有权限的音质档位（FLAC 无损 → OGG → MP3 320k）完成转换，放上去就能转成 MP3
- **PDF 页数不设上限**：任意页数的 PDF 都按原文件 1:1 转换（长文档加载/转换时间较长属正常，不再限制 500/1000 页）
- 相机 RAW 原片转换（CR2/NEF/ARW/DNG 等 18 种，Windows 实验性）

### 修复

- macOS 构建机偶发的 DMG 卸载报错不再导致发布失败（hdiutil 卸载容错）
- 商店 APPX 图标换回鼠鼠（NSIS 与商店包两套图标均已核对）
- WPS 生成的 docx 转 PDF 前先 roundtrip 修复
- csv/tsv→xlsx 不再依赖 LibreOffice
- win7-package-lock.json 修复 CI 构建

## 下载指南（按你的系统选，别下错）

| 你的系统 | 下载这个文件 |
|---|---|
| **Windows 10 / 11（64 位，绝大多数人）** | `FlyingMouse-Format-Setup-0.4.1-x64.exe` |
| Windows 7 SP1（64 位，老旧系统） | `FlyingMouse.Format-Setup-0.4.1-win7-x64.exe` |
| **macOS（Apple Silicon：M1/M2/M3/M4，2020 年及以后的 Mac）** | `FlyingMouse.Format-Setup-0.4.1-mac-arm64.dmg` |
| **macOS（Intel：2019 年及更早的 Mac）** | `FlyingMouse.Format-Setup-0.4.1-mac-x64.dmg` |

> 判断 Mac 芯片：点左上角苹果菜单 →「关于本机」→「芯片」栏——「Apple M1/M2/M3/M4」选 arm64；「Intel Core…」选 x64。选错了也没关系，Apple Silicon 也能运行 x64 包（Rosetta 转译）。
>
> ⚠️ 提示：
> - 默认选第一行 `x64.exe`（Windows 10/11 64 位）。只有确定是 Windows 7 才选第二行。
> - `latest.yml` 和 `*.blockmap` 是自动更新内部文件，**不要手动下载**。
> - macOS 包未签名未公证，首次打开被 Gatekeeper 拦截时：右键图标 →「打开」。

### 已知限制

- Windows / macOS 安装包未签名（SmartScreen / Gatekeeper 可能提示）
- Windows 7 Legacy 包与 macOS 包未在真实物理设备验收（自动化门禁已过）
- musicex 无任何权限的歌曲（已下架/需购买）仍无法转换
- 相机 RAW 为实验性支持
