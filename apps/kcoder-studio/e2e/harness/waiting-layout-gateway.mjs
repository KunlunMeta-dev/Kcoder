import { startGateway } from './gateway.mjs';
import { runE2E } from './run-context.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';

/** Run the real renderer against the isolated Gateway's in-memory protocol fixture. */
export async function withWaitingLayoutGateway(run) {
  return runE2E(import.meta.url, {
    testId: 'new-conversation-waiting-layout', tier: 'full-integration',
    modelPolicy: 'Isolated mock Gateway and actual renderer; no user profile, model or external request.',
  }, async context => {
    const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'waiting-layout' });
    const serversFile = await context.writeStateJson('waiting-layout-servers.json', [{
      id: 'local', label: 'Waiting fixture', transport: 'local', command: process.execPath, workspace,
    }]);
    const gateway = await startGateway(context, { label: 'waiting-layout-gateway', workspace, serversFile,
      env: { KCODER_STUDIO_MOCK: '1' } });
    return run({ baseUrl: gateway.baseUrl,
      writePositions: positions => context.writeArtifactJson('waiting-positions.json', { positions }) });
  });
}
