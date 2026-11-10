import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { win32 } from 'node:path';
import { waitForStdioChildClose } from './app-server-stdio.mjs';

function ownedPath(context, value) {
  assert.ok(typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && !/[\0\r\n]/.test(value),
    'Absolute Windows fixture path required');
  const path = win32.normalize(value);
  const relative = win32.relative(context.stateDir, path);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative),
    'Windows profile paths must stay in this run state');
  // Reuse RunContext's existing ancestor/reparse checks, including for overrides.
  context.pathInState(relative);
  return path;
}

/** Prepare Known Folders without changing any account's real Windows profile. */
export async function prepareWindowsHome(context, env, {
  home = context.pathInState('home'), temporaryDirectory = context.pathInState('temp'), makeDirectory = mkdir,
} = {}) {
  home = ownedPath(context, home);
  const temporary = ownedPath(context, temporaryDirectory);
  const environment = {
    ...env, HOME: home, USERPROFILE: home,
    APPDATA: win32.join(home, 'AppData/Roaming'), LOCALAPPDATA: win32.join(home, 'AppData/Local'),
    TEMP: temporary, TMP: temporary, TMPDIR: temporary,
  };
  const directories = new Set([
    home, ...['Downloads', 'Desktop', 'Documents'].map(name => win32.join(home, name)),
    environment.APPDATA, environment.LOCALAPPDATA, environment.TEMP, environment.TMP, environment.TMPDIR,
  ]);
  for (const directory of directories) {
    ownedPath(context, directory);
    await makeDirectory(directory, { recursive: true, mode: 0o700 });
  }
  return environment;
}

/** Import non-secret fixture settings through the actual Native private writer.
 * writeStateJson's POSIX mode alone cannot provide a protected Windows file DACL. */
export async function writeWindowsProfileSettings(context, {
  cli, workspace, env, settings, label = 'windows-profile',
}) {
  assert.match(label, /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/);
  assert.ok(typeof cli === 'string' && /^[A-Za-z]:[\\/]/.test(cli) && !/[\0\r\n]/.test(cli),
    'Explicit Windows CLI required');
  const cwd = ownedPath(context, workspace);
  const profile = ownedPath(context, env.KCODER_CONFIG_DIR);
  assert.ok(settings && typeof settings === 'object' && !Array.isArray(settings), 'Settings object required');
  const input = await context.writeStateJson(`${label}-settings.json`, settings);
  const child = context.spawnOwned(`${label}-settings`, cli,
    ['config', 'import', '--file', input, '--scope', 'user'], { cwd, env });
  const result = await waitForStdioChildClose(child, 30000, 'private Windows profile import');
  assert.equal(result.code, 0, 'Native settings import must prepare the private Windows profile');
  return win32.join(profile, 'settings.json');
}
