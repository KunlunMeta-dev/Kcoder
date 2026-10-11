import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const repoRoot = resolve(appRoot, "../..");
const kcoderBin = resolve(repoRoot, "target/debug/kcoder");
const sshUser = process.env.USER || "kcoder-e2e";
const chromiumBin = process.env.KCODER_CHROMIUM_BIN || "/usr/bin/chromium";
const chromiumNoSandbox = process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";
assert.ok(chromiumNoSandbox || process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX === "1", "explicit Chromium sandbox policy is required");
await access(kcoderBin);
await access(chromiumBin);

const fixtureRoot = process.env.KCODER_E2E_OWNED_STATE_DIR
  ? resolve(process.env.KCODER_E2E_OWNED_STATE_DIR)
  : await mkdtemp(join(tmpdir(), "kcoder-studio-ssh-e2e-"));
await mkdir(fixtureRoot, { recursive: true });
const workspace = join(fixtureRoot, "workspace");
const wrapperDir = join(fixtureRoot, "bin");
await mkdir(workspace);
await mkdir(wrapperDir);
await writeFile(join(workspace, "README.md"), "real ssh studio e2e\n");

const sshPort = await availablePort();
const gatewayPort = await availablePort();
await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(fixtureRoot, "host-key")]);
await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(fixtureRoot, "client-key")]);
await Promise.all([
  chmod(join(fixtureRoot, "host-key"), 0o600),
  chmod(join(fixtureRoot, "client-key"), 0o600),
]);
await writeFile(
  join(fixtureRoot, "authorized_keys"),
  await readFile(join(fixtureRoot, "client-key.pub")),
  { mode: 0o600 },
);
await writeFile(
  join(fixtureRoot, "sshd_config"),
  [
    `Port ${sshPort}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${join(fixtureRoot, "host-key")}`,
    `AuthorizedKeysFile ${join(fixtureRoot, "authorized_keys")}`,
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    "UsePAM no",
    "StrictModes no",
    `AllowUsers ${sshUser}`,
    `PidFile ${join(fixtureRoot, "sshd.pid")}`,
    "LogLevel VERBOSE",
    "",
  ].join("\n"),
);
const sshWrapper = join(wrapperDir, "ssh");
await writeFile(
  sshWrapper,
  `#!/bin/sh\nexec /usr/bin/ssh -F /dev/null -i ${join(fixtureRoot, "client-key")} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$@"\n`,
  { mode: 0o700 },
);
await chmod(sshWrapper, 0o700);

const serversFile = join(fixtureRoot, "servers.json");
await writeFile(serversFile, JSON.stringify([
  {
    id: "local",
    label: "本地控制组",
    runtime: "kcoder",
    transport: "local",
    command: kcoderBin,
    workspace,
  },
  {
    id: "ssh-loopback",
    label: "真实 SSH 测试机",
    runtime: "kcoder",
    transport: "ssh",
    host: "127.0.0.1",
    user: sshUser,
    port: sshPort,
    command: kcoderBin,
    workspace,
    chromiumBin,
    chromiumNoSandbox,
  },
], null, 2));

