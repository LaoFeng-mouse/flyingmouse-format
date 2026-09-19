# 0.7.5 审查修复候选

日期：2026-09-16。基于本任务已核对的 0.7.4 公开源码隔离修复。仅本地候选，尚未上传或发布；当次验证结果以交付目录为准。

修复多 PDF 操作路由、连续空白页、空白页模式切换、异步预览、JSON 数字保真、CSV 多行导出、图片合并取消早停、YAML 正文日志、诊断文件名脱敏及 CLI 临时副本清理。保留现有品牌资产、引擎和渠道功能范围。

新模块 conversion-cancellation.js 必须入包。原生启动器在 fresh Electron/ASAR 完整绑定之后通过 afterSign 重新编译并附加，禁止将新 ASAR 单独放到旧 Electron EXE。

普通图片/批次资源预算仍沿用原设定。公开版未新增音乐功能或取消界面；可选取消参数用于共享底层模块。本地版图片/PDF/OCR取消在步骤边界停止，不能保证单个原生处理步骤即时可中断。

四项新回归已登记：image-merge-regressions.test.js、text-fidelity-regression.test.js、ui-operation-lifecycle.test.js、cli-runtime-cleanup.test.js。现有安装包和原源码目录保留。

追加音频保存后缀保护：原生保存对话框按实际产物格式设置筛选；返回文件名缺少或不匹配后缀时补齐，目标变化时保持覆盖确认及不覆盖竞争文件的保护。save-dialog.js 必须入包，tests/save-dialog.test.js 登记全量测试。
