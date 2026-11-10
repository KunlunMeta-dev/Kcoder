import {
  canonicalGatewayConnectionUrl,
  parseGatewayConnectionRoutes,
  type GatewayConnectionRoutes,
} from "../../../shared/gatewayConnectionRoutes.js";

export const MAX_PAIRING_LINK_LENGTH = 8192;

export interface ParsedPairingLink {
  gateway: string;
  token: string;
  connectionRoutes?: GatewayConnectionRoutes;
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

function canonicalGatewayCandidate(gateway: string): string | undefined {
  const rawPath = gateway.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i)?.[1] ?? "";
  const hasUnsafeSegment = rawPath.split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === ".." || /[\\/]/.test(decoded);
    } catch {
      return true;
    }
  });

  return hasUnsafeSegment ? undefined : canonicalGatewayConnectionUrl(gateway);
}

function parseRoutesQuery(value: string): GatewayConnectionRoutes | undefined {
  try {
    return parseGatewayConnectionRoutes(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

export function parsePairingLink(rawValue: string): ParsedPairingLink {
  const raw = rawValue.trim();
  if (!raw) throw new Error("请先粘贴 KCoder 配对链接");
  if (rawValue.length > MAX_PAIRING_LINK_LENGTH) throw new Error("配对链接过长");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("配对链接格式无效");
  }
  if (url.protocol !== "kcoder-studio:" && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("不是有效的 KCoder 配对链接");
  }
  const gateways = url.searchParams.getAll("gateway");
  const urls = url.searchParams.getAll("url");
  if (gateways.length + urls.length !== 1) throw new Error("配对链接中的 Gateway 地址无效");
  const gateway = (gateways[0] ?? urls[0] ?? "").trim();
  const tokens = url.searchParams.getAll("token");
  if (!gateway || tokens.length !== 1 || !tokens[0]) throw new Error("配对链接缺少 gateway 或 token");
  const gatewayIds = url.searchParams.getAll("gatewayId");
  if (gatewayIds.length > 1) {
    throw new Error("配对链接中的 Gateway ID 无效");
  }
  if (gatewayIds.length === 1) validateGatewayRoute(gateway, gatewayIds[0]!);

  const routesValues = url.searchParams.getAll("routes");
  if (routesValues.length > 1) throw new Error("配对链接中的连接路由无效");
  let connectionRoutes: GatewayConnectionRoutes | undefined;
  if (routesValues.length === 1) {
    connectionRoutes = parseRoutesQuery(routesValues[0]!);
    const candidate = canonicalGatewayCandidate(gateway);
    if (!connectionRoutes || !candidate || !connectionRoutes.endpoints.some((endpoint) => endpoint.url === candidate)) {
      throw new Error("配对链接中的连接路由与 Gateway 地址不一致");
    }
  }

  return { gateway, token: tokens[0]!, ...(connectionRoutes ? { connectionRoutes } : {}) };
}

/** Normalize validated camera, pasted and native-link payloads into the same in-app connection route. */
export function pairingRouteFromLink(rawValue: string): string {
  const pairing = parsePairingLink(rawValue);
  const url = new URL(rawValue.trim());
  const gatewayId = url.searchParams.get("gatewayId");
  const metadata = gatewayId === null ? "" : `&gatewayId=${encodeURIComponent(gatewayId)}`;
  const routes = pairing.connectionRoutes
    ? `&routes=${encodeURIComponent(JSON.stringify(pairing.connectionRoutes))}`
    : "";
  return `/connect?gateway=${encodeURIComponent(pairing.gateway)}&token=${encodeURIComponent(pairing.token)}${metadata}${routes}`;
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
    return pairingRouteFromLink(url.toString());
  } catch {
    return "/welcome?pairingError=invalid";
  }
}
