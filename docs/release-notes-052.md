## FlyingMouse Format v0.5.2

### 新增

- **酷我音乐 KWM 解密**：支持酷我音乐客户端下载的 .kwm 加密音频（320kbps MP3 / FLAC），密钥内嵌文件头，完全离线可解，无需酷我客户端。拖入 .kwm 文件选 MP3/FLAC 等目标格式即可。
- **图片合并 PDF 按文件夹命名**：支持拖入整个文件夹（或点「选择文件夹转 PDF」按钮）后批量转 PDF，输出的 PDF 直接用文件夹名命名（不再叫「001.jpg 等 138 个文件.pdf」）。
- **著作权标注**：软件界面、CLI、诊断文件、仓库文档全面标注作者（牢蜂）与非商用声明。

### 修复

- **批量转 PDF 超过 100 个文件失败**：之前一次选 138 张图转 PDF 会报「Unexpected field」失败——批量上限写死 100 个。现在不限数量，选多少转多少（超大文件会稍慢，属正常）。
- **接入 Agent 失败**：应用内「接入 Agent」把 skill 写入 Codex/Claude 目录时，从安装包内复制文件会失败（asar 只读文件系统不支持整目录复制），现在改为逐文件复制，接入成功。
- **诊断报告信息量不足**：之前导出的诊断文件里转换记录全被抹成 [REDACTED_FILE]，看不出任何线索；现在只隐藏文件名，保留「转换类型 → 目标格式 → 字节数」等信息，方便反馈问题时排查。

### 许可变更（重要）

- 许可证从 MIT 更换为**非商用许可**：仅供个人免费使用，**禁止**销售、转卖、收费服务、在电商平台（闲鱼/淘宝/拼多多等）倒卖，**禁止**套壳换皮重新发布。完整条款见仓库 LICENSE 文件。
- 发现任何渠道倒卖本软件，欢迎通过 3465177342@qq.com 联系作者举报。

## 下载指南（按你的系统选，别下错）

| 你的系统 | 下载这个文件 |
|---|---|
| **Windows 10 / 11（64 位，绝大多数人）** | `FlyingMouse-Format-Setup-0.5.2-x64.exe` |
| Windows 7 SP1（64 位，老旧系统） | `FlyingMouse.Format-Setup-0.5.2-win7-x64.exe` |
| **macOS（Apple Silicon：M1/M2/M3/M4，2020 年及以后的 Mac）** | `FlyingMouse.Format-Setup-0.5.2-mac-arm64.dmg` |
| **macOS（Intel：2019 年及更早的 Mac）** | `FlyingMouse.Format-Setup-0.5.2-mac-x64.dmg` |

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
