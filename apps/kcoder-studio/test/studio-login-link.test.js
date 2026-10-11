import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayToken, studioDataDirectory, studioLoginUrlPath, writeStudioLoginUrl } from '../src/studio-login-link.js';

test('writes a private, replaceable per-user login URL and preserves unchanged files', async t => {
  const home = await mkdtemp(join(tmpdir(), 'kcoder-studio-login-link-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const urlPath = studioLoginUrlPath({ home, platform: 'linux' });
  assert.equal(urlPath, join(home, '.config', 'kcoder-studio', 'studio-login-url.txt'));
  const first = await writeStudioLoginUrl('http://127.0.0.1:4173/login?token=first', { home, platform: 'linux' });
  const unchanged = await writeStudioLoginUrl('http://127.0.0.1:4173/login?token=first', { home, platform: 'linux' });
  assert.equal(first.updated, true);
  assert.equal(unchanged.updated, false);
  assert.equal(await readFile(urlPath, 'utf8'), 'http://127.0.0.1:4173/login?token=first\n');
  assert.equal((await stat(urlPath)).mode & 0o777, 0o600);
  await writeStudioLoginUrl('https://relay.example/g/one/login?token=second', { home, platform: 'linux' });
  assert.equal(await readFile(urlPath, 'utf8'), 'https://relay.example/g/one/login?token=second\n');
});

test('generates an auth token unless an explicit token or test-only bypass is set', () => {
  assert.equal(createGatewayToken({ KCODER_STUDIO_AUTH_TOKEN: 'configured' }), 'configured');
  assert.equal(createGatewayToken({ NODE_ENV: 'test', KCODER_STUDIO_TEST_DISABLE_AUTH: '1' }), '');
  const token = createGatewayToken({});
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
});

test('uses USERPROFILE for the Windows login-link path', () => {
  assert.equal(studioLoginUrlPath({ platform: 'win32', home: 'C:\\Users\\Alice' }), 'C:\\Users\\Alice\\.config\\kcoder-studio\\studio-login-url.txt');
  assert.equal(studioDataDirectory({ platform: 'win32', serversStore: 'C:\\StudioData\\servers.json' }), 'C:\\StudioData');
  assert.equal(studioLoginUrlPath({ platform: 'linux', serversStore: '/var/lib/kcoder/servers.json' }), '/var/lib/kcoder/studio-login-url.txt');
});
