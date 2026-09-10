const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// P1 回归（2026-09-10 复核）：保存失败绝不允许删除用户选择的最终目标路径。
// 旧实现 `fail()` 里 rm(destination)，HTTP 404（写流都还没创建）也走这条 →
// 目标位置已有旧文件 + 保存请求失败 ⇒ 旧文件被删。现在下载只写随机 .partial，
// 完整校验后 rename 发布；失败只清本次临时文件。
const { downloadToFile } = require("../save-download");

async function scratchDir(t, name) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `fm-${name}-`));
  t.after(() => fsp.rm(root, { recursive: true, force: true }).catch(() => {}));
  return root;
}

// 可控的本地"下载服务"：按路由返回状态码/内容，模拟 404、断链、不完整。
function startServer(t, routes) {
  const server = http.createServer((req, res) => {
    const handler = routes(req.url);
    if (!handler) {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    handler(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

test("404 must not delete a pre-existing file at the destination", async (t) => {
  const dir = await scratchDir(t, "p1-404");
  const destination = path.join(dir, "report.docx");
  const original = "OLD USER DATA - MUST SURVIVE";
  await fsp.writeFile(destination, original);
  const baseUrl = await startServer(t, () => null); // every route 404s

  await assert.rejects(() => downloadToFile(`${baseUrl}/gone`, destination));

  assert.ok(fs.existsSync(destination), "404 保存失败时不得删除已有文件");
  assert.equal(await fsp.readFile(destination, "utf8"), original, "已有文件内容必须逐字节保留");
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith(".partial"));
  assert.deepEqual(leftovers, [], "失败不得留下 .partial 残留");
});

test("any other HTTP error code must not delete an existing destination", async (t) => {
  const dir = await scratchDir(t, "p1-500");
  const destination = path.join(dir, "out.pdf");
  await fsp.writeFile(destination, "keep me");
  const baseUrl = await startServer(t, (url) => (url === "/boom"
    ? (res) => { res.statusCode = 500; res.end("boom"); }
    : null));

  await assert.rejects(() => downloadToFile(`${baseUrl}/boom`, destination));
  assert.equal(await fsp.readFile(destination, "utf8"), "keep me");
});

test("successful save replaces the old file with complete new content", async (t) => {
  const dir = await scratchDir(t, "p1-ok");
  const destination = path.join(dir, "notes.md");
  await fsp.writeFile(destination, "stale");
  const payload = "# fresh output\n".repeat(50);
  const baseUrl = await startServer(t, (url) => (url === "/good"
    ? (res) => {
        res.setHeader("content-length", Buffer.byteLength(payload));
        res.end(payload);
      }
    : null));

  await downloadToFile(`${baseUrl}/good`, destination);
  assert.equal(await fsp.readFile(destination, "utf8"), payload);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".partial")), []);
});

test("truncated response (byte count mismatch) keeps the old file", async (t) => {
  const dir = await scratchDir(t, "p1-short");
  const destination = path.join(dir, "book.epub");
  await fsp.writeFile(destination, "original book");
  // content-length 声明 1000 字节，实际只发 10 → 校验必须失败。
  const baseUrl = await startServer(t, (url) => (url === "/short"
    ? (res) => {
        res.setHeader("content-length", "1000");
        res.end("0123456789");
        res.destroy();
      }
    : null));

  await assert.rejects(() => downloadToFile(`${baseUrl}/short`, destination), /不完整|中断/);
  assert.equal(await fsp.readFile(destination, "utf8"), "original book", "半截响应不得覆盖用户文件");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".partial")), [], "断链后不得留 .partial");
});

test("connection refused keeps destination untouched", async (t) => {
  const dir = await scratchDir(t, "p1-refused");
  const destination = path.join(dir, "song.flac");
  await fsp.writeFile(destination, "precious");
  // 端口 1 基本不可能有监听 → request error 路径。
  await assert.rejects(() => downloadToFile("http://127.0.0.1:1/x", destination));
  assert.equal(await fsp.readFile(destination, "utf8"), "precious");
});

test("rejected redirect keeps destination and cleans nothing of the user's", async (t) => {
  const dir = await scratchDir(t, "p1-redirect");
  const destination = path.join(dir, "target.txt");
  await fsp.writeFile(destination, "mine");
  const baseUrl = await startServer(t, (url) => (url === "/jump"
    ? (res) => { res.statusCode = 302; res.setHeader("location", "http://evil.example/x"); res.end(); }
    : null));

  await assert.rejects(
    () => downloadToFile(`${baseUrl}/jump`, destination, {
      resolveRedirect: () => { throw new Error("untrusted redirect"); }
    })
  );
  assert.equal(await fsp.readFile(destination, "utf8"), "mine");
});

test("electron-main must not rm the user destination on save failure", () => {
  // 静态守卫：主进程里任何 rm/unlink 都不允许指向最终目标路径；
  // 下载落盘（含 .partial 清理）只存在于 save-download.js。
  const source = fs.readFileSync(path.join(__dirname, "..", "electron-main.js"), "utf8");
  assert.doesNotMatch(source, /\.(rm|rmSync|unlink)\s*\(\s*(destination|result\.filePath|mdDestination)\b/,
    "保存链路不得删除最终目标文件");
  assert.match(source, /require\("\.\/save-download"\)/,
    "electron-main 必须经由 save-download 模块落盘");
});
