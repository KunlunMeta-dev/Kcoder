import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { runMigrationGuideDialog } from '../../harness/migration-guide-dialog.mjs';
import { migrationReplyLossProxy } from '../../harness/migration-reply-loss-proxy.mjs';
import { seedProjectsFixture } from '../browser/migration-projects.mjs';

async function registry(profile) {
  const queue = [profile]; let seen = 0;
  while (queue.length) for (const row of await readdir(queue.shift(), { withFileTypes: true })) {
    assert.ok(++seen < 4096); const path = resolve(row.parentPath, row.name);
    if (row.isDirectory()) queue.push(path);
    else if (row.isFile() && row.name === 'client-workspaces.json') return path;
  }
  assert.fail('The owned Native workspace registry was not published');
}
const records = async profile => Object.keys(JSON.parse(await readFile(resolve(profile, 'imported-project-associations/associations.json'))).records).length;
const choose = (frame, key, wanted) => String(frame.choices.items.find(row => row[key] === wanted)?.number ?? assert.fail(`Missing explicit ${key}`));

/** Actual high-level prompts drive both products, fixed target mappings and ordinary receipts. */
export async function exerciseTerminalProjects(context, binary) {
  const cases = process.env.KCODER_E2E_MIGRATION_PROJECTS_CASES;
  assert.ok(cases === undefined || cases === "remote", "choose the full Project boundary or explicit remote-only verification");
  const remoteOnly = cases === "remote";
  const expected = process.env.KCODER_E2E_KCODER_BIN_SHA256; assert.match(expected ?? '', /^[a-f0-9]{64}$/);
  const hash = createHash('sha256'); for await (const bytes of createReadStream(binary)) hash.update(bytes); assert.equal(hash.digest('hex'), expected);
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'terminal-projects' });
  const model = await startApprovalModelFixture(context, { responseSteps: () => [{ delta: { role: 'assistant', content: 'UNEXPECTED_MODEL_REQUEST' }, finishReason: 'stop' }] });
  const settings = { credential_store: 'file', active_provider: 'fixture', providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192, discover_models: false, no_proxy: true } } };
  const results = [], servers = [], fixtures = {};
  for (const mode of remoteOnly ? ['remote'] : ['local', 'remote']) for (const kind of ['claude-code', 'codex']) {
    const id = `${mode}-${kind}`, profile = context.pathInState(`${id}/target-profile`);
    await mkdir(profile, { recursive: true, mode: 0o700 }); await writeFile(resolve(profile, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
    const namespaced = { pathInState: name => context.pathInState(`${id}/${name}`), registerSecret: value => context.registerSecret(value) };
    const fixture = await seedProjectsFixture(namespaced, profile, workspace, binary);
    const destination = resolve(workspace, id); await mkdir(destination, { mode: 0o700 }); await writeFile(resolve(destination, 'USER_FILE'), 'KEEP_WORKTREE', { mode: 0o600 });
    fixtures[id] = { ...fixture, profile, destination, name: `Native target ${id}`, originalSettings: await readFile(resolve(profile, 'settings.json')) };
    if (mode === 'remote') {
      const quote = value => `'${value.replaceAll("'", "'\\''")}'`, launcher = context.pathInState(`${id}/target-launcher`);
      await writeFile(launcher, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(profile)}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
      servers.push({ ...fixture.server, id: `source-${kind}` }, { id: `target-${kind}`, label: `Owned ${kind} target`, transport: 'local', command: launcher, workspace });
    }
  }
  function selection(frame, state) {
    if (frame.code === 'project_sources') {
      assert.equal(frame.choices.items.length, frame.choices.page === 0 ? 10 : 3);
      if (!frame.choices.selected) return 'toggle 1';
      if (frame.choices.page === 0) return 'next';
      return frame.choices.selected === 1 ? 'toggle 3' : 'done';
    }
    if (frame.code === 'project_target') return frame.choices.items.some(row => row.title === state.name) ? choose(frame, 'title', state.name) : 'register';
    if (frame.code === 'project_register_name') return state.name;
    if (frame.code === 'project_register_path') { assert.equal(frame.default, null); return state.destination; }
    if (frame.code === 'project_register_confirm') return 'yes';
    if (frame.code === 'project_target_root') { assert.ok(frame.choices.sourceRoot.startsWith('Z:')); return choose(frame, 'path', state.destination); }
    if (frame.code === 'project_report') { assert.ok(frame.choices.fields.length <= 10); return 'back'; }
    return null;
  }
  if (!remoteOnly) for (const kind of ['claude-code', 'codex']) {
    const fixture = fixtures[`local-${kind}`], observed = []; let menu = 0;
    await runMigrationGuideDialog({ context, binary, workspace, label: `project-local-${kind}`, localArgs: ['--target-profile', fixture.profile], observe: frame => { observed.push(frame); if (frame.type === 'notice' && /failed|invalid|unavailable|blocked|changed|outcome_unknown/.test(frame.code ?? '')) assert.equal(frame.code, 'source_transfer_outcome_unknown', `Unexpected Native/transport notice ${frame.code}`); }, answer: frame => {
      const common = selection(frame, fixture); if (common !== null) return common;
      if (frame.code === 'entry') return 'projects';
      if (frame.code === 'source') return kind;
      if (frame.code === 'project_source_directory') return fixture.products[kind].root;
      if (frame.code === 'project_source_consent') return 'yes';
      if (frame.code === 'menu') return ['select', 'apply', 'quit'][menu++];
      if (frame.code === 'selection') { const row = frame.choices.items.find(row => !row.selected); return row ? `toggle ${row.number}` : 'preview'; }
      if (frame.code === 'reuse') return 'no';
      if (frame.code === 'request_id') return '';
      if (frame.code === 'confirm_operation') return 'IMPORT';
      assert.fail(`Unreviewed local project question ${frame.code}`);
    } });
    const state = observed.findLast(row => row.type === 'state')?.result; assert.equal(state.job.status, 'completed'); assert.equal(state.job.committedItems, 2); assert.equal(state.job.hasUnconfirmedOutcomes, false);
    const jobId = state.job.jobId, nativeRegistry = await registry(fixture.profile), nativeBytes = await readFile(nativeRegistry);
    assert.equal(await records(fixture.profile), 2); await rename(fixture.products[kind].root, `${fixture.products[kind].root}-withheld`);
    let reopen = 0, report = 0;
    await runMigrationGuideDialog({ context, binary, workspace, label: `project-local-${kind}-reopen`, localArgs: ['--target-profile', fixture.profile, '--job-id', jobId], observe: frame => { observed.push(frame); if (frame.type === 'notice' && /failed|invalid|unavailable|blocked|changed|outcome_unknown/.test(frame.code ?? '')) assert.equal(frame.code, 'source_transfer_outcome_unknown', `Unexpected Native/transport notice ${frame.code}`); }, answer: frame => {
      const common = selection(frame, fixture); if (common !== null) return common;
      if (frame.code === 'menu') return ['projects', 'undo', 'quit'][reopen++];
      if (frame.code === 'project_saved') return report++ === 0 ? '1' : 'back';
      if (frame.code === 'request_id') return '';
      if (frame.code === 'confirm_operation') return 'UNDO';
      assert.fail(`Reopening must not discover or remap ${frame.code}`);
    } });
    assert.equal(observed.findLast(row => row.type === 'state').result.job.status, 'rolled_back'); assert.equal(await records(fixture.profile), 0); assert.deepEqual(await readFile(nativeRegistry), nativeBytes); assert.deepEqual(await readFile(resolve(fixture.profile, 'settings.json')), fixture.originalSettings); assert.equal(await readFile(resolve(fixture.destination, 'USER_FILE'), 'utf8'), 'KEEP_WORKTREE');
    results.push({ mode: 'local', kind, jobId, explicitPages: [10, 3], committedAssociations: 2, originalUndo: true });
  }
  const serversFile = await context.writeStateJson('terminal-projects-servers.json', servers);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true, env: { KCODER_CONFIG_DIR: fixtures['remote-codex'].profile } });
  const login = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: gateway.authToken }) });
  assert.equal(login.status, 200); const { accessToken: token } = await login.json(); context.registerSecret(token);
  context.addCleanup('revoke only project terminal account token', async () => { const response = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }); assert.ok([204, 401].includes(response.status)); });
  let last;
  for (const kind of ['claude-code', 'codex']) {
    const fixture = fixtures[`remote-${kind}`], observed = [], record = context.pathInState(`remote-${kind}/guide.json`);
    const proxy = await migrationReplyLossProxy(context, gateway, 'adoption-prepare');
    let menu = 0, chosen = false, adoption = false, copied = false, moved = false, batch = 0;
    const dialog = (label, answer) => runMigrationGuideDialog({ context, binary, workspace, gateway: proxy.baseUrl, record, token, label, args: ['--source-target', `source-${kind}`, '--target', `target-${kind}`, '--target-workspace', workspace, '--source-workspace', workspace, '--source-directory', fixture.products[kind].root], observe: frame => { observed.push(frame); if (frame.type === 'notice' && /failed|invalid|unavailable|blocked|changed|outcome_unknown/.test(frame.code ?? '')) assert.equal(frame.code, 'source_transfer_outcome_unknown', `Unexpected Native/transport notice ${frame.code}`); }, answer });
    await dialog(`project-remote-${kind}`, async frame => {
      const common = selection(frame, fixture); if (common !== null) return common;
      if (frame.code === 'source') return kind;
      if (frame.code === 'transfer_menu') {
        if (!chosen) { chosen = true; return 'select'; }
        if (!copied) { copied = true; return 'copy'; }
        if (!observed.some(row => row.type === 'transfer_state' && row.result?.result?.receipt)) return 'read';
        if (!moved) { await rename(fixture.products[kind].root, `${fixture.products[kind].root}-withheld`); moved = true; }
        if (!adoption) { adoption = true; return 'adopt'; }
        if (!observed.some(row => row.type === 'adoption_state' && row.result?.state?.phase === 'preview_ready' && row.result.state.workerState === 'stopped')) return 'adoption-read';
        return ['batch', 'release', 'quit'][menu++];
      }
      if (frame.code === 'transfer_source_directory_confirm' || frame.code === 'transfer_copy_confirm' || frame.code === 'transfer_adoption_confirm' || frame.code === 'transfer_release_confirm') return 'yes';
      if (frame.code === 'transfer_sources') return frame.choices.projectsSelected ? 'done' : 'projects';
      if (frame.code === 'transfer_received_selection') { const row = frame.choices.items.find(row => !row.selected); assert.ok(frame.choices.items.every(row => row.kind === 'project')); return row ? `toggle ${row.number}` : 'done'; }
      if (frame.code === 'transfer_batch_job') return '1';
      if (frame.code === 'transfer_batch_menu') return ['select', 'apply', 'back'][batch++];
      if (frame.code === 'transfer_batch_selection') { const row = frame.choices.items.find(row => !row.selected); return row ? `toggle ${row.number}` : 'preview'; }
      if (frame.code === 'reuse') return 'no';
      if (frame.code === 'transfer_batch_confirm') return 'IMPORT';
      assert.fail(`Unreviewed remote project question ${frame.code}`);
    });
    const first = JSON.parse(await readFile(record)); assert.equal(first.selections.length, 2); assert.ok(first.selections.every(row => row.kind === 'projects')); assert.equal(proxy.dropped(), 1); assert.equal(proxy.selectedRequests(), 1);
    const saved = observed.findLast(row => row.type === 'remote_batch_state' && row.result?.state?.job?.status === 'completed'); assert.ok(saved); assert.equal(saved.result.state.job.committedItems, 2); assert.equal(saved.result.state.job.hasUnconfirmedOutcomes, false); assert.equal(saved.result.state.batch.unresolvedActions, 0);
    const nativeRegistry = await registry(fixture.profile), nativeBytes = await readFile(nativeRegistry); assert.equal(await records(fixture.profile), 2);
    let reopen = 0, report = 0, operation = 0;
    await dialog(`project-remote-${kind}-reopen`, frame => {
      const common = selection(frame, fixture); if (common !== null) return common;
      if (frame.code === 'transfer_menu') return ['read', 'adoption-read', 'batch', 'release', 'quit'][reopen++];
      if (frame.code === 'transfer_batch_job') return '1';
      if (frame.code === 'transfer_batch_menu') return ['projects', 'undo', 'back'][operation++];
      if (frame.code === 'project_saved') return report++ === 0 ? '1' : 'back';
      if (frame.code === 'transfer_batch_confirm') return 'UNDO';
      if (frame.code === 'transfer_release_confirm') return 'yes';
      assert.fail(`Reopening must not discover or remap ${frame.code}`);
    });
    const second = JSON.parse(await readFile(record)); for (const key of ['requestId', 'adoptionId', 'selections', 'adoptionSelections']) assert.deepEqual(second[key], first[key]);
    assert.ok(observed.some(row => row.type === 'remote_batch_state' && row.result?.state?.job?.status === 'rolled_back')); assert.equal(await records(fixture.profile), 0); assert.deepEqual(await readFile(nativeRegistry), nativeBytes); assert.deepEqual(await readFile(resolve(fixture.profile, 'settings.json')), fixture.originalSettings); assert.equal(await readFile(resolve(fixture.destination, 'USER_FILE'), 'utf8'), 'KEEP_WORKTREE');
    last = { record, gateway: proxy.baseUrl, requestId: first.requestId, adoptionId: first.adoptionId }; results.push({ mode: 'remote', kind, jobId: first.selectedJob, originalUndo: true, explicitPages: [10, 3], discardedAdoptionReply: true });
  }
  assert.equal(model.requests.length, 0);
  const child = context.spawnOwned('project-guide-real-pty', process.execPath, [resolve(repoRoot, 'crates/kcoder_repl/tests/migration-guided-transfer-terminal.e2e.mjs'), '--description', 'project-inventory-sourcegone-original-mapping-record'], { cwd: repoRoot, env: context.isolatedEnvironment({ KCODER_GUIDE_TUI_GATEWAY: last.gateway, KCODER_GUIDE_TUI_RECORD: last.record, KCODER_OWNED_GUIDE_TUI_ACCESS: token, KCODER_MIGRATION_TUI_BINARY: binary, KCODER_GUIDE_TUI_PROJECTS: '1', KCODER_GUIDE_TUI_CHROMIUM: await requireExecutable(process.env.KCODER_E2E_CHROMIUM_BIN, 'owned TUI Chromium') }) });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; assert.ok(output.length < 65536); }); await waitFor(() => child.exitCode !== null, 150000, 'real project guide PTY exit', 30, context.abortSignal); assert.equal(child.exitCode, 0, 'inspect project-guide-real-pty.log');
  const terminal = JSON.parse(output.trim().split('\n').at(-1)), assertions = JSON.parse(await readFile(resolve(terminal.directory, 'assertions.json'))); assert.equal(assertions.sourceGoneProjectReports, true); assert.equal(assertions.renderer, 'webgl'); assert.equal(assertions.modelRequests, 0); assert.equal(assertions.binarySha256, expected); assert.equal(assertions.requestId, last.requestId);
  await context.writeArtifactJson('terminal-projects-roundtrip.json', { passed: true, cases: remoteOnly ? 'remote' : 'all', results, modelRequests: 0, terminalDirectory: terminal.directory, binarySha256: expected });
}
