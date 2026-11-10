import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway } from '../../harness/gateway.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { repoRoot, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { runMigrationGuideDialog } from '../../harness/migration-guide-dialog.mjs';
import { migrationReplyLossProxy } from '../../harness/migration-reply-loss-proxy.mjs';

/** Actual CLI questions exercise original Native private receipts; synthetic values never enter answers. */
export async function exerciseTerminalPrivate(context, binary) {
  const expected = process.env.KCODER_E2E_KCODER_BIN_SHA256;
  assert.match(expected ?? '', /^[a-f0-9]{64}$/);
  const hash = createHash('sha256'); for await (const chunk of createReadStream(binary)) hash.update(chunk);
  assert.equal(hash.digest('hex'), expected);
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { responseSteps: () => [{ delta: { role: 'assistant', content: 'UNEXPECTED_MODEL_CALL' }, finishReason: 'stop' }] });
  const settings = { credential_store: 'file', active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture',
    context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192, no_proxy: true, discover_models: false,
  } }, mcp_servers: [], mcp_disabled_servers: [] };
  const profile = context.pathInState('private-source-profile'), targetProfile = context.pathInState('private-target-profile');
  for (const root of [profile, targetProfile]) { await mkdir(root, { mode: 0o700 }); await writeFile(resolve(root, 'settings.json'), JSON.stringify(settings), { mode: 0o600 }); }
  const targetBefore = await readFile(resolve(targetProfile, 'settings.json'));
  const vendor = context.pathInState('private-vendor'), empty = context.pathInState('private-empty');
  await mkdir(vendor, { mode: 0o700 }); await mkdir(empty, { mode: 0o700 });
  const values = Array.from({ length: 4 }, () => `synthetic-private-${randomUUID()}`); values.forEach(value => context.registerSecret(value));
  const marker = context.pathInState('source-command-must-not-run'), tool = context.pathInState('never-run-mcp');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(tool, `#!/bin/sh\nprintf invoked > ${quote(marker)}\n`, { mode: 0o700 });
  const originalSource = [];
  for (let index = 0; index < 2; index++) {
    const body = `model='fixture'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://source-${index}.invalid/v1'\nwire_api='responses'\nenv_key='OWNED_TERMINAL_PRIVATE_API_${index}'\n[mcp_servers.notes]\ncommand='${tool}'\n[mcp_servers.notes.env]\nTOKEN='${values[index + 2]}'\n`;
    const name = index ? 'review.config.toml' : 'config.toml';
    await writeFile(resolve(vendor, name), body, { mode: 0o600 }); originalSource.push({ name, body });
  }
  const launcher = async (id, root, source) => {
    const file = context.pathInState(`private-${id}-launcher`);
    await writeFile(file, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(root)}\nexport CODEX_HOME=${quote(source ? vendor : empty)}\nexport CLAUDE_CONFIG_DIR=${quote(empty)}\n${source ? values.slice(0, 2).map((value, index) => `export OWNED_TERMINAL_PRIVATE_API_${index}=${quote(value)}\n`).join('') : ''}exec ${quote(binary)} "$@"\n`, { mode: 0o700 });
    return file;
  };
  const serversFile = await context.writeStateJson('private-servers.json', [
    { id: 'source', label: 'Owned private source', transport: 'local', command: await launcher('source', profile, true), workspace },
    { id: 'destination', label: 'Owned private destination', transport: 'local', command: await launcher('destination', targetProfile, false), workspace },
  ]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true, env: { KCODER_CONFIG_DIR: targetProfile, CODEX_HOME: empty, CLAUDE_CONFIG_DIR: empty } });
  const login = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: gateway.authToken }) });
  assert.equal(login.status, 200); const { accessToken: token } = await login.json(); context.registerSecret(token);
  context.addCleanup('revoke private terminal fixture token', async () => { const response = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }); assert.ok([204, 401].includes(response.status)); });
  const proxy = await migrationReplyLossProxy(context, gateway, 'private-prepare');
  const cache = context.pathInState('private-terminal-cache'); await mkdir(cache, { mode: 0o700 });
  const record = resolve(cache, 'guide.json'), observed = [], trace = [];
  let publicBytes=0, sourceOnlyProbe=null;
  async function sessionCall(operation,session) {
    const response=await fetch(`${gateway.baseUrl}/api/migration/source-session/${operation}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(session)});
    assert.equal(response.status,200);return response.json();
  }
  const dialog = (label, answer) => runMigrationGuideDialog({ context, binary, gateway: proxy.baseUrl, token, workspace, record, label,
    args: ['--source-target', 'source', '--target', 'destination', '--source-workspace', workspace, '--target-workspace', workspace],
    async observe(frame, raw) {
      publicBytes+=Buffer.byteLength(raw);assert.ok(publicBytes<=4*1024*1024,'bounded private terminal observations');
      for (const value of values) assert.equal(raw.includes(value), false, 'private plaintext escaped actual CLI stdout');
      if (frame.type !== 'prompt') observed.push(frame);
      if (sourceOnlyProbe && frame.type==='private_transfer' && frame.result.sourceObserved && !frame.result.targetObserved) {
        const current=JSON.parse(await readFile(record,'utf8'));
        assert.equal(current.recovery.sessionId,sourceOnlyProbe.recovery.sessionId,'source-only observation must not allocate a replacement target child');
        assert.equal((await sessionCall('read',sourceOnlyProbe.recovery)).status,'released');
        assert.equal((await sessionCall('read',sourceOnlyProbe.target)).status,'released');
        sourceOnlyProbe=null;
      }
      if (frame.type === 'notice' && /failed|invalid|unknown|changed|busy|required|exceeded|unconfirmed|unavailable|unsupported|conflict|blocked/.test(frame.code ?? '')) assert.equal(frame.code, 'source_transfer_outcome_unknown', `Unexpected actual private notice ${frame.code}`);
    }, answer: async frame => { assert.ok(trace.length<512,'bounded private terminal questions'); const answerValue = await answer(frame); trace.push({ code: frame.code, answer: answerValue }); return answerValue; },
  });
  let top = 0, batch = 0, sourceChoice = 0, names = 0;
  const privateCommands = ['receive', 'include', 'receive', 'cancel-target', 'resume-target', 'include', 'cancel-source', 'resume-source', 'source-read', 'prepare', 'status', 'back'];
  await dialog('private-terminal-select-and-prepare', async frame => {
    const { code, choices } = frame;
    if (code === 'source') return 'codex';
    if (code === 'transfer_menu') {
      if (top < 3) return ['select', 'copy', 'adopt'][top++];
      const state = observed.findLast(row => row.type === 'adoption_state')?.result?.state;
      if (!state || state.phase !== 'preview_ready' || state.workerState !== 'stopped') return 'adoption-read';
      return top++ === 3 ? 'batch' : 'quit';
    }
    if (code === 'transfer_source_directory') return 'default';
    if (code === 'transfer_sources') { const row = choices.items.find(row => !row.selected); return row ? `toggle ${row.number}` : 'done'; }
    if (code === 'transfer_received_selection') { const row = choices.items.find(row => !row.selected); return row ? `toggle ${row.number}` : 'done'; }
    if (code === 'transfer_batch_job') return '1';
    if (code === 'transfer_batch_menu') return ['select', 'private', 'back'][batch++];
    if (code === 'transfer_batch_selection') { const row = choices.items.find(row => ['Office', 'notes'].includes(row.item.sourceName) && !row.selected); return row ? `toggle ${row.number}` : 'preview'; }
    if (code === 'target_name') return `terminal-private-${++names}`;
    if (code === 'endpoint' || code === 'model') return frame.default ?? '';
    if (code === 'context_window_tokens') return '64000';
    if (code === 'output_headroom_tokens' || code === 'max_output_tokens') return '8192';
    if (code === 'mcp_cwd') return '';
    if (code === 'reuse' || code === 'enable_mcp') return 'no';
    if (code === 'transfer_private_menu') {
      const command=privateCommands.shift();
      if (command==='source-read') {
        sourceOnlyProbe=JSON.parse(await readFile(record,'utf8'));
        for (const session of [sourceOnlyProbe.target,sourceOnlyProbe.recovery]) assert.equal((await sessionCall('close',session)).status,'released');
        await context.writeArtifactJson('source-only-expected-session.json',{targetSessionId:sourceOnlyProbe.target.sessionId,recoverySessionId:sourceOnlyProbe.recovery.sessionId,bothClosedBeforeReadonly:true});
      }
      return command;
    }
    if (code === 'transfer_private_sources') return String(++sourceChoice);
    if (code === 'transfer_private_candidates') { const row = choices.items.find(row => !row.selected); return row ? `toggle ${row.number}` : 'done'; }
    if (code === 'transfer_private_selector') return '1';
    if (code === 'transfer_private_fields') return choices.selected ? 'done' : 'toggle 1';
    if (['transfer_copy_confirm', 'transfer_adoption_confirm', 'transfer_private_api_consent', 'transfer_private_mcp_consent', 'transfer_private_cancel', 'transfer_private_resume', 'transfer_private_prepare'].includes(code)) return 'yes';
    assert.fail(`Unreviewed private question ${code}`);
  });
  assert.equal(proxy.dropped(), 1); assert.equal(proxy.selectedRequests(), 1, 'accepted prepare ACK loss cannot replay the mutation');
  const controls=observed.filter(row=>row.type==='private_control').map(row=>row.result);
  assert.equal(controls.length,4);assert.ok(controls.every(row=>row.workerRunning===false));
  for (const side of ['target','source']) {
    const pair=controls.filter(row=>row.side===side);assert.equal(pair.length,2);
    assert.equal(pair[0].control.cancelled,true);assert.equal(pair[1].control.cancelled,false);
    assert.equal(pair[0].offerId,pair[1].offerId);assert.ok(pair[1].control.sequence>pair[0].control.sequence);
  }
  const first = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(first.privateCredentials.offers.length, 2);
  assert.ok(first.privateCredentials.offers.every(row => row.included && row.dispatched));
  const jobId = first.selectedJob, original = first.privateCredentials.preparations[jobId];
  const offerIds = first.privateCredentials.offers.map(row => row.input.locator.offerId).sort();
  const prepared = observed.findLast(row => row.type === 'private_preparation')?.result;
  assert.equal(prepared.phase, 'prepared'); assert.deepEqual(prepared.offerIds, offerIds);
  assert.equal(prepared.expectedSequence, original.input.expectedSequence);
  assert.deepEqual(await readFile(resolve(targetProfile, 'settings.json')), targetBefore, 'private preparation is not publication');
  // Only the stopped client's optional selection cache is lost; canonical Native storage is untouched.
  delete first.privateCredentials; await writeFile(record, JSON.stringify(first), { mode: 0o600 });
  await rename(vendor, `${vendor}.withheld`);
  let reopen = 0, action = 0;
  const nativeRead = ['status', 'select 1', 'read', 'select 2', 'read', 'back'];
  await dialog('private-terminal-sourcegone-native-intent-and-publish', frame => {
    if (frame.code === 'transfer_menu') return ['batch', 'quit'][reopen++];
    if (frame.code === 'transfer_batch_job') return '1';
    if (frame.code === 'transfer_batch_menu') return ['private', 'apply', 'back'][action++];
    if (frame.code === 'transfer_private_menu') {
      if (nativeRead[0] !== 'status') assert.ok(frame.choices.records.every(row => row.nativeOnly === true));
      return nativeRead.shift();
    }
    if (frame.code === 'transfer_batch_confirm') return 'IMPORT';
    assert.fail(`Sourcegone recovery cannot request source values ${frame.code}`);
  });
  const published = observed.findLast(row => row.type === 'remote_batch_state' && ['completed','completed_with_issues'].includes(row.result?.state?.job?.status))?.result.state;
  assert.ok(published); assert.equal(published.batch.publishedCredentials, 4);
  assert.equal(published.job.status,'completed_with_issues','unselected template and unverified activation remain visible');
  assert.equal(published.job.committedItems,4);assert.equal(published.job.totalItems,5);
  assert.ok(published.job.requiresActionItems>0);assert.equal(published.job.hasUnconfirmedOutcomes,false);
  assert.equal(published.batch.committedActions,published.batch.totalActions);assert.equal(published.batch.unresolvedActions,0);
  assert.ok(published.job.sequence>prepared.sequence,'publication observation advances without changing original private CAS');
  const publicSettings = JSON.parse(await readFile(resolve(targetProfile, 'settings.json'), 'utf8'));
  for (const value of values) assert.equal(JSON.stringify(publicSettings).includes(value), false);
  assert.equal(publicSettings.mcp_disabled_servers.filter(name => name.startsWith('terminal-private-')).length, 2);
  reopen = 0; action = 0;
  const afterPublish = ['status', 'back', 'status', 'select 1', 'release', 'select 2', 'release', 'back'];
  await dialog('private-terminal-native-intent-undo-and-release', frame => {
    if (frame.code === 'transfer_menu') return ['batch', 'release', 'quit'][reopen++];
    if (frame.code === 'transfer_batch_job') return '1';
    if (frame.code === 'transfer_batch_menu') return ['private', 'undo', 'private', 'back'][action++];
    if (frame.code === 'transfer_private_menu') return afterPublish.shift();
    if (frame.code === 'transfer_batch_confirm') return 'UNDO';
    if (frame.code === 'transfer_private_release' || frame.code === 'transfer_release_confirm') return 'yes';
    assert.fail(`Original Undo cannot invent another private set ${frame.code}`);
  });
  assert.ok(observed.some(row=>row.type==='remote_batch_state' && row.result?.state?.job?.status==='rolled_back'));
  const released = observed.filter(row => row.type === 'private_transfer' && row.result?.keyReleased);
  assert.equal(new Set(released.map(row => row.result.offerId)).size, 2);
  const restored = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(restored.privateCredentials.offers.length, 0);
  assert.deepEqual(restored.privateCredentials.preparations[jobId].input, original.input);
  for (const field of ['requestId', 'adoptionId', 'manifestSha256']) assert.equal(restored[field], first[field]);
  assert.deepEqual(JSON.parse(await readFile(resolve(targetProfile, 'settings.json'), 'utf8')), JSON.parse(targetBefore));
  for (const file of originalSource) assert.equal(await readFile(resolve(`${vendor}.withheld`, file.name), 'utf8'), file.body);
  await assert.rejects(access(marker), { code: 'ENOENT' }); assert.equal(model.requests.length, 0);
  await context.writeArtifactJson('terminal-private-bundle-roundtrip.json', { requestId:first.requestId,adoptionId:first.adoptionId,jobId,offerIds,
    sha256:expected,acceptedPrepareReplyLost:true,prepareCalls:proxy.selectedRequests(),privateCacheLost:true,canonicalFullSetRestored:true,
    originalExpectedSequence:original.input.expectedSequence,targetControlExplicitCancelResume:true,sourceControlExplicitCancelResume:true,sourceOnlyReadLeftTargetClosed:true,sourceGoneBeforePublish:true,publishedReferences:4,
    publicationStatus:published.job.status,selectedItems:4,totalCandidates:5,requiresActionItems:published.job.requiresActionItems,originalBatchUndo:true,releasedKeys:2,privateValuesPublic:false,sourceToolExecuted:false,modelRequests:0,trace });
  const tui = context.spawnOwned('private-native-intent-pty', process.execPath, [resolve(repoRoot, 'crates/kcoder_repl/tests/migration-guided-transfer-terminal.e2e.mjs'),
    '--description', 'sourcegone-original-private-native-intent-recovered-without-client-selections'], { cwd: repoRoot, env: context.isolatedEnvironment({
      KCODER_GUIDE_TUI_GATEWAY:proxy.baseUrl,KCODER_GUIDE_TUI_RECORD:record,KCODER_OWNED_GUIDE_TUI_ACCESS:token,KCODER_MIGRATION_TUI_BINARY:binary,
      KCODER_GUIDE_TUI_PRIVATE:'1',KCODER_GUIDE_TUI_CHROMIUM:await requireExecutable(process.env.KCODER_E2E_CHROMIUM_BIN,'owned TUI Chromium'),
    }) });
  let output=''; tui.stdout.on('data',bytes=>{ output+=bytes;assert.ok(output.length<=65536); });
  await waitFor(()=>tui.exitCode!==null,150000,'actual private intent PTY reopen',30,context.abortSignal);
  assert.equal(tui.exitCode,0,'inspect private-native-intent-pty.log');
  const terminal=JSON.parse(output.trim().split('\n').at(-1));assert.equal(terminal.ok,true);
  const assertions=JSON.parse(await readFile(resolve(terminal.directory,'assertions.json'),'utf8'));
  assert.equal(assertions.sourceGonePrivateIntent,true);assert.equal(assertions.renderer,'webgl');assert.equal(assertions.binarySha256,expected);
  assert.equal(assertions.requestId,first.requestId);assert.equal(assertions.adoptionId,first.adoptionId);
  assert.equal(assertions.modelRequests,0);assert.equal(model.requests.length,0);
  await context.writeArtifactJson('terminal-private-pty.json',{directory:terminal.directory,requestId:first.requestId,adoptionId:first.adoptionId,binarySha256:expected,sourceGonePrivateIntent:true,modelRequests:0});
  return { gateway:proxy.baseUrl,token,record,workspace,jobId,requestId:first.requestId,adoptionId:first.adoptionId,expected };
}
