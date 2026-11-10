import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCrossHostSelectedDiagnostics } from './windows-cross-host-adoption.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoCrossHostPlaintext, crossHostPrivateCanaries, seedCrossHostPrivateFields, prepareCrossHostPrivateTransfer, finishCrossHostPrivateTransfer } from './windows-cross-host-content-private.mjs';

test('the shared public configuration keeps its two exact exclusion notices and unresolved activation blocker', () => {
  const issues = [
    { code: 'secret_excluded', severity: 'notice', phase: 'import' },
    { code: 'credential_resolution_required', severity: 'blocking', phase: 'activation' },
    { code: 'secret_excluded', severity: 'notice', phase: 'import' },
  ];
  assert.doesNotThrow(() => assertCrossHostSelectedDiagnostics({ category: 'provider', issues }));
  for (const changed of [issues.slice(0, 1), issues.slice(1), [...issues, { code: 'unsupported_field', severity: 'blocking', phase: 'import' }],
    issues.map(issue => issue.code === 'secret_excluded' ? { ...issue, severity: 'blocking' } : issue)])
    assert.throws(() => assertCrossHostSelectedDiagnostics({ category: 'provider', issues: changed }));
  assert.throws(() => assertCrossHostSelectedDiagnostics({ category: 'skill', issues }));
});

test('synthetic private fields seed only the original owned settings bytes and never enter retained metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-cross-private-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from(JSON.stringify({ model: 'fixture', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'never-execute-owned-marker' }] }] } }));
  await writeFile(join(root, 'settings.json'), bytes, { flag: 'wx' });
  const original = { model: 'fixture', files: [{ path: 'settings.json', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  const metadata = await seedCrossHostPrivateFields(root, 'linux', original);
  assertNoCrossHostPlaintext(metadata); assert.notEqual(metadata.files[0].sha256, original.files[0].sha256);
  const actual = await readFile(join(root, 'settings.json')); const settings = JSON.parse(actual);
  assert.equal(settings.env.ANTHROPIC_API_KEY === crossHostPrivateCanaries('linux')[0], true);
  assert.equal(settings.mcpServers.cross_host_private.env.TOKEN === crossHostPrivateCanaries('linux')[1], true);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'never-execute-owned-marker');
  for (const canary of [...crossHostPrivateCanaries('linux'), ...crossHostPrivateCanaries('windows')]) assert.throws(() => assertNoCrossHostPlaintext({ nested: [canary] }), /escaped a public message/);
  await assert.rejects(seedCrossHostPrivateFields(root, 'linux', original));
  await assert.rejects(seedCrossHostPrivateFields(root, 'linux', metadata));
  assert.deepEqual(await readFile(join(root, 'settings.json')), actual);
});

test('private content capability absence and unknown original preparation cannot authorize a write', async () => {
  await assert.rejects(prepareCrossHostPrivateTransfer({ capabilities: { source: {}, target: {} }, call: () => assert.fail('no source read or private mutation without capability') }), /UNMET_PREREQUISITE/);
  const methods = [], rpc = { request: async method => { methods.push(method); assert.fail('unknown preparation must not publish'); } };
  await assert.rejects(finishCrossHostPrivateTransfer({ prepared: { pair: { requestId: 'original' }, jobId: 'job' }, files: { read: async () => Buffer.from('{}') },
    connect: async () => rpc, call: async (_lane, operation) => { assert.equal(operation, 'prepare-status'); return { phase: 'unknown', offerIds: null }; } }));
  assert.deepEqual(methods, []);
});

test('lost private prepare acknowledgement reads the original intent and forwards only Native reviewed selectors and mapped destinations', async () => {
  const operations = [], choices = [], sent = [], capabilities = { migrationSourceCredentialSourcesV1: true };
  const receipt = { manifestSha256: 'a'.repeat(64) }, providerTarget = { kind: 'provider', targetName: 'PrivatelinuxOffice', endpoint: 'https://reviewed.invalid/v1', apiFormat: 'anthropic' };
  let intent;
  const rpc = { request: async (method, params) => {
    if (method === 'migration/items') return { items: [{ id: 'p', category: 'provider' }, { id: 'm', category: 'mcp' }], nextCursor: null };
    if (method === 'migration/batch/read') return { state: { job: { sequence: 1 } } };
    if (method === 'migration/batch/plan') { choices.push(...params.choices); return { job: { sequence: 2 }, batch: { planId: 'public-plan' } }; }
    assert.fail(`unexpected public method ${method}`);
  } };
  const value = await prepareCrossHostPrivateTransfer({ capabilities: { source: capabilities, target: capabilities }, from: 'linux', to: 'windows', source: {}, target: {}, targetWorkspace: '/owned/target-workspace',
    connect: async () => rpc, until: async read => read(), call: async (lane, operation, params, discard) => {
      operations.push([lane, operation]); assertNoCrossHostPlaintext(params);
      if (operation === 'query' && params.query.kind === 'configuration') return { sources: [{ sourceId: 'actual-native-source' }] };
      if (operation === 'query' && params.query.kind === 'source_bindings') return { bindings: [{ sourceId: 'actual-native-source', family: 'configuration' }] };
      if (lane === 'source-transfer' && operation === 'run') return {};
      if (operation === 'read') return { result: { phase: 'ready', receipt } };
      if (operation === 'received') return { items: [{ entryId: 'entry' }] };
      if (operation === 'adoption-prepare') return {};
      if (operation === 'adoption-read') return { state: { workerState: 'stopped', phase: 'preview_ready', jobs: [{ jobId: 'original-job' }] } };
      if (operation === 'candidates') return { items: [
        { kind: 'provider', sourceName: 'source', selectors: [{ kind: 'claude_configuration' }], endpoint: 'https://unmapped.invalid', targets: [providerTarget] },
        { kind: 'mcp', sourceName: 'mcp', targets: [{ kind: 'mcp', targetName: 'private-linux-notes' }], definitionSha256: 'b'.repeat(64), fields: [{ kind: 'environment', name: 'TOKEN' }, { kind: 'environment', name: 'UNSELECTED' }] },
      ] };
      if (lane === 'source-transfer/private' && operation === 'run') { sent.push(...params.selections); return { received: true }; }
      if (operation === 'prepare') { assert.equal(discard, true); intent = params; return; }
      if (operation === 'prepare-status') return { phase: 'prepared', offerIds: [intent.locator.offerId], expectedSequence: 2, originalPlanId: 'public-plan', planId: 'private-plan', consent: intent.consent };
      assert.fail(`unexpected operation ${operation}`);
    } });
  assert.equal(value.jobId, 'original-job'); assertNoCrossHostPlaintext(value); assert.equal(choices[1].enableAfterImport, false);
  assert.equal(choices[1].cwd, '/owned/target-workspace');
  assert.deepEqual(sent[0], { kind: 'provider', sourceName: 'source', selector: { kind: 'claude_configuration' }, targetName: providerTarget.targetName, endpoint: providerTarget.endpoint, apiFormat: providerTarget.apiFormat });
  assert.deepEqual(sent[1].fields, [{ kind: 'environment', name: 'TOKEN' }]);
  assert.equal(operations.filter(row => row[1] === 'prepare').length, 1);
  assert.deepEqual(operations.at(-1), ['source-transfer/private', 'prepare-status']);
});
