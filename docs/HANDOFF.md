# FlyingMouse Format 当前交接

更新时间：2026-08-08

## 项目边界

- 仓库：`D:\34615\飞鼠格式`
- GitHub：`https://github.com/LaoFeng-mouse/flyingmouse-format`
- 产品：鼠鼠 UI 的 FlyingMouse Format（飞鼠格式）
- 排除项：`鼠鼠打印` 是另一个项目，本次没有修改

## 当前版本

- 版本：`0.3.2`
- 安装包：`dist\FlyingMouse Format-Setup-0.3.2-x64.exe`
- 安装包大小：548,510,595 字节
- SHA-256：`5df0eb6b8223333a7c2198906dd6171207f1693c34584a037106d696473284e6`
- 解包 EXE ProductVersion：`0.3.2.0`
- 签名：未签名，SmartScreen 可能提示

## 本次结果

- 恢复并保留鼠鼠 UI，没有改成闲鱼交付版。
- 常规 NCM 和 Audio Vivid（AV3A）NCM 转换路径已整合。
- 目标格式按源扩展名分别记忆，用户改选后更新默认值。
- 保存目录会在下次保存时继续使用。
- 支持中文/English，用户选择会被记住。
- 打包图标已从旧橙色闪电改为鼠鼠，并增加回归测试。
- 桌面 `FlyingMouse Format.lnk` 指向 v0.3.2 解包 EXE，图标来源为 EXE 内置图标。

## 验证证据

- 自动化测试：72/72 通过。
- NSIS 构建：成功。
- 成品 EXE 内嵌图标：已提取并目视确认是鼠鼠。
- 桌面快捷方式：已刷新并通过真实桌面截图确认显示鼠鼠图标。

## 仍需注意

- NCM 仅保证兼容 `music.163.com` 对应网易云音乐客户端的文件；其他来源的同扩展名文件不在兼容范围。
- Git 仓库不包含大型转换引擎，源码开发环境需自行准备 `bin/`；普通用户应使用 Release 安装包。
- Microsoft Store 的历史提交状态没有在本次实时登录 Partner Center 核验；更新商店时必须使用当前鼠鼠 UI 重新打包和截图。
- 正式公开分发前建议配置可信代码签名。

发布与验证步骤见 [RELEASE.md](RELEASE.md)，代码结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。
