# 飞鼠格式 Electron 安全加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The project is not a Git repository, so commit steps are intentionally replaced with diff/file verification steps.

**Goal:** 加固飞鼠格式 Electron 的导航、外链、IPC、下载和渲染边界，升级到 Electron 43.1.0，并生成经过验证的 Windows 打包产物。

**Architecture:** 新增无 Electron 依赖的 `electron-security.js` 统一完成 URL 与来源判断，主进程只在通过策略后执行高权限操作。Express 统一发送 CSP，渲染器使用 DOM API 代替动态 `innerHTML`，从而让安全规则可单元测试且不影响现有转换接口。

**Tech Stack:** Node.js test runner、Electron 43.1.0、Express 4、electron-builder/NSIS、PowerShell。

---

## 文件结构

- Create: `electron-security.js` — 纯函数 URL、origin、下载路径和外链策略。
- Create: `tests/electron-security.test.js` — 安全策略行为测试。
- Create: `tests/electron-hardening-static.test.js` — 主进程、CSP 与打包配置结构回归测试。
- Modify: `electron-main.js` — 应用安全策略、限制导航/外链、校验 IPC 与重定向。
- Modify: `server.js` — 为全部本地响应增加 CSP。
- Modify: `public/app.js` — 使用 DOM API 构建动态列表和占位选项。
- Modify: `tests/ui-static.test.js` — 禁止动态 HTML 注入面。
- Modify: `package.json`, `package-lock.json` — Electron 升级到 43.1.0。
- Modify: `README.md` — 补充分发签名与安全构建说明。

### Task 1: 建立可测试的 URL 安全策略

**Files:**
- Create: `tests/electron-security.test.js`
- Create: `electron-security.js`

- [ ] **Step 1: 写安全策略失败测试**

创建 `tests/electron-security.test.js`：

```js
const assert = require("assert");
const { test } = require("node:test");
const {
  isTrustedRendererUrl,
  resolveTrustedDownloadUrl,
  isAllowedExternalUrl
} = require("../electron-security");

const serverUrl = "http://127.0.0.1:5177";

test("renderer URL must use the exact local service origin", () => {
  assert.strictEqual(isTrustedRendererUrl("http://127.0.0.1:5177/", serverUrl), true);
  assert.strictEqual(isTrustedRendererUrl("http://127.0.0.1:5177/index.html", serverUrl), true);
  assert.strictEqual(isTrustedRendererUrl("http://127.0.0.1:5178/", serverUrl), false);
  assert.strictEqual(isTrustedRendererUrl("https://example.com/", serverUrl), false);
  assert.strictEqual(isTrustedRendererUrl("not a url", serverUrl), false);
});

test("download URL must be an exact same-origin download resource", () => {
  assert.strictEqual(
    resolveTrustedDownloadUrl("/downloads/abc-123", serverUrl),
    "http://127.0.0.1:5177/downloads/abc-123"
  );
  for (const value of [
    "http://127.0.0.1:5178/downloads/abc",
    "https://example.com/downloads/abc",
    "/downloads/",
    "/downloads/abc/extra",
    "/downloads/abc?next=https://example.com",
    "http://user:pass@127.0.0.1:5177/downloads/abc"
  ]) {
    assert.strictEqual(resolveTrustedDownloadUrl(value, serverUrl), null, value);
  }
});

test("external URL only allows credential-free HTTPS", () => {
  assert.strictEqual(isAllowedExternalUrl("https://example.com/help"), true);
  for (const value of [
    "http://example.com",
    "file:///C:/Windows/System32/calc.exe",
    "mailto:test@example.com",
    "custom:payload",
    "https://user:pass@example.com",
    "not a url"
  ]) {
    assert.strictEqual(isAllowedExternalUrl(value), false, value);
  }
});
```

- [ ] **Step 2: 运行测试并确认正确红灯**

Run: `node --test tests\electron-security.test.js`

Expected: FAIL，原因是 `Cannot find module '../electron-security'`。

- [ ] **Step 3: 写最小安全策略实现**

创建 `electron-security.js`：

```js
function parseUrl(value, base) {
  try {
    return base ? new URL(String(value), base) : new URL(String(value));
  } catch {
    return null;
  }
}

function isTrustedRendererUrl(candidate, serverUrl) {
  const trusted = parseUrl(serverUrl);
  const parsed = parseUrl(candidate);
  if (!trusted || !parsed) return false;
  return trusted.protocol === "http:"
    && trusted.hostname === "127.0.0.1"
    && parsed.origin === trusted.origin
    && !parsed.username
    && !parsed.password;
}

function resolveTrustedDownloadUrl(candidate, serverUrl) {
  const parsed = parseUrl(candidate, serverUrl);
  if (!parsed || !isTrustedRendererUrl(parsed.toString(), serverUrl)) return null;
  if (!/^\/downloads\/[^/]+$/.test(parsed.pathname)) return null;
  if (parsed.search || parsed.hash) return null;
  return parsed.toString();
}

function isAllowedExternalUrl(candidate) {
  const parsed = parseUrl(candidate);
  return Boolean(parsed
    && parsed.protocol === "https:"
    && parsed.hostname
    && !parsed.username
    && !parsed.password);
}

module.exports = {
  isTrustedRendererUrl,
  resolveTrustedDownloadUrl,
  isAllowedExternalUrl
};
```

