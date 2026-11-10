import assert from 'node:assert/strict';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
import { runMigrationGuideDialog } from '../../harness/migration-guide-dialog.mjs';
import { migrationReplyLossProxy } from '../../harness/migration-reply-loss-proxy.mjs';
import { chromium } from '../../../renderer/node_modules/@playwright/test/index.mjs';

/** Actual CLI prompt transport, not a model or terminal emulator. Parent owns Gateway fixtures. */
export async function exerciseTerminalGuide({ context, binary, gateway, token, workspace, source, targetProfile, originalSettings }) {
  const cache = context.pathInState('terminal-guide-cache');
  await mkdir(cache, { mode: 0o700 });
  const record = resolve(cache, 'record.json');
  const transport = await migrationReplyLossProxy(context, gateway, 'adoption-prepare');
  await rename(`${source}.withheld`, source);
  const transcripts = [], observations = [];
  let runs = 0, access = token, staleAnswerSent = false;
  async function guide(answer) {
    const label = `interactive-terminal-guide-${++runs}`;
    await runMigrationGuideDialog({ context, binary, gateway: transport.baseUrl, token: access, workspace, record,
      label, args: ['--include-history'], staleAnswer: !staleAnswerSent,
      answer: async frame => {
        const value = await answer(frame);
        transcripts.push({ run: runs, code: frame.code, answer: value });
        return value;
      },
      observe: frame => {
        if (frame.code === 'migration_guide_stale_answer') staleAnswerSent = true;
        if (frame.type === 'prompt') return;
        observations.push({ run: runs, type: frame.type, code: frame.code, result: frame.result });
        if (frame.type === 'notice' && /failed|invalid|outcome_unknown|scope_changed/.test(frame.code || '') && frame.code !== 'source_transfer_outcome_unknown')
          throw new Error(`Unexpected guide diagnostic: ${frame.code}`);
      },
    });
  }
  let menu = 0, sourceSelected = false, historySelected = false, batchMenu = 0;
  await guide(frame => {
    const { code, choices } = frame;
    if (code === 'transfer_source_target') return String(choices.items.find(row => row.targetId === 'source').number);
    if (code === 'transfer_destination') return String(choices.items.find(row => row.targetId === 'destination').number);
    if (code === 'source') return 'claude-code';
    if (code === 'transfer_source_directory') return 'default';
    if (code === 'transfer_menu') {
      if (menu < 3) return ['select', 'copy', 'adopt'][menu++];
      if (menu === 3) {
        const state = observations.findLast(row => row.type === 'adoption_state')?.result?.state;
        if (state?.phase !== 'preview_ready' || state.workerState !== 'stopped') return 'adoption-read';
        menu++; return 'batch';
      }
      return ['release', 'quit'][menu++ - 4];
    }
    if (code === 'transfer_sources') {
      if (!sourceSelected) { sourceSelected = true; return `toggle ${choices.items.find(row => row.scope === 'user-instructions').number}`; }
      return 'done';
    }
    if (code === 'history_selection') {
      if (choices.page === 0) return 'next';
      if (!historySelected) { historySelected = true; return 'toggle 1'; }
      return 'done';
    }
    if (code === 'transfer_received_selection') {
      const item = choices.items.find(row => !row.selected); return item ? `toggle ${item.number}` : 'done';
    }
    if (code === 'transfer_batch_job') return '1';
    if (code === 'transfer_batch_menu') return ['select', 'apply', 'back'][batchMenu++];
    if (code === 'transfer_batch_selection') {
      const item = choices.items.find(row => !row.selected); return item ? `toggle ${item.number}` : 'preview';
    }
    if (code === 'target_name') return 'guide-received-instructions';
    if (code === 'enable_asset' || code === 'reuse') return 'no';
    if (code === 'transfer_batch_confirm') return 'IMPORT';
    if (['transfer_copy_confirm', 'transfer_adoption_confirm', 'transfer_release_confirm'].includes(code)) return 'yes';
    assert.fail(`Unhandled interactive question: ${code}`);
  });
  const first = JSON.parse(await readFile(record, 'utf8'));
  assert.ok(observations.some(row => row.code === 'migration_guide_stale_answer'));
  assert.equal(first.copyPrepared, true); assert.equal(first.adoptionPrepared, true);
  assert.equal(first.selections.length, 2);
  assert.equal(transport.dropped(), 1);
  const published = observations.findLast(row => row.type === 'remote_batch_state' && row.result?.state?.job?.status === 'completed');
  assert.ok(published, 'guided publication needs the actual Native completed checkpoint');
  assert.equal(published.result.state.batch.committedActions, 2);
  const beforeObserver = await openOwnedMobileRpc(context, gateway, 'destination', workspace);
  const plannedItems = await beforeObserver.rpc.request('migration/items', { jobId: first.selectedJob, pageIndex: 0 });
  const childId = plannedItems.planned.find(item => item.historyJobId)?.historyJobId;
  assert.ok(childId);
  const childBefore = await beforeObserver.rpc.request('migration/history/read', { jobId: childId });
  assert.equal(childBefore.job.stage, 'normalized');
  assert.equal(childBefore.job.normalization.recordsWithDiagnostics, 0);
  await beforeObserver.close();
  assert.equal(await readFile(resolve(targetProfile, 'settings.json'), 'utf8'), originalSettings);
  const originalRecord = await readFile(record);
  const wrongTarget = context.spawnOwned('interactive-guide-target-fence', binary, ['migrate', 'transfer', '--gateway', transport.baseUrl,
    '--access-token-env', 'OWNED_GUIDE_ACCESS', 'guide', '--record', record, '--target', 'source', '--jsonl'], {
    cwd: workspace, env: context.isolatedEnvironment({ OWNED_GUIDE_ACCESS: token }),
  });
  let wrongTargetError = '';
  wrongTarget.stderr.on('data', bytes => { wrongTargetError += bytes; assert.ok(wrongTargetError.length <= 65536); });
  await waitFor(() => wrongTarget.exitCode !== null, 10000, 'guide rejects an explicit different target', 20, context.abortSignal);
  assert.notEqual(wrongTarget.exitCode, 0); assert.match(wrongTargetError, /migration_transfer_record_scope_changed/);
  assert.deepEqual(await readFile(record), originalRecord, 'scope rejection cannot replace cached operation identities');
  await rename(source, `${source}.guide-withheld`);
  const renewed = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: gateway.authToken }) });
  assert.equal(renewed.status, 200); access = (await renewed.json()).accessToken; context.registerSecret(access);
  assert.notEqual(access, token, 'the original and renewed login leases are distinct');
  context.addCleanup('revoke only renewed terminal guide account token', async () => {
    const result = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'DELETE', headers: { authorization: `Bearer ${access}` } });
    assert.ok([204, 401].includes(result.status));
  });
  const revoked = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(revoked.status, 204);
  assert.equal((await fetch(`${gateway.baseUrl}/api/servers`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  menu = 0; batchMenu = 0;
  await guide(frame => {
    if (frame.code === 'transfer_menu') return ['reconnect', 'read', 'adoption-read', 'batch', 'release', 'quit'][menu++];
    if (frame.code === 'transfer_reconnect') return 'yes';
    if (frame.code === 'transfer_batch_job') return '1';
    if (frame.code === 'transfer_batch_menu') return ['undo', 'back'][batchMenu++];
    if (frame.code === 'transfer_batch_confirm') return 'UNDO';
    if (frame.code === 'transfer_release_confirm') return 'yes';
    assert.fail(`Reopen cannot rescan or replace the source: ${frame.code}`);
  });
  const second = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(second.requestId, first.requestId); assert.equal(second.adoptionId, first.adoptionId);
  const undone = observations.findLast(row => row.run === 2 && row.type === 'remote_batch_state' && row.result?.workerRunning === false);
  assert.ok(undone);
  assert.equal(undone.result.state.job.status, 'rolled_back', 'ordinary Undo must use the original owned Native retirement operation');
  const afterObserver = await openOwnedMobileRpc(context, gateway, 'destination', workspace);
  const retired = await afterObserver.rpc.request('migration/history/retirement/list', {});
  const retirement = retired.items.find(item => item.retirement.jobId === childId);
  assert.ok(retirement); assert.equal(retirement.retirement.phase, 'collected');
  const childAfter = await afterObserver.rpc.request('migration/history/read', { jobId: childId });
  assert.equal(childAfter.job.stage, 'normalized', 'physical retirement cannot rewrite the imported historical fact');
  await afterObserver.close();
  assert.equal(await readFile(resolve(targetProfile, 'settings.json'), 'utf8'), originalSettings);
  const tui = context.spawnOwned('interactive-terminal-guide-pty', process.execPath, [
    resolve(repoRoot, 'crates/kcoder_repl/tests/migration-guided-transfer-terminal.e2e.mjs'),
    '--description', 'owned-native-transfer-guide-reopen',
  ], { cwd: repoRoot, env: context.isolatedEnvironment({
    KCODER_GUIDE_TUI_GATEWAY: transport.baseUrl, KCODER_GUIDE_TUI_RECORD: record,
    KCODER_OWNED_GUIDE_TUI_ACCESS: access, KCODER_MIGRATION_TUI_BINARY: binary,
    KCODER_GUIDE_TUI_CHROMIUM: await requireExecutable(process.env.KCODER_E2E_CHROMIUM_BIN || chromium.executablePath(), 'TUI Chromium'),
  }) });
  let tuiOutput = '';
  tui.stdout.on('data', bytes => { tuiOutput += bytes; assert.ok(tuiOutput.length <= 65536); });
  await waitFor(() => tui.exitCode !== null, 150000, 'real PTY Native migration guide', 30, context.abortSignal);
  assert.equal(tui.exitCode, 0, 'inspect interactive-terminal-guide-pty.log');
  const tuiEvidence = JSON.parse(tuiOutput.trim().split('\n').at(-1));
  assert.equal(tuiEvidence.ok, true);
  const tuiAssertions = JSON.parse(await readFile(resolve(tuiEvidence.directory, 'assertions.json'), 'utf8'));
  assert.equal(tuiAssertions.requestId, first.requestId); assert.equal(tuiAssertions.adoptionId, first.adoptionId);
  assert.equal(tuiAssertions.renderer, 'webgl'); assert.equal(tuiAssertions.modelRequests, 0);
  await context.writeArtifactJson('interactive-terminal-guide.json', { transcripts, requestId: first.requestId, adoptionId: first.adoptionId,
    explicitSourceHistoryPages: true, cacheReopenedWithoutSource: true, completedActions: 2,
    wrongTargetRejectedWithoutChangingRecord: true, stalePromptRejected: true, explicitNewLoginRecovery: true, originalLoginRevoked: true,
    lostAdoptionReplyReconciled: true, adoptionReplyDrops: transport.dropped(),
    undoStatus: undone.result.state.job.status, retiredChildId: childId, retirementPhase: retirement.retirement.phase,
    historicalImportFactPreserved: true, tuiArtifactDirectory: tuiEvidence.directory });
}
