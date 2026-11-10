import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnv } from '../../../kcoder-relay/src/config.mjs';
import { runE2E, repoRoot } from '../harness/run-context.mjs';
import { openRpc, initializeRpc, closeRpcAndWait } from '../harness/rpc.mjs';

if (process.env.KCODER_E2E_REAL_MODEL !== '1' || process.env.KCODER_E2E_LIVE_WORKSPACE_SEND !== '1') {
  throw new Error('Explicit real-model and current-workspace acceptance consent is required');
}
process.umask(0o077);
loadEnv(resolve(repoRoot, '.env'));
await runE2E(import.meta.url, { testId: 'current-workspace-owned-send', tier: 'manual-live',
  modelPolicy: 'One owned conversation in the explicitly selected live workspace; one short no-tool prompt, 60 second completion deadline; retain the target provider policy and delete only the created conversation',
}, async run => {
  const login = new URL((await readFile(process.env.KCODER_E2E_CONNECTIVITY_LOGIN_FILE, 'utf8')).trim());
  const token = new URLSearchParams(login.hash.slice(1)).get('token');
  assert.ok(token);
  run.registerSecret(token);
  run.registerSecret(process.env.KUNLUNMETA_BASE_API_KEY);
  const base = login.searchParams.get('gateway');
  assert.equal(new URL(base).origin, new URL(process.env.KCODER_RELAY_PUBLIC_URL).origin);
  const paired = await fetch(base + '/api/mobile/session', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, durableDeviceAuthorization: true, deviceLabel: 'Owned current-workspace send acceptance' }) });
  assert.equal(paired.status, 200);
  const session = await paired.json();
  for (const secret of [session.accessToken, session.refreshToken, session.rpcToken]) run.registerSecret(secret);
  run.addCleanup('revoke only acceptance device', async () => {
    const result = await fetch(base + '/api/mobile/session', { method: 'DELETE',
      headers: { authorization: `Bearer ${session.accessToken}` } });
    assert.equal(result.status, 204);
  });
  const endpoint = new URL(base + '/rpc');
  endpoint.protocol = 'wss:';
  endpoint.search = new URLSearchParams({ server: 'local', token: session.rpcToken });
  const rpc = await openRpc(endpoint.toString(), { headers: { authorization: `Bearer ${session.accessToken}` } });
  run.addCleanup('close acceptance RPC', () => closeRpcAndWait(rpc));
  await initializeRpc(rpc, 'current-workspace-owned-send');
  const prompt = 'Reply only OK. Do not call tools, change files, or perform any other action.';
  // Cleanup is restricted to exact IDs whose ownership was established by this acceptance.
  if (process.env.KCODER_E2E_CLEANUP_ONLY === '1') {
    const owned = JSON.parse(process.env.KCODER_E2E_OWNED_THREADS);
    assert.ok(Array.isArray(owned) && owned.length > 0);
    for (const threadId of owned) {
      const read = await rpc.request('thread/read', { threadId });
      const users = read.messages?.filter(message => message.role === 'user');
      assert.equal(users?.length, 1);
      assert.equal(users[0].content, prompt, 'Never delete a conversation with unrelated user input');
      const result = await rpc.request('thread/delete', { threadId });
      assert.equal(result.deleted, true);
    }
    return { removedOnlyKnownOwnedThreads: owned };
  }
  const created = await rpc.request('thread/start', { cwd: repoRoot,
    metadata: { title: 'Owned send acceptance - safe to delete' } });
  const threadId = created.thread?.id;
  assert.ok(threadId);
  await run.writeArtifactJson('owned-thread.json', { threadId, workspace: repoRoot });
  run.addCleanup('delete only acceptance conversation', async () => {
    const result = await rpc.request('thread/delete', { threadId });
    assert.equal(result.deleted, true);
  });
  await rpc.request('thread/metadata/update', { threadId, title: 'Owned send acceptance - safe to delete' });
  const started = await rpc.request('turn/start', { threadId,
    input: [{ type: 'text', text: prompt }] });
  const turnId = started.turn?.id ?? started.turnId;
  assert.ok(turnId);
  let completed;
  try {
    completed = await rpc.waitFor(frame => frame.method === 'turn/completed'
      && frame.params?.threadId === threadId && (frame.params?.turnId ?? frame.params?.turn?.id) === turnId,
    60_000, 'current workspace model completion');
  } catch (error) {
    await rpc.request('turn/interrupt', { threadId, turnId });
    throw error;
  }
  const status = completed.params?.turn?.status ?? completed.params?.status;
  const errors = rpc.messages().filter(frame => /error/.test(frame.method ?? '')
    && frame.params?.threadId === threadId).map(frame => ({ method: frame.method, params: frame.params }));
  await run.writeArtifactJson('turn-result.json', { threadId, turnId, status, errors });
  assert.equal(status, 'completed', 'The actual current-workspace turn must complete');
  const read = await rpc.request('thread/read', { threadId });
  assert.ok(read.messages?.some(message => message.role === 'assistant' && message.content?.trim()));
  return { status, actualPublicGateway: true, actualSelectedWorkspace: repoRoot, persistedAssistantResponse: true };
});