- [ ] **Step 4: 运行策略测试并确认绿灯**

Run: `node --test tests\electron-security.test.js`

Expected: 3 tests, 3 pass, 0 fail。

- [ ] **Step 5: 核对新增文件**

Run: `Get-Item electron-security.js, tests\electron-security.test.js | Select-Object FullName,Length`

Expected: 两个文件均存在且长度大于 0。

### Task 2: 加固主进程、IPC 和下载重定向

**Files:**
- Create: `tests/electron-hardening-static.test.js`
- Modify: `electron-main.js`

- [ ] **Step 1: 写主进程结构失败测试**

创建 `tests/electron-hardening-static.test.js`：

```js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

function readRoot(fileName) {
  return fs.readFileSync(path.join(__dirname, "..", fileName), "utf8");
}

test("main process enforces Electron trust boundaries", () => {
  const source = readRoot("electron-main.js");
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /will-navigate/);
  assert.match(source, /isTrustedRendererUrl/);
  assert.match(source, /resolveTrustedDownloadUrl/);
  assert.match(source, /isAllowedExternalUrl/);
  assert.match(source, /event\.senderFrame/);
  assert.doesNotMatch(source, /shell\.openExternal\(url\)/);
});
```

- [ ] **Step 2: 运行测试并确认正确红灯**

Run: `node --test tests\electron-hardening-static.test.js`

Expected: FAIL，至少提示缺少 `sandbox: true` 或 `will-navigate`。

- [ ] **Step 3: 在主进程接入安全策略**

在 `electron-main.js` 顶部引入：

```js
const {
  isTrustedRendererUrl,
  resolveTrustedDownloadUrl,
  isAllowedExternalUrl
} = require("./electron-security");
```

在 `webPreferences` 增加 `sandbox: true`。创建窗口后注册：

```js
mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
  if (isTrustedRendererUrl(navigationUrl, serverUrl)) return;
  event.preventDefault();
  log("Blocked renderer navigation");
});
```

增加 IPC 与下载辅助函数：

```js
function assertTrustedIpc(event) {
  if (!isTrustedRendererUrl(event.senderFrame?.url, serverUrl)) {
    throw new Error("拒绝来自非本地页面的保存请求。");
  }
}

function trustedDownloadUrl(value) {
  const resolved = resolveTrustedDownloadUrl(value, serverUrl);
  if (!resolved) throw new Error("下载地址无效或已被拒绝。");
  return resolved;
}
```

两个 IPC handler 改为接收 `event`，第一行调用 `assertTrustedIpc(event)`；单文件 URL 使用 `trustedDownloadUrl(payload?.downloadUrl)`。批量保存必须先通过 `files.map` 校验全部条目，再显示文件夹对话框。

`downloadToFile` 的重定向分支必须调用 `trustedDownloadUrl(new URL(response.headers.location, url).toString())`，拒绝跨源重定向。

外链处理改为：

```js
contents.setWindowOpenHandler(({ url }) => {
  if (isAllowedExternalUrl(url)) {
    setImmediate(() => shell.openExternal(url).catch((error) => log("External URL failed", error)));
  } else {
    log("Blocked external URL");
  }
  return { action: "deny" };
});
```

- [ ] **Step 4: 运行主进程安全测试与语法检查**

Run: `node --test tests\electron-security.test.js tests\electron-hardening-static.test.js; node --check electron-main.js; node --check electron-security.js`

Expected: 4 tests pass；两个语法检查退出码 0。

### Task 3: 增加 CSP 并移除动态 innerHTML

**Files:**
- Modify: `tests/electron-hardening-static.test.js`
- Modify: `tests/ui-static.test.js`
- Modify: `server.js`
- Modify: `public/app.js`

- [ ] **Step 1: 写 CSP 和渲染器失败测试**

向 `tests/electron-hardening-static.test.js` 增加：

```js
test("local service sends a restrictive content security policy", () => {
  const source = readRoot("server.js");
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /default-src 'self'/);
  assert.match(source, /object-src 'none'/);
  assert.match(source, /frame-ancestors 'none'/);
});
```

向 `tests/ui-static.test.js` 增加：

```js
test("renderer does not inject dynamic HTML", () => {
  const app = readPublic("app.js");
  assert.doesNotMatch(app, /\.innerHTML\s*=/, "renderer must build dynamic content with DOM APIs");
  assert.match(app, /\.textContent\s*=/, "renderer should render untrusted text with textContent");
});
```

- [ ] **Step 2: 运行新增测试并确认红灯**

Run: `node --test tests\electron-hardening-static.test.js tests\ui-static.test.js`

Expected: FAIL，分别报告缺少 CSP 和仍存在 `innerHTML`。

- [ ] **Step 3: 为 Express 增加 CSP**