const fixtureServer = createHttpServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>SSH Browser Probe</title><h1>SSH_BROWSER_OK</h1>");
});
await new Promise((resolveListen, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(0, "127.0.0.1", resolveListen);
});
const fixtureAddress = fixtureServer.address();
const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`;

const sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(fixtureRoot, "sshd_config")], {
  stdio: ["ignore", "ignore", "pipe"],
});
let sshdLog = "";
sshd.stderr.setEncoding("utf8");
sshd.stderr.on("data", (chunk) => { sshdLog += chunk; });

let gateway;
let socket;
let browserSocket;
let browserProfileDir;
try {
  await waitForPort(sshPort, 5_000);
  gateway = spawn(process.execPath, ["dev-server.mjs"], {
    cwd: appRoot,
    env: {
      ...process.env,
      PATH: `${wrapperDir}${delimiter}${process.env.PATH || ""}`,
      KCODER_STUDIO_HOST: "127.0.0.1",
      KCODER_STUDIO_PORT: String(gatewayPort),
      KCODER_STUDIO_SERVERS_FILE: serversFile,
      KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_STUDIO_WORKSPACE: workspace,
      KCODER_STUDIO_APP_SERVER_IDLE_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let gatewayLog = "";
  gateway.stdout.setEncoding("utf8");
  gateway.stderr.setEncoding("utf8");
  gateway.stdout.on("data", (chunk) => { gatewayLog += chunk; });
  gateway.stderr.on("data", (chunk) => { gatewayLog += chunk; });
  await waitFor(() => gatewayLog.includes(`127.0.0.1:${gatewayPort}`), 10_000, "gateway startup");

  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  const servers = await fetch(`${baseUrl}/api/servers`).then((response) => response.json());
  assert.deepEqual(servers.servers.map((server) => server.id), ["local", "ssh-loopback"]);
  assert.equal(servers.servers[1].transport, "ssh");
  const connectionTest = await fetch(`${baseUrl}/api/servers/test`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({
      id: "ssh-loopback",
      label: "真实 SSH 测试机",
      transport: "ssh",
      host: "127.0.0.1",
      user: sshUser,
      port: sshPort,
      command: kcoderBin,
      workspace,
      chromiumBin,
      chromiumNoSandbox,
    }),
  }).then((response) => {
    assert.equal(response.status, 200);
    return response.json();
  });
  assert.equal(connectionTest.ok, true, JSON.stringify(connectionTest));
  assert.equal(connectionTest.serverInfo.name, "kcoder-app-server");
  assert.equal(connectionTest.protocolVersion, "2026-07-27");
  const health = await fetch(`${baseUrl}/api/servers/status`).then((response) => {
    assert.equal(response.status, 200);
    return response.json();
  });
  assert.deepEqual(health.statuses.map((item) => item.id), ["local", "ssh-loopback"]);
  assert.ok(health.statuses.every((item) => item.status === "online"), JSON.stringify(health));
  assert.ok(health.statuses.every((item) => Number.isInteger(item.latencyMs) && item.latencyMs >= 0));
  const html = await fetch(`${baseUrl}/`).then((response) => response.text());
  const token = html.match(/name="kcoder-rpc-token" content="([^"]+)"/)?.[1];
  assert.ok(token);

  const remoteRpcUrl = `ws://127.0.0.1:${gatewayPort}/rpc?token=${encodeURIComponent(token)}&server=ssh-loopback`;
  socket = await openWebSocket(remoteRpcUrl);
  const rpc = rpcClient(socket);
  const initialized = await rpc.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "studio-real-ssh-e2e", version: "1" },
  });
  assert.equal(initialized.serverInfo.name, "kcoder-app-server");
  browserSocket = await openWebSocket(`${remoteRpcUrl}&channel=browser`);
  const browserRpc = rpcClient(browserSocket);
  const browserInitialized = await browserRpc.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "studio-real-ssh-browser-e2e", version: "1" },
  });
  assert.equal(browserInitialized.serverInfo.name, "kcoder-app-server");

  const thread = await rpc.request("thread/start", {});
  await rpc.request("turn/start", {
    threadId: thread.thread.id,
    input: [{ type: "text", text: "real ssh e2e" }],
  });
  const terminal = await rpc.request("terminal/start", { cwd: workspace, rows: 24, cols: 80 });
  await rpc.request("terminal/write", {
    session_id: terminal.session_id,
    data: "printf 'REAL_SSH_PTY_OK\\n'; exit\n",
  });
  const browser = await browserRpc.request("browser/start", {
    url: fixtureUrl,
    width: 800,
    height: 600,
  });
  assert.equal(browser.sandbox_disabled, true);

  const activeTree = await waitFor(
    async () => {
      const localTree = await descendantCommands(gateway.pid);
      const remoteTree = await descendantCommands(sshd.pid);
      const sshClients = localTree.split("\n").filter((command) => command.includes("ssh -F /dev/null"));
      const remoteAppServers = remoteTree.split("\n").filter(
        (command) => command.includes(kcoderBin) && command.includes("app-server --scenario full-turn"),
      );
      return sshClients.length === 1
        && remoteAppServers.length === 1
        && remoteTree.includes("--remote-debugging-port=0")
        ? `local gateway descendants:\n${localTree}\nremote sshd descendants:\n${remoteTree}`
        : null;
    },
    10_000,
    "active SSH/app-server/Chromium process tree",
  );
  browserProfileDir = activeTree.match(/--user-data-dir=([^\s]+)/)?.[1];
  const screenshot = await browserRpc.request("browser/screenshot", { session_id: browser.session_id });
  assert.ok(screenshot.data_base64.length > 10_000);
  assert.equal(screenshot.page.title, "SSH Browser Probe");
  await assert.rejects(
    browserRpc.request("thread/list", {}),
    /Method not available on this gateway channel/,
  );
  await assert.rejects(
    rpc.request("browser/screenshot", { session_id: browser.session_id }),
    /Method not available on this gateway channel/,
  );
  assert.equal((await browserRpc.request("browser/close", { session_id: browser.session_id })).closed, true);

  const turnCompleted = await rpc.waitFor(
    (message) => message.method === "turn/completed",
    20_000,
    "remote turn",
  );
  assert.equal(turnCompleted.params?.turn?.status, "completed");
  const turnMessages = rpc.messages();
  assert.ok(turnMessages.some(
    (message) => message.method === "item/started" && message.params?.item?.type === "toolCall",
  ));
  await writeFile(join(process.env.KCODER_E2E_OWNED_ARTIFACT_DIR || fixtureRoot, "ssh-turn-events.json"), JSON.stringify(turnMessages, null, 2));
  const text = turnMessages.filter(message => message.method === "item/delta" && message.params?.threadId === thread.thread.id).map(message => message.params?.delta?.text ?? "").join("");
  assert.match(text, /tui-lab-final-sentinel/);
  await rpc.waitFor(
    (message) => message.method === "terminal/output" && message.params?.data?.includes("REAL_SSH_PTY_OK"),
    10_000,
    "remote PTY output",
  );
  await rpc.waitFor((message) => message.method === "terminal/exit", 10_000, "remote PTY exit");
  await closeWebSocket(browserSocket);
  browserSocket = null;
  await waitFor(
    async () => !(await descendantCommands(sshd.pid)).includes("--remote-debugging-port=0"),
    10_000,
    "remote Chromium cleanup",
  );
  const runtimeAfterBrowserClose = await rpc.request("thread/read", {
    threadId: thread.thread.id,
    limit: 50,
  });
  assert.equal(runtimeAfterBrowserClose.thread.id, thread.thread.id);
  const retainedTree = await waitFor(
    async () => {
      const localTree = await descendantCommands(gateway.pid);
      const remoteTree = await descendantCommands(sshd.pid);
      const sshClients = localTree.split("\n").filter((command) => command.includes("ssh -F /dev/null"));
      const remoteAppServers = remoteTree.split("\n").filter(
        (command) => command.includes(kcoderBin) && command.includes("app-server --scenario full-turn"),
      );
      return sshClients.length === 1 && remoteAppServers.length === 1
        ? `local gateway descendants:\n${localTree}\nremote sshd descendants:\n${remoteTree}`
        : null;
    },
    10_000,
    "resident SSH/app-server after browser disconnect",
  );

  socket.close();
  await waitFor(async () => {
    return (await descendantCommands(gateway.pid)).length === 0
      && (await descendantCommands(sshd.pid)).length === 0
      && (await matchingProcessTree(workspace)).length === 0;
  }, 10_000, "SSH child cleanup");
  const report = {
    ok: true,
    serverIds: servers.servers.map((server) => server.id),
    remoteTurnCompleted: true,
    remoteTurnStatus: turnCompleted.params.turn.status,
    remoteToolCall: true,
    remoteFinalSentinel: true,
    remotePty: true,
    remoteBrowserTitle: screenshot.page.title,
    remoteBrowserScreenshotBytes: Buffer.from(screenshot.data_base64, "base64").length,
    sharedResidentSshTransport: true,
    gatewayChannelIsolation: true,
    runtimeSurvivedBrowserDisconnect: true,
    residentIdleCleanup: true,
    sshConnectionTest: true,
    ports: { ssh: sshPort, gateway: gatewayPort, fixture: fixtureAddress.port },
    activeProcessTree: activeTree.split("\n").filter(Boolean),
    retainedProcessTree: retainedTree.split("\n").filter(Boolean),
  };
  const reportDir = resolve(process.env.KCODER_E2E_OWNED_ARTIFACT_DIR || resolve(repoRoot, "target/client-lab/ssh-e2e"));
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, "ssh-result.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  error.message = `${error.message}\nsshd log:\n${sshdLog}`;
  throw error;
} finally {
  socket?.close();
  browserSocket?.close();
  await stopProcess(gateway);
  await cleanupMarkedProcesses(workspace);
  await stopProcess(sshd);
  await new Promise((resolveClose) => fixtureServer.close(resolveClose));
  if (browserProfileDir) {
    await waitFor(async () => {
      try { await access(browserProfileDir); return false; } catch { return true; }
    }, 5_000, "remote Chromium profile cleanup");
  }
  await rm(fixtureRoot, { recursive: true, force: true });
}

