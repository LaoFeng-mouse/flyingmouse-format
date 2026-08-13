const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { collectDirectoryFiles, zipDirectory, listZipEntries } = require("../zip-util");

async function buildFixtureTree(root) {
  await fsp.mkdir(path.join(root, "sub", "nested"), { recursive: true });
  await fsp.writeFile(path.join(root, "top.txt"), "top");
  await fsp.writeFile(path.join(root, "sub", "mid.txt"), "mid");
  await fsp.writeFile(path.join(root, "sub", "nested", "deep.txt"), "deep");
  await fsp.mkdir(path.join(root, "empty-dir"), { recursive: true });
}

test("collectDirectoryFiles gathers files recursively with relative archive names", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-zip-collect-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "src");
  await buildFixtureTree(root);

  const files = await collectDirectoryFiles(root);
  const names = files.map((f) => f.archiveName).sort();
  assert.deepEqual(names, ["sub/mid.txt", "sub/nested/deep.txt", "top.txt"]);
  // 空目录不产生条目
  assert.equal(names.some((n) => n.includes("empty-dir")), false);
  // 每个文件都有可读的绝对路径
  for (const file of files) {
    assert.ok(path.isAbsolute(file.inputPath));
    assert.equal(await fsp.readFile(file.inputPath, "utf8"), path.basename(file.archiveName).replace(".txt", ""));
  }
});

test("zipDirectory archives the folder and preserves the directory structure", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-zip-dir-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "src");
  await buildFixtureTree(root);
  const outZip = path.join(scratch, "out.zip");

  const count = await zipDirectory(root, outZip, 6);
  assert.equal(count, 3);

  const entries = await listZipEntries(outZip);
  const names = entries.map((e) => e.fileName).sort();
  assert.deepEqual(names, ["sub/mid.txt", "sub/nested/deep.txt", "top.txt"]);
});

test("zipDirectory rejects an empty folder", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-zip-empty-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "empty");
  await fsp.mkdir(root, { recursive: true });

  await assert.rejects(() => zipDirectory(root, path.join(scratch, "out.zip")), /空的/);
});
