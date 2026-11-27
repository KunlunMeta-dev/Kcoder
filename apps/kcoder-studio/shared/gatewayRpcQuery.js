const fields = new Set(['channel', 'token', 'server', 'workspace', 'channelObserver', 'runtimeObserver']);

/** Connection metadata only; the Gateway separately authenticates and authorizes the target. */
export function isGatewayRpcQuery(params) {
  const seen = new Set();
  for (const [key] of params) {
    if (!fields.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return params.getAll('token').length === 1 && params.get('token')?.length <= 256;
}

/** Use the receiving transport's contract when constructing a connection query. */
export function createGatewayRpcQuery(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new TypeError('Invalid Gateway RPC connection parameters');
    params.set(key, value);
  }
  if (!isGatewayRpcQuery(params)) throw new TypeError('Invalid Gateway RPC connection parameters');
  return params;
}
