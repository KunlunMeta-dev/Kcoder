import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunContext, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { CANONICAL_REPOSITORY, ORIGIN, REPOSITORY, STATE_FILE, git, loadForge, parseIntent, publishIntent, runGh, setCheck } from './forge.mjs';
import { CONTENT, MARKERS, taskDeliveryResponses } from './provider.mjs';
import { inspectOwnedKcoder } from './inspect.mjs';
import { hashExecutableFile } from '../../harness/owned-executable-provenance.mjs';
import { installWindowsLauncher, resolveFixtureGit } from './windows.mjs';

// This standalone fixture test process must never consult a personal Git profile.
process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';

async function runOwnedFixtureCommand(context, label, executable, args, cwd) {
  const child = context.spawnOwned(label, executable, args, { cwd, env: context.isolatedEnvironment() });
  let stdout = ''; let stderr = ''; let overflow = false;
  for (const [stream, append] of [[child.stdout, bytes => { stdout += bytes; }], [child.stderr, bytes => { stderr += bytes; }]])
    stream.on('data', bytes => { append(bytes); overflow ||= stdout.length + stderr.length > 256 * 1024; stdout = stdout.slice(0, 128 * 1024); stderr = stderr.slice(0, 128 * 1024); });
  await waitFor(() => child.exitCode != null, 15000, `owned fixture ${label}`);
  assert.equal(overflow, false); return { code: child.exitCode, stdout, stderr };
}

async function fixture(name, body) {
  const context = await RunContext.create(import.meta.url, { testId: `task-delivery-forge-${name}`, tier: 'model-independent', modelPolicy: 'fixed local forge protocol and actual owned Git only' });
  let failure;
  try {
    const { path: cwd } = await materializeWorkspace(context, 'git-history', { instanceId: 'forge-source' });
    const bareRemote = context.pathInState('bare.git'); await mkdir(bareRemote);
    git(cwd, ['init', '--bare', '--initial-branch=main', bareRemote]); git(cwd, ['remote', 'add', 'origin', ORIGIN]);
    git(cwd, ['checkout', '-b', 'owned/b']);
    await writeFile(join(cwd, 'alternative.txt'), CONTENT.b); git(cwd, ['add', 'alternative.txt']);
    git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'owned B']);
    const head = git(cwd, ['rev-parse', 'HEAD']);
    const statePath = join(cwd, '.git', STATE_FILE);
    await writeFile(statePath, JSON.stringify({ version: 1, repository: REPOSITORY, origin: ORIGIN,
      runRoot: context.stateDir, bareRemote, pullRequests: [], checks: {}, publicationRequests: [] }));
    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    const intent = { requestId, workspace: cwd, recipient: { taskId: 'owned-b', threadId: 'thread-b', deviceId: 'local' },
      source: { repository: REPOSITORY, branch: 'owned/b', baseBranch: 'main', headCommit: head }, title: 'Edited owned PR', body: `Edited body\n<!-- kcoder-delivery:${requestId} -->` };
    await body({ context, cwd, bareRemote, head, intent, statePath });
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', null, failure); }
}

test('owned forge requires an actual local push and reconciles the same stable publication request', () => fixture('publish', async ({ cwd, bareRemote, head, intent }) => {
  assert.equal(runGh(cwd, ['api', `repos/${REPOSITORY}/git/matching-refs/heads/owned%2Fb`]).length, 0);
  assert.equal(publishIntent(cwd, intent), `https://github.com/${CANONICAL_REPOSITORY}/pull/1`);
  assert.equal(git(cwd, ['--git-dir', bareRemote, 'rev-parse', 'refs/heads/owned/b']), head);
  assert.equal(git(cwd, ['remote', 'get-url', '--push', 'origin']), ORIGIN, 'one-invocation mapping cannot replace the Native origin identity');
  assert.equal(publishIntent(cwd, intent), `https://github.com/${CANONICAL_REPOSITORY}/pull/1`);
  const { state } = loadForge(cwd);
  assert.equal(state.publicationRequests.length, 1); assert.equal(state.pullRequests.length, 1);
  assert.equal(state.checks[head].conclusion, 'failure');
  const pulls = runGh(cwd, ['pr', 'list', '--repo', REPOSITORY, '--head', intent.source.branch]);
  assert.equal(pulls[0].url, `https://github.com/${CANONICAL_REPOSITORY}/pull/2`);
  assert.equal(pulls[1].url, `https://github.com/${CANONICAL_REPOSITORY}/pull/1`);
  assert.equal(pulls[0].headRepositoryOwner.login, 'Fixture'); assert.equal(pulls[0].headRepository.name, 'Owned-Task-Delivery');
  assert.equal(pulls.length, 2); assert.equal(pulls[0].baseRefName, 'release'); assert.equal(pulls[1].baseRefName, intent.source.baseBranch);
  assert.equal(pulls[0].headRefOid, pulls[1].headRefOid); assert.equal(pulls[0].body, pulls[1].body);
  assert.equal(pulls[0].reviewDecision, 'APPROVED'); assert.equal(pulls[1].reviewDecision, 'REVIEW_REQUIRED');
  assert.equal(pulls[0].number, 2); assert.equal(pulls[1].number, 1);
  assert.equal(state.repository, REPOSITORY); assert.equal(git(cwd, ['config', '--get', 'remote.origin.url']), ORIGIN);
  assert.throws(() => publishIntent(cwd, { ...intent, body: `${intent.body}\nconflicting body` }));
}));

