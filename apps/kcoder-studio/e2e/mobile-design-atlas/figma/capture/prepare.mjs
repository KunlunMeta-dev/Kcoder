import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { runE2E, repoRoot } from '../../../harness/run-context.mjs';
import { writeFigmaSyncPackage } from './package.mjs';

import { loadFigmaConfiguration, readFigmaTarget } from '../config.mjs';

process.umask(0o077);

export async function prepareFigmaSync(sourceUrl) {
const configuration = await loadFigmaConfiguration(repoRoot);
await readFigmaTarget(configuration);
return runE2E(sourceUrl, { testId: 'figma-sync-prepare', tier: 'manual-live', retainSuccessLogs: true,
  modelPolicy: 'Repackage previously sampled synthetic component scenes with the latest REF checkpoint; no browser, model, Gateway or Figma writes' }, async run => {
  assert.ok(process.env.KCODER_FIGMA_SCENES, 'Set KCODER_FIGMA_SCENES to a successful export artifacts/editable-scenes.json');
  const input = await realpath(process.env.KCODER_FIGMA_SCENES);
  const relativeInput = relative(resolve(repoRoot, 'target/test'), input);
  assert.ok(relativeInput && relativeInput.split(sep)[0] !== '..' && !isAbsolute(relativeInput), 'Scene export must belong to the test harness');
  const evidence = JSON.parse(await readFile(resolve(dirname(input), '../manifest.json'), 'utf8'));
  assert.equal(evidence.status, 'passed', 'Scene export run must have passed');
  const bytes = await readFile(input), data = JSON.parse(bytes);
  assert.ok(data.states?.length && data.sourceHash, 'Missing scene provenance');
  const result = await writeFigmaSyncPackage({ artifactsDir: run.artifactsDir, data, checkpointPath: configuration.checkpointPath });
  await run.writeArtifactJson('scene-provenance.json', { input, sha256: createHash('sha256').update(bytes).digest('hex'),
    componentSourceHash: data.sourceHash, recapturedCurrentSource: false, boundary: 'Uses the recorded source snapshot, not a fresh current-source UI build' });
  console.log(`FIGMA_SYNC_READY ${result.output}`);
  return result;
});
}
