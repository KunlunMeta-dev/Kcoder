import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveOwnedAgentOutput } from '../lib/owned-agent-output.mjs';
import { waitForSubagentEvidence } from '../lib/evidence.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-owned-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = path.join(root, 'session');
  const agent = path.join(session, 'subagents', 'agent');
  await mkdir(agent, { recursive: true });
  return { root, session, agent };
}

test('missing owned output stays pending and is validated again after creation', async (t) => {
  const { root, session, agent } = await fixture(t);
  const output = path.join(agent, 'runs', 'run-1', 'output.md');
  await writeFile(path.join(session, 'state.json'), JSON.stringify({ tasks: { agent: { output_path: output } } }));
  assert.equal(await resolveOwnedAgentOutput(agent, output), null);
  const pending = await waitForSubagentEvidence(root, { timeoutMs: 0 });
  assert.equal(pending.hasAllRequired, false);
  assert.equal(pending.agents[0].outputExists, false);
  assert.equal(pending.agents[0].outputHasWorkerSentinel, false);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, 'tui-lab-subagent-worker-done');
  assert.equal(await resolveOwnedAgentOutput(agent, output), output);
  const ready = await waitForSubagentEvidence(root, { timeoutMs: 0 });
  assert.equal(ready.agents[0].output, output);
  assert.equal(ready.agents[0].outputHasWorkerSentinel, true);
});

test('missing outside output is rejected rather than treated as pending', async (t) => {
  const { root, agent } = await fixture(t);
  await assert.rejects(resolveOwnedAgentOutput(agent, path.join(root, 'outside', 'missing.md')), /escapes/);
});

test('symlink escapes are rejected for existing and still-missing output', { skip: process.platform === 'win32' }, async (t) => {
  const { root, agent } = await fixture(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'exists.md'), 'outside evidence');
  await symlink(outside, path.join(agent, 'linked'));
  for (const name of ['exists.md', 'missing.md']) {
    await assert.rejects(resolveOwnedAgentOutput(agent, path.join(agent, 'linked', name)), /escapes/);
  }
  await symlink(path.join(outside, 'missing.md'), path.join(agent, 'dangling.md'));
  await assert.rejects(resolveOwnedAgentOutput(agent, path.join(agent, 'dangling.md')), { code: 'ENOENT' });
});

test('permission and non-missing filesystem errors propagate unchanged', async () => {
  const owner = path.resolve('owned-agent');
  const output = path.join(owner, 'output.md');
  for (const code of ['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP']) {
    const failure = Object.assign(new Error(code), { code });
    await assert.rejects(resolveOwnedAgentOutput(owner, output, async (value) => {
      if (value === owner) return owner;
      throw failure;
    }), (error) => error === failure);
  }
  const denied = Object.assign(new Error('cannot inspect ancestor'), { code: 'EACCES' });
  await assert.rejects(resolveOwnedAgentOutput(owner, output, async (value) => {
    if (value === owner) return owner;
    throw Object.assign(new Error('pending'), { code: 'ENOENT' });
  }, async () => { throw denied; }), (error) => error === denied);
});

test('bounded evidence polling retries pending output until it is written', async (t) => {
  const { root, session, agent } = await fixture(t);
  const output = path.join(agent, 'output.md');
  await writeFile(path.join(session, 'state.json'), JSON.stringify({ tasks: { agent: { output_path: output } } }));
  await writeFile(path.join(agent, 'transcript.json'), JSON.stringify([{ role: 'assistant', content: 'done' }]));
  await mkdir(path.join(agent, 'llm-requests'));
  await writeFile(path.join(agent, 'llm-requests', 'request.json'), JSON.stringify({ session_id: 'session', request: {}, response: {} }));
  const writing = new Promise((resolve) => setTimeout(resolve, 30))
    .then(() => writeFile(output, 'tui-lab-subagent-worker-done'));
  const ready = await waitForSubagentEvidence(root, { timeoutMs: 1000 });
  await writing;
  assert.equal(ready.hasAllRequired, true);
  assert.equal(ready.agents[0].output, output);
});
