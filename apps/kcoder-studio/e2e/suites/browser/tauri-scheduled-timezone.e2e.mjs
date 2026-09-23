import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit Tauri binary required');
await runE2E(import.meta.url, { testId: 'native-timezone-calendar-creation', tier: 'manual-live', modelPolicy: 'model-independent real native IANA timezone, schedule controls and persistent next instant' }, async context => {
  const client = await startOwnedAiVerify(context, { timezone: 'Asia/Tokyo', tauriBin: process.env.KCODER_E2E_TAURI_BIN, kcoderBin: resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist') });
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await cmd('waitFor', 'automations-button'); await cmd('click', 'automations-button');
    await cmd('waitFor', 'automation-target');
    await client.command('waitFor', { selector: '[data-testid="automation-prompt"]:enabled' });
    await cmd('fill', 'automation-prompt', { value: 'NATIVE_TZ_MONTHLY' });
    await cmd('click', 'automation-kind');
    await client.command('waitFor', { selector: '[role="option"]', text: '每月' });
    await client.command('click', { selector: '[role="option"][data-testid="automation-kind-monthly"]' });
    await cmd('waitFor', 'automation-time-of-day'); await cmd('fill', 'automation-time-of-day', { value: '00:30' });
    assert.ok((await cmd('getText', 'scheduled-tasks-panel')).includes('Asia/Tokyo'));
    await cmd('click', 'automation-confirm'); await cmd('click', 'automation-create');
    await cmd('waitFor', 'automation-job', { text: 'NATIVE_TZ_MONTHLY' });
    const file = resolve(client.runRoot, 'state/workspaces/tauri-verification/.kcoder/cron/jobs.json');
    const job = JSON.parse(await readFile(file, 'utf8')).jobs.find(job => job.prompt === 'NATIVE_TZ_MONTHLY');
    assert.deepEqual(job.schedule, { kind: 'zoned_cron', expression: '30 0 1 * *', timezone: 'Asia/Tokyo' });
    const next = new Date(job.next_run_at); assert.equal(next.getUTCHours(), 15); assert.equal(next.getUTCMinutes(), 30);
    assert.equal(new Date(next.getTime() + 9 * 3600000).getUTCDate(), 1);
    await client.capture('native-monthly-timezone.png');
    return { nativeTimezone: 'Asia/Tokyo', monthlyBoundaryCorrect: true };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
