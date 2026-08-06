# 飞鼠格式

飞鼠格式是一个 Windows 桌面文件格式转换工具。界面支持拖拽或选择文件、自动识别可用目标格式、单文件转换、批量转换、进度条、失败原因展示，以及转换后选择保存位置。

## 当前能力

- 图片：`jpg / png / webp / avif / tiff`，并支持转 `pdf / txt`（TXT 为 OCR 识别结果）
- 文本：`txt / md / html / json / csv`
- Word/WPS 文档：`doc / docx / odt / rtf / wps / wpt / wpd` 转 `pdf / docx / odt / rtf / txt / html`
- Excel/WPS 表格：`xls / xlsx / xlsm / ods / csv / tsv / et / ett` 转 `pdf / xlsx / ods / csv / html`
- PPT/WPS 演示：`ppt / pptx / odp / dps / dpt` 转 `pdf / pptx / odp / html`
- PDF：文字型 PDF 转 `xlsx / txt / html`；扫描版/图片型 PDF 可 OCR 转 `txt`；PDF 页面可导出为 `png / jpg` 压缩包
- 音频：`mp3 / wav / flac / m4a / aac / ogg / opus / wma`
- 视频：`mp4 / mov / mkv / webm / avi / m4v / wmv / flv`
- 任意文件：封装为 `zip`

Office/WPS 转换依赖安装包内置的 LibreOffice Portable。音视频转换依赖安装包内置的 FFmpeg。PDF 页面导出图片依赖安装包内置的 Poppler。OCR 转 TXT 依赖安装包内置的 Tesseract.js 语言数据。PDF 转 Excel 适合文字型 PDF；扫描版图片 PDF 还原成 Excel 表格仍需要后续版面分析能力。

## 批量转换

一次可以选择多个文件。前端会读取每个文件可用的目标格式，并只展示这些文件共同支持的目标格式。开始转换后，队列会逐个处理文件，并在每个文件旁边显示等待、转换中、完成或失败原因。

转换成功的文件名保持为：

```text
原文件名.目标格式
```

桌面版支持单个文件选择保存位置，也支持“保存全部”到用户选择的文件夹；同名文件会自动追加序号，避免覆盖。

## 运行

```powershell
npm install
npm run desktop
```

桌面版会自动启动本地转换服务并打开软件窗口。

## 安全边界

- Electron 使用 `contextIsolation`、关闭 `nodeIntegration` 并启用 renderer sandbox。
- 窗口导航和 IPC 只信任本次启动的 `127.0.0.1` 随机端口。
- 保存接口只接受同源 `/downloads/<id>` 地址；外部打开只允许无账号信息的 HTTPS URL。
- 本地服务发送严格 CSP，动态文件名和错误信息使用 DOM API 与 `textContent` 渲染。

## 打包安装包

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:npm_config_registry='https://registry.npmmirror.com'
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run dist
```

安装包输出到：

```text
dist\飞鼠格式安装包-0.1.0-x64.exe
```

### 代码签名

当前本地构建明确保持 `signAndEditExecutable: false`，生成的是未签名测试构建。正式对外分发时，应在安全 CI 或临时构建环境中注入 Windows 代码签名证书及密码；禁止把 `.pfx`、证书密码、访问令牌或其他密钥写入仓库、脚本或文档。未提供正式证书前，不得把产物描述为“已签名”或“已验证发布者”。

## 关键路径

- `server.js`：Express 转换服务、格式识别、文件名修正、下载路由
- `public/app.js`：前端交互、批量转换队列、进度条和保存按钮
- `public/assets/mouse-format/`：飞鼠格式鼠鼠角色动作资产。动作资产必须保持完整鼠鼠头身形象，不能使用圆裁头像贴身体。
- `scripts/build-mouse-format-assets.js`：从本机 `D:\鼠鼠打印\assets\mouse_avatar.png` 生成飞鼠格式专属鼠鼠动作 PNG。
- `electron-main.js`：Electron 窗口、本地服务启动、保存文件/保存全部 IPC
- `electron-security.js`：导航、外链、IPC 来源和下载 URL 的纯函数安全策略
- `preload.js`：暴露桌面保存能力给前端
- `bin/ffmpeg/ffmpeg.exe`：内置 FFmpeg
- `bin/libreoffice/`：内置 LibreOffice Portable
- `bin/poppler/`：内置 Poppler，用于 PDF 页面导出图片
- `bin/tessdata/`：内置 OCR 中英文语言数据，用于图片/PDF 转 TXT

## 验证建议

- `node --check server.js`
- `node --check public\app.js`
- `node --check electron-main.js`
- `node --check electron-security.js`
- `node --check preload.js`
- `npm test`
- `npm audit --omit=dev`（正式分发前必须审阅；不要直接使用破坏性 `--force`）
- `node scripts\build-mouse-format-assets.js`
- `node --test tests\mouse-assets.test.js tests\ui-static.test.js`
- 打开桌面端或本地服务截图检查鼠鼠头身是否仍是同一个角色，不能出现圆头像贴矢量身体
- 用中文文件名测试音频转换，确认输出名仍是 `原文件名.目标格式`
- 用两个文本文件批量转 HTML，确认队列状态、保存全部和输出文件名正常
- 用文字型 PDF 转 XLSX，检查表格列没有明显错位
- 用 PNG 转 PDF、两张图片合并 PDF、PDF 转 PNG/JPG 压缩包，检查源文件未被修改
- 用带文字的图片转 TXT、图片型 PDF 转 TXT，检查源文件未被修改

当前可交接状态、产物哈希和未解决风险见 [`docs/HANDOFF.md`](docs/HANDOFF.md)。
