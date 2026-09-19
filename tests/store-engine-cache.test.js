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
  prepareWritableEngineBundleAsync,
  resolveWritableEngineBundle,
  resolveOfficeEnginesRoot,
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

test("staging + integrity + smoke all pass, then publish without deleting another app generation", async (t) => {
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
  assert.equal(fs.readFileSync(path.join(oldCache, "marker"), "utf8"), "old",
    "a different running application may still need this generation's unloaded engine files");
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

test("real configured engine smoke: minimal CSV converts to a valid PDF", async (t) => {
  const { defaultSmokeTest } = require("../store-engine-cache");
  const { LIBREOFFICE_PATH: real } = require("../config");
  if (!real || !fs.existsSync(real)) return t.skip("当前配置未提供 LibreOffice 引擎，跳过真实冒烟");
  const outcome = defaultSmokeTest(real, {});
  assert.ok(outcome.ok, `真实引擎冒烟失败: ${outcome.reason}`);
});

test("Store smoke succeeds with a deep TEMP path by keeping native profile and input short", async (t) => {
  const { defaultSmokeTest } = require("../store-engine-cache");
  const { LIBREOFFICE_PATH: real } = require("../config");
  if (!real || !fs.existsSync(real)) return t.skip("当前配置未提供 LibreOffice 引擎");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-deep-smoke-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const tmpRoot = path.join(root, "nested-".repeat(27));
  const fallback = path.join(root, "local");
  fs.mkdirSync(tmpRoot);
  const outcome = defaultSmokeTest(real, { tmpRoot, profileFallbackRoot: fallback });
  assert.equal(outcome.ok, true, outcome.reason);
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
  // Windows rejects the long native profile path; POSIX may use tmpRoot and
  // never create the fallback. Any fallback that was used must be cleaned.
  if (process.platform === "win32") assert.ok(fs.existsSync(fallback));
  if (fs.existsSync(fallback)) assert.deepEqual(fs.readdirSync(fallback), []);
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

test("unchanged validated cache skips real smoke across app-version-only updates", async (t) => {
  const { root, bundle } = await makeBundle(t, "receipt");
  const manifest = { schema: 1, generatedAt: "old", files: {
    [`${LO_SUB}/soffice.com`.split(path.sep).join("/")]: { size: 10 }
  } };
  const manifestPath = path.join(bundle, "engine-integrity.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  let calls = 0;
  const options = { bundledBundle: bundle, bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"),
    enginesRoot: path.join(root, "engines"), smokeTest: () => { calls += 1; return { ok: true }; } };
  const first = prepareWritableEngineBundle(options);
  assert.equal(first.source, "published");
  manifest.generatedAt = "new";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const next = prepareWritableEngineBundle(options);
  assert.equal(next.source, "cache");
  assert.equal(first.path, next.path);
  assert.equal(calls, 1, "unchanged receipt must avoid the expensive native conversion");
});

test("changes to an unlisted dependency invalidate the receipt and rebuild the cache", async (t) => {
  const { root, bundle } = await makeBundle(t, "receipt-change", { extras: { "writer-filter.dat": "original" } });
  fs.writeFileSync(path.join(bundle, "engine-integrity.json"), JSON.stringify({ schema: 1, files: {
    [`${LO_SUB}/soffice.com`.split(path.sep).join("/")]: { size: 10 }
  } }));
  let calls = 0;
  const options = { bundledBundle: bundle, bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"),
    enginesRoot: path.join(root, "engines"), smokeTest: () => { calls += 1; return { ok: true }; } };
  prepareWritableEngineBundle(options);
  const { destBundle } = resolveWritableEngineBundle(options);
  fs.rmSync(path.join(destBundle, "writer-filter.dat"));
  const rebuilt = prepareWritableEngineBundle(options);
  assert.equal(rebuilt.source, "published");
  assert.equal(fs.readFileSync(path.join(destBundle, "writer-filter.dat"), "utf8"), "original");
  assert.equal(calls, 2);
});

test("content key changes for a same-size critical binary update", async (t) => {
  const { root, bundle } = await makeBundle(t, "content-key");
  const manifestPath = path.join(bundle, "engine-integrity.json");
  const manifest = { schema: 1, files: { "program.dll": { size: 10, sha256: "a".repeat(64) } } };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const options = { bundledBundle: bundle, enginesRoot: path.join(root, "engines") };
  const first = resolveWritableEngineBundle(options);
  manifest.files["program.dll"].sha256 = "b".repeat(64);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.notEqual(first.path, resolveWritableEngineBundle(options).path);
  assert.throws(() => resolveWritableEngineBundle({ ...options, bundleName: "../outside" }), /Invalid/);
});

test("default Store cache leaves native path margin after redirection and a long user folder", async t => {
  const { bundle }=await makeBundle(t,"short-store-path");
  fs.writeFileSync(path.join(bundle,"engine-integrity.json"),JSON.stringify({schema:1,files:{
    [`${LO_SUB}/soffice.com`.split(path.sep).join("/")]:{size:10}
  }}));
  for(const user of ['34615','abcdefghijklmnopqrstuvwxyzABCDEF']){
    const local=path.win32.join('C:\\Users',user,'AppData','Local');
    const root=resolveOfficeEnginesRoot(local);
    const destination=resolveWritableEngineBundle({bundledBundle:bundle,enginesRoot:root});
    assert.match(destination.bundleName,/^lo-[a-f0-9]{32}$/);
    assert.match(destination.key,/^[a-f0-9]{64}$/,'directory abbreviation must not abbreviate content identity');
    const redirected=path.win32.join(local,'Packages','488B6338.354574AC174AD_7248mmq7yzyj2','LocalCache','Local');
    const relative=path.win32.relative(local,destination.destBundle);
    const physical=path.win32.join(redirected,`${relative}.staging`,
      'LibreOfficePortable','App','libreoffice','share','registry','lingucomponent.xcd');
    assert.ok(physical.length<=240,`native configuration path needs margin: ${physical.length} ${physical}`);
  }
});

test("short directory names retain full receipt keys and never remove a legacy cache", async t => {
  const {root,bundle}=await makeBundle(t,"short-key-integrity");
  fs.writeFileSync(path.join(bundle,"engine-integrity.json"),JSON.stringify({schema:1,files:{
    [`${LO_SUB}/soffice.com`.split(path.sep).join("/")]:{size:10}
  }}));
  let calls=0;
  const options={bundledBundle:bundle,bundledSofficePath:path.join(bundle,LO_SUB,'soffice.com'),
    enginesRoot:resolveOfficeEnginesRoot(root),smokeTest:()=>{calls++;return {ok:true};}};
  const destination=resolveWritableEngineBundle(options);
  assert.match(destination.bundleName,/^lo-[a-f0-9]{32}$/);
  const legacy=path.join(root,'FlyingMouseFormat','engines',`libreoffice-${destination.key}`);
  fs.mkdirSync(legacy,{recursive:true});fs.writeFileSync(path.join(legacy,'existing-engine'),'PRESERVE OLD GENERATION');
  assert.equal(prepareWritableEngineBundle(options).source,'published');
  const receiptPath=path.join(destination.destBundle,require('../store-engine-cache').RECEIPT_FILE);
  const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
  assert.equal(receipt.key,destination.key);assert.equal(receipt.key.length,64);
  assert.equal(prepareWritableEngineBundle(options).source,'cache');assert.equal(calls,1);
  receipt.key=receipt.key.slice(0,63)+(receipt.key.endsWith('0')?'1':'0');
  fs.writeFileSync(receiptPath,JSON.stringify(receipt));
  assert.equal(prepareWritableEngineBundle(options).source,'published','a mismatch outside the shortened directory key must force full validation');
  assert.equal(calls,2);assert.equal(JSON.parse(fs.readFileSync(receiptPath,'utf8')).key,destination.key);
  assert.equal(fs.readFileSync(path.join(legacy,'existing-engine'),'utf8'),'PRESERVE OLD GENERATION');
});

test("worker preparation leaves the main event loop responsive and reports failed validation", async (t) => {
  const { root, bundle } = await makeBundle(t, "worker-incomplete", { withSoffice: false, extras: { "placeholder": "test" } });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  t.after(() => clearInterval(timer));
  const outcome = await prepareWritableEngineBundleAsync({ bundledBundle: bundle,
    bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"), enginesRoot: path.join(root, "engines"), tmpRoot: root });
  assert.equal(outcome.source, "bundled");
  assert.match(outcome.reason, /soffice.com missing/);
  assert.ok(ticks > 0, "main-thread timers must run while the worker prepares the engine");
});

test("normal Python bytecode regeneration preserves warm cache while source changes still rebuild", async (t) => {
  const { root, bundle } = await makeBundle(t, "python-cache", { extras: {
    "program/uno.py": "python source",
    "program/__pycache__/uno.cpython-312.pyc": "staging bytecode",
    "program/__pycache__/source_less.cpython-312.pyc": "required bytecode"
  } });
  fs.writeFileSync(path.join(bundle, "engine-integrity.json"), JSON.stringify({ schema: 1, files: {
    [`${LO_SUB}/soffice.com`.split(path.sep).join("/")]: { size: 10 }
  } }));
  let calls = 0;
  const options = { bundledBundle: bundle, bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"),
    enginesRoot: path.join(root, "engines"), smokeTest: () => { calls++; return { ok: true }; } };
  prepareWritableEngineBundle(options);
  const { destBundle } = resolveWritableEngineBundle(options);
  fs.writeFileSync(path.join(destBundle, "program/__pycache__/uno.cpython-312.pyc"), "compiled for final cache path");
  assert.equal(prepareWritableEngineBundle(options).source, "cache");
  assert.equal(calls, 1);
  fs.rmSync(path.join(destBundle, "program/__pycache__/source_less.cpython-312.pyc"));
  assert.equal(prepareWritableEngineBundle(options).source, "published");
  fs.writeFileSync(path.join(destBundle, "program/uno.py"), "changed source");
  assert.equal(prepareWritableEngineBundle(options).source, "published");
  assert.equal(calls, 3);
});

async function replacementFixture(t) {
  const { root, bundle } = await makeBundle(t, "publication-rollback");
  const entryRel = `${LO_SUB}/soffice.com`.split(path.sep).join("/");
  fs.writeFileSync(path.join(bundle, "engine-integrity.json"), JSON.stringify({ schema: 1, files: {
    [entryRel]: { size: 10, sha256: require("node:crypto").createHash("sha256").update("fake-entry").digest("hex") }
  } }));
  const options = { bundledBundle: bundle, bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"),
    enginesRoot: path.join(root, "engines"), bundleName: "libreoffice-replacement-test", tmpRoot: root,
    smokeTest: () => ({ ok: true }) };
  assert.equal(prepareWritableEngineBundle(options).source, "published");
  const { destBundle } = resolveWritableEngineBundle(options);
  const entry = path.join(destBundle, LO_SUB, "soffice.com");
  // Byte-identical, hash-valid engine; only metadata makes the previous receipt stale.
  fs.utimesSync(entry, new Date(0), new Date(0));
  const backups = () => fs.readdirSync(options.enginesRoot)
    .filter(name => name.startsWith(`${path.basename(destBundle)}.previous-`))
    .map(name => path.join(options.enginesRoot, name));
  return { root, options, destBundle, entry, backups };
}

function publicationError() {
  const error = new Error("injected publication access denied");
  error.code = "EACCES";
  return error;
}

test("cache publication failure restores the previous hash-valid engine", async (t) => {
  const { options, destBundle, entry, backups } = await replacementFixture(t);
  const rename = fs.renameSync;
  fs.renameSync = function(from, to, ...rest) {
    if (from === `${destBundle}.staging` && to === destBundle) throw publicationError();
    return rename.call(this, from, to, ...rest);
  };
  let result;
  try { result = prepareWritableEngineBundle(options); } finally { fs.renameSync = rename; }
  assert.equal(result.source, "bundled");
  assert.match(result.reason, /injected publication/);
  assert.equal(fs.readFileSync(entry, "utf8"), "fake-entry", "publication failure must preserve the old engine");
  assert.deepEqual(backups(), [], "successful rollback restores the original path");
  assert.equal(fs.existsSync(`${destBundle}.staging`), false);
});

test("cache publication does not move or delete an old engine when its backup rename fails", async (t) => {
  const { options, destBundle, entry, backups } = await replacementFixture(t);
  const rename = fs.renameSync;
  fs.renameSync = function(from, to, ...rest) {
    if (from === destBundle && to.startsWith(`${destBundle}.previous-`)) throw publicationError();
    return rename.call(this, from, to, ...rest);
  };
  let result;
  try { result = prepareWritableEngineBundle(options); } finally { fs.renameSync = rename; }
  assert.equal(result.source, "bundled");
  assert.equal(fs.readFileSync(entry, "utf8"), "fake-entry");
  assert.deepEqual(backups(), []);
  assert.equal(fs.existsSync(`${destBundle}.staging`), false);
});

test("cache publication and rollback failure retain the last copy for the next preparation", async (t) => {
  const { options, destBundle, entry, backups } = await replacementFixture(t);
  const rename = fs.renameSync;
  fs.renameSync = function(from, to, ...rest) {
    if (to === destBundle && (from === `${destBundle}.staging` || from.startsWith(`${destBundle}.previous-`))) {
      throw publicationError();
    }
    return rename.call(this, from, to, ...rest);
  };
  let result;
  try { result = prepareWritableEngineBundle(options); } finally { fs.renameSync = rename; }
  assert.equal(result.source, "bundled");
  assert.match(result.reason, /previous engine preserved.*rollback failed/);
  assert.equal(fs.existsSync(destBundle), false);
  assert.equal(backups().length, 1);
  assert.equal(fs.readFileSync(path.join(backups()[0], LO_SUB, "soffice.com"), "utf8"), "fake-entry");
  assert.equal(fs.existsSync(`${destBundle}.staging`), false);
  const retry = prepareWritableEngineBundle(options);
  assert.equal(retry.source, "published", "restored stale receipt still requires normal validation/rebuild");
  assert.equal(fs.readFileSync(entry, "utf8"), "fake-entry");
  assert.deepEqual(backups(), []);
});

test("cache publication recovers an interrupted rename without weakening warm-cache checks", async (t) => {
  const { options, destBundle, entry, backups } = await replacementFixture(t);
  assert.equal(prepareWritableEngineBundle(options).source, "published");
  const previous = `${destBundle}.previous-${"a".repeat(24)}`;
  fs.renameSync(destBundle, previous);
  let calls = 0;
  const recovered = prepareWritableEngineBundle({ ...options, smokeTest: () => { calls++; return { ok: true }; } });
  assert.equal(recovered.source, "cache");
  assert.equal(calls, 0, "an unchanged validation receipt remains reusable after path recovery");
  assert.equal(fs.readFileSync(entry, "utf8"), "fake-entry");
  assert.deepEqual(backups(), []);
});

test("cache publication ignores lock age while its owner lives and preserves that owner's staging", async (t) => {
  const { options, destBundle, entry } = await replacementFixture(t);
  const lockDir = path.join(options.enginesRoot, ".flyingmouse-prepare.lock");
  fs.mkdirSync(lockDir);
  const owner = { pid: process.pid, token: "b".repeat(24) };
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner));
  fs.utimesSync(lockDir, new Date(0), new Date(0));
  const staging = `${destBundle}.staging`;
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, "another-worker.txt"), "owned by a long-running preparation");
  const outcome = prepareWritableEngineBundle({ ...options, prepareLockTimeoutMs: 10 });
  assert.equal(outcome.source, "bundled");
  assert.match(outcome.reason, /busy/);
  assert.equal(fs.readFileSync(entry, "utf8"), "fake-entry");
  assert.equal(fs.readFileSync(path.join(staging, "another-worker.txt"), "utf8"), "owned by a long-running preparation");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")), owner);
});

test("cache publication recovers a dead process lock and retains its race-prevention tombstone", async (t) => {
  const { options, destBundle } = await replacementFixture(t);
  const deadPid = Number(require("node:child_process").execFileSync(process.execPath,
    ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true }));
  assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
  const lockDir = path.join(options.enginesRoot, ".flyingmouse-prepare.lock");
  fs.mkdirSync(lockDir);
  const owner = { pid: deadPid, token: "c".repeat(24) };
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner));
  const result = prepareWritableEngineBundle({ ...options, prepareLockTimeoutMs: 5000 });
  assert.equal(result.source, "published");
  assert.equal(fs.existsSync(lockDir), false);
  const abandoned = path.join(options.enginesRoot, `.flyingmouse-prepare-${owner.token}.abandoned`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(abandoned, "owner.json"), "utf8")), owner);
  assert.ok(fs.existsSync(path.join(destBundle, ".validated.json")));
});

