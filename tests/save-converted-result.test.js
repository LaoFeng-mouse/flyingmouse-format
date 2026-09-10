const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { saveConvertedResult } = require("../save-converted-result");

async function fixture(t, markdown = "![figure](原报告.assets/image-1.png)\n", missing = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-save-result-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    if (req.url === "/main") res.end(markdown);
    else if (req.url === "/asset" && !missing) res.end("PNG IMAGE");
    else { res.statusCode = 404; res.end("missing"); }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = { fileName: "原报告.md", downloadUrl: `${base}/main`, assets: [{ name: "image-1.png", url: `${base}/asset` }] };
  return { root, result };
}

test("renaming Markdown saves every resource and rewrites references to its owned directory", async (t) => {
  const { root, result } = await fixture(t);
  const target = path.join(root, "另存名.md");
  const saved = await saveConvertedResult(result, target);
  const markdown = await fs.readFile(target, "utf8");
  const reference = markdown.match(/\]\(([^)]+)\)/)[1];
  assert.equal(await fs.readFile(path.join(root, reference), "utf8"), "PNG IMAGE");
  assert.equal(path.dirname(path.join(root, reference)), saved.assetsDirectory);
  assert.doesNotMatch(markdown, /原报告.assets/);
});

test("failed asset download preserves old document and sidecar and rejects save", async (t) => {
  const { root, result } = await fixture(t, undefined, true);
  const target = path.join(root, "existing.md");
  await fs.mkdir(path.join(root, "existing.assets"));
  await fs.writeFile(path.join(root, "existing.assets", "old.png"), "old image");
  await fs.writeFile(target, "old document");
  await assert.rejects(saveConvertedResult(result, target), /保存失败/);
  assert.equal(await fs.readFile(target, "utf8"), "old document");
  assert.equal(await fs.readFile(path.join(root, "existing.assets", "old.png"), "utf8"), "old image");
  assert.deepEqual((await fs.readdir(root)).sort(), ["existing.assets", "existing.md"]);
});

test("unlisted resource reference rejects an incomplete result", async (t) => {
  const { root, result } = await fixture(t, "![figure](原报告.assets/missing.png)");
  await assert.rejects(saveConvertedResult(result, path.join(root, "saved.md")), /附件不完整/);
  assert.deepEqual(await fs.readdir(root), []);
});

test("an asset filename prefix cannot satisfy a different missing asset", async (t) => {
  const { root, result } = await fixture(t, "![figure](原报告.assets/image-1.png.other)");
  await assert.rejects(saveConvertedResult(result, path.join(root, "saved.md")), /附件不完整/);
  assert.deepEqual(await fs.readdir(root), []);
});

test("asset URLs are validated before downloading and path traversal is rejected", async (t) => {
  const { root, result } = await fixture(t);
  const destination = path.join(root, "saved.md");
  await assert.rejects(saveConvertedResult(result, destination, { resolveUrl: (url) => {
    if (url.endsWith("/asset")) throw new Error("untrusted");
    return url;
  } }), /untrusted/);
  result.assets[0].name = "../outside.png";
  await assert.rejects(saveConvertedResult(result, destination), /附件名称无效/);
  assert.deepEqual(await fs.readdir(root), []);
});

test("empty asset manifest cannot silently publish Markdown with missing generated resources", async (t) => {
  const { root, result } = await fixture(t);
  result.assets = [];
  await assert.rejects(saveConvertedResult(result, path.join(root, "saved.md")), /附件不完整/);
  assert.deepEqual(await fs.readdir(root), []);
});

test("overwrite false preserves existing Markdown and cleans only newly created assets", async (t) => {
  const { root, result } = await fixture(t);
  const target = path.join(root, "saved.md");
  await fs.writeFile(target, "original document");
  await assert.rejects(saveConvertedResult(result, target, { overwrite: false }), /EEXIST/);
  assert.equal(await fs.readFile(target, "utf8"), "original document");
  assert.deepEqual(await fs.readdir(root), ["saved.md"]);
});
