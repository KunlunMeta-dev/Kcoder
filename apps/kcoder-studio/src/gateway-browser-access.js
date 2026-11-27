export function hasFullGatewayBrowserAuthority(session, serverIds) {
  return Boolean(
    session?.browserAdmin === true &&
      !session.deviceId &&
      session.allowedServerIds instanceof Set &&
      serverIds.every((id) => session.allowedServerIds.has(id)),
  );
}

export function isGatewayBrowserAdminRequest(request, session, servers, authRequired) {
  return Boolean(
    authRequired &&
      request.headers.authorization === undefined &&
      hasFullGatewayBrowserAuthority(session, servers.map(({ id }) => id)),
  );
}

export function websocketSessionCredential(request) {
  const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
  const carriers = protocols.filter(value => value.startsWith('kcoder-session.'));
  if (!carriers.length) return { id: null, invalid: false };
  // A malformed or duplicated carrier must not fall back to another credential.
  const match = carriers.length === 1 && carriers[0].match(/^kcoder-session\.([A-Za-z0-9-]{32,128})$/);
  return { id: match ? match[1] : null, invalid: !match };
}
