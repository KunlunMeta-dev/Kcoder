import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';
import { AppServerStdioClient } from '../../e2e/harness/app-server-stdio.mjs';

const defaultDisabledTools = [
  'EnterWorktree', 'ExitWorktree', 'WorktreeCreate', 'WorktreeRemove',
  'cron_create', 'cron_delete', 'cron_list',
  'SpecInit', 'SpecNewChange', 'SpecArchive', 'SpecStatus', 'SpecUpdate', 'SpecCheck',
  'SpecSync', 'SpecRecordVerification', 'SpecReview', 'SpecParallelDraft', 'SpecConfig',
  'AskUserQuestionAsync', 'EnterPlanMode', 'ExitPlanMode', 'VerifyPlanExecution',
];

process.umask(0o077);
await runIntegration(import.meta.url, {
  testId: 'startup-settings-native-without-model-or-valid-limits',
  tier: 'full-integration',
  modelPolicy: 'Real no-scenario Native stdio. Management makes zero model requests; execution uses only an owned closed loopback endpoint. No paid model, private network probe, Windows or GUI claim.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'startup candidate');
  const expectedSha256 = process.env.KCODER_E2E_KCODER_BIN_SHA256;
  assert.match(expectedSha256 ?? '', /^[a-f0-9]{64}$/);
  const digest = createHash('sha256');
  await new Promise((resolve, reject) => createReadStream(binary).on('data', bytes => digest.update(bytes)).on('end', resolve).on('error', reject));
  const binarySha256 = digest.digest('hex');
  assert.equal(binarySha256, expectedSha256);
  const image = await stat(binary, { bigint: true });
  const reports = [];
  const cases = ['unconfigured', 'missing-limits', 'offline', 'offline-slow-head', 'legacy-toml', 'json-in-toml'];
  for (const name of cases) {
    const report = { name, management: [], execution: null, providerManagementRequests: 0,
      modelRequestsDuringManagement: 0, managementHttp: [] };
    let phase = 'management', pendingHead = false;
    report.executionHttp = [];
    reports.push(report);
    const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: `startup-${name}` });
    const profile = context.pathInState(`startup-${name}-profile`);
    await mkdir(profile, { mode: 0o700 });
    await context.writeStateJson(`startup-${name}-profile/settings.json`, {});
    const server = createServer((request, response) => {
      if (phase === 'management') {
        report.providerManagementRequests++;
        report.managementHttp.push({ method: request.method, path: request.url });
        if (request.method === 'POST') report.modelRequestsDuringManagement++;
      } else if (phase === 'execution') report.executionHttp.push({ method: request.method, path: request.url });
      if (name === 'offline-slow-head' && request.method === 'HEAD') {
        pendingHead = true;
        response.once('close', () => { pendingHead = false; });
        return;
      }
      response.writeHead(503).end();
    });
    let closed = false;
    const closeProvider = async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    };
    context.addCleanup(`close startup endpoint ${name}`, closeProvider);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.registerPort(`startup-${name}-endpoint`, server.address().port);
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    const provider = { api_format: 'openai_chat_completions', endpoint, default_model: 'owned-explicit-model',
      authentication: { mode: 'none' }, discover_models: false, no_proxy: true,
      context_window_tokens: 262144, output_headroom_tokens: 1024, max_output_tokens: 1024,
      request_timeout_secs: name === 'offline-slow-head' ? 30 : 1, max_retries: 0 };
    const value = name === 'unconfigured' ? {} : {
      active_provider: 'ownedFixture', max_retries: 0,
      providers: { ownedFixture: name === 'missing-limits' ? {
        api_format: provider.api_format, endpoint, default_model: provider.default_model,
        authentication: provider.authentication, discover_models: false, no_proxy: true,
      } : provider },
    };
    const file = path.join(profile, `explicit-settings.${name.includes('toml') ? 'toml' : 'json'}`);
    const bytes = Buffer.from(name === 'legacy-toml' ? [
      'provider = "ownedFixture"', 'model = "owned-explicit-model"', 'api_format = "openai"',
      '[model_providers.ownedFixture]', `base_url = ${JSON.stringify(endpoint)}`,
      'context_window_tokens = 32768', 'output_headroom_tokens = 1024', 'max_output_tokens = 1024',
    ].join('\n') + '\n' : JSON.stringify(value, null, 2) + '\n');
    await writeFile(file, bytes, { mode: 0o600 });
    const label = `startup-native-${name}`;
    const child = context.spawnOwned(label, binary, ['--settings-file', file, '--cwd', workspace, 'app-server'], {
      cwd: workspace, env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: profile, KCODER_HOME: profile }), stdin: 'pipe',
    });
    report.pid = child.pid;
    const client = new AppServerStdioClient(label, child, { defaultTimeoutMs: 10_000, notificationHistoryLimit: 128 });
    const managementStarted = performance.now();
    context.addCleanup(`close startup reader ${name}`, () => client.closeReader());
    try {
      if (process.platform === 'linux') {
        await waitFor(async () => {
          const actual = await stat(`/proc/${child.pid}/exe`, { bigint: true });
          return actual.dev === image.dev && actual.ino === image.ino;
        }, 5_000, 'startup owned executable identity');
      }
      const request = async (method, params = {}) => {
        const response = await client.request(method, params);
        report.management.push({ method, ok: response.error === undefined, code: response.error?.code });
        assert.equal(response.error, undefined, `${name} ${method} must remain available`);
        return response.result;
      };
      await request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-startup-settings', version: '1' },
        capabilities: { experimental: { residentThreads: true } } });
      if (name === 'offline-slow-head') await waitFor(() => pendingHead, 5_000, 'owned prewarm HEAD remains unanswered');
      await request('runtime.context.get');
      await request('runtime.providers.list');
      await request('settings/tools/read');
      const selection = await request('settings/tools/selection/read');
      assert.equal(selection.truncated, false, 'the owned full-profile selection is complete');
      const catalog = await request('tools/catalog');
      assert.equal(catalog.truncated, false, 'the owned workspace catalog is complete');
      for (const toolName of defaultDisabledTools) {
        const tool = selection.tools.find(entry => entry.name === toolName);
        assert.ok(tool, `${toolName} remains registered and configurable`);
        assert.equal(tool.available, false, `${toolName} is disabled by the packaged defaults`);
        assert.equal(tool.unavailableReason, 'disabled_by_configuration');
        assert.ok(selection.modes.every(mode => !mode.allowedTools.includes(toolName)),
          `${toolName} is not selected for new Studio tasks`);
        assert.ok(catalog.tools.every(entry => entry.name !== toolName),
          `${toolName} is absent from the actual model-facing catalog`);
      }
      report.defaultDisabledToolsVerified = defaultDisabledTools.length;
      assert.equal(report.modelRequestsDuringManagement, 0, 'settings access must never generate a model response');
      report.managementElapsedMs = performance.now() - managementStarted;
      if (name === 'offline-slow-head') {
        report.pendingHeadWhileManagementCompleted = pendingHead;
        assert.equal(pendingHead, true, 'metadata must complete while the original HEAD is still unanswered');
        assert.ok(report.managementElapsedMs < 10_000, 'unanswered prewarm cannot consume the management deadline');
      }
      phase = 'execution';
      if (name !== 'offline-slow-head') await closeProvider();
      if (name !== 'legacy-toml') {
        const started = await client.request('thread/start', {});
        if (started.error) {
          report.execution = { rejected: true, code: started.error.code };
        } else {
          const threadId = started.result.thread.id;
          const turn = await client.request('turn/start', { threadId, clientMessageId: `owned-startup-${name}`, input: [{ type: 'text', text: 'Owned configuration failure only' }] });
          if (turn.error) report.execution = { rejected: true, code: turn.error.code };
          else {
            const ended = await client.waitForNotification(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === turn.result.turn.id,
              10_000, 'owned configuration failure terminal');
            assert.equal(ended.params.turn.status, 'failed', 'unconfigured/offline execution cannot report model success');
            report.execution = { rejected: false, terminal: ended.params.turn.status, turnId: turn.result.turn.id };
          }
        }
        await request('runtime.context.get');
        await request('runtime.providers.list');
        if (name === 'offline-slow-head') {
          assert.ok(report.executionHttp.some(event => event.method === 'POST' && event.path === '/v1/chat/completions'),
            'the owned 503 execution is observed independently of the pending prewarm HEAD');
        }
      }
      assert.equal(client.exit, null, 'settings remain available after the execution failure');
      report.ok = true;
    } catch (error) {
      report.ok = false;
      report.error = context.redactText(String(error));
    } finally {
      phase = 'cleanup';
      await context.stopOwned(label);
      client.closeReader();
      await closeProvider();
      report.exit = client.exit;
      report.explicitOverlayUnchanged = (await readFile(file)).equals(bytes);
      assert.equal(report.explicitOverlayUnchanged, true, 'the explicit read-only source must not be rewritten');
      await context.writeArtifactJson(`startup-settings-${name}.json`, { binary, binarySha256, platform: process.platform, report });
    }
  }
  await context.writeArtifactJson('startup-settings-cases.json', { binary, binarySha256, platform: process.platform, reports });
  assert.ok(reports.every(report => report.ok), `Native startup settings failures: ${reports.filter(report => !report.ok).map(report => report.name).join(', ')}`);
  return { binarySha256, actualNativeProcesses: cases.length, scenario: false,
    modelRequestsDuringManagement: reports.reduce((total, report) => total + report.modelRequestsDuringManagement, 0),
    nonModelManagementHttpRequests: reports.reduce((total, report) => total + report.providerManagementRequests, 0), platform: process.platform };
});
