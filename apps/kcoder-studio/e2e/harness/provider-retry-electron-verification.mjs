import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:net";
import { access, lstat, readdir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import { promisify } from "node:util";
import { chromium } from "../../renderer/node_modules/@playwright/test/index.mjs";
import { assertRendererBuildFresh } from "./renderer-build.mjs";
import { repoRoot, waitFor } from "./run-context.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_SSH_TARGET = "cyx_mac";
const DEFAULT_MAC_PROJECT_ROOT = "/Users/Admin/ZCodeProject/kcoder";
const DEFAULT_MAC_APP_RELATIVE = "target/packages/kcoder-studio/macos/mac/kcoder-studio.app";
const MAC_NODE = "/usr/local/bin/node";
const MAC_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin";
const SSH_OPTIONS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=5",
  "-o", "ServerAliveCountMax=2",
];

const REMOTE_TREE_DIGEST_SOURCE = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = process.argv[1];
async function walk(directory, prefix = "", entries = []) {
  for (const name of (await fs.readdir(directory)).sort()) {
    const full = path.join(directory, name);
    const relative = prefix ? prefix + "/" + name : name;
    const info = await fs.lstat(full);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await walk(full, relative, entries);
    } else if (info.isFile() && !info.isSymbolicLink()) {
      const digest = crypto.createHash("sha256");
      await new Promise((resolve, reject) => {
        const stream = require("node:fs").createReadStream(full);
        stream.on("data", chunk => digest.update(chunk));
        stream.once("error", reject);
        stream.once("end", resolve);
      });
      entries.push({ path: relative, size: info.size, sha256: digest.digest("hex") });
    } else {
      throw new Error("unsupported renderer resource: " + relative);
    }
  }
  return entries;
}
(async () => {
  const entries = await walk(root);
  const digest = crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  process.stdout.write(JSON.stringify({ fileCount: entries.length, digest }));
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
`;

const REMOTE_STOP_SOURCE = String.raw`
const { spawnSync } = require("node:child_process");
const pid = Number(process.argv[1]);
const expectedBinary = process.argv[2];
if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("invalid owned app PID");
function processTable() {
  const result = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("unable to inspect the isolated Electron process tree");
  return result.stdout.split(/\r?\n/).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}
function commandFor(targetPid) {
  const result = spawnSync("/bin/ps", ["-ww", "-p", String(targetPid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}
function startTimeFor(targetPid) {
  const result = spawnSync("/bin/ps", ["-p", String(targetPid), "-o", "lstart="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}
const rows = processTable();
const root = rows.find(row => row.pid === pid);
if (!root) {
  process.stdout.write(JSON.stringify({ pid, status: "already-exited", processTreePids: [] }));
  process.exit(0);
}
if (!root.command.includes(expectedBinary)) throw new Error("remote PID no longer belongs to this isolated Electron app");
const owned = [];
function collect(parentPid, depth) {
  for (const child of rows.filter(row => row.ppid === parentPid)) {
    owned.push({ ...child, depth });
    collect(child.pid, depth + 1);
  }
}
collect(pid, 1);
owned.push({ ...root, depth: 0 });
for (const record of owned) record.startTime = startTimeFor(record.pid);
const signalMatching = (record, signal) => {
  if (!record.startTime || startTimeFor(record.pid) !== record.startTime) return;
  try { process.kill(record.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
};
for (const record of [...owned].sort((left, right) => right.depth - left.depth)) signalMatching(record, "SIGTERM");
const sameProcessStillRunning = () => owned.filter(record => record.startTime && startTimeFor(record.pid) === record.startTime);
const deadline = Date.now() + 5_000;
const timer = setInterval(() => {
  let remaining;
  try { remaining = sameProcessStillRunning(); } catch (error) {
    clearInterval(timer);
    process.stderr.write(String(error));
    process.exit(2);
  }
  if (remaining.length === 0) {
    clearInterval(timer);
    process.stdout.write(JSON.stringify({
      pid,
      status: "terminated",
      processTreePids: owned.map(record => record.pid),
      descendantsTerminated: owned.length - 1,
    }));
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    clearInterval(timer);
    for (const record of [...remaining].sort((left, right) => right.depth - left.depth)) signalMatching(record, "SIGKILL");
    setTimeout(() => {
      const survivors = sameProcessStillRunning();
      if (survivors.length > 0) {
        process.stderr.write("isolated Electron process tree survived SIGKILL");
        process.exit(2);
      }
      process.stdout.write(JSON.stringify({
        pid,
        status: "force-terminated",
        processTreePids: owned.map(record => record.pid),
        descendantsTerminated: owned.length - 1,
      }));
      process.exit(0);
    }, 500);
  }
}, 100);
`;

const REMOTE_VERIFY_PROCESS_SOURCE = String.raw`
const { spawnSync } = require("node:child_process");
const matchPaths = process.argv.slice(1);
const result = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,ppid=,command="], { encoding: "utf8" });
if (result.status !== 0) throw new Error("unable to inspect Mac process table after Electron cleanup");
const rows = result.stdout.split(/\r?\n/).map(line => {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
}).filter(Boolean);
const byPid = new Map(rows.map(row => [row.pid, row]));
const ancestors = new Set();
let ancestor = byPid.get(process.pid);
while (ancestor && !ancestors.has(ancestor.pid)) {
  ancestors.add(ancestor.pid);
  ancestor = byPid.get(ancestor.ppid);
}
const residual = rows.filter(row => !ancestors.has(row.pid) && matchPaths.some(path => row.command.includes(path)));
const receipt = {
  checkedPathCount: matchPaths.length,
  residualProcesses: residual.map(row => ({
    pid: row.pid,
    appClone: row.command.includes(matchPaths[0]),
    gatewayBinary: row.command.includes(matchPaths[1]),
    isolatedState: matchPaths.slice(2).some(path => row.command.includes(path)),
  })),
};
process.stdout.write(JSON.stringify(receipt));
if (receipt.residualProcesses.length) process.exitCode = 93;
`;

/**
 * Start a private copy of the installed macOS Electron app and connect to its real
 * renderer through a loopback-only SSH CDP tunnel. The caller supplies the same local
 * HTTP provider fixture used by the browser suite; no model or renderer behavior is
 * mocked here.
 */
export async function startMacPackagedElectron(context, {
  fixture,
  credential,
  providerId = "provider-retry-feedback",
  projectLabel = "Provider Retry Feedback E2E",
  maxRetries = 2,
  retryBaseDelayMs = 3_000,
  rendererDist = resolve(repoRoot, "apps/kcoder-studio/renderer/dist"),
  sourceBundle,
  sshTarget = process.env.KCODER_E2E_MAC_SSH_TARGET || DEFAULT_SSH_TARGET,
  remoteProjectRoot = process.env.KCODER_E2E_MAC_PROJECT_ROOT || DEFAULT_MAC_PROJECT_ROOT,
  timeoutMs = 90_000,
} = {}) {
  assert.ok(fixture && typeof fixture.baseUrl === "string", "local provider fixture is required");
  assert.match(providerId, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
  assert.ok(typeof projectLabel === "string" && projectLabel.length > 0 && projectLabel.length <= 80);
  assert.ok(Number.isInteger(maxRetries) && maxRetries >= 1 && maxRetries <= 5);
  assert.ok(Number.isInteger(retryBaseDelayMs) && retryBaseDelayMs >= 3_000,
    "Mac retry feedback validation requires a retry backoff of at least 3000ms");
  if (typeof credential !== "string" || credential.length < 8) {
    throw new Error("an isolated synthetic provider credential is required");
  }
  context.registerSecret(credential);

  const fixtureUrl = new URL(fixture.baseUrl);
  assert.equal(fixtureUrl.protocol, "http:", "the isolated provider fixture must use HTTP");
  assert.equal(fixtureUrl.hostname, "127.0.0.1", "the fixture must bind only to local loopback");
  const localFixturePort = Number(fixtureUrl.port);
  assert.ok(Number.isInteger(localFixturePort) && localFixturePort > 0);

  const projectRoot = normalizeRemoteDirectory(remoteProjectRoot, "remote project root");
  const targetTestRoot = posix.join(projectRoot, "target/test");
  const relativeRun = posix.join(context.sourceRelative, basename(context.runRoot));
  assert.ok(!relativeRun.startsWith("../") && relativeRun !== "..", "run path escaped its E2E source root");
  const remoteRunRoot = posix.join(targetTestRoot, relativeRun);
  const relativeToTarget = posix.relative(targetTestRoot, remoteRunRoot);
  assert.ok(relativeToTarget && !relativeToTarget.startsWith("../") && !posix.isAbsolute(relativeToTarget),
    "remote run artifacts must remain under the target E2E directory");

  const remoteArtifactRoot = posix.join(remoteRunRoot, "artifacts/mac-electron");
  const remoteStateRoot = posix.join(remoteRunRoot, "state/mac-electron");
  const remoteAppBundle = posix.join(remoteArtifactRoot, "kcoder-studio.app");
  const remoteResources = posix.join(remoteAppBundle, "Contents/Resources");
  const remoteRendererDist = posix.join(remoteResources, "renderer-dist");
  const remoteHome = posix.join(remoteStateRoot, "home");
  const remoteConfigDir = posix.join(remoteStateRoot, "config");
  const remoteUserData = posix.join(remoteStateRoot, "desktop-profile");
  const remoteWorkspace = posix.join(remoteStateRoot, "workspace");
  const remoteTemp = posix.join(remoteStateRoot, "tmp");
  const remotePidFile = posix.join(remoteStateRoot, "electron.pid");
  const remoteSettingsFile = posix.join(remoteConfigDir, "settings.json");
  const remoteServersFile = posix.join(remoteStateRoot, "servers.json");
  const remoteBinary = posix.join(remoteResources, "bin/kcoder");
  const bundlePath = normalizeRemoteDirectory(
    sourceBundle || posix.join(projectRoot, DEFAULT_MAC_APP_RELATIVE),
    "Mac app bundle source",
  );
  const localSsh = process.env.KCODER_E2E_SSH_BIN || "/usr/bin/ssh";
  const localScp = process.env.KCODER_E2E_SCP_BIN || "/usr/bin/scp";
  const sshEnv = createSshEnvironment(context);

  await assertRendererBuildFresh({ buildRoot: rendererDist });
  await access(localSsh);
  await access(localScp);
  const [rendererInventory, sourceProvenance] = await Promise.all([
    inventoryRendererTree(rendererDist),
    collectRendererSourceProvenance(),
  ]);

  const stateRelative = relative(context.stateDir, context.pathInState("mac-electron"));
  assert.ok(stateRelative && stateRelative !== ".." && !stateRelative.startsWith(`..${sep}`));
  const localRuntimeRoot = context.pathInState("mac-electron");
  const localConfigDir = resolve(localRuntimeRoot, "config");
  const localSettingsFile = resolve(localConfigDir, "settings.json");
  const localCredentialsFile = resolve(localConfigDir, "credentials.json");
  const localServersFile = resolve(localRuntimeRoot, "servers.json");

  let reverseForwardStopped = false;
  let reverseForwardChild;
  let remoteAppPid = null;
  let cdpTunnelLabel = null;
  let appLaunchStopped = false;
  let browserDisconnected = false;
  let remoteStateRemoved = false;
  let browser;
  let page;
  let appLaunchChild;
  let remoteStopReport = null;
  let remoteProcessCleanupReport = null;

  const verifyRemoteProcessesStopped = async label => {
    const paths = [remoteAppBundle, remoteBinary, remoteStateRoot, remoteUserData, remoteWorkspace, remoteConfigDir, remoteHome];
    const command = `${MAC_NODE} -e ${shellQuote(REMOTE_VERIFY_PROCESS_SOURCE)} ${paths.map(shellQuote).join(" ")}`;
    const result = await remoteCleanupExec(context, label, localSsh, sshEnv, sshTarget, command);
    const receipt = parseJsonOutput(result.stdout, "remote Electron process cleanup receipt");
    assert.deepEqual(receipt.residualProcesses, [], "isolated app, Gateway, or child process remains on Mac");
    remoteProcessCleanupReport = receipt;
    return receipt;
  };

  const removeRemoteState = async () => {
    if (remoteStateRemoved) return;
    await verifyRemoteProcessesStopped("mac-electron-verify-process-tree-before-state-removal");
    await remoteCleanupExec(context, "mac-electron-remove-isolated-state", localSsh, sshEnv, sshTarget,
      `set -eu\ncase ${shellQuote(remoteStateRoot)} in ${shellQuote(`${targetTestRoot}/`)}*) ;; *) exit 91 ;; esac\n/bin/rm -rf ${shellQuote(remoteStateRoot)}\ntest ! -e ${shellQuote(remoteStateRoot)}`);
    remoteStateRemoved = true;
  };
  context.addCleanup("remove private Mac Electron config/profile/workspace", removeRemoteState);

  const stopReverseForward = async () => {
    if (reverseForwardStopped) return;
    reverseForwardStopped = true;
    if (reverseForwardChild) await context.stopOwned("mac-electron-provider-reverse-forward");
  };
  const stopAppLaunch = async () => {
    if (appLaunchStopped) return;
    if (!appLaunchChild) {
      appLaunchStopped = true;
      return;
    }
    let cleanupFailure;
    try {
      if (!remoteAppPid) {
        const pidOutput = await remoteCleanupExec(context, "mac-electron-read-app-pid", localSsh, sshEnv, sshTarget,
          `test -f ${shellQuote(remotePidFile)} && /bin/cat ${shellQuote(remotePidFile)}`).catch(() => null);
        const value = pidOutput?.stdout.trim();
        if (/^[0-9]+$/.test(value || "")) remoteAppPid = Number(value);
      }
      if (remoteAppPid) {
        const stopResult = await remoteCleanupExec(context, "mac-electron-stop-app", localSsh, sshEnv, sshTarget,
          `${MAC_NODE} -e ${shellQuote(REMOTE_STOP_SOURCE)} ${remoteAppPid} ${shellQuote(posix.join(remoteAppBundle, "Contents/MacOS/kcoder-studio"))}`);
        remoteStopReport = parseJsonOutput(stopResult.stdout, "remote Electron cleanup receipt");
      }
      await verifyRemoteProcessesStopped("mac-electron-verify-app-gateway-children-stopped");
    } catch (error) {
      cleanupFailure = error;
    } finally {
      await context.stopOwned("mac-electron-packaged-app");
    }
    if (cleanupFailure) throw cleanupFailure;
    appLaunchStopped = true;
  };
  const stopCdpTunnel = async () => {
    if (cdpTunnelLabel) await context.stopOwned(cdpTunnelLabel);
  };
  const disconnectBrowser = async () => {
    if (browserDisconnected) return;
    browserDisconnected = true;
    await browser?.close().catch(() => {});
  };
  try {
    await remoteExec(context, "mac-electron-clone-and-prepare", localSsh, sshEnv, sshTarget,
      [
        "set -eu",
        "umask 077",
        `test -d ${shellQuote(bundlePath)}`,
        `test ! -L ${shellQuote(bundlePath)}`,
        `test ! -e ${shellQuote(remoteAppBundle)}`,
        `test ! -e ${shellQuote(remoteStateRoot)}`,
        `mkdir -p ${shellQuote(remoteArtifactRoot)} ${shellQuote(remoteStateRoot)} ${shellQuote(remoteConfigDir)} ${shellQuote(remoteHome)} ${shellQuote(remoteUserData)} ${shellQuote(remoteWorkspace)} ${shellQuote(remoteTemp)}`,
        `ditto ${shellQuote(bundlePath)} ${shellQuote(remoteAppBundle)}`,
        `test -d ${shellQuote(remoteResources)}`,
        `test ! -L ${shellQuote(posix.join(remoteResources, "renderer-dist"))}`,
        `rm -rf ${shellQuote(posix.join(remoteResources, "renderer-dist"))}`,
      ].join("\n"));

    const reverseOutput = { text: "" };
    reverseForwardChild = context.spawnOwned("mac-electron-provider-reverse-forward", localSsh,
      [...SSH_OPTIONS, "-v", "-T", "-N", "-R", `0:127.0.0.1:${localFixturePort}`, sshTarget],
      { env: sshEnv });
    context.addCleanup("close provider fixture reverse-forward", stopReverseForward);
    reverseForwardChild.stdout.on("data", bytes => { reverseOutput.text = `${reverseOutput.text}${bytes}`.slice(-32_000); });
    reverseForwardChild.stderr.on("data", bytes => { reverseOutput.text = `${reverseOutput.text}${bytes}`.slice(-32_000); });
    const remoteFixturePort = await waitFor(() => {
      if (reverseForwardChild.exitCode !== null) {
        throw new Error(`Mac provider reverse-forward exited early (${reverseForwardChild.exitCode})`);
      }
      const match = reverseOutput.text.match(/Allocated port (\d+) for remote forward/);
      return match ? Number(match[1]) : null;
    }, 30_000, "SSH allocated remote provider fixture port", 50, context.abortSignal);
    assert.ok(Number.isInteger(remoteFixturePort) && remoteFixturePort > 0);
    context.registerPort("mac-electron-provider-fixture-reverse", remoteFixturePort);
    const remoteFixtureUrl = `http://127.0.0.1:${remoteFixturePort}${fixtureUrl.pathname}`;

    const settings = {
      active_provider: providerId,
      max_retries: maxRetries,
      retry_base_delay_ms: retryBaseDelayMs,
      providers: {
        [providerId]: {
          api_format: "openai_chat_completions",
          endpoint: remoteFixtureUrl,
          default_model: `${providerId}-model`,
          context_window_tokens: 128_000,
          output_headroom_tokens: 8_192,
          max_output_tokens: 8_192,
          request_timeout_secs: 30,
          no_proxy: true,
          max_retries: maxRetries,
          retry_base_delay_ms: retryBaseDelayMs,
          extra_body: {},
        },
      },
    };
    const serverConfig = [{
      id: "local",
      label: projectLabel,
      runtime: "kcoder",
      transport: "local",
      command: remoteBinary,
      workspace: remoteWorkspace,
      settingsFile: remoteSettingsFile,
    }];
    await context.writeStateJson("mac-electron/config/settings.json", settings);
    await context.writeStateJson("mac-electron/config/credentials.json", {
      [providerId]: { type: "api", key: credential },
    });
    await context.writeStateJson("mac-electron/servers.json", serverConfig);
    await runOwnedCommand(context, "mac-electron-copy-isolated-config", localScp,
      ["-q", localSettingsFile, localCredentialsFile, `${sshTarget}:${remoteConfigDir}/`], sshEnv);
    await runOwnedCommand(context, "mac-electron-copy-isolated-server-config", localScp,
      ["-q", localServersFile, `${sshTarget}:${remoteStateRoot}/`], sshEnv);

    await runOwnedCommand(context, "mac-electron-upload-renderer-dist", localScp,
      ["-q", "-r", resolve(rendererDist), `${sshTarget}:${remoteRendererDist}`], sshEnv);
    const remoteInventoryOutput = await remoteExec(context, "mac-electron-verify-renderer-copy", localSsh, sshEnv, sshTarget,
      `${MAC_NODE} -e ${shellQuote(REMOTE_TREE_DIGEST_SOURCE)} ${shellQuote(remoteRendererDist)}`);
    const remoteInventory = parseJsonOutput(remoteInventoryOutput.stdout, "copied renderer inventory");
    assert.equal(remoteInventory.digest, rendererInventory.digest,
      "Mac app clone renderer-dist bytes differ from the locally built dist");

    const appArgs = [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
    ];
    const isolatedAppEnv = {
      HOME: remoteHome,
      PATH: MAC_SYSTEM_PATH,
      TMPDIR: remoteTemp,
      KCODER_HOME: posix.join(remoteHome, "kcoder"),
      KCODER_CONFIG_DIR: remoteConfigDir,
      KCODER_STUDIO_WORKSPACE: remoteWorkspace,
      KCODER_STUDIO_SERVERS_FILE: remoteServersFile,
      KCODER_STUDIO_DESKTOP_USER_DATA_DIR: remoteUserData,
    };
    const environmentArgs = Object.entries(isolatedAppEnv)
      .map(([name, value]) => `${name}=${shellQuote(value)}`)
      .join(" ");
    const appBinary = posix.join(remoteAppBundle, "Contents/MacOS/kcoder-studio");
    const appCommand = [
      "set -eu",
      `cd ${shellQuote(remoteWorkspace)}`,
      `umask 077; /usr/bin/env -i ${environmentArgs} ${shellQuote(appBinary)} ${appArgs.map(shellQuote).join(" ")} &`,
      "app_pid=$!",
      `printf '%s\\n' "$app_pid" > ${shellQuote(remotePidFile)}`,
      "printf 'KCODER_E2E_REMOTE_APP_PID=%s\\n' \"$app_pid\"",
      "wait \"$app_pid\"",
    ].join("\n");
    const remoteAppCommand = `/bin/bash -c ${shellQuote(appCommand)}`;
    appLaunchChild = context.spawnOwned("mac-electron-packaged-app", localSsh,
      [...SSH_OPTIONS, "-T", sshTarget, remoteAppCommand], { env: sshEnv });
    context.addCleanup("stop isolated packaged Mac Electron", stopAppLaunch);
    const appOutput = { text: "" };
    appLaunchChild.stdout.on("data", bytes => { appOutput.text = `${appOutput.text}${bytes}`.slice(-64_000); });
    appLaunchChild.stderr.on("data", bytes => { appOutput.text = `${appOutput.text}${bytes}`.slice(-64_000); });
    const started = await waitFor(() => {
      if (appLaunchChild.exitCode !== null) {
        throw new Error(`isolated Mac Electron exited before CDP startup (${appLaunchChild.exitCode}): ${context.redactText(appOutput.text.slice(-4_000))}`);
      }
      const pidMatch = appOutput.text.match(/KCODER_E2E_REMOTE_APP_PID=(\d+)/);
      const cdpMatch = appOutput.text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[^\s]+)/);
      if (!pidMatch || !cdpMatch) return null;
      return { pid: Number(pidMatch[1]), endpoint: cdpMatch[1], remoteCdpPort: Number(cdpMatch[2]) };
    }, timeoutMs, "isolated Mac Electron CDP startup", 100, context.abortSignal);
    remoteAppPid = started.pid;
    context.registerPort("mac-electron-cdp-remote", started.remoteCdpPort);

    const cdpLocalPort = await startCdpTunnel(context, localSsh, sshEnv, sshTarget, started.remoteCdpPort,
      (_child, label) => { cdpTunnelLabel = label; });
    const version = await waitFor(async () => fetchJson(`http://127.0.0.1:${cdpLocalPort}/json/version`).catch(() => null),
      20_000, "private Mac Electron CDP endpoint", 100, context.abortSignal);
    const websocket = new URL(version.webSocketDebuggerUrl);
    assert.equal(websocket.hostname, "127.0.0.1", "Electron CDP websocket must be loopback-bound on Mac");
    const advertisedCdpPort = Number(websocket.port);
    assert.ok(advertisedCdpPort === started.remoteCdpPort || advertisedCdpPort === cdpLocalPort,
      `Electron advertised unexpected CDP port ${advertisedCdpPort}`);
    websocket.port = String(cdpLocalPort);
    browser = await chromium.connectOverCDP(websocket.href, { timeout: 20_000 });
    context.addCleanup("disconnect Mac Electron CDP client", disconnectBrowser);
    page = await waitFor(() => browser.contexts().flatMap(browserContext => browserContext.pages())
      .find(candidate => candidate.url().startsWith("http://127.0.0.1:")), timeoutMs,
    "isolated Mac Electron gateway page", 100, context.abortSignal);
    await page.getByTestId("chat-message-input").first().waitFor({ state: "visible", timeout: timeoutMs });
    await page.setViewportSize({ width: 1280, height: 900 });

    const provenance = {
      sourceBundlePath: bundlePath,
      sourceBundleReleaseManifestSha256: await remoteFileSha256(context, "mac-electron-source-manifest-digest", localSsh, sshEnv, sshTarget,
        posix.join(bundlePath, "Contents/Resources/kcoder-release-manifest.json")),
      remoteAppClonePath: remoteAppBundle,
      remoteIsolatedStatePath: remoteStateRoot,
      remoteElectronPid: remoteAppPid,
      remoteGatewayPort: await readRemoteGatewayPort(context, localSsh, sshEnv, sshTarget,
        posix.join(remoteUserData, "gateway-port")),
      remoteCdpPort: started.remoteCdpPort,
      advertisedCdpPort,
      localCdpTunnelPort: cdpLocalPort,
      remoteProviderFixturePort: remoteFixturePort,
      bundledGatewayBinarySha256: await remoteFileSha256(context, "mac-electron-bundled-gateway-binary-digest", localSsh, sshEnv, sshTarget,
        remoteBinary),
      rendererDist: rendererInventory,
      source: sourceProvenance,
      freshness: { distMtime: (await assertRendererBuildFresh({ buildRoot: rendererDist })).distMtime },
      releaseManifestState: "test clone only; existing release manifest is retained as source provenance and is not a release attestation",
    };
    await context.writeArtifactJson("mac-electron-provenance.json", provenance);

    return {
      page,
      browser,
      platformLabel: "mac-electron",
      appClonePath: remoteAppBundle,
      gatewayOrigin: new URL(page.url()).origin,
      provenance,
      get cleanupReport() { return remoteStopReport; },
      async stop() {
        await disconnectBrowser();
        try {
          await stopCdpTunnel();
          await stopAppLaunch();
          await stopReverseForward();
          await removeRemoteState();
        } finally {
          await context.writeArtifactJson("mac-electron-cleanup.json", {
            remoteAppPid,
            remoteStopReport,
            remoteProcessCleanupReport,
            isolatedStateRemoved: remoteStateRemoved,
            appCloneRetained: true,
            appClonePath: remoteAppBundle,
            ownedProcesses: [...context.processes.values()]
              .filter(record => record.label.startsWith("mac-electron-"))
              .map(({ label, pid, stopped }) => ({ label, pid, stopped })),
          });
        }
      },
    };
  } catch (error) {
    await disconnectBrowser().catch(() => {});
    throw new Error(context.redactText(error instanceof Error ? error.message : String(error)), { cause: error });
  }
}

async function startCdpTunnel(context, sshBinary, env, sshTarget, remotePort, onChild) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const localPort = await allocateLoopbackPort();
    const label = `mac-electron-cdp-tunnel-${attempt + 1}`;
    const child = context.spawnOwned(label, sshBinary,
      [...SSH_OPTIONS, "-T", "-N", "-L", `${localPort}:127.0.0.1:${remotePort}`, sshTarget], { env });
    onChild(child, label);
    let stopped = false;
    const close = async () => {
      if (stopped) return;
      stopped = true;
      await context.stopOwned(label);
    };
    context.addCleanup("close private Mac Electron CDP tunnel", close);
    try {
      await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`CDP SSH tunnel exited with ${child.exitCode}`);
        return await fetchJson(`http://127.0.0.1:${localPort}/json/version`).catch(() => null);
      }, 10_000, "Mac Electron CDP tunnel readiness", 100, context.abortSignal);
      context.registerPort("mac-electron-cdp-loopback-tunnel", localPort);
      return localPort;
    } catch (error) {
      await close();
      if (attempt === 3) throw error;
    }
  }
  throw new Error("unable to allocate a local loopback CDP tunnel");
}

