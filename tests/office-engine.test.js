const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const { probeLibreOffice, runLibreOffice } = require("../office-engine");

function profilePathFromArgs(args) {
  const argument = args.find((item) => item.startsWith("-env:UserInstallation="));
  assert.ok(argument, "isolated UserInstallation argument is missing");
  return fileURLToPath(argument.slice("-env:UserInstallation=".length));
}

test("probe creates a writable isolated profile before executing LibreOffice", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-office-probe-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  let profilePath;
  const result = await probeLibreOffice("C:\\LibreOffice\\soffice.com", {
    runtimeDir: scratch,
    executor: async (command, args, options) => {
      assert.equal(command, "C:\\LibreOffice\\soffice.com");
      assert.ok(args.includes("--headless"));
      assert.ok(args.includes("--version"));
      assert.ok(options.timeout >= 15000, "probe timeout must tolerate slow first launch");
      profilePath = profilePathFromArgs(args);
      assert.equal((await fsp.stat(profilePath)).isDirectory(), true);
      return { stdout: "LibreOffice 26.2.1.2 620(Build:2)", stderr: "" };
    }
  });

  assert.deepEqual(result, { enabled: true, version: "26.2.1.2" });
  await assert.rejects(fsp.stat(path.dirname(profilePath)), /ENOENT/);
});

test("conversion runner adds headless safety arguments and always cleans its profile", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-office-convert-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  let profileRoot;
  const result = await runLibreOffice("soffice", ["--convert-to", "pdf", "sample.docx"], {
    runtimeDir: scratch,
    executor: async (_command, args) => {
      for (const required of ["--headless", "--nologo", "--nofirststartwizard", "--nodefault", "--nolockcheck"]) {
        assert.ok(args.includes(required), `missing ${required}`);
      }
      profileRoot = path.dirname(profilePathFromArgs(args));
      assert.deepEqual(args.slice(-3), ["--convert-to", "pdf", "sample.docx"]);
      return { stdout: "converted", stderr: "" };
    }
  });
  assert.equal(result.stdout, "converted");
  await assert.rejects(fsp.stat(profileRoot), /ENOENT/);
});

test("profile creation failures use a stable bilingual error code", async () => {
  await assert.rejects(
    probeLibreOffice("soffice", {
      runtimeDir: "X:\\unwritable",
      fs: { ...require("node:fs"), mkdirSync: () => { throw Object.assign(new Error("access denied"), { code: "EACCES" }); } }
    }),
    (error) => error.code === "OFFICE_ENGINE_PROFILE_FAILED" && Boolean(error.messages.enUS) && Boolean(error.messages.zhCN)
  );
});

test("missing executables and failed user installation are classified", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-office-errors-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  await assert.rejects(
    probeLibreOffice("missing-soffice", {
      runtimeDir: scratch,
      executor: async () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); }
    }),
    (error) => error.code === "OFFICE_ENGINE_MISSING"
  );
  await assert.rejects(
    probeLibreOffice("soffice", {
      runtimeDir: scratch,
      executor: async () => { throw Object.assign(new Error("failed"), { stderr: "User installation could not be completed." }); }
    }),
    (error) => error.code === "OFFICE_ENGINE_PROFILE_FAILED"
  );
});

test("conversion failures with profile-word noise are not misclassified as profile errors", async (t) => {
  // 回归：2026-08-14《博物志》docx→pdf 失败被误报成「无法创建独立用户配置」。
  // LibreOffice headless 的 stderr 常含 profile 字样（路径回显/platform libraries），
  // 转换真正失败时应归为 OFFICE_CONVERSION_FAILED 而非 OFFICE_ENGINE_PROFILE_FAILED。
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-office-noise-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  await assert.rejects(
    runLibreOffice("soffice", ["--convert-to", "pdf", "sample.docx"], {
      runtimeDir: scratch,
      executor: async () => {
        throw Object.assign(new Error("soffice failed"), {
          code: 77,
          stderr: "Could not find platform independent libraries <prefix>\nconvert failed: filter not available",
          stdout: ""
        });
      }
    }),
    (error) => error.code === "OFFICE_CONVERSION_FAILED" && error.details?.exitCode === 77
  );
  // 真正的 profile 创建失败短语仍归 PROFILE_FAILED
  await assert.rejects(
    runLibreOffice("soffice", ["--convert-to", "pdf", "sample.docx"], {
      runtimeDir: scratch,
      executor: async () => {
        throw Object.assign(new Error("soffice failed"), {
          stderr: "no access to the user profile (access denied)",
          stdout: ""
        });
      }
    }),
    (error) => error.code === "OFFICE_ENGINE_PROFILE_FAILED"
  );
});

