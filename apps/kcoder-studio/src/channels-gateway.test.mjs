import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createChannelsGateway } from './channels-gateway.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kcoder-channel-notifications-'));
  const gateway = createChannelsGateway({ directory, serversById: new Map(), frame: value => value });
  t.after(async () => { await gateway.channels.close(); rmSync(directory, { recursive: true, force: true }); });
  const socket = () => {
    const value = new EventEmitter(); value.writable = true; value.messages = [];
    value.write = raw => { value.messages.push(JSON.parse(raw)); return true; };
    return value;
  };
  return { ...gateway, socket, store: gateway.channels.runtime.store };
}

test('committed changes coalesce across clients; no payload, unauthorized or revoked delivery', async t => {
  const f = fixture(t), first = f.socket(), second = f.socket(), forbidden = f.socket();
  let authorized = true;
  f.attachChannelNotifications(first, () => authorized);
  f.attachChannelNotifications(second, () => true);
  f.attachChannelNotifications(forbidden, () => false);
  f.store.saveConnection({ id: 'bot', platform: 'feishu', label: 'private bot', configuration: { appId: 'fixture' } }, { appSecret: 'private secret' });
  const chat = f.store.observeChat('bot', { platform: 'feishu', conversationId: 'private chat', text: 'private text' });
  f.store.bind(chat.id, { serverId: 'target', threadId: 'private task' }, 0);
  await delay(90);
  assert.deepEqual(first.messages, [{ jsonrpc: '2.0', method: 'gateway/channels/changed', params: {} }]);
  assert.deepEqual(second.messages, first.messages);
  assert.deepEqual(forbidden.messages, []);
  authorized = false;
  f.store.unbind(chat.id, 1);
  await delay(90);
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 2);
  second.emit('close');
  f.store.setSettings({ mirrorClientTurns: true });
  await delay(90);
  assert.equal(second.messages.length, 2);
});

test('a blocked socket coalesces changes until drain and rechecks current authorization', async t => {
  const f = fixture(t), socket = f.socket();
  socket.write = raw => { socket.messages.push(JSON.parse(raw)); return false; };
  let authorized = true, reads = 0;
  f.attachChannelNotifications(socket, () => { reads++; return authorized; });
  f.store.setSettings({ mirrorClientTurns: true }); await delay(90);
  f.store.setSettings({ mirrorClientTurns: false }); await delay(90);
  assert.equal(socket.messages.length, 1);
  assert.equal(reads, 1, 'a blocked delivery does not reread authorization');
  authorized = false; socket.emit('drain'); await delay(90);
  assert.equal(reads, 2, 'drain checks current authority before another delivery');
  assert.equal(socket.messages.length, 1);
  assert.equal(socket.listenerCount('drain'), 1);
  socket.emit('close');
  assert.equal(socket.listenerCount('drain'), 0);
});

test('a writable peer authenticates independently without rereading its blocked page socket', async t => {
  const f = fixture(t), blocked = f.socket(), writable = f.socket();
  const page = 'page-observer-00000001';
  let blockedReads = 0, writableReads = 0;
  blocked.write = raw => { blocked.messages.push(JSON.parse(raw)); return false; };
  f.attachChannelNotifications(blocked, () => { blockedReads++; return true; }, 'login', page);
  f.attachChannelNotifications(writable, () => { writableReads++; return true; }, 'login', page);
  await delay(90);
  f.store.setSettings({ mirrorClientTurns: true });
  await delay(90);
  assert.equal(blocked.messages.length, 1);
  assert.equal(writable.messages.length, 1);
  assert.equal(blockedReads, 1);
  assert.equal(writableReads, 1);
});

test('a socket closing during authentication cannot receive a notification', async t => {
  const f = fixture(t), socket = f.socket();
  let finish;
  f.attachChannelNotifications(socket, () => new Promise(resolve => { finish = resolve; }));
  await delay(90);
  assert.equal(typeof finish, 'function');
  socket.emit('close'); finish(true);
  await delay(0);
  assert.equal(socket.messages.length, 0);
  assert.equal(socket.listenerCount('drain'), 0);
});

test('one page receives one notification across sockets; other tabs and login sessions remain independent', async t => {
  const f = fixture(t), first = f.socket(), spare = f.socket(), otherTab = f.socket(), otherLogin = f.socket(), transient = f.socket();
  const page = 'page-observer-00000001';
  f.attachChannelNotifications(first, () => true, 'login-a', page);
  f.attachChannelNotifications(spare, () => true, 'login-a', page);
  f.attachChannelNotifications(otherTab, () => true, 'login-a', 'page-observer-00000002');
  f.attachChannelNotifications(otherLogin, () => true, 'login-b', page);
  f.attachChannelNotifications(transient, () => true, 'login-a', 'none');
  f.store.setSettings({ mirrorClientTurns: true });
  await delay(90);
  assert.equal(first.messages.length + spare.messages.length, 1);
  assert.equal(otherTab.messages.length, 1);
  assert.equal(otherLogin.messages.length, 1);
  assert.equal(transient.messages.length, 0);
  const joined = f.socket();
  f.attachChannelNotifications(joined, () => true, 'login-a', page);
  await delay(90);
  assert.equal(first.messages.length + spare.messages.length + joined.messages.length, 1);
  first.emit('close');
  await delay(90);
  assert.equal(spare.messages.length + joined.messages.length, 1, 'an existing socket takes over and resynchronizes');
  spare.emit('close'); joined.emit('close');
  const reconnect = f.socket();
  f.attachChannelNotifications(reconnect, () => true, 'login-a', page);
  await delay(90);
  assert.equal(reconnect.messages.length, 1, 'a reconnect resynchronizes without a data mutation');
  assert.equal(otherTab.messages.length, 1, 'another page does not refresh because a peer reconnects');
});
