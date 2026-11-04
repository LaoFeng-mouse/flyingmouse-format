"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");

const root = require("node:fs").mkdtempSync(path.join(os.tmpdir(), "fm-ofd-http-"));
process.env.FLYINGMOUSE_RUNTIME_DIR = root;
process.env.FLYINGMOUSE_LOG_FILE = path.join(root, "test.log");
const { app } = require("../server");
const { downloads } = require("../config");
const { verifyOfdPdf } = require("../ofd-convert");
let server, origin;
before(async () => {
  require("../utils").ensureDirs();
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
async function convert(name) {
  const form = new FormData();
  form.append("file", new Blob([await fs.readFile(path.join(__dirname, "fixtures", "ofd", name + ".ofd"))]), name + ".ofd");
  form.append("targetFormat", "pdf");
  const response = await fetch(origin + "/api/convert", { method: "POST", headers: { Origin: origin, "X-FlyingMouse-Progress-Id": randomUUID() }, body: form });
  return { status: response.status, result: await response.json() };
}

test("HTTP OFD cannot return success or register a download when resources/pages are missing", async () => {
  for (const name of ["blank-image-declared-but-missing", "missing-only-page-xml"]) {
    const count = downloads.size, { status, result } = await convert(name);
    assert.equal(status, 422, JSON.stringify(result));
    assert.match(result.errorCode, /^OFD_(MISSING_PAGE|MISSING_RESOURCE)$/);
    assert.equal(result.ok, undefined); assert.equal(result.downloadUrl, undefined); assert.equal(downloads.size, count);
  }
});

test("HTTP OFD downloads visible results for previous blank-page triggers, including repeat conversions", async () => {
  for (const name of ["blank-image-resource-baseloc", "blank-text-hidden-by-reordered-background", "blank-page-different-namespace-prefix", "blank-image-resource-baseloc"]) {
    const { status, result } = await convert(name); assert.equal(status, 200, JSON.stringify(result)); assert.equal(result.ok, true);
    const response = await fetch(origin + result.downloadUrl, { headers: { Origin: origin } }); assert.equal(response.status, 200);
    const output = path.join(root, randomUUID() + ".pdf"); await fs.writeFile(output, Buffer.from(await response.arrayBuffer()));
    const verification = await verifyOfdPdf(output, { pageCount: 1, pages: [{ hasContent: true, expectsVisibleContent: true }] });
    assert.equal(verification.pages[0].visible, true, name);
  }
});
