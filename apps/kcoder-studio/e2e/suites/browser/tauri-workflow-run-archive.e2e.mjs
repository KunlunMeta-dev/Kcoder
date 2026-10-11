import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { openRpc, gatewayRpcUrl, initializeRpc } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

// QA: owned 1024-record profile; no model turns. Preview/cancel preserve data,
// unknown effects block, stale content forces a new preview, committed archive
// releases admission capacity and remains readable after reopening the UI.
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'native-workflow-full-history-safe-archive', tier: 'full-integration',
  modelPolicy: 'model-independent real Tauri/Gateway/app-server/filesystem; zero model requests', retainSuccessLogs: true }, async context => {
  const frozenCli = context.pathInState('owned-kcoder');
  await copyFile(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), frozenCli);
  await chmod(frozenCli, 0o700);
  const cliSha256 = createHash('sha256').update(await readFile(frozenCli)).digest('hex');
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN || resolve(appRoot, 'renderer/src-tauri/target/debug/app'),
    kcoderBin: frozenCli, rendererRoot: process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist') });
  const command = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  let rpc;
  try {
    const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'run-archive' });
    const profile = dirname(client.settingsPath);
    const serversFile = await context.writeStateJson('archive-servers.json', [{ id: 'local', label: 'Owned archive seed', transport: 'local', command: frozenCli, workspace, settingsFile: client.settingsPath }]);
    const gateway = await startGateway(context, { label: 'archive-seed-gateway', workspace, serversFile, kcoderBin: frozenCli, env: { KCODER_CONFIG_DIR: profile } });
    rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
    context.addCleanup('close archive seed rpc', () => rpc.close());
    await initializeRpc(rpc, 'owned-workflow-archive');
    assert.equal((await rpc.request('workflow/capabilities/read', {})).runArchive, true, 'new typed capability must come from the owned executable');
    const flow = await rpc.request('workflow/create', { title: 'Owned run archive' });
    const root = resolve(profile, 'workflow-runs'); await mkdir(root, { mode: 0o700, recursive: true });
    const record = (index, revision = 1) => ({ runId: `run-${String(index).padStart(4, '0')}`, revision, definitionId: null, version: null,
      threadId: 'owned-thread', workspace, status: index === 1 ? 'failed' : 'completed', startedAtMs: 1, updatedAtMs: 2, resumeCount: 0, nodeStates: [] });
    await Promise.all(Array.from({ length: 1024 }, (_, index) => writeFile(resolve(root, `${record(index).runId}.json`), JSON.stringify(record(index)), { mode: 0o600 })));
    const ids = ['run-0000'];
    const initial = await rpc.request('workflow/runs/archive/preview', { runIds: ids });
    assert.equal(initial.activeRecords, 1024); assert.ok(initial.releasableBytes > 0);
    await assert.rejects(rpc.request('workflow/runs/archive', { runIds: ids, previewToken: initial.previewToken, confirm: false }));
    await command('waitFor', 'desktop-sidebar');
    await client.command('navigate', { value: '/workflows' });
    await command('waitFor', `workflow-library-${flow.id}`); await command('click', `workflow-library-${flow.id}`);
    await command('waitFor', 'workflow-run-history-toggle'); await command('click', 'workflow-run-history-toggle'); await command('waitFor', 'workflow-run-archive-open', { enabled: true });
    await command('click', 'workflow-run-archive-open'); await command('waitFor', 'workflow-run-archive-select-run-0000', { enabled: true });
    await command('click', 'workflow-run-archive-select-run-0000'); await command('click', 'workflow-run-archive-preview');
    await command('waitFor', 'workflow-run-archive-confirm', { enabled: true });
    assert.match(await command('getText', 'workflow-run-archive-preview-result'), /1024/);
    await client.capture('archive-preview-zh-light.png');
    await command('click', 'workflow-run-archive-cancel'); assert.ok(await stat(resolve(root, 'run-0000.json')));
    await command('click', 'workflow-run-archive-open'); await command('waitFor', 'workflow-run-archive-select-run-0001', { enabled: true });
    await command('click', 'workflow-run-archive-select-run-0001'); await command('click', 'workflow-run-archive-preview');
    await command('waitFor', 'workflow-run-archive-confirm', { enabled: false });
    assert.match(await command('getText', 'workflow-run-archive-preview-result'), /未知|验证/);
    await command('click', 'workflow-run-archive-select-run-0001'); await command('click', 'workflow-run-archive-select-run-0000');
    await command('click', 'workflow-run-archive-preview'); await command('waitFor', 'workflow-run-archive-confirm', { enabled: true });
    await writeFile(resolve(root, 'run-0000.json'), JSON.stringify(record(0, 2)), { mode: 0o600 });
    await command('click', 'workflow-run-archive-confirm');
    await waitFor(async () => (await command('getText', 'workflow-run-archive-dialog')).includes('stale'), 10000, 'late preview is visibly rejected');
    assert.ok(await stat(resolve(root, 'run-0000.json')));
    const fresh = await rpc.request('workflow/runs/archive/preview', { runIds: ids });
    await command('click', 'workflow-run-archive-preview'); await command('waitFor', 'workflow-run-archive-confirm', { enabled: true });
    await command('click', 'workflow-run-archive-confirm'); await command('waitFor', 'workflow-run-archive-result', { text: '已归档' });
    await waitFor(async () => !(await stat(resolve(root, 'run-0000.json')).then(() => true, () => false)), 10000, 'confirmed observation archival');
    assert.equal((await rpc.request('workflow/runs/list', { limit: 1 })).total, 1023);
    assert.equal((await rpc.request('workflow/runs/archive/read', { runId: ids[0] })).revision, 2);
    assert.equal((await rpc.request('workflow/runs/archive/list', { limit: 1 })).total, 1);
    const receipt = await rpc.request('workflow/runs/archive', { runIds: ids, previewToken: fresh.previewToken, confirm: true });
    assert.deepEqual(receipt.archivedRunIds, ids); assert.equal(receipt.recoveryPending, false);
    await command('click', 'workflow-run-archive-open'); await command('waitFor', 'workflow-run-archive-view-toggle', { enabled: true });
    await command('click', 'workflow-run-archive-view-toggle'); await command('waitFor', 'workflow-run-archive-read-run-0000');
    await client.capture('archived-history-zh-light.png');
    await command('click', 'workflow-run-archive-read-run-0000'); await command('waitFor', 'workflow-run-history', { text: 'run-0000' });
    await client.command('navigate', { value: '/settings/appearance' });
    await command('waitFor', 'appearance-mode-dark'); await command('click', 'appearance-mode-dark');
    await client.command('navigate', { value: '/settings' }); await command('waitFor', 'general-language-en-button'); await command('click', 'general-language-en-button');
    await client.command('navigate', { value: '/workflows' }); await command('waitFor', `workflow-library-${flow.id}`); await command('click', `workflow-library-${flow.id}`);
    await command('waitFor', 'workflow-run-history-toggle'); await command('click', 'workflow-run-history-toggle'); await command('waitFor', 'workflow-run-archive-open', { enabled: true });
    await command('click', 'workflow-run-archive-open'); await command('waitFor', 'workflow-run-archive-view-toggle', { enabled: true }); await command('click', 'workflow-run-archive-view-toggle');
    await command('waitFor', 'workflow-run-archive-read-run-0000');
    assert.doesNotMatch(await command('getText', 'workflow-run-archive-dialog'), /[\u3400-\u9fff]/);
    await client.capture('archived-history-en-dark.png');
    await context.writeArtifactJson('archive-protocol-evidence.json', { cliSha256, capacity: initial.activeRecords, releasedBytes: receipt.releasedBytes, ids, confirmRequired: true, staleRejected: true, archivedReadable: true });
    return { cliSha256, originalRecords: 1024, remainingRecords: 1023, cancelPreserves: true, unknownBlocked: true, staleRejected: true, receiptIdempotent: true, archivedReadable: true, modelRequests: 0 };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { rpc?.close(); await client.stop(); }
});
