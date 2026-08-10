# 发布流程

## 发布前

1. 确认 `package.json`、`package-lock.json`、`win7-package-lock.json` 与文档版本一致。
2. 确认 `build/icon.png` 仍由 `public/assets/mouse-format/mouse-idle.png` 生成。
3. 准备 `bin/` 的 FFmpeg、AVS3、LibreOffice、Poppler 与 Tesseract；本地完整测试运行 `npm test`。
4. 运行 `npm run test:ci`、真实 NCM/AV3A 回归、`npm audit --omit=dev` 和 `git diff --check`。
5. PDF 智能表格固定样本必须满足：电子 PDF 单元格准确率不低于 95%，扫描 PDF 不低于 85%，表格数量、页签和明确合并区域 100% 正确。

## 标准 Windows 10/11 x64 构建

```powershell
npm run dist
```

输出：`dist/FlyingMouse Format-Setup-<version>-x64.exe` 和 `dist/win-unpacked/`。验收 ProductVersion、安装包哈希、ASAR 白名单、转换资源、内嵌鼠鼠图标和当前 Windows 12 秒冒烟。

## Windows 7 SP1 x64 Legacy 构建

```powershell
npm run dist:win7
```

- 只允许 Node.js 18–22，推荐官方 Node.js 22 LTS。构建在任何 staging 写入前 fail closed，npm、Electron runtime probe 和 builder 子进程绑定当前 Node。
- 独立 profile 固定 Electron `22.3.27`、Sharp `0.32.6`、PDF.js `2.16.105`、Turndown `7.2.0`，使用专用 `win7-package-lock.json` 和 `npm ci`，不修改根 manifest、lock 或 `node_modules`。
- staging 固定为 `output/win7-stage/`；复制支持 Unicode 路径并拒绝 reparse point、特殊文件和越界资源。
- npm 前后按原始字节和 SHA-256 绑定 staging manifest/lock；本地 builder 和 `extraResources` 必须通过 regular-file、canonical containment 与递归 reparse 检查。
- Electron runtime probe 在 builder 前验证 staging PDF.js、Turndown ATX/Fenced 转换与运行时版本。

检查命令：

```powershell
node scripts/build-win7.js --prepare-only
npm test --prefix output\win7-stage
npm audit --omit=dev --prefix output\win7-stage
node scripts/inspect-pe.js "output/win7-stage/dist/win-unpacked/FlyingMouse Format.exe"
node scripts/inspect-pe.js "dist/FlyingMouse Format-Setup-<version>-win7-x64.exe"
```

内层应用必须为 PE32+、目标 OS `5.2`；NSIS 外壳为 PE32、OS `4.0`，不能代替内层兼容性证据。Release 必须披露未签名、Electron 22 EOL、Win7 Legacy 审计风险和“真实 Windows 7 SP1 x64 设备待验收”。

## 固定引擎 Release CI

- `ci-engines-v1.json` 固定引擎资产名、Release tag、SHA-256 与必需文件。
- `.github/workflows/release.yml` 使用 `actions/cache` 缓存 `output/ci-engines-v1.tar.zst`；缓存未命中才从 `ci-engines-v1` Release 下载。
- `scripts/restore-ci-engines.ps1` 必须先比对 SHA-256，再解包并检查 FFmpeg、Poppler、LibreOffice、OCR 数据和 AVS3 文件。
- 标签工作流执行 `npm ci`、完整 `npm test`、生产审计、标准包与 Win7 包构建、产物存在性和 PE 检查。超时上限为 180 分钟。

## v0.3.3 当前基线

- 主线：169 项，167 通过、2 个预期 skip、0 失败；CI 子集 138/138。
- Node.js 22 Win7 staging：90/90。
- 根生产审计：0；Win7 Legacy：2 high、0 critical。
- 3 个真实 NCM/AV3A 样本转换成功且源文件不变。
- 标准安装包：548,634,899 字节，SHA-256 `3f812a515d9ab899929d1a5d42c7ac0903ad7baab65690bef719757aa51bec79`。
- Win7 安装包：517,688,135 字节，SHA-256 `ee04bb1a22f56036d47f2ad98f6a20513c2430e619b98eec1ef098d52579726a`。
- 最终 GitHub Release validation：`31350567825`，完整流程通过；v0.3.3 两个远端资产已回读一致。

## GitHub 发布顺序

1. 先发布并回读固定 `ci-engines-v1.tar.zst` 资产，确认大小与 digest。
2. 推送 `main`，创建并推送新的 `v0.3.3` 标签；不得移动或覆盖 v0.3.2。
3. 等待标签 Release workflow 全部通过；任一测试、审计、构建或产物门禁失败都不得创建 v0.3.3 Release。
4. 创建 GitHub v0.3.3 Release，上传标准 x64 和 `win7-x64` 两个 NSIS 安装包。
5. 回读标签、资产文件名、大小、SHA-256/digest 和下载链接，再把远端证据写回 `HANDOFF.md`。

## Microsoft Store

商店包必须从当前鼠鼠 UI 版本重新构建并重新截图。Partner Center 审核属于外部状态，未经实时查看不得写成已通过或正在审核。
