import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startSubagentModelFixture, subagentFixtureSettings, recordSubagentTestInputs } from '../../harness/subagent-model.mjs';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('UNMET_PREREQUISITE: explicit owned Tauri binary required');
/** QA: real native Studio+Gateway+Engine, fixed SSE for layout/ownership/receipt behavior only.
 * Six Agents remain discoverable; parent and child unsent drafts survive detail close/reopen.
 * Safe token content excludes Thinking; actual dual commands and source question use shared UI.
 * Closing detail leaves a background run alive; independent stop targets a different actual run.
 * All native profiles/processes/model sockets are exclusively owned and cleaned by RunContext.
 */
await runE2E(import.meta.url, { testId: 'tauri-actual-subagent-workspace-drafts-and-interactions', tier: 'full-integration', modelPolicy: 'model-independent native Agent stream/tool/question/receipt projection with real backend', retainSuccessLogs: true }, async context => {
  const fixture = await startSubagentModelFixture(context, { streamingInspection: true, compactHistory: true });
  await recordSubagentTestInputs(context, process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist'));
  const client = await startOwnedAiVerify(context, { dropSteerReply: true, tauriBin: process.env.KCODER_E2E_TAURI_BIN, kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist') });
  const command = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  const count = selector => client.command('getElementCount', { selector }).then(Number);
  try {
    await command('waitFor', 'desktop-sidebar');
    const key = 'owned-native-subagent-fixture'; context.registerSecret(key);
    await writeFile(resolve(dirname(client.settingsPath), 'credentials.json'), JSON.stringify({ fixture: { type: 'api', key } }), { mode: 0o600 });
    await writeFile(client.settingsPath, JSON.stringify(subagentFixtureSettings(fixture.baseUrl)), { mode: 0o600 });
    await client.command('navigate', { value: '/settings/personal/models' });
    await command('waitFor', 'provider-edit-fixture::fixture');
    await client.command('navigate', { value: '/' });
    await command('waitFor', 'model-selector-button', { enabled: true, timeoutMs: 15000 });
    await command('waitFor', 'project-new-conversation-button', { enabled: true, timeoutMs: 15000 });
    await command('click', 'project-new-conversation-button');
    await command('waitFor', 'model-selector-button', { enabled: true, timeoutMs: 15000 });
    await command('fill', 'chat-message-input', { value: 'S03_START' });
    await command('waitFor', 'send-message-button', { enabled: true });
    await command('click', 'send-message-button');
    await command('waitFor', 'request-user-input-card', { text: 'S03_ACTUAL_FOREGROUND_QUESTION', timeoutMs: 30000 });
    await command('click', 'request-user-input-option-question-1-0');
    await command('waitFor', 'message-assistant', { text: 'S03_PARENT_DONE', timeoutMs: 60000 });
    await waitFor(() => fixture.observations.filter(value => value.kind === 'spawn').length === 6, 15000, 'six source Agent identities');
    const primary = fixture.observations.find(value => value.kind === 'spawn' && value.tag === 'primary').agentId;
    const stoppable = fixture.observations.find(value => value.kind === 'spawn' && value.tag === 'stoppable').agentId;
    await command('fill', 'chat-message-input', { value: 'S03_PARENT_UNSENT_DRAFT' });
    const open = async id => {
      if (await count('[data-testid="subagent-detail-open"]') === 0) {
        await command('waitFor', 'subagent-status-toggle-button', { timeoutMs: 10000 });
        await command('click', 'subagent-status-toggle-button');
      }
      await waitFor(async () => await count('[data-testid="subagent-detail-open"]') === 6, 10000, 'all six clickable Agents');
      await client.command('click', { selector: `[data-testid="subagent-status-item"][data-agent-id="${id}"] [data-testid="subagent-detail-open"]` });
      await command('waitFor', 'subagent-workspace');
    };
    await open(primary);
    await command('waitFor', 'subagent-workspace-records', { text: 'S03_LIVE_VISIBLE', timeoutMs: 15000 });
    assert.ok(!(await command('getText', 'subagent-workspace-records')).includes('S03_PRIVATE_THINKING'));
    await client.command('waitFor', { selector: '[data-testid="subagent-workspace-records"] [data-testid="message-assistant"]', visible: true });
    assert.match(await command('getText', 'subagent-workspace-back'), /Return to main agent|返回主代理/);
    await client.capture('subagent-conversation.png');
    fixture.release('primary-stream-second');
    await command('waitFor', 'subagent-workspace-records', { text: 'S03_SECOND_LIVE_DELTA', timeoutMs: 2000 });
    assert.ok(!(await command('getText', 'subagent-workspace-records')).includes('S03_THIRD_LIVE_DELTA'), 'second delta is visible while the third and final response remain gated');
    fixture.release('primary-stream-third');
    await command('waitFor', 'subagent-workspace-records', { text: 'S03_THIRD_LIVE_DELTA', timeoutMs: 2000 });
    await client.capture('subagent-live-incremental.png');
    await command('fill', 'subagent-workspace-input', { value: 'S03_CHILD_UNSENT_DRAFT' });
    await command('click', 'subagent-workspace-back');
    await command('waitFor', 'chat-message-input', { text: 'S03_PARENT_UNSENT_DRAFT' });
    await open(primary);
    assert.equal(await command('getValue', 'subagent-workspace-input'), 'S03_CHILD_UNSENT_DRAFT', 'child draft survives unmount and reopen');
    await command('waitFor', 'subagent-workspace-records', { text: 'S03_LIVE_VISIBLE', timeoutMs: 5000 });
    fixture.release('primary-model');
    await client.command('waitFor', { selector: '[data-testid="subagent-workspace"] [data-testid="processing-summary-header"]', timeoutMs: 3000 });
    if (await count('[data-testid="subagent-workspace"] [data-testid="processing-summary-toggle"]')) {
      await client.command('click', { selector: '[data-testid="subagent-workspace"] [data-testid="processing-summary-toggle"]' });
    }
    await client.command('waitFor', { selector: '[data-testid="subagent-workspace"] [data-tool-detail-toggle]', timeoutMs: 3000 });
    await client.command('click', { selector: '[data-testid="subagent-workspace"] [data-tool-detail-toggle]' });
    for (const message of ['S03_ADJUST_ONE', 'S03_ADJUST_TWO']) {
      await command('fill', 'subagent-workspace-input', { value: message });
      await command('waitFor', 'subagent-workspace-send', { enabled: true });
      await command('click', 'subagent-workspace-send');
    }
    await client.command('waitFor', { selector: '[data-testid="subagent-workspace"] [data-testid="request-user-input-card"]', text: 'S03_ACTUAL_AGENT_QUESTION', timeoutMs: 30000 });
    await client.command('click', { selector: '[data-testid="subagent-workspace"] [data-testid="request-user-input-option-question-1-0"]' });
    await client.command('waitFor', { selector: '[data-testid="subagent-workspace"] [data-testid="request-user-input-card"]', text: 'S03_AGENT_IGNORE_QUESTION', timeoutMs: 15000 });
    fixture.release('stoppable-question');
    await waitFor(() => fixture.observations.some(value => value.tag === 'stoppable' && value.kind === 'worker-request'), 10000, 'other Agent remains active');
    await client.command('click', { selector: '[data-testid="subagent-workspace"] [data-testid="request-user-input-ignore-button"]' });
    await command('waitFor', 'subagent-workspace-records', { text: 'S03_AGENT_DONE', timeoutMs: 30000 });
    await waitFor(async () => await count('[data-testid="subagent-workspace"] .animate-spin') === 0, 5000, 'terminal event settles the last streamed response');
    assert.equal(Number(await client.command('getElementCount', { selector: '[data-testid="subagent-workspace"] .animate-spin' })), 0, 'completed worker has no active tool or summary spinner');
    if (await count('[data-testid="subagent-workspace"] [data-testid="final-processing-toggle"]')) {
      await client.command('click', { selector: '[data-testid="subagent-workspace"] [data-testid="final-processing-toggle"]' });
    }
    for (const selector of [
      '[data-testid="subagent-workspace"] [data-testid="processing-summary-toggle"]',
      '[data-testid="subagent-workspace"] [data-tool-detail-toggle]',
    ]) {
      if (await count(selector) && await client.command('getAttribute', { selector, value: 'aria-expanded' }) === 'false') {
        await client.command('click', { selector });
      }
    }
    await client.command('waitFor', { selector: '[data-testid="subagent-workspace"] [data-testid="shell-tool-output"]', text: 'S03_TOOL_DONE', timeoutMs: 5000 });
    await client.capture('subagent-conversation-final.png');
    const commands = await command('getText', 'subagent-workspace-records');
    const userCommands = await client.command('getText', { selector: '[data-testid="subagent-workspace"] [data-testid="message-user"] [data-testid="user-message-content"]' });
    await context.writeArtifactJson('public-fixture-conversation.json', { text: commands, userText: userCommands });
    assert.ok(commands.includes('S03_LIVE_VISIBLE'), 'first snapshot text survives reopen and tool completion');
    assert.ok(commands.includes('S03_TOOL_DONE'), 'the actual recorded command result is visible in the ordinary tool detail');
    assert.ok(!/暂不可识别|Unrecognized/.test(commands), 'ordinary built-in tools retain their names and renderer');
    assert.ok(commands.includes('S03_ADJUST_ONE') && commands.includes('S03_ADJUST_TWO'));
    assert.equal(await count('[data-testid="subagent-workspace"] [data-testid="request-user-input-card"]'), 0);
    const fault = await waitFor(async () => {
      const value = await readFile(resolve(client.runRoot, 'artifacts/steer-reply-fault.json'), 'utf8').then(JSON.parse).catch(() => null);
      return value?.journalObservations > 0 ? value : null;
    }, 15000, 'actual lost Agent acknowledgement recovered only by authoritative journal observation');
    assert.equal(fault.committedReplyDropped, true); assert.equal(fault.steerReplies, 2);
    assert.equal((userCommands.match(/S03_ADJUST_ONE/g) || []).length, 1);
    assert.equal((userCommands.match(/S03_ADJUST_TWO/g) || []).length, 1);
    assert.ok(!commands.includes('S03_PRIVATE_THINKING'));
    await command('fill', 'subagent-workspace-input', { value: 'S03_ADJUST_AFTER_COMPLETE' });
    await command('waitFor', 'subagent-workspace-send', { enabled: true });
    await command('click', 'subagent-workspace-send');
    await command('waitFor', 'subagent-workspace-records', { text: 'S03_RESUMED_AGENT_DONE', timeoutMs: 30000 });
    await waitFor(async () => await count('[data-testid="subagent-workspace"] .animate-spin') === 0, 5000, 'resumed run settles without closing the child view');
    await command('click', 'subagent-workspace-back');
    await open(stoppable);
    await client.command('waitFor', { selector: '[data-testid="subagent-workspace"] [data-testid="request-user-input-card"]', text: 'S03_OTHER_PENDING_QUESTION', timeoutMs: 15000 });
    await command('waitFor', 'subagent-workspace-stop', { enabled: true });
    await command('click', 'subagent-workspace-stop');
    await command('waitFor', 'subagent-workspace-stop-status', { timeoutMs: 15000 });
    assert.match(await command('getText', 'subagent-workspace-stop-status'), /stopped|已停止/);
    await command('click', 'subagent-workspace-back');
    await command('waitFor', 'chat-message-input', { text: 'S03_PARENT_UNSENT_DRAFT' });
    assert.equal(fixture.observations.filter(value => value.kind === 'worker-request' && value.tag === 'primary').length, 5);
    assert.ok(!fixture.observations.some(value => value.kind === 'error'));
    await context.writeArtifactJson('native-subagent-summary.json', { native: true, clickableAgents: 6, primary, stoppable, safeLiveAndHistory: true, parentDraftPreserved: true, childDraftPreserved: true, sharedSourceQuestion: true, independentStop: true });
    return { native: true, clickableAgents: 6, parentDraftPreserved: true, childDraftPreserved: true, safeLive: true, sourceQuestion: true, independentStop: true, unknownRecoveredByAuthority: true };
  } catch (error) { client.markFailed(); await client.capture('subagent-workspace-failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
