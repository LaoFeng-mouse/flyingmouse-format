const fs = require("node:fs/promises");
const path = require("node:path");

async function chooseConvertedSavePath({ dialog, window, directory, fileName }) {
  const suffix = path.extname(fileName).slice(1).toLowerCase();
  const extension = /^[a-z0-9]+$/.test(suffix) ? suffix : "";
  const result = await dialog.showSaveDialog(window, {
    title: "保存转换后的文件",
    defaultPath: path.join(directory, fileName),
    buttonLabel: "保存",
    ...(extension ? { filters: [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }] } : {}),
    properties: ["showOverwriteConfirmation"]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  // Windows can return a path without the selected filter's extension.
  // Keep dotted titles and user-selected suffixes, then add the actual format.
  const filePath = extension && path.extname(result.filePath).toLowerCase() !== `.${extension}`
    ? `${result.filePath}.${extension}`
    : result.filePath;
  let existing;
  try {
    existing = await fs.lstat(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing && !existing.isFile()) {
    throw new Error("保存位置不是普通文件，请选择其他文件名。");
  }
  if (existing && filePath !== result.filePath) {
    // The native dialog could only confirm its original path, not this one.
    const confirmation = await dialog.showMessageBox(window, {
      type: "warning",
      title: "确认替换文件",
      message: "补全格式后缀后的文件已存在，要替换它吗？",
      detail: filePath,
      buttons: ["替换", "取消"],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    if (confirmation.response !== 0) return { canceled: true };
  }
  // A new destination must remain exclusive through atomic publication.
  return { canceled: false, filePath, overwrite: Boolean(existing) };
}

module.exports = { chooseConvertedSavePath };
