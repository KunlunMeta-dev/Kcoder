import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { repoRoot } from './run-context.mjs';

test('the actual renderer xterm package answers VT queries from its buffer state without DOM rendering', { timeout: 2000 }, async () => {
  const require = createRequire(resolve(repoRoot, 'apps/kcoder-studio/renderer/package.json'));
  const { Terminal } = require('@xterm/xterm');
  const terminal = new Terminal({ rows: 24, cols: 80 });
  const responses = [];
  const listener = terminal.onData(data => responses.push(data));
  try {
    await new Promise(accept => terminal.write('abc\x1b[6n', accept));
    await new Promise(accept => terminal.write('\x1b[4;9H\x1b[6n', accept));
    assert.deepEqual(responses, ['\x1b[1;4R', '\x1b[4;9R']);
  } finally { listener.dispose(); terminal.dispose(); }
});
