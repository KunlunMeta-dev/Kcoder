import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupDiagnosticCodes } from './task-workspace-diagnostic-facts.mjs';

test('lookup stderr observation retains only closed classes across chunks, never body, paths or secrets', () => {
  const result = []; const observe = lookupDiagnosticCodes(code => result.push({ code }));
  observe('Native workspace lookup refused co');
  observe('de="profile_capture" secret=do-not-record /private/root\n');
  observe('unrelated code=profile_capture\nNative workspace lookup refused code=unknown secret=other\n');
  observe('X'.repeat(16000) + '\nNative workspace lookup refused code=storage_read\n');
  assert.deepEqual(result, [{ code: 'profile_capture' }, { code: 'storage_read' }]);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
