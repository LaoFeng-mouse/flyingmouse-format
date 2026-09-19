const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { executeCli, parseCliArgs } = require("../cli");

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-cli-lifecycle-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, "explicit-parent");
  const temp = path.join(root, "system-temp");
  await fsp.mkdir(parent);
  await fsp.mkdir(temp);
  await fsp.mkdir(path.join(temp, "flyingmouse-format-runtime"));
  await fsp.writeFile(path.join(parent, "other-instance.txt"), "OTHER INSTANCE DATA");
  await fsp.writeFile(path.join(temp, "flyingmouse-format-runtime", "existing.txt"), "SHARED DEFAULT DATA");
  const input = path.join(parent, "input.txt");
  await fsp.writeFile(input, "SYNTHETIC PRIVATE CLI BODY\n");
  return { root, parent, temp, input };
}

function invoke(f, args, name, explicit = true) {
  return new Promise((resolve, reject) => {
    const logFile = path.join(f.root, `${name}.log`);
    const env = { ...process.env, TMP: f.temp, TEMP: f.temp, TMPDIR: f.temp, FLYINGMOUSE_LOG_FILE: logFile };
    if (explicit) env.FLYINGMOUSE_RUNTIME_DIR = f.parent;
    else delete env.FLYINGMOUSE_RUNTIME_DIR;
    const child = spawn(process.execPath, [path.join(__dirname, "..", "cli.js"), ...args, "--json"], {
      cwd: path.join(__dirname, ".."), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("CLI lifecycle test timed out")); }, 60000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", async code => {
      clearTimeout(timer);
      try {
        const log = await fsp.readFile(logFile, "utf8");
        const runtime = log.match(/Server starting \(runtime dir: (.*?), engines:/)?.[1];
        resolve({ code, stdout, stderr, runtime });
      } catch (error) { reject(error); }
    });
  });
}

async function assertProtected(f, results) {
  assert.equal(await fsp.readFile(path.join(f.parent, "other-instance.txt"), "utf8"), "OTHER INSTANCE DATA");
  assert.equal(await fsp.readFile(path.join(f.temp, "flyingmouse-format-runtime", "existing.txt"), "utf8"), "SHARED DEFAULT DATA");
  assert.equal(await fsp.readFile(f.input, "utf8"), "SYNTHETIC PRIVATE CLI BODY\n");
  for (const result of results) {
    assert.ok(result.runtime, result.stderr);
    assert.notEqual(path.resolve(result.runtime), path.resolve(f.parent), "explicit parent must not be used as an owned runtime");
    assert.equal(fs.existsSync(result.runtime), false, "this invocation's runtime must be removed after CLI completes");
  }
  for (const parent of [f.parent, f.temp]) {
    const owned = (await fsp.readdir(parent)).filter(name => name.startsWith("flyingmouse-cli-"));
    assert.deepEqual(owned, [], "owned workspace roots must also be removed");
  }
}

test("CLI success cleans its own runtime and preserves explicit parent, input, output and shared default", async t => {
  const f = await fixture(t);
  const output = path.join(f.parent, "saved.md");
  const result = await invoke(f, ["convert", f.input, "--to", "md", "--output", output], "success");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(await fsp.readFile(output, "utf8"), "SYNTHETIC PRIVATE CLI BODY\n");
  await assertProtected(f, [result]);
});

test("CLI conversion and save failures clean only their own workspaces", async t => {
  const f = await fixture(t);
  const malformed = path.join(f.parent, "invalid.json");
  await fsp.writeFile(malformed, "{");
  const invalid = await invoke(f, ["convert", malformed, "--to", "md", "--output", path.join(f.parent, "invalid.md")], "invalid");
  assert.equal(invalid.code, 1);
  const destination = path.join(f.parent, "existing.md");
  await fsp.writeFile(destination, "USER OUTPUT");
  const save = await invoke(f, ["convert", f.input, "--to", "md", "--output", destination], "save-failure");
  assert.equal(save.code, 1);
  assert.equal(await fsp.readFile(destination, "utf8"), "USER OUTPUT");
  assert.equal(await fsp.readFile(malformed, "utf8"), "{");
  await assertProtected(f, [invalid, save]);
});

