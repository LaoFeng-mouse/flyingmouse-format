"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const SKILL_NAME = "flyingmouse-format";

function candidateSkillRoots({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const userHome = platform === "win32" ? (env.USERPROFILE || home) : home;
  const candidates = [];
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(userHome, ".codex");
  candidates.push({ id: "codex", name: "Codex", path: path.join(codexHome, "skills") });
  candidates.push({ id: "claude", name: "Claude", path: path.join(userHome, ".claude", "skills") });
  candidates.push({ id: "agents", name: "Agents", path: path.join(userHome, ".agents", "skills") });
  return candidates;
}

async function discoverSkillRoots(options = {}) {
  const discovered = [];
  const seen = new Set();
  for (const candidate of candidateSkillRoots(options)) {
    const resolved = path.resolve(candidate.path);
    const key = options.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    const stat = await fsp.lstat(resolved).catch(() => null);
    if (stat?.isDirectory() && !stat.isSymbolicLink()) discovered.push({ ...candidate, path: resolved });
  }
  return discovered;
}

function assertSafeSkillName(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid skill name.");
}

async function assertRealDirectory(directory, label) {
  const stat = await fsp.lstat(directory).catch(() => null);
  if (stat?.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${directory}`);
  if (!stat?.isDirectory()) throw new Error(`${label} is not an existing directory: ${directory}`);
  return fsp.realpath(directory);
}

async function validateSourceTree(sourceDir) {
  const realSource = await assertRealDirectory(sourceDir, "Skill source");
  const required = ["SKILL.md", path.join("scripts", "flyingmouse-format.js")];
  for (const entry of required) {
    const stat = await fsp.stat(path.join(realSource, entry)).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Bundled skill is missing ${entry}.`);
  }
  return realSource;
}

async function copyDirectorySafe(source, destination) {
  await fsp.cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter(item) {
      const stat = fs.lstatSync(item);
      if (stat.isSymbolicLink()) throw new Error(`Skill source contains a symbolic link: ${item}`);
      return true;
    }
  });
}

async function installOne({ sourceDir, root, launcher, skillName }) {
  const realRoot = await assertRealDirectory(root.path, `${root.name} skill root`);
  const destination = path.join(realRoot, skillName);
  const temp = path.join(realRoot, `.${skillName}.install-${randomUUID()}`);
  const backup = path.join(realRoot, `.${skillName}.backup-${randomUUID()}`);
  const destinationStat = await fsp.lstat(destination).catch(() => null);
  let backupCanBeRemoved = false;
  if (destinationStat?.isSymbolicLink()) throw new Error(`Existing skill must not be a symbolic link: ${destination}`);

  try {
    await copyDirectorySafe(sourceDir, temp);
    await fsp.writeFile(path.join(temp, "launcher.json"), `${JSON.stringify({
      schemaVersion: 1,
      executable: path.resolve(launcher.executable),
      args: Array.isArray(launcher.args) ? launcher.args.map(String) : []
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

    if (destinationStat) await fsp.rename(destination, backup);
    try {
      await fsp.rename(temp, destination);
    } catch (error) {
      if (destinationStat) await fsp.rename(backup, destination).catch(() => {});
      throw error;
    }
    backupCanBeRemoved = true;
    if (destinationStat) await fsp.rm(backup, { recursive: true, force: true });
    return { id: root.id, name: root.name, path: destination, updated: Boolean(destinationStat) };
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
    if (backupCanBeRemoved) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

async function installAgentSkill({ sourceDir, roots, launcher, skillName = SKILL_NAME }) {
  assertSafeSkillName(skillName);
  const source = await validateSourceTree(sourceDir);
  if (!launcher?.executable || !path.isAbsolute(launcher.executable)) {
    throw new Error("Agent skill launcher executable must be an absolute path.");
  }
  const installed = [];
  const failed = [];
  for (const root of roots || []) {
    try {
      installed.push(await installOne({ sourceDir: source, root, launcher, skillName }));
    } catch (error) {
      failed.push({ id: root.id, name: root.name, path: root.path, error: error.message });
    }
  }
  if (!installed.length && failed.length === 1) throw new Error(failed[0].error);
  return { installed, failed };
}

module.exports = {
  SKILL_NAME,
  candidateSkillRoots,
  discoverSkillRoots,
  installAgentSkill
};
