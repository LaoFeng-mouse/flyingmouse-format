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

test("CLI parses conversion, merge, JSON, and engine options", () => {
  const parsed = parseCliArgs([
    "convert", "一.txt", "二.txt", "--to", "md", "--output-dir", "out",
    "--video-codec", "h265", "--pdf-action", "decrypt",
    "--password", "secret", "--json"
  ]);
  assert.equal(parsed.command, "convert");
  assert.deepEqual(parsed.files, ["一.txt", "二.txt"]);
  assert.equal(parsed.options.to, "md");
  assert.equal(parsed.options.outputDir, "out");
  assert.equal(parsed.options.videoCodec, "h265");
  assert.equal(parsed.options.pdfAction, "decrypt");
  assert.equal(parsed.options.password, "secret");
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
