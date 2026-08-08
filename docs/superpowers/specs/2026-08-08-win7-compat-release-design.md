# FlyingMouse Format v0.3.2 Win7 兼容版设计

## 目标

在不降低 Windows 10/11 主版本 Electron 43、安全边界和功能的前提下，恢复可重复构建的 Windows 7 SP1 x64 兼容发行通道，并生成 `FlyingMouse Format-Setup-0.3.2-win7-x64.exe`。

Win7 兼容版必须使用当前鼠鼠 UI，并包含 v0.3.2 已有能力：普通 NCM、Audio Vivid（AV3A）NCM、按源格式记忆目标格式、保存目录记忆、中文/English、批量转换和鼠鼠打包图标。`鼠鼠打印` 不在本次范围内。

## 已有基础

2026-08-07 已在 `D:\34615\飞鼠格式-win7` 构建过 v0.2.1 Win7 版，并上传到 GitHub v0.2.1 Release。旧方案使用：

- Electron `22.3.27`；
- Sharp `0.32.6`；
- pdfjs-dist `2.16.105`；
- NSIS x64 独立安装包；
- PDF.js `.mjs` 到 legacy `.js` 的加载回退；
- 48/48 自动化测试、解包版启动冒烟和 PE 系统版本检查。

旧副本只作为已验证兼容参数的证据，不再作为长期维护源。新版必须从当前主仓库生成，避免功能和文档继续漂移。

## 方案选择

### 采用：主仓库中的可重复 Win7 构建配置

主仓库保留 Electron 43 和现有依赖。新增 Win7 构建脚本，将当前受控源码复制到 Git 忽略的临时构建目录，再生成 Win7 专用 `package.json`、安装依赖并调用 electron-builder。

优点：

- 主版本不降级；
- Win7 包每次从当前源码生成，不再手工维护第二套应用代码；
- 兼容依赖、打包白名单和产物名称可以自动测试；
- 后续功能更新可以用同一命令重新生成 Win7 包。

### 不采用：继续手工维护 `D:\34615\飞鼠格式-win7`

旧副本已经落后于 v0.3.2，缺少 AV3A、操作记忆、双语和新版图标。继续复制文件容易漏模块、漏资源或把旧 UI 带回发布包。

### 不采用：整体降级主版本

把主版本也降到 Electron 22 会让 Win10/11 用户使用已经停止维护的 Chromium/Node 内核，并失去当前 Electron 43 的安全更新，不符合产品边界。

## 架构

```text
当前主仓库（Electron 43）
        │ npm run dist:win7
        ▼
Win7 构建脚本
├─ 创建 Git 忽略的临时 staging 目录
├─ 复制当前受控源码、public 与必要资源
├─ 生成 Win7 专用 package.json
├─ 安装 Win7 兼容依赖
└─ 调用 electron-builder NSIS x64
        ▼
FlyingMouse Format-Setup-0.3.2-win7-x64.exe
```

临时目录和其 `node_modules`、`dist` 不进入 Git。构建脚本不得修改主仓库的 `package.json`、`package-lock.json` 或 `node_modules`。

## Win7 构建配置

Win7 专用配置固定：

- `electron`: `22.3.27`；
- `sharp`: `0.32.6`；
- `pdfjs-dist`: `2.16.105`；
- `electron-builder`: 沿用当前构建工具；
- `artifactName`: `${productName}-Setup-${version}-win7-${arch}.${ext}`；
- `win.target`: 仅 `nsis`，不生成 APPX/MSIX；
- 架构：仅 x64；
- 系统要求：Windows 7 SP1 x64。

打包白名单必须包含当前所有根模块，尤其是 `logger.js`、`settings-store.js`、`ncm-format.js`、`av3a-format.js` 和 `kgg-format.js`。`extraResources` 必须包含 FFmpeg、AVS3、LibreOffice、Poppler、tessdata 和 Tesseract core。

## 共享代码兼容改动

当前 `server.js` 的 PDF.js 加载只导入 `pdfjs-dist/legacy/build/pdf.mjs`。共享实现改为：

1. 优先导入当前主版本的 `.mjs`；
2. 导入失败时回退 Win7 依赖提供的 `legacy/build/pdf.js`；
3. 使用 `mod.default || mod` 归一化导出。

此改动同时兼容主版本和 Win7 版本，不改变转换接口。其他 Win7 差异只存在于生成的构建配置中。

## 测试设计

遵循测试先行：

1. 为 Win7 配置生成器编写失败测试，断言固定兼容依赖、NSIS-only、x64 产物名、完整模块白名单和 AVS3 资源；
2. 为 PDF.js 双路径加载写失败测试或静态接线测试；
3. 实现最小配置生成器和加载回退，使测试转绿；
4. 运行主仓库完整测试，要求保持 72/72 或因新增测试而只增加、不减少；
5. 在 Win7 staging 依赖环境运行完整测试，确认 Sharp、PDF.js、OCR、NCM/AV3A 路由和保存设置代码可加载；
6. 运行 `npm audit --omit=dev`，分别记录主版与 Win7 版结果。Win7 因固定旧依赖产生的风险必须如实列出，不通过强制升级破坏兼容性。

## 成品验收

- NSIS Win7 x64 安装包构建成功；
- 解包 EXE 的 ProductVersion 为 `0.3.2.0`；
- PE 最低系统版本不高于 Windows 7 内核版本；
- 解包版可启动，日志出现本地服务和窗口加载成功；
- 鼠鼠 UI、中文/English 和鼠鼠内嵌图标可见；
- 打包内容包含 AVS3 helper、模型、转换引擎和新增根模块；
- 至少在打包版接口验证普通转换与一份 AV3A NCM；
- 计算安装包 SHA-256，并与 GitHub 远端资产摘要回读一致。

当前环境不是 Windows 7。PE 检查和在新系统上的 Electron 22 冒烟只能证明候选包具备兼容基础，不能替代真实 Win7 SP1 x64 机器验收。发布说明必须明确这一证据边界；获得真实 Win7 运行反馈后再记录为现场通过。

## 发布

- 不移动或重建 Windows 10/11 主安装包；
- 将 `FlyingMouse Format-Setup-0.3.2-win7-x64.exe` 追加到现有 GitHub v0.3.2 Release；
- Release 说明明确“仅 Windows 7 SP1 x64”“Legacy”“Electron 22 已停止上游安全维护”“安装包未签名”；
- README 中提供按系统选择安装包的中英文说明；
- `docs/RELEASE.md`、`docs/HANDOFF.md` 和 `AGENTS.md` 记录可重复构建命令、兼容边界、哈希和实际验证状态；
- 不把 Win7 版提交 Microsoft Store。

## 安全边界

- 保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、严格 CSP、同源 IPC 和下载校验；
- 不为兼容 Win7 关闭现有安全开关；
- Win7 版只解决操作系统加载与依赖兼容，不承诺获得 Electron 22 的未来安全更新；
- Win10/11 用户继续使用 Electron 43 主版本。
