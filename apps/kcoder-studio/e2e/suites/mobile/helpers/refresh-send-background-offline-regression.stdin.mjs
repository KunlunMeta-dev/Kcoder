import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { closeOwnedMobilePage, createRefreshProgressWriter, observeOwnedMobilePage } from './apps/kcoder-studio/e2e/suites/mobile/helpers/refresh-send-background-fixture.mjs';

const artifacts = new Map();
const runContext = {
  redactText(value) { return String(value).replaceAll('fixture-secret', '[redacted]'); },
  async writeArtifactJson(name, value) {
    if (artifacts.has(name)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    artifacts.set(name, value);
  },
};
class FakePage extends EventEmitter {
  closed = false;
  constructor(owner) { super(); this.owner = owner; }
  context() { return this.owner; }
  isClosed() { return this.closed; }
  async close() { this.closed = true; }
}
const owner = { closed: false, async close() { this.closed = true; page.closed = true; } };
const page = new FakePage(owner);
let uncaughtPageErrors = 0;
observeOwnedMobilePage(page, { runContext, pageId: 1, onPageError: () => uncaughtPageErrors++ });
page.emit('pageerror', new Error('fixture-secret page failure'));
page.emit('crash');
page.emit('console', { type: () => 'error', text: () => 'console fixture-secret' });
page.emit('requestfailed', { url: () => 'https://fixture.test/api/status?token=fixture-secret', failure: () => ({ errorText: 'net::ERR_FAILED' }) });
await closeOwnedMobilePage(page);
assert.equal(owner.closed, true, 'closing an owned mobile page must close its BrowserContext');
assert.equal(uncaughtPageErrors, 1, 'pageerror must remain connected to the suite assertion sink');
const pageArtifact = artifacts.get('phone-ux-mobile-page-errors-0001.json');
assert.ok(pageArtifact, 'observer diagnostics must flush once before the context closes');
assert.deepEqual(pageArtifact.diagnostics.map(item => item.kind), ['pageerror', 'crash', 'console', 'requestfailed']);
assert.equal(JSON.stringify(pageArtifact).includes('fixture-secret'), false, 'diagnostic artifacts must redact secrets');

const progressNames = new Set();
const progressWriter = createRefreshProgressWriter(async (name, value) => {
  if (progressNames.has(name) || artifacts.has(name)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
  progressNames.add(name);
  artifacts.set(name, value);
});
assert.equal(await progressWriter.write({ status: 'RUNNING' }), 1);
assert.equal(await progressWriter.write({ status: 'RUNNING' }), 2);
assert.equal(await progressWriter.write({ status: 'PARTIAL' }), 3);
assert.deepEqual([...progressNames], [
  'phone-ux-refresh-send-progress-0001.json',
  'phone-ux-refresh-send-progress-0002.json',
  'phone-ux-refresh-send-progress-0003.json',
]);
assert.equal(progressWriter.sequence, 3);
const terminalName = 'phone-ux-refresh-send-progress-terminal.json';
assert.equal(progressNames.has(terminalName), false, 'the terminal aggregate must have a distinct artifact path');

const suite = await readFile('./apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-ux-refresh-send-background.e2e.mjs', 'utf8');
const helper = await readFile('./apps/kcoder-studio/e2e/suites/mobile/helpers/refresh-send-background-fixture.mjs', 'utf8');
assert.match(suite, /chromium\.browser\.newContext\(/);
assert.match(suite, /browserContext\.newPage\(\)/);
assert.match(helper, /companionPage\s*=\s*await page\.context\(\)\.newPage\(\)/);
assert.match(suite, /phone-ux-refresh-send-progress-terminal\.json/);
assert.doesNotMatch(suite, /writeArtifactJson\("phone-ux-refresh-send-progress\.json"/);
console.log('PASS offline owned-context diagnostics, cleanup, secret redaction, monotonic wx-safe progress names, terminal path, and real visibility-context API source checks');
