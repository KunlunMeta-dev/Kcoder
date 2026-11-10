import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export const REPOSITORY = 'fixture/owned-task-delivery';
export const CANONICAL_REPOSITORY = 'Fixture/Owned-Task-Delivery';
export const ORIGIN = `https://github.com/${REPOSITORY}.git`;
export const STATE_FILE = 'kcoder-task-delivery-fixture.json';
const SHA = /^[a-f0-9]{40,64}$/;
const BRANCH = /^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,180}$/;
let gitBinary = process.env.KCODER_E2E_GIT_BIN || 'git';
export function configureFixtureGit(proof) {
  assert.ok(proof && isAbsolute(proof.path) && /^[a-f0-9]{64}$/.test(proof.sha256), 'fixed Git proof is required');
  const info = lstatSync(proof.path);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal(createHash('sha256').update(readFileSync(proof.path)).digest('hex'), proof.sha256, 'fixed Git executable changed');
  gitBinary = proof.path;
}
export function git(cwd, args) {
  return execFileSync(gitBinary, ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args], {
    cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  }).trim();
}
function contained(root, path) {
  const rel = relative(root, path);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'fixture path escaped its owned run');
}
export function loadForge(cwd) {
  const common = realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const path = join(common, STATE_FILE);
  const info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 128 * 1024, 'fixture state must be a bounded regular file');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(state.version, 1); assert.equal(state.repository, REPOSITORY);
  assert.equal(state.origin, ORIGIN); assert.ok(isAbsolute(state.runRoot));
  const runRoot = realpathSync(state.runRoot);
  contained(runRoot, common); contained(runRoot, realpathSync(state.bareRemote));
  assert.equal(git(runRoot, ['--git-dir', state.bareRemote, 'rev-parse', '--is-bare-repository']), 'true');
  assert.ok(Array.isArray(state.pullRequests) && state.pullRequests.length <= 8);
  assert.ok(Array.isArray(state.publicationRequests) && state.publicationRequests.length <= 8);
  assert.ok(state.checks && Object.keys(state.checks).length <= 16);
  return { common, path, state };
}
function saveForge(forge) {
  const temp = `${forge.path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(forge.state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, forge.path);
}
export function remoteHead(cwd, state, branch) {
  assert.ok(BRANCH.test(branch) && !branch.includes('..'));
  try { return git(cwd, ['--git-dir', state.bareRemote, 'rev-parse', '--verify', `refs/heads/${branch}`]); }
  catch (error) { if (error.status === 128) return null; throw error; }
}
export function setCheck(cwd, head, conclusion) {
  assert.ok(SHA.test(head)); assert.ok(['success', 'failure', 'pending'].includes(conclusion));
  const forge = loadForge(cwd);
  const existing = forge.state.checks[head];
  forge.state.checks[head] = { id: existing?.id ?? 7100 + Object.keys(forge.state.checks).length,
    name: 'owned-fixture-ci', head_sha: head, status: conclusion === 'pending' ? 'in_progress' : 'completed',
    conclusion: conclusion === 'pending' ? null : conclusion,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/71`,
    output: { title: `Owned fixture ${conclusion}`, summary: `SELECTED_FIXTURE_CI_${conclusion.toUpperCase()} commit=${head}`, text: 'Synthetic forge response; actual Git commit and push are local.' } };
  saveForge(forge); return forge.state.checks[head];
}
function option(args, key) { const at = args.indexOf(key); return at < 0 ? null : args[at + 1]; }
export function runGh(cwd, args) {
  const forge = loadForge(cwd); const { state } = forge;
  if (args[0] === 'api') {
    const endpoint = args[1]; const prefix = `repos/${REPOSITORY}/`;
    assert.ok(typeof endpoint === 'string' && endpoint.startsWith(prefix), 'fixture refuses another repository or remote host');
    const path = endpoint.slice(prefix.length);
    if (path.startsWith('git/matching-refs/heads/')) {
      const branch = decodeURIComponent(path.slice('git/matching-refs/heads/'.length));
      const sha = remoteHead(cwd, state, branch);
      return sha ? [{ ref: `refs/heads/${branch}`, object: { sha } }] : [];
    }
    let match = /^commits\/([a-f0-9]{40,64})\/check-runs\?per_page=50$/.exec(path);
    if (match) return { total_count: state.checks[match[1]] ? 1 : 0, check_runs: state.checks[match[1]] ? [state.checks[match[1]]] : [] };
    match = /^commits\/([a-f0-9]{40,64})\/status\?per_page=50$/.exec(path);
    if (match) return { sha: match[1], total_count: 0, statuses: [] };
    match = /^check-runs\/(\d+)$/.exec(path);
    if (match) { const check = Object.values(state.checks).find(row => String(row.id) === match[1]); assert.ok(check, 'unknown fixture check'); return check; }
    throw new Error('unsupported fixture API; no network fallback');
  }
  assert.equal(args[0], 'pr'); assert.equal(option(args, '--repo'), REPOSITORY);
  if (args[1] === 'list') {
    const branch = option(args, '--head'); assert.ok(BRANCH.test(branch));
    return state.pullRequests.filter(pr => pr.headRefName === branch).flatMap(pr => {
      const current = { ...pr, headRefOid: remoteHead(cwd, state, branch) ?? pr.headRefOid };
      // Same head/request UUID is insufficient: the Native consumer must reject the wrong-base row first.
      const otherBase = current.baseRefName === 'release' ? 'main' : 'release';
      return [{ ...current, number: current.number + 1, url: `https://github.com/${CANONICAL_REPOSITORY}/pull/${current.number + 1}`,
        baseRefName: otherBase, reviewDecision: 'APPROVED' }, current];
    });
  }
  if (args[1] === 'create') {
    const branch = option(args, '--head'); const title = option(args, '--title'); const body = option(args, '--body');
    assert.ok(BRANCH.test(branch) && title && title.length <= 240 && body && body.length <= 28 * 1024);
    const base = option(args, '--base'); assert.ok(BRANCH.test(base) && !base.includes('..'));
    assert.ok(args.includes('--draft'));
    const marker = /<!-- kcoder-delivery:([a-f0-9-]{36}) -->/.exec(body)?.[1]; assert.ok(marker, 'stable request marker required');
    const prior = state.pullRequests.find(pr => pr.body.includes(`<!-- kcoder-delivery:${marker} -->`));
    if (prior) { assert.equal(prior.title, title); assert.equal(prior.body, body); assert.equal(prior.baseRefName, base); return prior.url; }
    assert.equal(state.pullRequests.length, 0, 'this fixture permits one explicit PR only');
    const head = remoteHead(cwd, state, branch); assert.ok(head, 'a real local push must precede PR creation');
    const [owner, name] = CANONICAL_REPOSITORY.split('/');
    state.pullRequests.push({ number: 1, url: `https://github.com/${CANONICAL_REPOSITORY}/pull/1`, state: 'OPEN',
      headRefOid: head, headRefName: branch, baseRefName: base, headRepositoryOwner: { login: owner }, headRepository: { name },
      title, body, reviewDecision: 'REVIEW_REQUIRED' });
    state.publicationRequests.push({ requestId: marker, head, branch }); saveForge(forge);
    setCheck(cwd, head, 'failure'); return state.pullRequests[0].url;
  }
  throw new Error('unsupported fixture gh command; no network fallback');
}
export function parseIntent(text) {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; }
      else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try { const value = JSON.parse(text.slice(start, index + 1)); if (value.requestId && value.source && value.workspace && value.recipient) return value; }
        catch {}
        break;
      }
    }
  }
  throw new Error('bound Native delivery intent is missing');
}
export function publishIntent(cwd, intent) {
  const { state } = loadForge(cwd);
  assert.equal(realpathSync(intent.workspace), realpathSync(cwd));
  assert.equal(intent.source.repository, REPOSITORY); assert.ok(SHA.test(intent.source.headCommit));
  assert.ok(BRANCH.test(intent.source.branch) && BRANCH.test(intent.source.baseBranch) && intent.source.branch !== intent.source.baseBranch);
  assert.equal(git(cwd, ['branch', '--show-current']), intent.source.branch);
  assert.equal(git(cwd, ['rev-parse', 'HEAD']), intent.source.headCommit);
  assert.equal(git(cwd, ['config', '--get', 'remote.origin.url']), ORIGIN);
  assert.equal(git(cwd, ['status', '--porcelain=v1']), '', 'explicit publication needs a clean selected source');
  assert.match(intent.requestId, /^[a-f0-9-]{36}$/); assert.ok(intent.body.includes(`<!-- kcoder-delivery:${intent.requestId} -->`));
  const known = state.pullRequests.find(pr => pr.body.includes(`<!-- kcoder-delivery:${intent.requestId} -->`));
  if (known) {
    assert.equal(known.headRefName, intent.source.branch); assert.equal(known.headRefOid, intent.source.headCommit);
    assert.equal(known.baseRefName, intent.source.baseBranch);
    assert.equal(known.title, intent.title); assert.equal(known.body, intent.body);
    assert.equal(remoteHead(cwd, state, intent.source.branch), intent.source.headCommit);
    return known.url;
  }
  // Reconcile the exact remote commit first; a lost push receipt never causes a blind repeat.
  if (remoteHead(cwd, state, intent.source.branch) !== intent.source.headCommit) {
    // Only this invocation maps the logical forge URL to this run's owned local bare transport.
    git(cwd, ['-c', `url.${state.bareRemote}.insteadOf=${ORIGIN}`, '-c', 'protocol.https.allow=never',
      '-c', 'protocol.ssh.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=always',
      'push', 'origin', `HEAD:refs/heads/${intent.source.branch}`]);
  }
  return runGh(cwd, ['pr', 'create', '--repo', REPOSITORY, '--head', intent.source.branch,
    '--base', intent.source.baseBranch, '--title', intent.title, '--body', intent.body, '--draft']);
}