test("concurrent CLI invocations get separate workspaces below the same explicit parent", async t => {
  const f = await fixture(t);
  const results = await Promise.all(["a", "b"].map(name => invoke(f,
    ["convert", f.input, "--to", "md", "--output", path.join(f.parent, `${name}.md`)], name)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.notEqual(results[0].runtime, results[1].runtime);
  for (const name of ["a", "b"]) assert.equal(await fsp.readFile(path.join(f.parent, `${name}.md`), "utf8"), "SYNTHETIC PRIVATE CLI BODY\n");
  await assertProtected(f, results);
});

test("CLI without a runtime override never cleans the shared default runtime", async t => {
  const f = await fixture(t);
  const output = path.join(f.parent, "default.md");
  const result = await invoke(f, ["convert", f.input, "--to", "md", "--output", output], "default", false);
  assert.equal(result.code, 0, result.stderr);
  await assertProtected(f, [result]);
});

test("CLI startup failure removes owned files and restores an explicit runtime override", async t => {
  const f = await fixture(t);
  const previous = process.env.FLYINGMOUSE_RUNTIME_DIR;
  process.env.FLYINGMOUSE_RUNTIME_DIR = f.parent;
  let runtimeDir;
  try {
    await assert.rejects(() => executeCli(parseCliArgs(["targets", "txt"]), {
      startServer: async () => {
        runtimeDir = process.env.FLYINGMOUSE_RUNTIME_DIR;
        await fsp.mkdir(runtimeDir, { recursive: true });
        await fsp.writeFile(path.join(runtimeDir, "startup-partial"), "SYNTHETIC TEMP DATA");
        throw new Error("Synthetic server startup failed");
      }
    }), /Synthetic server startup failed/);
    assert.equal(process.env.FLYINGMOUSE_RUNTIME_DIR, f.parent);
    await assertProtected(f, [{ runtime: runtimeDir }]);
  } finally {
    if (previous === undefined) delete process.env.FLYINGMOUSE_RUNTIME_DIR;
    else process.env.FLYINGMOUSE_RUNTIME_DIR = previous;
  }
});

test("CLI refuses cleanup when another directory replaces its owned workspace", async t => {
  const f = await fixture(t);
  const previous = process.env.FLYINGMOUSE_RUNTIME_DIR;
  process.env.FLYINGMOUSE_RUNTIME_DIR = f.parent;
  let replacedRoot;
  try {
    await assert.rejects(() => executeCli(parseCliArgs(["targets", "txt"]), {
      startServer: async () => {
        replacedRoot = path.dirname(process.env.FLYINGMOUSE_RUNTIME_DIR);
        await fsp.rename(replacedRoot, path.join(f.parent, "original-owned-directory"));
        await fsp.mkdir(replacedRoot);
        await fsp.writeFile(path.join(replacedRoot, "other-owner.txt"), "DO NOT DELETE REPLACEMENT");
        throw new Error("Synthetic workspace replacement");
      }
    }), /cleanup was refused/);
    assert.equal(await fsp.readFile(path.join(replacedRoot, "other-owner.txt"), "utf8"), "DO NOT DELETE REPLACEMENT");
    assert.equal(process.env.FLYINGMOUSE_RUNTIME_DIR, f.parent);
    assert.equal(await fsp.readFile(path.join(f.parent, "other-instance.txt"), "utf8"), "OTHER INSTANCE DATA");
  } finally {
    if (previous === undefined) delete process.env.FLYINGMOUSE_RUNTIME_DIR;
    else process.env.FLYINGMOUSE_RUNTIME_DIR = previous;
  }
});
