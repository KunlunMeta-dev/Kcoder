import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWindowsUiProbe } from './windows-ui-probe-wrapper.mjs';
const input = {owner:'12345678-1234-1234-1234-123456789012',directory:'C:\\owned',node:'C:\\node.exe',installation:'C:\\installed',mode:'migration'};
test('owned UI supervision accepts only explicit Windows paths and supported work', () => {
  assert.doesNotThrow(() => validateWindowsUiProbe(input));
  for (const value of [{owner:'../other'}, {directory:'relative'}, {node:'C:\\bad\nnode'}, {mode:'unknown'}])
    assert.throws(() => validateWindowsUiProbe({...input,...value}));
});
