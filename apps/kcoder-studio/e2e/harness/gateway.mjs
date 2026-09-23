import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appRoot, repoRoot, waitFor } from "./run-context.mjs";

export async function startGateway(context, options = {}) {
  const label = options.label || "gateway";
  const host = options.host || "127.0.0.1";
  const authToken = options.authToken ?? (options.auth ? randomBytes(24).toString("base64url") : "");
  if (authToken) context.registerSecret(authToken);
  const overrides = {
    KCODER_STUDIO_HOST: host,
    KCODER_STUDIO_PORT: String(options.port ?? 0),
    KCODER_STUDIO_KCODER_BIN: options.kcoderBin || resolve(repoRoot, "target/debug/kcoder"),
    KCODER_STUDIO_WORKSPACE: options.workspace,
    KCODER_STUDIO_WEB_ROOT: process.env.KCODER_E2E_RENDERER_ROOT,
    KCODER_STUDIO_SERVERS_FILE: options.serversFile,
    KCODER_STUDIO_SERVERS_STORE: options.serversStore,
    KCODER_STUDIO_AUTH_TOKEN: authToken,
    KCODER_STUDIO_ALLOWED_HOSTS: options.allowedHosts || "127.0.0.1,localhost,::1",
    ...options.env,
  };
  for (const [name, value] of Object.entries(options.env || {})) {
    if (/(?:api[_-]?key|auth(?:entication)?[_-]?token|secret|password|credential|token(?!s))/i.test(name)
      && value) {
      context.registerSecret(String(value));
    }
  }
  const env = context.isolatedEnvironment(overrides, options.passEnv || []);
  if (options.dropSaveReply) {
    env.KCODER_E2E_DROP_SAVE_REPLY = '1';
    env.KCODER_E2E_SAVE_REPLY_FAULT_EVIDENCE = context.pathInArtifacts('save-reply-fault.json');
  }
  if (options.delayCancelReply) {
    env.KCODER_E2E_DELAY_CANCEL_REPLY = '1';
    env.KCODER_E2E_CANCEL_REPLY_EVIDENCE = context.pathInArtifacts('cancel-reply-fault.json');
  }
  const nodeArgs = [
    ...(options.dropSaveReply ? ['--import', resolve(appRoot, 'e2e/harness/save-reply-fault.mjs')] : []),
    ...(options.delayCancelReply ? ['--import', resolve(appRoot, 'e2e/harness/cancel-reply-fault.mjs')] : []),
    'dev-server.mjs',
  ];
  const child = context.spawnOwned(label, process.execPath, nodeArgs, {
    cwd: appRoot,
    env,
  });
  const logPath = resolve(context.logsDir, `${safeSlug(label)}.log`);
  const port = await waitFor(async () => {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const match = log.match(/KCoder Studio: http:\/\/[^:]+:(\d+)/);
    if (child.exitCode !== null) throw new Error(`gateway exited with code ${child.exitCode}; inspect ${logPath}`);
    return match ? Number(match[1]) : null;
  }, options.startTimeoutMs || 15_000, "gateway startup", 50, context.abortSignal);
  context.registerPort(label, port);
  return {
    child,
    port,
    host,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    authToken,
    logPath,
  };
}

export async function waitForGatewayRpcToken(context, gateway, options = {}) {
  const token = await waitFor(async () => {
    const response = await fetch(gateway.baseUrl, {
      redirect: "manual",
      headers: { accept: "text/html", ...options.headers },
    }).catch(() => null);
    if (!response || response.status !== 200) return null;
    const html = await response.text();
    const value = html.match(/name="kcoder-rpc-token" content="([^"]+)"/)?.[1];
    if (!value || (options.expectedToken && value !== options.expectedToken)) return null;
    return value;
  }, options.timeoutMs || 15_000, "gateway HTTP readiness and RPC token injection", 50, context.abortSignal);
  context.registerSecret(token);
  return token;
}

function safeSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "gateway";
}
