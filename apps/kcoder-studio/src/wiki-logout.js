/** Pause durable Wiki jobs before removing the authenticated target connection.
 * A network disconnect intentionally does not run this explicit logout action.
 */
export async function pauseWikiBeforeLogout(broker, { timeoutMs = 10000 } = {}) {
  let timer;
  let settle;
  let reject;
  const completion = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
  const fail = () => reject(new Error('Wiki logout pause was not confirmed by the target'));
  const client = {
    channel: 'runtime',
    send(message) {
      if (message.id === 1) {
        if (message.error) { fail(); return true; }
        const capabilities = message.result?.capabilities?.experimental;
        // Older targets cannot have durable Wiki jobs from this protocol.
        if (!capabilities?.knowledgeIngestV1) { settle(); return true; }
        broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 2,
          method: 'knowledge/job/pauseAll', params: {} }));
      } else if (message.id === 2) {
        if (message.error || !Number.isInteger(message.result?.pausedJobs)) fail();
        else settle();
      } else if (['server/transportError', 'server/disconnected'].includes(message.method)) fail();
      return true;
    },
    pause() {}, resume() {}, close: fail,
  };
  broker.attach(client);
  try {
    timer = setTimeout(fail, timeoutMs);
    broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2026-07-27',
        clientInfo: { name: 'kcoder-studio-wiki-logout', version: '1' } } }));
    await completion;
  } finally {
    clearTimeout(timer);
    broker.detach(client);
  }
}
