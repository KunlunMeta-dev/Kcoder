import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { login } from '../../harness/http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';

/** Own only a temporary expert; never edit the deployed user's existing experts. */
export async function createDeployedToolsExpert(context, { token, deviceId, workspacePath }) {
  assert.equal(process.env.KCODER_E2E_DEPLOYED_EXPERT_TOOLS_WRITE, '1');
  const base = new URL(process.env.KCODER_E2E_DEPLOYED_CONTROL_URL);
  assert.equal(base.protocol, 'http:');
  assert.ok(['127.0.0.1', '[::1]'].includes(base.hostname));
  assert.equal(base.pathname, '/');
  assert.ok(!base.search && !base.hash && !base.username && !base.password);
  const cookie = await login(base.origin, token);
  context.registerSecret(cookie);
  const url = new URL(gatewayRpcUrl({ wsUrl: base.origin.replace('http:', 'ws:') }, deviceId, 'cookie-auth'));
  url.searchParams.set('workspace', workspacePath);
  const rpc = await openRpc(url.href, { headers: { Cookie: cookie, Origin: base.origin } });
  context.addCleanup('close deployed expert settings control', () => closeRpcAndWait(rpc));
  await initializeRpc(rpc, 'owned-expert-tools-persistence', {
    integrationScopeV1: true, officeWorkspaceV1: true, agentDefinitionsV1: true,
    integrationOperationReceiptsV1: true,
  });
  const scope = await rpc.request('integrations/scope/read');
  const ownerId = randomUUID();
  const id = `personal.e2e-tools-${ownerId}`;
  let sequence = 0;
  const office = async (method, payload, mutation = {}) => {
    const reply = await rpc.request(`integrations/${method}`, {
      contractVersion: 'parallel-v1', requestId: `${ownerId}-${++sequence}`, scope,
      timeoutMs: 30000, payload, ...mutation,
    }, 45000);
    assert.equal(reply.status, 'completed', `Expert settings ${method}: ${reply.error?.code ?? reply.status}`);
    return reply.result;
  };
  const snapshot = async () => {
    const result = [];
    let cursor;
    do {
      const page = await office('assistant/list', { limit: 10, personalOnly: true, language: 'en', ...(cursor ? { cursor } : {}) });
      result.push(...page.items.map(item => ({ id: item.definition.id, revision: item.draftRevision,
        sha256: createHash('sha256').update(JSON.stringify(item.definition)).digest('hex') })));
      assert.ok(result.length < 1000);
      cursor = page.nextCursor;
    } while (cursor);
    return result.sort((a, b) => a.id.localeCompare(b.id));
  };
  const before = await snapshot();
  assert.ok(!before.some(item => item.id === id));
  const definition = {
    schemaVersion: 1, id, scope: 'personal', title: `工具保存验收 ${ownerId}`,
    description: 'Run-owned expert settings persistence check', language: 'zh-CN',
    instructions: 'Run-owned configuration only; do not execute a task.',
    inputSchema: { type: 'object' }, capabilities: [], resources: [],
    modelSelection: { kind: 'inherit_current' }, allowedTools: null,
    outputKinds: ['document'], acceptanceCriteria: ['Persist only this expert'], externalSend: 'deny',
  };
  context.addCleanup('delete only the run-owned tools expert and verify existing experts', async () => {
    const current = await snapshot();
    if (current.some(item => item.id === id)) {
      const { draft } = await office('assistant/read', { id });
      assert.equal(draft.definition.title, definition.title);
      assert.equal(draft.definition.instructions, definition.instructions);
      await office('assistant/deleteDraft', { id }, {
        operationId: `${ownerId}-delete`, expectedRevision: String(draft.revision),
      });
    }
    const after = await snapshot();
    assert.deepEqual(after, before, 'Existing expert definitions and revisions must be preserved');
  });
  const { draft } = await office('assistant/saveDraft', { definition }, { operationId: `${ownerId}-create` });
  assert.equal(draft.definition.id, id);
  return { id, draft, office };
}
