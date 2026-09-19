"use strict";

// Build-time only. Apply the same electron-builder selection to a newly copied
// Store layout, including -SkipBuild inputs made before this filter existed.
const fs = require("node:fs");
const path = require("node:path");
const { FileMatcher } = require("app-builder-lib/out/fileMatcher");

function createQpdfFilter(root) {
  const resource = require("../package.json").build.win.extraResources.find(item => item.to === "qpdf");
  if (!Array.isArray(resource?.filter)) throw new Error("Missing qpdf distribution filter");
  return new FileMatcher(root, root, value => value, resource.filter).createFilter();
}

function trimQpdfDistribution(directory) {
  const root = path.resolve(directory);
  if (path.basename(root) !== "qpdf" || path.basename(path.dirname(root)) !== "resources") {
    throw new Error("Expected a qpdf directory inside the new layout resources");
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Expected a real qpdf directory");
  const filter = createQpdfFilter(root), files = [];
  function walk(parent) {
    for (const name of fs.readdirSync(parent)) {
      const file = path.resolve(parent, name), relative = path.relative(root, file);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Unsafe qpdf staging path");
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("qpdf staging must not contain symlinks or junctions");
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files.push({ file, relative, size: stat.size, retained: filter(file, stat) });
      else throw new Error("Unexpected qpdf staging entry");
    }
  }
  walk(root);
  for (const required of ["bin/qpdf.exe", "share/doc/qpdf/manual-html/license.html", "share/doc/qpdf/manual-html/_sources/license.rst.txt"]) {
    if (!files.some(item => item.relative.split(path.sep).join("/") === required && item.retained && item.size > 0)) {
      throw new Error(`Missing retained qpdf executable/license: ${required}`);
    }
  }
  const removed = files.filter(item => !item.retained);
  for (const item of removed) fs.unlinkSync(item.file);
  return { removedFiles: removed.length, removedBytes: removed.reduce((sum, item) => sum + item.size, 0) };
}

if (require.main === module) {
  try { console.log(JSON.stringify(trimQpdfDistribution(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { createQpdfFilter, trimQpdfDistribution };
