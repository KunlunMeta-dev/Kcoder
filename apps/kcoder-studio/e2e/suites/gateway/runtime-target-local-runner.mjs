import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";

const appRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const repoRoot = resolve(appRoot, "../..");
const kcoderBin = process.env.KCODER_STUDIO_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
await access(kcoderBin);
const port = await availablePort();
const date = new Date().toISOString().slice(0, 10);
const stamp = new Date().toISOString().replaceAll(":", "-").replace("T", "-").replace("Z", "");
const standaloneOut = resolve(repoRoot, "target/client-lab", date, `${stamp}-studio-e2e-${process.pid}`);
const stateRoot = resolve(process.env.KCODER_E2E_OWNED_STATE_DIR || standaloneOut);
const artifactRoot = resolve(process.env.KCODER_E2E_OWNED_ARTIFACT_DIR || standaloneOut);
await Promise.all([mkdir(stateRoot, { recursive: true }), mkdir(artifactRoot, { recursive: true })]);
const testWorkspace = resolve(stateRoot, "workspace");
await mkdir(testWorkspace, { recursive: true });
await writeFile(resolve(testWorkspace, "README.md"), "studio file e2e\n");
const serversFile = resolve(stateRoot, "runtime-targets.json");
await writeFile(serversFile, JSON.stringify([
  { id: "local", label: "KCoder Local", runtime: "kcoder", transport: "local", command: kcoderBin, workspace: testWorkspace },
], null, 2));

