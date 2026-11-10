import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, appendFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForStatus } from './owned-process.mjs';

test('supervisor observation waits for a complete append receipt and preserves malformed-frame failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-owned-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'status.jsonl');
  await writeFile(file, '{"event":"REA');
  let settled = false;
  const observed = waitForStatus(file, event => event.event === 'READY' ? event : null, 2000).then(value => { settled = true; return value; });
  await new Promise(accept => setTimeout(accept, 30));
  assert.equal(settled, false);
  await appendFile(file, 'DY","pid":42}');
  await new Promise(accept => setTimeout(accept, 30));
  assert.equal(settled, false, 'a valid-looking JSON prefix still needs its commit delimiter');
  await appendFile(file, '\n');
  assert.deepEqual(await observed, { event: 'READY', pid: 42 });
  await writeFile(file, '{bad}\n');
  await assert.rejects(waitForStatus(file, () => true, 100), SyntaxError);
});
