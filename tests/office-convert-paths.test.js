const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const SOURCE_TEXT = 'Synthetic Office path regression 084.';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative);
}

// Load the complete conversion module. Replace only configuration and the
// external native-engine boundary; staging, publication and cleanup use real IO.
function loadConverter(runtime, native) {
  const filename = require.resolve('../office-convert');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const localRequire = loaded.require.bind(loaded);
  loaded.require = request => {
    if (request === './config') return { RUNTIME_DIR: runtime, LIBREOFFICE_PATH: 'synthetic-office-engine' };
    if (request === './office-engine') return { ...localRequire(request), runLibreOffice: native };
    if (request === './office-readiness') return { waitForOfficeReady: async () => ({ status: 'ready' }) };
    return localRequire(request);
  };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports.convertWithLibreOffice;
}

async function fixture(t, { deepRuntime = false, longName = false } = {}) {
  const temporaryParent = path.resolve(os.tmpdir());
  const root = await fsp.mkdtemp(path.join(temporaryParent, 'fm-office-paths-'));
  assert(inside(temporaryParent, root));
  const previousLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'local');
  t.mock.method(os, 'homedir', () => root);
  t.after(async () => {
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocal;
    assert(inside(temporaryParent, root));
    await fsp.rm(root, { recursive: true, force: true });
  });
  let runtime = path.join(root, 'runtime');
  if (deepRuntime) {
    while (runtime.length < 235) runtime = path.join(runtime, 'nested-runtime-'.repeat(3));
  }
  await fsp.mkdir(runtime, { recursive: true });
  const inputDirectory = path.join(root, 'originals');
  const outputDirectory = path.join(root, 'results');
  await fsp.mkdir(inputDirectory);
  await fsp.mkdir(outputDirectory);
  const name = longName ? '长原件-' + 'document-'.repeat(23) + '.docx' : 'source.docx';
  const input = path.join(inputDirectory, name);
  const output = path.join(outputDirectory, path.basename(name, '.docx') + '.pdf');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + SOURCE_TEXT + '</w:t></w:r></w:p></w:body></w:document>');
  const original = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fsp.writeFile(input, original, { flag: 'wx' });
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText(SOURCE_TEXT, { font: await pdf.embedFont(StandardFonts.Helvetica), x: 24, y: 700 });
  const converted = Buffer.from(await pdf.save());
  const sentinel = path.join(runtime, 'other-task.txt');
  await fsp.writeFile(sentinel, 'unrelated task must survive', { flag: 'wx' });
  return { root, runtime, input, output, original, originalSha256: sha256(original), converted, sentinel };
}

async function assertPreserved(f, calls) {
  assert.equal(sha256(await fsp.readFile(f.input)), f.originalSha256, 'original document must remain byte-identical');
  assert.equal(await fsp.readFile(f.sentinel, 'utf8'), 'unrelated task must survive');
  for (const call of calls) {
    assert(inside(f.root, call.input) && inside(f.root, call.out), 'native scratch stays within this test fixture');
    assert.notEqual(call.input, f.input, 'native processing must use an owned copy');
    assert.equal(fs.existsSync(call.input), false, 'owned staged input must be cleaned');
    assert.equal(fs.existsSync(call.out), false, 'owned native output directory must be cleaned');
  }
}

