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
  // md 图片外置：/downloads/<id>/asset/<name> 允许（server 端仍校验 name 防穿越）
  assert.strictEqual(
    resolveTrustedDownloadUrl("/downloads/abc-123/asset/image-1.png", serverUrl),
    "http://127.0.0.1:5177/downloads/abc-123/asset/image-1.png"
  );
  for (const value of [
    "http://127.0.0.1:5178/downloads/abc",
    "https://example.com/downloads/abc",
    "/downloads/",
    "/downloads/abc/extra",
    "/downloads/abc/asset/",
    "/downloads/abc/asset/a/b",
    "/downloads/abc?next=https://example.com",
    "http://user:pass@127.0.0.1:5177/downloads/abc"
  ]) {
    assert.strictEqual(resolveTrustedDownloadUrl(value, serverUrl), null, value);
  }
  // ../ 段会被 URL 归一化：asset/../../secret → /downloads/secret（普通下载形状，
  // server 仍按 id 查表返回已注册文件，无越权），允许并保持原样。
  assert.strictEqual(
    resolveTrustedDownloadUrl("/downloads/abc/asset/../../secret", serverUrl),
    "http://127.0.0.1:5177/downloads/secret"
  );
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
