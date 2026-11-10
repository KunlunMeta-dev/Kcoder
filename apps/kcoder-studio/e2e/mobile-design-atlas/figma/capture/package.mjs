import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compactScene } from './scene.mjs';
import { syncSourceHash } from '../sync/core.mjs';

import { repoRoot } from '../../../harness/run-context.mjs';

/** Called inside the exporter's RunContext; never writes into the running app. */
export async function writeFigmaSyncPackage({ artifactsDir, data, checkpointPath }) {
  const checkpoint = JSON.parse(await readFile(checkpointPath || resolve(repoRoot, 'docs/phone/figma-sync-checkpoint.json'), 'utf8'));
  if (checkpoint.schema !== 1 || !checkpoint.states?.length || !checkpoint.routes) throw new Error('Invalid checkpoint');
  const states = data.states.map(s => ({ id: s.id, title: s.title, group: s.group, condition: s.condition,
    transition: s.transition, scene: compactScene(s.scene.root) }));
  // Feature-specific conversion changes refresh affected states even when source
  // geometry is unchanged; other states retain their existing render digests.
  const hasStrike = node => node.s?.decoration?.includes('line-through') || node.c?.some(hasStrike);
  for (const state of states) if (hasStrike(state.scene)) state.renderRevision = 'strikethrough-1';
  const ids = new Set();
  for (const state of states) {
    if (ids.has(state.id) || !state.scene) throw new Error(`Duplicate/empty state ${state.id}`);
    ids.add(state.id);
  }
  const bundle = { schema: 1, interfaceVersion: 'V3', generatedAt: new Date().toISOString(), componentSourceHash: data.sourceHash,
    checkpoint, states };
  const output = resolve(artifactsDir, 'figma-sync'); await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'sync-bundle.json'), JSON.stringify(bundle));
  const builder = (await readFile(new URL('../canvas/builder.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const core = (await readFile(new URL('../sync/core.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const main = await readFile(new URL('../transport/plugin.js', import.meta.url), 'utf8');
  await writeFile(resolve(output, 'code.js'), `${builder}\n${core}\nconst bundledSyncPackage = ${JSON.stringify(bundle)};\n${main}`);
  await writeFile(resolve(output, 'ui.html'), await readFile(new URL('../transport/plugin.html', import.meta.url), 'utf8'));
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ name: 'KCoder V3 REF 同步', id: 'kcoder-v3-reference-sync',
    api: '1.0.0', editorType: ['figma'], main: 'code.js', ui: 'ui.html', documentAccess: 'dynamic-page',
    networkAccess: { allowedDomains: ['none'] } }, null, 2));
  await writeFile(resolve(output, 'package-report.json'), JSON.stringify({ schema: 1, stateCount: states.length,
    pendingAnchors: states.filter(s => !checkpoint.states.some(c => c.stateId === s.id)).map(s => s.id),
    omittedStatesRetained: checkpoint.states.filter(c => !ids.has(c.stateId)).map(s => s.stateId),
    sourceHashes: Object.fromEntries(states.map(s => [s.id, syncSourceHash(s)])),
    boundaries: ['Offline synthetic fixture only', 'No Figma network write from Node', 'Explicit plugin/MCP apply required'] }, null, 2));
  return { output, stateCount: states.length };
}
