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

## 产品边界

本仓库是“鼠鼠 UI 的飞鼠格式”。`鼠鼠打印` 是独立项目，不共享发布产物、桌面快捷方式或功能改动。
