const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  discoverSkillRoots,
  installAgentSkill
} = require("../agent-skill-installer");

test("discovers only existing Agent skill roots on macOS and Windows", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "flyingmouse-roots-"));
  await fs.mkdir(path.join(home, ".codex", "skills"), { recursive: true });
  await fs.mkdir(path.join(home, ".agents", "skills"), { recursive: true });
  const roots = await discoverSkillRoots({ home, platform: "darwin", env: {} });
  assert.deepEqual(roots.map((item) => item.id), ["codex", "agents"]);

  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "flyingmouse-win-roots-"));
  await fs.mkdir(path.join(profile, ".claude", "skills"), { recursive: true });
  const windowsRoots = await discoverSkillRoots({
    home: profile,
    platform: "win32",
    env: { USERPROFILE: profile }
  });
  assert.deepEqual(windowsRoots.map((item) => item.id), ["claude"]);
});

test("installs the bundled skill atomically with a platform launcher config", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "flyingmouse-skill-install-"));
  const source = path.join(temp, "source");
  const root = path.join(temp, "skills");
  await fs.mkdir(path.join(source, "scripts"), { recursive: true });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: flyingmouse-format\ndescription: test\n---\n");
  await fs.writeFile(path.join(source, "scripts", "flyingmouse-format.js"), "// test\n");

  const launcherExecutable = process.execPath;
  const result = await installAgentSkill({
    sourceDir: source,
    roots: [{ id: "codex", name: "Codex", path: root }],
    launcher: { executable: launcherExecutable, args: [] }
  });

  assert.equal(result.installed.length, 1);
  const installed = path.join(root, "flyingmouse-format");
  const config = JSON.parse(await fs.readFile(path.join(installed, "launcher.json"), "utf8"));
  assert.equal(config.executable, path.resolve(launcherExecutable));
  assert.equal(await fs.readFile(path.join(installed, "scripts", "flyingmouse-format.js"), "utf8"), "// test\n");
});

test("rejects a symlink skill root", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "flyingmouse-skill-link-"));
  const actual = path.join(temp, "actual");
  const linked = path.join(temp, "linked");
  const source = path.join(temp, "source");
  await fs.mkdir(actual);
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), "test");
  await fs.mkdir(path.join(source, "scripts"));
  await fs.writeFile(path.join(source, "scripts", "flyingmouse-format.js"), "test");
  await fs.symlink(actual, linked, "dir");
  await assert.rejects(() => installAgentSkill({
    sourceDir: source,
    roots: [{ id: "test", name: "Test", path: linked }],
    launcher: { executable: process.execPath, args: [] }
  }), /symbolic link/i);
});

test("installs nested skill files from a read-only virtual source (asar 场景回归)", async () => {
  // 回归：2026-08-14 接入 Agent 失败根因是 copyDirectorySafe 用 fsp.cp 复制
  // asar 内源，Electron 的 asar 补丁不覆盖 fs.cp，抛 ENOENT。修复后改为
  // readdir + readFile/writeFile 逐文件复制。此测试用只读权限源模拟 asar 的
  // 虚拟文件系统（无法写入/无法 cp 的源），验证逐文件复制仍能完整落盘。
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "flyingmouse-skill-readonly-"));
  const source = path.join(temp, "source");
  const root = path.join(temp, "skills");
  await fs.mkdir(path.join(source, "scripts"), { recursive: true });
  await fs.mkdir(path.join(source, "agents"), { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: flyingmouse-format\n---\n");
  await fs.writeFile(path.join(source, "scripts", "flyingmouse-format.js"), "// wrapper\n");
  await fs.writeFile(path.join(source, "agents", "openai.yaml"), "interface: {}\n");
  await fs.mkdir(root, { recursive: true });

  // 模拟 asar 只读：把源目录变成只读，验证复制不依赖对源的写权限
  if (process.platform !== "win32") {
    await fs.chmod(source, 0o555);
  }

  const result = await installAgentSkill({
    sourceDir: source,
    roots: [{ id: "codex", name: "Codex", path: root }],
    launcher: { executable: process.execPath, args: [] }
  });

  assert.equal(result.installed.length, 1);
  const installed = path.join(root, "flyingmouse-format");
  const entries = (await fs.readdir(installed, { recursive: true })).sort();
  assert.deepEqual(entries, ["SKILL.md", "agents", "agents\\openai.yaml", "launcher.json", "scripts", "scripts\\flyingmouse-format.js"].sort());
  assert.equal(await fs.readFile(path.join(installed, "agents", "openai.yaml"), "utf8"), "interface: {}\n");
});
