# FlyingMouse Format 架构说明

## 运行结构

```text
Electron 主进程
├─ 创建受限 BrowserWindow
├─ 启动仅监听 127.0.0.1 的 Express 服务
├─ 通过 preload 暴露保存文件 IPC
└─ 从 resources/ 或开发环境 bin/ 定位转换引擎
        ↓
鼠鼠 UI（public/） → 本地 API（server.js） → 转换器/外部引擎 → 临时结果
        ↓
Electron 保存对话框 → 用户选择的目录
```

## 主要模块

| 模块 | 职责 |
|---|---|
| `electron-main.js` | Electron 生命周期、本地服务、资源路径、保存 IPC、日志 |
| `preload.js` | 向渲染进程暴露最小化的保存接口 |
| `server.js` | 上传、格式识别、目标格式计算、转换调度和结果下载 |
| `ncm-format.js` | 常规 NCM 解密、元数据和封面处理 |
| `av3a-format.js` | 从 NCM 中识别并准备 Audio Vivid（AV3A）音频 |
| `kgg-format.js` | KGG 输入处理 |
| `settings-store.js` | 在 Electron `userData/settings.json` 保存上次目录 |
| `public/app.js` | 鼠鼠状态、批量队列、转换和保存交互 |
| `public/conversion-preferences.js` | 按源扩展名分别记忆目标格式 |
| `public/i18n.js` | 中文/English 选择及持久化 |

## 本地接口

- `GET /api/capabilities`：返回当前可用引擎能力。
- `POST /api/targets`：根据文件列表计算可选目标格式。
- `POST /api/convert`：转换单个文件。
- `POST /api/convert-images-to-pdf`：将多张图片合并为 PDF。
- `POST /api/merge-pdfs`：合并多个 PDF。
- `GET /downloads/:id`：读取本次会话生成的临时结果。

所有改变状态的接口都校验本地页面来源；服务只绑定回环地址和随机端口。

## 状态记忆

- 界面语言保存在浏览器 `localStorage`。
- 目标格式以“源文件扩展名 → 目标扩展名”保存；用户改选后立即覆盖该源格式的默认值。
- 上次保存目录写入 Electron `userData/settings.json`，下次保存对话框从该目录打开。
- 存储不可用或数据损坏时应回退默认行为，不阻止转换。

## 转换引擎

| 能力 | 主要引擎 |
|---|---|
| 音视频 | FFmpeg |
| AV3A / Audio Vivid | AVS3 解码器 + FFmpeg |
| Office / WPS 文档 | LibreOffice |
| PDF 渲染 | Poppler |
| OCR | Tesseract |
| 图片 | Sharp |

这些大型二进制不提交到 Git 仓库；正式安装包通过 `extraResources` 打入应用。

## NCM 兼容边界

只保证兼容 `music.163.com` 对应网易云音乐客户端生成的常规 NCM 与 AV3A NCM。其他来源即使扩展名相同，也可能采用不同封装或密钥方案，不视为本项目缺陷。

## 双运行时构建

- 标准版直接使用根 `package.json`：Electron 43，面向 Windows 10 / 11 x64。
- Windows 7 兼容版由 `win7-build-profile.js` 派生独立 profile/manifest，使用专用 `win7-package-lock.json` 经 `npm ci` 在可重建的 `output/win7-stage/` 安装 Electron 22.3.27、Sharp 0.32.6 和 PDF.js 2.16.105；根 manifest、根 `node_modules` 与标准版依赖不被改写或降级。
- `scripts/build-win7.js` 只允许清理项目内精确的 `output/win7-stage`。它在 npm 前后按原始字节和 SHA-256 绑定 staging 的 `package.json` / `package-lock.json`，并校验实际 manifest 与预期 profile 一致。
- 本地 electron-builder 入口必须 canonical 地位于 staging 内；`extraResources` 必须 canonical 地位于各自允许的项目根或 staging 根内，且路径链和递归资源中不得出现 reparse point。最终只复制精确命名的 Win7 安装包到根 `dist/`。
- PDF.js 加载器把入口固定在当前应用自己的 `node_modules/pdfjs-dist`，现代版优先 `.mjs`，旧版仅在该入口确实缺失时回退 `.js`，禁止借用父目录依赖。
- 所有 PDF.js 文本提取调用都设置 `isEvalSupported: false`，用于缓解旧 PDF.js 的动态代码执行风险。

Windows 7 构建是兼容 profile，不改变标准版运行时。PE 元数据由 `pe-metadata.js` / `scripts/inspect-pe.js` 检查；兼容性判断必须读取 `win-unpacked/FlyingMouse Format.exe` 这一内层应用，而不是 OS 字段不同的 NSIS 外壳。

## 产品边界

本仓库是“鼠鼠 UI 的飞鼠格式”。`鼠鼠打印` 是独立项目，不共享发布产物、桌面快捷方式或功能改动。