test("cache publication excludes a second worker without deleting active staging", async (t) => {
  const { Worker } = require("node:worker_threads");
  const { root, bundle } = await makeBundle(t, "parallel-publication");
  const options = { bundledBundle: bundle, bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"),
    enginesRoot: path.join(root, "engines"), bundleName: "libreoffice-parallel", tmpRoot: root };
  const shared = new SharedArrayBuffer(4);
  const gate = new Int32Array(shared);
  const script = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { prepareWritableEngineBundle } = require(workerData.module);
    parentPort.postMessage({ type: 'starting' });
    const outcome = prepareWritableEngineBundle({ ...workerData.options, prepareLockTimeoutMs: workerData.timeout,
      smokeTest: () => {
        parentPort.postMessage({ type: 'smoke' });
        if (workerData.wait) Atomics.wait(new Int32Array(workerData.shared), 0, 0, 10000);
        return { ok: true };
      } });
    parentPort.postMessage({ type: 'result', outcome });
  `;
  const create = (wait, timeout = wait ? 5000 : 0) => new Worker(script, { eval: true, workerData: {
    module: path.join(__dirname, "..", "store-engine-cache.js"), options, shared, wait, timeout
  } });
  const first = create(true);
  t.after(() => first.terminate());
  const messages = [];
  const firstDone = new Promise((resolve, reject) => {
    first.on("message", message => { messages.push(message); if (message.type === "result") resolve(message.outcome); });
    first.on("error", reject);
  });
  firstDone.catch(() => {});
  const readyDeadline = Date.now() + 5000;
  while (!messages.some(message => message.type === "smoke")) {
    assert.ok(Date.now() < readyDeadline, "first worker must reach the controlled smoke stage promptly");
    if (messages.some(message => message.type === "result")) assert.fail("first preparation did not reach smoke");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const staging = path.join(options.enginesRoot, `${options.bundleName}.staging`);
  assert.equal(fs.readFileSync(path.join(staging, LO_SUB, "soffice.com"), "utf8"), "fake-entry");
  const second = create(false);
  t.after(() => second.terminate());
  const secondResult = await new Promise((resolve, reject) => {
    second.on("message", message => { if (message.type === "result") resolve(message.outcome); });
    second.on("error", reject);
  });
  assert.equal(secondResult.source, "bundled");
  assert.match(secondResult.reason, /busy/);
  assert.equal(fs.readFileSync(path.join(staging, LO_SUB, "soffice.com"), "utf8"), "fake-entry");
  const waiting = create(false, 5000);
  t.after(() => waiting.terminate());
  let waitingResult;
  const waitingDone = new Promise((resolve, reject) => {
    waiting.on("message", message => {
      if (message.type === "result") { waitingResult = message.outcome; resolve(message.outcome); }
    });
    waiting.on("error", reject);
  });
  waitingDone.catch(() => {});
  await new Promise((resolve, reject) => {
    waiting.on("message", message => { if (message.type === "starting") resolve(); });
    waiting.on("error", reject);
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(waitingResult, undefined, "a waiting worker must not enter while the first worker owns preparation");
  assert.equal(fs.readFileSync(path.join(staging, LO_SUB, "soffice.com"), "utf8"), "fake-entry");
  Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
  assert.equal((await firstDone).source, "published");
  assert.equal((await waitingDone).source, "cache", "waiting preparation reuses the completed cache after ownership is released");
  assert.equal(fs.readFileSync(path.join(options.enginesRoot, options.bundleName, LO_SUB, "soffice.com"), "utf8"), "fake-entry");
});

for (const ownLock of [true, false]) {
  test(`cache publication cleans an exited worker's lock only when its token matches (${ownLock})`, async (t) => {
    const { root, bundle } = await makeBundle(t, "worker-exit-lock");
    const enginesRoot = path.join(root, "engines");
    const lockDir = path.join(enginesRoot, ".flyingmouse-prepare.lock");
    const childProcess = require("node:child_process");
    const realFork = childProcess.fork;
    const modulePath = require.resolve("../store-engine-cache");
    const previousModule = require.cache[modulePath];
    class FailedWorker extends require("node:events").EventEmitter {
      constructor() { super(); this.pid = process.pid; }
      send(workerData) {
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid,
          token: ownLock ? workerData.prepareOwnerToken : "d".repeat(24) }));
        setImmediate(() => this.emit("close", 1));
      }
    }
    try {
      childProcess.fork = () => new FailedWorker();
      delete require.cache[modulePath];
      const isolatedModule = require("../store-engine-cache");
      await assert.rejects(isolatedModule.prepareWritableEngineBundleAsync({ bundledBundle: bundle,
        bundledSofficePath: path.join(bundle, LO_SUB, "soffice.com"), enginesRoot, tmpRoot: root }), /exited without a result/);
      assert.equal(fs.existsSync(lockDir), !ownLock, "an exited worker must not unlock another active preparation");
    } finally {
      childProcess.fork = realFork;
      require.cache[modulePath] = previousModule;
    }
  });
}

