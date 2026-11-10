import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clientGatewaySecret } from '../src/config.mjs';

test('profile startup reads an owned private credential file without changing the legacy environment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-relay-credential-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'secret'); const value = 'new-profile-private-secret-'.repeat(3);
  await writeFile(file, value + '\n', { mode: 0o600 });
  const env = { KCODER_RELAY_GATEWAY_SECRET: 'old-private-secret-'.repeat(3), KCODER_RELAY_GATEWAY_SECRET_FILE: file };
  const before = { ...env }; assert.equal(clientGatewaySecret(env), value); assert.deepEqual(env, before);
  assert.equal(clientGatewaySecret({ KCODER_RELAY_GATEWAY_SECRET: before.KCODER_RELAY_GATEWAY_SECRET }), before.KCODER_RELAY_GATEWAY_SECRET);
  if (process.platform !== 'win32') {
    await chmod(file, 0o644); assert.throws(() => clientGatewaySecret(env), /private Relay/); await chmod(file, 0o600);
    const link = join(directory, 'link'); await symlink(file, link);
    assert.throws(() => clientGatewaySecret({ KCODER_RELAY_GATEWAY_SECRET_FILE: link }));
  }
  await writeFile(file, 'x'.repeat(600)); assert.throws(() => clientGatewaySecret(env), /private Relay/);
});
