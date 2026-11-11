"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function assetKey(platform, arch) {
  return `${platform}-${arch}`;
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) return false;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split("/").some((part) => part === "" || part === "." || part === "..");
}

function validatePartDefinition(key, part, index) {
  const label = `${key}[${index}]`;
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    throw new Error(`Engine asset ${label} must be an object.`);
  }
  if (typeof part.assetName !== "string" || !/^[A-Za-z0-9._-]+\.tar\.zst$/.test(part.assetName)) {
    throw new Error(`Engine asset ${label} has an invalid asset name.`);
  }
  if (!Array.isArray(part.requiredFiles) || part.requiredFiles.length === 0) {
    throw new Error(`Engine asset ${label} must list required files.`);
  }
  for (const requiredFile of part.requiredFiles) {
    if (!isSafeRelativePath(requiredFile)) {
      throw new Error(`Engine asset ${label} contains an unsafe required file: ${requiredFile}`);
    }
  }
  // 分卷本身不带 available：可用性由外层条目统一声明。这里只要求哈希确已固定，
  // 未固定的分卷必须显式写成 available:false + sha256:null。
  if (part.sha256 === null) {
    if (part.available !== false) throw new Error(`Engine asset ${label} must declare availability for an unpinned part.`);
    return part;
  }
  if (typeof part.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(part.sha256)) {
    throw new Error(`Engine asset ${label} must contain a valid SHA-256.`);
  }
  return part;
}

// win32-x64 的引擎超过 GitHub 单资产上限，manifest 用 parts 声明多个分卷；
// darwin-* 仍是单资产。两种形状都要走同一套名称/路径/SHA 校验，否则
// --platform win32 会在 selectEngineAsset 里直接报“invalid asset name”。
function validateAssetDefinition(key, asset) {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    throw new Error(`Engine asset ${key} must be an object.`);
  }
  if (Array.isArray(asset.parts)) {
    if (asset.parts.length === 0) throw new Error(`Engine asset ${key} must declare at least one part.`);
    const parts = asset.parts.map((part, index) => validatePartDefinition(key, part, index));
    const names = new Set();
    for (const part of parts) {
      if (names.has(part.assetName)) throw new Error(`Engine asset ${key} declares a duplicate part: ${part.assetName}`);
      names.add(part.assetName);
    }
    return { ...asset, parts, requiredFiles: parts.flatMap((part) => part.requiredFiles) };
  }
  if (typeof asset.assetName !== "string" || !/^[A-Za-z0-9._-]+\.tar\.zst$/.test(asset.assetName)) {
    throw new Error(`Engine asset ${key} has an invalid asset name.`);
  }
  if (!Array.isArray(asset.requiredFiles) || asset.requiredFiles.length === 0) {
    throw new Error(`Engine asset ${key} must list required files.`);
  }
  for (const requiredFile of asset.requiredFiles) {
    if (!isSafeRelativePath(requiredFile)) {
      throw new Error(`Engine asset ${key} contains an unsafe required file: ${requiredFile}`);
    }
  }
  if (asset.available === false && asset.sha256 === null) return asset;
  if (asset.available !== true) {
    throw new Error(`Engine asset ${key} must explicitly declare availability.`);
  }
  if (typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
    throw new Error(`Engine asset ${key} must contain a valid SHA-256.`);
  }
  return asset;
}

function assetExpectedHashes(asset) {
  return Array.isArray(asset?.parts)
    ? asset.parts.map((part) => ({ name: part.assetName, sha256: part.sha256 }))
    : [{ name: asset?.assetName, sha256: asset?.sha256 }];
}

function selectEngineAsset(manifest, platform, arch) {
  const key = assetKey(platform, arch);
  const asset = manifest?.assets?.[key];
  if (!asset) throw new Error(`No engine asset is declared for ${key}.`);
  if (asset.available !== true) {
    throw new Error(`Engine asset is not yet pinned for ${key}; refusing to build with an invented SHA-256.`);
  }
  return validateAssetDefinition(key, asset);
}

function assertContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new Error(`${label} resolves outside the engine root.`);
}

function validateEngineDirectory(rootPath, asset) {
  const root = fs.realpathSync.native(rootPath);
  for (const requiredFile of asset.requiredFiles) {
    if (!isSafeRelativePath(requiredFile)) throw new Error(`Unsafe required file: ${requiredFile}`);
    const candidate = path.join(root, ...requiredFile.replaceAll("\\", "/").split("/"));
    assertContained(root, path.resolve(candidate), requiredFile);
    const stats = fs.lstatSync(candidate);
    if (stats.isSymbolicLink()) throw new Error(`Required file must not be a symbolic link: ${requiredFile}`);
    if (!stats.isFile()) throw new Error(`Required engine file is not a regular file: ${requiredFile}`);
    assertContained(root, fs.realpathSync.native(candidate), requiredFile);
  }
}

