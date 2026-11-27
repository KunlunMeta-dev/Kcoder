const allowedPermissions = new Set(["clipboard-sanitized-write"]);

// Navigation and server redirects share the same exact-origin boundary. Only
// ordinary web links may be handed to the OS; a failed handoff owns no retry.
export function attachTrustedNavigation({ webContents, getGatewayOrigin, shell, warn = () => {} }) {
  const external = value => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin === getGatewayOrigin()) return;
      Promise.resolve(shell.openExternal(url.href)).catch(() => warn('DESKTOP_EXTERNAL_OPEN_FAILED'));
    } catch { /* Invalid URLs never leave the app. */ }
  };
  webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  const navigate = (event, legacyUrl) => {
    const url = legacyUrl ?? event.url;
    if (isTrustedGatewayUrl(url, getGatewayOrigin())) return;
    event.preventDefault();
    external(url);
  };
  webContents.on('will-navigate', navigate);
  webContents.on('will-redirect', navigate);
}

export function isTrustedGatewayUrl(value, gatewayOrigin) {
  try {
    return new URL(value).origin === gatewayOrigin;
  } catch {
    return false;
  }
}

export function allowRendererPermission({ permission, requestingUrl, gatewayOrigin, webContentsId, expectedWebContentsId }) {
  return (
    allowedPermissions.has(permission) &&
    webContentsId === expectedWebContentsId &&
    isTrustedGatewayUrl(requestingUrl, gatewayOrigin)
  );
}
