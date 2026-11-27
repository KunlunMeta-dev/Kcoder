import assert from 'node:assert/strict';
import test from 'node:test';
import { tuiRunFromOwnedLog } from './owned-tui-lab.mjs';
test('only an owned TUI artifact path can be read as the nested run', () => {
  assert.equal(tuiRunFromOwnedLog('unrelated\n/owned/target/tui-lab/date/run\n', '/owned'), '/owned/target/tui-lab/date/run');
  assert.equal(tuiRunFromOwnedLog('/elsewhere/target/tui-lab/run\n', '/owned'), null);
  assert.throws(() => tuiRunFromOwnedLog('/owned/target/tui-lab/../../private\n', '/owned'), /inside its artifact root/);
});
