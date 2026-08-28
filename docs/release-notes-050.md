## Mahiro Format v0.5.0

### 新增

- **酷狗会员加密音频 KGMA 离线解密**：会员下载的 .kgma（林俊杰/薛之谦等）直接离线解密，无需酷狗客户端、无需会员在线授权
- **PDF→Word 版式还原**：换用 pdf2docx 文档引擎，段落、表格、图片、字体、列表都按原版式还原（不再只是抽文字）
- **PDF→Excel 表格提取升级**：标准表格 100% 还原（旧版偶有标题误判、列错位、扫描件认错字）
- **视频输出编码选择**：转视频时可选 H.264 / H.265 / AV1 编码（目标 mp4/mov/mkv 时显示）
- **QQ 音乐 .mmp4 加密音频**：musicex 变体（D0M1 档位）现在也能转成 MP3
- **检查更新入口改为有更新才显示**：不再常驻「检查更新」按钮

### 修复

- camelot 表格提取加质量门槛，特殊排版/裁剪 PDF 自动回退原流程

## 下载指南（按你的系统选，别下错）

| 你的系统 | 下载这个文件 |
|---|---|
| **Windows 10 / 11（64 位，绝大多数人）** | `Mahiro-Format-Setup-0.5.0-x64.exe` |
| Windows 7 SP1（64 位，老旧系统） | `Mahiro.Format-Setup-0.5.0-win7-x64.exe` |
| **macOS（Apple Silicon：M1/M2/M3/M4，2020 年及以后的 Mac）** | `Mahiro.Format-Setup-0.5.0-mac-arm64.dmg` |
| **macOS（Intel：2019 年及更早的 Mac）** | `Mahiro.Format-Setup-0.5.0-mac-x64.dmg` |

> 判断 Mac 芯片：点左上角苹果菜单 →「关于本机」→「芯片」栏——「Apple M1/M2/M3/M4」选 arm64；「Intel Core…」选 x64。选错了也没关系，Apple Silicon 也能运行 x64 包（Rosetta 转译）。
>
> ⚠️ 提示：
> - 默认选第一行 `x64.exe`（Windows 10/11 64 位）。只有确定是 Windows 7 才选第二行。
> - `latest.yml` 和 `*.blockmap` 是自动更新内部文件，**不要手动下载**。
> - macOS 包未签名未公证，首次打开被 Gatekeeper 拦截时：右键图标 →「打开」。

### 已知限制

- Windows / macOS 安装包未签名（SmartScreen / Gatekeeper 可能提示）
- Windows 7 Legacy 包与 macOS 包未在真实物理设备验收（自动化门禁已过）
- Windows 7 版不含 PDF→Word/Excel 文档引擎（Python 3.12 不支持 Win7），这两个功能退回纯文字提取
- macOS 版同样不含文档引擎（引擎为 Windows 专用），PDF→Word/Excel 退回纯文字提取
- musicex 无任何权限的歌曲（已下架/需购买）仍无法转换
- 相机 RAW 为实验性支持
