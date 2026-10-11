import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectHistoryEvidence,
  collectLiveSteerRequestEvidence,
  collectRequestEvidence,
  waitForOrchestrateControlEvidence,
  waitForSubagentEvidence,
  waitForTargetedSubagentStopEvidence,
  waitForTargetedSubagentSteerEvidence,
} from '../lib/evidence.mjs';
import { formatBrowserConsole } from '../lib/browser-evidence.mjs';

test('collects required history and request evidence without crossing directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-evidence-'));
  const history = path.join(root, 'history');
  const requests = path.join(root, 'requests');
  await mkdir(history);
  await mkdir(requests);
  await writeFile(path.join(history, 'turn.jsonl'), '{"message":"done"}\n');
  await writeFile(path.join(requests, 'request.json'), '{"prompt":"probe"}\n');
  await writeFile(path.join(requests, 'ignored.txt'), 'probe');

  const historyEvidence = await collectHistoryEvidence(history);
  const requestEvidence = await collectRequestEvidence(requests);
  assert.equal(historyEvidence.fileCount, 1);
  assert.equal(requestEvidence.fileCount, 1);
});

test('proves a live steer follows the tool result before any assistant response', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-live-steer-'));
  await writeFile(
    path.join(root, 'request_002.json'),
    JSON.stringify({
      body: {
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1' }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] },
          { role: 'user', content: [{ type: 'text', text: 'new constraint' }] },
        ],
      },
    }),
  );

  const evidence = await collectLiveSteerRequestEvidence(root, 'new constraint');
  assert.equal(evidence.ordered, true);
  assert.equal(evidence.toolResultIndex, 1);
  assert.equal(evidence.steerIndex, 2);
  assert.equal(evidence.assistantBetweenToolResultAndSteer, false);
});

test('reports absent subagent evidence as unmet instead of passed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-subagent-evidence-'));
  const evidence = await waitForSubagentEvidence(root, { timeoutMs: 0 });
  assert.equal(evidence.agentCount, 0);
  assert.equal(evidence.hasAllRequired, false);
});

test('proves targeted steer reaches only the selected child transcript and request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-targeted-steer-'));
  const sessionId = 'session-targeted';
  const sessionDir = path.join(root, sessionId);
  const targetDir = path.join(sessionDir, 'subagents', 'agent-target');
  const siblingDir = path.join(sessionDir, 'subagents', 'agent-sibling');
  await mkdir(path.join(targetDir, 'llm-requests'), { recursive: true });
  await mkdir(path.join(siblingDir, 'llm-requests'), { recursive: true });
  await writeFile(path.join(root, 'parent.jsonl'), '{"message":"parent only"}\n');
  await writeFile(
    path.join(targetDir, 'transcript.json'),
    JSON.stringify([{ role: 'user', content: 'TUI_LAB_TARGETED_STEER_SENTINEL' }]),
  );
  await writeFile(
    path.join(targetDir, 'llm-requests', 'request.json'),
    JSON.stringify({ request: 'TUI_LAB_TARGETED_STEER_SENTINEL' }),
  );
  await writeFile(
    path.join(siblingDir, 'transcript.json'),
    JSON.stringify([{ role: 'user', content: 'sibling only' }]),
  );
  await writeFile(
    path.join(siblingDir, 'llm-requests', 'request.json'),
    JSON.stringify({ request: 'sibling only' }),
  );
  await writeFile(path.join(targetDir, 'output.md'), 'tui-lab-subagent-worker-done\n');
  await writeFile(path.join(siblingDir, 'output.md'), 'tui-lab-subagent-worker-done\n');
  await writeFile(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      tasks: {
        'agent-target': { id: 'agent-target', status: 'completed' },
        'agent-sibling': { id: 'agent-sibling', status: 'completed' },
      },
    }),
  );

  const evidence = await waitForTargetedSubagentSteerEvidence(root, {
    targetAgentId: 'agent-target',
    siblingAgentIds: ['agent-sibling'],
    sentinel: 'TUI_LAB_TARGETED_STEER_SENTINEL',
    timeoutMs: 0,
  });

  assert.equal(evidence.hasAllRequired, true);
  assert.equal(evidence.targetTranscriptContainsSentinel, true);
  assert.equal(evidence.targetRequestContainsSentinel, true);
  assert.equal(evidence.parentHistoryContainsSentinel, false);
  assert.equal(evidence.siblingsContainSentinel, false);
  assert.equal(evidence.targetOutputHasWorkerSentinel, true);
  assert.equal(evidence.allAgentsCompleted, true);
});

