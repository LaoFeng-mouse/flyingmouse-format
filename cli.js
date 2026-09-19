#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { saveConvertedResult } = require("./save-converted-result");

const VALUE_OPTIONS = new Map([
  ["--to", "to"],
  ["--output", "output"],
  ["--output-dir", "outputDir"],
  ["--video-codec", "videoCodec"],
  ["--pdf-action", "pdfAction"],
  ["--password", "password"]
]);

const HELP = `FlyingMouse Format CLI

Usage:
  flyingmouse-format capabilities [--json]
  flyingmouse-format targets <file-or-extension> [--json]
  flyingmouse-format convert <files...> --to <format> [options]
  flyingmouse-format images-to-pdf <images...> [--output <file>] [--json]
  flyingmouse-format merge-pdfs <pdfs...> [--output <file>] [--json]

Options:
  --output <file>             Single-result output path
  --output-dir <directory>    Output directory for one or more results
  --video-codec <h264|h265|av1>
  --pdf-action <encrypt|decrypt>
  --password <password>       PDF password (never printed in JSON output)
  --json                      Stable machine-readable output
  -h, --help                  Show this help

Packaged app:
  macOS: "FlyingMouse Format.app/Contents/MacOS/FlyingMouse Format" --cli ...
  Windows: "FlyingMouse Format.exe" --cli ...

License: Non-Commercial — personal use only. Commercial resale or rebranding is prohibited.
`;

