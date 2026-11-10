/** Shared native/Electron worker environment; never inherit credentials or target configuration. */
export function sdkWorkerEnvironment() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'HOME', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
      'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'].includes(key))),
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
}
