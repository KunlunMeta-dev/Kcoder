import assert from 'node:assert/strict';
import test from 'node:test';
import { installSmallAssetCancelObserver } from './migration-cancel-dom-observation.mjs';

function fixture() {
  let now = 0, listener, mutation, next = 0, disconnected = false;
  const frames = new Map(), statuses = [], style = { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' };
  const scope = { querySelectorAll: () => statuses, contains: () => true, addEventListener: (_type, fn) => { listener = fn; },
    removeEventListener: (_type, fn) => { assert.equal(fn, listener); listener = null; } };
  const env = { document: { querySelector: () => scope }, performance: { now: () => now }, innerWidth: 1280, innerHeight: 900,
    getComputedStyle: element => element.style ?? style,
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} disconnect() { disconnected = true; } },
    requestAnimationFrame: fn => { frames.set(++next, fn); return next; }, cancelAnimationFrame: id => frames.delete(id) };
  return { env, statuses, time: value => { now = value; },
    click(trusted = true) { listener({ isTrusted: trusted, target: { closest: () => ({ textContent: '取消本次迁移' }) } }); },
    frame() { const entries = [...frames]; frames.clear(); for (const [, fn] of entries) fn(); },
    mutate: () => mutation(), stopped: () => disconnected && listener === null && frames.size === 0,
    status(text, y = 10, visible = true) { const rect = { x: 10, y, left: 10, top: y, right: 310, bottom: y + 20, width: 300, height: 20 };
      return { textContent: text, isConnected: true, parentElement: null, style: { ...style, visibility: visible ? 'visible' : 'hidden' }, getBoundingClientRect: () => rect, getClientRects: () => [rect] }; } };
}

test('browser click and first visible animation frame share a clock independent of later automation polling', () => {
  const f = fixture(); installSmallAssetCancelObserver({ key: 'owned' }, f.env);
  f.time(100); f.click(); f.frame(); f.time(325); f.statuses.push(f.status('正在请求取消…')); f.mutate(); f.frame();
  f.time(1500);
  assert.equal(f.env.owned.state.firstRenderedAt - f.env.owned.state.clickAt, 225);
  assert.equal(f.env.owned.state.firstViewportAt, 325); assert.equal(f.env.owned.state.clickCount, 1); assert.equal(f.stopped(), true);
  assert.equal(f.env.owned.state.viewportStage, 'request_pending');
});

test('hidden and unrelated statuses do not count, and offscreen rendering is distinct from viewport visibility', () => {
  const f = fixture(); installSmallAssetCancelObserver({ key: 'owned' }, f.env); f.time(10); f.click(false);
  assert.equal(f.env.owned.state.clickAt, null); f.click();
  f.statuses.push(f.status('已完成保存'), f.status('正在安全停止', 10, false)); f.time(20); f.frame();
  assert.equal(f.env.owned.state.firstRenderedAt, null);
  f.statuses.push(f.status('正在安全停止', -500)); f.time(40); f.frame();
  assert.equal(f.env.owned.state.firstRenderedAt, 40); assert.equal(f.env.owned.state.firstViewportAt, null);
  f.env.owned.stop(); assert.equal(f.stopped(), true);
});
