import { chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { startWidgetModelFixture, widgetSettings, exerciseWidgetTarget } from '../../harness/kworker-widget-targets.mjs';

await runE2E(import.meta.url, { testId: 'kworker-widget-local-http-loopback-ssh-target-contract', tier: 'full-integration',
  modelPolicy: 'model-independent real SSE, local HTTP Gateway, owned real loopback SSH and Rust app-server; no model-quality claim' }, async context => {
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'widget-targets' });
  const fixture = await startWidgetModelFixture(context); const ssh = await startSshFixture(context);
  const targets = [];
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  for (const id of ['local', 'ssh']) {
    const profile = context.pathInState(id, 'config'); const settings = await context.writeStateJson(`${id}/config/settings.json`, widgetSettings(fixture.baseUrl));
    const wrapper = context.pathInState(id, 'kcoder');
    await writeFile(wrapper, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(profile)}\nexport XDG_CONFIG_HOME=${quote(profile)}\nexec ${quote(binary)} --settings-file ${quote(settings)} "$@"\n`, { mode: 0o700 }); await chmod(wrapper, 0o700);
    targets.push({ id, label: `Owned widget ${id}`, transport: id === 'ssh' ? 'ssh' : 'local', command: wrapper, workspace, ...(id === 'ssh' ? { host: '127.0.0.1', user: ssh.user, port: ssh.port } : {}) });
  }
  const serversFile = await context.writeStateJson('servers.json', targets);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: ssh.gatewayEnv }); const token = await waitForGatewayRpcToken(context, gateway);
  const results = [];
  for (const target of targets) results.push(await exerciseWidgetTarget(context, gateway, target.id, token, workspace));
  if (fixture.requests.length !== 4) throw new Error(`expected exactly four deterministic Provider requests; received ${fixture.requests.length}`);
  await context.writeArtifactJson('widget-target-results.json', { results, actualLoopbackSsh: true, httpGateway: true, deterministicProviderRequests: fixture.requests.length, platformScope: 'managed widget RPC only, no native JS isolation inference' });
  return { passed: true, results };
});
