// zip-util.js — 飞鼠格式 zip 打包与读取工具（yazl/yauzl）。
// 第一、三批抽取自 server.js（零逻辑改动，纯搬移）。

const fs = require("fs");
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
  openZipEntries,
  openZipEntriesFromBuffer,
  readZipEntryToFile,
  listZipEntries
};