test("cache publication returns within its deadline for an existing owner-less lock", async (t) => {
  const { options, destBundle, entry } = await replacementFixture(t);
  const lockDir = path.join(options.enginesRoot, ".flyingmouse-prepare.lock");
  fs.mkdirSync(lockDir);
  fs.mkdirSync(`${destBundle}.staging`);
  fs.writeFileSync(path.join(`${destBundle}.staging`, "other-owner.txt"), "do not touch");
  const child = require("node:child_process").spawnSync(process.execPath, ["-e", `
    const cache = require(process.argv[1]);
    const options = JSON.parse(process.argv[2]);
    const result = cache.prepareWritableEngineBundle({ ...options, prepareLockTimeoutMs: 0 });
    process.stdout.write(JSON.stringify(result));
  `, require.resolve("../store-engine-cache"), JSON.stringify(options)], {
    encoding: "utf8", timeout: 2500, windowsHide: true
  });
  assert.equal(child.error, undefined, `preparation exceeded the 2500ms child deadline: ${child.error?.code}`);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.source, "bundled");
  assert.match(result.reason, /owner.*missing|missing.*owner/);
  assert.ok(fs.existsSync(lockDir), "unknown lock ownership must be preserved");
  assert.equal(fs.readFileSync(entry, "utf8"), "fake-entry");
  assert.equal(fs.readFileSync(path.join(`${destBundle}.staging`, "other-owner.txt"), "utf8"), "do not touch");
});

