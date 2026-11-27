import { join, resolve } from 'node:path';
import { loadStorageContext, STORAGE_STARTUP_ENV } from './storage-paths.mjs';
import { assertStorageStartupReady } from './storage-startup.mjs';
import { resolveLegacyWindowsTarget } from './windows-legacy-target.mjs';
import { loadServers } from './server-config.js';
import { createDesktopProfileLaunchSpec } from './desktop-profile.mjs';

/** Startup configuration only; catalog publication remains in its original owner. */
export async function createServerLaunchConfiguration({ env, repoRoot, defaultBinary, home, platformConfig, storageSelection }) {
  const suppliedEnv = { ...env }, cwd = process.cwd();
  const { paths: storagePaths, context: storageContext } = storageSelection ?? await loadStorageContext({ env: suppliedEnv, cwd, home, platformConfig, consumer: 'gateway' });
  await assertStorageStartupReady({ context: storageContext, paths: storagePaths });
  env = process.platform === 'win32' ? Object.fromEntries(Object.entries(suppliedEnv)
    .filter(([, value]) => value !== undefined).map(([key, value]) => [key.toUpperCase(), value])) : suppliedEnv;
  const appServerBin = env.KCODER_STUDIO_KCODER_BIN || defaultBinary();
  const workspace = resolve(cwd, env.KCODER_STUDIO_WORKSPACE || repoRoot);
  const serversStore = env.KCODER_STUDIO_SERVERS_STORE ? resolve(cwd, env.KCODER_STUDIO_SERVERS_STORE)
    : storagePaths.selectionRevision !== null || storageContext.consumer === 'desktop'
      ? join(storagePaths.gatewayRoot, 'servers.json') : null;
  const catalogEnv = serversStore ? { ...env, KCODER_STUDIO_SERVERS_STORE: serversStore } : { ...env };
  // Preserve explicit override provenance while fixing paths before a child changes cwd.
  const childStorageEnv = { [STORAGE_STARTUP_ENV]: JSON.stringify(storageContext) };
  for (const [name, value] of [
    ['KCODER_CONFIG_DIR', env.KCODER_CONFIG_DIR && resolve(cwd, env.KCODER_CONFIG_DIR)],
    ['KCODER_HOME', env.KCODER_HOME && resolve(cwd, env.KCODER_HOME)],
    ['KCODER_CACHE_DIR', storagePaths.cacheRoot],
  ]) if (env[name]) {
    // Match the inherited spelling too: Windows spawn must not receive two conflicting aliases.
    for (const key of Object.keys(suppliedEnv)) {
      if ((process.platform === 'win32' ? key.toUpperCase() : key) === name) childStorageEnv[key] = value;
    }
  }
  const targetLaunchSpec = createDesktopProfileLaunchSpec({ env, appServerBin });
  const serverDefaults = { repoRoot, appServerBin, workspace,
    chromiumBin: env.KCODER_STUDIO_CHROMIUM_BIN,
    chromiumNoSandbox: env.KCODER_STUDIO_CHROMIUM_NO_SANDBOX === '1' };
  return {
    appServerBin, workspace, serverDefaults, serversStore,
    mock: env.KCODER_STUDIO_MOCK === '1', scenario: env.KCODER_STUDIO_SCENARIO || '',
    accountStorageRoot: storagePaths.gatewayRoot, storagePaths, storageContext,
    launchSpec(target, options) {
      const spec = targetLaunchSpec(target, options);
      return target.transport === 'local' && Object.keys(childStorageEnv).length
        ? { ...spec, env: { ...spec.env, ...childStorageEnv } } : spec;
    },
    async loadCatalog() {
      const catalog = await loadServers({ env: catalogEnv, ...serverDefaults });
      const servers = await Promise.all(catalog.map(target => resolveLegacyWindowsTarget(target, catalogEnv, appServerBin)));
      return { servers, serversById: new Map(servers.map(server => [server.id, server])) };
    },
  };
}
