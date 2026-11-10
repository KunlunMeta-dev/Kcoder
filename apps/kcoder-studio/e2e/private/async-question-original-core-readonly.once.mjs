import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { startChromium } from '../harness/chromium.mjs';
import { runE2E } from '../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'async-question-original-core-deployed-readonly', tier: 'manual-live',
  modelPolicy: 'Authorized read-only inspection of an existing public task. No answers, task inputs, model calls or platform sends.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_ASYNC_DEPLOYED_READ, '1');
  const url = new URL(process.env.KCODER_E2E_ASYNC_TASK_URL);
  assert.equal(url.protocol, 'https:');
  assert.ok(!url.hash && !url.username && !url.password);
  assert.match(url.pathname, /^\/g\/[a-f0-9]{32}\/runtime-tasks$/);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['deviceId', 'taskId']);
  const pid = Number(process.env.KCODER_E2E_ASYNC_GATEWAY_PID);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.equal((await stat(`/proc/${pid}`)).uid, process.getuid());
  const environment = Object.fromEntries((await readFile(`/proc/${pid}/environ`, 'utf8'))
    .split('\0').filter(line => line.includes('=')).map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  const token = environment.KCODER_STUDIO_AUTH_TOKEN;
  assert.ok(token);
  context.registerSecret(token);
  const browser = await startChromium(context, { startTimeoutMs: 60_000 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, ignoreHTTPSErrors: true });
  context.addCleanup('close deployed async question read page', () => page.close());
  const receipts = [], pending = new Map(), writes = [], pageErrors = [];
  let socketId = 0;
  page.on('pageerror', error => pageErrors.push(error.name));
  page.on('websocket', socket => {
    const id = ++socketId;
    socket.on('framesent', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.method === 'asyncQuestion/list') pending.set(`${id}:${message.id}`, message.params?.threadId);
        if (message.method === 'asyncQuestion/answer' || message.method === 'asyncQuestion/cancel' ||
          message.method === 'turn/start' || message.method === 'turn/steer') writes.push(message.method);
      } catch { /* Binary frames contain no observed JSON request. */ }
    });
    socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        const threadId = pending.get(`${id}:${message.id}`);
        if (!threadId) return;
        pending.delete(`${id}:${message.id}`);
        receipts.push(message.error
          ? { threadId, error: { code: message.error.code, message: message.error.message } }
          : { threadId, resultThreadId: message.result?.threadId,
            questions: message.result?.questions?.map(question => ({
              questionId: question.questionId, threadId: question.threadId,
              status: question.status, revision: question.revision,
            })) });
      } catch { /* No task text, answers or credentials are retained. */ }
    });
  });
  const login = new URL(url);
  login.pathname = login.pathname.replace(/runtime-tasks$/, 'login');
  login.search = '';
  await page.goto(login.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([
    page.waitForURL(current => !current.pathname.endsWith('/login'), { waitUntil: 'commit', timeout: 60_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  const panel = page.getByTestId('async-question-panel');
  const captures = [];
  for (const pass of ['initial', 'reload']) {
    const initialReceipts = receipts.length;
    if (pass === 'initial') await page.goto(url.href, { waitUntil: 'commit', timeout: 60_000 });
    else await page.reload({ waitUntil: 'commit', timeout: 60_000 });
    await panel.waitFor({ timeout: 90_000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="async-question-refresh"]');
      return button && !button.disabled;
    }, null, { timeout: 90_000 });
    assert.ok(receipts.length > initialReceipts, 'The actual restored task must receive an async question list receipt');
    await panel.getByTestId('async-question-toggle').click();
    captures.push({ pass, statuses: await panel.locator('article[data-status]').evaluateAll(
      cards => cards.map(card => card.getAttribute('data-status'))),
      refreshFailed: await panel.getByTestId('async-question-retry').count() > 0 });
    await panel.screenshot({ path: context.pathInArtifacts(`async-question-${pass}.png`) });
    await panel.getByTestId('async-question-refresh').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="async-question-refresh"]')?.disabled);
  }
  await context.writeArtifactJson('deployed-question-read.json', { receipts, captures, writes, pageErrors });
  assert.deepEqual(writes, []);
  assert.ok(receipts.every(receipt => !receipt.error && receipt.threadId === receipt.resultThreadId));
  assert.ok(captures.every(capture => !capture.refreshFailed && capture.statuses.includes('context_applied')));
  return { restoredTaskReads: receipts.length, captures, taskWrites: 0, modelCalls: 0 };
});
