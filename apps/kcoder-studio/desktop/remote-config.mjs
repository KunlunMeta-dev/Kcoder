import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";

export const DEFAULT_REMOTE_SERVER_URL = "http://127.0.0.1:4173";
export const DEFAULT_REMOTE_TOKEN = "123";

function argumentValue(argv, name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith(prefix)) return value.slice(prefix.length);
    if (value === `--${name}`) return argv[index + 1];
  }
  return undefined;
}

function normalizeServerUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`无效的 KCoder Studio 服务地址：${value}`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("KCoder Studio 远程客户端只支持 HTTP 或 HTTPS 服务地址");
  }
  if (parsed.username || parsed.password) {
    throw new Error("KCoder Studio 服务地址不能包含用户名或密码");
  }
  if (!parsed.hostname) throw new Error("KCoder Studio 服务地址缺少主机名");
  const route = `${parsed.pathname || "/"}${parsed.search}${parsed.hash}`;
  return {
    origin: parsed.origin,
    initialUrl: new URL(route === "/login" ? "/" : route, parsed.origin).href,
  };
}

export function resolveRemoteClientOptions(env = process.env, argv = process.argv.slice(1)) {
  const configuredUrl =
    argumentValue(argv, "server-url") ||
    env.KCODER_STUDIO_REMOTE_URL ||
    DEFAULT_REMOTE_SERVER_URL;
  const token =
    argumentValue(argv, "token") ||
    env.KCODER_STUDIO_REMOTE_TOKEN ||
    DEFAULT_REMOTE_TOKEN;
  if (!token.trim()) throw new Error("KCoder Studio 远程访问令牌不能为空");
  return {
    ...normalizeServerUrl(configuredUrl),
    token,
  };
}

export function loginRemoteGateway({ origin, token, timeoutMs = 15_000 }) {
  return new Promise((resolveLogin, reject) => {
    const body = new URLSearchParams({ token }).toString();
    const loginUrl = new URL("/login", origin);
    const request = loginUrl.protocol === "https:" ? requestHttps : requestHttp;
    const loginRequest = request(
      loginUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        if (response.statusCode !== 303) {
          reject(
            new Error(
              `KCoder Studio 远程登录失败（HTTP ${response.statusCode ?? "unknown"}）`,
            ),
          );
          return;
        }
        const values = response.headers["set-cookie"] ?? [];
        const cookies = Array.isArray(values) ? values : [values];
        const match = cookies.join("\n").match(/(?:^|\n)kcoder_studio_session=([^;\n]+)/);
        if (!match) {
          reject(new Error("KCoder Studio 服务端没有返回会话 Cookie"));
          return;
        }
        resolveLogin(decodeURIComponent(match[1]));
      },
    );
    loginRequest.once("error", reject);
    loginRequest.setTimeout(timeoutMs, () => {
      loginRequest.destroy(new Error(`连接 KCoder Studio 服务端超时（${timeoutMs}ms）`));
    });
    loginRequest.end(body);
  });
}
