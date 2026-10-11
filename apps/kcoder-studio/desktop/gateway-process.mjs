import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const studioRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function gatewayLogin(baseUrl, token, timeoutMs, currentCookie) {
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
        resolveLogin({ cookieValue: decodeURIComponent(match[1]),
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
  const env = { ...process.env, ...(options.env ?? {}) };
  const token = options.token ?? randomBytes(32).toString("base64url");
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const gatewayScript = options.gatewayScript ?? resolve(studioRoot, "dev-server.mjs");
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
  });
  const exit = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
    options.onStderr?.(chunk);
  });
  child.stdout.setEncoding("utf8");

  const ready = new Promise((resolveReady, reject) => {
    let output = "";
    const onData = (chunk) => {
      output = `${output}${chunk}`.slice(-16_384);
      options.onStdout?.(chunk);
      const match = output.match(/KCoder Studio: (http:\/\/[^\s]+)/);
      if (!match) return;
      const url = new URL(match[1]);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
        reject(new Error(`Desktop gateway reported a non-loopback URL: ${url.href}`));
        return;
      }
      resolveReady(url.origin);
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `KCoder Studio gateway exited before startup (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
        ),
      );
    });
  });

  const timeoutMs = options.timeoutMs ?? 20_000;
  let timeout;
  try {
    const baseUrl = await Promise.race([
      ready,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`KCoder Studio gateway did not start within ${timeoutMs}ms`)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    let authentication = await gatewayLogin(
      baseUrl,
      token,
      options.loginTimeoutMs ?? timeoutMs,
    );
    let renewing;
    return {
      baseUrl,
      get cookieValue() { return authentication.cookieValue; },
      get sessionTtlMs() { return authentication.ttlMs; },
      renewSession() {
        renewing ??= gatewayLogin(baseUrl, token, options.loginTimeoutMs ?? timeoutMs, authentication.cookieValue)
          .then(value => { authentication = value; })
          .finally(() => { renewing = null; });
        return renewing;
      },
      pid: child.pid,
      exit,
      stop: () => stopChild(child, options.stopGraceMs),
    };
  } catch (error) {
    await stopChild(child, options.stopGraceMs);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
