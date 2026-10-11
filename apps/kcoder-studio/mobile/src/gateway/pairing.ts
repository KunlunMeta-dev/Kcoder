export interface ParsedPairingLink {
  gateway: string;
  token: string;
}

function validateGatewayRoute(gateway: string, gatewayId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(gatewayId)) {
    throw new Error("配对链接中的 Gateway ID 与地址路径不一致");
  }

  const rawPath = gateway.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i)?.[1] ?? "";
  const hasUnsafeSegment = rawPath.split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === ".." || /[\\/]/.test(decoded);
    } catch {
      return true;
    }
  });

  let gatewayUrl: URL;
  try {
    gatewayUrl = new URL(gateway);
  } catch {
    throw new Error("配对链接中的 Gateway 地址无效");
  }
  if (
    hasUnsafeSegment ||
    (gatewayUrl.protocol !== "http:" && gatewayUrl.protocol !== "https:") ||
    gatewayUrl.username ||
    gatewayUrl.password ||
    gatewayUrl.search ||
    gatewayUrl.hash ||
    gatewayUrl.pathname !== `/g/${gatewayId}`
  ) {
    throw new Error("配对链接中的 Gateway ID 与地址路径不一致");
  }
}

export function parsePairingLink(rawValue: string): ParsedPairingLink {
  const raw = rawValue.trim();
  if (!raw) throw new Error("请先粘贴 KCoder 配对链接");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("配对链接格式无效");
  }
  if (url.protocol !== "kcoder-studio:" && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("不是有效的 KCoder 配对链接");
  }
  const gateway = url.searchParams.get("gateway") ?? url.searchParams.get("url");
  const token = url.searchParams.get("token");
  if (!gateway || !token) throw new Error("配对链接缺少 gateway 或 token");
  const gatewayIds = url.searchParams.getAll("gatewayId");
  if (gatewayIds.length > 1) {
    throw new Error("配对链接中的 Gateway ID 无效");
  }
  if (gatewayIds.length === 1) validateGatewayRoute(gateway, gatewayIds[0]!);
  return { gateway, token };
}

export function pairingRouteFromSystemPath(path: string): string {
  try {
    const normalized = path.includes("://")
      ? path
      : `kcoder-studio://${path.replace(/^\/+/, "")}`;
    const url = new URL(normalized);
    const isConnectRoute = url.protocol === "kcoder-studio:" && (
      url.hostname === "connect" || url.pathname.replace(/^\/+/, "") === "connect"
    );
    if (!isConnectRoute) return path;
    const pairing = parsePairingLink(url.toString());
    const gatewayId = url.searchParams.get("gatewayId");
    const metadata = gatewayId === null ? "" : `&gatewayId=${encodeURIComponent(gatewayId)}`;
    return `/connect?gateway=${encodeURIComponent(pairing.gateway)}&token=${encodeURIComponent(pairing.token)}${metadata}`;
  } catch {
    return "/welcome?pairingError=invalid";
  }
}
