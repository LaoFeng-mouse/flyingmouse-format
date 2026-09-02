## FlyingMouse Format v0.5.4（满血版）

> 版本说明：v0.5.4 为**满血版（full-version）**构建，与 Microsoft Store 公开线（v0.6.x）相互独立。本 Release 为预发布通道：功能与商店线 0.6.5 同源更新，并包含商店版不提供的能力。

### 新增

- **PDF → ODT/ODF（开源文档）**：PDF 转 Word 中间件后由 LibreOffice 转出标准 ODF 文档，段落/表格/图片版式保留；无 LibreOffice 环境（如 Win7 版）自动隐藏该目标。
- **PDF → Word 版式还原（docengine）持续增强**：统一文档引擎（pdf2docx + camelot 合并，含 qpdf 引擎资产）；版式还原失败时自动记录原因并回退结构化提取链路，不再静默卡住。
- 继承 v0.5.3：扫描件 PDF → Word 表格重建（检测表格线 → 逐格 OCR → 可编辑 docx 表格）、图片合并 PDF 逐张流式写盘（大量图片不再 OOM）、恢复打赏渠道（小鱼干）。

### 修复

- **损坏视频不再误报「没有音频轨道」**：文件损坏、未下载完整或容器无效时，现在明确报「音视频文件无法读取，可能已损坏」（MEDIA_INPUT_UNREADABLE）；只有文件正常但确实无声轨才报「没有音频轨道」。
- **PDF→Word 长文件转档可观测**：版式引擎耗时/失败时输出诊断日志（含失败原因），转换卡住可导出诊断报告定位。
- 继承 v0.5.3：mflac 全零占位文件明确报错、iOS 扫描件 PDF 版式提取崩溃（docstructure 引擎重打修复）、EPUB data-descriptor 断链与 docx 标题丢失、OFD 二次转换文字层失效、.fb2.zip 路由与真 latin1 文件名解码。

### 稳定性与门禁

- 全量测试：543 项 = 538 通过 / 5 跳过（fixture 保护）/ 0 失败。
- Electron 安全边界复查通过（contextIsolation / sandbox / IPC 同源信任全 handler 覆盖）。

## 下载指南

| 你的系统 | 下载这个文件 |
|---|---|
| **Windows 10 / 11（64 位）** | `FlyingMouse-Format-Setup-0.5.4-x64.exe` |

> ⚠️ 提示：
> - `latest.yml` 和 `*.blockmap` 是自动更新内部文件，**不要手动下载**。
> - Windows 7 包与 macOS 包本版暂未随此预发布通道提供，需要 Win7 的用户请联系作者（3465177342@qq.com）。
> - 安装包未签名，SmartScreen 提示时选择「仍要运行」。

### 已知限制

- Windows / macOS 安装包未签名
- Windows 7 版与 macOS 版不含文档引擎（Python 3.12 不支持 Win7；引擎为 Windows 专用），PDF→Word/Excel 退回纯文字提取
- musicex 无任何权限的歌曲（已下架/需购买）仍无法转换
- 相机 RAW 为实验性支持

### 许可

作者：牢蜂（LaoFeng）。非商用许可：仅供个人免费使用，禁止销售、转卖、收费服务、电商平台倒卖、套壳换皮重新发布。完整条款见仓库 LICENSE 文件。
