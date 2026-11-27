import assert from 'node:assert/strict';
import test from 'node:test';
import { MockThreadStore } from '../src/mock-thread-store.js';

test('mock metadata survives rereads and archive, restore and delete affect list membership', () => {
  const store = new MockThreadStore('/workspace', 123456);
  store.update('mock-active-session', { title: 'renamed' });
  assert.equal(store.list()[0].title, 'renamed');
  store.update('mock-active-session', { archivedAt: '2026-09-14T00:00:00Z' });
  assert.equal(store.list().length, 0);
  assert.equal(store.list(true).length, 2);
  store.update('mock-active-session', { archivedAt: null });
  assert.equal(store.list()[0].title, 'renamed');
  store.delete('mock-active-session');
  assert.equal(store.list().length, 0);
});

test('mock target stores and returned snapshots do not share mutable metadata', () => {
  const first = new MockThreadStore('/one');
  const second = new MockThreadStore('/two');
  first.list()[0].title = 'external mutation';
  first.update('mock-active-session', { title: 'first only' });
  assert.equal(second.list()[0].title, '移动任务操作测试');
  assert.equal(second.list()[0].cwd, '/two');
  assert.equal(first.read('mock-active-session').title, 'first only');
});
