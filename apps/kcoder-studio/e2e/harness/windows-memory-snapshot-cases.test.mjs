import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsMemorySnapshotSelection } from './windows-memory-snapshot-cases.mjs';
import { validateNativeLibtestOptions } from './windows-native-libtest.mjs';

test('imported context sidecars select seven exact normal-release State tests and require execution', () => {
  const selection = windowsMemorySnapshotSelection();
  assert.equal(selection.expectedTests.length, 7);
  assert.equal(new Set(selection.expectedTests).size, 7);
  assert.ok(selection.expectedTests.every(name => name.startsWith(selection.testFilter)));
  validateNativeLibtestOptions({ consent: '1', target: 'owned-host', parent: 'D:\\', node: 'D:\\node.exe',
    testBinary: '/owned/state-tests.exe', supervisor: '/owned/supervisor.exe', testSha256: 'a'.repeat(64),
    supervisorSha256: 'b'.repeat(64), sourceTreeSha256: 'c'.repeat(64), ...selection });
  selection.expectedTests.pop();
  assert.equal(windowsMemorySnapshotSelection().expectedTests.length, 7);
});
