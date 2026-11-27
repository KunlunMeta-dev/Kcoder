/** An owned static GET may be reread once before the application sent any RPC or action. */
export function mayReloadColdStaticPage({ origin, failures, rpcCount, userActions, reloads }) {
  return rpcCount === 0 && userActions === 0 && reloads === 0 && failures.length > 0 && failures.every(row => {
    try { const url = new URL(row.url); return row.method === 'GET' && row.error === 'net::ERR_NETWORK_CHANGED' &&
      url.origin === origin && url.pathname.startsWith('/assets/'); } catch { return false; }
  });
}
