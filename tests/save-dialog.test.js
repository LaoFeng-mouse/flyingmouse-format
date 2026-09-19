const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { test } = require('node:test');
const { saveConvertedResult } = require('../save-converted-result');
const { downloadToFile } = require('../save-download');
const { readLastSaveDirectory, writeLastSaveDirectory } = require('../settings-store');

const AUDIO = Buffer.from('ID3\x04\x00\x00SYNTHETIC_MP3_SAVE_BYTES');

async function fixture(t, { selectedName = 'audio1', confirmation = 1, canceled = false, beforeDownload } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-native-save-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Length': AUDIO.length, 'Content-Type': 'audio/mpeg' });
    res.end(AUDIO);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/downloads/synthetic-result`;
  const selectedPath = path.join(root, selectedName);
  const settingsPath = path.join(root, 'settings.json');
  const saveDialogs = [], confirmations = [];
  const source = await fsp.readFile(path.join(__dirname, '..', 'electron-main.js'), 'utf8');
  const start = source.indexOf('ipcMain.handle("save-converted-file",');
  const end = source.indexOf('\nipcMain.handle(', start + 1);
  assert.ok(start >= 0 && end > start);
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, callback) => { handler = callback; } },
    assertTrustedIpc: () => {},
    trustedDownloadUrl: value => { assert.equal(value, url); return value; },
    dialog: {
      showSaveDialog: async (_window, options) => { saveDialogs.push(options); return { canceled, filePath: canceled ? '' : selectedPath }; },
      showMessageBox: async (_window, options) => { confirmations.push(options); return { response: confirmation }; }
    },
    chooseConvertedSavePath: (...args) => require('../save-dialog').chooseConvertedSavePath(...args),
    mainWindow: {}, app: { getPath: () => root }, settingsPath,
    path, fs, readLastSaveDirectory, writeLastSaveDirectory, saveConvertedResult,
    downloadToFile: async (downloadUrl, destination, options) => {
      await beforeDownload?.(destination);
      return downloadToFile(downloadUrl, destination, options);
    },
    log: () => {}
  });
  return { root, selectedPath, settingsPath, saveDialogs, confirmations, requests: () => requests,
    save: () => handler({}, { fileName: 'audio1.mp3', downloadUrl: url, assets: [] }) };
}

for (const selectedName of ['audio1', '自定义音频']) {
  test(`native save adds the real extension when the dialog returns ${selectedName} without it`, async t => {
    const f = await fixture(t, { selectedName });
    const result = await f.save();
    assert.equal(result.filePath, `${f.selectedPath}.mp3`);
    assert.deepEqual(await fsp.readFile(result.filePath), AUDIO);
    assert.equal(fs.existsSync(f.selectedPath), false);
    assert.equal(f.saveDialogs[0].defaultPath, path.join(f.root, 'audio1.mp3'));
    assert.deepEqual(Array.from(f.saveDialogs[0].filters[0].extensions), ['mp3']);
    assert.ok(f.saveDialogs[0].properties.includes('showOverwriteConfirmation'));
  });
}

test('native save preserves an existing correct extension and casing', async t => {
  const f = await fixture(t, { selectedName: 'already.MP3' });
  const result = await f.save();
  assert.equal(result.filePath, f.selectedPath);
  assert.deepEqual(await fsp.readFile(result.filePath), AUDIO);
  assert.equal(fs.existsSync(`${f.selectedPath}.mp3`), false);
});

test('native save restores the remembered directory and records the completed successful destination', async t => {
  const f = await fixture(t);
  const previous = path.join(f.root, 'previous-save-directory');
  await fsp.mkdir(previous);
  await writeLastSaveDirectory(f.settingsPath, previous);
  const result = await f.save();
  assert.equal(f.saveDialogs[0].defaultPath, path.join(previous, 'audio1.mp3'));
  assert.equal(await readLastSaveDirectory(f.settingsPath, previous), path.dirname(result.filePath));
});

test('the native-confirmed existing path with the correct extension is still replaced', async t => {
  const f = await fixture(t, { selectedName: 'confirmed.mp3' });
  await fsp.writeFile(f.selectedPath, 'OLD MP3 FILE');
  const result = await f.save();
  assert.equal(result.filePath, f.selectedPath);
  assert.deepEqual(await fsp.readFile(result.filePath), AUDIO);
  assert.equal(f.confirmations.length, 0);
});

test('a different filename suffix is retained as part of the name and never mislabeled or overwritten', async t => {
  const f = await fixture(t, { selectedName: 'my.track.wav' });
  await fsp.writeFile(f.selectedPath, 'ORIGINAL WAV FILE');
  const result = await f.save();
  assert.equal(result.filePath, `${f.selectedPath}.mp3`);
  assert.equal(await fsp.readFile(f.selectedPath, 'utf8'), 'ORIGINAL WAV FILE');
  assert.deepEqual(await fsp.readFile(result.filePath), AUDIO);
});

test('canceling the extra overwrite confirmation preserves both the chosen name and completed-extension file', async t => {
  const f = await fixture(t, { selectedName: 'collision', confirmation: 1 });
  await fsp.writeFile(f.selectedPath, 'ORIGINAL EXTENSIONLESS FILE');
  await fsp.writeFile(`${f.selectedPath}.mp3`, 'ORIGINAL MP3 FILE');
  const result = await f.save();
  assert.equal(result.canceled, true);
  assert.equal(await fsp.readFile(f.selectedPath, 'utf8'), 'ORIGINAL EXTENSIONLESS FILE');
  assert.equal(await fsp.readFile(`${f.selectedPath}.mp3`, 'utf8'), 'ORIGINAL MP3 FILE');
  assert.equal(f.confirmations.length, 1);
  assert.ok(f.confirmations[0].detail.includes(`${f.selectedPath}.mp3`));
  assert.equal(f.confirmations[0].defaultId, f.confirmations[0].cancelId);
  assert.equal(f.requests(), 0);
  assert.equal(fs.existsSync(f.settingsPath), false);
});

test('explicit confirmation replaces only the completed-extension target', async t => {
  const f = await fixture(t, { selectedName: 'replace', confirmation: 0 });
  await fsp.writeFile(f.selectedPath, 'KEEP EXTENSIONLESS FILE');
  await fsp.writeFile(`${f.selectedPath}.mp3`, 'OLD MP3 FILE');
  const result = await f.save();
  assert.equal(f.confirmations.length, 1);
  assert.equal(result.filePath, `${f.selectedPath}.mp3`);
  assert.deepEqual(await fsp.readFile(result.filePath), AUDIO);
  assert.equal(await fsp.readFile(f.selectedPath, 'utf8'), 'KEEP EXTENSIONLESS FILE');
});

test('a file created after the dialog cannot be overwritten without confirmation', async t => {
  const f = await fixture(t, { selectedName: 'racing', beforeDownload: destination => fsp.writeFile(destination, 'CONCURRENT USER FILE') });
  await assert.rejects(f.save(), /EEXIST|已有文件/);
  assert.equal(await fsp.readFile(`${f.selectedPath}.mp3`, 'utf8'), 'CONCURRENT USER FILE');
  assert.equal(fs.existsSync(f.settingsPath), false);
});

test('canceling the native dialog performs no download or settings update', async t => {
  const f = await fixture(t, { canceled: true });
  const result = await f.save();
  assert.equal(result.canceled, true);
  assert.equal(f.requests(), 0);
  assert.equal(f.confirmations.length, 0);
  assert.equal(fs.existsSync(f.settingsPath), false);
});

test('a directory at the completed-extension path is refused before download', async t => {
  const f = await fixture(t, { selectedName: 'directory' });
  await fsp.mkdir(`${f.selectedPath}.mp3`);
  await fsp.writeFile(path.join(`${f.selectedPath}.mp3`, 'keep.txt'), 'USER DATA');
  await assert.rejects(f.save(), /不是普通文件/);
  assert.equal(await fsp.readFile(path.join(`${f.selectedPath}.mp3`, 'keep.txt'), 'utf8'), 'USER DATA');
  assert.equal(f.requests(), 0);
  assert.equal(fs.existsSync(f.settingsPath), false);
});
