# FlyingMouse Format v0.3.2 交接

更新时间：2026-08-09

## 项目边界

- 仓库：`D:\34615\飞鼠格式`
- GitHub：`https://github.com/LaoFeng-mouse/flyingmouse-format`
- 产品：鼠鼠 UI 的 FlyingMouse Format（飞鼠格式）
- 排除项：`鼠鼠打印` 是另一个项目，本次没有修改

## 标准 Windows 10/11 x64 包（既有证据）

- 版本：`0.3.2`
- 安装包：`dist\FlyingMouse Format-Setup-0.3.2-x64.exe`
- GitHub 现有资产：`FlyingMouse.Format-Setup-0.3.2-x64.exe`
- 安装包大小：548,510,595 字节
- SHA-256：`5df0eb6b8223333a7c2198906dd6171207f1693c34584a037106d696473284e6`
- 解包 EXE ProductVersion：`0.3.2.0`
- GitHub Release：`https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.3.2`（Latest）
- GitHub main：`c896a58311a3550ecea3668eeb1a758f465be45c`
- 签名：未签名，SmartScreen 可能提示

## Windows 7 SP1 x64 兼容包

- 锁定管线前临时安装包：`dist\FlyingMouse Format-Setup-0.3.2-win7-x64.exe`（下列值只供对照，不是最终发布值）
- 临时安装包大小：517,755,320 字节
- 临时安装包 SHA-256：`e2e1c015aca2400d4ba753a32addeb8ac7d30a11deea08c67fed87f896edb52a`
- 临时解包 EXE ProductVersion：`0.3.2.0`
- 临时解包 EXE SHA-256：`cecc0ed5644ec13e91b027c2e004b0cc10ea0cecd3de1d8d0108c57e8e8ace48`
- 临时解包 EXE：PE32+，目标 OS `5.2`
- 临时 NSIS 外壳：PE32，目标 OS `4.0`（不是应用兼容性判断对象）
- 预期锁定运行时：Electron `22.3.27`、Sharp `0.32.6`、PDF.js `2.16.105`
- 临时安装包签名：未签名
- 最终锁定成品：须在主仓真实 `bin/` 上执行 `npm run dist:win7` 后，重新记录大小、安装包/内层 EXE SHA-256、PE、ProductVersion、签名、ASAR/资源、图标和冒烟结果。
- GitHub 资产：截至 2026-08-09 尚未上传，未做远端大小或 SHA-256 回读验证

## 功能结果

- 恢复并保留鼠鼠 UI，没有改成闲鱼交付版。
- 常规 NCM 和 Audio Vivid（AV3A）NCM 转换路径已整合。
- 目标格式按源扩展名分别记忆，用户改选后更新默认值。
- 保存目录会在下次保存时继续使用。
- 支持中文/English，用户选择会被记住。
- 打包图标已从旧橙色闪电改为鼠鼠，并增加回归测试。
- 桌面 `FlyingMouse Format.lnk` 指向 v0.3.2 解包 EXE，图标来源为 EXE 内置图标。

## 验证证据

### 标准版既有发布验证（2026-08-08）

- 自动化测试：72/72 通过。
- NSIS 构建：成功。
- 成品 EXE 内嵌图标：已提取并目视确认是鼠鼠。
- 桌面快捷方式：已刷新并通过真实桌面截图确认显示鼠鼠图标。
- 标准版 GitHub 资产：既有上传已完成，远端大小与 SHA-256 和本地标准安装包一致。

### Win7 分支验证（2026-08-09）

- Win7 主线自动化：124 项，122 通过、2 个真实 fixture 条件跳过、0 失败。
- 锁定管线前运行时 staging 验证：83 项，81 通过、2 个真实 fixture 条件跳过、0 失败；可作回归基线，但最终锁定 staging 仍须复跑。
- 锁定构建管线代码与自动化已验证：专用 `win7-package-lock.json` 经 `npm ci` 重建 staging；npm 前后会校验 staging manifest/lockfile 的原始字节和 SHA-256。本地 builder 必须通过 regular-file/canonical/reparse 检查，`extraResources` 必须在各自允许根目录内通过 canonical containment 与递归 reparse 检查。该结论不等于最终锁定成品已构建。
- 锁定管线前真实 NCM：用户提供的 3 个样本均端到端转换为可播放 MP3，源文件 SHA-256 均未改变；最终锁定成品构建后仍须复验。
- 锁定管线前 ASAR/资源：`server.js` 与源码 SHA-256 一致，包含 PDF.js 本地依赖边界和 `isEvalSupported: false`；AV3A、FFmpeg、LibreOffice、Poppler、Tessdata 资源齐全。最终锁定 ASAR 与资源须重新核对。
- 锁定管线前当前 Windows 冒烟：Microsoft Windows 11 家庭版 中文版，x64，Version `10.0.26200` / Build `26200`；临时解包 EXE 连续运行 12 秒，4 个精确同路径 Electron 进程均响应，测试后只结束本次启动的进程。最终锁定解包 EXE 须重新冒烟。
- Win7 设备验收：尚未在真实 Windows 7 SP1 x64 机器运行，仍为待验收，不得写成已完成。
- staging 生命周期：完整测试中的安全性用例会按设计清理 `output/win7-stage/`；需要复核内层 EXE 时先重新准备或构建。根 `dist` 中当前仅保留锁定管线前临时包，不能据此跳过最终锁定构建。

## 仍需注意

- NCM 仅保证兼容 `music.163.com` 对应网易云音乐客户端的文件；其他来源的同扩展名文件不在兼容范围。
- Git 仓库不包含大型转换引擎，源码开发环境需自行准备 `bin/`；普通用户应使用 Release 安装包。
- Microsoft Store 的历史提交状态没有在本次实时登录 Partner Center 核验；更新商店时必须使用当前鼠鼠 UI 重新打包和截图。
- 正式公开分发前建议配置可信代码签名。
- 标准版 `npm audit --omit=dev` 为 0；锁定管线前 Win7 staging 遗留依赖审计为 2 个 high（PDF.js、Sharp），最终锁定 staging 须复跑审计。PDF.js 动态执行已通过 `isEvalSupported: false` 缓解；Sharp 0.32 的 libvips 风险仍存在，Win7 包只建议离线处理可信文件。

发布与验证步骤见 [RELEASE.md](RELEASE.md)，代码结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。