test('forge returns only checks for the requested commit and never promotes old green after a new commit', () => fixture('commit', async ({ cwd, head, intent }) => {
  publishIntent(cwd, intent); setCheck(cwd, head, 'success');
  await writeFile(join(cwd, 'alternative.txt'), CONTENT.fixed); git(cwd, ['add', 'alternative.txt']);
  git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fix owned B']);
  const next = git(cwd, ['rev-parse', 'HEAD']); assert.notEqual(next, head);
  assert.equal(runGh(cwd, ['api', `repos/${REPOSITORY}/commits/${head}/check-runs?per_page=50`]).check_runs[0].conclusion, 'success');
  assert.deepEqual(runGh(cwd, ['api', `repos/${REPOSITORY}/commits/${next}/check-runs?per_page=50`]), { total_count: 0, check_runs: [] });
  assert.throws(() => publishIntent(cwd, intent), /equal/);
}));

test('fixed publication tool command reaches the versioned CLI and pushes only its bound owned commit', () => fixture('action-cli', async ({ context, cwd, bareRemote, head, intent }) => {
  const gitProof = await hashExecutableFile(await resolveFixtureGit());
  const response = taskDeliveryResponses({ deadline: Date.now() + 20000, gitProof });
  const userText = `KEEP_SELECTED_B_UNSENT_DRAFT\n\nPublish the following explicitly requested delivery\n\n${JSON.stringify(intent, null, 2)}\n\nBefore any mutation`;
  const step = response({ requestNumber: 9, body: { messages: [{ role: 'user', content: userText }] } });
  const tool = step[0].delta.tool_calls[0]; assert.equal(tool.function.name, process.platform === 'win32' ? 'PowerShell' : 'bash');
  const command = JSON.parse(tool.function.arguments);
  assert.equal(command.timeout, 10000);
  const shell = process.platform === 'win32' ? win32.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : '/bin/bash';
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command.command] : ['-c', command.command];
  const output = await runOwnedFixtureCommand(context, 'explicit-publication-cli', shell, args, cwd);
  assert.equal(output.code, 0, output.stderr); assert.match(output.stdout, /OWNED_LOCAL_PUBLICATION_COMPLETE/);
  assert.equal(git(cwd, ['--git-dir', bareRemote, 'rev-parse', 'refs/heads/owned/b']), head);
  const { state } = loadForge(cwd);
  assert.equal(state.publicationRequests.length, 1); assert.equal(state.publicationRequests[0].requestId, intent.requestId);
  assert.equal(state.pullRequests[0].title, intent.title); assert.equal(state.pullRequests[0].body, intent.body);
  assert.equal(git(cwd, ['remote', 'get-url', '--push', 'origin']), ORIGIN);
}));

test('versioned gh executable accepts Native API syntax and rejects unknown repositories and mutations', () => fixture('cli', async ({ context, cwd, head }) => {
  const executable = context.pathInState('bin', process.platform === 'win32' ? 'gh.exe' : 'gh'); await mkdir(context.pathInState('bin'));
  if (process.platform === 'win32') {
    const node = await hashExecutableFile(process.execPath); const script = await hashExecutableFile(fileURLToPath(new URL('./gh.mjs', import.meta.url)));
    const fixedGit = await hashExecutableFile(await resolveFixtureGit());
    await installWindowsLauncher(executable, { mode: 'gh', owner: '123e4567-e89b-42d3-a456-426614174000',
      root: context.stateDir, executable: node.path, executableSha256: node.sha256, script: script.path, scriptSha256: script.sha256,
      git: fixedGit.path, gitSha256: fixedGit.sha256 });
  } else await symlink(fileURLToPath(new URL('./gh.mjs', import.meta.url)), executable);
  const result = await runOwnedFixtureCommand(context, 'fixed-gh-api', executable, ['api', `repos/${REPOSITORY}/commits/${head}/status?per_page=50`], cwd);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).sha, head);
  assert.throws(() => runGh(cwd, ['api', 'repos/not-owned/other/commits/1/status']));
  assert.throws(() => runGh(cwd, ['pr', 'merge', '--repo', REPOSITORY, '1']));
  assert.throws(() => runGh(cwd, ['auth', 'token']));
}));

