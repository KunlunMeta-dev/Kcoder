import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { gatewayStartupExitError, showGatewayStorageRecovery, storageStartupFailureMessage } from './gateway-startup-failure.mjs';

test('migration contention explains waiting in both locales without suggesting a new operation', () => {
  const busy = { code: 'STORAGE_MIGRATION_BUSY', message: 'private diagnostic' };
  const zh = storageStartupFailureMessage(busy, 'zh-CN');
  const en = storageStartupFailureMessage(busy, 'en-US');
  assert.match(zh, /等待当前操作完成/);
  assert.match(zh, /不要重复发起迁移/);
  assert.match(en, /Wait for it to finish/);
  assert.match(en, /Do not start another migration/);
  assert.doesNotMatch(zh + en, /private diagnostic|STORAGE_HELPER_FAILED/);
  assert.equal(storageStartupFailureMessage(new Error('unrelated'), 'zh-CN'), null);
});

test('storage startup failures preserve a bounded reason without leaking stderr', () => {
  const error = gatewayStartupExitError({ code: 1, signal: null,
    stderr: "sensitive-value\nError: Private Windows mobile device storage unavailable (reparse_point)\nraw stack" });
  assert.equal(error.code, 'MOBILE_DEVICE_STORAGE_UNAVAILABLE');
  assert.equal(error.reason, 'reparse_point');
  assert.doesNotMatch(error.message, /sensitive-value|raw stack/);
});

test('only recognized storage diagnostics use the recovery path', () => {
  const error = gatewayStartupExitError({ code: 1, signal: null, stderr: 'unrelated failure' });
  assert.equal(error.code, undefined);
  assert.match(error.message, /exited before startup.*unrelated failure/);
  assert.equal(gatewayStartupExitError({ code: 1, signal: null,
    stderr: 'KCODER_MOBILE_STORAGE_ERROR:owner_mismatch' }).reason, 'owner_mismatch');
});

for (const locale of ['zh-CN', 'en-US']) {
  test(`storage recovery explains the owned directory and opens it only on request (${locale})`, async () => {
    const dataDirectory = join('fixture', 'studio');
    const error = gatewayStartupExitError({ code: 1, signal: null,
      stderr: 'Private Windows mobile device storage unavailable (owner_mismatch)' });
    let opened;
    let displayed;
    const shell = { openPath: async path => { opened = path; } };
    for (const response of [1, 0]) {
      opened = undefined;
      const dialog = { showMessageBox: async options => { displayed = options; return { response }; } };
      assert.equal(await showGatewayStorageRecovery({ error, dialog, shell, locale, dataDirectory }), true);
      assert.ok(displayed.detail.includes(join(dataDirectory, 'mobile-device-auth')));
      assert.ok(displayed.detail.includes('owner_mismatch'));
      assert.equal(displayed.cancelId, 1);
      assert.equal(opened, response === 0 ? dataDirectory : undefined);
      assert.equal(displayed.buttons[0], locale === 'zh-CN' ? '打开数据目录' : 'Open data folder');
    }
  });
}

test('ordinary startup failures do not show the storage recovery dialog', async () => {
  assert.equal(await showGatewayStorageRecovery({ error: new Error('unrelated') }), false);
});

test('space exhaustion is explained without claiming an uncertain write was rolled back', async () => {
  const error = { code: 'DESKTOP_LOGIN_STORAGE_IO', reason: 'space_exhausted' };
  let shown;
  assert.equal(await showGatewayStorageRecovery({ error, locale: 'zh-CN',
    dialog: { showMessageBox: async options => { shown = options; return { response: 0 }; } } }), true);
  assert.match(shown.message, /空间不足/);
  assert.doesNotMatch(shown.detail, /一定没有修改|完全未写入/);
});

test('store contention is explained without asking the user to change permissions', async () => {
  const error = gatewayStartupExitError({ code: 1, signal: null,
    stderr: 'Private Windows mobile device storage unavailable (store_busy)' });
  await showGatewayStorageRecovery({ error, locale: 'en', dataDirectory: 'fixture',
    dialog: { showMessageBox: async options => {
      assert.match(options.message, /lock is unavailable/);
      assert.doesNotMatch(options.detail, /restore a trusted backup|permissions/);
      return { response: 1 };
    } } });
});

test('storage recovery uses the directory resolved by the actual Gateway child', async () => {
  const error = gatewayStartupExitError({ code: 1, signal: null,
    stderr: 'Private Windows mobile device storage unavailable (reparse_point)',
    dataDirectory: join('actual', 'child-store') });
  let opened;
  await showGatewayStorageRecovery({ error, locale: 'en', dataDirectory: 'wrong-default',
    dialog: { showMessageBox: async options => {
      assert.ok(options.detail.includes(join('actual', 'child-store', 'mobile-device-auth')));
      return { response: 0 };
    } }, shell: { openPath: async path => { opened = path; } } });
  assert.equal(opened, join('actual', 'child-store'));
});