async function allocateLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`loopback endpoint returned HTTP ${response.status}`);
  return response.json();
}

function createSshEnvironment(context) {
  if (!process.env.HOME || !isAbsolute(process.env.HOME)) {
    throw new Error("SSH host alias requires the caller's configured HOME");
  }
  return context.isolatedEnvironment(
    { HOME: process.env.HOME },
    ["SSH_AUTH_SOCK", "SSH_AGENT_PID"],
  );
}

async function runOwnedCommand(context, label, binary, args, env) {
  const child = context.spawnOwned(label, binary, args, { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", bytes => { stdout = `${stdout}${bytes}`.slice(-64_000); });
  child.stderr.on("data", bytes => { stderr = `${stderr}${bytes}`.slice(-64_000); });
  let exit;
  try {
    exit = await waitFor(() => child.exitCode !== null || child.signalCode !== null
      ? { code: child.exitCode, signal: child.signalCode }
      : null, 120_000, `${label} completion`, 50, context.abortSignal);
  } catch (error) {
    await context.stopOwned(label).catch(() => {});
    throw error;
  }
  await context.stopOwned(label);
  if (exit.code !== 0) {
    throw new Error(`${label} exited (${exit.code ?? exit.signal}): ${context.redactText(stderr.slice(-4_000))}`);
  }
  return { stdout, stderr };
}

async function remoteExec(context, label, sshBinary, env, sshTarget, script) {
  return runOwnedCommand(context, label, sshBinary,
    [...SSH_OPTIONS, "-T", sshTarget, `/bin/bash -c ${shellQuote(script)}`], env);
}

async function remoteCleanupExec(context, label, sshBinary, env, sshTarget, script) {
  try {
    const result = await execFileAsync(sshBinary,
      [...SSH_OPTIONS, "-T", sshTarget, `/bin/bash -c ${shellQuote(script)}`],
      { env, encoding: "utf8", timeout: 9_000, maxBuffer: 128 * 1024, windowsHide: true });
    return {
      stdout: context.redactText(result.stdout),
      stderr: context.redactText(result.stderr),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const output = [error?.stdout, error?.stderr]
      .filter(value => typeof value === "string" && value.length > 0)
      .map(value => context.redactText(value.slice(-4_000)))
      .join("\n");
    throw new Error(`${label} failed: ${context.redactText(detail)}${output ? `\n${output}` : ""}`, { cause: error });
  }
}

async function remoteFileSha256(context, label, sshBinary, env, sshTarget, file) {
  const script = [
    "set -eu",
    `test -f ${shellQuote(file)} && test ! -L ${shellQuote(file)}`,
    `${MAC_NODE} -e ${shellQuote("const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'));")} ${shellQuote(file)}`,
  ].join("\n");
  const { stdout } = await remoteExec(context, label, sshBinary, env, sshTarget, script);
  const digest = stdout.trim();
  assert.match(digest, /^[a-f0-9]{64}$/);
  return digest;
}

async function readRemoteGatewayPort(context, sshBinary, env, sshTarget, portFile) {
  const { stdout } = await remoteExec(context, "mac-electron-read-private-gateway-port", sshBinary, env, sshTarget,
    `test -f ${shellQuote(portFile)} && /bin/cat ${shellQuote(portFile)}`);
  const port = Number(stdout.trim());
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535, "private Desktop Gateway port was invalid");
  return port;
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output.trim().split(/\r?\n/).at(-1));
  } catch {
    throw new Error(`${label} did not contain valid JSON`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function normalizeRemoteDirectory(value, label) {
  if (typeof value !== "string" || !posix.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be an absolute POSIX path`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized.split("/").includes("..") || !/^\/[A-Za-z0-9_./-]+$/.test(value)) {
    throw new Error(`${label} contains unsupported path components`);
  }
  return normalized;
}

async function collectRendererSourceProvenance() {
  const status = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", "apps/kcoder-studio/renderer"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const diff = await execFileAsync("git", ["diff", "--binary", "HEAD", "--", "apps/kcoder-studio/renderer"], {
    cwd: repoRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const untracked = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "--", "apps/kcoder-studio/renderer"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const rendererRoot = resolve(repoRoot, "apps/kcoder-studio/renderer");
  const untrackedFiles = [];
  for (const sourcePath of untracked.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const absolute = resolve(repoRoot, sourcePath);
    const withinRenderer = relative(rendererRoot, absolute);
    assert.ok(withinRenderer && withinRenderer !== ".." && !withinRenderer.startsWith(`..${sep}`),
      "untracked source provenance escaped the renderer root");
    const info = await lstat(absolute);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `untracked renderer source must be a regular file: ${sourcePath}`);
    untrackedFiles.push({ path: sourcePath, sha256: await hashFile(absolute) });
  }
  return {
    gitHead: head.stdout.trim(),
    status: status.stdout.trim().split(/\r?\n/).filter(Boolean),
    trackedDiffSha256: sha256(diff.stdout),
    untrackedFiles,
  };
}

async function inventoryRendererTree(root) {
  const absoluteRoot = resolve(root);
  const rootInfo = await lstat(absoluteRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "renderer dist root must be a real directory");
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const full = resolve(directory, name);
      const info = await lstat(full);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await visit(full, relativePath);
      } else if (info.isFile() && !info.isSymbolicLink()) {
        entries.push({ path: relativePath, size: info.size, sha256: await hashFile(full) });
      } else {
        throw new Error(`renderer dist contains an unsupported resource: ${relativePath}`);
      }
    }
  }
  await visit(absoluteRoot);
  const digest = sha256(Buffer.from(JSON.stringify(entries)));
  return { fileCount: entries.length, digest, entries };
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", chunk => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveHash(digest.digest("hex")));
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
