import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from '../../harness/run-context.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function seedHistorySourceTransfer(context, workspace, sourceProgram, { products = ['claude-code', 'codex'] } = {}) {
  const profile = context.pathInState('history-source/profile'), claude = context.pathInState('history-source/home/.claude'), codex = context.pathInState('history-source/home/.codex');
  for (const path of [profile, claude, codex]) await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(resolve(profile, 'settings.json'), '{}\n', { mode: 0o600 });
  const files = [], claudeParent = randomUUID(), codexParent = randomUUID();
  for (const source of products) for (let index = 0; index < 13; index++) {
    const session = source === 'claude-code' ? claudeParent : index === 0 ? '10000000-0000-4000-8000-000000000001' : index === 11 ? codexParent : randomUUID();
    let title = `Owned ${source} physical history ${index}`, bytes, file;
    if (source === 'claude-code') {
      file = resolve(claude, index === 0 ? `projects/owned-transfer/${session}.jsonl` : `projects/owned-transfer/${session}/subagents/agent-family-${index}.jsonl`);
      bytes = Buffer.from([{ type: 'user', uuid: 'root', parentUuid: null, sessionId: session, cwd: index === 0 ? workspace : `${workspace}/agent-worktree`, version: '2.1.301', message: { role: 'user', content: title } },
        { type: 'assistant', uuid: 'recorded-tool', parentUuid: 'root', sessionId: session, version: '2.1.301', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'never-run', name: 'Bash', input: { command: `sh ${sourceProgram}` } }] } }].map(value => JSON.stringify(value)).join('\n') + '\n');
    } else if (index === 0) {
      title = 'Owned compressed source history';
      file = resolve(codex, `archived_sessions/rollout-2026-10-17T00-00-00-${session}.jsonl.zst`);
      bytes = await readFile(fileURLToPath(new URL('../../fixtures/migration/history-source-compressed.jsonl.zst', import.meta.url)));
    } else {
      file = resolve(codex, `sessions/2026/10/17/rollout-2026-10-17T00-00-00-${session}.jsonl`);
      bytes = Buffer.from([{ timestamp: '2026-10-17T00:00:00Z', type: 'session_meta', payload: { id: session, timestamp: '2026-10-17T00:00:00Z', cwd: index === 12 ? `${workspace}/fork-worktree` : workspace, ...(index === 12 ? { parent_thread_id: codexParent } : {}), originator: 'codex_cli_rs', cli_version: '0.64.0' } },
        { timestamp: '2026-10-17T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] } },
        { timestamp: '2026-10-17T00:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'never-run', arguments: JSON.stringify({ command: `sh ${sourceProgram}` }) } }].map(value => JSON.stringify(value)).join('\n') + '\n');
    }
    await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { mode: 0o600 });
    const modified = new Date(Date.UTC(2020, 0, 1) + (index === 0 ? 0 : 1000 * (source === 'claude-code' ? 100 - index : index)));
    await utimes(file, modified, modified);
    files.push({ source, session, title, file, bytes, sha256: sha(bytes), oldest: source === 'claude-code' ? index === 12 : index === 0, compressed: file.endsWith('.zst') });
  }
  return { profile, claude, codex, files };
}

export async function exerciseHistorySourceTransfer({ context, page, fixture, destinationProfile, sourceProgram, model }) {
  const dialog = page.getByTestId('migration-dialog');
  await selectAdvancedMigration(dialog, 'source');
  const browser = page.getByTestId('migration-source-browser');
  await browser.locator('#migration-source-device').selectOption('history-source-target');
  await browser.getByTestId('migration-source-mode-history').click();
  const targetSettings = await readFile(resolve(destinationProfile, 'settings.json'));
  const historyBefore = await readdir(resolve(destinationProfile, 'external-history')).then(value => value.sort(), error => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  const queries = [], runs = [], closes = [], receipts = [], summaries = new Map();
  const onRequest = request => {
    if (request.url().endsWith('/api/migration/source-session/query')) queries.push(request.postDataJSON());
    if (request.url().endsWith('/api/migration/source-transfer/run')) runs.push(request.postDataJSON());
  };
  const onResponse = async response => {
    try {
      if (!response.ok()) return;
      const url = response.url(), value = await response.json();
      if (url.endsWith('/api/migration/source-session/close') && value.status === 'released') closes.push(response.request().postDataJSON());
      if (url.endsWith('/api/migration/source-session/query') && value.catalogId) for (const row of value.items) summaries.set(`${value.catalogId}:${row.sourceHandle}`, row);
      if (/\/api\/migration\/source-transfer\/(run|read)$/.test(new URL(url).pathname) && value.result?.receipt) receipts.push(value);
    } catch { /* The visible receipt and owned Native bytes are asserted below. */ }
  };
  page.on('request', onRequest); page.on('response', onResponse);
  const results = [];
  try {
    for (const source of ['claude-code', 'codex']) {
      const panel = browser.getByTestId('migration-history-source-browser');
      await panel.getByRole('button', { name: source === 'codex' ? 'Codex' : 'Claude Code', exact: true }).click();
      assert.equal(runs.length, results.length, 'changing source kind must not start a transfer');
      await panel.getByTestId('migration-history-source-discover').click();
      await waitFor(async () => await panel.getByTestId('migration-history-source-row').count() === 10, 15000, 'ten history source rows');
      assert.ok(await panel.getByText('每份档案保留原标题并独立选择，选择父会话不会自动选中子代理或分支。', { exact: true }).count() > 0, 'the real related-family heading is visible');
      if (source === 'codex') await waitFor(() => [...summaries.values()].some(row => row.source === source && row.parentSessionId), 10000, 'Native sampled the declared Codex fork relationship');
      await page.screenshot({ path: context.pathInArtifacts(`history-family-${source}-first-page.png`) });
      const first = panel.getByTestId('migration-history-source-row').first().getByRole('checkbox');
      const firstTitle = await first.getAttribute('aria-label');
      await first.check();
      assert.equal(await panel.getByRole('checkbox', { checked: true }).count(), 1, 'family headings must not implicitly select related artifacts');
      if (source === 'claude-code') assert.equal(firstTitle, fixture.files.find(item => item.source === source && item.file.endsWith(`${item.session}.jsonl`)).title, 'the original main row precedes newer agent files');
      await panel.getByTestId('migration-history-source-next').click();
      await waitFor(async () => await panel.getByTestId('migration-history-source-row').count() === 3, 15000, 'three physical sources on the second page');
      const oldest = fixture.files.find(item => item.source === source && item.oldest);
      await panel.getByRole('checkbox', { name: oldest.title, exact: true }).check();
      assert.ok((await panel.innerText()).includes('跨页已选 2 项'));
      if (source === 'claude-code') {
        await panel.getByText('父会话在其他页或未被发现。请逐项明确选择需要迁入的档案。', { exact: true }).waitFor();
        await page.screenshot({ path: context.pathInArtifacts('history-family-claude-next-page.png') });
      }
      if (source === 'codex') {
        assert.ok((await panel.innerText()).includes('原始压缩文件'));
        assert.ok((await panel.innerText()).includes('来源已归档'));
      }
      const transfer = panel.getByTestId('migration-history-source-transfer');
      await transfer.evaluate(button => { button.click(); button.click(); });
      const status = panel.getByTestId('migration-transfer-status');
      await status.getByText('资料已接收', { exact: true }).waitFor({ timeout: 30000 });
      await status.getByRole('button', { name: '刷新', exact: true }).click();
      await waitFor(() => receipts.findLast(value => value.requestId === runs.at(-1)?.requestId), 10000, 'read back the original received history receipt');
      const run = runs.at(-1), received = receipts.findLast(value => value.requestId === run.requestId);
      assert.equal(runs.length, results.length + 1, 'duplicate clicks cannot allocate another request/attempt');
      assert.equal(run.selections.length, 2); assert.ok(run.selections.every(item => item.kind === 'history'));
      assert.equal(new Set(run.selections.map(item => item.catalogId)).size, 1);
      assert.equal(Object.keys(run.selections[0]).sort().join(','), 'catalogId,kind,sourceHandle');
      assert.equal(run.source.targetId, 'history-source-target'); assert.equal(run.target.targetId, 'fixture-target');
      const selected = fixture.files.filter(item => item.source === source && [firstTitle, oldest.title].includes(item.title));
      assert.equal(selected.length, 2);
      const receivedDirectory = resolve(destinationProfile, 'migrations/source-transfer/incoming', run.requestId);
      const manifest = JSON.parse(await readFile(resolve(receivedDirectory, 'manifest.json'), 'utf8'));
      assert.equal(manifest.entries.length, 2); assert.equal(received.result.receipt.entries, 2);
      assert.equal(received.result.receipt.bytes, selected.reduce((total, item) => total + item.bytes.length, 0));
      for (const entry of manifest.entries) {
        assert.equal(entry.content.kind, 'history');
        const original = selected.find(item => item.sha256 === entry.sha256); assert.ok(original);
        const snapshot = entry.content.snapshot;
        assert.equal(snapshot.origin.source, source); assert.equal(snapshot.origin.sourceSessionId, original.session);
        const summary = run.selections.map(item => summaries.get(`${item.catalogId}:${item.sourceHandle}`)).find(item => item?.sourceArtifactId === snapshot.origin.sourceArtifactId);
        assert.ok(summary); assert.equal(snapshot.origin.sourceArtifactId ?? null, summary.sourceArtifactId ?? null);
        assert.equal(snapshot.origin.parentSessionId ?? null, summary.parentSessionId ?? null);
        assert.equal(!!snapshot.original, original.compressed);
        assert.deepEqual(await readFile(resolve(receivedDirectory, `${entry.id}${snapshot.original ? '.jsonl.zst' : '.jsonl'}`)), original.bytes);
      }
      assert.deepEqual(await readFile(resolve(destinationProfile, 'settings.json')), targetSettings);
      const historyAfter = await readdir(resolve(destinationProfile, 'external-history')).then(value => value.sort(), error => {
        if (error.code === 'ENOENT') return null; throw error;
      });
      assert.deepEqual(historyAfter, historyBefore, 'receiving does not silently adopt/import history');
      await panel.getByRole('button', { name: '断开来源', exact: true }).click();
      await waitFor(() => closes.some(item => item.sessionId === run.source.sessionId) && closes.some(item => item.sessionId === run.target.sessionId), 10000, 'release precisely this transfer source and destination sessions');
      results.push({ source, requestId: run.requestId, attemptId: run.attemptId, selections: 2, pageSizes: [10, 3], bytes: received.result.receipt.bytes,
        manifestSha256: received.result.receipt.manifestSha256, compressedPhysicalBytesVerified: source === 'codex', sourceAndTargetChildrenReleased: true });
    }
    for (const item of fixture.files) assert.equal(sha(await readFile(item.file)), item.sha256);
    assert.equal(await access(`${sourceProgram}.marker`).then(() => true, () => false), false);
    assert.equal(model.requests.length, 0);
    assert.ok(queries.every(item => item.session.targetId === 'history-source-target' && ['history', 'history_page'].includes(item.query.kind)));
    await context.writeArtifactJson('history-source-transfer-results.json', { passed: true, results, sourceOnlyHistoryQueries: true, maxPageSize: 10,
      selectionAcrossPages: true, groupedClaudeParentAndAgents: true, codexDeclaredForkVisible: true, noImplicitFamilySelection: true, uniqueParentWithDifferentChildCwd: true, opaqueSelectionOnly: true, originalBytesAndProvenancePreserved: true, duplicateClicksSingleRequest: true,
      settingsAndHistoryNotImported: true, sourceUnchanged: true, historicalToolsExecuted: false, modelRequests: 0,
      scope: 'Actual browser/Gateway/two independent Native source and target profiles on this host; no real SSH/HTTP remote OS, native desktop or installer claim.' });
    await page.screenshot({ path: context.pathInArtifacts('history-source-transfer-ready.png') });
    return { historySourceTransfer: true, sources: 2, compressedPhysicalArtifact: true, noModelCalls: true };
  } finally { page.off('request', onRequest); page.off('response', onResponse); }
}