在 `server.js` 的静态资源中间件之前加入：

```js
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ");

app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  next();
});
```

- [ ] **Step 4: 将渲染器动态内容改为 DOM API**

在 `public/app.js` 增加并统一使用：

```js
function clearElement(element) {
  element.replaceChildren();
}

function setSelectPlaceholder(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.replaceChildren(option);
}
```

`renderFormatTable` 和 `renderBatchList` 使用 `document.createElement`、`className`、`dataset.saveIndex`、`textContent` 和 `append` 构建完整节点；不得把文件名、错误详情、能力信息或按钮字符串拼入 HTML。所有原有 `innerHTML = ...` 改为 `replaceChildren`、`setSelectPlaceholder` 或逐节点追加。

- [ ] **Step 5: 运行 CSP、渲染器和完整测试**

Run: `node --test tests\electron-hardening-static.test.js tests\ui-static.test.js; npm test`

Expected: 新增测试通过；完整套件 0 fail。

### Task 4: 升级 Electron 并补充分发说明

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/electron-hardening-static.test.js`
- Modify: `README.md`

- [ ] **Step 1: 增加版本配置失败测试**

向 `tests/electron-hardening-static.test.js` 增加：

```js
test("package uses Electron 43 and keeps unsigned local packaging explicit", () => {
  const packageJson = JSON.parse(readRoot("package.json"));
  assert.match(packageJson.devDependencies.electron, /^\^?43\./);
  assert.strictEqual(packageJson.build.win.signAndEditExecutable, false);
});
```

- [ ] **Step 2: 运行版本测试并确认红灯**

Run: `node --test tests\electron-hardening-static.test.js`

Expected: FAIL，当前 Electron 版本为 33.x。

- [ ] **Step 3: 升级并锁定 Electron 43.1.0**

Run: `npm install --save-dev electron@43.1.0`

Expected: `package.json` 和 `package-lock.json` 更新；安装命令退出码 0。

- [ ] **Step 4: 在 README 增加签名边界**

在打包章节后增加“代码签名”说明：本地构建保持 `signAndEditExecutable: false`；正式分发时通过安全 CI 或临时环境变量提供证书，禁止把 `.pfx`、证书密码、令牌写入仓库或文档；未配置证书的产物必须标记为未签名测试构建。

- [ ] **Step 5: 验证版本、依赖与测试**

Run: `npm ls electron --depth=0; node --test tests\electron-hardening-static.test.js; npm test`

Expected: Electron 43.1.0；全部测试 0 fail。

### Task 5: 完整验证与重新打包

**Files:**
- Generated: `dist\win-unpacked\飞鼠格式.exe`
- Generated: `dist\飞鼠格式安装包-0.1.0-x64.exe`

- [ ] **Step 1: 运行全部语法检查**

Run:

```powershell
node --check server.js
node --check public\app.js
node --check electron-main.js
node --check electron-security.js
node --check preload.js
```

Expected: 所有命令退出码 0，无语法错误。

- [ ] **Step 2: 运行完整测试套件**

Run: `npm test`

Expected: 全部测试通过，0 fail；记录任何仍存在的第三方可选依赖警告。

- [ ] **Step 3: 执行正式打包**

Run:

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:npm_config_registry='https://registry.npmmirror.com'
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run dist
```

Expected: 命令退出码 0，并生成 NSIS 安装包和 `win-unpacked` EXE。

- [ ] **Step 4: 静态核验新产物**

Run:

```powershell
$exe='D:\34615\飞鼠格式\dist\win-unpacked\飞鼠格式.exe'
$installer='D:\34615\飞鼠格式\dist\飞鼠格式安装包-0.1.0-x64.exe'
Get-Item $exe,$installer | Select-Object FullName,Length,LastWriteTime
Get-FileHash $exe,$installer -Algorithm SHA256
Get-AuthenticodeSignature $exe,$installer | Select-Object Path,Status
(Get-Item $exe).VersionInfo | Select-Object ProductName,ProductVersion,FileDescription
```

Expected: 两个文件存在且非空；记录新哈希；签名状态为 `NotSigned`；产品名仍为飞鼠格式或 Electron 打包元数据的预期值。

- [ ] **Step 5: 核对快捷方式但不修改**

Run:

```powershell
$shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut('C:\Users\34615\Desktop\飞鼠格式.lnk')
[pscustomobject]@{
  TargetPath=$shortcut.TargetPath
  TargetExists=Test-Path -LiteralPath $shortcut.TargetPath
  WorkingDirectory=$shortcut.WorkingDirectory
  IconLocation=$shortcut.IconLocation
}
```

Expected: 只报告当前目标及存在状态，不重写 `.lnk`。

- [ ] **Step 6: 最终需求逐项核对**

确认以下项目均有当前运行证据：安全策略测试红绿过程、导航/外链/IPC/下载限制、CSP、无动态 `innerHTML`、Electron 43.1.0、完整测试、语法检查、NSIS 打包、产物哈希、未签名边界和快捷方式未被修改。
