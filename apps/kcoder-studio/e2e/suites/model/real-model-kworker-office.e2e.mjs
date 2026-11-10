import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runE2E, repoRoot } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { realModelPreflight, prepareIsolatedRealModelConfig } from '../../harness/real-model.mjs';
import { startLiveModelObserver } from '../../harness/live-model-observer.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl } from '../../harness/rpc.mjs';
import { officeBudget, officeBudgetMeter } from '../../harness/kworker-office-budget.mjs';
import { officeCases, officeSourceHashes, validateOfficeCase, validateOfficeWidgets, OFFICE_PRESENTATION } from '../../harness/kworker-office-cases.mjs';
import { isContract } from '../../../shared/generated/validator.mjs';
const execute = promisify(execFile);
const disabledForCorpus = ['WebSearch', 'WebFetch', 'bash', 'PowerShell'];
const unavailableInOffice = new Set(['ocr', ...disabledForCorpus]);
// Delegation is a real KWorker capability, but these four owned tasks explicitly
// forbid using it. Tool registration and the user's task restriction are distinct.
const forbiddenForTask = new Set([...unavailableInOffice, 'spawn_agent', 'explore_agent', 'SendMessage', 'wait', 'close_agent']);
const officeHostTools = new Set(['show_widget', 'Workflow', 'WorkflowDraft', 'PowerShell', 'spawn_agent', 'explore_agent', 'SendMessage', 'wait', 'close_agent', 'tool_search', 'tool_execute']);

