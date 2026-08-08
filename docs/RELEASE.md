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

## 验收

- `npm test` 全部通过。
- `git diff --check` 无错误。
- 启动 `dist/win-unpacked/FlyingMouse Format.exe`，确认鼠鼠 UI、中文/English、转换和保存可用。
- 从成品 EXE 提取关联图标，确认是鼠鼠图标；只查看源 PNG 不算成品验收。
- 检查 EXE 的 ProductVersion 与发布版本一致。
- 计算安装包 SHA-256 并写入交接记录和 Release。
- 安装包当前未签名，发布说明必须保留 SmartScreen 提示。

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

## Microsoft Store

商店包必须从当前鼠鼠 UI 版本重新构建并重新截图。Partner Center 的审核状态属于外部状态，未经实时查看不得写成“当前已通过”或“正在审核”。详情见 [微软商店上架清单](微软商店上架清单.md)。
