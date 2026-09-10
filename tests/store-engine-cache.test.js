const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// P3（2026-09-10 复核）：`.complete` 只证明「复制代码走完」，不证明「引擎能转换
// 文件」。接受缓存必须有清单完整性校验 + 真实最小转换冒烟；发布走 staging→rename，
// 来源包残缺时绝不写发布目录、绝不清掉本来可用的旧缓存。

const {
  prepareWritableEngineBundle,
  readManifest,
  verifyIntegrity
} = require("../store-engine-cache");

const LO_SUB = path.join("LibreOfficePortable", "App", "libreoffice", "program");

async function makeBundle(t, name, { withSoffice = true, extras = {}, manifest = null } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `fm-eng-${name}-`));
  t.after(() => fsp.rm(root, { recursive: true, force: true }).catch(() => {}));
  const bundle = path.join(root, "bundle");
  if (withSoffice) {
    fs.mkdirSync(path.join(bundle, LO_SUB), { recursive: true });
    fs.writeFileSync(path.join(bundle, LO_SUB, "soffice.com"), "fake-entry");
  }
  for (const [rel, content] of Object.entries(extras)) {
    const target = path.join(bundle, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  if (manifest) {
    fs.writeFileSync(path.join(bundle, "engine-integrity.json"), JSON.stringify(manifest, null, 2));
  }
  return { root, bundle };
}

function manifestFor(relFiles) {
  const files = {};
  for (const rel of relFiles) {
    files[rel] = { size: 10, sha256: "x" }; // sha256 值由调用方场景决定成败
  }
  return { schema: 1, files };
}

function passSmoke() {
  return { ok: true };
}

test("incomplete source bundle (entry present, key file missing) is NEVER published", async (t) => {
  // 评审原话场景：来源包本身不完整、但还包含 soffice.com。
  const { root, bundle } = await makeBundle(t, "src-bad", {
    extras: {},
    manifest: { schema: 1, files: { [`${LO_SUB}/mergedlo.dll`.split(path.sep).join("/")]: { size: 5 } } }
  });
  const enginesRoot = path.join(root, "engines");
  const result = prepareWritableEngineBundle({
    bundledBundle: bundle,
    bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"),
    enginesRoot,
    bundleName: "libreoffice-9.9.9",
    smokeTest: passSmoke
  });
  assert.equal(result.source, "bundled", "缺关键 DLL 的来源包不得被发布为缓存");
  assert.ok(/mergedlo/.test(result.reason));
  assert.ok(!fs.existsSync(path.join(enginesRoot, "libreoffice-9.9.9")), "最终缓存目录不得存在");
  assert.ok(!fs.existsSync(`${path.join(enginesRoot, "libreoffice-9.9.9")}.staging`), "staging 必须被清理");
});

test("staging + integrity + smoke all pass, then publish; old caches reclaimed only after", async (t) => {
  const rel = (p) => p.split(path.sep).join("/");
  const entryRel = rel(`${LO_SUB}/soffice.com`);
  const { root, bundle } = await makeBundle(t, "src-ok");
  // 写一份与 bundle 实际内容一致的清单（size+sha 都从真实文件算）。
  const crypto = require("node:crypto");
  const entryBytes = fs.readFileSync(path.join(bundle, LO_SUB, "soffice.com"));
  const manifest = {
    schema: 1,
    files: { [entryRel]: { size: entryBytes.length, sha256: crypto.createHash("sha256").update(entryBytes).digest("hex") } }
  };
  fs.writeFileSync(path.join(bundle, "engine-integrity.json"), JSON.stringify(manifest));

  const enginesRoot = path.join(root, "engines");
  const oldCache = path.join(enginesRoot, "libreoffice-0.6.9");
  fs.mkdirSync(oldCache, { recursive: true });
  fs.writeFileSync(path.join(oldCache, "marker"), "old");

  let smokeCalls = [];
  const result = prepareWritableEngineBundle({
    bundledBundle: bundle,
    bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"),
    enginesRoot,
    bundleName: "libreoffice-9.9.9",
    tmpRoot: root,
    smokeTest: (sofficePath) => { smokeCalls.push(sofficePath); return { ok: true }; }
  });
  assert.equal(result.source, "published");
  assert.equal(smokeCalls.length, 1, "冒烟必须执行一次");
  assert.ok(smokeCalls[0].includes(".staging"), "冒烟必须在 staging 目录跑（发布前）");
  assert.ok(fs.existsSync(path.join(enginesRoot, "libreoffice-9.9.9", ".complete")));
  assert.ok(!fs.existsSync(oldCache), "发布成功后旧版本缓存被回收");
});

test("failed smoke leaves no published cache and does NOT touch old caches", async (t) => {
  const { root, bundle } = await makeBundle(t, "src-smokefail");
  const enginesRoot = path.join(root, "engines");
  const oldCache = path.join(enginesRoot, "libreoffice-0.6.9");
  fs.mkdirSync(oldCache, { recursive: true });
  fs.writeFileSync(path.join(oldCache, "marker"), "old");

  const result = prepareWritableEngineBundle({
    bundledBundle: bundle,
    bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"),
    enginesRoot,
    bundleName: "libreoffice-9.9.9",
    tmpRoot: root,
    smokeTest: () => ({ ok: false, reason: "engine refuses to run" })
  });
  assert.equal(result.source, "bundled");
  assert.match(result.reason, /冒烟/);
  assert.ok(!fs.existsSync(path.join(enginesRoot, "libreoffice-9.9.9")), "冒烟失败不得发布缓存");
  assert.ok(fs.existsSync(path.join(oldCache, "marker")), "旧缓存必须原样保留（0.6.9 会清掉它）");
});

test("published cache with .complete but missing key file is rejected and rebuilt", async (t) => {
  const rel = (p) => p.split(path.sep).join("/");
  const entryRel = rel(`${LO_SUB}/soffice.com`);
  const missingRel = rel(`${LO_SUB}/mergedlo.dll`);
  const { root, bundle } = await makeBundle(t, "src-rebuild");
  fs.writeFileSync(path.join(bundle, "engine-integrity.json"), JSON.stringify({
    schema: 1, files: { [entryRel]: { size: 10 }, [missingRel]: { size: 5 } }
  }));
  // 手工造一个「0.6.9 式半套缓存」：入口 + .complete 都在，mergedlo.dll 缺。
  const enginesRoot = path.join(root, "engines");
  const cacheDir = path.join(enginesRoot, "libreoffice-9.9.9");
  fs.mkdirSync(path.join(cacheDir, LO_SUB), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, LO_SUB, "soffice.com"), "fake-entry");
  fs.writeFileSync(path.join(cacheDir, ".complete"), "done");

  const result = prepareWritableEngineBundle({
    bundledBundle: bundle,
    bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"),
    enginesRoot,
    bundleName: "libreoffice-9.9.9",
    tmpRoot: root,
    smokeTest: () => ({ ok: true })
  });
  // 来源包同样缺 mergedlo → 拒绝使用半套缓存且无法重建 → 回退 bundled。
  assert.equal(result.source, "bundled");
  assert.match(result.reason, /完整性校验失败/);
});