test("cache publication diagnoses damaged owner metadata without removing the unknown lock", async (t) => {
  const { options, entry } = await replacementFixture(t);
  const lockDir = path.join(options.enginesRoot, ".flyingmouse-prepare.lock");
  fs.mkdirSync(lockDir);
  for (const content of ["{ damaged", "null", '{"pid":0,"token":"invalid"}']) {
    fs.writeFileSync(path.join(lockDir, "owner.json"), content);
    const outcome = prepareWritableEngineBundle({ ...options, prepareLockTimeoutMs: 0 });
    assert.equal(outcome.source, "bundled");
    assert.match(outcome.reason, /Invalid.*lock owner.*preserved/);
    assert.equal(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"), content);
    assert.equal(fs.readFileSync(entry, "utf8"), "fake-entry");
  }
});

test("cache publication retires ownership before a lock cleanup interruption", async (t) => {
  const { options } = await replacementFixture(t);
  const lockDir = path.join(options.enginesRoot, ".flyingmouse-prepare.lock");
  const remove = fs.rmSync;
  let interrupted = false;
  fs.rmSync = function(target, ...rest) {
    if (!interrupted && (target === lockDir || String(target).endsWith(".retired"))) {
      interrupted = true;
      fs.unlinkSync(path.join(target, "owner.json"));
      throw publicationError();
    }
    return remove.call(this, target, ...rest);
  };
  let outcome;
  try { outcome = prepareWritableEngineBundle(options); } finally { fs.rmSync = remove; }
  assert.equal(interrupted, true);
  assert.equal(outcome.source, "published", "post-publication housekeeping must not undo successful preparation");
  assert.equal(fs.existsSync(lockDir), false, "interrupted owner deletion must not leave an active empty lock");
  const retired = fs.readdirSync(options.enginesRoot).filter(name => name.endsWith(".retired"));
  assert.equal(retired.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(options.enginesRoot, retired[0])), []);
  assert.equal(prepareWritableEngineBundle({ ...options, prepareLockTimeoutMs: 0 }).source, "cache");
});

for (const timeout of [0, 5000]) {
  test(`cache publication observes the deadline when a lock disappears during owner read (${timeout})`, async (t) => {
    const { options } = await replacementFixture(t);
    const lockDir = path.join(options.enginesRoot, ".flyingmouse-prepare.lock");
    fs.mkdirSync(lockDir);
    const read = fs.readFileSync;
    let removed = false;
    fs.readFileSync = function(file, ...rest) {
      if (!removed && file === path.join(lockDir, "owner.json")) {
        removed = true;
        fs.rmdirSync(lockDir);
        const error = new Error("owner left while acquiring"); error.code = "ENOENT"; throw error;
      }
      return read.call(this, file, ...rest);
    };
    let outcome;
    try { outcome = prepareWritableEngineBundle({ ...options, prepareLockTimeoutMs: timeout }); }
    finally { fs.readFileSync = read; }
    assert.equal(removed, true);
    assert.equal(outcome.source, timeout ? "published" : "bundled");
    if (!timeout) assert.match(outcome.reason, /busy.*disappeared/);
    assert.equal(fs.existsSync(lockDir), false);
  });
}