const gateway = spawn(process.execPath, ["dev-server.mjs"], {
  cwd: appRoot,
  env: {
    ...process.env,
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_SCENARIO: "full-turn",
    KCODER_STUDIO_WORKSPACE: testWorkspace,
    KCODER_STUDIO_SERVERS_FILE: serversFile,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gatewayLog = "";
gateway.stdout.setEncoding("utf8");
gateway.stderr.setEncoding("utf8");
gateway.stdout.on("data", chunk => { gatewayLog += chunk; });
gateway.stderr.on("data", chunk => { gatewayLog += chunk; });

try {
  await waitFor(() => gatewayLog.includes(`127.0.0.1:${port}`), 10_000, "gateway startup");
  const html = await fetch(`http://127.0.0.1:${port}/`).then(response => response.text());
  const token = html.match(/name="kcoder-rpc-token" content="([^"]+)"/)?.[1];
  if (!token) throw new Error("gateway token was not injected into index.html");
  const serverPayload = await fetch(`http://127.0.0.1:${port}/api/servers`).then(response => response.json());
  const serverId = serverPayload.servers?.[0]?.id;
  if (serverId !== "local") throw new Error(`unexpected gateway server: ${String(serverId)}`);
  const rpcUrl = `ws://127.0.0.1:${port}/rpc?token=${encodeURIComponent(token)}&server=${encodeURIComponent(serverId)}`;
  const events = await exerciseProtocol(rpcUrl);
  const residentRouting = await exerciseResidentRouting(rpcUrl);

  const screenshot = resolve(artifactRoot, "studio.png");
  const captureVisual = process.env.KCODER_STUDIO_CAPTURE === "1";
  const sandboxDisabled = process.env.KCODER_STUDIO_CHROMIUM_NO_SANDBOX === "1";
  let chromiumLog = "visual capture skipped";
  let screenshotBytes = null;
  if (captureVisual) {
    const userData = process.env.KCODER_E2E_OWNED_STATE_DIR
      ? resolve(stateRoot, "chromium-profile")
      : await mkdtemp(resolve(tmpdir(), "kcoder-studio-chromium-"));
    await mkdir(userData, { recursive: true });
    const display = await availableDisplay();
    const xvfb = spawn("/usr/bin/Xvfb", [display, "-screen", "0", "1440x900x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "pipe"] });
    await waitFor(async () => {
      try { await access(`/tmp/.X11-unix/X${display.slice(1)}`); return true; } catch { return false; }
    }, 10_000, "Xvfb display");
    const chromiumArgs = ["--disable-gpu", "--disable-dev-shm-usage", `--user-data-dir=${userData}`, "--window-size=1440,900", "--window-position=0,0", `--app=http://127.0.0.1:${port}/?demo=1`];
    if (sandboxDisabled) chromiumArgs.unshift("--no-sandbox");
    const chromium = spawn("/usr/bin/chromium", chromiumArgs, { env: { ...process.env, DISPLAY: display }, stdio: ["ignore", "pipe", "pipe"] });
    chromiumLog = "";
    chromium.stdout.setEncoding("utf8");
    chromium.stderr.setEncoding("utf8");
    chromium.stdout.on("data", chunk => { chromiumLog += chunk; });
    chromium.stderr.on("data", chunk => { chromiumLog += chunk; });
    try {
      await new Promise(resolveWait => setTimeout(resolveWait, 6_000));
      const ffmpeg = spawn("/usr/bin/ffmpeg", ["-y", "-f", "x11grab", "-draw_mouse", "0", "-video_size", "1440x900", "-i", display, "-frames:v", "1", screenshot], { env: { ...process.env, DISPLAY: display }, stdio: ["ignore", "pipe", "pipe"] });
      const captured = await processExit(ffmpeg, 15_000);
      if (captured.code !== 0) throw new Error(`ffmpeg capture failed: ${JSON.stringify(captured)}`);
    } finally {
      chromium.kill("SIGTERM");
      xvfb.kill("SIGTERM");
    }
    screenshotBytes = (await stat(screenshot)).size;
    if (screenshotBytes < 10_000) throw new Error(`screenshot unexpectedly small: ${screenshotBytes}`);
  }

  const assertions = {
    ok: true,
    initialize: events.some(message => message.id === 1 && message.result),
    serverDiscovered: serverId === "local",
    threadStarted: events.some(message => message.method === "thread/started"),
    turnStarted: events.some(message => message.method === "turn/started"),
    assistantDelta: events.some(message => message.method === "item/delta" && message.params?.delta?.text),
    toolStarted: events.some(message => message.method === "item/started" && message.params?.item?.type === "toolCall"),
    turnCompleted: events.some(message => message.method === "turn/completed"),
    workspaceTree: events.some(message => message.id === 4 && Array.isArray(message.result?.stdout?.entries)),
    workspaceTextFile: events.some(message => message.id === 5 && message.result?.stdout?.content === "studio file e2e\n"),
    terminalOutput: events.some(message => message.method === "terminal/output" && message.params?.data?.includes("STUDIO-PTY-E2E")),
    terminalExit: events.some(message => message.method === "terminal/exit" && message.params?.exit_code === 0),
    residentThreadsAdvertised: residentRouting.residentThreadsAdvertised,
    twoClientsOwnDistinctThreads: residentRouting.twoClientsOwnDistinctThreads,
    crossClientThreadMutationRejected: residentRouting.crossClientThreadMutationRejected,
    twoClientsCompleteTurns: residentRouting.twoClientsCompleteTurns,
    screenshotBytes,
  };
  assertions.ok = Object.entries(assertions)
    .filter(([key]) => !["ok", "screenshotBytes"].includes(key))
    .every(([, value]) => value === true);
  await writeFile(resolve(artifactRoot, "assertions.json"), JSON.stringify(assertions, null, 2));
  await writeFile(resolve(artifactRoot, "meta.json"), JSON.stringify({ port, eventCount: events.length, screenshot: captureVisual ? screenshot : null, visualCapture: captureVisual, chromiumSandboxDisabled: captureVisual && sandboxDisabled }, null, 2));
  await writeFile(resolve(artifactRoot, "gateway.log"), gatewayLog);
  await writeFile(resolve(artifactRoot, "chromium.log"), chromiumLog);
  if (!assertions.ok) throw new Error(`E2E assertions failed: ${JSON.stringify(assertions)}`);
  console.log(artifactRoot);
} finally {
  gateway.kill("SIGTERM");
  if (gateway.exitCode === null && gateway.signalCode === null) await processExit(gateway, 5_000);
}

async function exerciseProtocol(url) {
  const socket = new WebSocket(url);
  const events = [];
  let threadId;
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
  });
  const completed = new Promise((resolveDone, reject) => {
    const timer = setTimeout(() => reject(new Error("turn completion timed out")), 20_000);
    let turnCompleted = false;
    let terminalCompleted = false;
    const finishIfReady = () => {
      if (!turnCompleted || !terminalCompleted) return;
      clearTimeout(timer);
      resolveDone();
    };
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      events.push(message);
      if (message.id === 1) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "device/execute", params: { command_key: "workspace_tree", path: testWorkspace } }));
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "device/execute", params: { command_key: "workspace_read_text_file", path: testWorkspace, args: ["README.md"], max_output_bytes: 4096 } }));
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "terminal/start", params: { cwd: testWorkspace, rows: 24, cols: 80 } }));
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/start", params: {} }));
      }
      if (message.id === 6) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "terminal/write", params: { session_id: message.result.session_id, data: "printf 'STUDIO-PTY-E2E\\n'; exit\n" } }));
      }
      if (message.id === 2) {
        threadId = message.result.thread.id;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId, input: [{ type: "text", text: "studio e2e" }] } }));
      }
      if (message.method === "turn/completed") { turnCompleted = true; finishIfReady(); }
      if (message.method === "terminal/exit") { terminalCompleted = true; finishIfReady(); }
    });
  });
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-27", clientInfo: { name: "studio-e2e", version: "1" } } }));
  await completed;
  socket.close();
  return events;
}

