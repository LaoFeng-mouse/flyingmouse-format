# 发布流程

## 发布前

1. 确认版本号在 `package.json`、`package-lock.json` 和 README 中一致。
2. 确认 `build/icon.png` 由 `public/assets/mouse-format/mouse-idle.png` 生成，不能使用旧橙色闪电图标。
3. 准备 `bin/` 下的 FFmpeg、AVS3、LibreOffice、Poppler 与 Tesseract 资源。
4. 若需要运行真实转换测试，设置对应路径：

```powershell
$env:FLYINGMOUSE_FFMPEG_PATH = 'D:\34615\飞鼠格式\bin\ffmpeg\ffmpeg.exe'
$env:FLYINGMOUSE_AVS3_DECODER_PATH = 'D:\34615\飞鼠格式\bin\avs3\avs3RM0Decoder.exe'
$env:FLYINGMOUSE_LIBREOFFICE_PATH = 'D:\34615\飞鼠格式\bin\libreoffice\LibreOfficePortable\App\libreoffice\program\soffice.com'
$env:FLYINGMOUSE_PDFTOPPM_PATH = 'D:\34615\飞鼠格式\bin\poppler\Library\bin\pdftoppm.exe'
npm test
```

## 构建

```powershell
npm run dist
```

NSIS 安装包输出为 `dist/FlyingMouse Format-Setup-<version>-x64.exe`，解包目录为 `dist/win-unpacked/`。构建前若出现 `EBUSY`，只关闭目标路径为当前 `FlyingMouse Format.exe` 的进程，不要批量结束其他 Electron 应用。

### Windows 7 SP1 x64 兼容包

Win7 构建从当前源码派生独立 staging，不修改根 `package.json`、根 `node_modules` 或标准安装包。完整构建只需：

```powershell
npm run dist:win7
```

若只需生成 staging 进行依赖或文件检查，可单独运行下列命令；它不会打包，后续完整构建仍会重新准备 staging：

```powershell
node scripts/build-win7.js --prepare-only
```

输出：

- 可重建 staging：`output/win7-stage/`（完整测试中的安全性用例可能清理它，需要时重新执行 prepare/build）
- 解包应用：`output/win7-stage/dist/win-unpacked/FlyingMouse Format.exe`
- 发布安装包：`dist/FlyingMouse Format-Setup-<version>-win7-x64.exe`

固定运行时为 Electron `22.3.27`、Sharp `0.32.6`、PDF.js `2.16.105`。标准版继续使用根 manifest 的当前依赖。Win7 staging 内只运行本地安装的 electron-builder；构建脚本拒绝越界路径、junction 和符号链接，不得用手工复制的旧 `node_modules` 代替 staging 安装。

检查目标 OS 字段时必须读取内层应用 EXE：

```powershell
node scripts/inspect-pe.js "output/win7-stage/dist/win-unpacked/FlyingMouse Format.exe"
node scripts/inspect-pe.js "dist/FlyingMouse Format-Setup-0.3.2-win7-x64.exe"
npm test --prefix output\win7-stage
npm audit --omit=dev --prefix output\win7-stage
```

内层应用的 PE 检查器预期输出 `format: "PE32+"`、`majorOperatingSystemVersion: 5`、`minorOperatingSystemVersion: 2`；外层安装器输出 `format: "PE32"`、OS `4.0`，不能用它代替应用本体的兼容性证据。staging 测试预期 83 项中 81 通过、2 个真实 fixture 条件跳过、0 失败；遗留生产依赖审计预期 2 个 high。

## 验收

- `npm test` 全部通过。
- `git diff --check` 无错误。
- 启动 `dist/win-unpacked/FlyingMouse Format.exe`，确认鼠鼠 UI、中文/English、转换和保存可用。
- 从成品 EXE 提取关联图标，确认是鼠鼠图标；只查看源 PNG 不算成品验收。
- 检查 EXE 的 ProductVersion 与发布版本一致。
- 计算安装包 SHA-256 并写入交接记录和 Release。
- 安装包当前未签名，发布说明必须保留 SmartScreen 提示。
- Win7 兼容包还必须记录主线测试（本次基线为 119 项：117 通过、2 跳过）、staging 测试、3 个真实 NCM/AV3A 源文件不变、PE 5.2、ASAR/资源/图标、当前 Windows 12 秒冒烟，以及主线 0 漏洞和 Win7 旧依赖 2 个 high 的审计结果。PDF.js 2.16 必须保持 `isEvalSupported: false`；Sharp 0.32 的遗留漏洞无法在保留 Electron 22/Win7 的同时直接升级，Release 说明必须建议离线处理可信文件。
- PE 5.2 和当前 Windows 冒烟不能代替真实 Windows 7 SP1 x64 设备验收；未在真实设备运行时必须明确写“待验收”。

## 桌面快捷方式

桌面快捷方式应满足：

- 名称：`FlyingMouse Format.lnk`
- 目标：当前发布目录或正式安装目录下的 `FlyingMouse Format.exe`
- 图标：`FlyingMouse Format.exe,0`

替换同路径 EXE 后应调用 Windows Shell 图标刷新，并用真实桌面截图确认；不要仅依据快捷方式属性判断。

## GitHub

1. 提交范围只包含 FlyingMouse Format。
2. 推送 `main` 和对应 `v<version>` 标签。
3. 创建 GitHub Release 并上传 NSIS 安装包。
4. 回读远端 Release，核对标签、文件名、文件大小、SHA-256 摘要和下载链接。

为既有 v0.3.2 补充 Win7 兼容包时，只追加新资产和说明：不得覆盖标准安装包，不得移动 `v0.3.2` 标签。上传后必须回读远端，确认标准 x64 与 `-win7-x64` 两个文件同时存在，并核对 Win7 资产的大小和 SHA-256；未回读前不得写成远端已验证。

## Microsoft Store

商店包必须从当前鼠鼠 UI 版本重新构建并重新截图。Partner Center 的审核状态属于外部状态，未经实时查看不得写成“当前已通过”或“正在审核”。详情见 [微软商店上架清单](微软商店上架清单.md)。
