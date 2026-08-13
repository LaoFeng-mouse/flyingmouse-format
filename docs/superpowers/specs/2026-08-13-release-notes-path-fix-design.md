# v0.5.0 Release 正文与发布说明路径修正设计

## 目标

修正已经公开的 GitHub v0.5.0 Release 正文，并防止后续标签发布再次因发布说明路径计算错误而回退到 `docs/RELEASE.md`。

## 已确认根因

发布工作流先生成 `docs/release-notes-0.5.0.md`，随后对完整路径执行 `${NOTES//./}`。这不仅删除版本号中的句点，也删除扩展名前的句点，最终得到不存在的 `docs/release-notes-050md`。仓库实际存在的专用说明是 `docs/release-notes-050.md`，因此工作流触发回退逻辑并把通用发布流程作为 v0.5.0 正文。

## 修改范围

1. 将版本号与路径分开处理：只删除版本号 `0.5.0` 中的句点，再拼成 `docs/release-notes-050.md`。
2. 增加自动化回归测试，断言 `v0.5.0` 能解析到 `docs/release-notes-050.md`，并保留专用说明缺失时回退到 `docs/RELEASE.md` 的行为。
3. 使用现有 `docs/release-notes-050.md` 更新线上 v0.5.0 Release 正文，不重建安装包、不移动标签、不更换附件。

## 实现方式

把发布说明选择逻辑提取到可测试的仓库脚本中，由 GitHub Actions 调用该脚本并读取输出路径。脚本仅接受标签和仓库根目录，拒绝非法标签输入；专用说明存在时返回专用文件，否则返回通用发布文档。

相比继续在 YAML 内堆叠 Bash 字符串替换，这种方式能由现有 Node.js 测试框架直接覆盖，也避免 Shell 转义再次破坏扩展名。

## 验收标准

- 回归测试在旧逻辑下能够复现错误，在新逻辑下通过。
- `v0.5.0` 解析结果精确为 `docs/release-notes-050.md`。
- 缺少专用说明时精确回退到 `docs/RELEASE.md`。
- 完整相关测试与 `git diff --check` 通过。
- GitHub Release 回读显示正文来自 `docs/release-notes-050.md`，Release 仍为公开、Latest、非 prerelease，原附件数量与摘要不变。

## 不在范围内

- 不重建或重新上传 v0.5.0 安装包。
- 不移动或重建 `v0.5.0` 标签。
- 不修改 Microsoft Store 提交状态。
- 不借此修订其他产品功能或发布历史。
