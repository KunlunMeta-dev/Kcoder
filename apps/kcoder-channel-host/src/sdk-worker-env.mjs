/** Shared native/Electron worker environment; never inherit credentials or target configuration. */
const allowed = new Set(['PATH', 'HOME', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']);
const windowsAllowed = new Set([...allowed].map(key => key.toUpperCase()));
export function sdkWorkerEnvironment(environment = process.env, platform = process.platform) {
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) =>
    platform === 'win32' ? windowsAllowed.has(key.toUpperCase()) : allowed.has(key))),
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
}
