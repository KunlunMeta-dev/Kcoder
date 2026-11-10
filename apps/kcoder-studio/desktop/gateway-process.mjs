import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayChildEnv, validateDesktopAuthToken } from "./gateway-env.mjs";
import { gatewayStartupExitError } from './gateway-startup-failure.mjs';
import { studioDataDirectory } from '../src/studio-login-link.js';

const studioRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function gatewayLogin(baseUrl, token, timeoutMs, currentCookie) {
  const startedAt = performance.now();
  return new Promise((resolveLogin, reject) => {
    const body = new URLSearchParams({ token, ...(currentCookie ? { renewSession: "1" } : {}) }).toString();
    const requestUrl = new URL("/login", baseUrl);
    const loginRequest = request(
      requestUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
          ...(currentCookie ? { cookie: `kcoder_studio_session=${encodeURIComponent(currentCookie)}` } : {}),
        },
      },
      (response) => {
        response.resume();
        if (response.statusCode !== 303) {
          reject(new Error(`KCoder Studio desktop login failed with HTTP ${response.statusCode ?? "unknown"}`));
          return;
        }
        const values = response.headers["set-cookie"] ?? [];
        const cookies = Array.isArray(values) ? values : [values];
        const match = cookies.join("\n").match(/(?:^|\n)kcoder_studio_session=([^;\n]+)/);
        if (!match) {
          reject(new Error("KCoder Studio desktop login did not return a session cookie"));
          return;
        }
        const ttl = Number(response.headers["x-kcoder-session-ttl-ms"]);
        resolveLogin({ cookieValue: decodeURIComponent(match[1]), elapsedMs: Math.ceil(performance.now() - startedAt),
          ttlMs: Number.isFinite(ttl) && ttl >= 100 ? ttl : 12 * 60 * 60 * 1000 });
      },
    );
    loginRequest.once("error", reject);
    loginRequest.setTimeout(timeoutMs, () => {
      loginRequest.destroy(new Error(`KCoder Studio desktop login timed out after ${timeoutMs}ms`));
    });
    loginRequest.end(body);
  });
}

async function stopChild(child, graceMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => true);
  child.kill("SIGTERM");
  const timeout = new Promise((resolveTimeout) => {
    const timer = setTimeout(() => resolveTimeout(false), graceMs);
    timer.unref?.();
  });
  if (await Promise.race([exited, timeout])) return;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited.catch(() => {});
}

export async function startGateway(options = {}) {
  const signal = options.signal;
  if (signal?.aborted) throw new Error('KCoder Studio gateway startup cancelled');
  const env = createGatewayChildEnv({ ...process.env, ...(options.env ?? {}) });
  // The Gateway now owns Relay startup. Only the Desktop owner's explicit inputs cross this boundary.
  for (const name of ['KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE', 'KCODER_STUDIO_DESKTOP_RELAY_REGISTRATION_KEY']) {
    if (typeof options.env?.[name] === 'string') env[name] = options.env[name];
  }
  // Ambient/user env never supplies this native producer's private configuration.
  for (const name of Object.keys(env)) {
    if (["KCODER_NATIVE_OFFICE_BINDING_V1","KCODER_NATIVE_CONNECTIVITY_BINDING_V1","KCODER_NATIVE_COMPONENT_IMAGE_BINDING_V1"].includes(name.toUpperCase())) delete env[name];
  }
  if (options.privateEnvironment !== undefined) {
    const entries = Object.entries(options.privateEnvironment);
    if (entries.some(([name, value]) => !["KCODER_NATIVE_CONNECTIVITY_BINDING_V1","KCODER_NATIVE_COMPONENT_IMAGE_BINDING_V1"].includes(name) || typeof value !== "string" || value.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error("Invalid native private environment");
    Object.assign(env, options.privateEnvironment);
  }
  const token = options.token === undefined || options.token === null
    ? randomBytes(32).toString("base64url")
    : validateDesktopAuthToken(options.token);
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const gatewayScript = options.gatewayScript ?? resolve(studioRoot, "dev-server.mjs");
  const dataDirectory = studioDataDirectory({ dataDirectory: env.KCODER_STUDIO_DATA_DIR,
    serversStore: env.KCODER_STUDIO_SERVERS_STORE
      ? resolve(options.cwd ?? studioRoot, env.KCODER_STUDIO_SERVERS_STORE) : undefined });
  const child = spawn(nodeBinary, [gatewayScript], {
    cwd: options.cwd ?? studioRoot,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
      KCODER_STUDIO_HOST: "127.0.0.1",
      KCODER_STUDIO_PORT: String(options.port ?? 0),
      KCODER_STUDIO_AUTH_TOKEN: token,
      KCODER_STUDIO_ALLOWED_HOSTS: "127.0.0.1,localhost,::1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exit = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let rejectCancellation;
  const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
  const onAbort = () => rejectCancellation(new Error('KCoder Studio gateway startup cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  let stderr = "";
  let forwardStderr = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
    if (forwardStderr) options.onStderr?.(chunk);
  });
  child.stdout.setEncoding("utf8");

  const ready = new Promise((resolveReady, reject) => {
    let output = "";
    const onData = (chunk) => {
      options.onStdout?.(chunk);
      if (forwardStderr) return;
      output = `${output}${chunk}`.slice(-16_384);
      const match = output.match(/KCoder Studio: (http:\/\/[^\s]+)/);
      if (!match) return;
      const url = new URL(match[1]);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
        reject(new Error(`Desktop gateway reported a non-loopback URL: ${url.href}`));
        return;
      }
      forwardStderr = true;
      if (stderr) options.onStderr?.(stderr);
      resolveReady(url.origin);
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const error = gatewayStartupExitError({ code, signal, stderr, dataDirectory });
      if (!forwardStderr && stderr) options.onStderr?.(error.code === 'MOBILE_DEVICE_STORAGE_UNAVAILABLE' ? `${error.message}\n` : stderr);
      reject(error);
    });
  });

  const timeoutMs = options.timeoutMs ?? 60_000;
  let timeout;
  try {
    const baseUrl = await Promise.race([
      ready,
      cancelled,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`KCoder Studio gateway did not start within ${timeoutMs}ms`)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    let authentication = await Promise.race([gatewayLogin(
      baseUrl,
      token,
      options.loginTimeoutMs ?? timeoutMs,
    ), cancelled]);
    let renewing;
    let stopping;
    return {
      baseUrl,
      get cookieValue() { return authentication.cookieValue; },
      get sessionTtlMs() { return authentication.ttlMs; },
      // Reserve observed private-store latency before the next renewal deadline.
      get sessionRenewalDelayMs() { return Math.max(50, Math.floor(authentication.ttlMs / 2) - authentication.elapsedMs); },
      renewSession() {
        renewing ??= gatewayLogin(baseUrl, token, options.loginTimeoutMs ?? timeoutMs, authentication.cookieValue)
          .then(value => { authentication = value; })
          .finally(() => { renewing = null; });
        return renewing;
      },
      pid: child.pid,
      exit,
      stop: () => stopping ??= stopChild(child, options.stopGraceMs),
    };
  } catch (error) {
    await stopChild(child, options.stopGraceMs);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}
