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
    executor: async (command, args) => {
      assert.equal(command, "C:\\LibreOffice\\soffice.com");
      assert.ok(args.includes("--headless"));
      assert.ok(args.includes("--version"));
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
      mkdir: async () => { throw Object.assign(new Error("access denied"), { code: "EACCES" }); }
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
