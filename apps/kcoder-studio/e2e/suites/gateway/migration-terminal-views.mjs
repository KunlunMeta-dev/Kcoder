import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { chromium } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { migrationReplyLossProxy } from '../../harness/migration-reply-loss-proxy.mjs';
import { runMigrationGuideDialog } from '../../harness/migration-guide-dialog.mjs';

/** Owned Native grants, not a simulated provider or a claim about vendor execution. */
export async function exerciseTerminalSourceViews({ context, binary, gateway, token, workspace, sourceProfile, targetProfile }) {
  const root = context.pathInState('terminal-view-root'), wrong = context.pathInState('terminal-view-unavailable');
  const cache = context.pathInState('terminal-view-cache'), record = resolve(cache, 'record.json');
  await mkdir(root, { mode: 0o700 }); await mkdir(cache, { mode: 0o700 });
  await mkdir(resolve(workspace, '.git'), { recursive: true });
  await mkdir(resolve(workspace, '.codex'), { recursive: true });
  await writeFile(resolve(sourceProfile, 'trusted-folders.json'), JSON.stringify({ trusted: [workspace], never: [] }), { mode: 0o600 });
  await writeFile(resolve(targetProfile, 'trusted-folders.json'), JSON.stringify({ trusted: [workspace], never: [] }), { mode: 0o600 });
  let config = "model='root-static'\nmodel_provider='SourceOffice'\nmodel_context_window=128000\napproval_policy='on-request'\nsandbox_mode='read-only'\nnotify=[]\nproject_root_markers=['.git']\n[model_providers.SourceOffice]\nbase_url='https://source-never-called.invalid/v1'\nwire_api='responses'\nenv_key='MUST_NOT_READ_VIEW_ENV'\n";
  for (let i = 0; i < 14; i++) config += `[mcp_servers.view${i}]\ncommand='MUST_NOT_EXECUTE_VIEW_SOURCE'\n`;
  await writeFile(resolve(root, 'config.toml'), config, { mode: 0o600 });
  await writeFile(resolve(workspace, '.codex/config.toml'), "model='project-static'\nmodel_reasoning_effort='medium'\n", { mode: 0o600 });
  const targetBefore = await readFile(resolve(targetProfile, 'settings.json'));
  const transport = await migrationReplyLossProxy(context, gateway, 'directory-select');
  const trace = [], notices = [], reports = []; let run = 0;
  async function dialog(answer, args = []) {
    await runMigrationGuideDialog({ context, binary, gateway: transport.baseUrl, token, workspace, record,
      label: `terminal-source-views-${++run}`, args, answer: frame => {
        const value = answer(frame); trace.push({ run, code: frame.code, answer: frame.code.endsWith('_path') ? '<owned-source-root>' : value }); return value;
      }, observe: (frame, raw) => {
        assert.ok(!raw.includes(root) && !raw.includes(wrong), 'source root paths stay private');
        if (frame.type === 'notice') notices.push(frame.code);
        if (frame.type === 'configuration_layers') reports.push(frame.result);
      },
    });
  }
  let menu = 0;
  await dialog(frame => {
    if (frame.code === 'source') return 'codex';
    if (frame.code === 'transfer_source_directory_confirm') return 'yes';
    if (frame.code === 'transfer_menu') return ['select', 'select', 'quit'][menu++];
    assert.fail(`failed explicit directory must not fall back to discovery: ${frame.code}`);
  }, ['--source-target', 'source', '--target', 'destination', '--source-workspace', workspace, '--target-workspace', workspace, '--include-project', '--source-directory', wrong]);
  const failed = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(failed.sourceViews.directory.confirmed, false); assert.equal(failed.sourceViews.discoveryStarted, false);
  const failedSelectionId = failed.sourceViews.directory.params.selectionId;
  assert.equal(failed.selections.length, 0); assert.equal(failed.copyPrepared, false);
  assert.ok(notices.length >= 2);
  let stages = 0, derived = false, reportPage = false;
  await dialog(frame => {
    if (frame.code === 'transfer_menu') return ['source-reset', 'select', 'select', 'quit'][stages++];
    if (frame.code === 'transfer_source_reset_confirm') return 'yes';
    if (frame.code === 'transfer_source_directory') return 'directory';
    if (frame.code === 'transfer_source_directory_path') return root;
    if (frame.code === 'transfer_source_directory_confirm') return 'yes';
    if (frame.code === 'transfer_sources') {
      assert.ok(frame.choices.items.length <= 10);
      if (!derived) { derived = true; return `layers ${frame.choices.items.find(row => row.scope === 'user').number}`; }
      assert.ok(frame.choices.items.some(row => row.scope === 'codex-project-layers' && row.selected));
      assert.ok(!frame.choices.items.some(row => ['user', 'project'].includes(row.scope)));
      return 'done';
    }
    if (frame.code === 'configuration_layers_page') {
      if (!reportPage) { reportPage = true; assert.equal(frame.choices.hasNextPage, true); return 'next'; }
      return 'back';
    }
    assert.fail(`Unhandled source views question: ${frame.code}`);
  });
  assert.equal(transport.dropped(), 1, 'the accepted explicit directory result is lost exactly once; only the next explicit select reconciles it');
  const saved = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(saved.requestId, failed.requestId); assert.equal(saved.adoptionId, failed.adoptionId);
  assert.notEqual(saved.sourceViews.directory.params.selectionId, failedSelectionId);
  assert.equal(saved.sourceViews.directory.confirmed, true); assert.equal(saved.selections.length, 1);
  assert.equal(saved.selections[0].sourceId, saved.sourceViews.codexLayers.result.source.sourceId);
  assert.ok(reports.every(report => report.fields.length <= 10)); assert.ok(reports.some(report => report.pageIndex === 1));
  // Reopen a live source grant before publication and retain the exact saved identities.
  menu = 0; reportPage = false;
  await dialog(frame => {
    if (frame.code === 'transfer_menu') return ['select', 'quit'][menu++];
    if (frame.code === 'transfer_sources') return reportPage ? 'done' : 'report 1';
    if (frame.code === 'configuration_layers_page') { reportPage = true; return 'back'; }
    assert.fail(`Reopen must not ask for a new directory: ${frame.code}`);
  });
  const reopened = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(reopened.sourceViews.directory.params.selectionId, saved.sourceViews.directory.params.selectionId);
  assert.equal(reopened.sourceViews.codexLayers.result.source.sourceId, saved.sourceViews.codexLayers.result.source.sourceId);
  const tui = context.spawnOwned('terminal-source-views-real-pty', process.execPath, [
    resolve(repoRoot, 'crates/kcoder_repl/tests/migration-guided-transfer-terminal.e2e.mjs'),
    '--description', 'owned-native-directory-and-layer-selection',
  ], { cwd: repoRoot, env: context.isolatedEnvironment({
    KCODER_GUIDE_TUI_GATEWAY: transport.baseUrl, KCODER_GUIDE_TUI_RECORD: record,
    KCODER_OWNED_GUIDE_TUI_ACCESS: token, KCODER_MIGRATION_TUI_BINARY: binary,
    KCODER_GUIDE_TUI_SOURCE_VIEWS: '1', KCODER_GUIDE_TUI_SOURCE_ROOT: root,
    KCODER_GUIDE_TUI_CHROMIUM: await requireExecutable(process.env.KCODER_E2E_CHROMIUM_BIN || chromium.executablePath(), 'TUI Chromium'),
  }) });
  let tuiOutput = '';
  tui.stdout.on('data', bytes => { tuiOutput += bytes; assert.ok(tuiOutput.length <= 65536); });
  await waitFor(() => tui.exitCode !== null, 150000, 'real PTY directory and layer selection', 30, context.abortSignal);
  assert.equal(tui.exitCode, 0, 'inspect terminal-source-views-real-pty.log');
  const tuiEvidence = JSON.parse(tuiOutput.trim().split('\n').at(-1));
  const tuiAssertions = JSON.parse(await readFile(resolve(tuiEvidence.directory, 'assertions.json'), 'utf8'));
  assert.equal(tuiAssertions.sourceViewsAndExplicitDirectory, true); assert.equal(tuiAssertions.modelRequests, 0);
  menu = 0;
  await dialog(frame => {
    if (frame.code === 'transfer_menu') return ['copy', 'release', 'quit'][menu++];
    if (['transfer_copy_confirm', 'transfer_release_confirm'].includes(frame.code)) return 'yes';
    assert.fail(`Unhandled transfer copy: ${frame.code}`);
  });
  const complete = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(complete.copyPrepared, true); assert.ok(complete.manifestSha256);
  assert.equal(await readFile(resolve(root, 'config.toml'), 'utf8'), config);
  await rename(root, `${root}.withheld`);
  menu = 0;
  await dialog(frame => {
    if (frame.code === 'transfer_menu') return ['reconnect', 'read', 'release', 'quit'][menu++];
    if (['transfer_reconnect', 'transfer_release_confirm'].includes(frame.code)) return 'yes';
    assert.fail(`Frozen target read cannot rescan the removed source: ${frame.code}`);
  });
  assert.deepEqual(await readFile(resolve(targetProfile, 'settings.json')), targetBefore);
  const final = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(final.requestId, saved.requestId); assert.equal(final.attemptId, saved.attemptId); assert.equal(final.manifestSha256, complete.manifestSha256);
  const claude = context.pathInState('terminal-claude-view-root');
  await mkdir(claude, { mode: 0o700 }); await mkdir(resolve(workspace, '.claude'), { mode: 0o700 });
  await writeFile(resolve(claude, 'settings.json'), JSON.stringify({ model: 'source-static', env: { ANTHROPIC_BASE_URL: 'https://never-called.invalid' }, permissions: { defaultMode: 'default' } }), { mode: 0o600 });
  await writeFile(resolve(workspace, '.claude/settings.json'), JSON.stringify({ model: 'project-static' }), { mode: 0o600 });
  const claudeRecord = resolve(cache, 'claude-report.json'); let claudeMenu = 0, shownClaude = false;
  await runMigrationGuideDialog({ context, binary, gateway: gateway.baseUrl, token, workspace, record: claudeRecord,
    label: 'terminal-claude-source-layer-report', args: ['--source-target', 'source', '--target', 'destination',
      '--source-workspace', workspace, '--include-project', '--source-directory', claude],
    answer: frame => {
      if (frame.code === 'source') return 'claude-code';
      if (frame.code === 'transfer_source_directory_confirm') return 'yes';
      if (frame.code === 'transfer_menu') return ['select', 'release', 'quit'][claudeMenu++];
      if (frame.code === 'transfer_sources') {
        const row = frame.choices.items.find(row => row.scope === 'project-effective');
        assert.ok(row, 'the owned source child must expose the effective static Claude snapshot');
        return shownClaude ? 'quit' : `report ${row.number}`;
      }
      if (frame.code === 'configuration_layers_page') { shownClaude = true; return 'back'; }
      if (frame.code === 'transfer_release_confirm') return 'yes';
      assert.fail(`Unhandled Claude report prompt: ${frame.code}`);
    }, observe: (frame, raw) => {
      assert.ok(!raw.includes(claude));
      if (frame.type === 'configuration_layers') {
        assert.equal(frame.result.status, 'available'); assert.ok(frame.result.layers.length >= 3);
        assert.ok(frame.result.fields.length <= 10);
      }
    },
  });
  assert.equal(shownClaude, true);
  await context.writeArtifactJson('terminal-source-views.json', { trace, requestId: final.requestId, adoptionId: final.adoptionId,
    failedSelectionId, selectedDirectoryId: saved.sourceViews.directory.params.selectionId, sourceRootRedacted: true, lostDirectoryReplyReconciled: true, directoryReplyDrops: transport.dropped(),
    failedRootNeverDiscoveredDefault: true, claudeSameChildLayerReport: shownClaude, exactNativeReplacement: true, reportPages: reports.map(row => row.pageIndex), reportSourceIds: reports.map(row => row.target.sourceId),
    targetReceiptRecoveredWithoutSource: true, targetSettingsUnchanged: true, imported: false, tuiArtifactDirectory: tuiEvidence.directory });
}
