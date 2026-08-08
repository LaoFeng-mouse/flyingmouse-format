const fs = require('node:fs');

const DOS_HEADER_MINIMUM_SIZE = 0x40;
const PE_SIGNATURE_SIZE = 4;
const COFF_HEADER_SIZE = 20;
const OPTIONAL_HEADER_MINIMUM_SIZE = 44;

function inspectPeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('PE input must be a Buffer');
  }
  if (buffer.length < DOS_HEADER_MINIMUM_SIZE) {
    throw new Error('PE buffer is too short to contain a DOS header');
  }
  if (buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Invalid DOS signature: expected MZ');
  }

  const peOffset = buffer.readUInt32LE(0x3c);
  if (!Number.isSafeInteger(peOffset) || peOffset < DOS_HEADER_MINIMUM_SIZE) {
    throw new Error('Invalid e_lfanew: PE header overlaps the DOS header');
  }
  if (peOffset > buffer.length - PE_SIGNATURE_SIZE) {
    throw new Error('Invalid e_lfanew: PE header offset is outside the buffer');
  }
  if (!buffer.subarray(peOffset, peOffset + PE_SIGNATURE_SIZE).equals(Buffer.from('PE\0\0', 'binary'))) {
    throw new Error('Invalid PE signature: expected PE\\0\\0');
  }

  const optionalHeaderOffset = peOffset + PE_SIGNATURE_SIZE + COFF_HEADER_SIZE;
  if (optionalHeaderOffset > buffer.length) {
    throw new Error('PE/COFF header is truncated');
  }

  const sizeOfOptionalHeader = buffer.readUInt16LE(peOffset + PE_SIGNATURE_SIZE + 16);
  if (sizeOfOptionalHeader < OPTIONAL_HEADER_MINIMUM_SIZE) {
    throw new Error('PE optional header must be at least 44 bytes');
  }
  if (optionalHeaderOffset > buffer.length - OPTIONAL_HEADER_MINIMUM_SIZE) {
    throw new Error('PE optional header is truncated');
  }
  if (sizeOfOptionalHeader > buffer.length - optionalHeaderOffset) {
    throw new Error('PE declared optional header is truncated');
  }

  const magic = buffer.readUInt16LE(optionalHeaderOffset);
  let format;
  if (magic === 0x10b) {
    format = 'PE32';
  } else if (magic === 0x20b) {
    format = 'PE32+';
  } else {
    throw new Error(`Unsupported optional header magic: 0x${magic.toString(16)}`);
  }

  const majorOperatingSystemVersion = buffer.readUInt16LE(optionalHeaderOffset + 40);
  const minorOperatingSystemVersion = buffer.readUInt16LE(optionalHeaderOffset + 42);
  return {
    format,
    majorOperatingSystemVersion,
    minorOperatingSystemVersion,
    operatingSystemVersion: `${majorOperatingSystemVersion}.${minorOperatingSystemVersion}`,
  };
}

function readExactly(fileDescriptor, length, position, label) {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const count = fs.readSync(
      fileDescriptor,
      buffer,
      bytesRead,
      length - bytesRead,
      position + bytesRead,
    );
    if (count === 0) {
      throw new Error(`PE ${label} is truncated`);
    }
    bytesRead += count;
  }
  return buffer;
}

function inspectPeFile(filePath) {
  const fileDescriptor = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fileDescriptor).size;
    if (!Number.isSafeInteger(fileSize) || fileSize < DOS_HEADER_MINIMUM_SIZE) {
      throw new Error('PE file is too short to contain a DOS header');
    }

    const dosHeader = readExactly(fileDescriptor, DOS_HEADER_MINIMUM_SIZE, 0, 'DOS header');
    if (dosHeader.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('Invalid DOS signature: expected MZ');
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (!Number.isSafeInteger(peOffset) || peOffset < DOS_HEADER_MINIMUM_SIZE) {
      throw new Error('Invalid e_lfanew: PE header overlaps the DOS header');
    }
    const peAndCoffHeaderSize = PE_SIGNATURE_SIZE + COFF_HEADER_SIZE;
    if (peOffset > fileSize - peAndCoffHeaderSize) {
      throw new Error('Invalid e_lfanew: PE/COFF header is outside the file');
    }

    const peAndCoffHeader = readExactly(
      fileDescriptor,
      peAndCoffHeaderSize,
      peOffset,
      'PE/COFF header',
    );
    if (!peAndCoffHeader.subarray(0, PE_SIGNATURE_SIZE).equals(Buffer.from('PE\0\0', 'binary'))) {
      throw new Error('Invalid PE signature: expected PE\\0\\0');
    }

    const sizeOfOptionalHeader = peAndCoffHeader.readUInt16LE(PE_SIGNATURE_SIZE + 16);
    if (sizeOfOptionalHeader < OPTIONAL_HEADER_MINIMUM_SIZE) {
      throw new Error('PE optional header must be at least 44 bytes');
    }
    const optionalHeaderOffset = peOffset + peAndCoffHeaderSize;
    if (sizeOfOptionalHeader > fileSize - optionalHeaderOffset) {
      throw new Error('PE declared optional header is truncated');
    }

    const optionalHeader = readExactly(
      fileDescriptor,
      sizeOfOptionalHeader,
      optionalHeaderOffset,
      'declared optional header',
    );
    const normalizedBuffer = Buffer.alloc(
      DOS_HEADER_MINIMUM_SIZE + peAndCoffHeaderSize + sizeOfOptionalHeader,
    );
    dosHeader.copy(normalizedBuffer);
    normalizedBuffer.writeUInt32LE(DOS_HEADER_MINIMUM_SIZE, 0x3c);
    peAndCoffHeader.copy(normalizedBuffer, DOS_HEADER_MINIMUM_SIZE);
    optionalHeader.copy(normalizedBuffer, DOS_HEADER_MINIMUM_SIZE + peAndCoffHeaderSize);
    return inspectPeBuffer(normalizedBuffer);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

module.exports = {
  inspectPeBuffer,
  inspectPeFile,
};
