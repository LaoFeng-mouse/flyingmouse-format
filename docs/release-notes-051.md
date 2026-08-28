## Mahiro Format v0.5.1

### 新增

- **QQ 音乐登录教程弹窗**：转换新版加密音频（mflac/mgg/mmp4）需要 QQ 音乐登录凭据时，会自动弹出图文教程，一步步教你：
  1. 打开网页版 QQ 音乐并登录
  2. 按 F12 打开开发者工具
  3. 切到「应用程序 / Application」标签
  4. 找到 Cookie 列表
  5. 复制 qm_keyst（新版登录为 psrf_qqmusic_key）和 uin
  6. 在桌面新建 QQ音乐_登录cookie.txt（有「复制模板」按钮，一键粘贴模板填上你的信息）
  7. 回到鼠鼠重新转换
- 每个步骤都有打码截图对照，照着做就行

### 修复

- 兼容新版 QQ 音乐登录凭据：网页版扫码登录的 cookie 名是 psrf_qqmusic_key（旧版是 qm_keyst），两种现在都能识别，不会复制了却读不到

## 下载指南（按你的系统选，别下错）

| 你的系统 | 下载这个文件 |
|---|---|
| **Windows 10 / 11（64 位，绝大多数人）** | `Mahiro-Format-Setup-0.5.1-x64.exe` |
| Windows 7 SP1（64 位，老旧系统） | `Mahiro.Format-Setup-0.5.1-win7-x64.exe` |
| **macOS（Apple Silicon：M1/M2/M3/M4，2020 年及以后的 Mac）** | `Mahiro.Format-Setup-0.5.1-mac-arm64.dmg` |
| **macOS（Intel：2019 年及更早的 Mac）** | `Mahiro.Format-Setup-0.5.1-mac-x64.dmg` |

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
