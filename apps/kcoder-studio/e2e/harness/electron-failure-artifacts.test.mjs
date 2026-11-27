import assert from 'node:assert/strict';
import test from 'node:test';
import { captureElectronFailureArtifacts } from './electron-failure-artifacts.mjs';

for (const failure of ['capture', 'snapshot', 'write']) {
  test(`diagnostic ${failure} failure cannot replace the original error`, async () => {
    const original = new Error('original suite failure');
    const calls = [];
    const client = {
      async capture() { calls.push('capture'); if (failure === 'capture') throw new Error('capture failed'); },
      async command() { calls.push('snapshot'); if (failure === 'snapshot') throw new Error('controller closed'); return '{"ok":true}'; },
    };
    const context = { async writeArtifactJson() { calls.push('write'); if (failure === 'write') throw new Error('artifact unavailable'); } };
    await assert.rejects(async () => {
      try { throw original; }
      catch (error) { await captureElectronFailureArtifacts(client, context); throw error; }
    }, error => error === original);
    assert.ok(calls.includes('snapshot'), 'snapshot remains independent of screenshot failure');
    if (failure !== 'snapshot') assert.ok(calls.includes('write'));
  });
}
