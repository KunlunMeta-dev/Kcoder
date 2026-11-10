// Bounded trusted-parent delivery. Unknown replies retain the original durable
// proof/route; retry never revives a device or changes its revocation identity.
export function createRetentionRevocationPump({ auth, brokerForRoute }) {
  let active = null;
  return {
    drain() {
      if (active) return active;
      active = (async () => {
        // The durable cursor advances before delivery, including failed routes.
        // Restarting the Gateway cannot repeatedly pin the same blocked prefix.
        const jobs = await auth.pendingRetentionRevocations({ limit: 32 });
        for (const job of jobs) {
          try {
            const broker = await brokerForRoute(job.route);
            if (!broker) continue;
            const reply = await broker.revokeRetainedDevice(job);
            const result = reply?.result;
            if (!reply.error && result?.version === 1 && result.revocationId === job.statement.revocationId &&
                result.routeId === job.route.routeId && result.complete === true) await auth.confirmRetentionRevocation(result);
          } catch { /* Original proof stays durable; no authority/source deletion inference. */ }
        }
      })().finally(() => { active = null; });
      return active;
    },
  };
}
