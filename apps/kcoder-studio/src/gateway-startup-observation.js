// Startup timings only. Operations retain their original verification and results.
const phases = new Set(['office_resources', 'channel_resources', 'component_image',
  'server_configuration', 'browser_sessions', 'account_credentials', 'resource_policy']);

export function createGatewayStartupObservation({
  now = () => performance.now(), uptime = () => process.uptime() * 1000,
  emit = record => console.warn(JSON.stringify(record)),
} = {}) {
  const report = (phase, status, elapsed) => {
    const elapsedMs = Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0;
    try { emit({ event: 'gateway-startup', phase, status, elapsedMs }); } catch { /* Diagnostics cannot replace the original outcome. */ }
  };
  report('module_imports', 'completed', uptime());
  return Object.freeze({
    async run(phase, operation) {
      if (!phases.has(phase)) throw new Error('Unknown Gateway startup phase');
      const start = now();
      report(phase, 'started', 0);
      try {
        const result = await operation();
        report(phase, 'completed', now() - start);
        return result;
      } catch (error) {
        report(phase, 'failed', now() - start);
        throw error;
      }
    },
  });
}
