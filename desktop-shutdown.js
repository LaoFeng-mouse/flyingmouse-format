const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PENDING_CLEANUP_FILE = '.shutdown-cleanup.json';

async function captureRuntimeIdentity({ runtimeDir, temporaryRoot = os.tmpdir(), pid = process.pid } = {}) {
  if (!runtimeDir) return;
  const expected = path.resolve(temporaryRoot, `flyingmouse-format-runtime-${pid}`);
  if (!Number.isSafeInteger(pid) || pid <= 0 || path.resolve(runtimeDir) !== expected) {
    throw new Error('Refused cleanup outside this desktop process runtime');
  }
  await fs.mkdir(expected, { recursive: true });
  const stat = await fs.lstat(expected);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refused linked desktop runtime');
  return { runtimeDir: expected, pid, identity: stat, realPath: await fs.realpath(expected) };
}

async function assertRuntimeIdentity({ runtimeDir, identity, realPath }) {
  const current = await fs.lstat(runtimeDir).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!current) return false;
  if (!identity || !current.isDirectory() || current.isSymbolicLink()
    || current.dev !== identity.dev || current.ino !== identity.ino
    || await fs.realpath(runtimeDir) !== realPath) throw new Error('Desktop runtime changed; cleanup was refused');
  return true;
}

async function cleanupOwnedRuntime(owner) {
  if (!owner || !await assertRuntimeIdentity(owner)) return;
  const { runtimeDir, pid, identity } = owner;
  // A deadline may stop removal halfway through. A later launch can reclaim
  // only this explicitly marked PID directory, after its process has exited.
  await fs.writeFile(path.join(runtimeDir, PENDING_CLEANUP_FILE),
    JSON.stringify({ schema: 1, pid, dev: identity.dev, ino: identity.ino }), { flag: 'wx' });
  await removeMarkedRuntime(owner);
}

async function removeMarkedRuntime(owner) {
  const { runtimeDir } = owner;
  // Keep the receipt until every large child has gone. Recursive rm(root) can
  // delete the receipt first and then be interrupted, losing restart cleanup.
  for (const name of await fs.readdir(runtimeDir)) {
    if (name === PENDING_CLEANUP_FILE) continue;
    if (!await assertRuntimeIdentity(owner)) return;
    await fs.rm(path.join(runtimeDir, name), { recursive: true, force: true });
  }
  if (await assertRuntimeIdentity(owner)) {
    await fs.unlink(path.join(runtimeDir, PENDING_CLEANUP_FILE));
    await fs.rmdir(runtimeDir);
  }
}

function createDesktopShutdown({ app, stopTasks, closeServer, closeWindows = () => {}, cleanup,
  log = () => {}, deadlineMs = 5000, cleanupMs = 1500, exitCode = 0, releaseLock = true } = {}) {
  let state = 'running';
  let pending;
  function beforeQuit(event) {
    if (state === 'exited') return;
    event?.preventDefault();
    if (state !== 'running') return;
    state = 'stopping';
    const started = Date.now();
    let deadline;
    const finish = reason => {
      if (state === 'exited') return;
      state = 'exited';
      clearTimeout(deadline);
      log(`Desktop shutdown complete (${reason})`);
      app.exit(exitCode);
    };
    // Release immediately: a click during cleanup must start a fresh instance,
    // not be swallowed by an invisible old window holding the instance lock.
    if (releaseLock) app.releaseSingleInstanceLock?.();
    deadline = setTimeout(() => finish('deadline; remaining cleanup deferred'), deadlineMs);
    // Set the cancellation barrier synchronously, before closing connections
    // can cause a queued conversion to enter another execution stage.
    let tasks;
    try { tasks = stopTasks(); } catch (error) { tasks = Promise.reject(error); }
    try { closeServer(); } catch (error) { log('Closing local server failed', error); }
    try { closeWindows(); } catch (error) { log('Closing desktop windows failed', error); }
    pending = Promise.resolve(tasks).then(results => {
      for (const result of results || []) if (result.status === 'rejected') throw result.reason;
      if (state !== 'exited') {
        clearTimeout(deadline);
        deadline = setTimeout(() => finish('cleanup deadline; remaining cleanup deferred'),
          Math.max(0, Math.min(cleanupMs, deadlineMs - (Date.now() - started))));
        return cleanup();
      }
    }).catch(error => log('Desktop cleanup deferred', error)).finally(() => finish('settled'));
  }
  return { beforeQuit, isStopping: () => state !== 'running', completion: () => pending };
}

module.exports = { createDesktopShutdown, captureRuntimeIdentity, assertRuntimeIdentity, cleanupOwnedRuntime, removeMarkedRuntime, PENDING_CLEANUP_FILE };
