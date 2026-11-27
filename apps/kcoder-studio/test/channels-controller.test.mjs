import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChannelsController } from '../src/channels-controller.mjs';
import { ChannelStore } from '../../kcoder-channel-host/src/channels/store.mjs';

test('controller shutdown fences authorization immediately and joins its original pending receipt', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'channels-controller-'));
  const controller = createChannelsController({ directory, selectBroker: async () => assert.fail('No task broker is needed') });
  let finish, cancelled = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  controller.authorizations.factories.feishu = () => ({ create: () => pending, cancel: () => { cancelled++; } });
  const body = { action: 'authorization_begin', platform: 'feishu', flowId: 'original', connectionId: 'connection', expectedRevision: 0 };
  const creating = controller.authorizations.request(body, 'owner'); creating.catch(() => {});
  t.after(async () => { finish({ state: 'waiting' }); await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  await new Promise(setImmediate);
  const closing = controller.close(); let settled = false; closing.then(() => { settled = true; });
  assert.equal(controller.close(), closing, 'concurrent shutdowns join the same owner cleanup');
  assert.equal(cancelled, 1);
  await assert.rejects(controller.authorizations.request(body, 'owner'), /CHANNEL_AUTHENTICATION_CLOSED/);
  await new Promise(setImmediate); assert.equal(settled, false);
  finish({ state: 'waiting' });
  await assert.rejects(creating, /CHANNEL_AUTHENTICATION_CLOSED/); await closing;
  const reopened = new ChannelStore(directory);
  try { assert.deepEqual(reopened.connections(), []); } finally { reopened.close(); }
});
