import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'non-utc-calendar-schedules-and-real-one-shot', tier: 'full-integration', modelPolicy: 'model-independent browser timezone, actual schedule persistence/UTC instants, one-shot receipt/history and one fixture provider request' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'TZ_DONE' });
  await context.writeStateJson('profile/settings.json', { active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture', no_proxy: true,
    context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
  } } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Timezone fixture', transport: 'local', workspace, command: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder') }]);
  const gateway = await startGateway(context, { workspace, serversFile, startTimeoutMs: 300_000, env: { KCODER_CONFIG_DIR: context.pathInState('profile'), TZ: 'UTC' } });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Tokyo' });
  const cronFile = resolve(workspace, '.kcoder/cron/jobs.json');
  const readCronFile = async () => JSON.parse(await readFile(cronFile, 'utf8'));
  const readJob = async prompt => (await readCronFile()).jobs.find(job => job.prompt === prompt);
  const jobCount = async () => {
    try { return (await readCronFile()).jobs.length; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  };
  const oneShotStarts = [];
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const errorResponses = [];
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const message = JSON.parse(String(frame.payload));
      if (message.method === 'automation/runStarted' && message.params?.title === 'TZ_ONE_SHOT')
        oneShotStarts.push(message.params);
    } catch { /* Non-JSON frames do not affect this assertion. */ }
  }));
  page.on('console', message => {
    if (message.type() === 'error' && consoleErrors.length < 100)
      consoleErrors.push(message.text().slice(0, 500));
  });
  page.on('pageerror', error => {
    if (pageErrors.length < 100) pageErrors.push(error.message.slice(0, 1000));
  });
  page.on('requestfailed', request => {
    if (failedRequests.length >= 100) return;
    const url = new URL(request.url());
    failedRequests.push({ method: request.method(), path: url.pathname, failure: request.failure()?.errorText ?? null });
  });
  page.on('response', response => {
    if (response.status() < 400 || errorResponses.length >= 100) return;
    const url = new URL(response.url());
    errorResponses.push({ status: response.status(), path: url.pathname });
  });
  try {
    await page.goto(gateway.baseUrl);
    await page.getByTestId('automations-button').click();
    await page.getByTestId('automation-target').locator('option').first().waitFor({ state: 'attached' });
    for (const [label, marker, expression] of [['每周', 'TZ_WEEKLY', '30 0 * * 1'], ['每工作日', 'TZ_WEEKDAY', '30 0 * * 1-5'], ['每月', 'TZ_MONTHLY', '30 0 1 * *']]) {
      await page.getByTestId('automation-tab-settings').click();
      await page.getByTestId('automation-prompt').fill(marker);
      await page.getByTestId('automation-kind').click(); await page.getByRole('option', { name: label, exact: true }).click();
      await page.getByTestId('automation-time-of-day').fill('00:30');
      const countBefore = await jobCount();
      await waitFor(async () => (await page.getByTestId('automation-preview').innerText()).includes('下一次计划时间'), 10000, 'target schedule preview');
      assert.equal(await jobCount(), countBefore, 'preview must not create a job');
      assert.doesNotMatch(await page.getByTestId('scheduled-tasks-panel').innerText(), /\{(?:time|timezone|schedule|count)\}/);
      await page.getByTestId('automation-confirm').check(); await page.getByTestId('automation-create').click();
      await page.getByTestId('automation-job').filter({ hasText: marker }).waitFor();
      const job = await readJob(marker);
      assert.deepEqual(job.schedule, { kind: 'zoned_cron', expression, timezone: 'Asia/Tokyo' });
      const next = new Date(job.next_run_at);
      assert.equal(next.getUTCHours(), 15); assert.equal(next.getUTCMinutes(), 30);
      if (marker === 'TZ_WEEKLY') assert.equal(next.getUTCDay(), 0);
      if (marker === 'TZ_WEEKDAY') assert.ok([0,1,2,3,4].includes(next.getUTCDay()));
      if (marker === 'TZ_MONTHLY') {
        const local = new Date(next.getTime() + 9 * 3600000);
        assert.equal(local.getUTCDate(), 1);
      }
    }
    const original = (await readJob('TZ_MONTHLY')).next_run_at;
    await page.reload(); await page.getByTestId('scheduled-tasks-panel').waitFor();
    assert.equal((await readJob('TZ_MONTHLY')).next_run_at, original);
    await page.getByTestId('automation-tab-settings').click();
    await page.getByTestId('automation-prompt').fill('INVALID_CRON_MUST_NOT_SAVE');
    await page.getByTestId('automation-kind').click();
    await page.getByTestId('automation-kind-cron').click();
    await page.getByTestId('automation-cron').fill('61 0 * * *');
    await waitFor(async () => (await page.getByTestId('automation-preview').innerText()).includes('无法预览'), 10000, 'invalid schedule preview');
    await page.getByTestId('automation-confirm').check();
    await page.getByTestId('automation-create').click();
    await page.getByRole('alert').waitFor();
    assert.equal(await jobCount(), 3);
    await page.getByRole('button', { name: '我已核对记录，开始新的操作', exact: true }).click();
    await page.getByTestId('automation-prompt').fill('TZ_ONE_SHOT');
    await page.getByTestId('automation-kind').click(); await page.getByRole('option', { name: '执行一次', exact: true }).click();
    const expected = Math.ceil((Date.now() + 10000) / 1000) * 1000;
    const local = await page.evaluate(ms => { const date = new Date(ms); const pad = value => String(value).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`; }, expected);
    await page.getByTestId('automation-at').fill(local);
    await page.getByTestId('automation-confirm').check(); await page.getByTestId('automation-create').click();
    await page.getByTestId('automation-job').filter({ hasText: 'TZ_ONE_SHOT' }).waitFor();
    const oneShotJob = await readJob('TZ_ONE_SHOT');
    assert.equal(Date.parse(oneShotJob.schedule.at), expected);
    await waitFor(() => model.requests.some(body => JSON.stringify(body.messages).includes('TZ_ONE_SHOT')), 30000, 'actual non-UTC scheduled request');
    await page.getByTestId('automation-tab-history').click();
    await page.getByTestId('automation-run-history').waitFor();
    await page.getByTestId('automation-runs-refresh').click();
    const successfulOneShotHistory = page.locator('[data-testid="automation-run"][data-status="succeeded"]').filter({ hasText: 'TZ_ONE_SHOT' });
    await successfulOneShotHistory.waitFor({ timeout: 30000 });
    await waitFor(async () => {
      const receipts = (await readCronFile()).receipts.filter(receipt => receipt.job_id === oneShotJob.id);
      return receipts.length === 1 && receipts[0].execution?.status === 'succeeded' ? receipts : null;
    }, 30000, 'single successful one-shot execution receipt');
    await new Promise(resolve => setTimeout(resolve, 2100));
    await page.getByTestId('automation-runs-refresh').click();
    await successfulOneShotHistory.waitFor({ timeout: 15000 });
    assert.equal(await successfulOneShotHistory.count(), 1, 'one-shot must appear once in execution history');
    assert.equal(model.requests.filter(body => JSON.stringify(body.messages).includes('TZ_ONE_SHOT')).length, 1,
      'one-shot must send one provider request');
    const oneShotRunStartedDeliveries = oneShotStarts.filter(params => params.jobId === oneShotJob.id);
    const runStartedRequestIds = oneShotRunStartedDeliveries.map(params =>
      typeof params.requestId === 'string' && params.requestId ? params.requestId : null);
    const distinctRunStartedRequestIds = new Set(runStartedRequestIds.filter(id => id !== null));
    assert.ok(distinctRunStartedRequestIds.size <= 1,
      'one-shot must not publish multiple distinct run-start request IDs');
    const oneShotRunStartIdentityVerified = runStartedRequestIds.length > 0
      && runStartedRequestIds.every(id => id !== null)
      && distinctRunStartedRequestIds.size === 1;
    const oneShotReceipts = (await readCronFile()).receipts.filter(receipt => receipt.job_id === oneShotJob.id);
    assert.equal(oneShotReceipts.length, 1);
    assert.equal(oneShotReceipts[0].execution.status, 'succeeded');
    assert.equal(Date.parse(oneShotReceipts[0].scheduled_at), expected);
    await page.screenshot({ path: context.pathInArtifacts('non-utc-schedules.png') });
    return {
      timezone: 'Asia/Tokyo',
      serverTimezone: 'UTC',
      calendarBoundaries: true,
      reloadPreservedNextInstant: true,
      oneShotRanOnce: true,
      oneShotHistorySucceeded: true,
      runStartedFrameDeliveries: oneShotRunStartedDeliveries.length,
      runStartedRequestIdentityVerified: oneShotRunStartIdentityVerified,
      runStartedRequestIdByDelivery: oneShotRunStartedDeliveries.map(({ jobId, requestId }) => ({
        jobId,
        requestId: typeof requestId === 'string' ? requestId : null,
      })),
    };
  } catch (error) {
    const dom = await page.evaluate(() => ({
      title: document.title,
      path: location.pathname,
      readyState: document.readyState,
      bodyText: document.body?.innerText?.slice(0, 5000) ?? '',
      testIds: Array.from(document.querySelectorAll('[data-testid]'))
        .slice(0, 100)
        .map(element => element.getAttribute('data-testid')),
      scripts: Array.from(document.scripts)
        .slice(0, 30)
        .map(script => script.src ? new URL(script.src, location.href).pathname : null),
    })).catch(failure => ({ captureError: String(failure).slice(0, 500) }));
    await page.screenshot({ path: context.pathInArtifacts('browser-failure.png') }).catch(() => undefined);
    await context.writeArtifactJson('browser-failure-diagnostics.json', {
      error: String(error).slice(0, 2000),
      consoleErrors,
      pageErrors,
      failedRequests,
      errorResponses,
      oneShotRunStartedDeliveries: oneShotStarts
        .map(({ jobId, requestId }) => ({ jobId, requestId: typeof requestId === 'string' ? requestId : null })),
      dom,
    });
    throw error;
  } finally { await page.close(); }
});
