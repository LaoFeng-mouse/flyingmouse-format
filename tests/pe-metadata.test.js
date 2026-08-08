const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { inspectPeBuffer, inspectPeFile } = require('../pe-metadata');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'scripts', 'inspect-pe.js');

function createPeBuffer({
  format = 'PE32',
  major = 5,
  minor = 2,
  peOffset = 0x80,
  optionalHeaderSize,
  bufferSize = 0x200,
} = {}) {
  if (format !== 'PE32' && format !== 'PE32+') {
    throw new Error(`Unsupported test PE format: ${format}`);
  }
  const declaredOptionalHeaderSize = optionalHeaderSize ?? (format === 'PE32' ? 0xe0 : 0xf0);
  const buffer = Buffer.alloc(bufferSize);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write('PE\0\0', peOffset, 'binary');
  buffer.writeUInt16LE(declaredOptionalHeaderSize, peOffset + 20);

  const optionalHeaderOffset = peOffset + 24;
  buffer.writeUInt16LE(format === 'PE32' ? 0x10b : 0x20b, optionalHeaderOffset);
  buffer.writeUInt16LE(major, optionalHeaderOffset + 40);
  buffer.writeUInt16LE(minor, optionalHeaderOffset + 42);
  return buffer;
}

test('synthetic PE fixtures use real optional-header sizes and reject unknown formats', () => {
  assert.equal(createPeBuffer().readUInt16LE(0x80 + 20), 0xe0);
  assert.equal(createPeBuffer({ format: 'PE32+' }).readUInt16LE(0x80 + 20), 0xf0);
  assert.throws(() => createPeBuffer({ format: 'PE64' }), /Unsupported test PE format: PE64/);
});

test('inspectPeBuffer reads PE32 operating-system version metadata', () => {
  assert.deepEqual(inspectPeBuffer(createPeBuffer()), {
    format: 'PE32',
    majorOperatingSystemVersion: 5,
    minorOperatingSystemVersion: 2,
    operatingSystemVersion: '5.2',
  });
});

test('inspectPeBuffer reads PE32+ operating-system version metadata', () => {
  assert.deepEqual(inspectPeBuffer(createPeBuffer({ format: 'PE32+', major: 6, minor: 1 })), {
    format: 'PE32+',
    majorOperatingSystemVersion: 6,
    minorOperatingSystemVersion: 1,
    operatingSystemVersion: '6.1',
  });
});

test('inspectPeBuffer rejects malformed and truncated input with domain errors', async (t) => {
  await t.test('non-Buffer input', () => {
    assert.throws(() => inspectPeBuffer('not a buffer'), /input must be a Buffer/i);
  });

  await t.test('truncated DOS header', () => {
    assert.throws(() => inspectPeBuffer(Buffer.alloc(63)), /too short.*DOS header/i);
  });

  await t.test('invalid DOS signature', () => {
    assert.throws(() => inspectPeBuffer(Buffer.alloc(64)), /DOS signature.*MZ/i);
  });

  await t.test('e_lfanew outside the buffer', () => {
    const buffer = Buffer.alloc(64);
    buffer.write('MZ');
    buffer.writeUInt32LE(64, 0x3c);
    assert.throws(() => inspectPeBuffer(buffer), /e_lfanew.*outside the buffer/i);
  });

  await t.test('e_lfanew overlaps the DOS header', () => {
    const buffer = createPeBuffer({ peOffset: 0x20 });
    assert.throws(() => inspectPeBuffer(buffer), /e_lfanew.*DOS header/i);
  });

  await t.test('invalid PE signature', () => {
    const buffer = createPeBuffer();
    buffer.write('PX\0\0', 0x80, 'binary');
    assert.throws(() => inspectPeBuffer(buffer), /PE signature/i);
  });

  await t.test('optional header size below required version fields', () => {
    const buffer = createPeBuffer({ optionalHeaderSize: 43 });
    assert.throws(() => inspectPeBuffer(buffer), /optional header.*at least 44 bytes/i);
  });

  await t.test('optional header bytes truncated by the file boundary', () => {
    const buffer = createPeBuffer().subarray(0, 0x80 + 24 + 43);
    assert.throws(() => inspectPeBuffer(buffer), /optional header.*truncated/i);
  });

  await t.test('declared optional header extends beyond the file boundary', () => {
    const buffer = createPeBuffer({ optionalHeaderSize: 0xffff }).subarray(0, 0x80 + 24 + 44);
    assert.throws(() => inspectPeBuffer(buffer), /declared optional header.*truncated/i);
  });

  await t.test('unknown optional-header magic', () => {
    const buffer = createPeBuffer();
    buffer.writeUInt16LE(0x999, 0x80 + 24);
    assert.throws(() => inspectPeBuffer(buffer), /unsupported optional header magic.*0x999/i);
  });
});

test('inspectPeFile reads a valid PE and rejects a truncated declared header', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyingmouse-pe-file-'));
  const validPath = path.join(tempDir, 'valid.exe');
  const truncatedPath = path.join(tempDir, 'truncated.exe');
  try {
    fs.writeFileSync(validPath, createPeBuffer());
    fs.writeFileSync(
      truncatedPath,
      createPeBuffer({ optionalHeaderSize: 0xffff }).subarray(0, 0x80 + 24 + 44),
    );

    assert.equal(inspectPeFile(validPath).operatingSystemVersion, '5.2');
    assert.throws(() => inspectPeFile(truncatedPath), /declared optional header.*truncated/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('inspect-pe CLI emits stable JSON with an absolute path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyingmouse-pe-cli-'));
  const filePath = path.join(tempDir, 'sample.exe');
  try {
    fs.writeFileSync(filePath, createPeBuffer({ format: 'PE32+', major: 6, minor: 1 }));
    const result = spawnSync(process.execPath, [cliPath, filePath], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      path: path.resolve(filePath),
      format: 'PE32+',
      majorOperatingSystemVersion: 6,
      minorOperatingSystemVersion: 1,
      operatingSystemVersion: '6.1',
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('inspect-pe CLI rejects wrong argument counts with usage', () => {
  for (const args of [[], ['one.exe', 'two.exe']]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: node scripts[\\/]inspect-pe\.js <path-to-exe>/);
  }
});

test('inspect-pe CLI reports invalid files on stderr and exits nonzero', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyingmouse-pe-bad-'));
  const filePath = path.join(tempDir, 'bad.exe');
  try {
    fs.writeFileSync(filePath, 'not a PE file');
    const result = spawnSync(process.execPath, [cliPath, filePath], { encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to inspect PE file:/);
    assert.doesNotMatch(result.stderr, /RangeError/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
