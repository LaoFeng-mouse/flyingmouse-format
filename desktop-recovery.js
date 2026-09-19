// Recovery lives in the main process so it remains usable when no renderer
// document (or preload bridge) can run. It never widens the renderer IPC origin.
function createDesktopRecovery({ window, url, dialog, shell, log, logPath, timeoutMs = 30000 }) {
  const contents = window.webContents;
  let disposed = false;
  let ready = false;
  let failure = null;
  let generation = 0;
  let timer;
  let promptOpen = false;
  let readyBeforeUnresponsive = false;
  let rendererUnresponsive = false;
  let restartingRenderer = false;
  const listeners = [];
  const alive = () => !disposed && !window.isDestroyed();
  function clearDeadline() { clearTimeout(timer); timer = undefined; }
  function armDeadline() {
    clearDeadline();
    timer = setTimeout(() => fail('renderer-ready-timeout'), timeoutMs);
    timer.unref?.();
  }
  function listen(target, event, handler) {
    target.on(event, handler);
    listeners.push([target, event, handler]);
  }

  function stopUnresponsiveRenderer() {
    // A navigation cannot interrupt JavaScript that no longer yields. Only
    // replace that renderer after the user chooses Retry for the current
    // failure; an interface that recovered while the prompt was open is kept.
    if (!alive()) return Promise.resolve(false);
    if (contents.getOSProcessId?.() === 0) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      let deadline;
      function finish(stopped) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        contents.removeListener('render-process-gone', onGone);
        window.removeListener('closed', onClosed);
        restartingRenderer = false;
        resolve(stopped);
      }
      const onGone = () => finish(true);
      const onClosed = () => finish(false);
      contents.once('render-process-gone', onGone);
      window.once('closed', onClosed);
      restartingRenderer = true;
      deadline = setTimeout(() => {
        log('Unresponsive renderer did not exit before its restart deadline');
        finish(false);
      }, 5000);
      deadline.unref?.();
      try {
        log('Stopping unresponsive renderer after user requested retry');
        contents.forcefullyCrashRenderer();
      } catch (error) {
        log('Stopping unresponsive renderer failed', error);
        finish(false);
      }
    });
  }

  async function prompt() {
    if (promptOpen || !failure || !alive()) return;
    promptOpen = true;
    const observedFailure = failure;
    let retry = false;
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'error', title: 'FlyingMouse Format',
        message: '界面暂时无法使用 / The app interface is unavailable',
        detail: `可以重试打开界面。正在进行的转换可能需要重新选择文件。\nRetry to reopen the interface; an active conversion may need to be selected again.\n\n${failure.reason}\n\n日志 / Log: ${logPath}`,
        buttons: ['重试 / Retry', '查看日志 / Open log', '关闭 / Close'],
        defaultId: 0, cancelId: 2, noLink: true
      });
      // A slow startup can finish while the native prompt is open. Do not erase
      // recovered work in response to an obsolete error.
      if (!alive() || failure !== observedFailure) { /* obsolete response */ }
      else if (result.response === 0) retry = true;
      else if (result.response === 1) {
        const error = await shell.openPath(logPath);
        if (error) log(`Opening desktop log failed: ${error}`);
      } else window.close();
    } catch (error) {
      log('Desktop recovery prompt failed', error);
      if (alive()) dialog.showErrorBox?.('FlyingMouse Format', `界面启动失败 / Interface startup failed\n${observedFailure.reason}\n${logPath}`);
      return;
    } finally { promptOpen = false; }
    if (retry && alive()) {
      // Preserve the first diagnostic reason, but use the renderer's current
      // condition: a startup timeout/navigation error may precede the hang.
      if (rendererUnresponsive) {
        if (!await stopUnresponsiveRenderer() || !alive()) {
          if (alive() && failure) void prompt();
          return;
        }
      }
      await start();
    }
    else if (alive() && failure) void prompt();
  }

  function fail(reason) {
    if (!alive()) return;
    ready = false;
    clearDeadline();
    if (failure) { log(`Additional desktop failure: ${reason}`); return; }
    failure = { reason };
    log(`Desktop interface unavailable: ${reason}`);
    void prompt();
  }

  async function start() {
    if (!alive()) return;
    const attempt = ++generation;
    ready = false;
    rendererUnresponsive = false;
    failure = null;
    clearDeadline();
    armDeadline();
    try {
      // The application serves only its own loopback origin. Set an app-local
      // direct session explicitly, including when a system/PAC proxy overrides
      // Chromium's implicit loopback bypass. This does not change Windows proxy.
      await contents.session.setProxy({ mode: 'direct' });
      await contents.session.closeAllConnections();
      if (!alive() || attempt !== generation || failure) return;
      await window.loadURL(url);
    } catch (error) {
      if (alive() && attempt === generation) fail(`navigation: ${error.message || error}`);
    }
  }

  listen(contents, 'did-finish-load', () => log('Desktop document loaded; awaiting interface readiness'));
  listen(contents, 'did-start-navigation', (_event, navigationUrl, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    try { if (new URL(navigationUrl).origin !== new URL(url).origin) return; } catch { return; }
    ready = false;
    failure = null;
    armDeadline();
  });
  listen(contents, 'did-fail-load', (_event, code, description, _validatedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) fail(`navigation ${code}: ${description}`);
  });
  listen(contents, 'render-process-gone', (_event, details) => {
    rendererUnresponsive = false;
    // This is the completion signal for an explicit retry, not another crash.
    if (!restartingRenderer) fail(`renderer ${details.reason}; exitCode=${details.exitCode}`);
  });
  listen(contents, 'preload-error', (_event, _preloadPath, error) => fail(`preload: ${error.message || error}`));
  listen(window, 'unresponsive', () => {
    if (!rendererUnresponsive) readyBeforeUnresponsive = ready;
    rendererUnresponsive = true;
    fail('renderer-unresponsive');
  });
  listen(window, 'responsive', () => {
    if (restartingRenderer) return;
    rendererUnresponsive = false;
    if (readyBeforeUnresponsive && failure?.reason === 'renderer-unresponsive') {
      ready = true;
      failure = null;
      log('Desktop interface responsive again');
    }
    readyBeforeUnresponsive = false;
  });
  listen(window, 'closed', () => {
    disposed = true;
    clearDeadline();
    for (const [target, event, handler] of listeners) target.removeListener(event, handler);
  });
  return {
    start,
    isReady: () => ready,
    markReady() {
      if (!alive()) return;
      ready = true;
      rendererUnresponsive = false;
      failure = null;
      clearDeadline();
      log('Desktop interface ready');
    }
  };
}

module.exports = { createDesktopRecovery };
