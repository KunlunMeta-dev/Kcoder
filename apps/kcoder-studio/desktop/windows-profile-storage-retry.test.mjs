import assert from 'node:assert/strict';
import test from 'node:test';
import { retryWindowsGatewayStorageStartup } from './windows-profile-startup.mjs';

for (const reason of ['owner_mismatch', 'reparse_point', 'identity_unavailable', 'validation_failed']) {
  test(`storage failure ${reason} does not select a replacement Home or restart`, async () => {
    const forbidden = () => assert.fail('An unavailable store must report its original failure');
    assert.equal(await retryWindowsGatewayStorageStartup({ platform: 'win32',
      error: { code: 'MOBILE_DEVICE_STORAGE_UNAVAILABLE', reason },
      dialog: { showMessageBox: forbidden }, restart: forbidden }), false);
  });
}

for (const locale of ['en', 'zh-CN']) {
  for (const response of [0, 1]) test(`busy store retry/quit stays in place: ${locale}, ${response}`, async () => {
    let restarts = 0;
    const env = { KCODER_HOME: 'original', KCODER_STUDIO_DATA_DIR: 'original-data' };
    assert.equal(await retryWindowsGatewayStorageStartup({ platform: 'win32', env, locale,
      error: { code: 'MOBILE_DEVICE_STORAGE_UNAVAILABLE', reason: 'store_busy' },
      dialog: { showMessageBox: async options => { assert.equal(options.cancelId, 1);
        assert.equal(options.buttons.length, 2); return { response }; } },
      restart: async () => { restarts++; } }), true);
    assert.equal(restarts, response === 0 ? 1 : 0);
    assert.deepEqual(env, { KCODER_HOME: 'original', KCODER_STUDIO_DATA_DIR: 'original-data' });
  });
}

test('cancellation after the busy prompt prevents relaunch', async () => {
  const controller = new AbortController();
  assert.equal(await retryWindowsGatewayStorageStartup({ platform: 'win32', signal: controller.signal,
    error: { code: 'MOBILE_DEVICE_STORAGE_UNAVAILABLE', reason: 'store_busy' },
    dialog: { showMessageBox: async () => { controller.abort(); return { response: 0 }; } },
    restart: () => assert.fail('Cancelled startup must not restart') }), true);
});

for (const options of [
  { platform: 'linux', error: { code: 'MOBILE_DEVICE_STORAGE_UNAVAILABLE', reason: 'store_busy' } },
  { platform: 'win32', error: { code: 'OTHER', reason: 'store_busy' } },
  { platform: 'win32', error: { code: 'MOBILE_DEVICE_STORAGE_UNAVAILABLE', reason: 'store_busy', cleanupError: new Error('unknown cleanup') } },
]) test(`unrelated or unconfirmed cleanup cannot restart: ${options.platform}, ${options.error.code}, ${!!options.error.cleanupError}`, async () => {
  const forbidden = () => assert.fail('No prompt or restart is allowed');
  assert.equal(await retryWindowsGatewayStorageStartup({ ...options,
    dialog: { showMessageBox: forbidden }, restart: forbidden }), false);
});
