const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const {
  parseCliArgs,
  resolveOutputDestinations,
  sanitizeJsonError
} = require("../cli");

test("CLI accepts leading help flags with successful output and no conversion service", () => {
  for (const args of [[], ["--help"], ["-h"], ["convert", "--help"]]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "cli.js"), ...args], {
      encoding: "utf8", timeout: 10000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^FlyingMouse Format CLI/);
    assert.doesNotMatch(result.stderr, /requires at least|Unknown command|Server started/);
  }
});

test("CLI parses conversion, merge, JSON, and engine options", () => {
  const parsed = parseCliArgs([
    "convert", "一.txt", "二.txt", "--to", "md", "--output-dir", "out",
    "--video-codec", "h265", "--pdf-action", "decrypt",
    "--password", "secret", "--text-encoding", "gb18030", "--json"
  ]);
  assert.equal(parsed.command, "convert");
  assert.deepEqual(parsed.files, ["一.txt", "二.txt"]);
  assert.equal(parsed.options.to, "md");
  assert.equal(parsed.options.outputDir, "out");
  assert.equal(parsed.options.videoCodec, "h265");
  assert.equal(parsed.options.pdfAction, "decrypt");
  assert.equal(parsed.options.password, "secret");
  assert.equal(parsed.options.textEncoding, "gb18030");
  assert.equal(parsed.options.json, true);
});

test("CLI preserves Chinese basenames and rejects ambiguous multi-file output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flyingmouse-cli-output-"));
  const destinations = resolveOutputDestinations([
    { fileName: "中文结果.md" },
    { fileName: "第二个.md" }
  ], { outputDir: dir });
  assert.equal(destinations[0], path.join(dir, "中文结果.md"));
  const duplicateDestinations = resolveOutputDestinations([
    { fileName: "同名.md" }, { fileName: "同名.md" }
  ], { outputDir: dir });
  assert.notEqual(duplicateDestinations[0], duplicateDestinations[1]);
  assert.throws(() => resolveOutputDestinations([
    { fileName: "a.md" }, { fileName: "b.md" }
  ], { output: path.join(dir, "one.md") }), /--output-dir/);
});

test("CLI JSON errors never include the PDF password", () => {
  const payload = sanitizeJsonError(new Error("conversion failed: super-secret"), { password: "super-secret" });
  assert.doesNotMatch(JSON.stringify(payload), /super-secret/);
  assert.equal(payload.ok, false);
});

test("CLI keeps stdout as one parseable JSON value when engine probes warn", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "cli.js"), "targets", "README.md", "--json"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.extension, "md");
  assert.doesNotMatch(result.stdout, /\[WARN\]/);
});

test("CLI exposes successful conversion warnings without changing path-only stdout or JSON output", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-cli-quality-warning-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "source.pdf");
  await fs.writeFile(input, "HTTP boundary input");
  const warning = { code: "PDF_NATIVE_ILLUSTRATIONS_PRESERVED", pageNumbers: [6], messages: {
    zhCN: "第 6 页插图已保留；图内文字仍为图片。", enUS: "Page 6 figures were preserved; text inside figures remains an image."
  } };
  for (const json of [false, true]) {
    const output = path.join(root, json ? "json.docx" : "plain.docx");
    // Exercise the public CLI plus actual multipart HTTP and download/save.
    // The server boundary supplies a successful response carrying a warning.
    const script = `
      const http = require('node:http');
      const { runCli } = require(${JSON.stringify(path.join(__dirname, "..", "cli.js"))});
      const warning = ${JSON.stringify(warning)};
      const runtime = { startServer: async () => {
        const server = http.createServer((req, res) => {
          if (req.url.startsWith('/downloads/')) { res.end('complete converted output'); return; }
          req.resume(); req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, fileName: 'source.docx', downloadUrl: '/downloads/result', warnings: [warning] }));
          });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        return { server, url: 'http://127.0.0.1:' + server.address().port };
      } };
      runCli(${JSON.stringify(["convert", input, "--to", "docx", "--output", output, ...(json ? ["--json"] : [])])}, runtime)
        .then(code => { process.exitCode = code; });
    `;
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(output, "utf8"), "complete converted output");
    if (json) {
      const payload = JSON.parse(result.stdout);
      assert.deepEqual(payload.outputs[0].warnings, [warning]);
      assert.doesNotMatch(result.stderr, /PDF_NATIVE_ILLUSTRATIONS_PRESERVED/);
    } else {
      assert.equal(result.stdout.trim(), output);
      assert.match(result.stderr, /PDF_NATIVE_ILLUSTRATIONS_PRESERVED/);
      assert.ok(result.stderr.includes(warning.messages.zhCN));
      assert.ok(result.stderr.includes("source.docx"));
    }
  }
});
