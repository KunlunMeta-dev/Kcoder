import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { runMigrationGuideDialog } from '../../harness/migration-guide-dialog.mjs';
import { migrationReplyLossProxy } from '../../harness/migration-reply-loss-proxy.mjs';
import { seedInstructionFixture } from '../browser/migration-instructions.mjs';

/** Real CLI answers drive the same Native graph, transfer receipt, target proof and ordinary batch. */
export async function exerciseTerminalInstructions(context, binary) {
  const expected = process.env.KCODER_E2E_KCODER_BIN_SHA256;
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'actual terminal instruction acceptance requires the shared frozen Native SHA');
  const hash = createHash('sha256'); for await (const bytes of createReadStream(binary)) hash.update(bytes);
  assert.equal(hash.digest('hex'), expected);
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'instruction-target' });
  const profile = context.pathInState('instruction-source-profile'), targetProfile = context.pathInState('instruction-target-profile');
  const model = await startApprovalModelFixture(context, { responseSteps: () => [{ delta: { role: 'assistant', content: 'UNEXPECTED_MODEL_CALL' }, finishReason: 'stop' }] });
  const settings = { credential_store: 'file', active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture',
    context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192, discover_models: false, no_proxy: true,
  } }, mcp_servers: [] };
  for (const path of [profile, targetProfile]) { await mkdir(path, { mode: 0o700 }); await writeFile(resolve(path, 'settings.json'), JSON.stringify(settings), { mode: 0o600 }); }
  const fixtures = await seedInstructionFixture(context, profile, workspace);
  await writeFile(resolve(targetProfile, 'trusted-folders.json'), JSON.stringify({ version: 1, trusted: [workspace], never: [] }), { mode: 0o600 });
  const originalSettings = await readFile(resolve(targetProfile, 'settings.json'));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = async (id, target) => {
    const file = context.pathInState(`instruction-${id}-launcher`);
    await writeFile(file, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(target)}\nexport CLAUDE_CONFIG_DIR=${quote(context.pathInState('empty-claude'))}\nexport CODEX_HOME=${quote(context.pathInState('empty-codex'))}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
    return file;
  };
  const servers = [{ id: 'destination', label: 'Owned instruction destination', transport: 'local', command: await launcher('destination', targetProfile), workspace }];
  for (const kind of ['claude-code', 'codex']) servers.push({ id: `source-${kind}`, label: `Owned ${kind} instructions`, transport: 'local', command: await launcher(kind, profile), workspace: fixtures[kind].root });
  const serversFile = await context.writeStateJson('instruction-servers.json', servers);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true, env: { KCODER_CONFIG_DIR: targetProfile } });
  const login = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: gateway.authToken }) });
  assert.equal(login.status, 200); const { accessToken: token } = await login.json(); context.registerSecret(token);
  context.addCleanup('revoke instruction terminal fixture token', async () => { const response = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }); assert.ok([204, 401].includes(response.status)); });
  const results = [];
  for (const kind of ['claude-code', 'codex']) {
    const cache = context.pathInState(`instruction-${kind}-cache`); await mkdir(cache, { mode: 0o700 });
    const record = resolve(cache, 'guide.json');
    const fault = kind === 'claude-code' ? 'instructions-capture' : 'adoption-prepare';
    const proxy = await migrationReplyLossProxy(context, gateway, fault);
    const observed = [], trace = []; let menu = 0, capturePass = 0, previewPass = 0, mappingPass = 0, bodyPass = 0, batch = 0, moved = false;
    let sourcePage, savedPage;
    const dialog = async (label, answer) => runMigrationGuideDialog({ context, binary, gateway: proxy.baseUrl, token, workspace, record, label,
      args: ['--source-target', `source-${kind}`, '--target', 'destination', '--source-workspace', fixtures[kind].root, '--target-workspace', workspace],
      observe: frame => {
        if (frame.type !== 'prompt') observed.push(frame);
        if (frame.type === 'instruction_report') {
          if (frame.result.target.kind === 'source') sourcePage = frame.result;
          else if (frame.result.target.kind === 'job') savedPage = frame.result;
        }
        if (frame.type === 'notice' && /failed|invalid|outcome_unknown|scope_changed/.test(frame.code || ''))
          assert.equal(frame.code, 'source_transfer_outcome_unknown', `Unexpected real Native notice ${frame.code}`);
      }, answer: async frame => { const value = await answer(frame); trace.push({ code: frame.code, answer: /root|cwd/.test(frame.code) ? 'owned-path' : value }); return value; },
    });
    await dialog(`instruction-${kind}-capture-transfer`, async frame => {
      const { code, choices } = frame;
      if (code === 'source') return kind;
      if (code === 'transfer_menu') {
        if (capturePass++ < (fault === 'instructions-capture' ? 2 : 1)) return 'instructions';
        const actions = ['copy', 'adopt'];
        if (menu < actions.length) {
          if (menu === 1 && !moved) { await rename(fixtures[kind].root, `${fixtures[kind].root}.withheld`); moved = true; }
          return actions[menu++];
        }
        const adoption = observed.findLast(row => row.type === 'adoption_state')?.result?.state;
        if (!adoption || adoption.phase !== 'preview_ready' || adoption.workerState !== 'stopped') return 'adoption-read';
        if (menu++ === 2) return 'batch';
        return menu === 4 ? 'release' : 'quit';
      }
      if (code === 'transfer_instruction_root' || code === 'transfer_instruction_cwd') return fixtures[kind].root;
      if (code === 'transfer_instruction_preview') {
        assert.equal(sourcePage.totalItems, 14);
        const root = sourcePage.items.find(row => row.relativePath === fixtures[kind].filename);
        if (previewPass++ === 0) return `original ${sourcePage.items.indexOf(root) + 1}`;
        if (previewPass === 2) return `compiled ${sourcePage.items.indexOf(root) + 1}`;
        if (previewPass === 3) return 'next';
        assert.equal(sourcePage.items.length, 4); return 'back';
      }
      if (code === 'instruction_next_body') return bodyPass++ === 0 ? 'yes' : 'no';
      if (code === 'transfer_received_selection') return choices.selected ? 'done' : `toggle ${choices.items.find(row => row.kind === 'instructions').number}`;
      if (code === 'transfer_instruction_mapping') {
        const targetPage = { items: choices.items.map(row => row.item) };
        const wanted = mappingPass++ === 0 ? fixtures[kind].filename : 'child-00/';
        if (mappingPass <= 2) {
          const row = targetPage.items.find(item => item.relativePath === wanted || item.relativePath.startsWith(wanted)); assert.ok(row);
          return `toggle ${targetPage.items.indexOf(row) + 1}`;
        }
        return 'done';
      }
      if (code === 'transfer_instruction_scope') return mappingPass === 1 ? '.' : 'instruction-mapped';
      if (code === 'transfer_batch_job') return '1';
      if (code === 'transfer_batch_menu') return ['select', 'apply', 'back'][batch++];
      if (code === 'transfer_batch_selection') { const row = choices.items.find(row => !row.selected); return row ? `toggle ${row.number}` : 'preview'; }
      if (code === 'target_name') return `terminal-${kind}-${mappingPass++}`;
      if (code === 'reuse') return 'no';
      if (code === 'transfer_batch_confirm') return 'IMPORT';
      if (['transfer_instruction_descendants', 'transfer_instruction_static', 'transfer_instruction_select', 'transfer_copy_confirm', 'transfer_instruction_workspace', 'transfer_instruction_mapping_confirm', 'transfer_adoption_confirm', 'transfer_release_confirm'].includes(code)) return 'yes';
      assert.fail(`Unreviewed instruction question ${code}`);
    });
    const first = JSON.parse(await readFile(record, 'utf8'));
    assert.equal(proxy.dropped(), 1); assert.equal(proxy.selectedRequests(), 1, 'a lost accepted reply cannot replay capture or adoption');
    assert.equal(first.instructionCapture.dispatched, true);
    assert.equal(first.selections.length, 1); assert.equal(first.selections[0].kind, 'instructions');
    assert.equal(first.instructionMappings.length, 1); assert.equal(first.instructionMappings[0].items.length, 2);
    assert.equal(first.instructionMappings[0].archiveIncompleteChain ?? false, false);
    const completed = observed.findLast(row => row.type === 'remote_batch_state' && row.result?.state?.job?.status === 'completed');
    assert.ok(completed); assert.equal(completed.result.state.batch.committedActions, 2);
    const contexts = JSON.parse(await readFile(resolve(targetProfile, 'imported-context.json'), 'utf8'));
    const records = Object.values(contexts.records);
    assert.equal(records.length, 2); assert.ok(records.every(row => row.enabled === false && row.kind === 'instructions'));
    let reopen = 0, batchStep = 0, saved = 0;
    await dialog(`instruction-${kind}-reopen-undo`, frame => {
      if (frame.code === 'transfer_menu') return ['read', 'adoption-read', 'batch', 'release', 'quit'][reopen++];
      if (frame.code === 'transfer_batch_job') return '1';
      if (frame.code === 'transfer_batch_menu') return ['instructions', 'undo', 'back'][batchStep++];
      if (frame.code === 'transfer_instruction_saved') { assert.equal(savedPage.items.length, 2); return ['original 1', 'compiled 1', 'back'][saved++]; }
      if (frame.code === 'instruction_next_body') return 'no';
      if (frame.code === 'transfer_batch_confirm') return 'UNDO';
      if (frame.code === 'transfer_release_confirm') return 'yes';
      assert.fail(`Reopen must not capture or remap ${frame.code}`);
    });
    const second = JSON.parse(await readFile(record, 'utf8'));
    for (const name of ['requestId', 'adoptionId', 'instructionCapture', 'instructionMappings']) assert.deepEqual(second[name], first[name]);
    const rolled = observed.findLast(row => row.type === 'remote_batch_state' && row.result?.state?.job?.status === 'rolled_back'); assert.ok(rolled);
    assert.deepEqual(await readFile(resolve(targetProfile, 'settings.json')), originalSettings);
    const reads = observed.filter(row => row.type === 'instruction_body').map(row => row.result);
    assert.ok(reads.some(row => row.offset > 0) || kind === 'codex');
    assert.ok(reads.some(row => row.target.kind === 'job' && row.representation === 'compiled'));
    assert.ok(reads.every(row => !row.enabledByPreview));
    await context.writeArtifactJson(`terminal-instructions-${kind}.json`, { requestId: first.requestId, adoptionId: first.adoptionId, captureId: first.instructionCapture.params.captureId, selectedItems: 2, lostReplyKind: fault, replyDrops: proxy.dropped(), sourceGoneBeforeAdoption: moved, compiledAndOriginalRead: true, originalUndo: true, trace });
    results.push({ kind, record, gateway: proxy.baseUrl, requestId: first.requestId, adoptionId: first.adoptionId, inactive: true, originalUndo: true });
  }
  assert.equal(model.requests.length, 0);
  const last = results.at(-1);
  const tui = context.spawnOwned('scoped-instruction-guide-pty', process.execPath, [
    resolve(repoRoot, 'crates/kcoder_repl/tests/migration-guided-transfer-terminal.e2e.mjs'),
    '--description', 'sourcegone-native-instruction-guide-original-and-compiled',
  ], { cwd: repoRoot, env: context.isolatedEnvironment({
    KCODER_GUIDE_TUI_GATEWAY: last.gateway, KCODER_GUIDE_TUI_RECORD: last.record,
    KCODER_OWNED_GUIDE_TUI_ACCESS: token, KCODER_MIGRATION_TUI_BINARY: binary,
    KCODER_GUIDE_TUI_INSTRUCTIONS: '1', KCODER_GUIDE_TUI_CHROMIUM: await requireExecutable(process.env.KCODER_E2E_CHROMIUM_BIN, 'owned TUI Chromium'),
  }) });
  let output = '';
  tui.stdout.on('data', bytes => { output += bytes; assert.ok(output.length <= 65536); });
  await waitFor(() => tui.exitCode !== null, 150000, 'actual scoped instruction PTY reopen', 30, context.abortSignal);
  assert.equal(tui.exitCode, 0, 'inspect scoped-instruction-guide-pty.log');
  const terminal = JSON.parse(output.trim().split('\n').at(-1)); assert.equal(terminal.ok, true);
  const assertions = JSON.parse(await readFile(resolve(terminal.directory, 'assertions.json'), 'utf8'));
  assert.equal(assertions.sourceGoneInstructionPreviews, true); assert.equal(assertions.renderer, 'webgl');
  assert.equal(assertions.modelRequests, 0); assert.equal(assertions.requestId, last.requestId);
  assert.equal(assertions.adoptionId, last.adoptionId); assert.equal(assertions.binarySha256, expected);
  await context.writeArtifactJson('terminal-scoped-instructions-roundtrip.json', { passed: true, results, modelRequests: 0, targetSettingsUnchanged: true, platform: 'Linux CLI with actual Native/Gateway; PTY separately' });
  return { gateway, token, workspace, results };
}
