const { execFile, spawn } = require("node:child_process");
const path = require("node:path");
const ownedTasks = require("./owned-tasks");
const MAX_BUFFER = 1024 * 1024;

// soffice.com owns a soffice.bin child. execFile's built-in timeout kills only
// the launcher on Windows, leaving native error dialogs and profiles locked.
// execFile also does not forward detached: POSIX process groups require spawn.
function defaultExecutor(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    ownedTasks.assertAccepting();
    let settled = false;
    let stopping = false;
    let timer;
    let closeSignal = null;
    const output = { stdout: [], stderr: [] };
    const lengths = { stdout: 0, stderr: 0 };
    const child = spawn(command, args, {
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    ownedTasks.trackProcess(child, { processGroup: process.platform !== "win32" });
    child.stdin?.on("error", () => {});
    child.stdin?.end();

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const captured = {
        stdout: Buffer.concat(output.stdout, lengths.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr, lengths.stderr).toString("utf8")
      };
      if (error) reject(Object.assign(error, captured, { childPid: child.pid, signal: closeSignal }));
      else resolve(captured);
    }

    function stop(error) {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      error.treeTerminated = false;
      const cleaned = (cleanupError) => {
        error.treeTerminated = !cleanupError;
        if (cleanupError) {
          error.cleanupError = cleanupError.code || cleanupError.message;
          // Never substitute a process-name kill for the invocation's own PID.
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill("SIGKILL"); } catch { /* Keep the original cleanup failure. */ }
          }
        }
        // Do not wait indefinitely for close: a descendant can retain pipes,
        // even when tree termination failed. Retain that failure in diagnostics.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(error);
      };
      if (!child.pid) return cleaned(new Error("Child process did not start"));
      if (process.platform === "win32") {
        const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
        execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 10000 }, cleaned);
      } else {
        try { process.kill(-child.pid, "SIGKILL"); cleaned(); }
        catch (cleanupError) {
          // The group may have finished between its last output and cleanup.
          cleaned(cleanupError.code === "ESRCH" ? undefined : cleanupError);
        }
      }
    }

    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", (chunk) => {
        if (settled || stopping) return;
        const remaining = MAX_BUFFER - lengths[name];
        const captured = chunk.subarray(0, remaining);
        if (captured.length) output[name].push(captured);
        lengths[name] += captured.length;
        if (chunk.length > remaining) stop(Object.assign(new RangeError(`${name} maxBuffer length exceeded`), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stream: name, maxBuffer: MAX_BUFFER
        }));
      });
      child[name].on("error", stop);
    }
    child.once("error", (error) => { if (!stopping) finish(error); });
    child.once("close", (code, signal) => {
      closeSignal = signal;
      if (stopping) return;
      finish(code === 0 ? null : Object.assign(new Error(`LibreOffice process exited with ${signal || code}`), {
        code, killed: Boolean(signal)
      }));
    });
    const timeout = options.timeout;
    if (Number.isFinite(timeout) && timeout > 0) timer = setTimeout(() => {
      stop(Object.assign(new Error("LibreOffice process exceeded its deadline"), {
        code: "ETIMEDOUT", timedOut: true
      }));
    }, timeout);
  });
}

module.exports = { defaultExecutor };