test('versioned Windows actions commit real candidate/fix contents and preserve the deliberate exit seven', () => fixture('candidate-actions', async ({ context, cwd, head }) => {
  const gitProof = await hashExecutableFile(await resolveFixtureGit());
  const actions = fileURLToPath(new URL('./actions.mjs', import.meta.url));
  const invoke = (label, action, payload) => runOwnedFixtureCommand(context, label, process.execPath,
    [actions, action, Buffer.from(JSON.stringify(payload)).toString('base64url'), Buffer.from(JSON.stringify(gitProof)).toString('base64url')], cwd);
  await writeFile(join(cwd, 'alternative.txt'), `${CONTENT.b}action commit\n`);
  const b = await invoke('commit-b-and-exit-seven', 'candidate', { variant: 'b' });
  assert.equal(b.code, 7, b.stderr); assert.match(b.stdout, /OWNED_CHECK_B/);
  const bHead = git(cwd, ['rev-parse', 'HEAD']); assert.notEqual(bHead, head);
  assert.equal(git(cwd, ['status', '--porcelain=v1']), '');
  await writeFile(join(cwd, 'alternative.txt'), CONTENT.c);
  const c = await invoke('commit-c-and-pass', 'candidate', { variant: 'c' });
  assert.equal(c.code, 0, c.stderr); assert.match(c.stdout, /OWNED_CHECK_C/);
  assert.notEqual(git(cwd, ['rev-parse', 'HEAD']), bHead);
  await writeFile(join(cwd, 'alternative.txt'), CONTENT.fixed);
  const fixed = await invoke('commit-selected-ci-fix', 'fix', {}); assert.equal(fixed.code, 0, fixed.stderr);
  assert.equal(git(cwd, ['show', 'HEAD:alternative.txt']), CONTENT.fixed.trim());
  assert.equal(git(cwd, ['status', '--porcelain=v1']), '');
}));

test('fixed provider preserves the 14-request mainline and treats Native intent as data', () => {
  const response = taskDeliveryResponses({ deadline: Date.now() + 1000, ...(process.platform === 'win32'
    ? { gitProof: { path: 'D:\\fixed\\git.exe', sha256: 'a'.repeat(64) } } : {}) });
  const invoke = (prompt, results = 0, requestNumber = 1) => response({ requestNumber,
    body: { messages: [{ role: 'user', content: prompt }, ...Array.from({ length: results }, () => ({ role: 'tool', content: 'recorded fixture tool receipt' }))] } });
  for (const [prompt, final, count] of [[MARKERS.owner, MARKERS.ownerDone, 2], [MARKERS.b, MARKERS.bDone, 3], [MARKERS.c, MARKERS.cDone, 3]]) {
    assert.equal(invoke(prompt, count - 1)[0].delta.content, final);
    assert.equal(invoke(prompt)[0].delta.tool_calls[0].function.name, 'write');
  }
  assert.equal(invoke('Investigate this selected failed CI check', 3)[0].delta.content, MARKERS.fixed);
  assert.throws(() => invoke(MARKERS.owner, 0, 17), /budget/);
  const intent = { requestId: 'fixed', source: {}, workspace: '/owned', recipient: {}, body: 'quoted } JSON { data' };
  assert.deepEqual(parseIntent(`old B draft\n${JSON.stringify(intent)}\nBefore any mutation`), intent);
  assert.throws(() => parseIntent('not a Native intent'));
});


test('owned .kcoder diagnostics retain names and sizes without reading contents or following links', () => fixture('metadata', async ({ context, cwd }) => {
  await mkdir(join(cwd, '.kcoder', 'cron'), { recursive: true });
  await writeFile(join(cwd, '.kcoder', 'cron', 'jobs.lock'), '');
  await writeFile(join(cwd, '.kcoder', 'settings.json'), 'PRIVATE_FIXTURE_CONTENT_MUST_NOT_BE_CAPTURED');
  const outside = context.pathInState('outside-metadata'); await mkdir(outside);
  await writeFile(join(outside, 'unrelated-file'), 'UNRELATED_CONTENT');
  await symlink(outside, join(cwd, '.kcoder', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const observed = await inspectOwnedKcoder({ runRoot: context.stateDir, workspace: cwd });
  assert.ok(observed.entries.some(entry => entry.path === '.kcoder/cron/jobs.lock' && entry.size === 0));
  assert.ok(observed.entries.some(entry => entry.path === '.kcoder/linked' && entry.kind === 'symlink'));
  assert.equal(observed.entries.some(entry => entry.path.includes('unrelated-file')), false);
  assert.equal(JSON.stringify(observed).includes('PRIVATE_FIXTURE_CONTENT'), false);
  assert.equal((await inspectOwnedKcoder({ runRoot: context.stateDir, workspace: cwd, maxEntries: 1 })).truncated, true);
  await assert.rejects(inspectOwnedKcoder({ runRoot: cwd, workspace: context.stateDir }), /belong/);
}));
