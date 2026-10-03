'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test, before, after } = require('node:test');
const JSZip = require('jszip');
const sharp = require('sharp');
const { convertOfdToPdf } = require('../ofd-convert');
const { PDFTOPPM_PATH } = require('../config');

const runFile = promisify(execFile);
const ns = 'http://www.ofdspec.org/2016';
const pixelsPerMm = 96 / 25.4;
let root;
let sequence = 0;

before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-ofd-boundary-')); });
after(async () => {
  if (!root) return;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('fm-ofd-boundary-'));
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(content, imageBytes) {
  const zip = new JSZip();
  zip.file('OFD.xml', `<o:OFD xmlns:o="${ns}"><o:DocBody><o:DocRoot>Doc/Document.xml</o:DocRoot></o:DocBody></o:OFD>`);
  zip.file('Doc/Document.xml', `<o:Document xmlns:o="${ns}"><o:CommonData><o:PageArea><o:PhysicalBox>0 0 100 100</o:PhysicalBox></o:PageArea><o:DocumentRes>Res.xml</o:DocumentRes></o:CommonData><o:Pages><o:Page ID="1" BaseLoc="Page.xml"/></o:Pages></o:Document>`);
  const media = imageBytes ? '<o:MultiMedias><o:MultiMedia ID="8" Type="Image" Format="PNG"><o:MediaFile>Image.png</o:MediaFile></o:MultiMedia></o:MultiMedias>' : '';
  zip.file('Doc/Res.xml', `<o:Res xmlns:o="${ns}"><o:Fonts><o:Font ID="2" FontName="Helvetica"/></o:Fonts>${media}</o:Res>`);
  zip.file('Doc/Page.xml', `<o:Page xmlns:o="${ns}"><o:Content><o:Layer ID="9">${content}</o:Layer></o:Content></o:Page>`);
  if (imageBytes) zip.file('Doc/Image.png', imageBytes);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function raster(content, imageBytes) {
  const prefix = path.join(root, String(++sequence));
  const input = prefix + '.ofd';
  const output = prefix + '.pdf';
  await fs.writeFile(input, await fixture(content, imageBytes));
  // Exercise the production conversion and its output validation, then inspect
  // the independent raster instead of trusting text extraction or PDF operators.
  await convertOfdToPdf(input, output);
  await runFile(PDFTOPPM_PATH, ['-singlefile', '-png', '-r', '96', output, prefix], {
    windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024
  });
  return sharp(await fs.readFile(prefix + '.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

function ink(rasterized, box) {
  const { data, info } = rasterized;
  const [left, top, right, bottom] = box.map(value => Math.round(value * pixelsPerMm));
  let count = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const offset = (y * info.width + x) * info.channels;
    if (data[offset] < 245 || data[offset + 1] < 245 || data[offset + 2] < 245) count++;
  }
  return count;
}

test('an omitted PathObject Fill does not turn FillColor into a painted background', async () => {
  const text = '<o:TextObject ID="3" Boundary="20 20 70 60" Font="2" Size="6"><o:TextCode X="0" Y="6">KEEP TITLE</o:TextCode><o:TextCode X="0" Y="40">BODY CONTENT</o:TextCode></o:TextObject>';
  const rectangle = '<o:PathObject ID="4" Boundary="20 50 70 20" Stroke="true"><o:FillColor Value="255 255 255"/><o:AbbreviatedData>S 0 0 L 70 0 L 70 20 L 0 20 C</o:AbbreviatedData></o:PathObject>';
  const omitted = await raster(text + rectangle);
  const explicitFalse = await raster(text + rectangle.replace('Stroke="true"', 'Stroke="true" Fill="false"'));
  const explicitTrue = await raster(text + rectangle.replace('Stroke="true"', 'Stroke="true" Fill="true"'));
  assert.ok(ink(explicitFalse, [22, 53, 85, 67]) > 100);
  assert.ok(omitted.data.equals(explicitFalse.data), 'omitted Fill must render identically to explicit false');
  assert.equal(ink(explicitTrue, [22, 53, 85, 67]), 0);
});

const marker = '<o:PathObject ID="99" Boundary="60 20 10 10" Fill="true" Stroke="false"><o:FillColor Value="0 150 0"/><o:AbbreviatedData>S 0 0 L 10 0 L 10 10 L 0 10 C</o:AbbreviatedData></o:PathObject>';
const overflowing = {
  path: '<o:PathObject ID="3" Boundary="20 20 10 10" Fill="true" Stroke="false"><o:FillColor Value="255 0 0"/><o:AbbreviatedData>S -10 -10 L 30 -10 L 30 30 L -10 30 C</o:AbbreviatedData></o:PathObject>',
  text: '<o:TextObject ID="3" Boundary="20 20 10 10" Font="2" Size="6"><o:TextCode X="-8" Y="6">MMMMMMMM</o:TextCode><o:TextCode X="0" Y="-5">MMMM</o:TextCode><o:TextCode X="0" Y="22">MMMM</o:TextCode></o:TextObject>',
  image: '<o:ImageObject ID="3" Boundary="20 20 10 10" ResourceID="8" CTM="30 0 0 30 -10 -10"/>'
};

for (const [type, content] of Object.entries(overflowing)) {
  test(`${type} is clipped to its Boundary and does not clip the following object`, async () => {
    const imageBytes = type === 'image'
      ? await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer()
      : undefined;
    const result = await raster(content + marker, imageBytes);
    assert.ok(ink(result, [21, 21, 29, 29]) > 30, 'object must remain visible inside its Boundary');
    for (const box of [[5, 5, 55, 19], [5, 31, 55, 55], [5, 20, 19, 30], [31, 20, 55, 30]]) {
      assert.equal(ink(result, box), 0, `paint escaped Boundary into ${box}`);
    }
    assert.ok(ink(result, [62, 22, 68, 28]) > 400, 'the next object must retain its own clip');
  });
}

test('a path with neither fill nor stroke cannot leak into the next clipping path', async () => {
  const invisible = overflowing.path.replace('Fill="true"', 'Fill="false"');
  const result = await raster(invisible + overflowing.text + marker);
  assert.equal(ink(result, [5, 5, 55, 19]), 0);
  assert.equal(ink(result, [31, 20, 55, 30]), 0);
  assert.ok(ink(result, [21, 21, 29, 29]) > 30);
  assert.ok(ink(result, [62, 22, 68, 28]) > 400);
});
