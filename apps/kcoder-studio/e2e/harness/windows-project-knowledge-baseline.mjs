import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { V1, sha256 } from './project-knowledge-fixture.mjs';

const source = 'apps/kcoder-studio/e2e/suites/gateway/project-knowledge-publication.e2e.mjs';
const relative = '.kcoder\\specs\\specs\\core\\spec.md';
const script = fileURLToPath(new URL('windows-project-knowledge-baseline.ps1', import.meta.url));

/** This can normalize only the newly created, exact V1 baseline of this scenario. */
export async function secureWindowsKnowledgeBaseline(context, {
  execute = promisify(execFile), systemRoot = process.env.SystemRoot,
} = {}) {
  assert.equal(context.sourceRelative, source, 'Only the project knowledge Native scenario may secure its baseline');
  assert.match(context.runRoot, /^[A-Za-z]:\\/);
  assert.equal(win32.normalize(context.stateDir).toLowerCase(), win32.join(context.runRoot, 'state').toLowerCase());
  assert.match(systemRoot ?? '', /^[A-Za-z]:\\/);
  const before = sha256(await readFile(script));
  const { stdout } = await execute(win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-RunRoot', context.runRoot, '-ExpectedSha256', sha256(V1),
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536, windowsHide: true,
    env: context.isolatedEnvironment({ TEMP: context.pathInState('tmp'), TMP: context.pathInState('tmp'), TMPDIR: context.pathInState('tmp') }) });
  const receipt = JSON.parse(stdout.trim());
  assert.equal(win32.normalize(receipt.path).toLowerCase(), win32.join(context.stateDir, 'workspaces/project-knowledge', relative).toLowerCase());
  assert.equal(receipt.relative, relative);
  assert.match(receipt.currentSid, /^S-1-[0-9-]+$/);
  assert.equal(receipt.ownerSid, receipt.currentSid);
  for (const key of ['protected', 'singleLink', 'nonReparse']) assert.equal(receipt[key], true);
  assert.equal(receipt.aceCount, 1); assert.equal(receipt.bytes, Buffer.byteLength(V1));
  assert.equal(receipt.sha256Before, sha256(V1)); assert.equal(receipt.sha256After, sha256(V1));
  assert.match(receipt.identityBefore, /^[0-9]+(?::[0-9]+){4}$/);
  assert.equal(receipt.identityAfter, receipt.identityBefore);
  assert.equal(sha256(await readFile(script)), before, 'Baseline helper source changed');
  await context.writeArtifactJson('knowledge-windows-baseline-owner.json', { receipt, script: { path: script, sha256: before } });
  return receipt;
}