test("deep Windows runtime uses an exclusive short profile and removes only its own directory", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-short-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const deep = path.join(scratch, "deep-".repeat(35));
  const fallback = path.join(scratch, "local");
  await fsp.mkdir(deep, { recursive: true });
  await fsp.mkdir(fallback);
  const sentinel = path.join(fallback, "user-file.txt");
  await fsp.writeFile(sentinel, "preserve");
  let profile;
  await probeLibreOffice("soffice", { runtimeDir: deep, profileFallbackRoot: fallback, platform: "win32",
    executor: async (_command, args) => {
      profile = profilePathFromArgs(args);
      assert.ok(profile.length <= 160, `LibreOffice profile path must reserve space for nested files: ${profile.length}`);
      assert.ok(profile.startsWith(fallback + path.sep));
      await fsp.writeFile(path.join(profile, "can-write"), "yes");
      return { stdout: "LibreOffice 26.2.1.2" };
    } });
  await assert.rejects(fsp.stat(path.dirname(profile)), /ENOENT/);
  assert.equal(await fsp.readFile(sentinel, "utf8"), "preserve");
});

for (const platform of ["win32", "darwin", "linux"]) {
  test(`explicit short native workspace request bounds deep TEMP on ${platform}`, async (t) => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-bounded-"));
    t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
    const deep = path.join(scratch, "deep-".repeat(35));
    const fallback = path.join(scratch, "short");
    await fsp.mkdir(deep, { recursive: true });
    await fsp.mkdir(fallback);
    const sentinel = path.join(fallback, "user-file.txt");
    await fsp.writeFile(sentinel, "preserve");
    let workspace;
    await probeLibreOffice("soffice", {
      runtimeDir: deep, profileFallbackRoot: fallback, platform, requireShortPaths: true,
      executor: async (_command, args) => {
        const profile = profilePathFromArgs(args);
        workspace = path.dirname(profile);
        assert.ok(profile.length <= 160, `Profile must reserve space for native files: ${profile.length}`);
        assert.ok(workspace.startsWith(fallback + path.sep));
        for (const filename of ["source.pdf", "result.docx"]) {
          const stagedPath = path.join(workspace, filename);
          assert.ok(stagedPath.length < 200);
          await fsp.writeFile(stagedPath, "owned temporary file");
        }
        return { stdout: "LibreOffice 26.2.1.2" };
      }
    });
    await assert.rejects(fsp.stat(workspace), /ENOENT/);
    assert.equal(await fsp.readFile(sentinel, "utf8"), "preserve");
    assert.deepEqual(await fsp.readdir(fallback), ["user-file.txt"]);
  });
}

test("silent native timeouts retain a stable timeout code and cleanup diagnostics", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-timeout-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  await assert.rejects(runLibreOffice("soffice", [], { runtimeDir: scratch,
    executor: async () => { throw Object.assign(new Error("deadline"), {
      code: "ETIMEDOUT", timedOut: true, treeTerminated: true, stdout: "", stderr: ""
    }); } }), error => error.code === "OFFICE_ENGINE_TIMEOUT" && error.details.treeTerminated === true);
});

test("an existing directory which rejects actual writes never launches LibreOffice", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-no-write-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  let launched = false;
  await assert.rejects(probeLibreOffice("soffice", { runtimeDir: scratch, profileFallbackRoot: scratch,
    fs: { ...require("node:fs"), writeFileSync: () => { throw Object.assign(new Error("write denied"), { code: "EACCES" }); } },
    executor: async () => { launched = true; return { stdout: "LibreOffice 26.2.1.2" }; }
  }), error => error.code === "OFFICE_ENGINE_PROFILE_FAILED" && error.details.fileCode === "EACCES");
  assert.equal(launched, false);
  assert.deepEqual(await fsp.readdir(scratch), [], "failed allocation must clean only the workspace it created");
});

test("cancellation reaches the executor and is never reclassified as an engine failure", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-cancel-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const controller = new AbortController();
  let receivedSignal;
  const running = runLibreOffice("soffice", [], { runtimeDir: scratch, signal: controller.signal,
    executor: async (_command, _args, options) => {
      receivedSignal = options.signal;
      controller.abort();
      throw Object.assign(new Error("转换已取消。"), { code: "CONVERSION_CANCELED" });
    } });
  await assert.rejects(running, (error) => error.code === "CONVERSION_CANCELED");
  assert.equal(receivedSignal, controller.signal, "the request signal must be forwarded to the executor");
});

test("the real executor terminates its child when the request is canceled", async () => {
  const { defaultExecutor } = require("../office-process");
  const controller = new AbortController();
  const started = Date.now();
  const running = defaultExecutor(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    signal: controller.signal, timeout: 60000
  });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(running, (error) => error.code === "CONVERSION_CANCELED");
  assert.ok(Date.now() - started < 20000, "cancellation must not wait for the process deadline");
});
