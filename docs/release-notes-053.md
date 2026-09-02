## FlyingMouse Format v0.5.3

> 说明：v0.5.3 为内部迭代版本，未单独发布安装包；其全部改动并入 v0.5.4 一起发布。本文件留存版本记录。

### 新增

- **扫描件 PDF → Word 表格重建**：扫描版 PDF 转 Word 时先检测表格线，按格 OCR 后重建为可编辑的 docx 表格（此前扫描件只能出纯文字）；无表格线的页面自动回落整页 OCR 文字提取。
- **恢复打赏渠道**：软件说明内恢复「小鱼干」收款码入口。

### 修复

- **大量图片合并 PDF 内存溢出（OOM）**：改为逐张流式写盘，几百张图合并不再崩。
- **mflac 全零占位文件明确报错**：下载中断产生的空壳 .mflac 现在报「文件为空」类错误（MFLAC_BLANK_FILE），不再误导性地报「footer 缺失」。
- **docstructure 引擎对 iOS 扫描件崩溃**：PyInstaller 冻结缺陷重打修复，iPhone 扫描类 PDF 版式提取恢复正常。

## FlyingMouse Format v0.5.3（构建门禁结论）

- 全量测试：通过；npm audit（--omit=dev）：2 个 moderate（fast-xml-parser 传递依赖，项目已记录例外：仅 XMLParser 解析方向使用，advisory 针对不使用的 XMLBuilder 写入方向）。
