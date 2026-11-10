import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelWorker } from '../src/channels/worker-client.mjs';

test('failed SDK selection stops the exact forked worker without network access', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-worker-'));
  const worker = new ChannelWorker({ id: 'not-started', platform: 'unsupported', configuration: {} }, {}, directory);
  t.after(async () => { await worker.stop(); rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(worker.start(() => { throw new Error('No SDK event is expected'); }), /CHANNEL_PLATFORM_UNSUPPORTED/);
  assert.equal(worker.child.connected, false);
  assert.ok(worker.child.exitCode !== null || worker.child.signalCode !== null);
  assert.equal(worker.pending.size, 0);
});