await runE2E(import.meta.url, { testId: 'kworker-office-four-tasks-three-visuals', tier: 'real-model-credentialed', modelPolicy: 'real-model-required', retainSuccessLogs: true }, async context => {
  if (process.env.KCODER_E2E_REAL_MODEL !== '1') throw Error('UNMET_PREREQUISITE: set KCODER_E2E_REAL_MODEL=1 and use --real-model; no fixture fallback');
  const budget = officeBudget();
  const selector = process.env.KCODER_E2E_MODEL_CREDENTIAL_ENV;
  if (!selector || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(selector) || !process.env[selector]?.trim())
    throw Error('UNMET_PREREQUISITE: kworker office requires an explicit protected credential environment selector/value');
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE || 'kunlunmeta');
  if (!model.credentialEnv.includes(selector)) throw Error('UNMET_PREREQUISITE: protected credential selector does not match the selected profile');
  context.registerSecret(process.env[selector]);
  const { path: workspace, sourceDigest } = await materializeWorkspace(context, 'kworker-office');
  const marker = `OFFICE_${randomBytes(8).toString('hex')}`;
  await appendFile(resolve(workspace, 'sources/meeting.md'), `\nSource marker: ${marker}\n`);
  const inputHashes = await officeSourceHashes(workspace);
  const isolated = await prepareIsolatedRealModelConfig(context, model, { credentialSource: 'environment-only' });
  const meter = officeBudgetMeter(budget, model.model);
  const observer = await startLiveModelObserver(context, model.providerConfig.endpoint, budget.maxRequests, {
    requestTimeoutMs: budget.requestTimeoutMs,
    beforeForward: metadata => {
      for (const name of metadata.exposedToolNames) assert.ok(!unavailableInOffice.has(name), `Disabled office corpus tool ${name}`);
      return meter.admit(metadata);
    },
  });
  const settingsFile = await context.writeStateJson('real-model-config/settings_office.jsonc', {
    active_provider: model.provider,
    providers: { [model.provider]: { ...model.providerConfig, endpoint: observer.endpoint, no_proxy: true, max_output_tokens: budget.outputTokens, max_retries: 0 } },
    // Local text/file tasks use the real default Luna policy, with remote fetch and shell execution disabled for this owned corpus.
    tools: { profile: 'full', disabled: disabledForCorpus },
    permission_mode: 'bypass', max_tokens: budget.outputTokens, max_retries: 0,
    max_duration_secs: Math.floor(budget.caseWallMs / 1000), session_memory: { enabled: false },
  }, 0o400);
  const childEnv = context.isolatedEnvironment({ KCODER_CONFIG_DIR: isolated.configDir, KCODER_TRAINING_MODE: 'true', [selector]: process.env[selector] });
  const effective = await execute(model.kcoderBin, ['--cwd', workspace, '--settings-file', settingsFile, 'config', 'get', 'tools.luna.allowed'], { cwd: repoRoot, env: childEnv, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' });
  const allowed = JSON.parse(effective.stdout);
  assert.ok(Array.isArray(allowed) && allowed.includes('Workflow') && allowed.includes('TodoWrite'));
  assert.ok(!allowed.includes('ocr'), 'the configured Luna source policy must exclude OCR');
  const serversFile = await context.writeStateJson('office-servers.json', [{ id: 'office', label: 'Owned office test', transport: 'local', command: model.kcoderBin, workspace, settingsFile, profile: model.profile }]);
  const gateway = await startGateway(context, { workspace, serversFile, env: {
    KCODER_CONFIG_DIR: isolated.configDir, KCODER_TRAINING_MODE: 'true', KCODER_MAX_TOKENS: String(budget.outputTokens), KCODER_MAX_RETRIES: '0',
    KCODER_MAX_DURATION_SECS: String(Math.floor(budget.caseWallMs / 1000)), [selector]: process.env[selector],
  } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'office', token));
  context.addCleanup('close owned office RPC', () => closeRpcAndWait(rpc));
  const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-office-real-model', version: '1' }, capabilities: { experimental: { studioWorkModesV1: true, inlineWidgetsV1: true } } });
  assert.equal(initialized.capabilities.experimental.studioWorkModesV1, true);
  assert.equal(initialized.capabilities.experimental.inlineWidgetsV1, true);
  const results = [];
  const started = Date.now();
  const timeout = setTimeout(() => { void context.requestAbort(new Error('Office suite wall budget exceeded')); rpc.close(); }, budget.suiteWallMs);
  try {
    for (const task of officeCases(marker)) {
      const { thread } = await rpc.request('thread/start', { studioWorkMode: 'kworker', cwd: workspace });
      assert.equal(thread.studioWorkMode, 'kworker');
      const catalog = await rpc.request('tools/catalog', { threadId: thread.id, clientPresentation: OFFICE_PRESENTATION });
      const names = catalog.tools.map(tool => tool.name);
      assert.ok(names.includes('show_widget') && names.includes('Workflow') && names.includes('TodoWrite'));
      assert.ok(names.every(name => allowed.includes(name) || officeHostTools.has(name)), 'catalog tools must belong to the configured Luna policy or the finite native KWorker additions');
      assert.ok(!names.some(name => unavailableInOffice.has(name)));
      meter.beginCase(task.id);
      const before = rpc.messages().length;
      const { turn } = await rpc.request('turn/start', { threadId: thread.id, clientPresentation: OFFICE_PRESENTATION, input: [{ type: 'text', text: task.prompt }] });
      const terminal = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.id, budget.caseWallMs + 5000, `real office ${task.id}`);
      assert.equal(terminal.params.turn.status, 'completed', 'a received or failed model response is not task success');
      const events = rpc.messages().slice(before).filter(message => message.params?.threadId === thread.id && message.params?.turnId === turn.id);
      const readPaths = new Set(events.filter(message => message.method === 'item/started' && message.params?.item?.type === 'toolCall' && String(message.params.item.name).toLowerCase() === 'read')
        .map(message => message.params.item.input?.path ?? message.params.item.input?.file_path).filter(path => typeof path === 'string').map(path => resolve(workspace,path)));
      for (const source of task.requiredSources) assert.ok(readPaths.has(resolve(workspace,source)), 'model must actually read every required original source file');
      for (const message of events.filter(message => message.method === 'item/started' && message.params?.item?.type === 'toolCall')) assert.ok(!forbiddenForTask.has(message.params.item.name), 'the owned corpus task cannot delegate or use disabled tools');
      const artifacts = await validateOfficeCase(workspace, task, marker);
      assert.deepEqual(await officeSourceHashes(workspace), inputHashes, 'original corpus must remain unchanged');
      let visualizations;
      if (task.id === 'presentation') {
        const list = await rpc.request('widget/list', { threadId: thread.id });
        assert.ok(list.widgets.length >= 3 && list.widgets.length <= 12);
        const widgets = [];
        for (const widget of list.widgets) {
          assert.ok(isContract('WidgetRef', widget) && widget.threadId === thread.id && widget.turnId === turn.id);
          assert.ok(Number.isSafeInteger(widget.bytes) && widget.bytes > 0 && widget.bytes <= 1024 * 1024 && /^[a-f0-9]{64}$/.test(widget.sha256));
          const parts = [];
          let offset = 0;
          while (offset < widget.bytes) {
            const chunk = await rpc.request('widget/content/read', { threadId: thread.id, widgetId: widget.widgetId, revision: widget.revision, offset });
            assert.ok(isContract('WidgetContentReadResult', chunk));
            assert.equal(chunk.widgetId, widget.widgetId); assert.equal(chunk.revision, widget.revision); assert.equal(chunk.sha256, widget.sha256); assert.equal(chunk.bytes, widget.bytes); assert.equal(chunk.offset, offset);
            const data = Buffer.from(chunk.dataBase64, 'base64');
            assert.ok(chunk.nextOffset > offset && chunk.nextOffset <= widget.bytes && data.length <= 32768);
            assert.equal(data.length, chunk.nextOffset - offset); parts.push(data); offset = chunk.nextOffset;
          }
          const bytes = Buffer.concat(parts); assert.equal(createHash('sha256').update(bytes).digest('hex'), widget.sha256);
          widgets.push({ widget, source: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
        }
        visualizations = validateOfficeWidgets(widgets);
      }
      results.push({ caseId: task.id, threadMode: thread.studioWorkMode, actualSourceRead: true, ...artifacts, ...(visualizations ? { visualizations } : {}), budget: meter.snapshot() });
      await context.writeArtifactJson('office-progress.json', { provider: model.provider, model: model.model, budget, sourceDigest, inputHashes, cases: results });
    }
    assert.ok(observer.observations.some(row => row.status === 200), 'the suite must make actual real-provider requests');
    assert.ok(observer.observations.every(row => row.status === 200 && !row.error), 'provider or budget failures cannot be hidden');
    return { provider: model.provider, model: model.model, sourceDigest, inputHashes, budget, actualProviderRequests: observer.observations.length, durationMs: Date.now() - started, cases: results, claimBoundary: 'actual model/file/source arithmetic and inline source generation; browser/native rendering verified separately' };
  } finally { clearTimeout(timeout); await context.writeArtifactJson('office-provider-shape.json', { observations: observer.observations, budget: meter.snapshot() }); }
});
