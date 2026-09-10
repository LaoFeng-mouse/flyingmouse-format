# 0.6.10 发布说明（商店版稳定性 · 复核遗留 P1–P5）

> 分支 `fix/0.6.10-save-safety`（基于 main `f05c0b9` = 0.6.9）。承接 0.6.9 代码复核结论，修复全部 5 项遗留缺陷。

## 修复内容

### P1 下载保存失败不再删除用户已有文件
- 新增根模块 `save-download.js`：下载落盘改为「同目录随机 `.partial` 临时文件 → 收全字节 + 关流 + content-length 校验通过 → rename 发布」。
- 失败路径只清理本次临时文件，目标文件（destination）永不被 rm。旧实现写流 `error` 后统一 `fs.rm(destination)`，源 URL 404/500/中途断连会把用户上一次成功产物删掉。
- 重定向信任校验由主进程注入 `resolveRedirect`，逐跳校验。
- 回归：`tests/save-download.test.js`（404/500/截断/断连/拒重定向/静态守卫 7 项），并做新旧实现对照复现（旧=404 后文件消失；新=逐字节保留）。

### P2 设置持久化降级覆盖全部入口（不只启动）
- `public/app.js` 统一入口 `persistSettings(patch)`：先更新 `state.settings` 内存、再刷 UI，最后尽力持久化；失败只置一次性 `settingsDegraded` 非阻断警告，不再静默丢失。
- 启动两处迁移降级（migrate / getSettings 的 catch）都携带 `legacy.language`，防止迁移失败把用户语言偏好丢回系统语言。
- 回归：`tests/settings-degrade-ui.test.js`（5 项静态守卫，沿用仓库「渲染进程无 DOM 单测框架」惯例）。

### P3 引擎缓存发布需清单校验 + 真实冒烟，`.complete` 不再是唯一证据
- 新增根模块 `store-engine-cache.js`：复制到 `<final>.staging` → 按打包期清单校验关键文件（size 全记，≤5MB 加 sha256，mergedlo 等百 MB 级只 stat）→ 真实最小 CSV→PDF 冒烟转换（90s 超时）→ 写 `.complete` → rename 发布 → 发布成功后才回收其余旧缓存。
- 来源包残缺（如缺 DLL）永不发布，且绝不动本来可用的旧缓存；无清单的旧包退回 0.6.9 判定但仍执行冒烟。
- 新增清单生成器 `scripts/build-engine-manifest.js`（48 个关键文件白名单），产物 `engine-integrity.json` 随 extraResources 进包（bin/libreoffice 为 gitignore，需在引擎齐全的机器生成）。
- 回归：`tests/store-engine-cache.test.js`（7 项，含本机真实引擎冒烟）。
- 已知取舍：首启准备仍为同步执行（与 0.6.9 同时机，避免引入新竞态），「首启等待」体感优化另行立项。

### P4 设置写盘队列清理条件修复
- `settings-store.js` `withSettingsLock`：要清理的队尾 Promise 先存局部 `queued`，存入 Map 与比较为同一对象（旧实现比较的是两个不同包装，条件永不成立、Map 无界增长）。
- 导出 `_mutationChainsSize()` 作回归探针。
- 回归：`tests/settings-store.test.js`（8 项）。

### P5 版本同步脚本原子化
- `scripts/release-version-sync.js` 重写为两阶段：阶段一全部读入 + 校验 + 内存生成（零写入）；阶段二逐文件写盘，中途 IO 失败逐一回滚已写文件。
- 回归：`tests/release-version-sync-atomic.test.js`（4 项：最后一个 lock 非法→零写入；只读 README→回滚；dry-run 不动盘）。

## 测试
- 全量：519 例，477 通过 / 30 失败；失败集与改动前基线逐条一致（fix worktree 的 `bin/` 缺引擎二进制，ffmpeg/pdftoppm ENOENT，经 `git stash -u` 对照证实非本批引入）。
- 本批新增/改动测试：save-download 7/7、settings-degrade-ui 5/5、store-engine-cache 7/7、settings-store 8/8、release-version-sync-atomic 4/4。
- 新根模块已登记 `build.files`；新测试文件已同时加入 `test` 与 `test:ci` 两处列表。

## 渠道
- 商店（APPX）：随 0.6.10 重打包交付；manifest 版本 0.6.10.0。
- GitHub Release / tag 与 Partner Center 上传由维护者本人操作。
