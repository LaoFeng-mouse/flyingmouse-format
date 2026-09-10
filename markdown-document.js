// Parse Markdown once into Pandoc's document tree. Code and mathematics are never
// rewritten with a global regular expression. Pandoc is shipped as an offline tool.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const READER = "markdown+mark+tex_math_dollars+tex_math_single_backslash+tex_math_double_backslash-smart";

function markdownError(code, zhCN, enUS, cause) {
  return Object.assign(new Error(zhCN), { code, messages: { zhCN, enUS }, ...(cause ? { cause } : {}) });
}

function pandocPath() {
  if (process.env.FLYINGMOUSE_PANDOC_PATH) return process.env.FLYINGMOUSE_PANDOC_PATH;
  const executable = process.platform === "win32" ? "pandoc.exe" : "pandoc";
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, "pandoc", executable),
    path.join(__dirname, "bin", "pandoc", executable)
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function runPandoc(executable, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = [], stderr = [], outputBytes = 0, errorBytes = 0, settled = false;
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], cwd: options.cwd });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(markdownError("MARKDOWN_ENGINE_TIMEOUT", "Markdown 转换超时，请拆分文档后重试。", "Markdown conversion timed out. Split the document and retry.")), options.timeoutMs || 120000);
    child.on("error", (error) => fail(markdownError("MARKDOWN_ENGINE_MISSING", "Markdown 文档引擎不可用，请修复安装后重试。", "The Markdown document engine is unavailable. Repair the installation and retry.", error)));
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024 * 1024) return fail(markdownError("MARKDOWN_DOCUMENT_TOO_LARGE", "Markdown 文档结构超过安全处理上限。", "The Markdown document tree exceeds the processing limit."));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      // Keep diagnostics bounded while continuing to drain verbose child output.
      if (errorBytes < 256 * 1024) stderr.push(chunk.subarray(0, 256 * 1024 - errorBytes));
      errorBytes += chunk.length;
    });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") fail(error); });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) return reject(markdownError("MARKDOWN_CONVERSION_FAILED", `Markdown 转换失败${diagnostic ? `：${diagnostic}` : "。"}`, `Markdown conversion failed${diagnostic ? `: ${diagnostic}` : "."}`));
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: diagnostic });
    });
    child.stdin.end(input);
  });
}

function addWarning(warnings, code, zhCN, enUS) {
  if (!warnings.some((warning) => warning.code === code && warning.messages.zhCN === zhCN)) warnings.push({ code, messages: { zhCN, enUS } });
}

function safeLink(value) {
  return /^(?:https?:|mailto:)/i.test(value) || (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith("//") && !/[\u0000-\u001f\\]/.test(value));
}