test('proves targeted stop cancels one child while its sibling completes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-targeted-stop-'));
  const sessionDir = path.join(root, 'session-targeted-stop');
  for (const agentId of ['agent-target', 'agent-sibling']) {
    await mkdir(path.join(sessionDir, 'subagents', agentId), { recursive: true });
  }
  await writeFile(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      tasks: {
        'agent-target': { id: 'agent-target', status: 'cancelled' },
        'agent-sibling': { id: 'agent-sibling', status: 'completed' },
      },
    }),
  );

  const evidence = await waitForTargetedSubagentStopEvidence(root, {
    targetAgentId: 'agent-target',
    siblingAgentIds: ['agent-sibling'],
    timeoutMs: 0,
  });

  assert.equal(evidence.targetCancelled, true);
  assert.equal(evidence.siblingsCompleted, true);
  assert.equal(evidence.hasAllRequired, true);
});

test('collects redacted Orchestrate control evidence without exposing delivery bodies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-orchestrate-control-'));
  const sessionId = 'session-control';
  const sessionDir = path.join(root, sessionId);
  await mkdir(sessionDir);
  await writeFile(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      tasks: {
        'agent-1': {
          id: 'agent-1',
          kind: 'subagent',
          status: 'paused',
          control: { run_mode: 'paused', revision: 2 },
          breaker: { stage: 'normal' },
          message_queue: [{ status: 'queued', body: 'secret message body' }],
        },
      },
    }),
  );
  await writeFile(
    path.join(sessionDir, 'runtime-events.jsonl'),
    ['control_requested', 'control_applied', 'message_queued', 'fleet_injected']
      .map((kind) => JSON.stringify({ kind }))
      .join('\n'),
  );

  const evidence = await waitForOrchestrateControlEvidence(root, sessionId, { timeoutMs: 0 });

  assert.equal(evidence.hasAllRequired, true);
  assert.equal(evidence.agents[0].queueLength, 1);
  assert.doesNotMatch(JSON.stringify(evidence), /secret message body/);
});

test('formats browser console and page errors as persistent evidence', () => {
  const text = formatBrowserConsole([
    {
      at: '2026-07-29T00:00:00.000Z',
      type: 'log',
      text: 'ready',
      location: { url: 'http://localhost/app.js', lineNumber: 4, columnNumber: 2 },
    },
    {
      at: '2026-07-29T00:00:01.000Z',
      type: 'pageerror',
      error: { message: 'boom', stack: 'stack' },
    },
  ]);
  assert.match(text, /app\.js:4:2: ready/);
  assert.match(text, /pageerror: boom/);
});


test('subagent evidence follows owned immutable output paths from state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-run-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = path.join(root, 'session');
  const agent = path.join(session, 'subagents', 'agent');
  await mkdir(agent, { recursive: true });
  const output = path.join(agent, 'output--run-id.output');
  await writeFile(output, 'tui-lab-subagent-worker-done');
  await writeFile(path.join(session, 'state.json'), JSON.stringify({ tasks: { agent: { output_path: output } } }));
  const evidence = await waitForSubagentEvidence(root, { timeoutMs: 0 });
  assert.equal(evidence.agents[0].output, output);
  assert.equal(evidence.agents[0].outputHasWorkerSentinel, true);
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'not an agent artifact');
  await writeFile(path.join(session, 'state.json'), JSON.stringify({ tasks: { agent: { output_path: outside } } }));
  await assert.rejects(waitForSubagentEvidence(root, { timeoutMs: 0 }), /escapes/);
});