test("bundle without manifest falls back to entry-exists but smoke still runs", async (t) => {
  const { root, bundle } = await makeBundle(t, "src-nomanifest");
  const enginesRoot = path.join(root, "engines");
  let ran = false;
  const result = prepareWritableEngineBundle({
    bundledBundle: bundle,
    bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"),
    enginesRoot,
    bundleName: "libreoffice-9.9.9",
    tmpRoot: root,
    smokeTest: () => { ran = true; return { ok: true }; }
  });
  assert.equal(result.source, "published");
  assert.ok(ran, "无清单（旧包/dev 树）时冒烟仍必须执行");
});

test("real engine smoke: minimal CSV converts to a valid PDF (opt-in, slow)", async (t) => {
  const { defaultSmokeTest } = require("../store-engine-cache");
  const real = [
    "D:/项目/飞鼠格式-src/bin/libreoffice/LibreOfficePortable/App/libreoffice/program/soffice.com",
    "D:/软件/飞鼠格式/FlyingMouse Format/resources/libreoffice/LibreOfficePortable/App/libreoffice/program/soffice.com"
  ].map((p) => p.split("/").join(path.sep)).find((p) => fs.existsSync(p));
  if (!real) return t.skip("本机无完整引擎包，跳过真实冒烟");
  const outcome = defaultSmokeTest(real, {});
  assert.ok(outcome.ok, `真实引擎冒烟失败: ${outcome.reason}`);
});

test("readManifest tolerates missing/corrupt manifest files", async (t) => {
  const { root, bundle } = await makeBundle(t, "src-badmanifest");
  assert.equal(readManifest(bundle), null);
  fs.writeFileSync(path.join(bundle, "engine-integrity.json"), "{ not json");
  assert.equal(readManifest(bundle), null);
  assert.equal(verifyIntegrity(bundle, null).ok, false);
});

for (const [label, content] of [["missing", null], ["corrupt", "{bad"], ["empty", '{"schema":1,"files":{}}']]) {
  test(`existing cache with ${label} manifest must run smoke before reuse`, async (t) => {
    const { root, bundle } = await makeBundle(t, `existing-${label}`);
    if (content !== null) fs.writeFileSync(path.join(bundle, "engine-integrity.json"), content);
    const enginesRoot = path.join(root, "engines");
    const cacheDir = path.join(enginesRoot, "libreoffice-test");
    fs.cpSync(bundle, cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, ".complete"), "old marker");
    let calls = 0;
    const result = prepareWritableEngineBundle({
      bundledBundle: bundle, bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"),
      enginesRoot, bundleName: "libreoffice-test",
      smokeTest: () => { calls += 1; return { ok: false, reason: "invalid output" }; }
    });
    assert.equal(calls, 2, "both existing cache and staged replacement need a real smoke result");
    assert.equal(result.source, "bundled");
    assert.match(result.reason, /冒烟/);
  });
}

test("manifest rejects traversal and invalid metadata", async (t) => {
  const { bundle } = await makeBundle(t, "invalid-entry");
  for (const files of [{ "../outside": { size: 1 } }, { "a": {} }, { "a": { size: -1 } }, { "a": { size: 1, sha256: "bad" } }]) {
    assert.equal(verifyIntegrity(bundle, { schema: 1, files }).ok, false);
  }
});

test("smoke rejects a magic-only PDF and a valid blank PDF, accepts expected text", async (t) => {
  const { defaultSmokeTest } = require("../store-engine-cache");
  const { PDFDocument, StandardFonts } = require("pdf-lib");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-smoke-pdf-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const blank = await PDFDocument.create();
  blank.addPage();
  const expected = await PDFDocument.create();
  const page = expected.addPage();
  page.drawText("flyingmouse 42", { font: await expected.embedFont(StandardFonts.Helvetica) });
  for (const [bytes, success] of [[Buffer.from("%PDF"), false], [await blank.save(), false], [await expected.save(), true]]) {
    const outcome = defaultSmokeTest("fake-soffice", { tmpRoot: root, exec: (_exe, args) => {
      fs.writeFileSync(path.join(args[args.indexOf("--outdir") + 1], "smoke.pdf"), bytes);
    } });
    assert.equal(outcome.ok, success, outcome.reason);
  }
});
