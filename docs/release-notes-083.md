# 飞鼠格式 0.8.3 公开版更新

作者：牢蜂（LaoFeng）。仅供个人免费使用，禁止商业售卖、转卖和套壳。

发布日期：2026-11-04。[v0.8.3 Release](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.8.3) 提供 **Windows 10/11 x64 完整版**，包含 ICO 转换、安全、依赖兼容及 PDF/OCR 长路径修复。公开功能只支持普通音频，不包含平台专用音乐模块或登录、凭据接入。此次未构建或发布 Lite、Win7、macOS 或 Microsoft Store 包。

- **完善 ICO 双向转换。**常见图片可生成 16、24、32、48、64、128、256 像素的多尺寸 Windows 图标；ICO 可转回 PNG、JPG、WebP 等格式，或与图片合并为 PDF。保持比例与透明度，小图补透明边、不放大；动画取首帧和 JPEG 白底合成会提示。补齐界面遗漏的 ICO 说明，切换语言后同步更新，清空文件或切换为其他目标格式后正确隐藏。增加图标目录、尺寸、像素与蒙版完整性检查，不支持的编码明确拒绝。
- **修复 PDF 栅格化与 OCR 长路径。**深层临时目录或长中文路径下，使用任务专属的短目录准备原生引擎输入和输出，覆盖 PDF 栅格化及 OCR 回退。保持原文件不变；失败或取消时清理所属临时文件，不发布未完成结果。
- **补齐公开安装包署名与许可。**统一作者及非商用元信息，包内保留原始 LICENSE，NSIS 安装器展示完整许可文本；不改变原许可条款。
- **修复普通媒体兼容问题。**正确识别音轨排在视频前面的输入，修正透明视频背景处理；支持普通媒体的 5.1(side) 音频转换到相应编码，保持多轨选择与提示一致。
- **完善失败与取消处理。**合并任务取消后不再发布残留结果；不可读取输入提供明确反馈。
- **加固电子书 HTML 导出。**按文档结构清理活动脚本和不安全链接，覆盖特殊标签拼接，同时保留正常正文、表格、图片及允许的链接。
- **升级依赖并保留 Excel 功能。**更新文件匹配、归档及构建工具的相关依赖。ExcelJS 保留 4.4.0 的普通与流式读写接口；修复流式写出、ZIP 元数据读取及损坏文件错误传递，避免截断 XML 被当作部分成功。

主线开发环境要求 **Node.js 22.13.0 或更新版本**。执行 `npm ci` 时自动应用受版本及文件摘要约束的四份兼容补丁，构建前再次校验。补丁内容、第三方许可和生产/构建适用范围见 [依赖补丁说明](../third-party/dependency-patches/NOTICE.md)。

最终公开构建在 Windows / Node 22.23.4 下完成验证：完整测试 **1,368 通过、0 失败、11 条件跳过**，生产与全量 npm 审计均为 **0 告警**，依赖树和四份补丁校验通过。入口、Runtime 与 ASAR 已整体重建；实际应用 **17 组 GUI 场景通过**（含 1 组损坏 ICO 预期拒绝、16 份转换产物），NSIS 归档完整性及 **20,633 个载荷文件**比对通过。图文 PDF 的保守 OCR 回退继续显示图片/版式损失提示；纯文字原生转换另行验证无告警。本轮未执行安装器覆盖安装。npm 审计结果不代表原生转换引擎或整套软件零风险。

[PR #88](https://github.com/LaoFeng-mouse/flyingmouse-format/pull/88) 已合并，其 [CI](https://github.com/LaoFeng-mouse/flyingmouse-format/actions/runs/41810778109) 和 [合并后 main CI](https://github.com/LaoFeng-mouse/flyingmouse-format/actions/runs/41811574267) 的 Windows、macOS x64/arm64 检查均通过。发布标签指向 `e8d0827016192f980893b08c09920305ef089dab`，与构建提交 `49908ae9d930fff6bab14f89eb3131f58016d86d` 的 Git 树相同。

安装器原构建名为 `FlyingMouse Format-Setup-0.8.3-x64.exe`；公开下载名为 [`FlyingMouse-Format-Setup-0.8.3-x64.exe`](https://github.com/LaoFeng-mouse/flyingmouse-format/releases/download/v0.8.3/FlyingMouse-Format-Setup-0.8.3-x64.exe)，字节相同，大小 **1,618,541,947 字节**。SHA-256：`3a3825bd3eb751c451978c6248a52c17e122fdf708556fd7a4cc55739592ec2d`。同页提供 blockmap、`latest.yml` 与 `SHA256SUMS.txt`；完整校验表见 [公开交接](HANDOFF.md)。

Windows 安装器未签名。Windows 7 继续使用独立 Legacy 运行环境和锁文件，本次主线升级不构成 Win7 风险清零或实机验收；macOS 的代码和引擎 CI 不替代安装包构建与真实设备验收，Microsoft Store 本轮未提交或发布。
