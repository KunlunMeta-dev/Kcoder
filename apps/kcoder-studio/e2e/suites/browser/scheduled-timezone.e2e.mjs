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
await runE2E(import.meta.url, { testId: 'non-utc-calendar-schedules-and-real-one-shot', tier: 'full-integration', modelPolicy: 'model-independent browser timezone, actual schedule persistence/UTC instants and one fixture provider request' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'TZ_DONE' });
  await context.writeStateJson('profile/settings.json', { active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture', no_proxy: true,
    context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
  } } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Timezone fixture', transport: 'local', workspace, command: resolve(repoRoot, 'target/debug/kcoder') }]);
  const gateway = await startGateway(context, { workspace, serversFile, env: { KCODER_CONFIG_DIR: context.pathInState('profile'), TZ: 'UTC' } });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Tokyo' });
  const readJob = async prompt => JSON.parse(await readFile(resolve(workspace, '.kcoder/cron/jobs.json'), 'utf8')).jobs.find(job => job.prompt === prompt);
  const jobCount = async () => {
    try { return JSON.parse(await readFile(resolve(workspace, '.kcoder/cron/jobs.json'), 'utf8')).jobs.length; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  };
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
    await page.getByTestId('automation-prompt').fill('TZ_ONE_SHOT');
    await page.getByTestId('automation-kind').click(); await page.getByRole('option', { name: '执行一次', exact: true }).click();
    const expected = Math.ceil((Date.now() + 10000) / 1000) * 1000;
    const local = await page.evaluate(ms => { const date = new Date(ms); const pad = value => String(value).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`; }, expected);
    await page.getByTestId('automation-at').fill(local);
    await page.getByTestId('automation-confirm').check(); await page.getByTestId('automation-create').click();
    await page.getByTestId('automation-job').filter({ hasText: 'TZ_ONE_SHOT' }).waitFor();
    assert.equal(Date.parse((await readJob('TZ_ONE_SHOT')).schedule.at), expected);
    await waitFor(() => model.requests.some(body => JSON.stringify(body.messages).includes('TZ_ONE_SHOT')), 30000, 'actual non-UTC scheduled request');
    await page.screenshot({ path: context.pathInArtifacts('non-utc-schedules.png') });
    return { timezone: 'Asia/Tokyo', serverTimezone: 'UTC', calendarBoundaries: true, reloadPreservedNextInstant: true, oneShotRan: true };
  } finally { await page.close(); }
});
