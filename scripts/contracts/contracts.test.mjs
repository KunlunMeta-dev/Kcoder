import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesSchema } from './runtime.mjs';
import { isContract, allowedFields, knownValues, errorCodes } from '../../apps/kcoder-studio/shared/generated/validator.mjs';
import * as guards from '../../apps/kcoder-studio/shared/generated/contractGuards.mjs';
import { CONTRACT_DOMAINS, domainFile, splitContractDomains, mergeContractDomains } from './domains.mjs';

// These same versioned cases are decoded by the Rust exporter before generation.
const readDomains = (base, stem) => mergeContractDomains(Object.fromEntries(CONTRACT_DOMAINS.map(domain => [
  domain, JSON.parse(readFileSync(new URL(domainFile(stem, domain), base))),
])));
const fixtures = readDomains(import.meta.url, 'fixtures');
const serializedExamples = readDomains(new URL('../../apps/kcoder-studio/shared/generated/', import.meta.url), 'examples');
test('continuous work pages and result references retain native bounds', () => {
  const result = { resultId: 'result-1', ready: true, artifactRefs: Array(256).fill('artifact') };
  assert.equal(isContract('ContinuousWorkResultView', result), true);
  assert.equal(isContract('ContinuousWorkResultView', { ...result, artifactRefs: Array(257).fill('artifact') }), false);
  const work = { workId: 'work-1', threadId: 'thread-1', phase: 'running',
    revision: 1, requirementsRevision: 1, freshness: 'current' };
  assert.equal(isContract('ContinuousWorkListResult', { items: Array(10).fill(work) }), true);
  assert.equal(isContract('ContinuousWorkListResult', { items: Array(11).fill(work) }), false);
});
test('future work control targets remain bounded observations with a required kind', () => {
  const base = fixtures.ContinuousWorkControlResult.valid[0].value;
  const check = target => isContract('ContinuousWorkControlResult', { ...base, target });
  assert.equal(check({ kind: '未来动作', detail: '汉'.repeat(800) }), true);
  assert.equal(check({ kind: '\ufefffuture' }), true); // Rust trim does not remove U+FEFF.
  assert.equal(check({ kind: '\u0085future' }), false);
  assert.equal(check({ kind: 'future\n' }), false);
  assert.equal(check({ detail: 'missing kind' }), false);
  assert.equal(check('not-an-object'), false);
  assert.equal(check({ kind: 'future', detail: 'x'.repeat(3000) }), false);
  assert.equal(check({ kind: 'future', number: Number.MAX_SAFE_INTEGER + 1 }), false);
  const nested = { kind: 'future' };
  let tail = nested;
  for (let i = 0; i < 66; i += 1) { tail.next = {}; tail = tail.next; }
  assert.equal(check(nested), false);
  const cyclic = { kind: 'future' }; cyclic.self = cyclic;
  assert.equal(check(cyclic), false);
  const original = fixtures.ContinuousWorkControlResult.valid.find(item => item.name === 'future-target-read-only').value.target;
  const decoded = serializedExamples.ContinuousWorkControlResult.find(item => item.name === 'future-target-read-only').decoded.target;
  assert.deepEqual(decoded, original);
});
for (const [name, cases] of Object.entries(fixtures)) {
  test(`${name}: Rust-compatible legacy/current values and invalid wire rejection`, () => {
    const guard = guards[`is${name}`];
    assert.equal(typeof guard, 'function', `public guard for ${name}`);
    for (const example of cases.valid) assert.equal(isContract(name, example.value), true, example.name);
    for (const example of cases.invalid) assert.equal(isContract(name, example.value), false, example.name);
    for (const example of cases.valid) assert.equal(guard(example.value), true, example.name);
    for (const example of cases.invalid) assert.equal(guard(example.value), false, example.name);
    if (allowedFields[name]) for (const example of cases.valid) {
      // Unknown wire fields may be accepted by serde and omitted on serialization.
      const decoded = serializedExamples[name].find(value => value.name === example.name).decoded;
      for (const field of Object.keys(decoded)) assert.ok(allowedFields[name].includes(field), field);
    }
  });
}
test('wire validation rejects non-JSON object inheritance and unsafe integer precision', () => {
  const summary = fixtures.ModelConfigurationSummary.valid[0].value;
  assert.equal(isContract('ModelConfigurationSummary', Object.assign(Object.create({ apiKey: 'secret' }), summary)), false);
  assert.equal(isContract('ModelConfigurationSummary', { ...summary, contextWindowTokens: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(isContract('ModelConfigurationSummary', { ...summary, contextWindowTokens: Infinity }), false);
  assert.equal(isContract('UnregisteredPrivateContract', summary), false);
});

test('Rust f64 chart coordinates remain finite floating point values', () => {
  const schema = { type: 'number', format: 'double' };
  assert.equal(matchesSchema(schema, 1.25), true);
  assert.equal(matchesSchema(schema, -0.5), true);
  assert.equal(matchesSchema(schema, NaN), false);
  assert.equal(matchesSchema(schema, Infinity), false);
  assert.equal(matchesSchema(schema, -Infinity), false);
  assert.equal(matchesSchema(schema, '1.25'), false);
});


for (const name of ['TaskStatus', 'TurnAttemptStatus', 'WikiJobStatus', 'WikiJobPhase']) {
  test(`${name} metadata describes known facts while preserving unknown UTF-8 labels`, () => {
    assert.ok(knownValues[name].includes(name === 'WikiJobPhase' ? 'source_support' : 'completed'));
    assert.equal(knownValues[name].includes('future_review'), false);
    assert.equal(isContract(name, 'future_review'), true);
    assert.equal(isContract(name, '汉'.repeat(85) + 'a'), true);
    assert.equal(isContract(name, '汉'.repeat(85) + 'ab'), false);
    assert.equal(isContract(name, '\ud800'), false);
  });
}
test('MCP reason/error labels and omitted legacy facts come from the actual serde contract', () => {
  assert.deepEqual(Object.keys(errorCodes.McpFailureReason).sort(), [...knownValues.McpFailureReason].sort());
  assert.equal(errorCodes.McpFailureReason.protocolFailed, 'mcp_protocol_failed');
  assert.equal(errorCodes.McpFailureReason.authorizationRequired, 'mcp_authorization_required');
  const examples = readDomains(new URL('../../apps/kcoder-studio/shared/generated/', import.meta.url), 'examples');
  const oldAttempt = examples.McpConnectionAttempt.find(example => example.name === 'legacy_missing_reason');
  assert.deepEqual(oldAttempt.decoded, { status: 'unavailable' });
  const oldServer = examples.McpServerSummary.find(example => example.name === 'legacy_without_failure_fields');
  assert.equal(Object.hasOwn(oldServer.decoded, 'lastConnectionFailure'), false);
  const extended = { ...oldServer.value, futureDetail: 'fixture-sensitive-field' };
  assert.equal(isContract('McpServerSummary', extended), true);
  const projection = Object.fromEntries(Object.entries(extended).filter(([key]) => allowedFields.McpServerSummary.includes(key)));
  assert.equal(Object.hasOwn(projection, 'futureDetail'), false);
});

test('schema string length counts Unicode scalars and enforces both bounds', () => {
  const bounded = { type: 'string', minLength: 2, maxLength: 3 };
  assert.equal(matchesSchema(bounded, 'a'), false);
  assert.equal(matchesSchema(bounded, 'ab'), true);
  assert.equal(matchesSchema(bounded, 'abc'), true);
  assert.equal(matchesSchema(bounded, 'abcd'), false);
  assert.equal(matchesSchema(bounded, '😀'), false);
  assert.equal(matchesSchema(bounded, '😀a'), true);
  assert.equal(matchesSchema(bounded, '😀ab'), true);
  assert.equal(matchesSchema(bounded, '😀abc'), false);
  assert.equal(matchesSchema(bounded, '\ud800a'), false);
  assert.equal(matchesSchema({ type: 'string', minLength: 0, maxLength: 0 }, ''), true);
  assert.equal(matchesSchema({ type: 'string', maxLength: 0 }, 'a'), false);
});


test('initialize defaults and unknown-field compatibility retain the typed bool map', () => {
  const examples = serializedExamples.InitializeParams;
  assert.deepEqual(examples.find(value => value.name === 'default_capabilities').decoded.capabilities, { experimental: {} });
  const extended = examples.find(value => value.name === 'unknown_fields_compatible');
  assert.equal(Object.hasOwn(extended.decoded, 'futureDetail'), false);
  assert.deepEqual(extended.decoded.clientInfo, { name: 'contract-client', version: '1' });
  assert.equal(isContract('InitializeParams', { ...extended.value, capabilities: { experimental: { futureFlag: 'true' } } }), false);
});

test('every reviewed fixture has one generated schema and complete Rust-decoded examples across domains', () => {
  const base = new URL('../../apps/kcoder-studio/shared/generated/', import.meta.url);
  const schemas = readDomains(base, 'schemas');
  const examples = readDomains(base, 'examples');
  assert.deepEqual(Object.keys(schemas).sort(), Object.keys(fixtures).sort());
  assert.deepEqual(Object.keys(examples).sort(), Object.keys(fixtures).sort());
  for (const [name, cases] of Object.entries(fixtures)) {
    assert.equal(examples[name].length, cases.valid.length, name);
    for (const example of examples[name]) assert.equal(isContract(name, example.decoded), true, `${name}/${example.name}`);
  }
});

test('domain splitting preserves content and rejects misplaced, duplicate or unsafe record names', () => {
  const records = { ModelConfigurationSummary: { a: 1 }, WidgetRef: { b: 2 }, McpAppRevokeResult: { c: 3 }, MigrationAssetPlanParams: { d: 4 } };
  assert.deepEqual(mergeContractDomains(splitContractDomains(records)), records);
  assert.throws(() => mergeContractDomains({ core: { WidgetRef: {} } }), /another storage domain/);
  assert.throws(() => mergeContractDomains({ widgets: { WidgetRef: {} }, core: { WidgetRef: {} } }), /Duplicate/);
  assert.throws(() => splitContractDomains(JSON.parse('{"__proto__":{}}')), /Invalid contract name/);
  assert.throws(() => mergeContractDomains({ arbitrary: {} }), /Invalid contract storage domain/);
});

test('generation refuses missing, stale or mismatched exporter receipts without exposing fixture values', async () => {
  const { validateExporterReceipt } = await import('./source-receipt.mjs');
  const source = { Example: { valid: [{ name: 'current', value: { label: 'SYNTHETIC_PRIVATE_CANARY' } }], invalid: [] } };
  const fixturesWithDecoding = { Example: { valid: [{ ...source.Example.valid[0], decoded: { label: 'decoded' } }], invalid: [] } };
  assert.doesNotThrow(() => validateExporterReceipt({ sourceReceipt: 'current', fixtures: fixturesWithDecoding }, 'current', source));
  for (const exported of [{ fixtures: source }, { sourceReceipt: 'old', fixtures: source },
    { sourceReceipt: 'current', fixtures: { Example: { valid: [], invalid: [] } } },
    { sourceReceipt: 'current', fixtures: { Example: { valid: source.Example.valid, invalid: [{ value: 'changed' }] } } }]) {
    assert.throws(() => validateExporterReceipt(exported, 'current', source), error =>
      error.message.includes('rebuild the exporter') && !error.message.includes('SYNTHETIC_PRIVATE_CANARY'));
  }
});

test('compiled source receipts bind contents and added files while ignoring checkout location', async () => {
  const { protocolSourceReceipt } = await import('./source-receipt.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const roots = [mkdtempSync(join(tmpdir(), 'kcoder-contract-receipt-')), mkdtempSync(join(tmpdir(), 'kcoder-contract-receipt-'))];
  const files = ['Cargo.toml', 'Cargo.lock', 'crates/kcoder_app_protocol/Cargo.toml', 'crates/kcoder_app_protocol/build.rs',
    'crates/kcoder_types/Cargo.toml', 'crates/kcoder_app_protocol/examples/export_contracts.rs',
    'scripts/contracts/source-receipt.mjs', 'scripts/contracts/fixtures.json',
    'crates/kcoder_app_protocol/src/lib.rs', 'crates/kcoder_types/src/lib.rs',
    'crates/kcoder_app_protocol/internal/channel_protocol/Cargo.toml', 'crates/kcoder_app_protocol/src/internal/channel_protocol/lib.rs',
    'crates/kcoder_app_protocol/internal/integration_protocol/Cargo.toml', 'crates/kcoder_app_protocol/src/internal/integration_protocol/lib.rs',
    'crates/kcoder_types/internal/common_types/Cargo.toml', 'crates/kcoder_types/internal/session_types/Cargo.toml',
    'crates/kcoder_types/internal/integration_types/Cargo.toml'];
  try {
    for (const root of roots) for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), `fixture:${file}`);
    }
    const original = protocolSourceReceipt(roots[0]);
    assert.equal(protocolSourceReceipt(roots[1]), original);
    for (const file of files.filter(file =>
      /\/internal\/.*\/Cargo\.toml$/.test(file) || /\/src\/internal\//.test(file))) {
      writeFileSync(join(roots[1], file), 'changed contract crate');
      assert.notEqual(protocolSourceReceipt(roots[1]), original);
      writeFileSync(join(roots[1], file), `fixture:${file}`);
    }
    writeFileSync(join(roots[0], 'crates/kcoder_app_protocol/src/lib.rs'), 'changed wire type');
    assert.notEqual(protocolSourceReceipt(roots[0]), original);
    writeFileSync(join(roots[1], 'scripts/contracts/fixtures.json'), 'changed fixtures');
    assert.notEqual(protocolSourceReceipt(roots[1]), original);
    writeFileSync(join(roots[1], 'scripts/contracts/fixtures.json'), 'fixture:scripts/contracts/fixtures.json');
    writeFileSync(join(roots[1], 'crates/kcoder_types/src/new.rs'), 'new shared wire type');
    assert.notEqual(protocolSourceReceipt(roots[1]), original);
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});

test('array cardinality is enforced through nullable schema branches', () => {
  const schema = { anyOf: [{type:'null'}, {type:'array',minItems:1,maxItems:2,items:{type:'string'}}] };
  assert.equal(matchesSchema(schema,null),true);
  assert.equal(matchesSchema(schema,[]),false);
  assert.equal(matchesSchema(schema,['one']),true);
  assert.equal(matchesSchema(schema,['one','two']),true);
  assert.equal(matchesSchema(schema,['one','two','three']),false);
  assert.equal(matchesSchema(schema,['one',3]),false);
});
