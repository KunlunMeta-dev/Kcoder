import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMobilePreviewConfig, mobilePreviewModelEnvironment } from './mobile-preview-config.js';

const options = { prefix: '/g/owned-preview', gatewayPort: 4189, proxyPort: 14178, remotePort: 18453 };
const env = { KCODER_RELAY_PUBLIC_URL: 'https://49.234.36.54:8451', KCODER_RELAY_SSH_HOSTNAME: 'current-relay.example',
  KCODER_RELAY_CONFIG_DIR: '/private/config', KCODER_RELAY_SERVERS_FILE: '/private/servers.json', KCODER_RELAY_KCODER_BIN: '/opt/kcoder' };

test('preview preserves configured model credentials and target defaults without copying Relay credentials', () => {
  const model = { KUNLUNMETA_BASE_API_KEY: 'owned-provider-fixture-key',
    KUNLUNMETA_BASE_URL: 'https://provider.example', KUNLUNMETA_BASE_MODEL: 'configured-model' };
  assert.deepEqual(mobilePreviewModelEnvironment({ ...env, ...model,
    KCODER_RELAY_GATEWAY_SECRET: 'owned-relay-fixture-secret', KCODER_STUDIO_AUTH_TOKEN: 'owned-login-fixture-token' }), model);
  assert.deepEqual(mobilePreviewModelEnvironment({}), {}, 'an absent model choice must remain absent');
  assert.deepEqual(mobilePreviewModelEnvironment({ KUNLUNMETA_BASE_API_KEY: '' }), { KUNLUNMETA_BASE_API_KEY: '' },
    'explicit credential removal cannot resurrect an inherited key');
});

test('preview follows the current Relay origin, IP authority, STUN and SSH configuration', () => {
  const result = resolveMobilePreviewConfig(env, options);
  assert.equal(result.publicBaseUrl, 'https://49.234.36.54:8451/g/owned-preview');
  assert.equal(result.publicAuthority, '49.234.36.54:8451');
  assert.equal(result.stunUrls, 'stun:49.234.36.54:8452');
  assert.equal(result.sshHostname, 'current-relay.example');
  assert.equal(result.localOrigin, 'http://127.0.0.1:14178');
  const moved = resolveMobilePreviewConfig({ ...env, KCODER_RELAY_PUBLIC_URL: 'https://next-relay.example',
    KCODER_RELAY_SSH_HOSTNAME: 'next-ssh.example', KCODER_RELAY_STUN_PORT: '9452' }, options);
  assert.equal(moved.publicAuthority, 'next-relay.example');
  assert.equal(moved.stunUrls, 'stun:next-relay.example:9452');
  assert.equal(moved.sshHostname, 'next-ssh.example');
});

test('explicit operator STUN settings remain authoritative', () => {
  assert.equal(resolveMobilePreviewConfig({ ...env, KCODER_STUDIO_P2P_STUN_URLS: 'stun:own.example:3478' }, options).stunUrls,
    'stun:own.example:3478');
});

test('malformed public URLs, paths, SSH arguments and missing backend paths fail before launch', () => {
  for (const url of ['http://relay.example', 'https://user:secret@relay.example', 'https://relay.example/path', 'https://relay.example?token=private']) {
    assert.throws(() => resolveMobilePreviewConfig({ ...env, KCODER_RELAY_PUBLIC_URL: url }, options));
  }
  assert.throws(() => resolveMobilePreviewConfig({ ...env, KCODER_RELAY_SSH_HOSTNAME: '-oProxyCommand=unsafe' }, options));
  assert.throws(() => resolveMobilePreviewConfig({ ...env, KCODER_RELAY_KCODER_BIN: '' }, options));
  assert.throws(() => resolveMobilePreviewConfig(env, { ...options, prefix: '/g/a/../b' }));
  assert.throws(() => resolveMobilePreviewConfig(env, { ...options, remotePort: options.proxyPort }));
});
