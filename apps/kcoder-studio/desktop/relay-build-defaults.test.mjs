import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { desktopRelayBuildDefaults } from './relay-build-defaults.mjs';

test('package defaults project only the validated public Relay URL from env', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-relay-defaults-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, '.env');
  const input = 'KCODER_RELAY_PUBLIC_URL="https://relay.example:8451"\nKCODER_RELAY_REGISTRATION_KEY=private-fixture\nKCODER_RELAY_ACCOUNT_LOGIN_TOKEN=private-fixture\nKCODER_RELAY_ADMIN_PASSWORD_HASH=private-fixture\n';
  await writeFile(file, input);
  assert.deepEqual(desktopRelayBuildDefaults({}, file), { relayPublicUrl: 'https://relay.example:8451' });
  assert.deepEqual(desktopRelayBuildDefaults({ KCODER_RELAY_PUBLIC_URL: 'https://other.example', SECRET: 'private-fixture' }, file), { relayPublicUrl: 'https://other.example' });
  assert.throws(() => desktopRelayBuildDefaults({ KCODER_RELAY_PUBLIC_URL: 'http://127.0.0.1' }), /Relay public URL/);
  assert.throws(() => desktopRelayBuildDefaults({ KCODER_RELAY_PUBLIC_URL: 'https://user:secret@relay.example' }), /HTTPS root URL/);
  assert.deepEqual(desktopRelayBuildDefaults({}, join(directory, 'missing')), {});
});
