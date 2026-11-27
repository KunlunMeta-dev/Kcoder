import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopProfileLaunchSpec } from './desktop-profile.mjs';
import { launchSpec, normalizeServer, storedServer } from './server-config.js';

const defaults = { repoRoot: '/owned', appServerBin: '/owned/kcoder', workspace: '/owned/work' };
const env = { KCODER_STUDIO_DESKTOP_HOST: '1', KCODER_STUDIO_DESKTOP_PROFILE: 'owned-default' };
test('only the owned unset built-in local launch receives a default; every stored projection remains unchanged', () => {
  const makeSpec = createDesktopProfileLaunchSpec({ env, appServerBin: defaults.appServerBin });
  for (const patch of [{}, { profile: 'explicit' }, { settingsFile: '/owned/original.jsonc' },
    { id: 'renamed' }, { command: '/owned/custom-kcoder' }, { transport: 'ssh', host: 'owned.invalid' },
    { transport: 'ssh', host: 'owned.invalid', security: { identity: { mode: 'kcoder-account' } } }]) {
    const target = normalizeServer({ id: 'local', label: 'Owned', transport: 'local', ...patch }, defaults);
    const original = structuredClone(target), projection = storedServer(target);
    const spec = makeSpec(target), baseline = launchSpec(target);
    if (Object.keys(patch).length === 0) assert.deepEqual(spec.args, ['--profile', 'owned-default', 'app-server']);
    else assert.deepEqual(spec, baseline);
    assert.deepEqual(target, original); assert.deepEqual(storedServer(target), projection);
  }
});
test('the profile default requires the Desktop gate and a valid explicit local CLI', () => {
  assert.equal(createDesktopProfileLaunchSpec({ env: { KCODER_STUDIO_DESKTOP_PROFILE: 'ignored' } }), launchSpec);
  assert.equal(createDesktopProfileLaunchSpec({ env: {} }), launchSpec);
  for (const profile of ['unsafe;profile', 'a'.repeat(65)]) assert.throws(() => createDesktopProfileLaunchSpec({ env: { ...env, KCODER_STUDIO_DESKTOP_PROFILE: profile }, appServerBin: defaults.appServerBin }), /DESKTOP_PROFILE_INVALID/);
  assert.throws(() => createDesktopProfileLaunchSpec({ env, appServerBin: 'kcoder' }), /LOCAL_CLI_REQUIRED/);
});
test('Windows command normalization preserves the requested workspace and explicit target profile', () => {
  const appServerBin = 'D:\\Owned CLI\\kcoder.exe', workspace = 'D:\\Workspace';
  const makeSpec = createDesktopProfileLaunchSpec({ env, appServerBin, platform: 'win32' });
  const target = normalizeServer({ id: 'local', label: 'Owned', transport: 'local', command: 'd:\\OWNED CLI\\kcoder.exe' }, { ...defaults, platform: 'win32', appServerBin, workspace });
  assert.deepEqual(makeSpec(target, { workspacePath: 'D:\\Other workspace' }).args, ['--profile', 'owned-default', '--cwd', 'D:\\Other workspace', 'app-server']);
  assert.deepEqual(makeSpec({ ...target, profile: 'chosen' }).args, ['--profile', 'chosen', 'app-server']);
});
