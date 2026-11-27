import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const { startRuntimeAutomationControl } = createRequire(import.meta.url)('./runtime-automation-control.cjs');

test('runtime automation rejects external, ambiguous and unassigned origins', async () => {
  for (const origin of ['https://example.com:1234', 'http://localhost:1234', 'http://127.0.0.1:0', 'http://127.0.0.1:99999', 'http://127.0.0.1:1234/path'])
    await assert.rejects(startRuntimeAutomationControl(origin));
});

test('owned control requires matching origin and credentials and creates only the existing E2E gate', async () => {
  const origin = 'http://127.0.0.1:1234';
  const control = await startRuntimeAutomationControl(origin);
  try {
    const window = {}; window.top = window;
    vm.runInNewContext(control.script, { window, location: { origin } });
    const config = window.__KCODER_AI_VERIFY__;
    assert.ok(Object.isFrozen(config));
    assert.equal(config.origin, origin);
    assert.deepEqual([...(await config.nativeIsolation)], [true, true]);
    assert.equal(window.__KCODER_STUDIO_E2E__, undefined);
    for (const [headers, status] of [[{}, 403], [{ origin }, 401], [{ origin, authorization: 'Bearer invalid' }, 401], [{ origin, authorization: `Bearer ${config.token}` }, 204]]) {
      const response = await fetch(`${config.controlUrl}/commands`, { headers });
      assert.equal(response.status, status);
      assert.equal(await response.text(), '');
    }
    const otherWindow = {}; otherWindow.top = otherWindow;
    vm.runInNewContext(control.script, { window: otherWindow, location: { origin: 'http://127.0.0.1:4321' } });
    assert.equal(otherWindow.__KCODER_AI_VERIFY__, undefined);
  } finally { await control.close(); }
});
