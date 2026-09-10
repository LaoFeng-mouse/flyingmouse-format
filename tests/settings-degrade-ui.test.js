const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

// P2（2026-09-10 复核）：设置降级必须覆盖「启动之后的用户操作」。旧回调
// `state.settings = await logBridge.updateSettings(...)` 裸奔——写盘一失败，
// 语言切换的 refreshLanguage() 被跳过、默认格式新值不进内存。统一入口
// persistSettings()：内存先行、持久化尽力、失败只置一次降级警告。
// 渲染进程无单测框架（仓库既有约定：ui-static.test.js 的静态守卫），沿用同法。

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

test("all settings persistence goes through the degraded-tolerant persistSettings()", () => {
  assert.match(appSource, /async function persistSettings\(patch\)/, "缺少统一持久化入口");
  assert.match(appSource, /catch \(error\) \{\s*rendererLog\("warn", "设置持久化失败/, "persistSettings 必须 catch 持久化错误");
  const bare = [...appSource.matchAll(/state\.settings\s*=\s*await logBridge\.updateSettings/g)];
  assert.equal(bare.length, 0, "成功响应不能整份覆盖本地偏好");
  assert.match(appSource.slice(appSource.indexOf("async function persistSettings"), appSource.indexOf("languageSelect.addEventListener")),
    /await settingsSync\.persist\(patch\)/, "持久化必须保留未落盘字段并处理响应先后顺序");
});

test("language change updates in-memory settings and UI before persisting", () => {
  const handler = appSource.slice(
    appSource.indexOf('languageSelect.addEventListener("change"'),
    appSource.indexOf('targetSelect.addEventListener("change"')
  );
  assert.ok(handler, "语言回调缺失");
  const memoryAt = handler.indexOf('state.settings = { ...state.settings, language');
  const refreshAt = handler.indexOf("refreshLanguage()");
  const persistAt = handler.indexOf("await persistSettings({ language");
  assert.ok(memoryAt >= 0, "语言变更必须先写入内存设置（持久化失败不影响本次会话）");
  assert.ok(memoryAt < refreshAt && refreshAt < persistAt, "顺序必须是 内存→UI 刷新→尽力持久化");
  assert.match(handler, /i18n\.language === "zh-CN" \|\| i18n\.language === "en-US"/, "内存只接受白名单语言值（与主进程规范化一致）");
});

test("default target change updates in-memory settings before persisting", () => {
  const handler = appSource.slice(
    appSource.indexOf('targetSelect.addEventListener("change"'),
    appSource.indexOf('downloadButton.addEventListener')
  );
  assert.ok(handler, "目标格式回调缺失");
  assert.ok(handler.indexOf("state.settings = { ...state.settings, targetBySource }") < handler.indexOf("await persistSettings({ targetBySource })"),
    "targetBySource 先进内存再持久化");
  assert.doesNotMatch(handler, /await logBridge\.updateSettings/, "回调不得再裸调 IPC");
});

test("startup settings fallbacks keep the legacy language preference", () => {
  // 迁移/读取失败的内存降级若不带 language，用户语言会退回系统语言（复核表第三行）。
  const fallbacks = [...appSource.matchAll(/settingsSync\.restore\(\{\s*schemaVersion: 2,\s*targetBySource: legacy\.targetBySource,\s*\.\.\.\(legacy\.language/g)];
  assert.equal(fallbacks.length, 2, "migrate 与 getSettings 两处降级都要保留旧语言偏好");
});

test("persist failure surfaces a one-shot non-blocking warning", () => {
  assert.match(appSource, /if \(!settingsDegraded\) \{[\s\S]{0,160}setStatus\(t\("settings\.degraded"\), "warn"\);/,
    "持久化失败提示复用一次性 settingsDegraded 警告");
});
