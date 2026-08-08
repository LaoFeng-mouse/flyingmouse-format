# FlyingMouse Format / 飞鼠格式

> A mouse-themed, offline Windows file converter. / 一款鼠鼠主题、可离线使用的 Windows 文件格式转换工具。

[![Release](https://img.shields.io/github/v/release/LaoFeng-mouse/flyingmouse-format?color=e95f6d)](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/latest)
![CI](https://github.com/LaoFeng-mouse/flyingmouse-format/actions/workflows/ci.yml/badge.svg)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6)
![License](https://img.shields.io/badge/License-MIT-green)

[下载最新版 / Download](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/latest) · [问题反馈 / Issues](https://github.com/LaoFeng-mouse/flyingmouse-format/issues)

![FlyingMouse Format mouse UI](public/assets/screenshots/home.png)

## 中文

### 主要功能

- 鼠鼠原版界面：鼠鼠会跟随上传、识别、批量、OCR、转换成功或失败切换状态。
- 本地离线转换：内置 FFmpeg、LibreOffice、Poppler、Tesseract 和 AVS3 解码器。
- 支持图片、文本、Word/WPS、Excel/WPS、PPT/WPS、PDF、音频、视频和 ZIP。
- NCM 解密与转码：支持来自 `music.163.com` 对应网易云音乐客户端的常规 NCM，以及 Audio Vivid（AV3A）NCM。
- 操作记忆：按“源文件格式”分别记住上次选择的目标格式；重新修改后，新选择会成为该源格式的默认值。
- 路径记忆：记住上次保存目录，下次保存时自动从该目录开始。
- 中文/English 界面：首次启动跟随系统语言，手动选择后会记住设置。
- 批量转换：显示逐文件进度、结果和失败原因，并可单独保存或保存全部。

> NCM 说明：仅保证支持 `music.163.com` 对应客户端下载的音乐文件。其他网站或来源虽然扩展名也可能是 `.ncm`，但内部格式不同，不属于本项目的兼容范围。

### 快速开始

1. 在 [Releases](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/latest) 下载 `FlyingMouse Format-Setup-0.3.1-x64.exe`。
2. 安装并启动 FlyingMouse Format。
3. 拖入文件，选择目标格式并开始转换。
4. 选择保存位置；软件会记住目标格式与保存目录。

从源码运行：

```powershell
npm install
npm run desktop
```

运行测试与打包：

```powershell
npm test
npm run dist
```

## English

### Highlights

- Original mouse UI with animated state changes for upload, detection, batch work, OCR, success, and errors.
- Fully local conversion with bundled FFmpeg, LibreOffice, Poppler, Tesseract, and an AVS3 decoder.
- Converts images, text, Word/WPS, Excel/WPS, PPT/WPS, PDF, audio, video, and ZIP files.
- Decrypts and converts standard NCM plus Audio Vivid (AV3A) NCM from the NetEase Cloud Music client associated with `music.163.com`.
- Remembers the chosen target separately for each source extension. Changing it replaces that extension's default.
- Remembers the last save directory for the next save dialog.
- Chinese and English UI. The first launch follows the system language; a manual choice is remembered.
- Batch conversion with per-file progress, results, error details, individual save, and Save All.

> NCM scope: compatibility is guaranteed only for files downloaded by the NetEase Cloud Music client associated with `music.163.com`. Files from other sites may use a different internal format despite sharing the `.ncm` extension.

### Quick start

1. Download `FlyingMouse Format-Setup-0.3.1-x64.exe` from [Releases](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/latest).
2. Install and launch FlyingMouse Format.
3. Drop in files, choose a target, and convert.
4. Choose a save location. The app remembers both the target preference and save folder.

## Supported formats / 支持格式

| Category / 类别 | Input / 输入 | Output / 输出 |
|---|---|---|
| Images / 图片 | jpg, png, webp, avif, tiff, gif, bmp, heic | png, jpg, webp, avif, tiff, pdf, txt (OCR), mp4, webm |
| Text / 文本 | txt, md, html, json, csv, log, xml, yaml | txt, md, html, json, csv, pdf, docx |
| Word/WPS | doc, docx, odt, rtf, wps, wpt, wpd | pdf, docx, odt, rtf, txt, html, md |
| Excel/WPS | xls, xlsx, xlsm, ods, csv, tsv, et, ett | pdf, xlsx, ods, csv, html |
| PPT/WPS | ppt, pptx, odp, dps, dpt | pdf, pptx, odp, html |
| PDF | pdf | xlsx, txt, html, png, jpg, split/merge PDF |
| Audio / 音频 | ncm, mp3, wav, flac, m4a, aac, ogg, opus, wma | mp3, wav, flac, m4a, ogg, aac, opus, wma |
| Video / 视频 | mp4, mov, mkv, webm, avi, m4v, wmv, flv | mp4, webm, mkv, mov, mp3, wav, flac, m4a, ogg, aac, opus, wma |
| Any file / 任意文件 | any | zip |

## Privacy and security / 隐私与安全

- Files are processed locally and are not uploaded to a cloud conversion service. / 文件在本地处理，不上传到云端转换服务。
- Electron uses context isolation, sandboxing, restricted navigation, and a local-only random port. / Electron 使用上下文隔离、沙箱、导航限制和仅本机可访问的随机端口。
- The Windows installer is currently unsigned, so SmartScreen may show a warning. / 当前 Windows 安装包尚未签名，SmartScreen 可能显示提示。

## License / 许可证

Source code is released under the [MIT License](LICENSE). Bundled third-party components retain their respective licenses. / 项目代码采用 [MIT License](LICENSE)，内置第三方组件遵循各自许可证。