function openWebSocket(url, timeoutMs = 10_000) {
  return new Promise((resolveOpen, reject) => {
    const webSocket = new WebSocket(url);
    const timer = setTimeout(() => {
      webSocket.close();
      reject(new Error(`WebSocket timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
    webSocket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(webSocket); }, { once: true });
    webSocket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket failed: ${url}`));
    }, { once: true });
  });
}

function closeWebSocket(webSocket, timeoutMs = 5_000) {
  if (webSocket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket close timed out after ${timeoutMs}ms`)), timeoutMs);
    webSocket.addEventListener("close", () => {
      clearTimeout(timer);
      resolveClose();
    }, { once: true });
    webSocket.close();
  });
}

function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

function rpcClient(webSocket) {
  let nextId = 1;
  const pending = new Map();
  const messages = [];
  const waiters = new Set();
  webSocket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    messages.push(message);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return {
    request(method, params, timeoutMs = 30_000) {
      const id = nextId++;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        webSocket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    notify(method, params) {
      webSocket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    respond(id, result) {
      webSocket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    },
    waitFor(predicate, timeoutMs, label) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveWait, reject) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${label}`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    messages() {
      return [...messages];
    },
  };
}

async function descendantCommands(rootPid) {
  const rows = await processRows();
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.ppid) || descendants.has(row.pid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((row) => row.pid !== rootPid && descendants.has(row.pid)).map((row) => row.command).join("\n");
}

