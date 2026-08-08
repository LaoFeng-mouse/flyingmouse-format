# AV3A 与转换操作记忆整合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Audio Vivid NCM 在安装版中可直接转换，并按源扩展名恢复最近目标格式、恢复最近成功保存目录。

**Architecture:** AV3A 继续由 `av3a-format.js` 抽取码流并调用随包资源解码为 WAV，再交给现有 FFmpeg。目标偏好放在独立的浏览器纯函数模块并使用版本化 localStorage；保存目录放在主进程独立 JSON 设置模块，Electron IPC 只使用可信页面和经过校验的本地目录。

**Tech Stack:** Electron 43、Node.js、原生 `node:test`、浏览器 localStorage、electron-builder extraResources。

---

### Task 1: 将 AV3A 运行资源纳入安装包

**Files:**
- Create: `bin/avs3/avs3RM0Decoder.exe`
- Create: `bin/avs3/model.bin`
- Create: `bin/avs3/THIRD_PARTY_NOTICE.txt`
- Modify: `package.json`
- Modify: `electron-main.js`
- Test: `tests/electron-hardening-static.test.js`

- [ ] 先在静态测试中要求 `extraResources` 包含 `bin/avs3 -> avs3`，并要求主进程设置 `FLYINGMOUSE_AVS3_DECODER_PATH`。
- [ ] 运行 `node --test tests/electron-hardening-static.test.js`，确认因资源配置缺失而失败。
- [ ] 复制已验证的解码器和模型，保留完整版权、限制用途和免责声明；在 `boot()` 中设置资源路径。
- [ ] 重新运行静态测试并校验两个二进制 SHA256。

### Task 2: 按源扩展名记忆目标格式

**Files:**
- Create: `public/conversion-preferences.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `package.json`
- Test: `tests/conversion-preferences.test.js`

- [ ] 为 `normalizeExtension()`、损坏存储回退、单扩展恢复、手动覆盖、混合扩展一致/冲突编写失败测试。
- [ ] 运行 `node --test tests/conversion-preferences.test.js`，确认模块缺失。
- [ ] 实现版本键 `flyingmouse.conversionPreferences.v1`，API 为 `rememberTarget(storage, extensions, target)` 与 `preferredTarget(storage, extensions, availableTargets)`。
- [ ] 在文件目标加载完成后只恢复仍可用的共同目标；在 `targetSelect.change` 时为当前所有规范化源扩展写入新目标。
- [ ] 运行偏好测试及 `tests/ui-static.test.js`。

### Task 3: 持久化最近成功保存目录

**Files:**
- Create: `settings-store.js`
- Modify: `electron-main.js`
- Modify: `package.json`
- Test: `tests/settings-store.test.js`

- [ ] 为设置缺失、损坏 JSON、路径不是目录、原子写入和取消不更新写失败测试。
- [ ] 运行 `node --test tests/settings-store.test.js`，确认模块缺失。
- [ ] 实现 `readLastSaveDirectory(settingsPath, fallbackDirectory)` 和 `writeLastSaveDirectory(settingsPath, directory)`；写入临时文件后原子替换。
- [ ] 单文件保存默认路径使用 `lastDirectory + fileName`，批量保存选择器使用 `lastDirectory`；只有下载全部成功后才写入新目录。
- [ ] 运行设置测试和 Electron 静态安全测试。

### Task 4: 完整回归、真实样本与安装包验收

**Files:**
- Modify: `package.json`
- Test: `tests/av3a-real.test.js`

- [ ] 运行 `npm test`，要求零失败。
- [ ] 使用三首用户样本运行 `tests/av3a-real.test.js`，要求生成 MP3 后 FFmpeg 全文件解码退出码为 0。
- [ ] 运行 `npm run dist`，确认 NSIS 和 `win-unpacked/resources/avs3` 存在。
- [ ] 启动打包版，验证普通 NCM 与 AV3A NCM 均可转换；目标格式和保存目录在重启应用后恢复。
- [ ] 运行 `git diff --check` 并提交整合改动。
