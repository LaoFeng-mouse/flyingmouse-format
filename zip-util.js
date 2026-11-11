// zip-util.js — 飞鼠格式 zip 打包与读取工具（yazl/yauzl）。
// 第一、三批抽取自 server.js（零逻辑改动，纯搬移）。

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const yazl = require("yazl");
const yauzl = require("yauzl");
const sanitize = require("sanitize-filename");
const { pipeline } = require("stream/promises");

async function writeZipArchive(files, outputPath, level) {
  const archive = new yazl.ZipFile();
  // yazl emits source-file failures on ZipFile itself, not outputStream.
  archive.on("error", (error) => archive.outputStream.destroy(error));
  const completion = pipeline(archive.outputStream, fs.createWriteStream(outputPath));
  try {
    for (const file of files) archive.addFile(file.inputPath, file.archiveName, { compressionLevel: level });
    archive.end();
    await completion;
  } catch (error) {
    archive.outputStream.destroy(error);
    await completion.catch(() => {});
    // 调用方以最终输出路径打开该归档；失败后不得留下半成品 ZIP
    // （同一目录的既有文件与本次临时文件由调用方按各自所有权处理）。
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function zipFile(inputPath, outputPath, originalName, compressionLevel = 6) {
  await zipFiles([{ inputPath, archiveName: sanitize(originalName || "file") || "file" }], outputPath, compressionLevel);
}

async function zipFiles(files, outputPath, compressionLevel = 6) {
  const levelNum = Number(compressionLevel);
  const level = Number.isFinite(levelNum) ? Math.min(9, Math.max(0, levelNum)) : 6;
  await writeZipArchive(files.map((file) => ({
    inputPath: file.inputPath, archiveName: sanitize(file.archiveName || "file") || "file"
  })), outputPath, level);
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
  await writeZipArchive(files, outputPath, level);
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
      pipeline(stream, output).then(resolve, reject);
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
    // 条目读取出错时同样要释放文件句柄，否则损坏的 ZIP 会让 fd 泄漏到进程结束。
    zipfile.on("error", (error) => {
      try { zipfile.close(); } catch { /* 已关闭或不可关闭时保持原始错误 */ }
      reject(error);
    });
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
