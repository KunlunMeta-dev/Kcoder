import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, lstat, chmod } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

// Retained public fixture data is explicit replay evidence, not executable test source.
export async function retainWebReplayWorkspace(context, temporary) {
  const target = context.pathInArtifacts('native-session/workspace');
  await copyStrict(context, temporary.path, target);
  await context.writeArtifactJson('native-session/workspace-source.json', { templateId: temporary.metadata.id, version: temporary.metadata.version, sourceDigest: temporary.sourceDigest, retainedForReadOnlyTuiReplay: true });
  return target;
}

export async function exportWebNativeHistory(context, threadId, settingsFile) {
  assert.match(threadId, /^[A-Za-z0-9_-]{1,128}$/);
  const files = [];
  async function walk(path) { for (const entry of await readdir(path, { withFileTypes: true })) { const full = resolve(path, entry.name); if (entry.isDirectory()) await walk(full); else if (entry.isFile() && entry.name === `${threadId}.jsonl`) files.push(full); } }
  await walk(context.stateDir); assert.equal(files.length, 1, 'Exactly one original owned history source is required');
  const source = files[0], target = context.pathInArtifacts(`native-session/${threadId}.jsonl`);
  const rows = (await readFile(source, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(rows.some(row => row.webSources?.length), 'Actual native sources must already exist before export');
  const copied = [];
  for (const from of [source, source.replace(/\.jsonl$/, '.hctl'), resolve(dirname(source), threadId)]) {
    const to = context.pathInArtifacts('native-session', basename(from));
    await copyStrict(context, from, to, copied);
  }
  const settings = await readFile(settingsFile, 'utf8'); assertNoSecret(context, settings);
  const model = JSON.parse(settings); assert.equal(model.web, undefined); assert.equal(model.mcp, undefined);
  await context.writeArtifactJson('native-session/model-connection.json', model);
  await context.writeArtifactJson('native-session/files.json', { threadId, files: copied });
  return { path: target, sha256: createHash('sha256').update(await readFile(target)).digest('hex'), originalSource: relative(context.stateDir, source), threadId, rows: rows.length, sidecarsAndNativeControls: copied.map(file => file.path) };
}

async function copyStrict(context, source, target, receipt = [], budget = { files: 0, bytes: 0 }) {
  const sourceRelative = relative(context.stateDir, source), targetRelative = relative(context.artifactsDir, target);
  assert.ok(sourceRelative && !sourceRelative.startsWith(`..${sep}`) && sourceRelative !== '..');
  assert.ok(targetRelative && !targetRelative.startsWith(`..${sep}`) && targetRelative !== '..');
  const stat = await lstat(source); assert.ok(!stat.isSymbolicLink(), 'Replay export refuses symlinks');
  if (stat.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (['llm-requests', 'recovery'].includes(entry.name)) continue;
      await copyStrict(context, resolve(source, entry.name), resolve(target, entry.name), receipt, budget);
    }
    return;
  }
  assert.ok(stat.isFile() && stat.nlink === 1, 'Replay evidence must be an original single-link regular file');
  assert.ok(++budget.files <= 256 && (budget.bytes += stat.size) <= 16 * 1024 * 1024, 'Replay export budget exceeded');
  const bytes = await readFile(source); assertNoSecret(context, bytes.toString('utf8'));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await copyFile(source, target, 1); await chmod(target, 0o600);
  assert.deepEqual(await readFile(target), bytes, 'History/control/sidecar bytes must not be rewritten');
  receipt.push({ path: relative(context.artifactsDir, target), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
function assertNoSecret(context, value) {
  for (const secret of context.secrets) assert.ok(!value.includes(secret), 'Retained native history contains a registered secret');
}
