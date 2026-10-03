const allowedPermissions = new Set(["clipboard-sanitized-write"]);

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