const MACHO_CPU_TYPES = {
  x64: 0x01000007,
  arm64: 0x0100000c
};

function readMachOArchitectures(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 8) throw new Error(`Engine executable is not a valid Mach-O file: ${filePath}`);
  const architectures = new Set();
  const addCpu = (cpuType) => {
    for (const [arch, expected] of Object.entries(MACHO_CPU_TYPES)) {
      if ((cpuType >>> 0) === expected) architectures.add(arch);
    }
  };
  const magicLE = bytes.readUInt32LE(0);
  const magicBE = bytes.readUInt32BE(0);
  if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
    addCpu(bytes.readUInt32LE(4));
  } else if (magicBE === 0xfeedfacf || magicBE === 0xfeedface) {
    addCpu(bytes.readUInt32BE(4));
  } else {
    let littleEndian;
    let entrySize;
    if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
      littleEndian = false;
      entrySize = magicBE === 0xcafebabf ? 32 : 20;
    } else if (magicLE === 0xcafebabe || magicLE === 0xcafebabf) {
      littleEndian = true;
      entrySize = magicLE === 0xcafebabf ? 32 : 20;
    } else {
      throw new Error(`Engine executable is not a valid Mach-O file: ${filePath}`);
    }
    const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
    const count = read32.call(bytes, 4);
    if (count < 1 || count > 32 || bytes.length < 8 + count * entrySize) {
      throw new Error(`Engine executable has an invalid universal Mach-O header: ${filePath}`);
    }
    for (let index = 0; index < count; index += 1) addCpu(read32.call(bytes, 8 + index * entrySize));
  }
  if (architectures.size === 0) throw new Error(`Engine executable has no supported Mach-O architecture: ${filePath}`);
  return architectures;
}

function validateMachOArchitecture(filePath, arch) {
  if (!Object.hasOwn(MACHO_CPU_TYPES, arch)) throw new Error(`Unsupported Mach-O architecture: ${arch}`);
  const architectures = readMachOArchitectures(filePath);
  if (!architectures.has(arch)) {
    throw new Error(`Engine executable does not contain ${arch}: ${filePath}`);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--") || argv[index + 1] === undefined) throw new Error(`Invalid argument: ${name || "<missing>"}`);
    options[name.slice(2)] = argv[index + 1];
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.platform || !options.arch || !options.root) {
    throw new Error("Usage: validate-ci-engines.js --platform <platform> --arch <arch> --root <directory> [--bundle <archive>]");
  }
  const manifest = require(path.join(__dirname, "..", "ci-engines-v1.json"));
  const key = assetKey(options.platform, options.arch);
  const asset = options.prepare === "true"
    ? validateAssetDefinition(key, manifest?.assets?.[key])
    : selectEngineAsset(manifest, options.platform, options.arch);
  if (options.bundle) {
    if (asset.available !== true) throw new Error(`Cannot verify an archive hash for unpinned ${key}.`);
    const expected = assetExpectedHashes(asset);
    if (expected.length === 1) {
      const actualHash = sha256File(options.bundle);
      if (actualHash !== expected[0].sha256) {
        throw new Error(`Engine bundle SHA-256 mismatch. Expected ${expected[0].sha256}, got ${actualHash}.`);
      }
    } else {
      // 多分卷：把 --bundle 当作包含各分卷的目录，逐个比对声明的 SHA-256。
      const stats = fs.statSync(options.bundle, { throwIfNoEntry: false });
      if (!stats?.isDirectory()) {
        throw new Error(`Multi-volume engines require --bundle to be a directory containing ${expected.length} archives.`);
      }
      for (const part of expected) {
        const candidate = path.join(options.bundle, part.name);
        if (!fs.existsSync(candidate)) throw new Error(`Engine bundle is missing ${part.name}.`);
        const actualHash = sha256File(candidate);
        if (actualHash !== part.sha256) {
          throw new Error(`Engine bundle SHA-256 mismatch for ${part.name}. Expected ${part.sha256}, got ${actualHash}.`);
        }
      }
    }
  }
  validateEngineDirectory(options.root, asset);
  if (options.platform === "darwin") {
    for (const requiredFile of asset.requiredFiles.filter((value) => /(?:ffmpeg|pdftoppm|\/soffice)$/.test(value))) {
      validateMachOArchitecture(path.join(options.root, ...requiredFile.split("/")), options.arch);
    }
  }
  process.stdout.write(`Validated ${assetKey(options.platform, options.arch)} engine files.\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  assetKey,
  isSafeRelativePath,
  main,
  selectEngineAsset,
  sha256File,
  validateAssetDefinition,
  validateEngineDirectory,
  validateMachOArchitecture
};
