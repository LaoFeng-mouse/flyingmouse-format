'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test, before, after, mock } = require('node:test');
const { PDFDocument, rgb } = require('pdf-lib');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-docx-integrity-http-'));
process.env.FLYINGMOUSE_RUNTIME_DIR = root;
process.env.FLYINGMOUSE_LOG_FILE = path.join(root, 'test.log');
const config = require('../config');
config.DOCENGINE_PATH = 'fixture-docengine';
mock.method(require('../utils'), 'commandExists', async () => false);
mock.method(require('../office-engine'), 'probeLibreOffice', async () => ({ enabled: false }));
mock.method(require('../markdown-document'), 'pandocPath', () => '');
mock.method(require('../pdf-structure-engine'), 'getStructuredPdfAvailability', async () => ({ enabled: false }));
let nativeCalls = 0, nativeOutputs = 0;
// Only external capability/engine boundaries are replaced. PDF parsing,
// conversion, DOCX validation, HTTP progress and publication remain real.
mock.method(require('../utils'), 'run', async (command, args) => {
  assert.equal(command, config.DOCENGINE_PATH); nativeCalls++;
  await require('../text-docx').convertTextToDocx('Total 118600', 'txt', args[2]);
  assert.equal((await require('../pdf').validateNativePdfDocx(args[2])).editableText, 'Total 118600');
  nativeOutputs++;
});
const { app } = require('../server');
const { validateNativePdfDocx } = require('../pdf');
let server, origin;
before(async () => {
  require('../utils').ensureDirs();
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  mock.restoreAll(); await fsp.rm(root, { recursive: true, force: true });
});
async function request(vector) {
  const pdf = await PDFDocument.create(), page = pdf.addPage();
  page.drawText(vector ? 'Powered by TCPDF (www.tcpdf.org)' : 'Total 1186.00', { x: 40, y: 780, size: 12 });
  if (vector) page.drawSvgPath('M0 0 L30 0 L30 8 L8 8 L8 40 L0 40 Z', { x: 80, y: 650, color: rgb(0,0,0) });
  const form = new FormData(), id = randomUUID();
  form.append('file', new Blob([await pdf.save()]), vector ? 'vector.pdf' : 'decimal.pdf');
  form.append('targetFormat', 'docx');
  const response = await fetch(origin + '/api/convert', { method: 'POST', body: form,
    headers: { 'X-FlyingMouse-Progress-Id': id } });
  const body = await response.json();
  const progress = await (await fetch(origin + '/api/conversion-progress/' + id)).json();
  return { response, body, progress };
}

test('vector-only body with a native footer returns 422, failed progress, and no download or success log', async () => {
  const downloads = [...config.downloads.keys()], calls = nativeCalls;
  const { response, body, progress } = await request(true);
  assert.equal(response.status, 422);
  assert.equal(body.errorCode, 'PDF_DOCX_CONTENT_UNVERIFIED');
  assert.notEqual(body.ok, true); assert.equal(body.downloadUrl, undefined);
  assert.equal(progress.status, 'failed');
  assert.equal(nativeCalls, calls, 'uncertified graphical content must be rejected before native publication');
  assert.deepEqual([...config.downloads.keys()], downloads);
  assert.deepEqual(await fsp.readdir(config.OUTPUT_DIR), []);
  assert.deepEqual(await fsp.readdir(config.UPLOAD_DIR), []);
  const log = await fsp.readFile(process.env.FLYINGMOUSE_LOG_FILE, 'utf8');
  assert.match(log, /Convert rejected/); assert.doesNotMatch(log, /Convert succeeded/);
});

test('native decimal loss returns success only after real fallback restores downloadable text', async () => {
  const calls = nativeCalls, outputs = nativeOutputs, { response, body, progress } = await request(false);
  assert.equal(response.status, 200); assert.equal(body.ok, true);
  assert.equal(nativeCalls, calls + 1);
  assert.equal(nativeOutputs, outputs + 1, 'the faulty native document was actually produced and structurally valid');
  assert.ok(body.warnings.some(w => w.code === 'PDF_DOCX_LAYOUT_FALLBACK'));
  const download = await fetch(origin + body.downloadUrl);
  assert.equal(download.status, 200);
  const output = path.join(root, 'checked.docx');
  await fsp.writeFile(output, Buffer.from(await download.arrayBuffer()));
  assert.equal((await validateNativePdfDocx(output)).editableText, 'Total 1186.00');
  assert.equal(progress.status, 'succeeded');
});
