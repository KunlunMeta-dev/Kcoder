import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createWindowResponsiveness } from './window-responsiveness.mjs';

function fixture({ paint = async () => true, response = 0 } = {}) {
  const monitor = new EventEmitter(), dialogs = [], reloads = [];
  let origin = 'http://127.0.0.1:3210', visible = true, destroyed = false, focused = true;
  const contents = Object.assign(new EventEmitter(), { getURL: () => origin + '/', isDestroyed: () => destroyed,
    isLoadingMainFrame: () => false, executeJavaScript: paint, reload: () => {
      reloads.push(true); contents.emit('did-start-navigation', {}, origin, false, true);
    } });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => destroyed,
    isVisible: () => visible, isMinimized: () => false, isFocused: () => focused });
  const controller = createWindowResponsiveness({ powerMonitor: monitor, getGatewayOrigin: () => origin, timeoutMs: 10, focusAwayMs: 0,
    dialog: { showMessageBox: async (_window, options) => { dialogs.push(options); return { response: await response }; } } });
  controller.attach(window);
  return { controller, window, contents, monitor, dialogs, reloads, focus: value => { focused = value; window.emit(value ? 'focus' : 'blur'); },
    hide: () => { visible = false; }, destroy: () => { destroyed = true; window.emit('closed'); } };
}

test('healthy resume is paint-checked once without reloading drafts', async () => {
  let calls = 0;
  const f = fixture({ paint: async () => { calls++; return true; } });
  await Promise.all([f.controller.probe(f.window), f.controller.probe(f.window)]);
  assert.equal(calls, 1); assert.equal(f.dialogs.length, 0); assert.equal(f.reloads.length, 0);
  f.hide(); assert.equal(await f.controller.probe(f.window), 'skipped');
  f.controller.dispose(); assert.equal(f.monitor.listenerCount('resume'), 0);
});

test('a stalled paint defaults to waiting and reload requires an explicit choice', async () => {
  for (const choice of [0, 1]) {
    const f = fixture({ paint: () => new Promise(() => {}), response: choice });
    assert.equal(await f.controller.probe(f.window), choice ? 'reload-requested' : 'waiting');
    assert.equal(f.dialogs[0].defaultId, 0); assert.equal(f.dialogs[0].cancelId, 0);
    assert.match(f.dialogs[0].detail, /草稿/); assert.equal(f.reloads.length, choice);
    f.controller.dispose();
  }
});

test('navigation during the recovery dialog cannot reload the new page', async () => {
  let choose;
  const f = fixture({ paint: () => new Promise(() => {}), response: new Promise(resolve => { choose = resolve; }) });
  const probe = f.controller.probe(f.window);
  await new Promise(resolve => setTimeout(resolve, 25));
  f.contents.emit('did-start-navigation', {}, 'http://127.0.0.1:3210/settings', false, true);
  choose(1); assert.equal(await probe, 'stale'); assert.equal(f.reloads.length, 0);
  f.controller.dispose();
});

test('a late successful paint prevents an unnecessary reload after the dialog', async () => {
  let paint, choose;
  const f = fixture({ paint: () => new Promise(resolve => { paint = resolve; }), response: new Promise(resolve => { choose = resolve; }) });
  const probe = f.controller.probe(f.window);
  await new Promise(resolve => setTimeout(resolve, 25));
  paint(true); await Promise.resolve(); choose(1);
  assert.equal(await probe, 'responsive'); assert.equal(f.reloads.length, 0); f.controller.dispose();
});

test('window closure cancels the pending timeout and never opens a recovery dialog', async () => {
  const f = fixture({ paint: () => new Promise(() => {}) });
  const probe = f.controller.probe(f.window); await Promise.resolve(); f.destroy();
  assert.equal(await probe, 'stale'); assert.equal(f.dialogs.length, 0); f.controller.dispose();
});

test('a crashed renderer uses the same guarded recovery action', async () => {
  const f = fixture({ response: 1 });
  f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(f.dialogs.length, 0, 'recovery must wait until the native renderer teardown returns');
  await new Promise(resolve => setImmediate(resolve));
  await f.controller.probe(f.window);
  assert.equal(f.dialogs.length, 1); assert.equal(f.reloads.length, 1); f.controller.dispose();
});

test('actual resume and long-away focus events use one owned paint check', async () => {
  let calls = 0;
  const f = fixture({ paint: async () => { calls++; return true; } });
  f.monitor.emit('resume'); await f.controller.probe(f.window);
  assert.equal(calls, 1);
  f.focus(false); f.focus(true); await f.controller.probe(f.window);
  assert.equal(calls, 2); assert.equal(f.dialogs.length, 0); f.controller.dispose();
});

test('a background failure waits for focus without stealing focus or reloading', async () => {
  const f = fixture({ paint: () => new Promise(() => {}) });
  f.focus(false); f.monitor.emit('resume');
  assert.equal(await f.controller.probe(f.window), 'deferred');
  assert.equal(f.dialogs.length, 0); assert.equal(f.reloads.length, 0);
  f.focus(true); assert.equal(await f.controller.probe(f.window), 'waiting');
  assert.equal(f.dialogs.length, 1); f.controller.dispose();
});
