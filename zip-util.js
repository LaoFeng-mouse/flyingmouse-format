// zip-util.js — 飞鼠格式 zip 打包与读取工具（yazl/yauzl）。
// 第一、三批抽取自 server.js（零逻辑改动，纯搬移）。

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const yazl = require("yazl");
const yauzl = require("yauzl");
const sanitize = require("sanitize-filename");

async function zipFile(inputPath, outputPath, originalName, compressionLevel = 6) {
  await zipFiles([{ inputPath, archiveName: sanitize(originalName || "file") || "file" }], outputPath, compressionLevel);
}

async function zipFiles(files, outputPath, compressionLevel = 6) {
  const levelNum = Number(compressionLevel);
  const level = Number.isFinite(levelNum) ? Math.min(9, Math.max(0, levelNum)) : 6;
  await new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    const output = fs.createWriteStream(outputPath);
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
    archive.outputStream.pipe(output);
    for (const file of files) {
      archive.addFile(file.inputPath, sanitize(file.archiveName || "file") || "file", { compressionLevel: level });
    }
    archive.end();
  });
}

// 递归收集目录下所有文件，返回 [{ inputPath, archiveName }]。
// archiveName 用相对路径（正斜杠）保留目录结构；空目录不产生条目。
async function collectDirectoryFiles(dirPath, baseDir = dirPath) {
  const result = [];
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relative = path.relative(baseDir, fullPath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      result.push(...await collectDirectoryFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      result.push({ inputPath: fullPath, archiveName: relative });
    }
    // 跳过符号链接/其它类型，避免循环与越界。
  }
  return result;
}

// 把一个文件夹递归打包成 zip（保留目录结构，文件名为相对路径，不做 sanitize
// 以免破坏子目录路径——用户选的是自己本机目录，文件名无需净化）。
async function zipDirectory(dirPath, outputPath, compressionLevel = 6) {
  const files = await collectDirectoryFiles(dirPath);
  if (!files.length) {
    throw new Error("这个文件夹是空的，没有可压缩的文件。");
  }
  const levelNum = Number(compressionLevel);
  const level = Number.isFinite(levelNum) ? Math.min(9, Math.max(0, levelNum)) : 6;
  await new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    const output = fs.createWriteStream(outputPath);
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
    archive.outputStream.pipe(output);
    for (const file of files) {
      archive.addFile(file.inputPath, file.archiveName, { compressionLevel: level });
    }
    archive.end();
  });
  return files.length;
}

function openZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipfile) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(zipfile);
    });
  });
}

// yauzl.open 走 fd_slicer（createFromFd），对某些合法 deflate 流会读流挂起
// （实测：一个 30 页 docx 的 word/document.xml 读到 49KB 就停，永不 end/error，
//  而 Node zlib 与 yauzl.fromBuffer 都能完整解压出 332643 字节）。
// 对需要可靠读取内容的小包（DOCX 校验），改用 fromBuffer 路径绕开该 bug。
function openZipEntriesFromBuffer(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipfile) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(zipfile);
    });
  });
}

function readZipEntryToFile(zipfile, entry, outputPath) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const output = fs.createWriteStream(outputPath);
      stream.pipe(output);
      output.on("close", resolve);
      output.on("error", reject);
    });
  });
}

async function listZipEntries(zipPath) {
  const zipfile = await openZipEntries(zipPath);
  return new Promise((resolve, reject) => {
    const entries = [];
    zipfile.on("entry", (entry) => {
      if (!/\/$/.test(entry.fileName)) entries.push(entry);
      zipfile.readEntry();
    });
    zipfile.on("end", () => {
      zipfile.close();
      resolve(entries);
    });
    zipfile.on("error", reject);
    zipfile.readEntry();
  });
}

module.exports = {
  zipFile,
  zipFiles,
  collectDirectoryFiles,
  zipDirectory,
  openZipEntries,
  openZipEntriesFromBuffer,
  readZipEntryToFile,
  listZipEntries
};
