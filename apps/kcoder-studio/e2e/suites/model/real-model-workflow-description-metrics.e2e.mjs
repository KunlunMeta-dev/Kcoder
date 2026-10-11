import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { prepareIsolatedRealModelConfig, realModelPreflight } from '../../harness/real-model.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { extractWorkflowDescription, contextInputUsage } from './workflow-description-source.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

const code = 'const pattern = /\\d+/;\nreturn {label: "你好", matched: pattern.test(input.text), count: 3, enabled: true};';
const cases = [
  { id: 'typed_defaults', expected: { action: 'create', title: 'Typed audit', input_schema: { type: 'object', properties: { count: { type: 'integer', default: 3 }, enabled: { type: 'boolean', default: true } } } } },
  { id: 'quoted_code', expected: { action: 'upsert_node', id: 'audit-draft', expected_revision: 7, node: { id: 'compute', title: 'Compute', kind: 'code', config: { code: { source: code } } } } },
  { id: 'nested_unicode', expected: { action: 'create', title: 'Nested audit', input_schema: { type: 'object', properties: { matrix: { type: 'array', items: { type: 'array', items: { type: 'integer' } }, default: [[1, 2], [3]] }, label: { type: 'string', default: '你好🌍' }, enabled: { type: 'boolean', default: false } } } } },
  { id: 'delete_only', expected: { action: 'patch_nodes', id: 'audit-draft', expected_revision: 7, remove_node_ids: ['obsolete'], response_detail: 'changes' } },
  { id: 'save_revision', expected: { action: 'save', id: 'audit-draft', expected_revision: 7, response_detail: 'changes' } },
  { id: 'loop_pin_threshold', expected: { action: 'upsert_node', id: 'audit-draft', expected_revision: 7, node: { id: 'loop', title: 'Loop', kind: 'loop', config: { loop: { mode: 'repeat', maxIterations: 3, body: { definitionId: 'audit-child', version: 3 }, until: { op: 'greater_than', pointer: '/iteration/output/outputs/0/score', value: 52 } } } } } },
].map(sample => ({ ...sample, prompt: `Produce one WorkflowDraft call using native structured fields, preserving the exact requested values. This is a private authoring/schema audit; do not execute workflow nodes. The current draft audit-draft has revision 7 and a valid graph; immutable child audit-child version 3 is available and returns its score through outputs[0]; obsolete is an independent unused node. ${sample.id === 'delete_only' ? 'Delete only obsolete. Omit nodes and nodes_json entirely. ' : ''}Requested arguments (these are public synthetic inputs): ${JSON.stringify(sample.expected)}` }));

