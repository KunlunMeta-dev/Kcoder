import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runE2E, repoRoot, requireExecutable } from '../harness/run-context.mjs';
import { materializeWorkspace } from '../harness/workspace-fixture.mjs';
import { AppServerStdioClient, waitForStdioChildClose } from '../harness/app-server-stdio.mjs';

// Exercise normal startup; the scenario entry bypasses project MCP discovery.
await runE2E(import.meta.url, { testId: 'normal-startup-missing-project-settings-does-not-write', tier: 'full-integration',
  modelPolicy: 'normal Native initialize and idle only; no thread, turn or model request', retainSuccessLogs: true }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'pinned KCoder');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'provider-empty-load' });
  const config = context.pathInState('profile');
  const settings = await context.writeStateJson('profile/settings.json', { active_provider: 'fixture', mcp_servers: [], hooks: {},
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: 'http://127.0.0.1:9/v1', default_model: 'fixture', discover_models: false,
      authentication: { mode: 'none' }, context_window_tokens: 128000, output_headroom_tokens: 4096, max_output_tokens: 2048 } } });
  const environment = context.isolatedEnvironment({ KCODER_CONFIG_DIR: config, XDG_CONFIG_HOME: config });
  const inventory = async () => {
    const directory = join(workspace, '.kcoder');
    let names;
    try { names = await readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.sort().map(async name => {
      const info = await lstat(join(directory, name));
      return { path: '.kcoder/' + name, kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', bytes: info.size };
    }));
  };
  const before = await inventory();
  assert.deepEqual(before, []);
  const doctor = context.spawnOwned('provider-empty-doctor', binary, ['--settings-file', settings, '--cwd', workspace, 'doctor'], { cwd: workspace, env: environment });
  let identity = '';
  doctor.stdout.on('data', bytes => { identity = (identity + bytes).slice(-128 * 1024); });
  assert.equal((await waitForStdioChildClose(doctor, 15000, 'owned doctor')).code, 0);
  const child = context.spawnOwned('provider-empty-native', binary, ['--settings-file', settings, '--cwd', workspace, 'app-server'], { cwd: workspace, env: environment, stdin: 'pipe' });
  const rpc = new AppServerStdioClient('provider-empty-native', child);
  assert.ok((await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'provider-empty-load', version: '1' } })).result);
  const afterInitialize = await inventory();
  const resources = await rpc.request('server/resources/read');
  assert.ok(resources.result?.instanceId);
  const shutdown = await rpc.request('server/shutdown/idle', { instanceId: resources.result.instanceId });
  assert.equal(shutdown.result?.accepted, true);
  const exit = await waitForStdioChildClose(child, 15000, 'owned normal Native');
  const afterShutdown = await inventory();
  const evidence = { binary, binarySha256: sha(await readFile(binary)), probeSourceSha256: sha(await readFile(new URL(import.meta.url))),
    buildCommit: /^build commit: (.+)$/m.exec(identity)?.[1] ?? null, buildDirty: /^build dirty: (.+)$/m.exec(identity)?.[1] ?? null,
    before, afterInitialize, afterShutdown, shutdown: shutdown.result, exit, methods: rpc.methodsSent,
    modelRequests: 0, threadsCreated: 0, scenario: false };
  await context.writeArtifactJson('provider-empty-load.json', evidence);
  assert.equal(exit.code, 0);
  assert.deepEqual(afterInitialize, [], 'normal startup must not materialize a missing project configuration store');
  assert.deepEqual(afterShutdown, [], 'normal idle shutdown must not materialize a missing project configuration store');
  return evidence;
});
