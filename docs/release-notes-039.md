## FlyingMouse Format v0.3.9

- fix: WPS 生成的 docx 转 PDF 前先 roundtrip 修复（LibreOffice 静默截断只出前几页）
- fix: csv/tsv→xlsx 不再依赖 LibreOffice（exceljs 自有实现，CI 无 LO 环境可用）
- fix: win7-package-lock.json 重新生成 + URL 归一化（修复 CI win7 构建 npm ci 失败）

## 下载指南（按你的系统选，别下错）

| 你的系统 | 下载这个文件 |
|---|---|
| **Windows 10 / 11（64 位，绝大多数人）** | `FlyingMouse-Format-Setup-0.3.9-x64.exe` |
| Windows 7 SP1（64 位，老旧系统） | `FlyingMouse-Format-Setup-0.3.9-win7-x64.exe` |
| macOS Apple Silicon（M1/M2/M3/M4） | `FlyingMouse-Format-Setup-0.3.9-mac-arm64.dmg` |
| macOS Intel（Intel 芯片） | `FlyingMouse-Format-Setup-0.3.9-mac-x64.dmg` |

> ⚠️ 提示：
> - 默认选第一行 `x64.exe`（Windows 10/11 64 位）。只有确定自己是 Windows 7 才选第二行。
> - `latest.yml` 和 `*.blockmap` 是自动更新内部使用的文件，**不要手动下载**。
> - macOS 用户请按芯片选择 DMG；Apple Silicon 装 x64 版也可以跑（Rosetta），但推荐 arm64。
