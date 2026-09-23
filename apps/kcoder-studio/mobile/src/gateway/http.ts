import type {
  GatewayProfile,
  KCoderServer,
  KCoderServerDraft,
  ServerStatus,
} from "./types";

export class GatewaySessionExpiredError extends Error {
  constructor() {
    super("Gateway 会话已失效，请重新授权");
    this.name = "GatewaySessionExpiredError";
  }
}

function normalizedBaseUrl(value: string, allowHttp = true): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("请输入 Gateway 地址");
  const withScheme = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `${allowHttp ? "http" : "https"}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Gateway 地址格式无效，请输入例如 http://127.0.0.1:4173");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Gateway 地址只支持 http:// 或 https://");
  }
  if (parsed.protocol === "http:" && !allowHttp) {
    throw new Error(
      "此构建只允许 HTTPS Gateway；开发内网调试需同时启用 KCODER_STUDIO_ALLOW_HTTP=1 和 EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP=1",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string") return payload.error;
  } catch {
    // Fall back to generic status text for non-JSON errors.
  }
  return `${response.status} ${response.statusText}`.trim();
}

export async function exchangeMobileSession(
  rawBaseUrl: string,
  token: string,
  label?: string,
): Promise<GatewayProfile> {
  const allowHttp =
    typeof document !== "undefined" ||
    process.env.EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP === "1";
  const baseUrl = normalizedBaseUrl(rawBaseUrl, allowHttp);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/mobile/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    throw new Error("无法访问 Gateway，请检查地址、网络和防火墙设置");
  }
  if (!response.ok) throw new Error(`连接失败：${await readError(response)}`);
  const payload = (await response.json()) as {
    accessToken?: unknown;
    expiresAt?: unknown;
    rpcToken?: unknown;
  };
  if (
    typeof payload.accessToken !== "string" ||
    typeof payload.expiresAt !== "number"
  ) {
    throw new Error("Gateway 返回了无效的移动会话");
  }
  const gatewayId = new URL(baseUrl).host.replace(/[^A-Za-z0-9._-]/g, "-");
  return {
    id: `${gatewayId}-${Date.now().toString(36)}`,
    label: label?.trim() || new URL(baseUrl).host,
    baseUrl,
    accessToken: payload.accessToken,
    expiresAt: payload.expiresAt,
    rpcToken:
      typeof payload.rpcToken === "string" ? payload.rpcToken : "cookie-auth",
  };
}

export async function gatewayRequest<T>(
  profile: GatewayProfile,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${profile.accessToken}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${profile.baseUrl}${path}`, {
    ...init,
    headers,
  });
  if (response.status === 401) throw new GatewaySessionExpiredError();
  if (!response.ok) throw new Error(await readError(response));
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listServers(
  profile: GatewayProfile,
): Promise<KCoderServer[]> {
  const payload = await gatewayRequest<{ servers?: KCoderServer[] }>(
    profile,
    "/api/servers",
  );
  return Array.isArray(payload.servers) ? payload.servers : [];
}

export async function listServerStatuses(
  profile: GatewayProfile,
): Promise<ServerStatus[]> {
  const payload = await gatewayRequest<{ statuses?: ServerStatus[] }>(
    profile,
    "/api/servers/status",
  );
  return Array.isArray(payload.statuses) ? payload.statuses : [];
}

export async function testServer(
  profile: GatewayProfile,
  draft: KCoderServerDraft,
): Promise<{ ok: boolean; error?: string }> {
  return gatewayRequest(profile, "/api/servers/test", {
    method: "POST",
    body: JSON.stringify(draft),
  });
}

export async function saveServer(
  profile: GatewayProfile,
  draft: KCoderServerDraft,
): Promise<KCoderServer> {
  const result = await gatewayRequest<{ server: KCoderServer }>(
    profile,
    `/api/servers/${encodeURIComponent(draft.id)}`,
    { method: "PUT", body: JSON.stringify(draft) },
  );
  return result.server;
}

export async function deleteServer(
  profile: GatewayProfile,
  id: string,
): Promise<void> {
  await gatewayRequest(profile, `/api/servers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: "{}",
  });
}

export async function revokeMobileSession(
  profile: GatewayProfile,
): Promise<void> {
  await gatewayRequest<void>(profile, "/api/mobile/session", {
    method: "DELETE",
  });
}

export { normalizedBaseUrl };
