const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { inspect } = require("node:util");
const { test } = require("node:test");
const { convertText } = require("../text-docx");
const { csvToMarkdown, csvToHtmlTable } = require("../text-conversion");
const logger = require("../logger");

async function withScratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fm-text-fidelity-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("JSON text exports retain original numeric tokens and formatting", async (t) => {
  const dir = await withScratch(t);
  const raw = ' {\r\n "id":9007199254740993,"amount":0.12345678901234567890,"large":1e400,"negativeZero":-0,"nested":[1E-400,123456789012345678901234567890]\r\n}\r\n';
  const input = path.join(dir, "input.json");
  await fs.writeFile(input, raw);
  for (const target of ["txt", "json", "md"]) {
    const output = path.join(dir, `result.${target}`);
    const result = await convertText(input, output, "json", target, "input.json");
    const actual = await fs.readFile(output, "utf8");
    if (target === "md") assert.ok(actual.includes(raw), "Markdown must embed the untouched JSON source");
    else assert.equal(actual, raw, `${target} must retain the original JSON text`);
    assert.deepEqual(result.warnings, []);
  }
});

test("JSON Markdown export keeps backticks inside a complete JSON code block", async (t) => {
  const dir = await withScratch(t);
  const raw = '{"ticks":"`````", "id":9007199254740993}';
  const input = path.join(dir, "input.json");
  const output = path.join(dir, "result.md");
  await fs.writeFile(input, raw);
  await convertText(input, output, "json", "md", "input.json");
  const actual = await fs.readFile(output, "utf8");
  const fence = /^(`{3,})json\n/.exec(actual)?.[1];
  assert.ok(fence && fence.length > 5, "fence must be longer than any input backtick run");
  assert.equal(actual, `${fence}json\n${raw}\n${fence}\n`);
});

test("invalid JSON remains rejected without publishing an output", async (t) => {
  const dir = await withScratch(t);
  const input = path.join(dir, "invalid.json");
  await fs.writeFile(input, '{"id":9007199254740993,}');
  for (const target of ["txt", "json", "md"]) {
    const output = path.join(dir, `rejected-output.${target}`);
    await assert.rejects(convertText(input, output, "json", target, "invalid.json"), /JSON/);
    await assert.rejects(fs.stat(output), { code: "ENOENT" });
  }
});

for (const [target, convert] of [["Markdown", csvToMarkdown], ["HTML", csvToHtmlTable]]) {
  test(`150000-row CSV converts to ${target} without dropping the final row`, () => {
    const raw = 'id,value\n' + '1,x\n'.repeat(149999) + '150000,final-row\n';
    const actual = convert(raw);
    if (target === "Markdown") {
      assert.equal(actual.split("\n").length, 150002);
      assert.ok(actual.endsWith("| 150000 | final-row |"));
    } else {
      assert.equal(actual.match(/<tr>/g).length, 150001);
      assert.ok(actual.includes("<tr><td>150000</td><td>final-row</td></tr>"));
    }
  });
}

test("invalid YAML error and persisted log exclude body, aliases and tags", async (t) => {
  const dir = await withScratch(t);
  const previousLogFile = logger.getLogFile();
  t.after(() => logger.setLogFile(previousLogFile));
  const privateMarker = "FM_SYNTHETIC_PRIVATE_DOCUMENT_6A89";
  const cases = [
    `credential: ${privateMarker}\nbroken: [one, two\n`,
    `credential: value\nreference: *${privateMarker}\n`,
    `credential: value\nreference: !${privateMarker} value\n`
  ];
  for (const [index, raw] of cases.entries()) {
    const input = path.join(dir, `invalid-${index}.yaml`);
    const output = path.join(dir, `invalid-${index}.json`);
    const logPath = path.join(dir, `invalid-${index}.log`);
    await fs.writeFile(input, raw);
    let caught;
    try { await convertText(input, output, "yaml", "json", "input.yaml"); }
    catch (error) { caught = error; }
    assert.ok(caught, "malformed YAML must fail");
    assert.equal(caught.code, "YAML_JSON_PARSE_FAILED");
    logger.setLogFile(logPath);
    logger.error("YAML conversion rejected", caught);
    const persisted = await fs.readFile(logPath, "utf8");
    assert.ok(!inspect(caught, { depth: null }).includes(privateMarker), "the error object must not retain document content");
    assert.ok(!persisted.includes(privateMarker), "persisted logs must not contain document content");
    assert.ok(typeof caught.details?.reason === "string" && caught.details.reason.length > 0);
    assert.ok(Number.isSafeInteger(caught.details?.line) && caught.details.line >= 1);
    assert.ok(Number.isSafeInteger(caught.details?.column) && caught.details.column >= 1);
    assert.match(persisted, /YAML/);
    await assert.rejects(fs.stat(output), { code: "ENOENT" });
  }
});