function nativeBoundary(f, calls, { error } = {}) {
  return async (command, args) => {
    assert.equal(command, 'synthetic-office-engine');
    const outIndex = args.indexOf('--outdir');
    assert(outIndex >= 0 && args[outIndex + 1], 'native output directory is required');
    const input = args.at(-1), out = args[outIndex + 1];
    calls.push({ input, out });
    assert(inside(f.root, input) && inside(f.root, out));
    assert.notEqual(input, f.input);
    assert.deepEqual(await fsp.readFile(input), f.original, 'native interface receives the exact document');
    // This models the observed native MAX_PATH boundary, not the staging layout.
    // Failure cases still write a partial native artifact before rejecting.
    if (!error && (input.length >= 260 || out.length >= 260)) {
      throw Object.assign(new Error(`Native Office cannot open long input/output paths (${input.length}/${out.length})`), { code: 'ENAMETOOLONG' });
    }
    await fsp.mkdir(out, { recursive: true });
    const generated = path.join(out, path.basename(input, path.extname(input)) + '.pdf');
    await fsp.writeFile(generated, error ? Buffer.from('incomplete native output') : f.converted, { flag: 'wx' });
    if (error) throw error;
    return { stdout: 'conversion completed', stderr: '' };
  };
}

for (const scenario of [
  { label: 'deep runtime', deepRuntime: true, longName: false },
  { label: 'long original filename', deepRuntime: false, longName: true }
]) {
  test(`Office conversion bounds native input/output for ${scenario.label} and preserves the original`, async t => {
    const f = await fixture(t, scenario), calls = [];
    const convert = loadConverter(f.runtime, nativeBoundary(f, calls));
    await convert(f.input, f.output, path.basename(f.input), 'pdf');
    assert.equal(calls.length, 1);
    assert.deepEqual(await fsp.readFile(f.output), f.converted, 'publish the complete native result under the requested name');
    assert.equal((await PDFDocument.load(await fsp.readFile(f.output))).getPageCount(), 1);
    await assertPreserved(f, calls);
  });
}

test('native Office failure never publishes its partial file and only removes owned staging', async t => {
  const f = await fixture(t, { deepRuntime: true }), calls = [];
  const failure = Object.assign(new Error('synthetic native conversion failure'), { code: 'OFFICE_CONVERSION_FAILED' });
  const convert = loadConverter(f.runtime, nativeBoundary(f, calls, { error: failure }));
  await assert.rejects(convert(f.input, f.output, path.basename(f.input), 'pdf'), error => error === failure);
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(f.output), false, 'failed conversion cannot publish a final result');
  await assertPreserved(f, calls);
});

