import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runE2E } from '../harness/run-context.mjs';
import { runWindowsPackageProbe } from '../harness/windows-package-probe.mjs';
const directory = '/tmp/kcoder-release-1.0.0-current-20261028/target/packages/kcoder-studio/windows';
const installer = join(directory, 'KCoder-Studio-Setup-1.0.0-win-x64.exe');
async function digest(path) { const hash = createHash('sha256'); for await (const part of createReadStream(path)) hash.update(part); return hash.digest('hex'); }
await runE2E(import.meta.url, { testId: 'windows-task-board-terminal-state', tier: 'full-integration',
  modelPolicy: 'model-independent: actual frozen Windows package, bounded local provider fixture, isolated profile; no personal sessions or external model calls' }, async context => {
  const output = context.pathInState('installer-payload');
  const extractor = context.spawnOwned('extract-exact-installer-payload', '/root/.cache/electron-builder/7zip@1.0.0/7zip-linux-x64-16wjr/bin/7zz', ['x', '-y', `-o${output}`, installer, '$PLUGINSDIR/app-64.7z']);
  const code = await new Promise((accept, reject) => { extractor.once('error', reject); extractor.once('close', accept); });
  assert.equal(code, 0);
  const archive = join(output, '$PLUGINSDIR', 'app-64.7z');
  const resources = join(directory, 'win-unpacked/resources');
  const manifest = JSON.parse(await readFile(join(resources, 'kcoder-release-manifest.json'), 'utf8'));
  const options = {
    target: 'win-cyx-ts', node: 'C:\\Program Files\\nodejs\\node.exe', parent: 'C:\\Users\\cyx\\AppData\\Local\\Temp',
    archive, archiveSha256: await digest(archive), commit: manifest.packagingSource.commit,
    nativeCommit: 'fe6705e7e550e440b62bc13cfc6a42bff90b9080',
    cliSha256: await digest(join(resources, 'bin/kcoder.exe')), focus: 'task-board',
  };
  await context.writeArtifactJson('exact-installer-input.json', { installer, sha256: await digest(installer), sourceCommit: options.commit });
  const result = await runWindowsPackageProbe(context, options);
  console.log(JSON.stringify({ passed: result.passed, runRoot: context.runRoot }));
  return result;
});
