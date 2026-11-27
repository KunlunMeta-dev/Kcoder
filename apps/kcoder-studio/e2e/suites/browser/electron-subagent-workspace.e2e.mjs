import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startSubagentModelFixture, subagentFixtureSettings, recordSubagentTestInputs } from '../../harness/subagent-model.mjs';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_ELECTRON_BIN) throw new Error('UNMET_PREREQUISITE: explicit owned Electron binary required');
/** QA: real native Studio+Gateway+Engine, fixed SSE for layout/ownership/receipt behavior only.
 * Six Agents remain discoverable; parent and child unsent drafts survive detail close/reopen.
 * The owner can open the child's reasoning. A child routes questions to its parent;
 * only the parent's explicit question opens the shared user-input card.
 * Closing detail leaves a background run alive; independent stop targets a different actual run.
 * All native profiles/processes/model sockets are exclusively owned and cleaned by RunContext.
 */
await runE2E(import.meta.url, { testId: 'electron-actual-subagent-workspace-drafts-and-interactions', tier: 'full-integration', modelPolicy: 'model-independent native Agent stream/tool/question/receipt projection with real backend', retainSuccessLogs: true }, async context => {
  const fixture = await startSubagentModelFixture(context, { streamingInspection: true, compactHistory: true });
  await recordSubagentTestInputs(context, process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist'));
  const client = await startOwnedAiVerify(context, { dropSteerReply: true, electronBin: process.env.KCODER_E2E_ELECTRON_BIN, kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist') });
  const command = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  const count = selector => client.command('getElementCount', { selector }).then(Number);
  const bounds = async selector => JSON.parse(await client.command('getElementMetrics', { selector }))[0];
  const childScope = '[data-testid="subagent-workspace"]';
  const sidebarSelector = '[data-testid="desktop-sidebar"]';
  const narrowWindow = { width: 980, height: 720 };
  const resizeNarrow = async () => {
    await client.command('resizeWindow', { value: `${narrowWindow.width}x${narrowWindow.height}` });
    return waitFor(async () => {
      const body = await bounds('body');
      return body.width === narrowWindow.width ? body : null;
    }, 5000, 'narrow Electron viewport');
  };
  const returnWithPointer = async viewport => {
    const back = await bounds('[data-testid="subagent-workspace-back"]');
    const x = Math.round(back.left + back.width / 2);
    // Under the owned Xvfb, the native menu bar takes the space above the viewport.
    const y = Math.round(narrowWindow.height - viewport.height + back.top + back.height / 2);
    await client.command('dragPointer', { value: `${x},${y}:${x},${y}` });
    await waitFor(async () => await count(childScope) === 0, 5000, 'native pointer returns to the parent');
    await command('waitFor', 'chat-message-input', { text: 'S03_PARENT_UNSENT_DRAFT', visible: true });
    await command('waitFor', 'desktop-sidebar', { visible: true });
  };
  const expandChildControls = async selector => {
    const closed = `${childScope} ${selector}[aria-expanded="false"]`;
    const total = await count(closed);
    for (let i = 0; i < total && await count(closed); i++) await client.command('click', { selector: closed });
  };
  const revealProcessGroups = async () => {
    for (const id of ['final-processing-toggle', 'processing-window-toggle', 'process-activity-toggle', 'processing-summary-toggle']) {
      await expandChildControls(`[data-testid="${id}"]`);
    }
  };
  const openParentInteraction = async question => {
    const selector = `[data-status-item^="interaction:"] button[title*="${question}"]`;
    await client.command('waitFor', { selector, timeoutMs: 30000 });
    assert.equal(await client.command('getAttribute', { selector, value: 'aria-expanded' }), 'false');
    await client.command('click', { selector });
  };
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
    await openParentInteraction('S03_ACTUAL_FOREGROUND_QUESTION');
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
    await revealProcessGroups();
    const thinkingToggle = `${childScope} [data-testid="assistant-thinking-toggle"]`;
    await client.command('waitFor', { selector: thinkingToggle, timeoutMs: 5000 });
    assert.equal(await client.command('getAttribute', { selector: thinkingToggle, value: 'aria-expanded' }), 'false');
    await client.command('click', { selector: thinkingToggle });
    await command('waitFor', 'assistant-thinking-content', { text: 'S03_PRIVATE_THINKING', timeoutMs: 5000 });
    await client.command('click', { selector: thinkingToggle });
    assert.equal(await count(`${childScope} [data-testid="assistant-thinking-content"]`), 0);
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
    const viewport = await resizeNarrow();
    const sidebar = await bounds(sidebarSelector);
    const header = await bounds('[data-testid="workbench-main-header"]');
    const child = await bounds(childScope);
    await context.writeArtifactJson('subagent-narrow-bounds.json', { narrowWindow, viewport, sidebar, header, child });
    await client.capture('subagent-narrow-sidebar.png');
    assert.ok(sidebar.width > 0 && child.left >= sidebar.right - 1, 'the child leaves the expanded sidebar visible');
    assert.ok(child.top >= header.bottom - 1, 'the child starts below the draggable workbench header');
    await returnWithPointer(viewport);
    await client.command('resizeWindow', { value: '1280x800' });
    await open(primary);
    assert.equal(await command('getValue', 'subagent-workspace-input'), 'S03_CHILD_UNSENT_DRAFT', 'child draft survives unmount and reopen');
    await command('waitFor', 'subagent-workspace-records', { text: 'S03_LIVE_VISIBLE', timeoutMs: 5000 });
    for (const message of ['S03_ADJUST_ONE', 'S03_ADJUST_TWO']) {
      await command('fill', 'subagent-workspace-input', { value: message });
      await command('waitFor', 'subagent-workspace-send', { enabled: true });
      await command('click', 'subagent-workspace-send');
    }
    fixture.release('primary-model');
    await waitFor(() => fixture.observations.filter(value => value.tag === 'primary' && value.kind === 'child-question-guidance').length === 2, 30000, 'both child questions return parent guidance');
    assert.deepEqual(fixture.observations.filter(value => value.tag === 'primary' && value.kind === 'child-question-guidance').map(value => value.count), [2, 3]);
    assert.equal(await count(`${childScope} [data-status-item^="interaction:"]`), 0);
    await command('waitFor', 'subagent-workspace-records', { text: 'S03_AGENT_DONE', timeoutMs: 30000 });
    await waitFor(async () => await count('[data-testid="subagent-workspace"] .animate-spin') === 0, 5000, 'terminal event settles the last streamed response');
    assert.equal(Number(await client.command('getElementCount', { selector: '[data-testid="subagent-workspace"] .animate-spin' })), 0, 'completed worker has no active tool or summary spinner');
    // Completed messages share the main conversation's virtualized list. Navigate to
    // each turn before inspecting its rendered body instead of counting off-screen DOM.
    const marker = index => `${childScope} [data-testid="message-turn-navigation-marker"][data-turn-index="${index}"]`;
    const promptSelector = `${childScope} [data-testid="message-user"] [data-testid="user-message-content"]`;
    await client.command('click', { selector: marker(0) });
    await client.command('waitFor', { selector: promptSelector, text: 'S03_WORKER_primary', timeoutMs: 5000 });
    await revealProcessGroups();
    await expandChildControls('[data-tool-detail-toggle][aria-label*="bash" i]');
    const shellOutput = await client.command('waitFor', { selector: `${childScope} [data-testid="shell-tool-output"]`, text: 'S03_TOOL_DONE', timeoutMs: 5000 });
    await client.capture('subagent-conversation-final.png');
    const commands = await command('getText', 'subagent-workspace-records');
    assert.ok(commands.includes('S03_LIVE_VISIBLE'), 'first snapshot text survives reopen and tool completion');
    assert.ok(!/暂不可识别|Unrecognized/.test(commands), 'ordinary built-in tools retain their names and renderer');
    const promptPreviews = await client.command('getText', { selector: `${childScope} [data-testid="message-turn-navigation-preview"] > p:first-child` });
    const adjustments = ['S03_ADJUST_ONE', 'S03_ADJUST_TWO'];
    for (const [index, message] of adjustments.entries()) {
      assert.equal(promptPreviews.split('\n').filter(prompt => prompt === message).length, 1);
      await client.command('click', { selector: marker(index + 1) });
      const userText = await client.command('waitFor', { selector: promptSelector, text: message, timeoutMs: 5000 });
      assert.equal(userText.split('\n').filter(prompt => prompt === message).length, 1);
    }
    await context.writeArtifactJson('collapsed-fixture-conversation.json', { text: commands, promptPreviews, shellOutput });
    assert.equal(await count('[data-testid="subagent-workspace"] [data-testid="request-user-input-card"]'), 0);
    const fault = await waitFor(async () => {
      const value = await readFile(resolve(client.runRoot, 'artifacts/steer-reply-fault.json'), 'utf8').then(JSON.parse).catch(() => null);
      return value?.journalObservations > 0 ? value : null;
    }, 15000, 'actual lost Agent acknowledgement recovered only by authoritative journal observation');
    assert.equal(fault.committedReplyDropped, true); assert.equal(fault.steerReplies, 2);
    assert.ok(!commands.includes('S03_PRIVATE_THINKING'));
    await command('fill', 'subagent-workspace-input', { value: 'S03_ADJUST_AFTER_COMPLETE' });
    await command('waitFor', 'subagent-workspace-send', { enabled: true });
    await command('click', 'subagent-workspace-send');
    await command('waitFor', 'subagent-workspace-records', { text: 'S03_RESUMED_AGENT_DONE', timeoutMs: 30000 });
    await waitFor(async () => await count('[data-testid="subagent-workspace"] .animate-spin') === 0, 5000, 'resumed run settles without closing the child view');
    await command('click', 'subagent-workspace-back');
    await open(stoppable);
    await command('waitFor', 'subagent-workspace-records', { text: 'S03_LIVE_stoppable', timeoutMs: 15000 });
    assert.equal(await count(`${childScope} [data-status-item^="interaction:"]`), 0);
    await command('waitFor', 'subagent-workspace-stop', { enabled: true });
    await command('click', 'subagent-workspace-stop');
    await command('waitFor', 'subagent-workspace-stop-status', { timeoutMs: 15000 });
    assert.match(await command('getText', 'subagent-workspace-stop-status'), /stopped|已停止/);
    await command('press', 'subagent-workspace-back', { key: 'Escape' });
    await waitFor(async () => await count(childScope) === 0, 5000, 'Escape returns to the parent');
    await command('waitFor', 'chat-message-input', { text: 'S03_PARENT_UNSENT_DRAFT' });
    const boardViewport = await resizeNarrow();
    await command('click', 'task-workspace-button');
    const taskRow = '[data-testid="task-board-list-row"] > button:has([title="S03_START"])';
    await client.command('waitFor', { selector: taskRow, visible: true });
    await client.command('click', { selector: taskRow });
    const memberOpen = '[data-reference-kind="agent"] [data-testid^="task-workspace-open-reference-"]';
    await client.command('waitFor', { selector: memberOpen });
    await client.command('click', { selector: memberOpen });
    await command('waitFor', 'subagent-workspace', { visible: true });
    const boardSidebar = await bounds(sidebarSelector);
    assert.ok(boardSidebar.width > 0 && (await bounds(childScope)).left >= boardSidebar.right - 1,
      'the task member view leaves the expanded sidebar visible');
    await returnWithPointer(boardViewport);
    assert.equal(fixture.observations.filter(value => value.kind === 'worker-request' && value.tag === 'primary').length, 5);
    assert.ok(!fixture.observations.some(value => value.kind === 'error'));
    const summary = { native: true, clickableAgents: 6, narrowSidebarVisible: true, nativePointerBack: true, escapeBack: true, taskBoardMemberBack: true, ownedReasoningShownOnExpand: true, parentDraftPreserved: true, childDraftPreserved: true, childQuestionsReturnedToParent: 2, parentQuestionAnswered: true, independentStop: true, unknownRecoveredByAuthority: true };
    await context.writeArtifactJson('native-subagent-summary.json', { ...summary, primary, stoppable });
    return summary;
  } catch (error) {
    client.markFailed();
    await client.capture('subagent-workspace-failure.png').catch(() => {});
    await context.writeArtifactJson('fixture-rows-on-failure.json', {
      tools: (await client.command('getText', { selector: `${childScope} [data-processing-block-id]` }).catch(() => '')).slice(0, 6000),
      shell: (await client.command('getText', { selector: `${childScope} [data-testid="shell-tool-output"]` }).catch(() => '')).slice(0, 2000),
    });
    throw error;
  }
  finally { await client.stop(); }
});
