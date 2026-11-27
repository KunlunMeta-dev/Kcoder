import { lstat, mkdir } from 'node:fs/promises';
import { join, parse, relative, sep } from 'node:path';
import { loadStorageContext, STORAGE_STARTUP_ENV } from '../src/storage-paths.mjs';
import { assertStorageStartupReady } from '../src/storage-startup.mjs';
import { acquireStorageInstance } from '../src/storage-lease.mjs';
import { loadStorageBusinessContext, prepareStorageBusinessStartup } from '../src/migrations/storage-startup.mjs';
import { assertDesktopProfilePath } from './storage-browser-cache.mjs';

async function directory(path, anchor = parse(path).root) {
  let current = anchor;
  const remaining = relative(anchor, path);
  if (remaining === '..' || remaining.startsWith(`..${sep}`)) throw new Error('STORAGE_PATH_INVALID');
  const existing = await lstat(anchor);
  if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('STORAGE_TARGET_NOT_DIRECTORY');
  for (const name of remaining.split(sep).filter(Boolean)) {
    current = join(current, name);
    let entry = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!entry) {
      await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
      entry = await lstat(current);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('STORAGE_TARGET_NOT_DIRECTORY');
  }
}

/** Await from the main entry before ready, sessions, single-instance lock or Gateway. */
export async function configureDesktopStorage({ app, env = process.env, acquireLease = acquireStorageInstance,
  createStartupClient, prepareInitialSelection } = {}) {
  const loadOptions = { env, home: app.getPath('home'),
    platformConfig: app.getPath('appData'), consumer: 'desktop' };
  let selected = createStartupClient
    ? await loadStorageBusinessContext({ loadOptions, createClient: createStartupClient })
    : await loadStorageContext(loadOptions);
  if (prepareInitialSelection && await prepareInitialSelection(selected)) selected = await loadStorageContext(loadOptions);
  if (createStartupClient) selected = await prepareStorageBusinessStartup({ selected, loadOptions,
    createClient: createStartupClient });
  assertDesktopProfilePath(selected.paths.desktopRoot);
  await assertStorageStartupReady(selected);
  const lease = await acquireLease(selected);
  try {
  const { paths, context } = selected;
  const browserCache = paths.selectionRevision !== null || paths.sources.cacheRoot === 'cacheOverride'
    ? join(paths.cacheRoot, 'browser-cache', 'desktop') : null;
  // A blocked cache must fail before creating an empty persistent profile or changing Electron paths.
  if (browserCache) await directory(browserCache);
  await directory(paths.desktopRoot, paths.sources.desktopRoot === 'selection' ? paths.dataRoot : undefined);
  app.setPath('userData', paths.desktopRoot);
  // Session data includes cookies/IndexedDB and remains in persistent storage.
  app.setPath('sessionData', paths.desktopRoot);
  const childEnv = { ...env, [STORAGE_STARTUP_ENV]: JSON.stringify(context) };
  for (const name of Object.keys(childEnv)) {
    const canonical = process.platform === 'win32' ? name.toUpperCase() : name;
    if (context.overrides[canonical]) childEnv[name] = context.overrides[canonical];
  }
  lease.verify();
  return { ...selected, env: childEnv, browserCacheRoot: browserCache, lease };
  } catch (error) { lease.close(); throw error; }
}
