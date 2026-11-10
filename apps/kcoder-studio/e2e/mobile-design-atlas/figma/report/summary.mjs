/** Shared machine-readable summary; no canvas or filesystem side effects. */
export function summarizeSync({ result, bundle, bundlePath, configuration, checkOnly, currentSourceExported }) {
  const updated = result.job.events.filter(event => event.status === 'updated');
  return {
    status: result.job.status,
    sampledStates: bundle.states.length,
    changedStates: checkOnly ? result.job.preflight.changes : new Set(updated.flatMap(event => event.ids)).size,
    batchesApplied: updated.length,
    absentControls: result.job.events.flatMap(event => event.absentControls || []),
    project: configuration.project,
    targetUrl: configuration.url,
    fileKey: configuration.fileKey,
    rootNodeId: bundle.checkpoint.rootNodeId,
    bundlePath,
    modelTurns: 0,
    currentSourceExported,
  };
}
