import { isTrustedGatewayUrl } from './security-policy.mjs';

const paintProbe = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))';

/** Probe only owned visible views; recovery never replays a backend operation. */
export function createWindowResponsiveness({ dialog, powerMonitor, getGatewayOrigin,
  isQuitting = () => false, locale = 'zh-CN', timeoutMs = 10_000, focusAwayMs = 30_000,
  warn = () => {} }) {
  const windows = new Map();
  let disposed = false, prompting = false;
  const trusted = (window, entry) => !disposed && !isQuitting() && windows.get(window) === entry &&
    !window.isDestroyed() && !window.webContents.isDestroyed() &&
    isTrustedGatewayUrl(window.webContents.getURL(), getGatewayOrigin());
  const visible = window => window.isVisible() && !window.isMinimized();
  async function probe(window) {
    const entry = windows.get(window);
    if (!entry || !entry.ready || !trusted(window, entry) || !visible(window)) return 'skipped';
    if (entry.pending) return entry.pending;
    const generation = entry.generation, origin = getGatewayOrigin();
    const controller = new AbortController();
    entry.cancel = () => controller.abort();
    const current = () => !controller.signal.aborted && trusted(window, entry) &&
      generation === entry.generation && origin === getGatewayOrigin() && visible(window);
    let painted = false;
    const operation = async () => {
      if (!current()) return 'stale';
      const responsive = entry.crashed ? false : await new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', abort); resolve(value);
        };
        const abort = () => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);
        controller.signal.addEventListener('abort', abort, { once: true });
        try {
          Promise.resolve(window.webContents.executeJavaScript(paintProbe)).then(() => {
            painted = true; finish(true);
          }, () => finish(false));
        } catch { finish(false); }
      });
      if (!current()) return 'stale';
      entry.unhealthy = !responsive;
      if (responsive) return 'responsive';
      // Native dialogs remain usable when the renderer's JS thread is frozen.
      // Background windows must not compete for focus or open multiple prompts.
      if (prompting || !window.isFocused()) return 'deferred';
      prompting = true;
      try {
        const english = locale.toLowerCase().startsWith('en');
        const result = await dialog.showMessageBox(window, {
          type: 'warning', defaultId: 0, cancelId: 0,
          buttons: english ? ['Keep waiting', 'Reload window'] : ['继续等待', '重新加载窗口'],
          message: english ? 'KCoder Studio is not responding' : 'KCoder Studio 页面未响应',
          detail: english
            ? 'Reloading may discard unsent drafts in this window. Backend tasks will not be resent.'
            : '重新加载可能丢失此窗口尚未发送的草稿。后台任务不会被重新发送。',
        });
        if (!current()) return 'stale';
        if (painted) { entry.unhealthy = false; return 'responsive'; }
        if (result.response !== 1) return 'waiting';
        window.webContents.reload();
        return 'reload-requested';
      } finally { prompting = false; }
    };
    // Publish before invoking Electron: a synchronous event cannot start a second probe.
    const pending = Promise.resolve().then(operation).catch(() => { warn('DESKTOP_RESPONSIVENESS_CHECK_FAILED'); return 'failed'; });
    entry.pending = pending;
    try { return await pending; }
    finally { if (entry.pending === pending) { entry.pending = null; entry.cancel = null; } }
  }
  function attach(window) {
    if (!window || disposed || windows.has(window) || window.isDestroyed()) return window;
    const entry = { ready: isTrustedGatewayUrl(window.webContents.getURL(), getGatewayOrigin()) && !window.webContents.isLoadingMainFrame(), generation: 0, pending: null, cancel: null, awayAt: null, unhealthy: false, crashed: false };
    windows.set(window, entry);
    const navigate = (_event, _url, inPlace, mainFrame) => {
      if (mainFrame === false || inPlace) return;
      entry.generation++; entry.ready = false; entry.cancel?.();
    };
    const loaded = () => { entry.ready = true; entry.crashed = false; entry.unhealthy = false; };
    const blur = () => { entry.awayAt = Date.now(); };
    const focus = () => {
      const away = entry.awayAt; entry.awayAt = null;
      if (entry.unhealthy || away !== null && Date.now() - away >= focusAwayMs) void probe(window);
    };
    const crashed = () => {
      entry.ready = true; entry.crashed = true;
      // Let Electron finish tearing down the old renderer before a recovery can reload it.
      setImmediate(() => { void probe(window); });
    };
    const unresponsive = () => { void probe(window); };
    const detach = () => {
      entry.generation++; entry.cancel?.(); windows.delete(window);
      window.removeListener('blur', blur); window.removeListener('focus', focus);
      window.removeListener('unresponsive', unresponsive); window.removeListener('closed', detach);
      window.webContents.removeListener('did-start-navigation', navigate);
      window.webContents.removeListener('did-finish-load', loaded);
      window.webContents.removeListener('render-process-gone', crashed);
    };
    entry.detach = detach;
    window.on('blur', blur); window.on('focus', focus); window.on('unresponsive', unresponsive); window.once('closed', detach);
    window.webContents.on('did-start-navigation', navigate); window.webContents.on('did-finish-load', loaded);
    window.webContents.on('render-process-gone', crashed);
    return window;
  }
  const resume = () => { for (const window of windows.keys()) void probe(window); };
  powerMonitor.on('resume', resume);
  return { attach, probe, dispose() {
    disposed = true; powerMonitor.removeListener('resume', resume);
    for (const entry of [...windows.values()]) entry.detach();
  } };
}
