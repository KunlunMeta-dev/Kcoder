import { runE2E, repoRoot } from '../../../harness/run-context.mjs';
import { connectFigmaSync } from './codex.mjs';
import { loadFigmaConfiguration, readFigmaTarget } from '../config.mjs';
import { decodeSyncResult } from '../sync/job.mjs';

export async function checkFigmaConnection(sourceUrl) {
  const configuration = await loadFigmaConfiguration(repoRoot);
  await readFigmaTarget(configuration);
  return runE2E(sourceUrl, { testId: 'figma-sync-connect-check', tier: 'manual-live', retainSuccessLogs: true,
    modelPolicy: 'Read-only existing Figma MCP capability discovery using an owned ephemeral RPC context; no model turn or credential extraction' }, async run => {
    const { environment } = configuration;
    const mcp = await connectFigmaSync(run, { server: environment.KCODER_FIGMA_MCP_SERVER, command: environment.KCODER_FIGMA_CODEX_BIN });
    const session = decodeSyncResult(await mcp.call('create_session', { fileKey: configuration.fileKey, description: 'Read-only verification of the deterministic KCoder sync client' }));
    await run.writeArtifactJson('connection.json', { project: configuration.project, server: mcp.server, fileKey: configuration.fileKey, sessionId: session.sessionId, modelTurns: 0 });
    return { connected: true, server: mcp.server, modelTurns: 0 };
  });
}
