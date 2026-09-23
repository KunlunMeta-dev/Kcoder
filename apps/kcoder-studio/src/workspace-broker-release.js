export function pendingWorkIdleDelay(idleMs) {
  return Math.max(1_000, idleMs);
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
