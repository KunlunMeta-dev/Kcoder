import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runE2E, repoRoot } from '../../../harness/run-context.mjs';
import { loadFigmaConfiguration, readFigmaTarget, validateFigmaIdentity } from '../config.mjs';
import { connectFigmaSync } from '../transport/codex.mjs';
import { makeRegistrationScript } from '../transport/registration.mjs';
import { acquireSyncLock, atomicSyncJson, decodeSyncResult } from './job.mjs';

/** Explicit reviewed registration; ordinary sync never invents anchors or routes. */
export async function registerFigmaStates(sourceUrl, manifestPath, bundlePath) {
  const configuration = await loadFigmaConfiguration(repoRoot);
  await readFigmaTarget(configuration);
  const manifest = JSON.parse(await readFile(await realpath(manifestPath), 'utf8'));
  const bundle = JSON.parse(await readFile(await realpath(bundlePath), 'utf8'));
  validateFigmaIdentity(configuration, bundle.checkpoint);
  assert.equal(manifest.schema, 1); assert.equal(manifest.fileKey, configuration.fileKey);
  assert.equal(manifest.rootNodeId, configuration.rootNodeId);
  assert.ok(manifest.id && manifest.states.length);
  for (const state of manifest.states) assert.ok(bundle.states.some(sample => sample.id === state.id), `Unsampled state ${state.id}`);
  return runE2E(sourceUrl, { testId: 'figma-register', tier: 'manual-live', retainSuccessLogs: true,
    modelPolicy: 'Explicit source-reviewed REF anchor and route registration through MCP; no model, Gateway or original designer content writes' }, async run => {
    const { checkpointPath, indexPath, environment } = configuration;
    const release = await acquireSyncLock(`${checkpointPath}.lock`, { jobId: randomUUID(), pid: process.pid, runRoot: run.runRoot });
    run.addCleanup('release Figma registration lock', release);
    const before = await readFile(checkpointPath, 'utf8'), checkpoint = JSON.parse(before);
    assert.ok(!checkpoint.migrations?.some(item => item.id === manifest.id), 'Registration already recorded; use normal sync');
    assert.ok(manifest.states.every(state => !checkpoint.states.some(anchor => anchor.stateId === state.id)), 'State already registered');
    const indexBefore = await readFile(indexPath, 'utf8'), index = JSON.parse(indexBefore);
    const mcp = await connectFigmaSync(run, { server: environment.KCODER_FIGMA_MCP_SERVER, command: environment.KCODER_FIGMA_CODEX_BIN });
    const session = decodeSyncResult(await mcp.call('create_session', { fileKey: configuration.fileKey, description: 'Register reviewed current-source checklist REF states' }));
    await run.writeArtifactJson('intent.json', { manifest, bundlePath: resolve(bundlePath), checkpointPath });
    const receipt = decodeSyncResult(await mcp.call('use_figma', { fileKey: configuration.fileKey, sessionId: session.sessionId,
      skillNames: 'figma-use,figma-generate-design', description: `Register explicit REF anchors: ${manifest.states.map(s => s.id).join(', ')}`,
      code: await makeRegistrationScript(checkpoint, manifest) }));
    await run.writeArtifactJson('receipt.json', receipt);
    // Preserve the authoritative receipt before modifying either shared file.
    assert.equal(await readFile(checkpointPath, 'utf8'), before, 'Checkpoint changed; reconcile saved registration receipt');
    assert.equal(await readFile(indexPath, 'utf8'), indexBefore, 'Index changed; reconcile saved registration receipt');
    const next = { ...checkpoint, states: [...checkpoint.states, ...receipt.anchors], updatedAt: new Date().toISOString() };
    const replacing = new Map((manifest.replaceRoutes || []).map(item => [item.stateId, item.routes]));
    next.routes = next.routes.filter(route => !replacing.has(route.stateId));
    for (const [stateId, routes] of replacing) next.routes.push(...routes.map(route => ({ stateId, ...route })));
    const allIds = new Set(next.states.map(anchor => anchor.stateId));
    assert.ok(next.routes.every(route => allIds.has(route.stateId) && (!route.targetStateId || allIds.has(route.targetStateId))), 'Unregistered route target');
    next.migrations = [...(next.migrations || []), { id: manifest.id, kind: 'explicit-source-registration',
      registeredAt: new Date().toISOString(), states: manifest.states.map(state => state.id), sectionId: receipt.sectionId }];
    await atomicSyncJson(checkpointPath, next);
    index.states.push(...manifest.states.map(state => {
      const anchor = next.states.find(item => item.stateId === state.id);
      return { stateId: state.id, nodeId: anchor.nodeId, sectionId: anchor.sectionId, group: state.group,
        url: `https://www.figma.com/design/${configuration.fileKey}/k-coder?node-id=${anchor.nodeId.replace(':', '-')}` };
    }));
    index.counts.atlasStates = bundle.states.filter(state => state.group !== 'supplement').length;
    index.counts.supplementalStates = bundle.states.filter(state => state.group === 'supplement').length;
    await atomicSyncJson(indexPath, index);
    return { registered: receipt.pendingStates, sectionId: receipt.sectionId, nextStep: 'Apply the same frozen bundle through figma-sync.mjs' };
  });
}
