import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsPrivateCredentialSelections } from './windows-private-credential-cases.mjs';
import { validateNativeLibtestOptions } from './windows-native-libtest.mjs';

test('private credentials require the complete exact 24-case Native roster on the owned Windows host', () => {
  const selections = windowsPrivateCredentialSelections();
  const selection = { expectedTests: selections.flatMap(value => value.expectedTests) };
  assert.equal(selection.expectedTests.length, 24);
  assert.equal(new Set(selection.expectedTests).size, 24);
  assert.ok(selections.every(value => value.expectedTests.every(name => name.startsWith(value.testFilter))));
  assert.equal(selection.expectedTests.filter(name => name.includes('::crypto::')).length, 5);
  for (const selected of selections) validateNativeLibtestOptions({ consent: '1', target: 'owned-host', parent: 'D:\\', node: 'D:\\node.exe',
    testBinary: '/owned/migration-tests.exe', supervisor: '/owned/supervisor.exe', testSha256: 'a'.repeat(64),
    supervisorSha256: 'b'.repeat(64), sourceTreeSha256: 'c'.repeat(64), ...selected });
  selection.expectedTests.pop();
  assert.equal(windowsPrivateCredentialSelections().flatMap(value => value.expectedTests).length, 24);
});