async function prepareDocument(tree, resourceDir, sourceDir, warnings) {
  const root = sourceDir ? await fsp.realpath(sourceDir) : null;
  let imageIndex = 0;
  async function visit(value) {
    if (Array.isArray(value)) {
      const result = [];
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (item?.t === "RawInline" && item.c[0] === "html" && /^<u\s*>$/i.test(item.c[1])) {
          const end = value.findIndex((next, index) => index > i && next?.t === "RawInline" && /^<\/u\s*>$/i.test(next.c[1]));
          if (end !== -1) {
            result.push({ t: "Underline", c: await visit(value.slice(i + 1, end)) });
            i = end;
            continue;
          }
        }
        result.push(await visit(item));
      }
      return result;
    }
    if (!value || typeof value !== "object") return value;
    if (value.t === "Image") {
      const [attributes, alt, [url, title]] = value.c;
      const fallback = async (code, message) => {
        addWarning(warnings, code, message, `Image could not be embedded: ${url}. Its description is preserved.`);
        return { t: "Span", c: [["", [], []], await visit(alt.length ? alt : [{ t: "Str", c: `[${url}]` }])] };
      };
      if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z\d+/=\s]+$/i.test(url)) return value;
      if (!root || /^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(url)) return fallback("MARKDOWN_IMAGE_UNAVAILABLE", `图片未嵌入（仅支持随文档提供的本地图片）：${url}`);
      try {
        const decoded = decodeURIComponent(url.split("#")[0]);
        const candidate = await fsp.realpath(path.resolve(root, decoded));
        const relative = path.relative(root, candidate);
        if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("outside source directory");
        if (!/\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i.test(candidate)) throw new Error("unsupported image type");
        const destination = `image-${++imageIndex}${path.extname(candidate).toLowerCase()}`;
        await fsp.copyFile(candidate, path.join(resourceDir, destination));
        return { t: "Image", c: [attributes, await visit(alt), [destination, title]] };
      } catch {
        return fallback("MARKDOWN_IMAGE_UNAVAILABLE", `图片缺失或无法读取，已保留图片说明：${url}`);
      }
    }
    if (value.t === "Link" && !safeLink(value.c[2][0])) {
      addWarning(warnings, "MARKDOWN_LINK_REMOVED", "已移除不安全的链接地址，保留链接文字。", "An unsafe link address was removed; its text is preserved.");
      return { t: "Span", c: [["", [], []], await visit(value.c[1])] };
    }
    if (value.t === "RawInline" || value.t === "RawBlock") {
      if (value.c[0] === "html" && /^<br\s*\/?\s*>$/i.test(value.c[1])) return { t: "LineBreak" };
      addWarning(warnings, "MARKDOWN_RAW_CONTENT_LITERAL", "部分原始 HTML/TeX 未转换，已按原文保留；支持的公式和下划线不受影响。", "Some raw HTML/TeX was preserved as literal text; supported mathematics and underline are unaffected.");
      return value.t === "RawBlock" ? { t: "CodeBlock", c: [["", [], []], value.c[1]] } : { t: "Str", c: value.c[1] };
    }
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = await visit(child);
    return result;
  }
  // Preserve ordinary document metadata, but do not honor document-supplied
  // template directives, include files, bibliography engines or filters.
  const metadata = {};
  const allowedMetadata = new Set(["title", "subtitle", "author", "date", "lang", "abstract", "keywords"]);
  for (const [key, value] of Object.entries(tree.meta || {})) {
    if (allowedMetadata.has(key)) metadata[key] = await visit(value);
    else addWarning(warnings, "MARKDOWN_METADATA_UNSUPPORTED", `未应用此文档元数据字段：${key}`, `This document metadata field was not applied: ${key}`);
  }
  return { ...tree, meta: metadata, blocks: await visit(tree.blocks) };
}

async function convertMarkdownDocument(raw, outputPath, options = {}) {
  const executable = pandocPath();
  if (!executable || !fs.existsSync(executable)) throw markdownError("MARKDOWN_ENGINE_MISSING", "Markdown 转 Word 需要内置 Pandoc 引擎；当前安装缺少引擎，请修复安装。", "Markdown to Word requires the bundled Pandoc engine. Repair this installation to restore it.");
  const warnings = [];
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-markdown-"));
  try {
    const parsed = await runPandoc(executable, ["--from", READER, "--to", "json"], String(raw), { cwd: workDir });
    const tree = await prepareDocument(JSON.parse(parsed.stdout), workDir, options.sourceDir, warnings);
    const rendered = await runPandoc(executable, ["--from", "json", "--to", "docx", "--resource-path", workDir, "--output", path.resolve(outputPath)], JSON.stringify(tree), { cwd: workDir });
    for (const diagnostic of [parsed.stderr, rendered.stderr].filter(Boolean)) addWarning(warnings, "MARKDOWN_RENDER_WARNING", `Markdown 引擎提示：${diagnostic}`, `Markdown engine warning: ${diagnostic}`);
    const stat = await fsp.stat(outputPath);
    if (stat.size < 100) throw markdownError("MARKDOWN_OUTPUT_INVALID", "Markdown 引擎未生成有效的 Word 文档。", "The Markdown engine did not produce a valid Word document.");
    return { warnings };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { convertMarkdownDocument, pandocPath };
