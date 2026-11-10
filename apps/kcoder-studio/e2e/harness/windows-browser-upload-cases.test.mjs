import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsBrowserUploadSelections } from './windows-browser-upload-cases.mjs';
import { validateNativeLibtestOptions } from './windows-native-libtest.mjs';

test('browser-source upload and container use exact distinct Native rosters without diagnostic stack overrides', () => {
  const selections = windowsBrowserUploadSelections();
  const names = selections.flatMap(value => value.expectedTests);
  assert.equal(names.length, 28); assert.equal(new Set(names).size, names.length);
  for (const selection of selections) {
    assert.ok(selection.expectedTests.every(name => name.startsWith(selection.testFilter)));
    validateNativeLibtestOptions({ consent: '1', target: 'owned-host', parent: 'D:\\', node: 'D:\\node.exe',
      testBinary: '/owned/native-tests.exe', supervisor: '/owned/supervisor.exe', testSha256: 'a'.repeat(64),
      supervisorSha256: 'b'.repeat(64), sourceTreeSha256: 'c'.repeat(64), ...selection });
  }
  selections[0].expectedTests.pop();
  assert.equal(windowsBrowserUploadSelections()[0].expectedTests.length, 14);
});
