import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'native-wiki-actual-lexical-search-revision-and-library-isolation', tier: 'manual-live',
  modelPolicy: 'model-independent retrieval of verbatim repository documents; no model calls, fixture generation, or LLM quality claim',
}, async context => {
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: binary, rendererRoot: resolve(appRoot, 'renderer/dist') });
  const profile = dirname(client.settingsPath), workspace = resolve(profile, '../workspaces/tauri-verification');
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await cmd('waitFor', 'desktop-sidebar');
    const settings = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    settings.knowledge = { enabled: true };
    await writeFile(client.settingsPath, JSON.stringify(settings), { mode: 0o600 });
    const gateway = await startGateway(context, { label: 'retrieval-gateway', workspace, kcoderBin: binary,
      env: { KCODER_CONFIG_DIR: profile } });
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
    context.addCleanup('close native retrieval RPC', () => rpc.close());
    await initializeRpc(rpc, 'native-wiki-retrieval');
    const library = await rpc.request('knowledge/create', { idempotencyKey: 'retrieval-library', name: 'Verbatim repository corpus' });
    const empty = await rpc.request('knowledge/create', { idempotencyKey: 'empty-library', name: 'Empty scoped library' });
    const files = ['docs/kcoder-wiki-validation-2026-09-29.md', 'docs/optimization-2026-10-03/p06-workflow-canvas.md'];
    const sources = [];
    for (const [index, file] of files.entries()) {
      const text = await readFile(resolve(repoRoot, file), 'utf8');
      const title = text.split('\n')[0].replace(/^#\s*/, '');
      const imported = await rpc.request('knowledge/source/importText', { libraryId: library.id,
        idempotencyKey: `document-${index}`, title, text });
      sources.push({ file, title, sourceId: imported.sourceId, revisionId: imported.revisionId,
        sha256: createHash('sha256').update(text).digest('hex') });
    }
    await rpc.request('knowledge/default/set', { libraryId: library.id });
    const fixedQueries = [
      { query: sources[0].title, expectedSource: sources[0].sourceId },
      { query: 'Wiki 存储审计', expectedSource: sources[0].sourceId },
      { query: '工作流画布', expectedSource: sources[1].sourceId },
      { query: '不存在量子飞船装配协议', expectedSource: null },
    ];
    const results = [];
    for (const item of fixedQueries) {
      const started = performance.now();
      const result = await rpc.request('knowledge/search', { libraryId: library.id, query: item.query, limit: 5 });
      const elapsedMs = performance.now() - started;
      if (item.expectedSource) assert.ok(result.items.some(hit => hit.documentId.startsWith(`source:${item.expectedSource}:`)));
      else assert.equal(result.items.length, 0);
      assert.equal(new Set(result.items.map(hit => hit.documentId.startsWith('source:') ? hit.documentId.split(':')[1] : hit.documentId)).size, result.items.length);
      results.push({ ...item, elapsedMs, items: result.items });
    }
    await cmd('click', 'knowledge-button');
    await cmd('waitFor', 'knowledge-library-picker', { text: 'Verbatim repository corpus' });
    await cmd('fill', 'knowledge-library-picker', { value: library.id });
    await cmd('fill', 'wiki-search', { value: sources[0].title });
    await client.command('waitFor', { selector: '.max-h-64 button', text: sources[0].title });
    const visibleHit = await client.command('getText', { selector: '.max-h-64 button' });
    assert.ok(visibleHit.includes(sources[0].revisionId), 'native result exposes actual immutable revision');
    await client.command('click', { selector: '.max-h-64 button' });
    await cmd('waitFor', 'wiki-original-reader', { text: '库身份' });
    await cmd('click', 'wiki-original-reader-close');
    await cmd('fill', 'wiki-search', { value: '不存在量子飞船装配协议' });
    await client.command('waitFor', { selector: '.max-h-64', text: '未找到相关依据' });
    await cmd('fill', 'wiki-search', { value: sources[0].title });
    await client.command('waitFor', { selector: '.max-h-64 button', text: sources[0].title });
    await cmd('fill', 'knowledge-library-picker', { value: empty.id });
    await waitFor(async()=>await cmd('getValue','wiki-search')==='',5000,'new library search component is mounted');
    await cmd('fill', 'wiki-search', { value: sources[0].title });
    await client.command('waitFor', { selector: '.max-h-64', text: '未找到相关依据' });
    assert.equal(await client.command('getElementCount', { selector: '.max-h-64 button' }), '0');
    await client.capture('native-retrieval-scope-isolation.png');
    await context.writeArtifactJson('retrieval-evidence.json', { sources, fixedQueries: results,
      nativeChineseSearch: true, nativeExactRevisionOpened: true, nativeNoAnswer: true, librarySwitchClearsResults: true,
      latencyScope: 'one measured pass over two actual repository documents, includes Gateway RPC; no large/cold corpus inference' });
    return { passed: true, native: true, actualGateway: true, fixedQueries: fixedQueries.length };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
