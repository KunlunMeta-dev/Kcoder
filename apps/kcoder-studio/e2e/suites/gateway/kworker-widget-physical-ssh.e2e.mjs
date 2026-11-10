import { delimiter, resolve } from 'node:path';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { startWidgetModelFixture, widgetSettings, exerciseWidgetTarget } from '../../harness/kworker-widget-targets.mjs';
import { startPhysicalWidgetSsh } from '../../harness/physical-widget-ssh.mjs';

await runE2E(import.meta.url, { testId: 'kworker-widget-physical-ssh-nonshared-target-artifacts', tier: 'manual-live',
  modelPolicy: 'model-independent deterministic SSE over owned real SSH reverse forward; current copied Rust binary, no installation or model fees', cleanupTimeoutMs: 15000 }, async context => {
  if (process.env.KCODER_E2E_REMOTE_WIDGET_CONSENT !== '1') throw new Error('UNMET_PREREQUISITE: KCODER_E2E_REMOTE_WIDGET_CONSENT=1 is required');
  const target = process.env.KCODER_E2E_REMOTE_SSH_TARGET; const key = process.env.KCODER_E2E_REMOTE_SSH_KEY; const knownHosts = process.env.KCODER_E2E_REMOTE_KNOWN_HOSTS;
  if (!target || !key || !knownHosts) throw new Error('UNMET_PREREQUISITE: explicit remote SSH target, private-key path and known-hosts path are required');
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'physical-widget-client' });
  const fixture = await startWidgetModelFixture(context);
  const remote = await startPhysicalWidgetSsh(context, { target, key, knownHosts, binary, localProviderPort: Number(new URL(fixture.baseUrl).port) });
  await remote.configure(widgetSettings(remote.providerEndpoint));
  const server = { id: 'physical-widget', label: 'Owned physical SSH widget runtime', transport: 'ssh', host: target.split('@')[1], user: target.split('@')[0], command: `${remote.root}/launcher`, workspace: `${remote.root}/workspace` };
  const serversFile = await context.writeStateJson('servers.json', [server]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { PATH: `${remote.wrapperDir}${delimiter}${process.env.PATH || ''}` } });
  const result = await exerciseWidgetTarget(context, gateway, server.id, await waitForGatewayRpcToken(context, gateway), server.workspace);
  if (fixture.requests.length !== 2) throw new Error(`expected exactly two deterministic Provider calls; received ${fixture.requests.length}`);
  await context.writeArtifactJson('physical-widget-results.json', { result, target, sourceBinarySha256: remote.sha256, nonsharedFilesystem: true, actualSsh: true, sourceReadThroughRpc: true, modelFees: 0, platformScope: 'Linux remote managed widget protocol, no native JS isolation inference' });
  return { passed: true, physicalSsh: true, result };
});
