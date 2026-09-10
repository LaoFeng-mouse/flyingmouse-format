// Save one conversion result and its Markdown resources as a consistent unit.
// Every asset gets downloaded before the main file is atomically replaced.
// Unique owned asset directories prevent changing resources of an older document
// if downloading, rewriting or publishing the replacement fails.
const fs = require("fs/promises");
const path = require("path");
const { downloadToFile, partialPathFor, publishDownloadedFile } = require("./save-download");

function assetName(value) {
  const name = String(value || "");
  if (!name || name === "." || name === ".." || /[\\/:\0]/.test(name)
    || path.basename(name) !== name) throw new Error("保存失败：附件名称无效。");
  return name;
}

function rewriteAssetReferences(markdown, originalFileName, assets, directoryName) {
  const base = `${path.parse(path.basename(originalFileName)).name}.assets`;
  const prefixes = [...new Set([base, encodeURI(base), encodeURIComponent(base)])];
  let rewritten = markdown;
  for (const asset of assets) {
    for (const prefix of prefixes) {
      for (const name of new Set([asset.name, encodeURI(asset.name), encodeURIComponent(asset.name)])) {
        const original = `${prefix}/${name}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Do not let image.png satisfy a missing image.png.other reference.
        rewritten = rewritten.replace(new RegExp(`${original}(?=[\\s)\\]"'<>?#]|$)`, "g"),
          `${directoryName}/${encodeURIComponent(asset.name)}`);
      }
    }
  }
  if (prefixes.some((prefix) => rewritten.includes(`${prefix}/`))) {
    throw new Error("保存失败：Markdown 引用的附件不完整，请重新转换后保存。");
  }
  return rewritten;
}

async function saveConvertedResult(result, destination, options = {}) {
  const download = options.download || downloadToFile;
  const resolveUrl = options.resolveUrl || ((url) => url);
  const mainUrl = resolveUrl(result.downloadUrl);
  const assets = Array.isArray(result.assets) ? result.assets : [];
  const isMarkdown = path.extname(String(result.fileName || "")).toLowerCase() === ".md";
  if (!assets.length && !isMarkdown) {
    await download(mainUrl, destination, options);
    return { filePath: destination, assetsDirectory: null };
  }
  if (!isMarkdown) {
    throw new Error("保存失败：只有 Markdown 产物支持外置附件。");
  }
  const names = new Set();
  const validated = assets.map((asset) => {
    const name = assetName(asset?.name);
    if (names.has(name.toLowerCase())) throw new Error("保存失败：附件名称重复。");
    names.add(name.toLowerCase());
    return { name, url: resolveUrl(asset?.url) };
  });
  const stagedMain = partialPathFor(destination);
  let assetsDirectory;
  let published = false;
  try {
    await download(mainUrl, stagedMain, options);
    if (validated.length) assetsDirectory = await fs.mkdtemp(path.join(path.dirname(destination), "fm-assets-"));
    for (const asset of validated) {
      await download(asset.url, path.join(assetsDirectory, asset.name), options);
    }
    const markdown = await fs.readFile(stagedMain, "utf8");
    const rewritten = rewriteAssetReferences(markdown, result.fileName, validated, assetsDirectory ? path.basename(assetsDirectory) : "");
    await fs.writeFile(stagedMain, rewritten, "utf8");
    await publishDownloadedFile(stagedMain, destination, options);
    published = true;
    return { filePath: destination, assetsDirectory: assetsDirectory || null };
  } finally {
    await fs.rm(stagedMain, { force: true }).catch(() => {});
    // Never touch a pre-existing asset directory or the user's destination.
    if (!published && assetsDirectory) await fs.rm(assetsDirectory, { recursive: true, force: true });
  }
}

module.exports = { saveConvertedResult, rewriteAssetReferences };
