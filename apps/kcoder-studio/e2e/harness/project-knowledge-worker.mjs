import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';
import { MARKERS, PUBLISH_CHANGE, SOURCE, STALE_CHANGE, V1, boundedToolObservation, sha256 } from './project-knowledge-fixture.mjs';

if (process.argv[2] === '--precheck') {
  const workspace = process.argv[3]; assert.ok(isAbsolute(workspace));
  assert.deepEqual(JSON.parse(await readFile(resolve(workspace, 'interface.json'), 'utf8')), { version: 'two' });
  console.log('OWNED_INTERFACE_V2_PRECHECK_PASSED');
} else {
  // RunContext owns this worker's process group/Windows Job. Native has a separate JSONL stdin;
  // the supervisor's stdin remains its owner-control channel. No detached/breakaway child exists.
  const [binary, workspace, receipt] = process.argv.slice(2);
  for (const path of [binary, workspace, receipt]) assert.ok(isAbsolute(path));
  const evidence = { stage: 'initialize', nativePid: null, threads: [], turns: [], approvals: [], snapshots: [], toolResults: [], error: null };
  evidence.gitEnvironment = Object.fromEntries(['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_TEMPLATE_DIR']
    .map(name => [name, process.env[name] ?? null]));
  const child = spawn(binary, ['--cwd', workspace, 'app-server'], {
    cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
  });
  evidence.nativePid = child.pid;
  child.stderr.pipe(process.stderr);
  const client = new AppServerStdioClient('project-knowledge-native', child, { notificationHistoryLimit: 256 });
  const rpc = async (method, params) => {
    const response = await client.request(method, params, 30000);
    assert.ok(!response.error, `${method}: ${response.error?.message}`);
    return response.result;
  };
  const snapshot = async label => {
    const content = await readFile(resolve(workspace, SOURCE), 'utf8');
    const record = { label, content, revision: sha256(content) };
    evidence.snapshots.push(record); return record;
  };
  const exists = async path => access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  let failure;
  const seenResults = new Set();
  const writeInputs = new Map();
  const observeResults = async () => {
    for (const frame of client.notificationHistory) {
      const item = frame.params?.item;
      if (frame.method === 'item/started' && item?.type === 'toolCall' && item.name === 'write')
        writeInputs.set(item.id, item.input);
    }
    for (const frame of client.notificationHistory) {
      const item = frame.params?.item;
      if (frame.method !== 'item/completed' || item?.type !== 'toolCall' || !/^knowledge-[0-9]+$/.test(item.id)) continue;
      const identity = JSON.stringify([frame.params.threadId, frame.params.turnId, item.id]);
      if (seenResults.has(identity)) continue;
      seenResults.add(identity);
      assert.ok(evidence.toolResults.length < 64);
      const isError = item.status === 'failed' ? true : item.status === 'completed' ? false : 'unknown';
      evidence.toolResults.push({ ...boundedToolObservation({ id: item.id, name: item.name, text: item.output ?? '',
        isError, errorSource: 'Native item/completed status' }), threadId: frame.params.threadId, turnId: frame.params.turnId,
        nativeStatus: item.status, nativeOutputTruncated: item.outputTruncated, nativeOutputOriginalBytes: item.outputOriginalBytes });
      if (item.name === 'write') {
        assert.equal(isError, false, 'Native write failed; inspect retained bounded tool result');
        assert.match(item.output, /^(?:The file .+ has been updated successfully\.|File created successfully at:)/s);
        const input = writeInputs.get(item.id);
        assert.ok(input?.file_path, 'a successful write must retain its actual Native tool input path');
        const actual = await readFile(resolve(workspace, input.file_path), 'utf8');
        assert.equal(actual, input.content, 'successful Native write must match actual owned file bytes');
      }
    }
  };
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'owned-project-knowledge-publication', version: '1' },
      capabilities: { approvals: true, experimental: { approvalToolCallIdentityV1: true, interactionBindingV1: true } } });
    evidence.capabilities = initialized.capabilities;
    assert.equal(initialized.capabilities.approvals, true);
    assert.equal(initialized.capabilities.experimental?.residentThreads, true, 'two real resident threads are required');
    const defaults = await rpc('settings/execution-defaults/read', {});
    evidence.permissionDefaults = defaults;
    assert.equal(defaults.persistedPermissionMode, 'ask');
    assert.equal(defaults.effectivePermissionMode, 'ask');
    assert.equal(defaults.cliPermissionModeOverride, null);
    const { thread: first } = await rpc('thread/start', { cwd: workspace });
    evidence.threads.push(first.id);
    const turn = async (threadId, marker, archiveDecision) => {
      evidence.stage = marker;
      const { turn: started } = await rpc('turn/start', { threadId, input: [{ type: 'text', text: `${marker}\nUse the relevant source ${SOURCE}.` }] });
      const deadline = Date.now() + 90000;
      let approvalCount = 0, terminal;
      while (Date.now() < deadline) {
        await observeResults();
        for (const request of client.pendingServerRequests()) {
          assert.equal(request.method, 'approval/request', 'unexpected interactive protocol request');
          const params = request.params;
          assert.equal(params.threadId, threadId); assert.equal(params.turnId, started.id);
          assert.equal(params.action.type, 'tool'); assert.equal(params.action.name, 'SpecArchive');
          assert.equal(params.action.input.name, marker === 'KNOWLEDGE_STALE' ? STALE_CHANGE : PUBLISH_CHANGE);
          assert.ok(params.approvalId && params.toolCallId && params.appServerEpoch);
          assert.ok(archiveDecision, 'only explicit archive phases may receive an approval');
          const before = await snapshot(`${marker}-before-${archiveDecision}`);
          if (marker !== 'KNOWLEDGE_STALE') assert.equal(before.content, V1, 'unconfirmed candidate must not publish');
          else { assert.match(before.content, /version two/); assert.doesNotMatch(before.content, /version one/); }
          const decision = { decision: archiveDecision, approvalId: params.approvalId, threadId, turnId: started.id };
          await client.respond(request.id, decision);
          evidence.approvals.push({ requestId: request.id, ...params, decision: archiveDecision });
          approvalCount++;
          assert.equal(approvalCount, 1, 'an archive attempt must not automatically retry its approval');
        }
        terminal = client.notificationHistory.find(frame => frame.method === 'turn/completed' &&
          frame.params?.turn?.id === started.id && frame.params?.turn?.threadId === threadId);
        if (terminal) break;
        if (client.exit) throw new Error('Native exited during project knowledge turn');
        await new Promise(accept => setTimeout(accept, 20));
      }
      assert.ok(terminal, 'bounded project knowledge turn did not reach Native terminal state');
      await observeResults();
      assert.equal(terminal.params.turn.status, 'completed', JSON.stringify(terminal));
      assert.equal(approvalCount, archiveDecision ? 1 : 0);
      evidence.turns.push({ marker, threadId, turnId: started.id, status: terminal.params.turn.status, approvalCount });
    };
    await turn(first.id, MARKERS[0]);
    assert.equal((await snapshot('candidate-prepared')).content, V1);
    assert.deepEqual(JSON.parse(await readFile(resolve(workspace, 'interface.json'), 'utf8')), { version: 'two' });
    for (const name of [PUBLISH_CHANGE, STALE_CHANGE]) {
      const base = JSON.parse(await readFile(resolve(workspace, '.kcoder/specs/changes', name, '.base.json'), 'utf8'));
      assert.equal(base.requirements.format, 'project_knowledge_v2');
      assert.deepEqual(base.requirements.knowledge_sources, [{ path: SOURCE, revision: sha256(V1) }]);
    }
    await turn(first.id, MARKERS[1], 'decline');
    assert.equal((await snapshot('archive-denied')).content, V1);
    assert.equal(await exists(resolve(workspace, '.kcoder/specs/changes', PUBLISH_CHANGE)), true);
    await turn(first.id, MARKERS[2], 'accept');
    const published = await snapshot('archive-confirmed');
    assert.match(published.content, /version two/); assert.doesNotMatch(published.content, /version one/);
    assert.equal(await exists(resolve(workspace, '.kcoder/specs/changes', PUBLISH_CHANGE)), false);
    await turn(first.id, MARKERS[3], 'accept');
    const staleTurn = evidence.turns.at(-1).turnId;
    const staleResults = evidence.toolResults.filter(result => result.threadId === first.id && result.turnId === staleTurn);
    const staleRead = staleResults.filter(result => result.name === 'SpecStatus');
    const staleArchive = staleResults.filter(result => result.name === 'SpecArchive');
    assert.equal(staleRead.length, 1); assert.equal(staleArchive.length, 1);
    assert.equal(staleRead[0].isError, true); assert.match(staleRead[0].text, /project_knowledge_stale_revision/);
    assert.equal(staleArchive[0].isError, true, 'sync-before-archive refusal must be a Native failed tool result');
    assert.equal((await snapshot('stale-archive-refused')).revision, published.revision);
    assert.equal(await exists(resolve(workspace, '.kcoder/specs/changes', STALE_CHANGE)), true);
    const { thread: next } = await rpc('thread/start', { cwd: workspace });
    assert.notEqual(next.id, first.id); evidence.threads.push(next.id);
    await turn(next.id, MARKERS[4]);
    assert.equal((await snapshot('old-scope-refused')).revision, published.revision);
    await turn(next.id, MARKERS[5]);
    evidence.stage = 'passed';
  } catch (error) {
    evidence.error = error.stack ?? error.message; failure = error;
  } finally {
    child.stdin.end();
    try { evidence.nativeExit = await waitForStdioChildClose(child, 10000, 'project knowledge Native'); }
    catch (error) {
      failure ??= error; evidence.nativeCloseError = error.message;
      // Revoke only the exact directly owned child. The enclosing Job/group remains
      // the final owner if normal JSONL EOF shutdown cannot settle its descendants.
      child.kill('SIGTERM');
      await waitForStdioChildClose(child, 3000, 'project knowledge Native cancellation').catch(() => {});
    }
    client.closeReader();
    try {
      // The audit projection deliberately excludes inputs, provider fields and credentials.
      // Native shutdown flushes this exact owned profile's permission writer.
      const settings = JSON.parse(await readFile(resolve(process.env.KCODER_CONFIG_DIR, 'settings.json'), 'utf8'));
      evidence.permissionConfiguration = { mode: settings.permission_mode, rules: settings.permission_rules };
      const bytes = await readFile(resolve(process.env.KCODER_CONFIG_DIR, 'permissions.log'));
      assert.ok(bytes.length <= 1024 * 1024, 'permission audit exceeded the owned evidence budget');
      evidence.permissionAudit = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => {
        const row = JSON.parse(line);
        return { timestampMs: row.timestamp_ms, tool: row.tool_name, reason: row.reason };
      });
      assert.ok(evidence.permissionAudit.length <= 512);
      if (!failure) {
        const archives = evidence.permissionAudit.filter(row => row.tool === 'SpecArchive');
        assert.equal(archives.length, 3);
        assert.ok(archives.every(row => row.reason === 'mode_ask'));
      }
    } catch (error) { failure ??= error; evidence.permissionProofError = error.message; }
    await writeFile(receipt, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (failure) throw failure;
}