async function exerciseResidentRouting(url) {
  const first = await openRpcSocket(url);
  const second = await openRpcSocket(url);
  try {
    const [firstInitialized, secondInitialized] = await Promise.all([
      first.request("initialize", { protocolVersion: "2026-07-27", clientInfo: { name: "studio-e2e-a", version: "1" } }),
      second.request("initialize", { protocolVersion: "2026-07-27", clientInfo: { name: "studio-e2e-b", version: "1" } }),
    ]);
    const [firstStarted, secondStarted] = await Promise.all([
      first.request("thread/start", {}),
      second.request("thread/start", {}),
    ]);
    const firstThread = firstStarted.result?.thread?.id;
    const secondThread = secondStarted.result?.thread?.id;
    const conflict = await second.request("thread/resume", { threadId: firstThread });

    const firstCompleted = first.waitFor(message => message.method === "turn/completed" && message.params?.threadId === firstThread);
    const firstTurn = await first.request("turn/start", {
      threadId: firstThread,
      input: [{ type: "text", text: "resident client a" }],
    });
    await firstCompleted;
    const secondCompleted = second.waitFor(message => message.method === "turn/completed" && message.params?.threadId === secondThread);
    const secondTurn = await second.request("turn/start", {
      threadId: secondThread,
      input: [{ type: "text", text: "resident client b" }],
    });
    await secondCompleted;

    return {
      residentThreadsAdvertised: firstInitialized.result?.capabilities?.experimental?.residentThreads === true
        && secondInitialized.result?.capabilities?.experimental?.residentThreads === true,
      twoClientsOwnDistinctThreads: typeof firstThread === "string" && typeof secondThread === "string" && firstThread !== secondThread,
      crossClientThreadMutationRejected: conflict.error?.code === -32023,
      twoClientsCompleteTurns: Boolean(firstTurn.result?.turn?.id && secondTurn.result?.turn?.id),
    };
  } finally {
    first.close();
    second.close();
  }
}

async function openRpcSocket(url) {
  const socket = new WebSocket(url);
  const events = [];
  const pending = new Map();
  const waiters = [];
  let nextId = 100;
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    events.push(message);
    if (message.id !== undefined && pending.has(message.id)) {
      const resolvePending = pending.get(message.id);
      pending.delete(message.id);
      resolvePending(message);
    }
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (!waiters[index].predicate(message)) continue;
      const [{ resolveWait }] = waiters.splice(index, 1);
      resolveWait(message);
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      const response = new Promise((resolveResponse, rejectResponse) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectResponse(new Error(`request timed out: ${method}`));
        }, 20_000);
        pending.set(id, message => {
          clearTimeout(timer);
          resolveResponse(message);
        });
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return response;
    },
    waitFor(predicate) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveWait, rejectWait) => {
        const waiter = { predicate, resolveWait: message => { clearTimeout(timer); resolveWait(message); } };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          rejectWait(new Error("notification timed out"));
        }, 20_000);
        waiters.push(waiter);
      });
    },
    close() { socket.close(); },
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function availablePort() {
  const probe = createNetServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  await new Promise(resolveClose => probe.close(resolveClose));
  return address.port;
}

async function availableDisplay() {
  for (let number = 90; number < 190; number += 1) {
    try {
      await access(`/tmp/.X11-unix/X${number}`);
    } catch {
      return `:${number}`;
    }
  }
  throw new Error("no free X11 display in :90-:189");
}

async function processExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("process timeout"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}
