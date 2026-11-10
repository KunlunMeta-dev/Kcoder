(() => {
  const config = __KCODER_VERIFY_CONFIG__;
  if (window !== window.top || location.origin !== config.origin) return;
  const report = (kind, value) => {
    fetch(`${config.controlUrl}/diagnostic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ kind, value }),
    }).catch(() => {});
  };
  const nativeIsolation = Promise.resolve([
    typeof window.require === 'undefined',
    typeof window.process === 'undefined',
  ]);
  nativeIsolation.then(value => report('native-isolation', value));
  Object.defineProperty(window, '__KCODER_AI_VERIFY__', {
    value: Object.freeze({ ...config, nativeIsolation }), writable: false, configurable: false,
  });
  window.addEventListener('error', event => report('error', String(event.message)));
  window.addEventListener('unhandledrejection', event => report('rejection', String(event.reason)));
  window.addEventListener('load', () => report('load', {
    automationInstalled: Boolean(window.__KCODER_STUDIO_E2E__), readyState: document.readyState,
  }));
})();