await runE2E(import.meta.url, { testId: 'real-workflow-description-token-and-first-call-metrics', tier: 'manual-live',
  modelPolicy: 'real-model-required; 6 preregistered paired cases; <=12 upstream requests; <=1024 output tokens each; <=240s wall; zero retries; only predeclared authoring calls execute in per-sample owned libraries; no workflow nodes or other tools execute' }, async context => {
  const bodyStarted = Date.now(); const deadline = bodyStarted + 240_000;
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE || 'kunlunmeta');
  const isolated = await prepareIsolatedRealModelConfig(context, model);
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'description-metrics' });
  const binary = await requireExecutable(process.env.KCODER_E2E_WORKFLOW_DESCRIPTION_PROBE_BIN, 'bounded real provider probe');
  const { stdout: source } = await promisify(execFile)('git', ['show', 'e6bc92645:crates/kcoder_tools/src/workflow_draft.rs'], { cwd: repoRoot, maxBuffer: 512 * 1024 });
  const oldDescription = extractWorkflowDescription(source);
  assert.equal([...oldDescription].length, 13831, 'historical source identity changed');
  const spec = await context.writeStateJson('description-spec.json', { oldDescription, cases });
  const base = JSON.parse(await readFile(isolated.settingsFile, 'utf8'));
  const selected = { ...model.providerConfig, max_output_tokens: 1024, output_headroom_tokens: 1024, reasoning_effort: null,
    models: { [model.model]: { ...model.providerConfig.models?.[model.model], context_window_tokens: model.providerConfig.context_window_tokens, max_output_tokens: 1024, output_headroom_tokens: 1024, reasoning_effort: null } } };
  const settingsFile = await context.writeStateJson('bounded-settings.json', { ...base, max_retries: 0, providers: { [model.provider]: selected } }, 0o400);
  const output = context.pathInState('description-metrics.json');
  const credentialEnv = Object.fromEntries(model.credentialEnv.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const child = context.spawnOwned('workflow-description-probe', binary, [isolated.configDir, settingsFile, model.profile, spec, output], {
    cwd: workspace.path, env: context.isolatedEnvironment({ KCODER_E2E_REAL_MODEL: '1', KCODER_MAX_RETRIES: '0', KCODER_CONFIG_DIR: isolated.configDir, ...credentialEnv }),
  });
  const clock = Date.now(); const timer = setTimeout(() => { void context.stopOwned('workflow-description-probe'); }, Math.max(1, deadline - Date.now()));
  let code; try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); }
  let report; try { report = JSON.parse(await readFile(output, 'utf8')); } catch { throw new Error('Provider probe produced no usage report; unmet prerequisite or first request failed'); }
  report.apiFormat = model.providerConfig.api_format;
  report.oldSource = 'e6bc92645:crates/kcoder_tools/src/workflow_draft.rs::WorkflowDraftTool::description';
  report.samplePolicy = 'Six exact synthetic native-structured first calls, alternating pair order; fixed actual Engine-rendered current schema, actual configured host normalization/coercion, system, per-case user input, profile/model/parameters; actual authoring only in owned per-sample libraries; no nodes, external effects, retries or reselection.';
  report.wallMs = Date.now() - clock;
  report.suiteBodyWallMs = Date.now() - bodyStarted;
  const old = report.rows.filter(row => row.variant === 'old'); const current = report.rows.filter(row => row.variant === 'new');
  report.uncachedInputUsage = Object.fromEntries(['old', 'new'].map(variant => [variant, report.rows.filter(row => row.variant === variant).reduce((total,row) => total + Math.max(0,...row.usageEvents.map(usage => usage.input_tokens)),0)]));
  report.totalInputTokens = Object.fromEntries(['old', 'new'].map(variant => [variant, contextInputUsage(report.rows.filter(row => row.variant === variant), report.apiFormat)]));
  report.firstLegalCalls = { old: old.filter(row => row.firstLegalCall).length, new: current.filter(row => row.firstLegalCall).length, denominator: 6 };
  const normalizedLegal = row => row.normalizedToolContractValid && row.normalizedNodeContractValid && row.normalizedScenarioSemanticsValid && row.toolCallCount === 1 && row.streamStopped;
  report.firstNormalizedContractCalls = { old: old.filter(normalizedLegal).length, new: current.filter(normalizedLegal).length, denominator: 6 };
  report.hostToolExecutionMeasured = true;
  report.hostToolExecutionScope = "WorkflowDraft direct Tool.call after actual configured Engine normalization/coercion, owned IDs/revision/child, disk readback; no Engine permission/hook orchestration or node execution";
  const authoringLegal = row => row.actualAuthoring?.accepted && row.actualAuthoring?.persistedSemanticsValid && row.toolCallCount === 1 && row.streamStopped;
  report.firstActualAuthoringCalls = { old: old.filter(authoringLegal).length, new: current.filter(authoringLegal).length, denominator: 6 };
  report.nativeFieldCompliance = { old: old.filter(row => row.nativeFieldCompliance).length, new: current.filter(row => row.nativeFieldCompliance).length, denominator: 6 };
  report.rawNonRegression = report.firstLegalCalls.new >= report.firstLegalCalls.old;
  const retained = { ...report, outputUnitCap: report.maxOutputTokens, totalInputUsage: report.totalInputTokens, usageUnit: 'actual provider-reported tokens; Anthropic context totals add uncached input + cache creation + cache read; OpenAI input already includes cache', rows: report.rows.map(row => ({ ...row, usageEvents: row.usageEvents.map(usage => ({ input: usage.input_tokens, output: usage.output_tokens, total: usage.total_tokens ?? null, cacheCreationInput: usage.cache_creation_input_tokens ?? null, cacheReadInput: usage.cache_read_input_tokens ?? null })) })) };
  delete retained.maxOutputTokens; delete retained.totalInputTokens;
  await context.writeArtifactJson('description-metrics.json', retained);
  assert.equal(code, 0, 'probe failed; partial data retained');
  assert.equal(report.rows.length, 12, 'all preregistered samples must be retained');
  assert.ok(report.rows.every(row => row.usageEvents.some(usage => usage.input_tokens > 0)), 'actual provider input usage is mandatory');
  assert.ok(report.totalInputTokens.new < report.totalInputTokens.old, 'actual provider input token usage did not decrease');
  assert.ok(report.firstNormalizedContractCalls.new >= report.firstNormalizedContractCalls.old, 'first normalized contract call rate regressed; all samples retained without retry');
  assert.ok(report.rows.every(normalizedLegal), 'bounded normalized contract acceptance requires all six legal samples per variant');
  assert.ok(report.firstActualAuthoringCalls.new >= report.firstActualAuthoringCalls.old, 'actual owned authoring acceptance regressed');
  assert.ok(report.rows.every(authoringLegal), 'bounded owned authoring acceptance requires all six accepted samples per variant');
  assert.ok(report.rows.every(row => row.nativeFieldCompliance), 'fixed native-field prompt control was not followed');
  return { provider: report.provider, model: report.model, requests: report.rows.length, firstLegalCalls: report.firstLegalCalls, wallMs: report.wallMs };
});
