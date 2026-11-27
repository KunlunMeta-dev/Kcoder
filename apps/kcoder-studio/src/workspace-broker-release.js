export function pendingWorkIdleDelay(idleMs) {
  return Math.max(1_000, idleMs);
}

// Duplicate processes may retain the same session lease after a client leaves.
// Only accelerate the existing guarded idle shutdown for the same owner/target.
export function workspaceIdleDelay(brokers, broker, delayMs, expediteDuplicates = true) {
  if (!expediteDuplicates) return delayMs;
  const hasPeer = [...brokers].some(peer => peer !== broker && !peer.closed &&
    !peer.idleShutdown?.closing && !peer.restartAdmissionRetired && !peer.restartRequest &&
    peer.targetId === broker.targetId && peer.loginOwner === broker.loginOwner);
  return hasPeer ? Math.min(delayMs, 250) : delayMs;
}

/** Schedule only this broker's guarded idle transition. */
export function scheduleBrokerIdle(key, broker, delay, expediteDuplicates, { registry, idleMs, remove, schedule }) {
  if (broker.child.ownsOidcSessionAuthority && !broker.closed) return;
  if (broker.idleTimer) clearTimeout(broker.idleTimer);
  broker.idleTimer = null;
  if (broker.clientCount !== 0 || broker.closed || broker.idleShutdown.closing || broker.hasLiveTerminals || broker.hasProjectAutomations) return;
  delay = workspaceIdleDelay(registry.get(key) ?? [], broker, delay, expediteDuplicates);
  broker.idleTimer = setTimeout(() => {
    broker.idleTimer = null;
    if (broker.clientCount !== 0 || broker.closed || broker.hasLiveTerminals || broker.hasProjectAutomations) return;
    if (broker.hasProtectedIdleResources) {
      schedule(key, broker, pendingWorkIdleDelay(idleMs), false);
      return;
    }
    void broker.stopWhenIdle().then(result => {
      const summary = JSON.stringify({ event: 'broker-idle-shutdown', ...result });
      if (broker.lastIdleShutdownSummary !== summary) {
        broker.lastIdleShutdownSummary = summary;
        process.stderr.write(`${summary}\n`);
      }
      if (result.status === 'stopped') remove(key, broker);
      else if (!broker.closed && !broker.idleShutdown.closing)
        schedule(key, broker, pendingWorkIdleDelay(idleMs), false);
    });
  }, delay);
  broker.idleTimer.unref?.();
}

export async function releaseIdleBrokers(brokers, {
  remove,
  stop = broker => broker.stopWhenIdle(),
  now = Date.now,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  const busyBrokers = () => brokers.filter(broker =>
    broker.clientCount !== 0 || broker.hasLiveTerminals || broker.hasProjectAutomations || broker.hasPendingWork || broker.hasProtectedIdleResources);
  const deadline = now() + 1_000;
  let busy = busyBrokers();
  // Allow in-flight WebSocket close events to settle, without releasing any
  // member of the group while another member still owns protected work.
  while (busy.length > 0 && now() < deadline) {
    await wait(25);
    busy = busyBrokers();
  }
  if (busy.length > 0) {
    const clients = busy.reduce((count, broker) => count + broker.clientCount, 0);
    const terminals = busy.filter(broker => broker.hasLiveTerminals).length;
    const automations = busy.filter(broker => broker.hasProjectAutomations).length;
    const pending = busy.filter(broker => broker.hasPendingWork).length;
    throw new Error(`workspace is active in another client, terminal, automation or pending request (clients=${clients}, terminalBrokers=${terminals}, automationBrokers=${automations}, pendingBrokers=${pending})`);
  }
  const results = await Promise.all(brokers.map(broker => stop(broker)));
  for (let index = 0; index < brokers.length; index++) {
    if (results[index]?.status === 'stopped') remove(brokers[index]);
  }
  if (results.some(result => result?.status !== 'stopped'))
    throw new Error('workspace release was not confirmed; active or unsupported backends were not force-terminated');
  return { released: true, releasedCount: brokers.length };
}


/** Retire only future admission; existing clients and protected work keep their owners. */
export function retireRestartScopeAdmissions(registry, scopeKey, { targetId, loginOwner }) {
  let count = 0;
  for (const broker of registry.get(scopeKey) ?? []) {
    if (broker.targetId !== targetId || broker.loginOwner !== loginOwner || broker.closed) continue;
    broker.retireAdmissionForRestart();
    count++;
  }
  return count;
}
