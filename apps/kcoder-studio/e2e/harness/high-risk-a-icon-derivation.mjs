import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, runE2E, waitFor } from './run-context.mjs';

await runE2E(import.meta.url, {
  testId: 'approved-icon-512-derivation-a', tier: 'contract', retainSuccessLogs: true,
  modelPolicy: 'pinned Electron Builder icon tool and approved local artwork only; no image generation service or UI redesign',
}, async context => {
  const source = resolve(repoRoot, 'logo/icon.png');
  const before = createHash('sha256').update(await readFile(source)).digest('hex');
  const output = context.pathInState('icon-set');
  await mkdir(output);
  const code = `const {createRequire}=require('node:module');
const requireStudio=createRequire(process.argv[1]);
const builder=createRequire(requireStudio.resolve('electron-builder'));
const {runIconsTool}=builder('app-builder-lib/out/toolsets/icons.js');
runIconsTool({inputFile:process.argv[2],outputFormat:'set',outDir:process.argv[3]}).catch(()=>{console.error('PINNED_ICON_DERIVATION_FAILED');process.exitCode=1});`;
  const child = context.spawnOwned('derive-approved-icon-set', process.execPath,
    ['-e', code, resolve(repoRoot, 'apps/kcoder-studio/package.json'), source, output], {
      env: context.isolatedEnvironment({ ELECTRON_BUILDER_CACHE: context.pathInState('builder-cache') }),
    });
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 120_000, 'pinned icon derivation', 100, context.abortSignal);
  assert.equal(child.exitCode, 0, 'Pinned deterministic icon tool must finish before its output is accepted');
  const generated = resolve(output, '512x512.png');
  const bytes = await readFile(generated);
  assert.equal(bytes.readUInt32BE(16), 512); assert.equal(bytes.readUInt32BE(20), 512);
  const destination = context.pathInArtifacts('derived-linux-icon.png');
  await copyFile(generated, destination);
  const committed = await readFile(resolve(repoRoot, 'apps/kcoder-studio/desktop/icons/icon.png'));
  const pixelScript = `from PIL import Image,ImageChops,ImageStat
import json,sys
a=Image.open(sys.argv[1]).convert('RGBA');b=Image.open(sys.argv[2]).convert('RGBA')
print(json.dumps({'exactRgba':a.tobytes()==b.tobytes(),'meanAbsRgba':ImageStat.Stat(ImageChops.difference(a,b)).mean}))`;
  const pixels = context.spawnOwned('compare-approved-icon-pixels', '/usr/bin/python3', ['-c', pixelScript,
    resolve(repoRoot, 'apps/kcoder-studio/desktop/icons/icon.png'), destination]);
  let comparison = '';
  pixels.stdout.on('data', chunk => { comparison += chunk; });
  await waitFor(() => pixels.exitCode !== null || pixels.signalCode !== null, 10_000, 'approved icon pixel comparison', 20, context.abortSignal);
  assert.equal(pixels.exitCode, 0);
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), before);
  await context.writeArtifactJson('approved-icon-derivation.json', {
    sourceSha256: before, sourceDimensions: [1254, 1254], targetDimensions: [512, 512],
    electronBuilder: '26.15.2', pinnedToolset: 'icons@1.1.0',
    derivedSha256: createHash('sha256').update(bytes).digest('hex'),
    committedSha256: createHash('sha256').update(committed).digest('hex'),
    pixels: JSON.parse(comparison), outputNames: await readdir(output),
  });
});
