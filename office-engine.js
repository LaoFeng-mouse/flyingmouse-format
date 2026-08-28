const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const MESSAGES = {
  OFFICE_ENGINE_MISSING: {
    zhCN: "缺少 LibreOffice 文档转换引擎，请重新安装完整版本的 Mahiro Format。",
    enUS: "The LibreOffice document engine is missing. Reinstall the complete Mahiro Format package."
  },
  OFFICE_ENGINE_INCOMPATIBLE: {
    zhCN: "当前 LibreOffice 引擎与系统不兼容，请安装适用于此系统的 Mahiro Format 版本。",
    enUS: "The bundled LibreOffice engine is incompatible with this system. Install the matching Mahiro Format build."
  },
  OFFICE_ENGINE_PROFILE_FAILED: {
    zhCN: "LibreOffice 无法创建独立用户配置，请检查临时目录权限或安全软件拦截。",
    enUS: "LibreOffice could not create its isolated user profile. Check temporary-folder permissions or security software."
  },
  OFFICE_ENGINE_START_FAILED: {
    zhCN: "LibreOffice 文档引擎启动失败，请导出诊断报告后重试。",
    enUS: "The LibreOffice document engine failed to start. Export diagnostics and try again."
  },
  OFFICE_CONVERSION_FAILED: {
    zhCN: "LibreOffice 未能完成文档转换，文件可能损坏或目标格式不受支持。",
    enUS: "LibreOffice could not complete the conversion. The file may be damaged or the target format unsupported."
  }
};

class OfficeEngineError extends Error {
  constructor(code, details = {}) {
    const messages = MESSAGES[code] || MESSAGES.OFFICE_ENGINE_START_FAILED;
    super(messages.zhCN);
    this.name = "OfficeEngineError";
    this.code = code;
    this.messages = messages;
    this.details = details;
  }
}

function defaultExecutor(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeout }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function classifyExecutionError(error, operation) {
  if (error instanceof OfficeEngineError) return error;
  const detail = `${error?.stderr || ""}\n${error?.stdout || ""}\n${error?.message || ""}`;
  let code = operation === "convert" ? "OFFICE_CONVERSION_FAILED" : "OFFICE_ENGINE_START_FAILED";
  if (error?.code === "ENOENT") code = "OFFICE_ENGINE_MISSING";
  // 注意：不能只匹配单词 "profile"——LibreOffice headless 启动的 stderr 常常
  // 包含 "profile"（如 -env:UserInstallation 的路径回显、Could not find platform
  // independent libraries 等），转换真正失败时会被误判成 PROFILE_FAILED
  // （2026-08-14《博物志》docx→pdf 实锤：roundtrip 失败报的是「无法创建独立
  // 用户配置」，实际是转换失败）。必须匹配明确的配置创建失败短语。
  else if (/user installation (could not|cannot|failed to) (be completed|be created|be initiali[sz]ed)|unable to (create|initiali[sz]e) (the )?user profile|cannot (create|initiali[sz]e) (the )?user profile|no access to the user profile|access rights? to (the )?profile|access (is )?denied|permission denied/i.test(detail)) code = "OFFICE_ENGINE_PROFILE_FAILED";
  else if (/not a valid win32|incompatible|unsupported operating system|requires windows/i.test(detail)) code = "OFFICE_ENGINE_INCOMPATIBLE";
  return new OfficeEngineError(code, {
    exitCode: typeof error?.code === "number" ? error.code : null,
    signal: error?.signal || null
  });
}

async function executeWithProfile(command, commandArgs, options = {}) {
  const runtimeDir = options.runtimeDir;
  if (!runtimeDir) throw new TypeError("runtimeDir is required.");
  const mkdir = options.mkdir || fsp.mkdir;
  const rm = options.rm || fsp.rm;
  const executor = options.executor || defaultExecutor;
  const id = options.randomUUID ? options.randomUUID() : crypto.randomUUID();
  const profileRoot = path.join(runtimeDir, `office-${id}`);
  const profileDir = path.join(profileRoot, "profile");
  try {
    try {
      await mkdir(profileDir, { recursive: true });
    } catch (error) {
      throw new OfficeEngineError("OFFICE_ENGINE_PROFILE_FAILED", { fileCode: error?.code || null });
    }
    const args = [
      "--headless",
      "--nologo",
      "--nofirststartwizard",
      "--nodefault",
      "--nolockcheck",
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      ...commandArgs
    ];
    try {
      return await executor(command, args, { timeout: options.timeout });
    } catch (error) {
      throw classifyExecutionError(error, options.operation);
    }
  } finally {
    await rm(profileRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function probeLibreOffice(command, options = {}) {
  const result = await executeWithProfile(command, ["--version"], {
    ...options,
    operation: "probe",
    timeout: options.timeout || 20000
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = /LibreOffice\s+([0-9]+(?:\.[0-9]+)+)/i.exec(output);
  if (!match) throw new OfficeEngineError("OFFICE_ENGINE_START_FAILED");
  return { enabled: true, version: match[1] };
}

function runLibreOffice(command, commandArgs, options = {}) {
  return executeWithProfile(command, commandArgs, {
    ...options,
    operation: "convert",
    timeout: options.timeout || 1000 * 60 * 10
  });
}

module.exports = { OfficeEngineError, probeLibreOffice, runLibreOffice };
