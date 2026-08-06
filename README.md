# FlyingMouse Format 飞鼠格式

> 一个 Windows 万能文件格式转换工具 · 完全离线可用 · 内置 FFmpeg / LibreOffice / Poppler / Tesseract

![GitHub release](https://img.shields.io/github/v/release/LaoFeng-mouse/flyingmouse-format?color=brightgreen&label=Release)
![Electron](https://img.shields.io/badge/Electron-43-47848F)
![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6)
![License](https://img.shields.io/badge/License-Proprietary-lightgrey)

[⬇️ 下载安装包](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/latest) · [查看 Release](https://github.com/LaoFeng-mouse/flyingmouse-format/releases) · [功能清单](#-支持格式) · [快速开始](#-快速开始)

---

## 🖼️ 界面预览
<img width="1751" height="1220" alt="9963867e92fae323144e9670b7c0501d" src="https://github.com/user-attachments/assets/27bab2ab-3055-48a3-a37c-6d7fce2f6661" />




---

## ✨ 特色

- 🧩 **万能转换**：图片 / 文档 / 表格 / 演示 / PDF / 音视频 / WPS 格式互转，任意文件还能打包成 ZIP
- 📦 **完全离线**：FFmpeg、LibreOffice、Poppler、Tesseract 全部内置，断网也能用
- 🐭 **批量转换**：一次拖入多个文件，队列逐个处理，实时进度条 + 失败原因
- 📄 **PDF 处理**：文字型 PDF 转 Excel/文本/网页，扫描版 PDF 可 OCR 转文本，页面可导出 PNG/JPG 压缩包
- 🖱️ **拖拽即用**：把文件丢给鼠鼠，自动识别可用目标格式
- 🔒 **安全可靠**：沙箱隔离 + 严格 CSP，本地服务仅监听 127.0.0.1，转换后由你选择保存位置

---

## 📋 支持格式

| 类别 | 输入格式 | 可转换为 |
|---|---|---|
| 🖼️ 图片 | jpg png webp avif tiff gif bmp heic | png jpg webp avif tiff pdf txt(OCR) |
| 📝 文本 | txt md html json csv log xml yaml | txt md html json csv |
| 📄 Word/WPS | doc docx odt rtf wps wpt wpd | pdf docx odt rtf txt html |
| 📊 Excel/WPS | xls xlsx xlsm ods csv tsv et ett | pdf xlsx ods csv html |
| 📽️ PPT/WPS | ppt pptx odp dps dpt | pdf pptx odp html |
| 📑 PDF | pdf | xlsx(表格提取) txt html png jpg(页面) |
| 🎵 音频 | mp3 wav flac m4a aac ogg opus wma | mp3 wav flac m4a ogg |
| 🎬 视频 | mp4 mov mkv webm avi m4v wmv flv | mp4 webm mkv mov mp3 wav flac m4a ogg |
| 📦 任意文件 | * | zip |

---

## 🚀 快速开始

**方式一：下载安装包（推荐）**

1. 打开 [Release 页面](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/latest)
2. 下载 `FlyingMouse Format-Setup-0.1.0-x64.exe`
3. 双击安装，桌面上会出现"FlyingMouse Format"快捷方式
4. 把文件拖进窗口，选择目标格式，点击转换

**方式二：从源码运行（开发者）**

```powershell
npm install
npm run desktop
```

桌面版会自动启动本地转换服务并打开软件窗口。

> ⚠️ 安装包当前为未签名构建（NotSigned），首次运行 Windows SmartScreen 可能提示，
> 选择"更多信息 → 仍要运行"即可。正式代码签名证书将在后续版本提供。

---

## 🔒 安全设计

- Electron `contextIsolation` + `sandbox` + 关闭 `nodeIntegration`
- 渲染器导航与 IPC 只信任本次启动的 `127.0.0.1` 随机端口
- 下载接口只接受同源 `/downloads/<id>` 地址；外部打开仅允许无凭据 HTTPS
- 本地服务发送严格 CSP；动态文件名与错误信息使用 `textContent` 渲染，无 XSS 注入面
- 生产依赖 `npm audit` 0 漏洞

---

## 🛠️ 技术栈

| 组件 | 用途 |
|---|---|
| Electron 43 | 桌面壳 + 窗口 + 系统保存对话框 |
| Express | 本地转换服务 |
| FFmpeg | 音视频转码 |
| LibreOffice Portable | Office/WPS 文档转换 |
| Poppler | PDF 页面渲染 |
| Tesseract.js | 图片/扫描 PDF OCR 识别 |
| pdfjs-dist 6 | PDF 文本与表格提取 |
| sharp | 图片处理 |
| exceljs | XLSX 生成 |

---

## 📁 项目结构

```
├─ electron-main.js       # Electron 主进程（窗口、保存 IPC）
├─ electron-security.js   # URL/导航/下载安全策略
├─ preload.js             # 安全桥接 window.flyingMouseFormat
├─ server.js              # Express 转换服务（格式识别、转换分发）
├─ public/                # 前端界面
├─ bin/                   # 内置转换引擎（不入库，需单独备份）
├─ tests/                 # 自动化测试（25 个用例）
└─ docs/HANDOFF.md        # 交接与交付说明
```

---

## 📜 版权与许可证

软件代码版权归作者所有。内置开源组件分别遵循其各自许可证：
FFmpeg（含 GPL 组件）、LibreOffice（MPL/LGPL）、Poppler（GPL-2.0）、Tesseract（Apache-2.0）。
分发二进制时请遵守对应开源许可证的声明与源码提供义务。

---

## 📬 反馈

问题或建议请到 [Issues](https://github.com/LaoFeng-mouse/flyingmouse-format/issues) 提交。
觉得好用的话，点个 ⭐ Star 支持一下！
