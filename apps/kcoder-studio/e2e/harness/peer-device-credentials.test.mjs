import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, rm, link } from 'node:fs/promises';
import path from 'node:path';
import { RunContext } from './run-context.mjs';
import { readOwnedPeerDeviceCredential } from './peer-device-credentials.mjs';

test('owned explicit file credential is registered before use and never falls back to keyring or links', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'peer-owned-credential-file-boundary', tier: 'model-independent' });
  let failure;
  try {
    const profile = context.pathInState('profile'); await mkdir(profile, { mode: 0o700 });
    const file = path.join(profile, 'peer-gateway-session.json');
    const credentials = { backend: 'file', secret: { deviceId: 'owned-device', accessToken: 'owned-access-secret', refreshToken: 'owned-refresh-secret', rpcToken: 'owned-rpc-secret' } };
    await writeFile(file, JSON.stringify(credentials), { mode: 0o600 });
    const value = await readOwnedPeerDeviceCredential(context, profile);
    assert.equal(value.id, 'owned-device'); assert.equal(value.token, credentials.secret.accessToken);
    assert.equal(context.redactText(value.token).includes(value.token), false);
    await writeFile(file, JSON.stringify({ backend: 'keyring' }));
    await assert.rejects(readOwnedPeerDeviceCredential(context, profile), /explicitly requires/);
    await rm(file);
    await assert.rejects(readOwnedPeerDeviceCredential(context, profile));
    const external = context.pathInState('other-credential'); await writeFile(external, JSON.stringify(credentials), { mode: 0o600 });
    await symlink(external, file); await assert.rejects(readOwnedPeerDeviceCredential(context, profile)); await rm(file);
    await link(external, file); await assert.rejects(readOwnedPeerDeviceCredential(context, profile), /private regular file/);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { explicitPrivateFileOnly: !failure }, failure); }
});
