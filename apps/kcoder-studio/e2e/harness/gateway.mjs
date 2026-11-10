import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appRoot, repoRoot, waitFor } from "./run-context.mjs";
import { captureOwnedRedactedStderr } from "./owned-redacted-stderr.mjs";

export async function startGateway(context, options = {}) {
  if (options.uid !== undefined || options.gid !== undefined) {
    if (process.platform !== 'linux' || !Number.isSafeInteger(options.uid) || options.uid <= 0
      || !Number.isSafeInteger(options.gid) || options.gid < 0) throw new Error('Invalid isolated Gateway UID/GID');
  }
  const label = options.label || "gateway";
  const host = options.host || "127.0.0.1";
  const hasGatewayLocation = options.gatewayRoot !== undefined || options.cwd !== undefined;
  const gatewayRoot = resolve(options.gatewayRoot || appRoot);
  const cwd = resolve(options.cwd || gatewayRoot);
  const scriptPath = resolve(gatewayRoot, "dev-server.mjs");
  const authToken = options.authToken ?? (options.auth ? randomBytes(24).toString("base64url") : "");
  if (authToken) context.registerSecret(authToken);
  const overrides = {
    NODE_ENV: 'test',
    KCODER_STUDIO_HOST: host,
    KCODER_STUDIO_PORT: String(options.port ?? 0),
    KCODER_STUDIO_KCODER_BIN: options.kcoderBin || process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"),
    KCODER_STUDIO_WORKSPACE: options.workspace,
    KCODER_STUDIO_WEB_ROOT: process.env.KCODER_E2E_RENDERER_ROOT,
    KCODER_STUDIO_SERVERS_FILE: options.serversFile,
    KCODER_STUDIO_SERVERS_STORE: options.serversStore,
    KCODER_STUDIO_AUTH_TOKEN: authToken,
    KCODER_STUDIO_TEST_DISABLE_AUTH: authToken ? '' : '1',
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
  if (options.dropSteerReply) {
    env.KCODER_E2E_DROP_STEER_REPLY = '1';
    env.KCODER_E2E_STEER_REPLY_FAULT_EVIDENCE = context.pathInArtifacts('steer-reply-fault.json');
  }
  if (options.delayCancelReply) {
    env.KCODER_E2E_DELAY_CANCEL_REPLY = '1';
    env.KCODER_E2E_CANCEL_REPLY_EVIDENCE = context.pathInArtifacts('cancel-reply-fault.json');
  }
  if (options.delayWorkspaceFileReply) {
    env.KCODER_E2E_DELAY_WORKSPACE_FILE_REPLY = '1';
    env.KCODER_E2E_WORKSPACE_FILE_REPLY_EVIDENCE = context.pathInArtifacts('workspace-file-reply-delay.json');
    env.KCODER_E2E_WORKSPACE_FILE_REPLY_RELEASE = context.pathInArtifacts('workspace-file-reply-release');
  }
  if (options.uiReceiptFault) {
    env.KCODER_E2E_UI_RECEIPT_FAULT = '1';
    env.KCODER_E2E_UI_RECEIPT_DIRECTORY = context.artifactsDir;
  }
  if (options.nativeRemoteDisconnectFault) {
    env.KCODER_E2E_NATIVE_REMOTE_DISCONNECT = '1';
    env.KCODER_E2E_NATIVE_REMOTE_DISCONNECT_KIND = options.nativeRemoteDisconnectFault.kind || 'completion';
    env.KCODER_E2E_NATIVE_REMOTE_DISCONNECT_DIRECTORY = options.nativeRemoteDisconnectFault.directory;
  }
  const nodeArgs = [
    ...(options.dropSaveReply ? ['--import', resolve(appRoot, 'e2e/harness/save-reply-fault.mjs')] : []),
    ...(options.dropSteerReply ? ['--import', resolve(appRoot, 'e2e/harness/steer-reply-fault.mjs')] : []),
    ...(options.delayCancelReply ? ['--import', resolve(appRoot, 'e2e/harness/cancel-reply-fault.mjs')] : []),
    ...(options.delayWorkspaceFileReply ? ['--import', resolve(appRoot, 'e2e/harness/workspace-file-reply-delay.mjs')] : []),
    ...(options.uiReceiptFault ? ['--import', resolve(appRoot, 'e2e/harness/ui-receipt-fault.mjs')] : []),
    ...(options.nativeRemoteDisconnectFault ? ['--import', resolve(appRoot, 'e2e/harness/remote-native-disconnect-fault.mjs')] : []),
    hasGatewayLocation ? scriptPath : 'dev-server.mjs',
  ];
  const child = context.spawnOwned(label, process.execPath, nodeArgs, {
    cwd,
    env,
    ...(options.uid === undefined ? {} : { uid: options.uid, gid: options.gid }),
  });
  // Subscribe before the first await so preload diagnostics cannot precede the owned capture.
  const stderrDiagnostics = options.redactedStderrDiagnostics
    ? captureOwnedRedactedStderr(context, label, options.redactedStderrDiagnostics === true ? {} : options.redactedStderrDiagnostics)
    : null;
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
    gatewayRoot,
    cwd,
    scriptPath,
    scriptArgIndex: nodeArgs.length,
    stderrDiagnostics,
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
