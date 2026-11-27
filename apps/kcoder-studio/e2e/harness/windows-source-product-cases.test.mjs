import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsSourceProductSelection } from './windows-source-product-cases.mjs';
import { validateNativeLibtestOptions } from './windows-native-libtest.mjs';

test('uploaded products have eleven exact normal-release Native cases, including both Memory boundaries', () => {
  const selection = windowsSourceProductSelection();
  assert.equal(selection.expectedTests.length, 11);
  assert.equal(new Set(selection.expectedTests).size, 11);
  assert.equal(selection.expectedTests.filter(name => name.includes('::memory::')).length, 2);
  assert.ok(selection.expectedTests.every(name => name.startsWith(selection.testFilter)));
  validateNativeLibtestOptions({ consent: '1', target: 'owned-host', parent: 'D:\\', node: 'D:\\node.exe',
    testBinary: '/owned/native-tests.exe', supervisor: '/owned/supervisor.exe', testSha256: 'a'.repeat(64),
    supervisorSha256: 'b'.repeat(64), sourceTreeSha256: 'c'.repeat(64), ...selection });
  selection.expectedTests.pop();
  assert.equal(windowsSourceProductSelection().expectedTests.length, 11);
});
