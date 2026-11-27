function live(window) { return window && !window.isDestroyed(); }

// Start each owned view independently; one pending navigation must not prevent
// another window from receiving its already-authenticated Gateway generation.
export async function refreshGatewayWindows({ windows, previousOrigin, baseUrl, warn }) {
  await Promise.all([...windows].map(async window => {
    if (!live(window)) return;
    try {
      const current = new URL(window.webContents.getURL() || '/', previousOrigin);
      const origin = new URL(baseUrl).origin;
      if (origin === previousOrigin && current.origin === previousOrigin && current.pathname !== '/login') {
        await window.webContents.executeJavaScript("window.dispatchEvent(new Event('kcoder:servers-changed'));");
      } else {
        const route = current.origin === previousOrigin ? `${current.pathname}${current.search}${current.hash}` : '/';
        if (live(window)) await window.loadURL(new URL(route, baseUrl).href);
      }
    } catch {
      if (live(window)) warn('DESKTOP_WINDOW_REFRESH_FAILED');
    }
  }));
}

export async function restoreGatewayLoginPages({ windows, origin }) {
  const results = await Promise.allSettled([...windows].map(async window => {
    if (!live(window)) return;
    const current = new URL(window.webContents.getURL() || 'about:blank');
    if (current.origin !== origin || current.pathname !== '/login') return;
    let target = new URL('/', origin);
    try {
      const candidate = new URL(current.searchParams.get('returnTo') || '/', origin);
      if (candidate.origin === origin && candidate.pathname !== '/login') target = candidate;
    } catch {}
    try { if (live(window)) await window.loadURL(target.href); }
    catch (error) { if (live(window)) throw error; }
  }));
  if (results.some(result => result.status === 'rejected')) throw new Error('DESKTOP_LOGIN_VIEW_RECOVERY_FAILED');
}
