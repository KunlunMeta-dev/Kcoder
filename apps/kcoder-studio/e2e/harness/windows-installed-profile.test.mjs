import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOwnedInstalledProfile } from './windows-installed-profile.mjs';

const root = String.raw`C:\ProgramData\kcoder-installer-owned\installed-ui-profile`;
const requested = `${root}\\profile`;
const user = String.raw`C:\Users\kc_e2e_1234abcd`;
const identity = { sid: 'S-1-5-21-1-2-3-1001', userProfile: user };
const defaults = { requested, fixtureRoot: root, fixtureUsername: 'kc_e2e_1234abcd',
  readIdentity: async () => identity, readSelection: async () => null, canonicalize: async value => value };

test('owned installer profile follows only the current account recovery for the requested source', async () => {
  assert.equal((await resolveOwnedInstalledProfile(defaults)).directory, requested);
  const recovered = `${user}\\.config\\kcoder`;
  const selection = { sid: identity.sid, sourceDirectory: requested, directory: recovered };
  const result = await resolveOwnedInstalledProfile({ ...defaults, readSelection: async () => selection });
  assert.equal(result.directory, recovered);
  assert.equal(result.recovered, true);
  assert.equal((await resolveOwnedInstalledProfile({ ...defaults,
    readSelection: async () => ({ ...selection, sourceDirectory: `${root}\\different` }) })).directory, requested);
});

test('owned installer profile refuses other users, outside paths and redirected directories', async () => {
  const selection = { sid: identity.sid, sourceDirectory: requested, directory: `${user}\\.config\\kcoder` };
  for (const options of [
    { readIdentity: async () => ({ ...identity, userProfile: String.raw`C:\Users\personal` }) },
    { readSelection: async () => ({ ...selection, sid: 'S-1-5-21-9-9-9-1001' }) },
    { readSelection: async () => ({ ...selection, directory: String.raw`C:\Users\personal\.config\kcoder` }) },
    { readSelection: async () => selection,
      canonicalize: async value => value === selection.directory ? String.raw`C:\Users\personal\redirected` : value },
    { requested: String.raw`C:\Users\personal\profile` },
  ]) await assert.rejects(resolveOwnedInstalledProfile({ ...defaults, ...options }));
});
