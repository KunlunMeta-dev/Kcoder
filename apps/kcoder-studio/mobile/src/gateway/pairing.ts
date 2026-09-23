export interface ParsedPairingLink {
  gateway: string;
  token: string;
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
    return `/connect?gateway=${encodeURIComponent(pairing.gateway)}&token=${encodeURIComponent(pairing.token)}`;
  } catch {
    return "/welcome?pairingError=invalid";
  }
}
