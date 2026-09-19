const path = require('node:path');
const { execFile } = require('node:child_process');
const { cancellationError, beginApplicationShutdown } = require('./conversion-cancellation');

function terminateOwnedProcess(child, { directOnly = false, processGroup = false } = {}) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  // Wait for close, not merely successful delivery of the kill request, before
  // deleting files that the native converter may still have open.
  let closed;
  const completion = new Promise(resolve => { closed = resolve; child.once('close', closed); });
  if (process.platform !== 'win32' || directOnly) {
    try {
      if (processGroup && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
      return completion;
    } catch (error) {
      child.removeListener('close', closed);
      return error.code === 'ESRCH' ? Promise.resolve() : Promise.reject(error);
    }
  }
  return new Promise((resolve, reject) => {
    // Only a still-running ChildProcess created and registered by this app is
    // accepted. Never kill by image name or enumerate unrelated processes.
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }, error => {
        if (!error || child.exitCode !== null || child.signalCode !== null) resolve(completion);
        else { child.removeListener('close', closed); reject(error); }
      });
  });
}

function createOwnedTaskRegistry({ onStop = () => {} } = {}) {
  const tasks = new Set();
  let stopping = false;
  let pending;
  function assertAccepting() { if (stopping) throw cancellationError(); }
  function track(cancel) {
    let cancellation;
    const stop = () => cancellation || (cancellation = Promise.resolve().then(cancel));
    tasks.add(stop);
    if (stopping) void stop().catch(() => {});
    return () => tasks.delete(stop);
  }
  function trackProcess(child, options) {
    const remove = track(() => terminateOwnedProcess(child, options));
    child.once('close', remove);
    return remove;
  }
  function trackWorker(worker) {
    const remove = track(() => worker.terminate());
    worker.once('exit', remove);
    return remove;
  }
  function trackPendingWorker(promise) {
    const terminate = worker => (worker.worker || worker).terminate();
    const remove = track(async () => {
      const worker = await promise.catch(() => null);
      if (worker) await terminate(worker);
    });
    promise.then(worker => (worker.worker || worker).once('exit', remove), remove).catch(remove);
    return promise;
  }
  function stopAll() {
    if (pending) return pending;
    stopping = true;
    onStop();
    pending = (async () => {
      const seen = new Set(), results = [];
      for (;;) {
        const batch = [...tasks].filter(stop => !seen.has(stop));
        for (const stop of batch) seen.add(stop);
        results.push(...await Promise.allSettled(batch.map(stop => stop())));
        // Capture registrations that arrive while an earlier cancellation is
        // settling. Executors also reject new work at their spawn boundary.
        await new Promise(resolve => setImmediate(resolve));
        if (![...tasks].some(stop => !seen.has(stop))) return results;
      }
    })();
    return pending;
  }
  return { assertAccepting, track, trackProcess, trackWorker, trackPendingWorker, stopAll,
    isStopping: () => stopping, size: () => tasks.size };
}

module.exports = { ...createOwnedTaskRegistry({ onStop: beginApplicationShutdown }),
  createOwnedTaskRegistry, terminateOwnedProcess };