test('native Office cancellation preserves an existing destination and unrelated files', async t => {
  const f = await fixture(t, { deepRuntime: true }), calls = [];
  const previous = Buffer.from('existing destination belongs to another completed task');
  await fsp.writeFile(f.output, previous, { flag: 'wx' });
  const aborted = Object.assign(new Error('native operation cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
  const convert = loadConverter(f.runtime, nativeBoundary(f, calls, { error: aborted }));
  await assert.rejects(convert(f.input, f.output, path.basename(f.input), 'pdf'), error => error === aborted);
  assert.equal(calls.length, 1);
  assert.deepEqual(await fsp.readFile(f.output), previous);
  await assertPreserved(f, calls);
});

test('Office cleanup preserves a replacement directory at its former workspace path', async t => {
  const f = await fixture(t, { deepRuntime: true });
  const failure = Object.assign(new Error('native failure after workspace replacement'), { code: 'OFFICE_CONVERSION_FAILED' });
  let taskRoot, detached, replacement;
  const convert = loadConverter(f.runtime, async (_command, args) => {
    const input = args.at(-1), out = args[args.indexOf('--outdir') + 1];
    assert.deepEqual(await fsp.readFile(input), f.original);
    taskRoot = path.dirname(input);
    while (taskRoot !== out && !inside(taskRoot, out)) taskRoot = path.dirname(taskRoot);
    assert(inside(f.root, taskRoot) && taskRoot !== f.runtime);
    assert.equal((await fsp.realpath(taskRoot)).toLowerCase(), path.resolve(taskRoot).toLowerCase());
    detached = path.join(f.root, 'detached-original-workspace');
    assert(inside(f.root, detached));
    await fsp.rename(taskRoot, detached);
    await fsp.mkdir(taskRoot);
    replacement = path.join(taskRoot, 'replacement-owner.txt');
    await fsp.writeFile(replacement, 'replacement directory belongs to a different owner', { flag: 'wx' });
    throw failure;
  });
  await assert.rejects(convert(f.input, f.output, path.basename(f.input), 'pdf'), error => error === failure);
  assert.equal(await fsp.readFile(replacement, 'utf8'), 'replacement directory belongs to a different owner');
  assert.equal((await fsp.stat(detached)).isDirectory(), true);
  assert.equal(fs.existsSync(f.output), false);
  assert.equal(sha256(await fsp.readFile(f.input)), f.originalSha256);
  assert.equal(await fsp.readFile(f.sentinel, 'utf8'), 'unrelated task must survive');
  // Both the detached and replacement directories are synthetic children of f.root;
  // only the fixture's final cleanup removes them after the ownership assertion.
});

test('unavailable short Office workspace fails before native execution with a stable bilingual error', async t => {
  const f = await fixture(t, { deepRuntime: true });
  const blocked = path.join(f.root, 'not-a-directory');
  await fsp.writeFile(blocked, 'reserved fixture file', { flag: 'wx' });
  process.env.LOCALAPPDATA = blocked;
  t.mock.method(os, 'homedir', () => blocked);
  let calls = 0;
  const convert = loadConverter(f.runtime, async () => { calls++; });
  await assert.rejects(convert(f.input, f.output, path.basename(f.input), 'pdf'), error =>
    error.code === 'OFFICE_ENGINE_PROFILE_FAILED'
    && Boolean(error.messages?.zhCN) && Boolean(error.messages?.enUS)
    && error.details.profileFailures.length > 0);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(f.output), false);
  assert.equal(await fsp.readFile(blocked, 'utf8'), 'reserved fixture file');
  assert.equal(sha256(await fsp.readFile(f.input)), f.originalSha256);
  assert.equal(await fsp.readFile(f.sentinel, 'utf8'), 'unrelated task must survive');
});

test('CRC repair and WPS roundtrip retain bounded native paths without rewriting the source', async t => {
  const f = await fixture(t, { deepRuntime: true, longName: true }), calls = [];
  const zip = await JSZip.loadAsync(f.original);
  const xml = await zip.file('word/document.xml').async('string');
  zip.file('word/document.xml', xml.replace('<w:document ', '<w:document xmlns:wpsCustomData="urn:synthetic-wps" '));
  const damaged = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  // Corrupt one central-directory CRC, preserving the real DOCX contents.
  const firstCentral = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert(firstCentral >= 0);
  damaged.writeUInt32LE(0, firstCentral + 16);
  await fsp.writeFile(f.input, damaged);
  f.original = damaged;
  f.originalSha256 = sha256(damaged);
  const convert = loadConverter(f.runtime, async (_command, args) => {
    const input = args.at(-1), out = args[args.indexOf('--outdir') + 1];
    const filter = args[args.indexOf('--convert-to') + 1];
    calls.push({ input, out, filter });
    assert(input.length < 260 && out.length < 260, 'repair and conversion must both respect the native path boundary');
    assert(inside(f.root, input) && inside(f.root, out));
    const repairedBytes = await fsp.readFile(input);
    const repairedZip = await JSZip.loadAsync(repairedBytes, { checkCRC32: true });
    assert((await repairedZip.file('word/document.xml').async('string')).includes(SOURCE_TEXT));
    const extension = filter.split(':', 1)[0];
    const generated = path.join(out, path.basename(input, path.extname(input)) + '.' + extension);
    await fsp.writeFile(generated, extension === 'docx' ? repairedBytes : f.converted, { flag: 'wx' });
    return { stdout: 'synthetic roundtrip completed', stderr: '' };
  });
  await convert(f.input, f.output, path.basename(f.input), 'pdf');
  assert.deepEqual(calls.map(call => call.filter), ['docx:MS Word 2007 XML', 'pdf']);
  assert.deepEqual(await fsp.readFile(f.output), f.converted);
  await assertPreserved(f, calls);
});
