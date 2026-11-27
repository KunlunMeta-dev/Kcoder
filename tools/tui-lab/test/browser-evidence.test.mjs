import assert from 'node:assert/strict';
import test from 'node:test';
import { captureStep } from '../lib/browser-evidence.mjs';

const healthy = {
  renderer: 'webgl',
  webglContexts: 1,
  contextLost: false,
  dimensions: { cols: 100, rows: 32 },
};

function fakePage(before, after = before) {
  let calls = 0;
  return {
    screenshots: 0,
    async evaluate() { return calls++ === 0 ? before : after; },
    async screenshot() { this.screenshots += 1; },
  };
}

test('refuses a screenshot when the WebGL context is already lost', async () => {
  const page = fakePage({ ...healthy, contextLost: true });
  const trace = [];
  await assert.rejects(captureStep(page, trace, 'welcome', '/unused.png'), /WebGL.*before/);
  assert.equal(page.screenshots, 0);
  assert.equal(trace[0].visualEvidenceValid, false);
});

test('refuses visual success when context loss happens during screenshot capture', async () => {
  const page = fakePage(healthy, { ...healthy, renderer: 'webgl-context-lost', contextLost: true });
  const trace = [];
  await assert.rejects(captureStep(page, trace, 'welcome', '/unused.png'), /WebGL.*after/);
  assert.equal(page.screenshots, 1);
  assert.equal(trace[0].renderer, 'webgl-context-lost');
  assert.equal(trace[0].visualEvidenceValid, false);
});

test('refuses DOM fallback and missing WebGL canvas evidence', async () => {
  for (const state of [{ ...healthy, renderer: 'dom-fallback:unsupported' }, { ...healthy, webglContexts: 0 }]) {
    await assert.rejects(captureStep(fakePage(state), [], 'welcome', '/unused.png'), /WebGL/);
  }
});

test('records renderer health before and after a valid capture', async () => {
  const trace = [];
  await captureStep(fakePage(healthy), trace, 'welcome', '/unused.png');
  assert.equal(trace[0].renderer, 'webgl');
  assert.equal(trace[0].visualEvidenceValid, true);
  assert.deepEqual(trace[0].rendererBefore, healthy);
  assert.deepEqual(trace[0].rendererAfter, healthy);
  assert.deepEqual(trace[0].dimensions, healthy.dimensions);
});
