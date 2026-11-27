import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clientGatewaySecret } from '../src/config.mjs';

test('the private credential reader preserves its explicit environment object; no startup/environment-isolation claim', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-relay-credential-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'secret'); const value = 'new-profile-private-secret-'.repeat(3);
  await writeFile(file, value + '\n');
  const env = { KCODER_RELAY_GATEWAY_SECRET: 'old-private-secret-'.repeat(3), KCODER_RELAY_GATEWAY_SECRET_FILE: file };
  const before = { ...env }; assert.equal(clientGatewaySecret(env), value); assert.deepEqual(env, before);
  assert.equal(clientGatewaySecret({ KCODER_RELAY_GATEWAY_SECRET: before.KCODER_RELAY_GATEWAY_SECRET }), before.KCODER_RELAY_GATEWAY_SECRET);
  if (process.platform !== 'win32') {
    const link = join(directory, 'link'); await symlink(file, link);
    assert.throws(() => clientGatewaySecret({ KCODER_RELAY_GATEWAY_SECRET_FILE: link }));
  }
  await writeFile(file, 'x'.repeat(600)); assert.throws(() => clientGatewaySecret(env), /private Relay/);
});
