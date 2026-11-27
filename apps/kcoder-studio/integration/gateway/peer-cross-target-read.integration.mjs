import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { startPeerSshTargets } from '../../e2e/harness/peer-ssh-targets.mjs';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';

process.umask(0o077);

const SEED_ANSWER = 'OWNED_REMOTE_SESSION_ANSWER';
const PRIVATE_MARKER = 'ghp_ownedTestCredentialExampleNotARealToken000';
const CASE_PREFIX = 'OWNED_CROSS_TARGET_READ_';
const PUB_TEXT = 'OWNED_READ_SOURCE_COMPLETE';

async function setReadAccess(context, endpoint, access) {
  const settings = JSON.parse(await readFile(endpoint.settings, 'utf8'));
  settings.cross_session_messages.read_access = access;
  const next = await context.writeStateJson(`${endpoint.alias}-profile/settings-${access}.tmp`, settings);
  await rename(next, endpoint.settings);
}

async function readPeerDiagnostics(context, alias) {
  const logPath = context.pathInState(`${alias}-profile/kcoder.log`);
  const log = await readFile(logPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return log.split('\n').filter(line => line.includes('kcoder::peer_channel'));
}

await runIntegration(import.meta.url, {
  testId: 'actual-gateway-cross-target-session-read',
  tier: 'full-integration',
  modelPolicy: 'Real HTTP-login Gateway, independent local and owned SSH Native targets, and deterministic model protocol selecting ReadSession. No paid model, live account, model judgment, or GUI claim.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed Native for routed session read');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  context.registerSecret(PRIVATE_MARKER);

  let address;
  const outcomes = new Map();
  let readRequests = 0;
  const fixture = await startPeerSshTargets(context, binary, {
    modelOptions: {
      responseSteps: ({ body }) => {
        const latest = body.messages
          .filter(message => message.role === 'user')
          .map(message => JSON.stringify(message.content))
          .findLast(content => content.includes(CASE_PREFIX) || content.includes('OWNED_TRANSPORT_SEED_peer-ssh'));
        if (latest?.includes('OWNED_TRANSPORT_SEED_peer-ssh')) {
          return [{ delta: { content: `${SEED_ANSWER} token=${PRIVATE_MARKER}` }, finishReason: 'stop' }];
        }
        const name = ['default', 'allowed', 'revoked', 'missing-target']
          .find(variant => latest?.includes(CASE_PREFIX + variant));
        assert.ok(name, 'unexpected fixture turn');
        const id = `owned-routed-read-${name}`;
        assert.ok(++readRequests <= 8, 'fixture must run only the bounded ReadSession cases');
        const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === id);
        if (result) {
          assert.equal(typeof result.content, 'string');
          outcomes.set(name, result.content);
          return [{ delta: { content: PUB_TEXT }, finishReason: 'stop' }];
        }
        const targetAddress = name === 'missing-target'
          ? { ...address, targetId: 'owned-unreachable-target' }
          : address;
        return [{ delta: { role: 'assistant', tool_calls: [{
          index: 0, id, type: 'function', function: {
            name: 'ReadSession',
            arguments: JSON.stringify({ threadId: targetAddress.threadId, targetAddress }),
          },
        }] }, finishReason: 'tool_calls' }];
      },
    },
  });
  const target = await fixture.seed('peer-ssh');
  const source = fixture.clients.get('peer-local'), receiver = fixture.clients.get('peer-ssh');
  const { thread } = await source.request('thread/start', {});
  const before = await receiver.request('thread/read', { threadId: target.id, limit: 30 });
  assert.ok(before.messages.some(message => String(message.content).includes(PRIVATE_MARKER)), 'fixture marker must be present in the original history');

  let cursor;
  for (let page = 0; page < 16; page++) {
    const result = await source.request('thread/agentMessage/targets', {
      sourceThreadId: thread.id, ...(cursor ? { cursor } : {}),
    });
    address = result.targets.find(row => row.threadId === target.id)?.address;
    if (address || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  assert.ok(address, 'the original SSH conversation is visible to the actual logged-in browser');
  assert.equal(address.threadId, target.id);
  const safeDiagnostic = line => [PRIVATE_MARKER, SEED_ANSWER, thread.id, target.id]
    .every(value => !line.includes(value));

  async function runCase(name) {
    const clientMessageId = `owned-read-case-${name}`;
    await source.request('turn/start', {
      threadId: thread.id, clientMessageId,
      input: [{ type: 'text', text: `${CASE_PREFIX}${name}` }],
    });
    await waitFor(async () => {
      const { receipt } = await source.request('turn/receipt/read', { threadId: thread.id, clientMessageId });
      assert.ok(!['failed', 'interrupted'].includes(receipt?.status), 'the original read fixture turn must finish');
      return receipt?.status === 'completed';
    }, 35_000, `ReadSession ${name}`);
    const output = outcomes.get(name);
    assert.equal(typeof output, 'string', 'the original model round must observe a tool result');
    assert.ok(!output.includes(PRIVATE_MARKER), 'read result exposed a fixture credential');
    const diagnostics = await Promise.all(['peer-local', 'peer-ssh'].map(async alias => {
      const lines = await readPeerDiagnostics(context, alias);
      assert.ok(lines.every(safeDiagnostic),
        'peer transport diagnostics leaked fixture data or thread identity');
      return { alias, events: lines.slice(-12).map(line => Object.fromEntries(
        Array.from(line.matchAll(/(operation|side|code|underlying|cause|elapsed_ms)="?([A-Za-z0-9_.-]{1,128})/g),
          ([, key, value]) => [key, value])
      )) };
    }));
    await context.writeArtifactJson(`read-${name}-facts.json`, {
      code: output.match(/session_read_[a-z_]+/)?.[0] ?? null, diagnostics,
    });
    return output;
  }

  assert.match(await runCase('default'), /session_read_other_project/);
  const owner = fixture.endpoints.get('peer-ssh');
  await setReadAccess(context, owner, 'same_account');
  const allowed = await runCase('allowed');
  assert.ok(allowed.includes(SEED_ANSWER), 'authorized read must return target content');
  assert.match(allowed, /已省略敏感内容/);

  await setReadAccess(context, owner, 'none');
  const revoked = await runCase('revoked');
  assert.match(revoked, /session_read_not_permitted/);
  assert.ok(!revoked.includes(SEED_ANSWER), 'revoked read returned target content');

  const missing = await runCase('missing-target');
  assert.match(missing, /session_read_target_unreachable/);
  await waitFor(async () => {
    const diagnostics = await readPeerDiagnostics(context, 'peer-local');
    assert.ok(diagnostics.every(safeDiagnostic),
      'peer transport diagnostics leaked fixture data or thread identity');
    return diagnostics.some(line => line.includes('ReadSession') && line.includes('elapsed_ms'));
  }, 5_000, 'bounded non-interactive CLI peer diagnostics');

  const after = await receiver.request('thread/read', { threadId: target.id, limit: 30 });
  assert.deepEqual(after.messages, before.messages, 'cross-target reads must not write the recipient transcript');
  assert.equal(fixture.model.requests.length, 9, 'the four reads must not wake a target model turn');
  await context.writeArtifactJson('session-read-assertions.json', {
    binarySha256, actualLocalSshGateway: true, defaultDenied: true, sameAccountRead: true,
    revocationObserved: true, sensitiveContentMasked: true, targetHistoryUnchanged: true,
    nonInteractiveDiagnostics: true, providerRequests: fixture.model.requests.length,
  });
  return { actualCrossTargetRead: true, policyRechecked: true, logsRedacted: true };
});