function parseCliArgs(argv) {
  const args = [...argv];
  const first = args.shift();
  const command = !first || first === "--help" || first === "-h" ? "help" : first;
  const files = [];
  const options = { json: false, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (VALUE_OPTIONS.has(arg)) {
      const value = args[index + 1];
      if (value == null || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      options[VALUE_OPTIONS.get(arg)] = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      files.push(arg);
    }
  }

  return { command, files, options };
}

function uniqueDestination(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const parsed = path.parse(filePath);
  let counter = 1;
  let candidate;
  do {
    candidate = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
    counter += 1;
  } while (fs.existsSync(candidate));
  return candidate;
}

function resolveOutputDestinations(results, options = {}) {
  if (options.output && results.length !== 1) {
    throw new Error("--output can only be used for one result; use --output-dir for multiple files.");
  }
  if (options.output && options.outputDir) throw new Error("Use either --output or --output-dir, not both.");
  if (options.output) return [path.resolve(options.output)];
  const directory = path.resolve(options.outputDir || process.cwd());
  const reserved = new Set();
  return results.map((result) => {
    const initial = path.join(directory, path.basename(result.fileName));
    let destination = uniqueDestination(initial);
    if (reserved.has(destination)) {
      const parsed = path.parse(destination);
      let counter = 1;
      do {
        destination = uniqueDestination(path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`));
        counter += 1;
      } while (reserved.has(destination));
    }
    reserved.add(destination);
    return destination;
  });
}

function sanitizeJsonError(error, options = {}) {
  const password = String(options.password || "");
  let message = String(error?.message || error || "Unknown error");
  if (password) message = message.split(password).join("[redacted]");
  return {
    ok: false,
    error: message,
    errorCode: error?.errorCode || "CLI_FAILED"
  };
}

function requestJson(url, requestOptions = {}, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: requestOptions.method || "GET",
      headers: requestOptions.headers || {}
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          payload = { error: Buffer.concat(chunks).toString("utf8") || `HTTP ${response.statusCode}` };
        }
        if ((response.statusCode || 500) >= 400) {
          const error = new Error(payload.messages?.zhCN || payload.error || `HTTP ${response.statusCode}`);
          error.errorCode = payload.errorCode;
          error.payload = payload;
          reject(error);
          return;
        }
        resolve(payload);
      });
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function writeRequestChunk(request, chunk) {
  if (request.write(chunk)) return;
  await new Promise((resolve) => request.once("drain", resolve));
}

async function postMultipart(url, fields, files, fieldName) {
  const boundary = `----flyingmouse-${randomUUID()}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`));
  }
  const fileParts = [];
  for (const filePath of files) {
    const absolute = path.resolve(filePath);
    const stat = await fsp.stat(absolute);
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
    const safeName = path.basename(absolute).replace(/["\r\n]/g, "_");
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    fileParts.push({ absolute, header, size: stat.size });
  }
  const closing = Buffer.from(`--${boundary}--\r\n`);
  const contentLength = parts.reduce((sum, item) => sum + item.length, 0)
    + fileParts.reduce((sum, item) => sum + item.header.length + item.size + 2, 0)
    + closing.length;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": contentLength
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { payload = { error: Buffer.concat(chunks).toString("utf8") }; }
        if ((response.statusCode || 500) >= 400) {
          const error = new Error(payload.messages?.zhCN || payload.error || `HTTP ${response.statusCode}`);
          error.errorCode = payload.errorCode;
          error.payload = payload;
          reject(error);
        } else resolve(payload);
      });
    });
    request.on("error", reject);
    (async () => {
      try {
        for (const part of parts) await writeRequestChunk(request, part);
        for (const item of fileParts) {
          await writeRequestChunk(request, item.header);
          for await (const chunk of fs.createReadStream(item.absolute)) await writeRequestChunk(request, chunk);
          await writeRequestChunk(request, Buffer.from("\r\n"));
        }
        request.end(closing);
      } catch (error) {
        request.destroy(error);
      }
    })();
  });
}

function extensionFromInput(value) {
  const base = path.basename(String(value || ""));
  const ext = path.extname(base).replace(/^\./, "");
  return ext || base.replace(/^\./, "");
}

function printResult(payload, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (Array.isArray(payload.outputs)) {
    for (const output of payload.outputs) process.stdout.write(`${output.path}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
}

let cliActive = false;

async function createCliWorkspace() {
  // An explicit runtime override is a caller-owned parent, never a cleanup target.
  const parent = path.resolve(process.env.FLYINGMOUSE_RUNTIME_DIR || os.tmpdir());
  await fsp.mkdir(parent, { recursive: true });
  const realParent = await fsp.realpath(parent);
  const root = await fsp.mkdtemp(path.join(realParent, `flyingmouse-cli-${process.pid}-`));
  const identity = await fsp.lstat(root);
  return {
    runtimeDir: path.join(root, "runtime"),
    async dispose() {
      const current = await fsp.lstat(root).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!current) return;
      // Verify the exact owned directory before recursive deletion. A changed
      // symlink or directory identity is not ours to remove.
      if (!current.isDirectory() || current.isSymbolicLink()
        || current.dev !== identity.dev || current.ino !== identity.ino
        || path.dirname(root) !== realParent || await fsp.realpath(root) !== root) {
        throw new Error("CLI temporary workspace changed; cleanup was refused.");
      }
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  };
}

async function executeCli(parsed, runtime) {
  if (parsed.command === "help" || parsed.options.help) return { help: true };
  // config and conversion modules capture their runtime directory at load time.
  // Never reuse a GUI/shared server's already initialized runtime for CLI cleanup.
  if (cliActive || (!runtime && require.cache[require.resolve("./config")])) {
    throw new Error("Run each CLI invocation in its own process before loading the conversion server.");
  }
  cliActive = true;
  const previousRuntime = process.env.FLYINGMOUSE_RUNTIME_DIR;
  let workspace;
  let started;
  try {
    workspace = await createCliWorkspace();
    process.env.FLYINGMOUSE_RUNTIME_DIR = workspace.runtimeDir;
    const { startServer } = runtime || require("./server");
    started = await startServer(0);
    const baseUrl = started.url;
    if (parsed.command === "capabilities") {
      return await requestJson(`${baseUrl}/api/capabilities`);
    }
    if (parsed.command === "targets") {
      if (parsed.files.length !== 1) throw new Error("targets requires one file name or extension.");
      return await requestJson(`${baseUrl}/api/targets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, JSON.stringify({ extension: extensionFromInput(parsed.files[0]) }));
    }
    if (!parsed.files.length) throw new Error(`${parsed.command} requires at least one input file.`);

    let results;
    if (parsed.command === "convert") {
      if (!parsed.options.to) throw new Error("convert requires --to <format>.");
      results = [];
      for (const file of parsed.files) {
        results.push(await postMultipart(`${baseUrl}/api/convert`, {
          targetFormat: parsed.options.to,
          videoCodec: parsed.options.videoCodec,
          pdfAction: parsed.options.pdfAction,
          password: parsed.options.password
        }, [file], "file"));
      }
    } else if (parsed.command === "images-to-pdf") {
      results = [await postMultipart(`${baseUrl}/api/convert-images-to-pdf`, {}, parsed.files, "files")];
    } else if (parsed.command === "merge-pdfs") {
      results = [await postMultipart(`${baseUrl}/api/merge-pdfs`, {}, parsed.files, "files")];
    } else {
      throw new Error(`Unknown command: ${parsed.command}`);
    }

    const destinations = resolveOutputDestinations(results, parsed.options);
    const outputs = [];
    for (let index = 0; index < results.length; index += 1) {
      await fsp.mkdir(path.dirname(destinations[index]), { recursive: true });
      const resolveUrl = (value) => {
        const url = new URL(value, baseUrl);
        if (url.origin !== new URL(baseUrl).origin || url.username || url.password || !url.pathname.startsWith("/downloads/")) {
          throw new Error("Rejected conversion download URL.");
        }
        return url.href;
      };
      await saveConvertedResult(results[index], destinations[index], { resolveUrl, overwrite: false, resolveRedirect: resolveUrl });
      outputs.push({
        input: parsed.command === "convert" ? path.resolve(parsed.files[index]) : parsed.files.map((item) => path.resolve(item)),
        path: destinations[index],
        fileName: results[index].fileName,
        mimeType: results[index].mimeType,
        warnings: results[index].warnings || []
      });
    }
    return { ok: true, command: parsed.command, outputs };
  } finally {
    try {
      if (started) await new Promise((resolve) => started.server.close(resolve));
    } finally {
      try {
        await workspace?.dispose();
      } finally {
        if (previousRuntime === undefined) delete process.env.FLYINGMOUSE_RUNTIME_DIR;
        else process.env.FLYINGMOUSE_RUNTIME_DIR = previousRuntime;
        cliActive = false;
      }
    }
  }
}

async function runCli(argv = process.argv.slice(2), runtime) {
  process.env.FLYINGMOUSE_LOG_STDERR = "1";
  let parsed;
  try {
    parsed = parseCliArgs(argv);
    const result = await executeCli(parsed, runtime);
    if (result.help) process.stdout.write(HELP);
    else printResult(result, parsed.options.json);
    return 0;
  } catch (error) {
    const payload = sanitizeJsonError(error, parsed?.options || {});
    if (parsed?.options?.json) process.stderr.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`Error: ${payload.error}\nRun with --help for usage.\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((code) => { process.exitCode = code; });
}

module.exports = {
  HELP,
  parseCliArgs,
  resolveOutputDestinations,
  sanitizeJsonError,
  executeCli,
  runCli
};