async function matchingProcessTree(marker) {
  const rows = await processRows();
  const matches = new Set(rows.filter((row) => row.command.includes(marker)).map((row) => row.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!matches.has(row.ppid) || matches.has(row.pid)) continue;
      matches.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((row) => matches.has(row.pid)).map((row) => row.command).join("\n");
}

async function cleanupMarkedProcesses(marker) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await matchingProcessRows(marker);
    if (!rows.length) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  let rows = await matchingProcessRows(marker);
  for (const row of rows.reverse()) {
    try { process.kill(row.pid, "SIGTERM"); } catch {}
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rows = await matchingProcessRows(marker);
  for (const row of rows.reverse()) {
    try { process.kill(row.pid, "SIGKILL"); } catch {}
  }
  await waitFor(
    async () => (await matchingProcessRows(marker)).length === 0,
    2_000,
    "marked SSH process cleanup",
  );
}

async function matchingProcessRows(marker) {
  const rows = await processRows();
  const matches = new Set(rows.filter((row) => row.command.includes(marker)).map((row) => row.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!matches.has(row.ppid) || matches.has(row.pid)) continue;
      matches.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((row) => matches.has(row.pid));
}

async function processRows() {
  const output = await run("ps", ["-eo", "pid=,ppid=,args="]);
  return output.trim().split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForPort(port, timeoutMs) {
  return waitFor(() => new Promise((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
    socket.once("error", () => { socket.destroy(); resolveProbe(false); });
  }), timeoutMs, `port ${port}`);
}

async function availablePort() {
  const probe = createNetServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  await new Promise((resolveClose) => probe.close(resolveClose));
  return address.port;
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr || error.message}`));
      else resolveRun(stdout);
    });
  });
}
