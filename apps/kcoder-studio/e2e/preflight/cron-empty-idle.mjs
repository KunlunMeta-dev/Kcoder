import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runE2E, repoRoot, requireExecutable } from '../harness/run-context.mjs';
import { materializeWorkspace } from '../harness/workspace-fixture.mjs';
import { AppServerStdioClient, waitForStdioChildClose } from '../harness/app-server-stdio.mjs';

// Reproduce the existing idle path with no thread, turn, model or scheduled job.
await runE2E(import.meta.url, { testId: 'empty-cron-idle-does-not-create-workspace-state', tier: 'full-integration',
  modelPolicy: 'actual Native idle admission only; no model requests or CronCreate calls', retainSuccessLogs: true }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'pinned KController');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'cron-empty-idle' });
  const config = context.pathInState('profile');
  const settings = await context.writeStateJson('profile/settings.json', { active_provider: 'fixture', mcp_servers: [], hooks: {},
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: 'http://127.0.0.1:9/v1', default_model: 'fixture', discover_models: false,
      authentication: { mode: 'none' }, context_window_tokens: 128000, output_headroom_tokens: 4096, max_output_tokens: 2048 } } });
  const environment = context.isolatedEnvironment({ KCODER_CONFIG_DIR: config, XDG_CONFIG_HOME: config });
  const inventory = async () => {
    const result = [];
    const visit = async (directory, prefix) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const path = join(directory, entry.name), relative = prefix + entry.name, stat = await lstat(path);
        result.push({ path: relative, kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file', bytes: stat.size });
        if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path, relative + '/');
      }
    };
    await visit(join(workspace, '.kcoder'), '.kcoder/');
    return result.sort((a, b) => a.path.localeCompare(b.path));
  };
  const before = await inventory();
  assert.deepEqual(before, []);
  const doctor = context.spawnOwned('cron-idle-doctor', binary, ['--settings-file', settings, '--cwd', workspace, 'doctor'], { cwd: workspace, env: environment });
  let identity = '';
  doctor.stdout.on('data', bytes => { identity = (identity + bytes).slice(-128 * 1024); });
  const doctorExit = await waitForStdioChildClose(doctor, 15000, 'owned doctor');
  assert.equal(doctorExit.code, 0);
  const child = context.spawnOwned('cron-idle-native', binary, ['--settings-file', settings, '--cwd', workspace, 'app-server', '--scenario', 'full-turn'], { cwd: workspace, env: environment, stdin: 'pipe' });
  const rpc = new AppServerStdioClient('cron-idle-native', child);
  const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'cron-empty-idle', version: '1' } });
  assert.ok(initialized.result, 'initialize must succeed');
  const afterInitialize = await inventory();
  const resources = await rpc.request('server/resources/read');
  assert.ok(resources.result?.instanceId);
  const shutdown = await rpc.request('server/shutdown/idle', { instanceId: resources.result.instanceId });
  assert.equal(shutdown.result?.accepted, true);
  const exit = await waitForStdioChildClose(child, 15000, 'owned idle Native');
  const afterShutdown = await inventory();
  const evidence = { binary, binarySha256: sha(await readFile(binary)), probeSourceSha256: sha(await readFile(new URL(import.meta.url))),
    buildCommit: /^build commit: (.+)$/m.exec(identity)?.[1] ?? null, buildDirty: /^build dirty: (.+)$/m.exec(identity)?.[1] ?? null,
    before, afterInitialize, afterShutdown, shutdown: shutdown.result, exit, methods: rpc.methodsSent,
    modelRequests: 0, scheduledJobsCreated: 0 };
  await context.writeArtifactJson('cron-empty-idle.json', evidence);
  assert.equal(exit.code, 0);
  assert.deepEqual(afterShutdown, [], 'idle shutdown without a Cron store must not materialize workspace runtime paths');
  return evidence;
});
